/**
 * `batch`: many tool calls in one, refs between them, the rollback of a
 * stopped batch, the batchId dedupe, one batch at a time, the auditor role,
 * and the result cap. Runs real server processes and a simulated plugin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Harness } from "./helpers/harness.js";
import type { PluginHandler, PluginRequest, SimulatedPlugin } from "./helpers/plugin.js";
import { postRpc } from "./helpers/rpc.js";
import type { ServerProcess } from "./helpers/server-process.js";

const FILE_KEY = "batch-file";
const TIMEOUT_MS = 60_000;

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** The handlers of a simulated plugin that makes node IDs 10:1, 10:2, ... */
function handlers(overrides: Record<string, PluginHandler> = {}): Record<string, PluginHandler> {
  let next = 0;
  const made = () => `10:${++next}`;
  return {
    create_frame: (request) => ({
      nodeId: made(),
      nodeName: request.params?.name,
      type: "FRAME",
      pageId: "0:1",
      nested: { list: [{ value: "deep" }] },
    }),
    create_text: (request) => ({
      nodeId: made(),
      type: "TEXT",
      parentId: request.params?.parentId,
      characters: request.params?.characters,
    }),
    create_instance: () => ({ id: made(), name: "Button", mainComponentId: "5:2" }),
    set_instance_properties: (request) => ({ id: request.nodeIds?.[0], properties: {} }),
    set_node_properties: (request) => ({ nodeId: request.nodeIds?.[0], applied: request.params }),
    delete_nodes: (request) => ({
      deletedCount: 1,
      deletions: [{ nodeId: request.nodeIds?.[0] }],
    }),
    create_shape: () => {
      throw new Error("create_shape: Figma refused the shape");
    },
    ...overrides,
  };
}

async function start(port: number, env: Record<string, string | undefined> = {}) {
  const root = await h.tempDir("root");
  const cwd = await h.tempDir("cwd");
  return h.server({ port, cwd, env: { FIGMA_BRIDGE_OUTPUT_ROOT: root, ...env } });
}

/** A leader, a connected plugin, and a follower. */
async function bridge(pluginHandlers = handlers()) {
  const port = await h.freePort();
  const leader = await start(port);
  expect(leader.role).toBe("LEADER");
  const plugin = await h.plugin({ port, fileKey: FILE_KEY, handlers: pluginHandlers });
  const follower = await start(port);
  expect(follower.role).toBe("FOLLOWER");
  return { port, leader, plugin, follower };
}

interface BatchResult {
  ok: boolean;
  batchId?: string;
  replayed?: boolean;
  results: { index: number; id?: string; tool: string; ok: boolean; data?: any; error?: string }[];
  stoppedAt?: number;
  rolledBack?: { deleted: string[]; failed: { nodeId: string; error: string }[] };
}

async function runBatch(
  server: ServerProcess,
  args: Record<string, unknown>
): Promise<BatchResult> {
  const outcome = await server.callTool("batch", { fileKey: FILE_KEY, ...args });
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.data as BatchResult;
}

/** The text of a refused batch: an error result or a thrown error. */
async function refusal(server: ServerProcess, args: Record<string, unknown>): Promise<string> {
  try {
    const outcome = await server.callTool("batch", { fileKey: FILE_KEY, ...args });
    if (outcome.ok) throw new Error("batch accepted an input it should refuse.");
    return outcome.error;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const types = (plugin: SimulatedPlugin) => plugin.requests.map((request) => request.type);

describe("batch", () => {
  test(
    "runs 5 ops through a follower, with refs, pairs, and argsJson",
    async () => {
      const { plugin, follower } = await bridge();

      const result = await runBatch(follower, {
        ops: [
          { id: "card", tool: "create_frame", args: { name: "Card", width: 320, height: 200 } },
          { tool: "create_text", args: { parentId: { ref: "card" }, characters: "Buy" } },
          {
            id: "button",
            tool: "create_instance",
            args: {
              componentId: "5:1",
              parentId: { ref: "card" },
              variantProperties: [{ name: "Size", value: "Large" }],
            },
          },
          {
            tool: "set_instance_properties",
            args: {
              nodeId: { ref: "button" },
              properties: [
                { name: "Label", value: "Buy" },
                { name: "Show icon", value: "false" },
              ],
            },
          },
          {
            tool: "set_node_properties",
            argsJson: JSON.stringify({ nodeId: { ref: "card" }, name: "Card done" }),
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.results.map((entry) => [entry.index, entry.tool, entry.ok])).toEqual([
        [0, "create_frame", true],
        [1, "create_text", true],
        [2, "create_instance", true],
        [3, "set_instance_properties", true],
        [4, "set_node_properties", true],
      ]);
      expect(result.results[0].id).toBe("card");
      expect(result.results[2].data.id).toBe("10:3");

      expect(types(plugin)).toEqual([
        "create_frame",
        "create_text",
        "create_instance",
        "set_instance_properties",
        "set_node_properties",
      ]);
      const [, text, instance, properties, patch] = plugin.requests;
      expect(text.params?.parentId).toBe("10:1");
      expect(instance.params?.parentId).toBe("10:1");
      expect(instance.params?.variantProperties).toEqual([{ name: "Size", value: "Large" }]);
      expect(properties.nodeIds).toEqual(["10:3"]);
      expect(properties.params?.properties).toEqual([
        { name: "Label", value: "Buy" },
        { name: "Show icon", value: "false" },
      ]);
      expect(patch.nodeIds).toEqual(["10:1"]);
      expect(patch.params?.name).toBe("Card done");
    },
    TIMEOUT_MS
  );

  test(
    "resolves { ref, path } and leaves a string such as $49 alone",
    async () => {
      const { plugin, follower } = await bridge();

      const result = await runBatch(follower, {
        ops: [
          { id: "card", tool: "create_frame", args: { name: "Card", width: 100, height: 100 } },
          {
            tool: "create_text",
            args: {
              parentId: { ref: "card" },
              name: { ref: "card", path: "nested.list.0.value" },
              characters: "$49",
            },
          },
        ],
      });

      expect(result.ok).toBe(true);
      expect(plugin.requests[1].params).toMatchObject({
        parentId: "10:1",
        name: "deep",
        characters: "$49",
      });
    },
    TIMEOUT_MS
  );

  test(
    "fails an op whose ref path is missing, and refuses a ref to a later op",
    async () => {
      const { plugin, follower } = await bridge();

      const result = await runBatch(follower, {
        rollback: false,
        ops: [
          { id: "card", tool: "create_frame", args: { width: 100, height: 100 } },
          { tool: "create_text", args: { parentId: { ref: "card", path: "no.such" } } },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.stoppedAt).toBe(1);
      expect(result.results[1].error).toContain("no value at that path");
      expect(types(plugin)).toEqual(["create_frame"]);

      const message = await refusal(follower, {
        ops: [
          { tool: "create_text", args: { parentId: { ref: "later" } } },
          { id: "later", tool: "create_frame", args: {} },
        ],
      });
      expect(message).toContain("ops[0] (create_text)");
      expect(message).toContain("names no earlier op");
      expect(types(plugin)).toEqual(["create_frame"]);
    },
    TIMEOUT_MS
  );

  test(
    "stops at a failed op and deletes the created nodes, newest first",
    async () => {
      const { plugin, follower } = await bridge();

      const result = await runBatch(follower, {
        ops: [
          { id: "card", tool: "create_frame", args: { width: 100, height: 100 } },
          { tool: "create_text", args: { parentId: { ref: "card" }, characters: "Hi" } },
          { tool: "create_shape", args: { shapeType: "RECTANGLE", parentId: { ref: "card" } } },
          { tool: "create_text", args: { characters: "never" } },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.stoppedAt).toBe(2);
      expect(result.results[2].error).toContain("Figma refused the shape");
      expect(result.results[3]).toMatchObject({ index: 3, ok: false });
      expect(result.results[3].error).toContain("not run");
      expect(result.rolledBack).toEqual({ deleted: ["10:2", "10:1"], failed: [] });

      const deletes = plugin.requests.filter((request) => request.type === "delete_nodes");
      expect(deletes.map((request) => request.nodeIds)).toEqual([["10:2"], ["10:1"]]);
      expect(deletes.every((request) => request.params?.confirm === true)).toBe(true);
      expect(types(plugin)).toEqual([
        "create_frame",
        "create_text",
        "create_shape",
        "delete_nodes",
        "delete_nodes",
      ]);
    },
    TIMEOUT_MS
  );

  test(
    'onError: "continue" runs the rest and rolls nothing back',
    async () => {
      const { plugin, follower } = await bridge();

      const result = await runBatch(follower, {
        onError: "continue",
        ops: [
          { tool: "create_frame", args: { width: 100, height: 100 } },
          { tool: "create_shape", args: { shapeType: "RECTANGLE" } },
          { tool: "create_text", args: { characters: "after" } },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.stoppedAt).toBeUndefined();
      expect(result.results.map((entry) => entry.ok)).toEqual([true, false, true]);
      expect(result.rolledBack).toBeUndefined();
      expect(types(plugin)).toEqual(["create_frame", "create_shape", "create_text"]);
    },
    TIMEOUT_MS
  );

  test(
    "refuses invalid op args in the SDK wording and sends nothing",
    async () => {
      const { plugin, follower } = await bridge();

      const message = await refusal(follower, {
        ops: [
          { tool: "create_frame", args: { width: 100, height: 100 } },
          { tool: "create_text", args: { fontSize: -4 } },
          { tool: "set_node_properties", argsJson: "{not json" },
          { tool: "create_frame", args: {}, argsJson: "{}" },
        ],
      });

      expect(message).toContain(
        "ops[1] (create_text): Input validation error: Invalid arguments for tool create_text"
      );
      expect(message).toContain("ops[2] (set_node_properties): argsJson is not a JSON object");
      expect(message).toContain("ops[3] (create_frame): give exactly one of args and argsJson");
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "runs a batchId once and replays it; the same batchId with other ops is refused",
    async () => {
      const { plugin, follower } = await bridge();
      const ops = [
        { id: "card", tool: "create_frame", args: { width: 100, height: 100 } },
        { tool: "create_text", args: { parentId: { ref: "card" }, characters: "Hi" } },
      ];

      const first = await runBatch(follower, { batchId: "card-1", ops });
      const second = await runBatch(follower, { batchId: "card-1", ops });

      expect(first.ok).toBe(true);
      expect(first.replayed).toBeUndefined();
      expect(second.replayed).toBe(true);
      expect(second.results).toEqual(first.results);
      expect(types(plugin)).toEqual(["create_frame", "create_text"]);

      const message = await refusal(follower, { batchId: "card-1", ops: ops.slice(0, 1) });
      expect(message).toContain('batchId "card-1"');
      expect(types(plugin)).toEqual(["create_frame", "create_text"]);
    },
    TIMEOUT_MS
  );

  test(
    "runs two concurrent batches one after the other",
    async () => {
      const slowFrame: PluginHandler = async (request: PluginRequest) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { nodeId: `20:${String(request.params?.name)}`, type: "FRAME" };
      };
      const { plugin, follower } = await bridge(handlers({ create_frame: slowFrame }));
      const frames = (prefix: string) =>
        [1, 2, 3].map((n) => ({ tool: "create_frame", args: { name: `${prefix}${n}` } }));

      const [a, b] = await Promise.all([
        runBatch(follower, { ops: frames("A") }),
        runBatch(follower, { ops: frames("B") }),
      ]);

      expect(a.ok && b.ok).toBe(true);
      const names = plugin.requests.map((request) => String(request.params?.name)).join(",");
      expect(["A1,A2,A3,B1,B2,B3", "B1,B2,B3,A1,A2,A3"]).toContain(names);
    },
    TIMEOUT_MS
  );

  test(
    "caps a large result, omitting the largest data first and keeping each node ID",
    async () => {
      const big = (size: number): PluginHandler => {
        let next = 0;
        return () => ({ nodeId: `30:${++next}`, payload: "x".repeat(size) });
      };
      const { follower } = await bridge(handlers({ create_frame: big(15_000) }));

      const result = await runBatch(follower, {
        ops: [1, 2, 3].map(() => ({ tool: "create_frame", args: {} })),
      });

      expect(JSON.stringify(result).length).toBeLessThanOrEqual(35_000);
      const omitted = result.results.filter((entry) => entry.data.omitted === true);
      expect(omitted.length).toBeGreaterThan(0);
      for (const entry of omitted) {
        expect(entry.data.nodeId).toMatch(/^30:\d$/);
        expect(entry.data.chars).toBeGreaterThan(15_000);
      }
    },
    TIMEOUT_MS
  );
});

describe("batch and the other processes", () => {
  test(
    "the auditor process has no batch, and /rpc refuses batch with 400",
    async () => {
      const port = await h.freePort();
      const leader = await start(port);
      expect(leader.role).toBe("LEADER");
      const plugin = await h.plugin({ port, fileKey: FILE_KEY, handlers: handlers() });
      const auditor = await start(port, { FIGMA_BRIDGE_ROLE: "auditor" });

      expect(await auditor.listTools()).not.toContain("batch");
      expect(await leader.listTools()).toContain("batch");

      const answer = await postRpc(port, await h.token(), {
        tool: "batch",
        params: { ops: [{ tool: "create_frame", args: {} }] },
        fileKey: FILE_KEY,
      });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toContain("batch is not served over /rpc");
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );
});
