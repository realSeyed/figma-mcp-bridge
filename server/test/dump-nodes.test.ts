/**
 * BR-2: dump_nodes writes complete, canonical dumps under the output root of
 * the serving process, and returns only the manifest. Runs real server
 * processes and a simulated plugin that walks a synthetic tree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TreeBuilder } from "../src/extensions/dumps.js";
import {
  allNodes,
  chunker,
  STYLES,
  SYNTHETIC_TREE,
  VARIABLE_DEFS,
  type TreeNode,
} from "./helpers/dump-tree.js";
import { Harness } from "./helpers/harness.js";
import type { PluginHandler, SimulatedPlugin } from "./helpers/plugin.js";
import { postRpc } from "./helpers/rpc.js";
import type { ServerProcess, ToolOutcome } from "./helpers/server-process.js";

const FILE_KEY = "dump-file";
const PLUGIN_BUILD = "test-build-1";
const TIMEOUT_MS = 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface ManifestFile {
  kind: string;
  nodeId: string | null;
  path: string;
  sha256: string;
  bytes: number;
  nodeCount: number | null;
  hiddenCount: number | null;
  variantCount: number | null;
}

interface Manifest {
  tool: string;
  fileKey: string;
  bridgeCommit: string;
  leaderCommit: string;
  pluginBuild: string;
  epoch: number;
  leaderStartedAt: string;
  outputRoot: string;
  outputPath: string;
  includeHidden: boolean;
  includeVariables: boolean;
  includeStyles: boolean;
  startedAt: string;
  finishedAt: string;
  files: ManifestFile[];
}

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** The handlers of a plugin that serves the synthetic file. */
function fileHandlers(dumpChunk: PluginHandler = chunker(SYNTHETIC_TREE)) {
  return {
    dump_nodes_chunk: dumpChunk,
    get_variable_defs: () => VARIABLE_DEFS,
    get_styles: () => STYLES,
  };
}

/** Starts a leader with its own output root and chunk size, and connects the plugin. */
async function leaderWithPlugin(
  options: { chunkNodes?: number; handlers?: Record<string, PluginHandler> } = {}
) {
  const port = await h.freePort();
  const root = await h.tempDir("root");
  const cwd = await h.tempDir("cwd");
  const leader = await h.server({ port, cwd, env: processEnv(root, options.chunkNodes) });
  expect(leader.role).toBe("LEADER");
  const plugin = await h.plugin({
    port,
    fileKey: FILE_KEY,
    pluginBuild: PLUGIN_BUILD,
    handlers: options.handlers ?? fileHandlers(),
  });
  return { port, root, cwd, leader, plugin };
}

/** Starts a follower with its own output root and chunk size. */
async function follower(port: number, chunkNodes?: number) {
  const root = await h.tempDir("follower-root");
  const cwd = await h.tempDir("follower-cwd");
  const server = await h.server({ port, cwd, env: processEnv(root, chunkNodes) });
  expect(server.role).toBe("FOLLOWER");
  return { root, cwd, server };
}

function processEnv(root: string, chunkNodes?: number): Record<string, string | undefined> {
  return {
    FIGMA_BRIDGE_OUTPUT_ROOT: root,
    FIGMA_BRIDGE_DUMP_CHUNK_NODES: chunkNodes === undefined ? undefined : String(chunkNodes),
  };
}

async function dump(server: ServerProcess, args: Record<string, unknown>): Promise<ToolOutcome> {
  return server.callTool("dump_nodes", { fileKey: FILE_KEY, ...args });
}

async function dumpOk(server: ServerProcess, args: Record<string, unknown>): Promise<Manifest> {
  const outcome = await dump(server, args);
  if (!outcome.ok) throw new Error(`dump_nodes failed: ${outcome.error}`);
  return outcome.data as Manifest;
}

function dumpError(outcome: ToolOutcome): string {
  if (outcome.ok)
    throw new Error(
      `dump_nodes was expected to fail, but returned ${JSON.stringify(outcome.data)}`
    );
  return outcome.error;
}

function chunkRequests(plugin: SimulatedPlugin) {
  return plugin.requests.filter((request) => request.type === "dump_nodes_chunk");
}

function fileOf(manifest: Manifest, nodeId: string | null, kind = "nodes"): ManifestFile {
  const file = manifest.files.find((entry) => entry.kind === kind && entry.nodeId === nodeId);
  if (!file)
    throw new Error(
      `the manifest has no ${kind} file for ${nodeId}: ${JSON.stringify(manifest.files)}`
    );
  return file;
}

/** Each file under a folder, as paths relative to it with `/`, sorted. Empty when it is missing. */
async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const visit = async (folder: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(folder, entry.name), `${prefix}${entry.name}/`);
      else found.push(`${prefix}${entry.name}`);
    }
  };
  await visit(dir, "");
  return found.sort();
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * An independent check of the canonical form: rebuild each object with its
 * keys inserted in sorted order, and let JSON.stringify write it. The data
 * holds no key that looks like an array index, which JSON.stringify would
 * move to the front.
 */
function sortedCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedCopy);
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort())
    copy[key] = sortedCopy((value as Record<string, unknown>)[key]);
  return copy;
}

function expectCanonical(bytes: Buffer): void {
  expect(bytes[0]).not.toBe(0xef); // no byte order mark
  const text = bytes.toString("utf8");
  expect(text.endsWith("\n")).toBe(false);
  expect(text).toBe(JSON.stringify(sortedCopy(JSON.parse(text))));
}

/** The synthetic subtree of a node as the dump writes it: the nodes as they are, hidden ones kept. */
function expectedTree(id: string, includeHidden = true): unknown {
  const build = (current: TreeNode): unknown => {
    const children = (current.children ?? []).filter(
      (child) => includeHidden || (child.styles as { visible?: boolean }).visible !== false
    );
    const { children: _children, ...self } = current;
    return children.length > 0 ? { ...self, children: children.map(build) } : self;
  };
  return build(allNodes(SYNTHETIC_TREE).find((candidate) => candidate.id === id)!);
}

describe("dump_nodes", () => {
  test(
    "three chunk sizes write byte-identical files, and each sha256 matches the file",
    async () => {
      const { port, root, leader, plugin } = await leaderWithPlugin({ chunkNodes: 1000 });
      const small = await follower(port, 1);
      const medium = await follower(port, 4);

      const runs: Array<[ServerProcess, string, number]> = [
        [small.server, small.root, 30],
        [medium.server, medium.root, 8],
        [leader, root, 1],
      ];
      const contents: Buffer[] = [];
      for (const [server, outputRoot, chunks] of runs) {
        const before = chunkRequests(plugin).length;
        const manifest = await dumpOk(server, { nodeIds: ["1:1"], outputPath: "dumps/run" });
        expect(chunkRequests(plugin).length - before).toBe(chunks);

        const file = fileOf(manifest, "1:1");
        expect(file.path).toBe("dumps/run/1_1.json");
        const bytes = await readFile(join(outputRoot, "dumps", "run", "1_1.json"));
        expect(file.sha256).toBe(sha256(bytes));
        expect(file.sha256).toMatch(SHA256);
        expect(file.bytes).toBe(bytes.byteLength);
        contents.push(bytes);

        // manifest.json holds the result, byte for byte.
        const onDisk = await readFile(join(outputRoot, "dumps", "run", "manifest.json"), "utf8");
        expect(JSON.parse(onDisk)).toEqual(manifest);
        expectCanonical(Buffer.from(onDisk, "utf8"));
        expect(await filesUnder(outputRoot)).toEqual([
          "dumps/run/1_1.json",
          "dumps/run/manifest.json",
        ]);
      }
      expect(contents[1].equals(contents[0])).toBe(true);
      expect(contents[2].equals(contents[0])).toBe(true);
      expect(JSON.parse(contents[0].toString("utf8"))).toEqual(expectedTree("1:1"));
    },
    TIMEOUT_MS
  );

  test(
    "a file is canonical JSON, named after its root with _ for :",
    async () => {
      const { root, leader } = await leaderWithPlugin({ chunkNodes: 7 });
      const manifest = await dumpOk(leader, {
        nodeIds: ["1:1", "I1:12;1:13"],
        outputPath: "canon",
      });

      expect(manifest.files.map((file) => file.path)).toEqual([
        "canon/1_1.json",
        "canon/I1_12;1_13.json",
      ]);
      for (const name of ["1_1.json", "I1_12;1_13.json", "manifest.json"]) {
        const bytes = await readFile(join(root, "canon", name));
        expectCanonical(bytes);
        expect(bytes.toString("utf8")).not.toContain("\n");
      }
      // The keys of the synthetic nodes were not in order; the file sorts them.
      const text = await readFile(join(root, "canon", "1_1.json"), "utf8");
      expect(text.startsWith('{"bounds":{"height":10,"width":10,"x":0,"y":0},"children":[')).toBe(
        true
      );
      expect(text).toContain('"characters":"Ünïcödé — ✓ 😀 \\"quoted\\" \\\\ end"');
    },
    TIMEOUT_MS
  );

  test(
    "the counts: nodes, hidden nodes, and variants for a set root and a frame root",
    async () => {
      const { root, leader } = await leaderWithPlugin({ chunkNodes: 4 });
      const manifest = await dumpOk(leader, {
        nodeIds: ["1:1", "1:5", "1:15", "I1:12;1:13"],
        outputPath: "counts",
      });
      const counts = (id: string) => {
        const { nodeCount, hiddenCount, variantCount } = fileOf(manifest, id);
        return { nodeCount, hiddenCount, variantCount };
      };
      expect(counts("1:1")).toEqual({ nodeCount: 30, hiddenCount: 5, variantCount: 5 });
      expect(counts("1:5")).toEqual({ nodeCount: 7, hiddenCount: 1, variantCount: 3 });
      expect(counts("1:15")).toEqual({ nodeCount: 10, hiddenCount: 1, variantCount: 2 });
      expect(counts("I1:12;1:13")).toEqual({ nodeCount: 2, hiddenCount: 1, variantCount: 0 });

      // The hidden nodes are in the file with their marker.
      const tree = JSON.parse(await readFile(join(root, "counts", "1_1.json"), "utf8"));
      const hidden = allNodes(tree as TreeNode)
        .filter((entry) => (entry.styles as { visible?: boolean }).visible === false)
        .map((entry) => entry.id);
      expect(hidden).toEqual(["1:4", "1:10", "I1:12;1:13", "1:21", "1:25"]);

      // Without hidden content: no hidden node, and only the visible variants.
      const visible = await dumpOk(leader, {
        nodeIds: ["1:1"],
        includeHidden: false,
        outputPath: "visible",
      });
      expect(visible.includeHidden).toBe(false);
      const { nodeCount, hiddenCount, variantCount } = fileOf(visible, "1:1");
      expect({ nodeCount, hiddenCount, variantCount }).toEqual({
        nodeCount: 21,
        hiddenCount: 0,
        variantCount: 4,
      });
      const visibleTree = JSON.parse(await readFile(join(root, "visible", "1_1.json"), "utf8"));
      expect(visibleTree).toEqual(expectedTree("1:1", false));
    },
    TIMEOUT_MS
  );

  test(
    "a chunk that fails fails the call, and no file of the call remains",
    async () => {
      let chunks = 0;
      const walk = chunker(SYNTHETIC_TREE);
      const failing: PluginHandler = (request) => {
        chunks += 1;
        if (chunks === 3) throw new Error("synthetic chunk failure.");
        return walk(request);
      };
      const { root, cwd, leader } = await leaderWithPlugin({
        chunkNodes: 4,
        handlers: fileHandlers(failing),
      });

      // 1:5 takes two chunks and is written as .partial; 1:1 fails at chunk 3.
      const error = dumpError(
        await dump(leader, { nodeIds: ["1:5", "1:1"], outputPath: "dumps/fail" })
      );
      expect(chunks).toBe(3);
      expect(error).toContain("dump_nodes failed at root 1:1, chunk 1: synthetic chunk failure.");
      expect(error).toContain("then call dump_nodes again.");
      expect(error).toContain("No file of this call remains.");
      expect(await filesUnder(root)).toEqual([]);
      expect(existsSync(join(root, "dumps"))).toBe(false);
      expect(await filesUnder(cwd)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a new plugin connection between two chunks fails the call, and no file remains",
    async () => {
      let chunks = 0;
      let replacement: Promise<SimulatedPlugin> | undefined;
      const walk = chunker(SYNTHETIC_TREE);
      const port = await h.freePort();
      const root = await h.tempDir("root");
      const leader = await h.server({
        port,
        cwd: await h.tempDir("cwd"),
        env: processEnv(root, 4),
      });
      const first: SimulatedPlugin = await h.plugin({
        port,
        fileKey: FILE_KEY,
        pluginBuild: PLUGIN_BUILD,
        handlers: fileHandlers(async (request) => {
          chunks += 1;
          if (chunks === 2) {
            // The leader replaces this connection and closes it. Its close
            // frame waits unread, so the answer below still arrives, and the
            // next chunk goes to the new connection: epoch 2.
            first.pause();
            replacement = h.plugin({
              port,
              fileKey: FILE_KEY,
              pluginBuild: PLUGIN_BUILD,
              handlers: fileHandlers(),
            });
            await replacement;
          }
          return walk(request);
        }),
      });

      const error = dumpError(await dump(leader, { nodeIds: ["1:1"], outputPath: "dumps/epoch" }));
      expect(error).toContain(
        "dump_nodes failed for the roots 1:1: the plugin session changed during the dump (epoch 1 -> 2)"
      );
      expect(error).toContain("No file of this call remains.");
      // The walk finished on the new connection; only the identity check failed it.
      expect(chunkRequests(await replacement!).length).toBe(6);
      expect(await filesUnder(root)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a target file that exists refuses the call before the first chunk",
    async () => {
      const { root, leader, plugin } = await leaderWithPlugin();
      const folder = join(root, "dumps", "taken");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "1_1.json"), "old");

      const error = dumpError(
        await dump(leader, { nodeIds: ["1:5", "1:1"], outputPath: "dumps/taken" })
      );
      expect(error).toContain("dump_nodes failed before the first chunk");
      expect(error).toContain(join(folder, "1_1.json"));
      expect(error).toContain("Evidence is never overwritten");
      expect(chunkRequests(plugin)).toHaveLength(0);
      expect(await readFile(join(folder, "1_1.json"), "utf8")).toBe("old");
      expect(await filesUnder(root)).toEqual(["dumps/taken/1_1.json"]);

      // A manifest that exists refuses the call too.
      await writeFile(join(folder, "manifest.json"), "old");
      const second = dumpError(await dump(leader, { nodeIds: ["1:5"], outputPath: "dumps/taken" }));
      expect(second).toContain(join(folder, "manifest.json"));
      expect(chunkRequests(plugin)).toHaveLength(0);

      // A repeated root is refused by the input check.
      const repeated = dumpError(await dump(leader, { nodeIds: ["1:5", "1:2", "1:5"] }));
      expect(repeated).toContain("nodeIds[2]: 1:5 repeats nodeIds[0]");
      expect(chunkRequests(plugin)).toHaveLength(0);
    },
    TIMEOUT_MS
  );

  test(
    "the variables file and the styles file hold the canonical payloads, with null counts",
    async () => {
      const { root, leader } = await leaderWithPlugin();
      const manifest = await dumpOk(leader, {
        nodeIds: ["1:15"],
        includeVariables: true,
        includeStyles: true,
      });

      expect(manifest.outputPath).toMatch(/^dumps\/\d{8}T\d{6}Z$/);
      expect(manifest.files.map((file) => file.kind)).toEqual(["nodes", "variables", "styles"]);
      for (const [kind, payload] of [
        ["variables", VARIABLE_DEFS],
        ["styles", STYLES],
      ] as const) {
        const file = fileOf(manifest, null, kind);
        expect(file.path).toBe(`${manifest.outputPath}/${kind}.json`);
        expect({
          nodeCount: file.nodeCount,
          hiddenCount: file.hiddenCount,
          variantCount: file.variantCount,
        }).toEqual({
          nodeCount: null,
          hiddenCount: null,
          variantCount: null,
        });
        const bytes = await readFile(join(root, file.path));
        expect(bytes.toString("utf8")).toBe(JSON.stringify(sortedCopy(payload)));
        expect(file.sha256).toBe(sha256(bytes));
        expect(file.bytes).toBe(bytes.byteLength);
      }

      expect(manifest).toMatchObject({
        tool: "dump_nodes",
        fileKey: FILE_KEY,
        pluginBuild: PLUGIN_BUILD,
        epoch: 1,
        includeHidden: true,
        includeVariables: true,
        includeStyles: true,
      });
      expect(manifest.bridgeCommit).toBe(manifest.leaderCommit);
      for (const time of [manifest.startedAt, manifest.finishedAt, manifest.leaderStartedAt]) {
        expect(time).toMatch(ISO_UTC);
      }
      expect(manifest.finishedAt >= manifest.startedAt).toBe(true);
    },
    TIMEOUT_MS
  );

  test(
    "a follower writes the files under its own root, and the chunks travel over /rpc",
    async () => {
      const { port, root: leaderRoot, cwd: leaderCwd, plugin } = await leaderWithPlugin();
      const { root, cwd, server } = await follower(port, 4);

      const manifest = await dumpOk(server, { nodeIds: ["1:1"], outputPath: "dumps/follower" });
      expect(await filesUnder(root)).toEqual([
        "dumps/follower/1_1.json",
        "dumps/follower/manifest.json",
      ]);
      expect(manifest.outputRoot).toBe(await realpath(root));
      expect(await filesUnder(leaderRoot)).toEqual([]);
      expect(await filesUnder(leaderCwd)).toEqual([]);
      expect(await filesUnder(cwd)).toEqual([]);

      // The plugin talks only to the leader, which admits a request from /rpc
      // only with the install token, so each chunk came over /rpc with it.
      const requests = chunkRequests(plugin);
      expect(requests).toHaveLength(8);
      expect(requests[0].params).toEqual({
        rootId: "1:1",
        cursor: null,
        maxNodes: 4,
        includeHidden: true,
      });
      // The first chunk holds 1:1, 1:2, 1:3, and 1:4; the next one starts at 1:5.
      expect(requests[1].params?.cursor).toEqual([1]);
    },
    TIMEOUT_MS
  );

  test(
    "the result holds no node data",
    async () => {
      const { leader } = await leaderWithPlugin();
      const outcome = await dump(leader, {
        nodeIds: ["1:1"],
        includeVariables: true,
        includeStyles: true,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      const text = JSON.stringify(outcome.data);
      expect(text).not.toContain('"children"');
      expect(text).not.toContain('"characters"');
      for (const entry of allNodes(SYNTHETIC_TREE)) expect(text).not.toContain(entry.name);
      expect(text).not.toContain("synthetic-tokens");
      expect(text).not.toContain("synthetic/body");
    },
    TIMEOUT_MS
  );

  test(
    "a raw /rpc request for dump_nodes gets HTTP 400 and writes nothing",
    async () => {
      const { port, root, cwd, plugin } = await leaderWithPlugin();
      const answer = await postRpc(port, await h.token(), {
        tool: "dump_nodes",
        nodeIds: ["1:1"],
        params: { outputPath: "dumps/rpc" },
        fileKey: FILE_KEY,
      });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toContain("each process serves dump_nodes itself");
      expect(answer.body.error).toContain("its own output root");
      expect(chunkRequests(plugin)).toHaveLength(0);
      expect(await filesUnder(root)).toEqual([]);
      expect(await filesUnder(cwd)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a chunk setting that is not a positive integer fails before the first chunk",
    async () => {
      const port = await h.freePort();
      const root = await h.tempDir("root");
      const leader = await h.server({
        port,
        cwd: await h.tempDir("cwd"),
        env: { FIGMA_BRIDGE_OUTPUT_ROOT: root, FIGMA_BRIDGE_DUMP_CHUNK_NODES: "0" },
      });
      const plugin = await h.plugin({ port, fileKey: FILE_KEY, handlers: fileHandlers() });
      const error = dumpError(await dump(leader, { nodeIds: ["1:1"] }));
      expect(error).toContain('FIGMA_BRIDGE_DUMP_CHUNK_NODES is "0"');
      expect(chunkRequests(plugin)).toHaveLength(0);
      expect(await filesUnder(root)).toEqual([]);
    },
    TIMEOUT_MS
  );
});

describe("the tree builder", () => {
  const record = (
    depth: number,
    childCount: number,
    id: string,
    extra: Record<string, unknown> = {}
  ) => ({
    depth,
    childCount,
    node: { id, type: "FRAME", ...extra },
  });

  test("builds the tree and leaves out children on a leaf", () => {
    const builder = new TreeBuilder("1:1");
    for (const entry of [
      record(0, 2, "1:1"),
      record(1, 1, "1:2"),
      record(2, 0, "1:3"),
      record(1, 0, "1:4"),
    ]) {
      builder.add(entry);
    }
    expect(builder.finish()).toEqual({
      id: "1:1",
      type: "FRAME",
      children: [
        { id: "1:2", type: "FRAME", children: [{ id: "1:3", type: "FRAME" }] },
        { id: "1:4", type: "FRAME" },
      ],
    });
    expect(builder.nodeCount).toBe(4);
  });

  test("refuses each record that does not fit", () => {
    const fails = (records: unknown[], message: string) => {
      const builder = new TreeBuilder("1:1");
      expect(() => {
        for (const entry of records) builder.add(entry);
        builder.finish();
      }).toThrow(message);
    };
    fails([record(1, 0, "1:1")], "the first record has the depth 1, not 0");
    fails([record(0, 0, "9:9")], 'the first record is the node "9:9", not the root');
    fails(
      [record(0, 1, "1:1"), record(2, 0, "1:2")],
      "record 1 has the depth 2, but the next node has the depth 1"
    );
    fails(
      [record(0, 0, "1:1"), record(0, 0, "1:2")],
      "record 1 follows a complete tree, so the dump has two roots"
    );
    fails([record(0, 2, "1:1"), record(1, 0, "1:2")], '"1:1" still waits for 1 of its children');
    fails([record(0, -1, "1:1")], "record 0 has the childCount -1");
    fails(
      [{ depth: 0, childCount: 0, node: { id: "1:1", children: [] } }],
      "record 0 carries children"
    );
    fails([], "the walk returned no record");
  });
});
