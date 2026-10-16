import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../node.js";
import {
  canonicalBytes,
  canonicalJson,
  EvidenceSet,
  folderTimestamp,
  manifestEnvelope,
  sessionChange,
  utcTimestamp,
} from "../evidence.js";
import type { EvidenceIdentity, ManifestEnvelope, WrittenEvidence } from "../evidence.js";
import { resolveFileIdentity } from "../identity.js";
import { createFigmaNodeIdSchema, fileKeyField } from "../schema-common.js";
import { parseToolInput } from "../tool-helpers.js";
import type { ToolResult } from "../tool-helpers.js";
import type { ExtensionRpcMap, ExtensionSchemaMap } from "./types.js";

/**
 * Dump tools.
 *
 * `dump_nodes` runs in the process that serves the call. It asks the plugin
 * for each root in chunks with the internal command `dump_nodes_chunk`, builds
 * the tree from the records, and writes one canonical JSON file for each root
 * under the output root of this process. The result is the manifest only.
 *
 * Import only from `schema-common.js`, `tool-helpers.js`, `evidence.js`,
 * `identity.js`, packages, and types. Importing `schema.js` or `tools.js`
 * here would close an import cycle.
 */

const TOOL = "dump_nodes";

/** The most roots one call takes. */
const MAX_ROOTS_PER_CALL = 200;

/** The most records one chunk returns, unless the test setting overrides it. */
const DEFAULT_CHUNK_NODES = 1_000;

/** A test setting: the most records one chunk returns. */
const CHUNK_NODES_VARIABLE = "FIGMA_BRIDGE_DUMP_CHUNK_NODES";

const dumpNodesInput = z.object({
  nodeIds: z
    .array(createFigmaNodeIdSchema())
    .min(1)
    .max(MAX_ROOTS_PER_CALL)
    .superRefine((ids, ctx) => {
      const first = new Map<string, number>();
      const repeats: string[] = [];
      ids.forEach((id, index) => {
        const earlier = first.get(id);
        if (earlier === undefined) first.set(id, index);
        else repeats.push(`nodeIds[${index}]: ${id} repeats nodeIds[${earlier}]`);
      });
      if (repeats.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${TOOL} takes each root once. ${repeats.join("; ")}. Remove the repeated IDs.`,
        });
      }
    })
    .describe(
      "1 to 200 roots to dump: pages, frames, component sets, or any node on a page. One file for each root."
    ),
  includeHidden: z
    .boolean()
    .optional()
    .describe(
      "Dump the hidden nodes, paints, and effects too, each marked visible: false. Defaults to true. A dump without them is not audit evidence."
    ),
  includeVariables: z
    .boolean()
    .optional()
    .describe(
      "Also write variables.json: each variable collection and each variable. Defaults to false."
    ),
  includeStyles: z
    .boolean()
    .optional()
    .describe("Also write styles.json: each local style. Defaults to false."),
  outputPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The folder for the files, under the output root of this server process. Defaults to dumps/<UTC time>. The folder must not hold a file of this call already: evidence is never overwritten."
    ),
  fileKey: fileKeyField,
});

type DumpNodesInput = z.infer<typeof dumpNodesInput>;

/** Tool name to Zod object schema. Spread into `toolInputSchemas`. */
export const schemas = {
  dump_nodes: dumpNodesInput,
} satisfies ExtensionSchemaMap;

/**
 * Tool name to RPC wire mapper. Spread into `rpcToArgs`. The leader refuses
 * `dump_nodes` over `/rpc`, so the mapper only keeps the map complete.
 */
export const rpcToArgs = {
  dump_nodes: (nodeIds, params) => ({ nodeIds, ...params }),
} satisfies ExtensionRpcMap;

/** One file of the manifest. */
export interface DumpManifestFile {
  kind: "nodes" | "variables" | "styles";
  /** The root of a nodes file; null for variables and styles. */
  nodeId: string | null;
  /** Relative to the output root, with `/`. */
  path: string;
  sha256: string;
  bytes: number;
  nodeCount: number | null;
  hiddenCount: number | null;
  variantCount: number | null;
}

export type DumpManifest = ManifestEnvelope<DumpManifestFile> & {
  outputPath: string;
  includeHidden: boolean;
  includeVariables: boolean;
  includeStyles: boolean;
};

type Json = Record<string, unknown>;

/** The counts of one nodes file. */
type DumpCounts = { nodeCount: number; hiddenCount: number; variantCount: number };

/** A frame of the tree builder: a node whose children are still to come. */
type OpenNode = { node: Json; remaining: number };

/**
 * Builds the tree of one root from its records, which come in pre-order, and
 * checks the structure as it goes: each depth fits the open nodes, each
 * `childCount` is met, and one root remains. A node without children gets no
 * `children` field. It also counts the nodes, the hidden nodes, and the
 * variants.
 */
export class TreeBuilder {
  private root: Json | null = null;
  private readonly open: OpenNode[] = [];
  private records = 0;
  nodeCount = 0;
  hiddenCount = 0;
  variantCount = 0;

  constructor(private readonly rootId: string) {}

  /**
   * Adds one record.
   * @param record - `{ depth, childCount, node }`, as `dump_nodes_chunk` sends it.
   * @throws If the record does not fit the tree.
   */
  add(record: unknown): void {
    const at = `record ${this.records}`;
    this.records += 1;
    if (!isRecord(record)) throw new Error(`${at} is not an object`);
    const { depth, childCount, node } = record;
    if (!isCount(depth)) throw new Error(`${at} has the depth ${show(depth)}`);
    if (!isCount(childCount)) throw new Error(`${at} has the childCount ${show(childCount)}`);
    if (!isRecord(node)) throw new Error(`${at} has no node object`);
    if ("children" in node) throw new Error(`${at} carries children; a record holds one node`);

    if (this.root === null) {
      if (depth !== 0) throw new Error(`the first record has the depth ${depth}, not 0`);
      if (node.id !== this.rootId) {
        throw new Error(`the first record is the node ${show(node.id)}, not the root`);
      }
      this.root = node;
    } else {
      const parent = this.open[this.open.length - 1];
      if (!parent) throw new Error(`${at} follows a complete tree, so the dump has two roots`);
      if (depth !== this.open.length) {
        throw new Error(
          `${at} has the depth ${depth}, but the next node has the depth ${this.open.length}`
        );
      }
      (parent.node.children as Json[]).push(node);
      parent.remaining -= 1;
      if (parent.node.type === "COMPONENT_SET" && node.type === "COMPONENT") {
        this.variantCount += 1;
      }
    }

    this.nodeCount += 1;
    if (isRecord(node.styles) && node.styles.visible === false) this.hiddenCount += 1;
    if (childCount > 0) {
      node.children = [];
      this.open.push({ node, remaining: childCount });
    }
    while (this.open.length > 0 && this.open[this.open.length - 1].remaining === 0) {
      this.open.pop();
    }
  }

  /**
   * The tree, once each count is met.
   * @returns The root node, with its children.
   * @throws If no record came, or a node still waits for children.
   */
  finish(): Json {
    if (this.root === null) throw new Error("the walk returned no record");
    const waiting = this.open[this.open.length - 1];
    if (waiting) {
      throw new Error(
        `the walk ended, but ${show(waiting.node.id)} still waits for ${waiting.remaining} of its children`
      );
    }
    return this.root;
  }
}

/** A failure of one call: the message names the place, the cause, and the correction. */
class DumpError extends Error {}

/**
 * The tool error of a failure.
 * @param where - The root or the step.
 * @param cause - What went wrong.
 * @param correction - What to do.
 * @returns The error.
 */
const dumpError = (where: string, cause: string, correction: string): DumpError =>
  new DumpError(`${TOOL} failed ${where}: ${cause.replace(/[.\s]+$/, "")}. ${correction}`);

/** The correction when the plugin stopped answering. */
const KEEP_PLUGIN_OPEN =
  "Make sure that the plugin stays open in the file, then call dump_nodes again.";

/**
 * The file name of a root: `:` is not allowed in a Windows file name.
 * @param nodeId - The root.
 * @returns For example `12_34.json` for `12:34`.
 */
export const dumpFileName = (nodeId: string): string => `${nodeId.replace(/:/g, "_")}.json`;

/**
 * Reads the test setting of the chunk size.
 * @returns The most records one chunk returns.
 */
const chunkNodes = (): number => {
  const raw = process.env[CHUNK_NODES_VARIABLE]?.trim();
  if (!raw) return DEFAULT_CHUNK_NODES;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw dumpError(
      "before the first chunk",
      `${CHUNK_NODES_VARIABLE} is "${raw}", but it must be an integer of 1 or more`,
      `Unset it to use ${DEFAULT_CHUNK_NODES}, then restart the server.`
    );
  }
  return Number(raw);
};

/**
 * Sends one plugin request and returns its data.
 * @param node - The node of this process.
 * @param requestType - The plugin command.
 * @param params - The params.
 * @param fileKey - The resolved file key.
 * @returns The data of the answer.
 * @throws With the cause the plugin or the bridge gave.
 */
const request = async (
  node: Node,
  requestType: string,
  params: Record<string, unknown> | undefined,
  fileKey: string
): Promise<unknown> => {
  const response = await node.sendWithParams(requestType, undefined, params, fileKey);
  if (response.error) throw new Error(response.error);
  return response.data;
};

/**
 * Walks one root chunk by chunk, and builds its tree.
 * @param node - The node of this process.
 * @param fileKey - The resolved file key.
 * @param rootId - The root.
 * @param includeHidden - Whether the walk keeps the hidden content.
 * @param maxNodes - The most records one chunk returns.
 * @returns The tree and its counts.
 */
const dumpRoot = async (
  node: Node,
  fileKey: string,
  rootId: string,
  includeHidden: boolean,
  maxNodes: number
): Promise<{ tree: Json; counts: DumpCounts }> => {
  const builder = new TreeBuilder(rootId);
  let cursor: number[] | null = null;
  let chunk = 0;
  do {
    chunk += 1;
    const where = `at root ${rootId}, chunk ${chunk}`;
    let answer: unknown;
    try {
      answer = await request(
        node,
        "dump_nodes_chunk",
        { rootId, cursor, maxNodes, includeHidden },
        fileKey
      );
    } catch (err) {
      throw dumpError(
        where,
        errorMessage(err),
        "Make sure that the node exists and that the plugin stays open in the file, then call dump_nodes again."
      );
    }
    try {
      if (!isRecord(answer) || answer.rootId !== rootId || !Array.isArray(answer.records)) {
        throw new Error(`the plugin answered ${show(answer).slice(0, 200)}`);
      }
      if (answer.records.length === 0) throw new Error("the chunk holds no record");
      const next = answer.nextCursor;
      if (next !== null && !(Array.isArray(next) && next.every(isCount))) {
        throw new Error(`the chunk has the nextCursor ${show(next)}`);
      }
      for (const record of answer.records) builder.add(record);
      cursor = next as number[] | null;
    } catch (err) {
      throw dumpError(
        where,
        `the dump is not a valid tree: ${errorMessage(err)}`,
        "The plugin build may not match this server: rebuild both, run the plugin again, then call dump_nodes again."
      );
    }
  } while (cursor !== null);

  let tree: Json;
  try {
    tree = builder.finish();
  } catch (err) {
    throw dumpError(
      `at root ${rootId}`,
      `the dump is not a valid tree: ${errorMessage(err)}`,
      "Call dump_nodes again; if the tree changed during the dump, wait until no one edits it."
    );
  }
  const { nodeCount, hiddenCount, variantCount } = builder;
  return { tree, counts: { nodeCount, hiddenCount, variantCount } };
};

/**
 * One file of the manifest.
 * @param written - The written file.
 * @param kind - What the file holds.
 * @param nodeId - The root of a nodes file, else null.
 * @param counts - The counts of a nodes file, else null.
 * @returns The manifest entry.
 */
const manifestFile = (
  written: WrittenEvidence,
  kind: DumpManifestFile["kind"],
  nodeId: string | null,
  counts: DumpCounts | null
): DumpManifestFile => ({
  kind,
  nodeId,
  path: written.path,
  sha256: written.sha256,
  bytes: written.bytes,
  nodeCount: counts ? counts.nodeCount : null,
  hiddenCount: counts ? counts.hiddenCount : null,
  variantCount: counts ? counts.variantCount : null,
});

/**
 * Runs one `dump_nodes` call in this process.
 *
 * The steps: resolve the file and read its identity; refuse a target that
 * exists; walk each root and write it as `.partial`; read the variables and
 * the styles when asked; read the identity again; publish each file; write
 * the manifest. A failure at any step removes each file of the call.
 * @param node - The node of this process.
 * @param input - The parsed input.
 * @returns The manifest, which `manifest.json` also holds.
 */
export async function executeDumpNodes(node: Node, input: DumpNodesInput): Promise<DumpManifest> {
  const startedAt = new Date();
  const includeHidden = input.includeHidden ?? true;
  const includeVariables = input.includeVariables ?? false;
  const includeStyles = input.includeStyles ?? false;
  const outputPath = input.outputPath ?? `dumps/${folderTimestamp(startedAt)}`;
  const maxNodes = chunkNodes();

  const names = input.nodeIds.map(dumpFileName);
  if (includeVariables) names.push("variables.json");
  if (includeStyles) names.push("styles.json");
  names.push("manifest.json");

  let before: EvidenceIdentity;
  let evidence: EvidenceSet;
  try {
    before = await resolveFileIdentity(node, input.fileKey);
    evidence = await EvidenceSet.open(outputPath, names);
  } catch (err) {
    throw dumpError("before the first chunk", errorMessage(err), "No file was written.");
  }

  try {
    const files: DumpManifestFile[] = [];
    for (const rootId of input.nodeIds) {
      const { tree, counts } = await dumpRoot(
        node,
        before.fileKey,
        rootId,
        includeHidden,
        maxNodes
      );
      const written = await evidence.write(dumpFileName(rootId), canonicalBytes(tree));
      files.push(manifestFile(written, "nodes", rootId, counts));
    }

    const payloads: Array<[DumpManifestFile["kind"], string, string]> = [];
    if (includeVariables) payloads.push(["variables", "get_variable_defs", "variables.json"]);
    if (includeStyles) payloads.push(["styles", "get_styles", "styles.json"]);
    for (const [kind, requestType, name] of payloads) {
      let data: unknown;
      try {
        data = await request(node, requestType, undefined, before.fileKey);
      } catch (err) {
        throw dumpError(
          `at ${name}`,
          `${requestType} failed: ${errorMessage(err)}`,
          KEEP_PLUGIN_OPEN
        );
      }
      files.push(manifestFile(await evidence.write(name, canonicalBytes(data)), kind, null, null));
    }

    await checkSession(node, before, input.nodeIds);

    await evidence.publish();
    const manifest: DumpManifest = {
      ...manifestEnvelope(
        TOOL,
        before,
        evidence.realRoot,
        utcTimestamp(startedAt),
        utcTimestamp(),
        files
      ),
      outputPath: await evidence.folder(),
      includeHidden,
      includeVariables,
      includeStyles,
    };
    await evidence.write("manifest.json", canonicalBytes(manifest));
    await evidence.publish();
    return manifest;
  } catch (err) {
    const message =
      err instanceof DumpError
        ? err.message
        : `${TOOL} failed while it wrote the files: ${errorMessage(err).replace(/[.\s]+$/, "")}. Correct the cause, then call dump_nodes again.`;
    const remaining = await evidence.discard();
    throw new Error(
      remaining.length === 0
        ? `${message} No file of this call remains.`
        : `${message} These files of the call could not be removed and are not evidence: ${remaining.join(", ")}`
    );
  }
}

/**
 * Reads the identity of the file again, and fails when another plugin
 * session served part of the call.
 * @param node - The node of this process.
 * @param before - The identity at the start of the call.
 * @param rootIds - The roots, for the message.
 */
const checkSession = async (
  node: Node,
  before: EvidenceIdentity,
  rootIds: readonly string[]
): Promise<void> => {
  const where = `for the roots ${rootIds.join(", ")}`;
  let after: EvidenceIdentity;
  try {
    after = await resolveFileIdentity(node, before.fileKey);
  } catch (err) {
    throw dumpError(
      where,
      `the identity of the file could not be read again: ${errorMessage(err)}`,
      KEEP_PLUGIN_OPEN
    );
  }
  const change = sessionChange(before, after);
  if (change !== null) {
    throw dumpError(
      where,
      `the plugin session changed during the dump (${change}), so the chunks can come from two sessions`,
      "Call dump_nodes again while the plugin stays open."
    );
  }
};

/**
 * Registers this area's tools.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 */
export function register(server: McpServer, node: Node): void {
  server.tool(
    TOOL,
    "Dump nodes to disk as evidence for an audit, and return only the manifest: paths, sizes, counts, and SHA-256 values, never node data. Each root gets one file of canonical JSON (sorted keys, no whitespace), named after its ID with _ for : (12:34 gives 12_34.json), with the complete subtree: hidden nodes, paints, and effects are kept and marked visible: false, and the nodes inside instances are included. Each node holds the fields of get_node plus mainComponentId, componentSetId, detachedInfo, reactions, flowStartingPoints, styledTextSegments, and the boundVariables of each paint. includeVariables adds variables.json and includeStyles adds styles.json. The files go under the output root of this server process (FIGMA_BRIDGE_OUTPUT_ROOT, or its working directory when unset), in outputPath, which defaults to dumps/<UTC time>. A file is never overwritten: a target that exists refuses the call before it reads anything. The plugin sends each root in chunks; a failed chunk, a broken tree, or a plugin session that changes during the call fails it, and no file of the call remains. The editor freezes while a chunk runs, so dump a big root in its own call. When multiple files are connected, specify fileKey.",
    dumpNodesInput.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(dumpNodesInput, args);
      if (!parsed.success) return parsed.error;
      try {
        const manifest = await executeDumpNodes(node, parsed.data);
        return { content: [{ type: "text", text: canonicalJson(manifest) }] };
      } catch (err) {
        return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
      }
    }
  );
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
