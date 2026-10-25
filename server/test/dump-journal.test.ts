/**
 * BR-8: the dump of the write journal. `dump_journal` runs in the process that
 * serves the call, fetches the entries with `dump_journal_chunk`, which the
 * leader serves itself from the journal file, and writes `journal.json` and
 * `manifest.json` under the output root of that process. Runs real server
 * processes and a simulated plugin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../src/evidence.js";
import { entryHash, GENESIS_HASH, type JournalEntry } from "../src/journal.js";
import type { JournalState } from "../src/types.js";
import { Harness } from "./helpers/harness.js";
import type { PluginHandler, SimulatedPlugin } from "./helpers/plugin.js";
import { postRpc, rawRpc } from "./helpers/rpc.js";
import type { ServerProcess } from "./helpers/server-process.js";

const FILE_KEY = "dump-journal-file";
const NODE_ID = "1:1";
const TIMEOUT_MS = 60_000;
const MARK = { "X-Figma-Bridge-Role": "auditor" };

/** The fields of the manifest of BR-8, and no other. */
const MANIFEST_FIELDS = [
  "bridgeCommit",
  "entryCount",
  "files",
  "finishedAt",
  "genesisHash",
  "headHash",
  "leaderCommit",
  "leaderStartedAt",
  "outputPath",
  "outputRoot",
  "startedAt",
  "tool",
];

interface JournalManifest {
  tool: string;
  bridgeCommit: string;
  leaderCommit: string;
  leaderStartedAt: string;
  outputRoot: string;
  outputPath: string;
  startedAt: string;
  finishedAt: string;
  entryCount: number;
  headHash: string;
  genesisHash: string;
  files: Array<{ kind: string; path: string; sha256: string; bytes: number; entryCount: number }>;
}

interface JournalDump {
  genesisHash: string;
  entries: JournalEntry[];
}

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** The handlers of a simulated plugin for the writes of these tests. */
function handlers(): Record<string, PluginHandler> {
  return {
    get_node: () => ({ id: NODE_ID, name: "synthetic-root", type: "FRAME" }),
    set_node_properties: (request) => ({ updated: request.nodeIds?.[0], synthetic: true }),
  };
}

interface Started {
  server: ServerProcess;
  /** The output root of the process. */
  root: string;
}

/** Starts a process with its own output root and working folder. */
async function start(port: number, env: Record<string, string | undefined> = {}): Promise<Started> {
  const root = await h.tempDir("root");
  const cwd = await h.tempDir("cwd");
  const server = await h.server({ port, cwd, env: { FIGMA_BRIDGE_OUTPUT_ROOT: root, ...env } });
  return { server, root };
}

/** A leader, a connected plugin, and a follower. */
async function bridge(
  options: { leaderEnv?: Record<string, string>; followerEnv?: Record<string, string> } = {}
) {
  const port = await h.freePort();
  const leader = await start(port, options.leaderEnv);
  expect(leader.server.role).toBe("LEADER");
  const plugin = await h.plugin({ port, fileKey: FILE_KEY, handlers: handlers() });
  const follower = await start(port, options.followerEnv);
  expect(follower.server.role).toBe("FOLLOWER");
  return { port, leader, plugin, follower };
}

async function journalState(port: number): Promise<JournalState> {
  const response = await fetch(`http://127.0.0.1:${port}/ping`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { journal: JournalState }).journal;
}

/** Sends `count` writes through the server. */
async function writes(server: ServerProcess, count: number): Promise<void> {
  for (let x = 1; x <= count; x++) {
    const outcome = await server.callTool("set_node_properties", {
      nodeId: NODE_ID,
      x,
      fileKey: FILE_KEY,
    });
    if (!outcome.ok) throw new Error(`set_node_properties failed: ${outcome.error}`);
  }
}

/** Calls `dump_journal` and returns the manifest. */
async function dump(server: ServerProcess, args: Record<string, unknown> = {}) {
  const outcome = await server.callTool("dump_journal", args);
  if (!outcome.ok) throw new Error(`dump_journal failed: ${outcome.error}`);
  return outcome.data as JournalManifest;
}

/** The bytes and the parsed content of the journal file of a manifest. */
async function journalFile(root: string, manifest: JournalManifest) {
  expect(manifest.files).toHaveLength(1);
  const bytes = await readFile(join(root, manifest.files[0].path));
  return { bytes, dump: JSON.parse(bytes.toString("utf8")) as JournalDump };
}

/** The hash of an entry, calculated here without the module under test. */
function independentHash(entry: JournalEntry): string {
  const { hash: _ignored, ...rest } = entry;
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Each file under a folder, relative to it, with `/`. */
async function filesUnder(folder: string): Promise<string[]> {
  if (!existsSync(folder)) return [];
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(folder.length + 1)
        .replace(/\\/g, "/")
    )
    .sort();
}

function requestTypes(plugin: SimulatedPlugin): string[] {
  return plugin.requests.map((request) => request.type);
}

/** A valid journal of three synthetic entries, as the leader writes it. */
function syntheticJournal(): { text: string; entries: JournalEntry[] } {
  const entries: JournalEntry[] = [];
  let prevHash = GENESIS_HASH;
  for (const seq of [1, 2, 3]) {
    const unhashed = {
      seq,
      timestamp: `2026-01-01T00:00:0${seq}.000Z`,
      fileKey: FILE_KEY,
      epoch: 1,
      auditor: false,
      tool: "set_node_properties",
      nodeIds: null,
      params: { nodeId: NODE_ID, x: seq },
      response: { data: { result: `ok-${seq}` } },
      prevHash,
    };
    const entry = { ...unhashed, hash: entryHash(unhashed) };
    entries.push(entry);
    prevHash = entry.hash;
  }
  return { text: entries.map((entry) => `${canonicalJson(entry)}\n`).join(""), entries };
}

describe("the dump", () => {
  test(
    "an empty journal gives no entry, the genesis hash as the head, and the fields of BR-8",
    async () => {
      const { follower } = await bridge();

      const manifest = await dump(follower.server);

      expect(Object.keys(manifest).sort()).toEqual(MANIFEST_FIELDS);
      expect(manifest.tool).toBe("dump_journal");
      expect(manifest.entryCount).toBe(0);
      expect(manifest.headHash).toBe(GENESIS_HASH);
      expect(manifest.genesisHash).toBe(GENESIS_HASH);
      expect(manifest.outputPath).toMatch(/^journal\/\d{8}T\d{6}Z$/);
      expect(manifest.files).toEqual([
        {
          kind: "journal",
          path: `${manifest.outputPath}/journal.json`,
          sha256: manifest.files[0].sha256,
          bytes: manifest.files[0].bytes,
          entryCount: 0,
        },
      ]);

      const { bytes } = await journalFile(follower.root, manifest);
      expect(bytes.toString("utf8")).toBe(
        canonicalJson({ genesisHash: GENESIS_HASH, entries: [] })
      );
      const onDisk = await readFile(join(follower.root, manifest.outputPath, "manifest.json"));
      expect(onDisk.toString("utf8")).toBe(canonicalJson(manifest));
    },
    TIMEOUT_MS
  );

  test(
    "after five writes the file is canonical, matches the manifest, and its chain holds",
    async () => {
      const { port, follower } = await bridge();
      await writes(follower.server, 5);

      const manifest = await dump(follower.server);
      const { bytes, dump: content } = await journalFile(follower.root, manifest);

      expect(bytes.toString("utf8")).toBe(canonicalJson(content));
      expect(manifest.files[0].sha256).toBe(sha256(bytes));
      expect(manifest.files[0].bytes).toBe(bytes.length);
      expect(manifest.entryCount).toBe(5);
      expect(manifest.files[0].entryCount).toBe(5);
      expect(content.genesisHash).toBe(GENESIS_HASH);
      expect(content.entries).toHaveLength(5);

      let previous = GENESIS_HASH;
      content.entries.forEach((entry, index) => {
        expect(entry.seq).toBe(index + 1);
        expect(entry.prevHash).toBe(previous);
        expect(entry.hash).toBe(independentHash(entry));
        previous = entry.hash;
      });
      expect(manifest.headHash).toBe(previous);
      expect((await journalState(port)).headHash).toBe(manifest.headHash);

      const lines = (await readFile(await h.journalFile(), "utf8")).split("\n").filter(Boolean);
      expect(content.entries.map((entry) => canonicalJson(entry))).toEqual(lines);
    },
    TIMEOUT_MS
  );

  test(
    "the chunk sizes 1, 2 and 500 give byte-identical files, through a follower and the leader",
    async () => {
      const port = await h.freePort();
      const leader = await start(port, { FIGMA_BRIDGE_JOURNAL_CHUNK_ENTRIES: "2" });
      const plugin = await h.plugin({ port, fileKey: FILE_KEY, handlers: handlers() });
      await writes(leader.server, 5);

      const files: string[] = [];
      for (const size of ["1", "2", "500"]) {
        const follower = await start(port, { FIGMA_BRIDGE_JOURNAL_CHUNK_ENTRIES: size });
        expect(follower.server.role).toBe("FOLLOWER");
        const manifest = await dump(follower.server);
        files.push((await journalFile(follower.root, manifest)).bytes.toString("utf8"));
      }
      // The own call of the leader reads the journal directly.
      const own = await dump(leader.server);
      files.push((await journalFile(leader.root, own)).bytes.toString("utf8"));

      expect(new Set(files).size).toBe(1);
      expect((JSON.parse(files[0]) as JournalDump).entries).toHaveLength(5);
      expect(requestTypes(plugin).filter((type) => type !== "set_node_properties")).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a chunk size that is not an integer of 1 or more fails with the variable",
    async () => {
      const { follower } = await bridge({
        followerEnv: { FIGMA_BRIDGE_JOURNAL_CHUNK_ENTRIES: "0" },
      });

      const outcome = await follower.server.callTool("dump_journal");

      expect(outcome.ok).toBe(false);
      const message = outcome.ok ? "" : outcome.error;
      expect(message).toContain("FIGMA_BRIDGE_JOURNAL_CHUNK_ENTRIES");
      expect(message).toContain("integer of 1 or more");
      expect(await filesUnder(follower.root)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a dump adds no entry and does not change the head",
    async () => {
      const { port, follower, leader, plugin } = await bridge();
      await writes(follower.server, 2);
      const before = await journalState(port);
      const text = await readFile(await h.journalFile());

      await dump(follower.server);
      await dump(leader.server);

      expect(await journalState(port)).toEqual(before);
      expect(await readFile(await h.journalFile())).toEqual(text);
      expect(requestTypes(plugin)).toEqual(["set_node_properties", "set_node_properties"]);
    },
    TIMEOUT_MS
  );
});

describe("the serving process", () => {
  test(
    "a follower writes under its own output root, and nothing lands under the leader root",
    async () => {
      const { follower, leader } = await bridge();
      await writes(follower.server, 1);

      const manifest = await dump(follower.server, { outputPath: "evidence/journal-a" });

      expect(await filesUnder(follower.root)).toEqual([
        "evidence/journal-a/journal.json",
        "evidence/journal-a/manifest.json",
      ]);
      expect(manifest.outputPath).toBe("evidence/journal-a");
      expect(await filesUnder(leader.root)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a follower sends the chunks over /rpc with the token: another token fails the dump",
    async () => {
      const port = await h.freePort();
      await start(port);
      await h.plugin({ port, fileKey: FILE_KEY, handlers: handlers() });
      const otherToken = join(await h.tempDir("other-token"), "rpc-token");
      const stranger = await start(port, { FIGMA_BRIDGE_TOKEN_FILE: otherToken });
      expect(stranger.server.role).toBe("FOLLOWER");

      const outcome = await stranger.server.callTool("dump_journal");

      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? "" : outcome.error).toContain("not the install token");
      expect(await filesUnder(stranger.root)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "an auditor process lists dump_journal and dumps the journal with marked requests",
    async () => {
      const { port } = await bridge();
      const auditor = await start(port, { FIGMA_BRIDGE_ROLE: "auditor" });
      expect(auditor.server.role).toBe("FOLLOWER");

      const names = await auditor.server.listTools();
      expect(names).toHaveLength(16);
      expect(names).toContain("dump_journal");

      const manifest = await dump(auditor.server);
      expect(manifest.entryCount).toBe(0);

      // A marked request may send the chunk command, and nothing else that writes.
      const token = await h.token();
      const marked = await rawRpc(port, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...MARK },
        body: JSON.stringify({
          tool: "dump_journal_chunk",
          params: { afterSeq: 0, throughSeq: null, maxEntries: 10 },
        }),
      });
      expect(marked.status).toBe(200);
    },
    TIMEOUT_MS
  );
});

describe("the leader over /rpc", () => {
  test(
    "refuses dump_journal with 400, and serves dump_journal_chunk without the plugin",
    async () => {
      const { port, follower, plugin } = await bridge();
      await writes(follower.server, 3);
      const token = await h.token();
      const sent = plugin.requests.length;

      const refused = await postRpc(port, token, { tool: "dump_journal" });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain("dump_journal_chunk");

      const first = await postRpc(port, token, {
        tool: "dump_journal_chunk",
        params: { afterSeq: 0, throughSeq: null, maxEntries: 2 },
      });
      expect(first.status).toBe(200);
      const chunk = first.body.data as {
        status: string;
        entryCount: number;
        headHash: string;
        entries: JournalEntry[];
      };
      expect(chunk.status).toBe("ok");
      expect(chunk.entryCount).toBe(3);
      expect(chunk.headHash).toBe((await journalState(port)).headHash);
      expect(chunk.entries.map((entry) => entry.seq)).toEqual([1, 2]);

      const rest = await postRpc(port, token, {
        tool: "dump_journal_chunk",
        params: { afterSeq: 2, throughSeq: 3, maxEntries: 2 },
      });
      expect((rest.body.data as { entries: JournalEntry[] }).entries.map((e) => e.seq)).toEqual([
        3,
      ]);

      const bad = await postRpc(port, token, {
        tool: "dump_journal_chunk",
        params: { afterSeq: -1, throughSeq: null, maxEntries: 0 },
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toContain("afterSeq");
      expect(bad.body.error).toContain("maxEntries");

      const beyond = await postRpc(port, token, {
        tool: "dump_journal_chunk",
        params: { afterSeq: 0, throughSeq: 9, maxEntries: 2 },
      });
      expect(beyond.body.error).toContain("not in the journal");

      expect(plugin.requests.length).toBe(sent);
      expect((await journalState(port)).entryCount).toBe(3);
    },
    TIMEOUT_MS
  );
});

describe("a refused or failed dump", () => {
  test(
    "a target that exists refuses the call before the first chunk, and stays the same",
    async () => {
      const { follower } = await bridge();
      const folder = join(follower.root, "taken");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "journal.json"), "synthetic", "utf8");

      const outcome = await follower.server.callTool("dump_journal", { outputPath: "taken" });

      expect(outcome.ok).toBe(false);
      const message = outcome.ok ? "" : outcome.error;
      expect(message).toContain("before the first chunk");
      expect(message).toContain("never overwritten");
      expect(await readFile(join(folder, "journal.json"), "utf8")).toBe("synthetic");
      expect(await filesUnder(follower.root)).toEqual(["taken/journal.json"]);
    },
    TIMEOUT_MS
  );

  test(
    "a broken journal fails the call with the reason, and no file of the call remains",
    async () => {
      const { text } = syntheticJournal();
      const file = join(await h.tempDir("broken"), "write-journal.jsonl");
      await writeFile(file, text.slice(0, -1), "utf8");
      const { port, follower, leader } = await bridge({
        leaderEnv: { FIGMA_BRIDGE_JOURNAL_FILE: file },
      });
      const reason = (await journalState(port)).reason!;
      expect(reason).toContain("torn append");

      for (const server of [follower, leader]) {
        const outcome = await server.server.callTool("dump_journal");
        expect(outcome.ok).toBe(false);
        const message = outcome.ok ? "" : outcome.error;
        expect(message).toContain("is broken");
        expect(message).toContain(reason);
        expect(message).toContain("No file was written");
        expect(await filesUnder(server.root)).toEqual([]);
      }

      // The chunk command gives the reason too.
      const answer = await postRpc(port, await h.token(), {
        tool: "dump_journal_chunk",
        params: { afterSeq: 0, throughSeq: null, maxEntries: 10 },
      });
      expect(answer.body.error).toContain(reason);
    },
    TIMEOUT_MS
  );

  test(
    "a journal file changed outside the leader fails the chain check, and no file remains",
    async () => {
      const { text } = syntheticJournal();
      const file = join(await h.tempDir("changed"), "write-journal.jsonl");
      await writeFile(file, text, "utf8");
      const { port, follower } = await bridge({ leaderEnv: { FIGMA_BRIDGE_JOURNAL_FILE: file } });
      expect((await journalState(port)).status).toBe("ok");

      // The same length, so the offsets of the leader still fit the lines.
      await writeFile(file, text.replace('"ok-2"', '"ok-9"'), "utf8");

      const outcome = await follower.server.callTool("dump_journal");

      expect(outcome.ok).toBe(false);
      const message = outcome.ok ? "" : outcome.error;
      expect(message).toContain("the hash of entry 2");
      expect(message).toContain("No file of this call remains");
      expect(await filesUnder(follower.root)).toEqual([]);
    },
    TIMEOUT_MS
  );
});
