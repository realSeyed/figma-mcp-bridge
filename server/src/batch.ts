import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { canonicalJson } from "./evidence.js";
import type { ToolResult } from "./tool-helpers.js";
import { toolAnnotations } from "./toolset.js";

/**
 * The `batch` tool: up to 100 tool calls in order, in one MCP call.
 *
 * `recordTools` wraps the server that `registerTools` registers on and keeps
 * the schema and the handler of each tool that really registered. `batch`
 * calls those handlers itself, in the serving process, so a follower sends
 * each plugin request of a batch over `/rpc` as one call of its own, and the
 * write journal of the leader records each one.
 *
 * The recorder also gives each tool its MCP annotations (`toolset.ts`).
 *
 * Imports `evidence.js`, `toolset.js`, packages, and types only.
 */

/** The handler of a tool, as `server.tool` takes it. */
type ToolHandler = (...args: unknown[]) => ToolResult | Promise<ToolResult>;

/** One recorded tool. A tool without a shape takes no arguments. */
export interface RecordedTool {
  description: string;
  shape: z.ZodRawShape | undefined;
  handler: ToolHandler;
}

export interface RecordedServer {
  /** Pass this to each registration: it records the tools that register. */
  server: McpServer;
  /** The tools that registered, by name, in registration order. */
  tools: Map<string, RecordedTool>;
}

/**
 * Wraps the server so that each `tool` call that registers a tool is
 * recorded and forwarded with the annotations of `toolAnnotations`. A tool that the role wrapper drops (its stub has `enabled: false`)
 * is not recorded.
 * @param server - The MCP server, or the restricted server of a role.
 */
export function recordTools(server: McpServer): RecordedServer {
  const tools = new Map<string, RecordedTool>();

  const record = (name: string, ...rest: unknown[]): unknown => {
    const handler = rest[rest.length - 1] as ToolHandler;
    const args = rest.slice(0, -1);
    const description = typeof args[0] === "string" ? (args.shift() as string) : "";
    // The first object left is the shape. No registration passes annotations:
    // they come from the name, so the read-only list governs each tool.
    const shape = args.find((arg) => typeof arg === "object" && arg !== null) as
      z.ZodRawShape | undefined;
    const annotations = toolAnnotations(name);
    const forwarded = [
      description,
      ...(shape ? [shape] : []),
      ...(annotations ? [annotations] : []),
      handler,
    ];
    const handle = (server.tool as (...args: unknown[]) => unknown)(name, ...forwarded);
    if ((handle as { enabled?: boolean } | undefined)?.enabled === false) return handle;
    tools.set(name, { description, shape, handler });
    return handle;
  };

  const proxy = new Proxy(server, {
    get(target, property) {
      if (property === "tool") return record;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { server: proxy, tools };
}

/** The tools a batch cannot call: itself, the identity read, and the tools that write files or return images. */
export const BATCH_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "batch",
  "list_files",
  "get_screenshot",
  "save_screenshots",
  "dump_nodes",
  "dump_journal",
  "import_html_layers",
]);

/** The most ops of one batch. */
export const MAX_BATCH_OPS = 100;

/** The most characters of a batch result: the read budget, under the 38,000 backstop. */
export const MAX_BATCH_RESULT_CHARS = 35_000;

/** How long a batchId is remembered. */
const DEDUPE_TTL_MS = 60 * 60 * 1000;

/** The most batchIds remembered at once; the oldest goes first. */
const DEDUPE_MAX_ENTRIES = 200;

const OP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** The keys of a result that hold the node ID of an op, in order. */
const PRIMARY_ID_KEYS = ["nodeId", "id", "pageId"] as const;

const DESCRIPTION = `Run up to 100 tool calls in order in one call. Use it to build a component or a page section: later ops take { "ref": "<id>" } to use an earlier op's node ID.

Each op is { id?, tool, args } or { id?, tool, argsJson }: args is the tool's arguments; argsJson is the same object as a JSON string, for a client that cannot send an open object. Pass exactly one of them ({} for no arguments). Anywhere in args, a value that is exactly { "ref": "<op id>" } becomes the node ID that op returned (its nodeId, id, or pageId), and { "ref": "<op id>", "path": "a.b.0.c" } the value at that path of its result. No string is ever rewritten.

Example: {"ops":[{"id":"card","tool":"create_frame","args":{"name":"Card","width":320,"height":200,"layoutMode":"VERTICAL"}},{"tool":"create_text","args":{"parentId":{"ref":"card"},"characters":"$49"}},{"tool":"create_instance","args":{"componentId":"12:34","parentId":{"ref":"card"},"variantProperties":[{"name":"Size","value":"Large"}]}}]}

Every op without a ref is checked before the first runs: a bad one runs nothing. onError: "stop" (default) stops at the first failure and, with rollback (default true), deletes the nodes the batch created, newest first; "continue" runs the rest. Give a batchId to make a retry safe: the same batchId with the same ops returns the first result with replayed: true and runs nothing (for 60 minutes). The result lists each op as { index, id, tool, ok, data | error }, and is cut at 35000 characters by omitting the largest data first. fileKey is the default of each op that names none. Not batchable: ${[...BATCH_EXCLUDED_TOOLS].join(", ")}.`;

type Json = Record<string, unknown>;

/** One op as the schema gives it. */
interface Op {
  id?: string;
  tool: string;
  args?: Json;
  argsJson?: string;
}

interface BatchInput {
  ops: Op[];
  onError?: "stop" | "continue";
  rollback?: boolean;
  batchId?: string;
  fileKey?: string;
}

/** The result entry of one op. */
interface OpResult {
  index: number;
  id?: string;
  tool: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface BatchResult {
  ok: boolean;
  batchId?: string;
  replayed?: boolean;
  results: OpResult[];
  stoppedAt?: number;
  rolledBack?: { deleted: string[]; failed: { nodeId: string; error: string }[] };
}

/**
 * The text of a tool result, joined.
 * @param result - The tool result.
 */
function textOf(result: ToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Whether a value is exactly a ref: an object with `ref` and at most `path`.
 * @param value - Any value of the args.
 */
function isRef(value: unknown): value is { ref: string; path?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const ref = (value as Json).ref;
  const path = (value as Json).path;
  return (
    typeof ref === "string" &&
    keys.every((key) => key === "ref" || key === "path") &&
    (path === undefined || typeof path === "string")
  );
}

/**
 * Each ref in a value.
 * @param value - The args or a part of them.
 */
function refsIn(value: unknown): { ref: string; path?: string }[] {
  if (isRef(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(refsIn);
  return [];
}

/**
 * The node ID an op returned: the first of nodeId, id, and pageId.
 * @param data - The data of the op result.
 */
function primaryIdOf(data: unknown): { key: string; value: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  for (const key of PRIMARY_ID_KEYS) {
    const value = (data as Json)[key];
    if (typeof value === "string") return { key, value };
  }
  return undefined;
}

/**
 * The value at a dotted path of a result.
 * @param data - The data of the op result.
 * @param path - Keys and array indexes, joined by dots.
 */
function valueAt(data: unknown, path: string): unknown {
  let current = data;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Json)[part];
  }
  return current;
}

/**
 * The node IDs an op created, which a rollback deletes. Converting or wrapping
 * existing nodes creates nothing to delete.
 * @param tool - The tool of the op.
 * @param args - The args the op ran with.
 * @param data - The data of the op result.
 */
function createdNodeIds(tool: string, args: Json, data: unknown): string[] {
  const result = (typeof data === "object" && data !== null ? data : {}) as Json;
  const id = (key: string): string[] => (typeof result[key] === "string" ? [result[key]] : []);
  switch (tool) {
    case "create_frame":
    case "create_text":
    case "create_shape":
    case "create_image":
    case "create_svg":
      return id("nodeId");
    case "create_instance":
      return id("id");
    case "create_component":
      return args.fromNodeId === undefined ? id("id") : [];
    case "create_section":
      return args.nodeIds === undefined ? id("id") : [];
    case "duplicate_nodes":
      return Array.isArray(result.duplicates)
        ? result.duplicates.flatMap((item: unknown) => {
            const nodeId = (item as Json | null)?.nodeId;
            return typeof nodeId === "string" ? [nodeId] : [];
          })
        : [];
    default:
      return [];
  }
}

/**
 * Caps the result at `MAX_BATCH_RESULT_CHARS`: the largest data goes first,
 * replaced by `{ omitted: true, chars }` and the op's node ID.
 * @param result - The batch result.
 */
function capResult(result: BatchResult): BatchResult {
  let text = JSON.stringify(result);
  if (text.length <= MAX_BATCH_RESULT_CHARS) return result;
  const bySize = result.results
    .filter((entry) => entry.data !== undefined)
    .map((entry) => ({ entry, chars: JSON.stringify(entry.data).length }))
    .sort((a, b) => b.chars - a.chars);
  for (const { entry, chars } of bySize) {
    const primary = primaryIdOf(entry.data);
    entry.data = { omitted: true, chars, ...(primary ? { [primary.key]: primary.value } : {}) };
    text = JSON.stringify(result);
    if (text.length <= MAX_BATCH_RESULT_CHARS) break;
  }
  return result;
}

/**
 * The SDK's wording for args that a tool schema refuses.
 * @param tool - The tool name.
 * @param error - The Zod error.
 */
function validationMessage(tool: string, error: z.ZodError): string {
  return `Input validation error: Invalid arguments for tool ${tool}: ${error.message}`;
}

/**
 * Registers `batch` on the server. Call it after every other tool, with the
 * tools that `recordTools` recorded: the enum of `ops[].tool` lists them.
 * @param server - The recorded server, so that a role wrapper can drop `batch`.
 * @param tools - The recorded tools.
 */
export function registerBatchTool(server: McpServer, tools: Map<string, RecordedTool>): void {
  const names = [...tools.keys()].filter((name) => !BATCH_EXCLUDED_TOOLS.has(name));
  if (names.length === 0) return;

  const opSchema = z.object({
    id: z
      .string()
      .regex(OP_ID)
      .optional()
      .describe(
        "A name for this op, which a later op uses in { ref }: a letter, then up to 63 letters, digits, _ or -"
      ),
    tool: z.enum(names as [string, ...string[]]).describe("The tool to call"),
    args: z
      .record(z.unknown())
      .optional()
      .describe("The arguments of the tool, as its own schema takes them. Give args or argsJson."),
    argsJson: z
      .string()
      .optional()
      .describe("The arguments of the tool as a JSON object in a string. Give args or argsJson."),
  });

  const shape = {
    ops: z
      .array(opSchema)
      .min(1)
      .max(MAX_BATCH_OPS)
      .describe("The tool calls, 1 to 100, run in order"),
    onError: z
      .enum(["stop", "continue"])
      .optional()
      .describe(
        "What a failed op does: stop ends the batch there, continue runs the rest. Default: stop."
      ),
    rollback: z
      .boolean()
      .optional()
      .describe(
        "With onError stop, delete the nodes the batch created when an op fails, newest first. Default: true."
      ),
    batchId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "A name for this batch that makes a retry safe: the same batchId with the same ops returns the first result and runs nothing. Remembered 60 minutes."
      ),
    fileKey: z.string().optional().describe("The file of each op that names no fileKey of its own"),
  };

  /** One batch at a time in this process, so two batches never interleave. */
  let queue: Promise<unknown> = Promise.resolve();
  /** batchId to the hash of its input and its result. */
  const seen = new Map<string, { hash: string; at: number; result: Promise<BatchResult> }>();

  /**
   * Reads and checks every op before the first runs.
   * @param input - The batch input.
   * @returns The args of each op, refs not yet resolved.
   */
  const prepare = (input: BatchInput): Json[] => {
    const problems: string[] = [];
    const ids = new Map<string, number>();
    const prepared: Json[] = [];
    input.ops.forEach((op, index) => {
      const label = `ops[${index}] (${op.tool})`;
      let args: Json = {};
      if ((op.args === undefined) === (op.argsJson === undefined)) {
        problems.push(`${label}: give exactly one of args and argsJson; pass args: {} for none.`);
      } else if (op.argsJson !== undefined) {
        try {
          const parsed: unknown = JSON.parse(op.argsJson);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("it is not a JSON object");
          }
          args = parsed as Json;
        } catch (err) {
          problems.push(
            `${label}: argsJson is not a JSON object (${err instanceof Error ? err.message : String(err)}). Write the arguments as one JSON object, or use args.`
          );
        }
      } else {
        args = op.args as Json;
      }
      if (input.fileKey !== undefined && args.fileKey === undefined) {
        const recorded = tools.get(op.tool);
        if (recorded?.shape && "fileKey" in recorded.shape) {
          args = { ...args, fileKey: input.fileKey };
        }
      }

      const refs = refsIn(args);
      for (const ref of refs) {
        const target = ids.get(ref.ref);
        if (target === undefined) {
          problems.push(
            `${label}: { "ref": "${ref.ref}" } names no earlier op. A ref takes the id of an op before this one.`
          );
        }
      }
      if (refs.length === 0) {
        const recorded = tools.get(op.tool);
        if (recorded?.shape) {
          const parsed = z.object(recorded.shape).safeParse(args);
          if (!parsed.success)
            problems.push(`${label}: ${validationMessage(op.tool, parsed.error)}`);
        }
      }
      if (op.id !== undefined) {
        if (ids.has(op.id)) {
          problems.push(
            `${label}: the id "${op.id}" is also ops[${ids.get(op.id)}]. Give each op its own id.`
          );
        } else {
          ids.set(op.id, index);
        }
      }
      prepared.push(args);
    });
    if (problems.length > 0) {
      throw new Error(
        `batch ran nothing. Correct these ops and call it again:\n${problems.join("\n")}`
      );
    }
    return prepared;
  };

  /**
   * Runs one batch.
   * @param input - The batch input.
   * @param extra - The request extra of the batch call, given to each handler.
   */
  const run = async (input: BatchInput, extra: unknown): Promise<BatchResult> => {
    const prepared = prepare(input);
    const onError = input.onError ?? "stop";
    const rollback = onError === "stop" && input.rollback !== false;
    const results: OpResult[] = [];
    const byId = new Map<string, OpResult>();
    const created: { nodeIds: string[]; fileKey: unknown }[] = [];
    let stoppedAt: number | undefined;

    const resolveRefs = (value: unknown): unknown => {
      if (isRef(value)) {
        const target = byId.get(value.ref);
        if (target === undefined) throw new Error(`{ "ref": "${value.ref}" } names no earlier op.`);
        if (!target.ok) {
          throw new Error(`{ "ref": "${value.ref}" } names ops[${target.index}], which failed.`);
        }
        if (value.path !== undefined) {
          const found = valueAt(target.data, value.path);
          if (found === undefined) {
            throw new Error(
              `{ "ref": "${value.ref}", "path": "${value.path}" }: the result of ops[${target.index}] has no value at that path.`
            );
          }
          return found;
        }
        const primary = primaryIdOf(target.data);
        if (primary === undefined) {
          throw new Error(
            `{ "ref": "${value.ref}" }: ops[${target.index}] returned no nodeId, id, or pageId. Give a path, as in { "ref": "${value.ref}", "path": "<key>" }.`
          );
        }
        return primary.value;
      }
      if (Array.isArray(value)) return value.map(resolveRefs);
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, resolveRefs(item)])
        );
      }
      return value;
    };

    for (const [index, op] of input.ops.entries()) {
      const entry: OpResult = { index, ...(op.id ? { id: op.id } : {}), tool: op.tool, ok: false };
      results.push(entry);
      if (op.id) byId.set(op.id, entry);
      const recorded = tools.get(op.tool);
      try {
        if (!recorded) throw new Error(`${op.tool} is not a tool of this server.`);
        const args = resolveRefs(prepared[index]) as Json;
        let outcome: ToolResult;
        if (recorded.shape) {
          const parsed = z.object(recorded.shape).safeParse(args);
          if (!parsed.success) throw new Error(validationMessage(op.tool, parsed.error));
          outcome = await recorded.handler(parsed.data, extra);
          const text = textOf(outcome);
          if (outcome.isError) throw new Error(text);
          try {
            entry.data = JSON.parse(text);
          } catch {
            entry.data = text;
          }
          entry.ok = true;
          const nodeIds = createdNodeIds(op.tool, parsed.data as Json, entry.data);
          if (nodeIds.length > 0) created.push({ nodeIds, fileKey: (parsed.data as Json).fileKey });
        } else {
          outcome = await recorded.handler(extra);
          const text = textOf(outcome);
          if (outcome.isError) throw new Error(text);
          try {
            entry.data = JSON.parse(text);
          } catch {
            entry.data = text;
          }
          entry.ok = true;
        }
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
        if (onError === "stop") {
          stoppedAt = index;
          break;
        }
      }
    }

    const result: BatchResult = {
      ok: results.every((entry) => entry.ok) && stoppedAt === undefined,
      ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
      results,
    };
    if (stoppedAt !== undefined) {
      result.stoppedAt = stoppedAt;
      for (let index = stoppedAt + 1; index < input.ops.length; index++) {
        const op = input.ops[index];
        results.push({
          index,
          ...(op.id ? { id: op.id } : {}),
          tool: op.tool,
          ok: false,
          error: `not run: the batch stopped at ops[${stoppedAt}]`,
        });
      }
      if (rollback && created.length > 0) {
        result.rolledBack = await rollBack(created, extra);
      }
    }
    return capResult(result);
  };

  /**
   * Deletes the created nodes, newest first, with one delete_nodes call each.
   * A node that is gone already (a child of a deleted parent) counts as deleted.
   * @param created - The nodes of each op that created some, in op order.
   * @param extra - The request extra of the batch call.
   */
  const rollBack = async (
    created: { nodeIds: string[]; fileKey: unknown }[],
    extra: unknown
  ): Promise<NonNullable<BatchResult["rolledBack"]>> => {
    const deleted: string[] = [];
    const failed: { nodeId: string; error: string }[] = [];
    const remove = tools.get("delete_nodes");
    for (const { nodeIds, fileKey } of [...created].reverse()) {
      for (const nodeId of [...nodeIds].reverse()) {
        if (!remove) {
          failed.push({ nodeId, error: "delete_nodes is not a tool of this server" });
          continue;
        }
        try {
          const args = { nodeIds: [nodeId], confirm: true, ...(fileKey ? { fileKey } : {}) };
          const outcome = await remove.handler(args, extra);
          const text = textOf(outcome);
          if (outcome.isError && !/not found/i.test(text)) {
            failed.push({ nodeId, error: text });
          } else {
            deleted.push(nodeId);
          }
        } catch (err) {
          failed.push({ nodeId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return { deleted, failed };
  };

  /**
   * The batch of a batchId: a new run, or the run of the same input before.
   * @param input - The batch input.
   * @param extra - The request extra.
   */
  const start = (input: BatchInput, extra: unknown): Promise<BatchResult> => {
    const runQueued = (): Promise<BatchResult> => {
      const next = queue.then(() => run(input, extra));
      queue = next.catch(() => undefined);
      return next;
    };
    if (input.batchId === undefined) return runQueued();

    const now = Date.now();
    for (const [id, entry] of seen) {
      if (now - entry.at > DEDUPE_TTL_MS) seen.delete(id);
    }
    const { batchId: _batchId, ...rest } = input;
    const hash = createHash("sha256")
      .update(canonicalJson(JSON.parse(JSON.stringify(rest)) as unknown))
      .digest("hex");
    const before = seen.get(input.batchId);
    if (before !== undefined) {
      if (before.hash !== hash) {
        return Promise.reject(
          new Error(
            `batch ran nothing: the batchId "${input.batchId}" was used in the last 60 minutes with other ops. Give a new batchId for a new batch.`
          )
        );
      }
      return before.result.then((result) => ({ ...result, replayed: true }));
    }
    const result = runQueued();
    seen.set(input.batchId, { hash, at: now, result });
    // A run that throws is not remembered, so a retry runs it again.
    result.catch(() => seen.delete(input.batchId as string));
    while (seen.size > DEDUPE_MAX_ENTRIES) seen.delete(seen.keys().next().value as string);
    return result;
  };

  server.tool(
    "batch",
    DESCRIPTION,
    shape,
    async (input: BatchInput, extra: unknown): Promise<ToolResult> => {
      try {
        const result = await start(input, extra);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    }
  );
}
