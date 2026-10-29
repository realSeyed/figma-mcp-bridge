/**
 * BR-8: the write journal. The leader records each write request that it
 * sends to a plugin connection, with its response, in an append-only file with
 * a hash chain. Runs real server processes and a simulated plugin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, fsyncSync, writeSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/evidence.js";
import {
  digestLongStrings,
  entryHash,
  GENESIS_HASH,
  MAX_JOURNAL_STRING,
  READ_ONLY_REQUESTS,
  WriteJournal,
  type JournalEntry,
  type JournalFs,
  type JournalRecord,
} from "../src/journal.js";
import { AUDITOR_INTERNAL_COMMANDS, AUDITOR_TOOLS } from "../src/role.js";
import type { IdentityReport, JournalState } from "../src/types.js";
import { chunker, SYNTHETIC_TREE } from "./helpers/dump-tree.js";
import { Harness } from "./helpers/harness.js";
import { pngScreenshot, type PluginHandler, type SimulatedPlugin } from "./helpers/plugin.js";
import { postRpc, rawRpc } from "./helpers/rpc.js";
import type { ServerProcess } from "./helpers/server-process.js";

const FILE_KEY = "journal-file";
const NODE_ID = "1:1";
const TIMEOUT_MS = 60_000;
const MARK = { "X-Figma-Bridge-Role": "auditor" };
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The read-only list of BR-8, written out so a change to the list needs a change to its test. */
const EXPECTED_READ_ONLY = [
  "list_files",
  "get_document",
  "get_metadata",
  "get_node",
  "get_instance",
  "get_component",
  "list_components",
  "get_variable_defs",
  "get_styles",
  "list_fonts",
  "list_sections",
  "get_section",
  "dump_nodes",
  "save_screenshots",
  "scroll_and_zoom_into_view",
  "dump_nodes_chunk",
  "get_screenshot",
  "get_selection",
  "get_design_context",
  "get_motion_styles",
  "get_node_motion",
  "dump_journal",
  "dump_journal_chunk",
];

/** `EDIT_REQUEST_TYPES` of `plugin/src/main/code.ts`, written out. */
const CORE_WRITES = [
  "set_node_visibility",
  "set_text_content",
  "set_text_properties",
  "set_node_properties",
  "set_solid_fill",
  "set_gradient_fill",
  "set_effects",
  "set_stroke_properties",
  "set_auto_layout",
  "create_page",
  "create_frame",
  "create_text",
  "create_shape",
  "create_image",
  "import_html_layers",
  "duplicate_nodes",
  "reparent_nodes",
  "group_nodes",
  "ungroup_node",
  "delete_nodes",
  "apply_animation_style",
  "remove_animation_style",
  "apply_manual_keyframe_track",
  "remove_manual_keyframe_track",
  "set_timeline_duration",
];

/** Each `edit: true` entry of the plugin area files, written out. */
const EXTENSION_WRITES = [
  "create_component",
  "combine_as_variants",
  "create_instance",
  "swap_instance",
  "detach_instance",
  "add_component_property",
  "edit_component_property",
  "delete_component_property",
  "bind_component_property",
  "set_instance_properties",
  "clear_paints",
  "create_section",
  "fit_section",
  "move_to_section",
  "move_out_of_section",
  "create_text_style",
  "update_text_style",
  "delete_text_style",
  "apply_text_style",
  "create_variable_collection",
  "update_variable_collection",
  "delete_variable_collection",
  "create_variables",
  "update_variables",
  "delete_variables",
  "bind_variables",
  "e2e_fixture",
];

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** The handlers of a simulated plugin for the reads and the writes of these tests. */
function handlers(extra: Record<string, PluginHandler> = {}): Record<string, PluginHandler> {
  return {
    get_node: () => ({ id: NODE_ID, name: "synthetic-root", type: "FRAME" }),
    set_node_properties: (request) => ({ updated: request.nodeIds?.[0], synthetic: true }),
    delete_nodes: () => ({ deleted: 1 }),
    dump_nodes_chunk: chunker(SYNTHETIC_TREE),
    get_screenshot: pngScreenshot,
    ...extra,
  };
}

/** Starts a process with its own output root and working folder. */
async function start(port: number, env: Record<string, string | undefined> = {}) {
  const root = await h.tempDir("root");
  const cwd = await h.tempDir("cwd");
  return h.server({ port, cwd, env: { FIGMA_BRIDGE_OUTPUT_ROOT: root, ...env } });
}

/** A leader, a connected plugin, and a follower. */
async function bridge(
  options: { env?: Record<string, string>; extra?: Record<string, PluginHandler> } = {}
) {
  const port = await h.freePort();
  const leader = await start(port, options.env);
  expect(leader.role).toBe("LEADER");
  const plugin = await h.plugin({ port, fileKey: FILE_KEY, handlers: handlers(options.extra) });
  const follower = await start(port);
  expect(follower.role).toBe("FOLLOWER");
  return { port, leader, plugin, follower };
}

interface Ping {
  status: string;
  journal: JournalState;
}

async function ping(port: number): Promise<Ping> {
  const response = await fetch(`http://127.0.0.1:${port}/ping`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Ping;
}

async function listFiles(server: ServerProcess): Promise<IdentityReport> {
  const outcome = await server.callTool("list_files");
  if (!outcome.ok) throw new Error(`list_files failed: ${outcome.error}`);
  return outcome.data as IdentityReport;
}

async function outcomeOk(server: ServerProcess, name: string, args: Record<string, unknown>) {
  const outcome = await server.callTool(name, args);
  if (!outcome.ok) throw new Error(`${name} failed: ${outcome.error}`);
  return outcome.data;
}

/** The text of the journal file, or null when it does not exist. */
async function journalText(file: string): Promise<string | null> {
  return existsSync(file) ? readFile(file, "utf8") : null;
}

/** The entries of the journal file. An absent file has none. */
async function journalEntries(file: string): Promise<JournalEntry[]> {
  const text = (await journalText(file)) ?? "";
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as JournalEntry);
}

/** The hash of an entry, calculated here without the module under test. */
function independentHash(entry: JournalEntry): string {
  const { hash: _ignored, ...rest } = entry;
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

/** Polls until the check returns a value that is not undefined. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined> | T | undefined) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out while waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function requestTypes(plugin: SimulatedPlugin): string[] {
  return plugin.requests.map((request) => request.type);
}

describe("an entry", () => {
  test(
    "a write through a follower adds one entry that equals the request and the answer",
    async () => {
      const { port, plugin, follower } = await bridge();
      const file = await h.journalFile();

      const data = await outcomeOk(follower, "set_node_properties", {
        nodeId: NODE_ID,
        x: 5,
        fileKey: FILE_KEY,
      });

      const entries = await journalEntries(file);
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      const request = plugin.requests.find((r) => r.type === "set_node_properties")!;

      expect(entry.seq).toBe(1);
      expect(entry.timestamp).toMatch(ISO_UTC);
      expect(entry.fileKey).toBe(FILE_KEY);
      expect(entry.epoch).toBe(1);
      expect(entry.auditor).toBe(false);
      expect(entry.tool).toBe("set_node_properties");
      expect(entry.nodeIds).toEqual(request.nodeIds ?? null);
      expect(entry.params).toEqual(request.params ?? null);
      expect(entry.response).toEqual({ data });
      expect(entry.response).toEqual({ data: { updated: NODE_ID, synthetic: true } });
      expect(entry.prevHash).toBe(GENESIS_HASH);
      expect(entry.hash).toBe(independentHash(entry));

      expect((await ping(port)).journal).toEqual({
        status: "ok",
        entryCount: 1,
        headHash: entry.hash,
      });
    },
    TIMEOUT_MS
  );

  test(
    "an own MCP call of the leader process adds one entry",
    async () => {
      const { leader, plugin } = await bridge();
      const file = await h.journalFile();

      await outcomeOk(leader, "delete_nodes", {
        nodeIds: [NODE_ID],
        confirm: true,
        fileKey: FILE_KEY,
      });

      const entries = await journalEntries(file);
      expect(entries).toHaveLength(1);
      const request = plugin.requests.find((r) => r.type === "delete_nodes")!;
      expect(entries[0]).toMatchObject({
        seq: 1,
        fileKey: FILE_KEY,
        epoch: 1,
        auditor: false,
        tool: "delete_nodes",
        nodeIds: request.nodeIds ?? null,
        params: request.params ?? null,
        response: { data: { deleted: 1 } },
        prevHash: GENESIS_HASH,
      });
    },
    TIMEOUT_MS
  );

  test(
    "a plugin error is recorded as error, and an answer with no data as data null",
    async () => {
      const { port, plugin } = await bridge({
        extra: {
          delete_nodes: () => {
            throw new Error("synthetic plugin failure");
          },
          clear_paints: () => undefined,
        },
      });
      const file = await h.journalFile();
      const token = await h.token();

      const failed = await postRpc(port, token, {
        tool: "delete_nodes",
        nodeIds: [NODE_ID],
        params: { confirm: true },
        fileKey: FILE_KEY,
      });
      expect(failed.body.error).toBe("synthetic plugin failure");

      const empty = await postRpc(port, token, {
        tool: "clear_paints",
        nodeIds: ["2:1"],
        fileKey: FILE_KEY,
      });
      expect(empty.status).toBe(200);
      expect(requestTypes(plugin)).toEqual(["delete_nodes", "clear_paints"]);

      const entries = await journalEntries(file);
      expect(entries.map((entry) => entry.tool)).toEqual(["delete_nodes", "clear_paints"]);
      expect(entries[0].response).toEqual({ error: "synthetic plugin failure" });
      expect(entries[1].response).toEqual({ data: null });
      expect(entries[1].params).toEqual(plugin.requests[1].params ?? null);
    },
    TIMEOUT_MS
  );

  test(
    "a plugin disconnect while a write waits adds an entry with the error",
    async () => {
      const port = await h.freePort();
      const leader = await start(port);
      expect(leader.role).toBe("LEADER");
      const plugin = await h.plugin({
        port,
        fileKey: FILE_KEY,
        // Never answers, so the write still waits when the plugin goes away.
        handlers: { set_node_properties: () => new Promise(() => undefined) },
      });
      const file = await h.journalFile();

      const pending = postRpc(port, await h.token(), {
        tool: "set_node_properties",
        nodeIds: [NODE_ID],
        params: { x: 1 },
        fileKey: FILE_KEY,
      });
      await waitFor("the request at the plugin", () =>
        plugin.requests.length > 0 ? true : undefined
      );
      await plugin.close();

      const answer = await pending;
      expect(answer.body.error).toContain("Plugin disconnected");

      const entries = await journalEntries(file);
      expect(entries).toHaveLength(1);
      expect(entries[0].tool).toBe("set_node_properties");
      expect(entries[0].response).toEqual({ error: answer.body.error! });
    },
    TIMEOUT_MS
  );
});

describe("the chain", () => {
  test(
    "seq, prevHash and hash chain over a run of writes, and the head is the last hash",
    async () => {
      const { port, leader, follower } = await bridge();
      const file = await h.journalFile();

      for (const x of [1, 2, 3]) {
        await outcomeOk(follower, "set_node_properties", { nodeId: NODE_ID, x, fileKey: FILE_KEY });
      }

      const text = (await journalText(file))!;
      expect(text.endsWith("\n")).toBe(true);
      const lines = text.slice(0, -1).split("\n");
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(canonicalJson(JSON.parse(line))).toBe(line);
      }
      expect(text.charCodeAt(0)).not.toBe(0xfeff);

      const entries = lines.map((line) => JSON.parse(line) as JournalEntry);
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
      expect(entries.map((entry) => entry.params?.x)).toEqual([1, 2, 3]);
      let previous = GENESIS_HASH;
      for (const entry of entries) {
        expect(entry.prevHash).toBe(previous);
        expect(entry.hash).toBe(independentHash(entry));
        expect(entry.hash).toBe(entryHash(entry));
        previous = entry.hash;
      }

      const expected: JournalState = { status: "ok", entryCount: 3, headHash: previous };
      expect((await ping(port)).journal).toEqual(expected);
      expect((await listFiles(leader)).journal).toEqual(expected);
      expect((await listFiles(follower)).journal).toEqual(expected);
    },
    TIMEOUT_MS
  );

  test(
    "a restart with the same file keeps the count and the head, and the next entry follows",
    async () => {
      const firstPort = await h.freePort();
      const first = await start(firstPort);
      expect(first.role).toBe("LEADER");
      await h.plugin({ port: firstPort, fileKey: FILE_KEY, handlers: handlers() });
      for (const x of [1, 2]) {
        await outcomeOk(first, "set_node_properties", { nodeId: NODE_ID, x, fileKey: FILE_KEY });
      }
      const before = (await ping(firstPort)).journal;
      expect(before.entryCount).toBe(2);
      await first.close();

      const secondPort = await h.freePort();
      const second = await start(secondPort);
      expect(second.role).toBe("LEADER");
      expect((await ping(secondPort)).journal).toEqual(before);

      await h.plugin({ port: secondPort, fileKey: FILE_KEY, handlers: handlers() });
      await outcomeOk(second, "set_node_properties", { nodeId: NODE_ID, x: 3, fileKey: FILE_KEY });

      const entries = await journalEntries(await h.journalFile());
      expect(entries).toHaveLength(3);
      expect(entries[2].seq).toBe(3);
      expect(entries[2].prevHash).toBe(before.headHash);
      expect((await ping(secondPort)).journal).toEqual({
        status: "ok",
        entryCount: 3,
        headHash: entries[2].hash,
      });
    },
    TIMEOUT_MS
  );
});

describe("no entry", () => {
  test(
    "for reads, dumps, captures, list_files, refusals, and a write with no connected file",
    async () => {
      const port = await h.freePort();
      const leader = await start(port);
      expect(leader.role).toBe("LEADER");
      const file = await h.journalFile();
      const token = await h.token();

      // A write with no connected file reaches no plugin.
      const unconnected = await leader.callTool("set_node_properties", { nodeId: NODE_ID, x: 1 });
      expect(unconnected.ok).toBe(false);

      const plugin = await h.plugin({ port, fileKey: FILE_KEY, handlers: handlers() });
      const follower = await start(port);
      expect(follower.role).toBe("FOLLOWER");

      await outcomeOk(follower, "get_node", { nodeId: NODE_ID, fileKey: FILE_KEY });
      const shot = await leader.callToolRaw("get_screenshot", {
        nodeIds: [NODE_ID],
        fileKey: FILE_KEY,
      });
      expect(shot.isError).toBe(false);
      await outcomeOk(follower, "dump_nodes", {
        nodeIds: [NODE_ID],
        outputPath: "dumps/run-1",
        fileKey: FILE_KEY,
      });
      await outcomeOk(follower, "save_screenshots", {
        items: [{ nodeId: NODE_ID, outputPath: "shots/one.png" }],
        fileKey: FILE_KEY,
      });
      await listFiles(leader);
      await listFiles(follower);

      // A validation 400, a marked write (403), and a write for a file that is not connected.
      const invalid = await postRpc(port, token, {
        tool: "set_node_properties",
        nodeIds: ["not-an-id"],
        params: { x: 1 },
        fileKey: FILE_KEY,
      });
      expect(invalid.status).toBe(400);
      const marked = await rawRpc(port, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...MARK },
        body: JSON.stringify({
          tool: "delete_nodes",
          nodeIds: [NODE_ID],
          params: { confirm: true },
        }),
      });
      expect(marked.status).toBe(403);
      const otherFile = await postRpc(port, token, {
        tool: "set_node_properties",
        nodeIds: [NODE_ID],
        params: { x: 1 },
        fileKey: "not-connected",
      });
      expect(otherFile.body.error).toContain("No plugin connected");

      expect(requestTypes(plugin)).toContain("get_node");
      expect(requestTypes(plugin)).toContain("get_screenshot");
      expect(requestTypes(plugin)).toContain("dump_nodes_chunk");
      expect(requestTypes(plugin)).not.toContain("set_node_properties");
      expect(requestTypes(plugin)).not.toContain("delete_nodes");

      expect(await journalText(file)).toBeNull();
      expect((await ping(port)).journal).toEqual({
        status: "ok",
        entryCount: 0,
        headHash: GENESIS_HASH,
      });
    },
    TIMEOUT_MS
  );
});

describe("the auditor role", () => {
  test(
    "a leader with the auditor role records an unmarked write of a follower with auditor false",
    async () => {
      const { follower } = await bridge({ env: { FIGMA_BRIDGE_ROLE: "auditor" } });

      await outcomeOk(follower, "set_node_properties", {
        nodeId: NODE_ID,
        x: 5,
        fileKey: FILE_KEY,
      });

      const entries = await journalEntries(await h.journalFile());
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ tool: "set_node_properties", auditor: false });
    },
    TIMEOUT_MS
  );
});

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

describe("a broken chain", () => {
  const { text: VALID, entries: ENTRIES } = syntheticJournal();
  const lines = VALID.slice(0, -1).split("\n");

  const cases: Array<{ name: string; text: string; reason: RegExp; valid: number }> = [
    {
      name: "a changed character in a response",
      text: VALID.replace('"ok-2"', '"ok-9"'),
      reason: /^line 2: hash is not the SHA-256/,
      valid: 1,
    },
    {
      name: "a removed line",
      text: `${lines[0]}\n${lines[2]}\n`,
      reason: /^line 2: seq is 3, not the line number 2/,
      valid: 1,
    },
    {
      name: "a line that is not canonical",
      text: `${lines[0]}\n${lines[1].replace('{"auditor":', '{ "auditor":')}\n${lines[2]}\n`,
      reason: /^line 2: the line is not the canonical JSON/,
      valid: 1,
    },
    {
      name: "a bad line before a torn last line",
      text: `${lines[0]}\n${lines[1].replace('"ok-2"', '"ok-9"')}\n${lines[2]}`,
      reason: /^line 2: hash is not the SHA-256/,
      valid: 1,
    },
  ];

  for (const broken of cases) {
    test(
      `${broken.name}: reported, each write refused, reads served, the file unchanged`,
      async () => {
        const file = join(await h.tempDir("broken"), "write-journal.jsonl");
        await writeFile(file, broken.text, "utf8");
        const original = await readFile(file);

        const { port, plugin, follower, leader } = await bridge({
          env: { FIGMA_BRIDGE_JOURNAL_FILE: file },
        });

        const state = (await ping(port)).journal;
        expect(state.status).toBe("broken");
        expect(state.reason).toMatch(broken.reason);
        expect(state.entryCount).toBe(broken.valid);
        expect(state.headHash).toBe(ENTRIES[broken.valid - 1].hash);
        expect((await listFiles(follower)).journal).toEqual(state);

        const logged = leader.stderr.filter((line) => line.includes("is broken"));
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain(file);
        expect(logged[0]).toContain(state.reason!);

        const refused = await follower.callTool("set_node_properties", {
          nodeId: NODE_ID,
          x: 1,
          fileKey: FILE_KEY,
        });
        expect(refused.ok).toBe(false);
        const message = refused.ok ? "" : refused.error;
        expect(message).toContain("is broken");
        expect(message).toContain("move the journal file aside");
        expect(message).toContain("Tell the auditor");
        const ownRefused = await leader.callTool("delete_nodes", {
          nodeIds: [NODE_ID],
          confirm: true,
          fileKey: FILE_KEY,
        });
        expect(ownRefused.ok).toBe(false);

        await outcomeOk(follower, "get_node", { nodeId: NODE_ID, fileKey: FILE_KEY });
        expect(requestTypes(plugin)).toEqual(["get_node"]);

        expect(await readFile(file)).toEqual(original);
        expect(leader.stderr.filter((line) => line.includes("is broken"))).toHaveLength(1);
      },
      TIMEOUT_MS
    );
  }
});

describe("a torn last line", () => {
  test(
    "moves aside: its bytes go to a side file, journal_recovered joins the chain, and a write succeeds",
    async () => {
      const { text: VALID, entries: ENTRIES } = syntheticJournal();
      const dir = await h.tempDir("torn");
      const file = join(dir, "write-journal.jsonl");
      // The last line lost its newline, as an append that stopped halfway leaves it.
      await writeFile(file, VALID.slice(0, -1), "utf8");
      const tornBytes = Buffer.from(`${canonicalJson(ENTRIES[2])}`, "utf8");

      const { port, leader, follower } = await bridge({
        env: { FIGMA_BRIDGE_JOURNAL_FILE: file },
      });

      const state = (await ping(port)).journal;
      expect(state.status).toBe("ok");
      expect(state.entryCount).toBe(3);

      const sideFiles = (await readdir(dir)).filter((name) =>
        name.startsWith("write-journal.jsonl.torn-")
      );
      expect(sideFiles).toHaveLength(1);
      const savedTo = join(dir, sideFiles[0]);
      expect(await readFile(savedTo)).toEqual(tornBytes);

      const entries = await journalEntries(file);
      expect(entries.slice(0, 2)).toEqual(ENTRIES.slice(0, 2));
      const recovered = entries[2];
      expect(recovered).toMatchObject({
        seq: 3,
        fileKey: "",
        epoch: 0,
        auditor: false,
        tool: "journal_recovered",
        nodeIds: null,
        params: {
          tornBytes: tornBytes.length,
          tornSha256: createHash("sha256").update(tornBytes).digest("hex"),
          savedTo,
        },
        response: { data: null },
        prevHash: ENTRIES[1].hash,
      });
      expect(recovered.hash).toBe(independentHash(recovered));
      expect(state.headHash).toBe(recovered.hash);
      expect(leader.stderr.filter((line) => line.includes("ended with a torn line"))).toHaveLength(
        1
      );
      expect(leader.stderr.filter((line) => line.includes("is broken"))).toHaveLength(0);

      await outcomeOk(follower, "set_node_properties", {
        nodeId: NODE_ID,
        x: 1,
        fileKey: FILE_KEY,
      });
      const after = await journalEntries(file);
      expect(after).toHaveLength(4);
      expect(after[3]).toMatchObject({
        seq: 4,
        tool: "set_node_properties",
        prevHash: recovered.hash,
      });
      expect((await ping(port)).journal).toEqual({
        status: "ok",
        entryCount: 4,
        headHash: after[3].hash,
      });
    },
    TIMEOUT_MS
  );
});

describe("a long string", () => {
  /** The digest of a long string, calculated here without the module under test. */
  const digest = (text: string) => ({
    omitted: true,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    bytes: Buffer.byteLength(text, "utf8"),
  });

  test(
    "goes into the entry as its digest, in the params and in the response, and the plugin gets it whole",
    async () => {
      // Two bytes in UTF-8 each, so the byte count is not the length.
      const long = "é".repeat(MAX_JOURNAL_STRING + 1);
      const answer = "a".repeat(20_000);
      const { port, plugin } = await bridge({
        extra: { set_text_content: () => ({ echo: answer, short: "kept" }) },
      });

      const reply = await postRpc(port, await h.token(), {
        tool: "set_text_content",
        nodeIds: [NODE_ID],
        params: { text: long },
        fileKey: FILE_KEY,
      });
      expect(reply.body).toEqual({ data: { echo: answer, short: "kept" } });
      const request = plugin.requests.find((r) => r.type === "set_text_content")!;
      expect(request.params?.text).toBe(long);

      const [entry] = await journalEntries(await h.journalFile());
      expect(entry.params).toEqual({ ...request.params, text: digest(long) });
      expect(entry.response).toEqual({ data: { echo: digest(answer), short: "kept" } });
      expect(digest(long).bytes).toBe(2 * (MAX_JOURNAL_STRING + 1));
      expect(entry.hash).toBe(independentHash(entry));
    },
    TIMEOUT_MS
  );

  test("the digest walks arrays and objects, and keeps a string of the limit", () => {
    const limit = "x".repeat(MAX_JOURNAL_STRING);
    const over = `${limit}y`;
    const value = { list: [limit, over, 1, null, { inner: over }], flag: true };

    expect(digestLongStrings(value)).toEqual({
      list: [limit, digest(over), 1, null, { inner: digest(over) }],
      flag: true,
    });
    expect(value.list[1]).toBe(over);
  });
});

describe("the append retry", () => {
  const RECORD: JournalRecord = {
    fileKey: FILE_KEY,
    epoch: 1,
    auditor: false,
    tool: "set_node_properties",
    nodeIds: null,
    params: { nodeId: NODE_ID, x: 1 },
    response: { data: null },
  };

  const failure = (code: string): Error => Object.assign(new Error(`synthetic ${code}`), { code });

  /**
   * File calls that fail with the given codes first, then pass to node:fs.
   * @returns The calls, and the pauses that the journal asked for.
   */
  function failingFs(writeCodes: string[], fsyncCodes: string[] = []) {
    const sleeps: number[] = [];
    const fs: JournalFs = {
      writeSync(fd, buffer, offset, length) {
        const code = writeCodes.shift();
        if (code !== undefined) throw failure(code);
        return writeSync(fd, buffer, offset, length);
      },
      fsyncSync(fd) {
        const code = fsyncCodes.shift();
        if (code !== undefined) throw failure(code);
        fsyncSync(fd);
      },
      sleep: (ms) => {
        sleeps.push(ms);
      },
    };
    return { fs, sleeps };
  }

  /** A journal on a new file in a temporary folder, loaded. */
  async function journalWith(fs: JournalFs) {
    const file = join(await h.tempDir("retry"), "write-journal.jsonl");
    const journal = new WriteJournal(file, fs);
    journal.load();
    h.defer(async () => journal.close());
    return { file, journal };
  }

  test("a write that fails with EAGAIN twice is tried again, 50 ms apart, and recorded once", async () => {
    const { fs, sleeps } = failingFs(["EAGAIN", "EAGAIN"]);
    const { file, journal } = await journalWith(fs);

    const entry = journal.append(RECORD);

    expect(sleeps).toEqual([50, 50]);
    expect(journal.state()).toEqual({ status: "ok", entryCount: 1, headHash: entry.hash });
    expect(await readFile(file, "utf8")).toBe(`${canonicalJson(entry)}\n`);
  });

  test("a short write, then an interrupted one, send only the bytes not yet written", async () => {
    const asked: number[] = [];
    const fs: JournalFs = {
      writeSync(fd, buffer, offset, length) {
        asked.push(length);
        if (asked.length === 1) return writeSync(fd, buffer, offset, Math.floor(length / 2));
        if (asked.length === 2) throw failure("EINTR");
        return writeSync(fd, buffer, offset, length);
      },
      fsyncSync: (fd) => fsyncSync(fd),
      sleep: () => undefined,
    };
    const { file, journal } = await journalWith(fs);

    const entry = journal.append(RECORD);

    const line = `${canonicalJson(entry)}\n`;
    const total = Buffer.byteLength(line, "utf8");
    const rest = total - Math.floor(total / 2);
    expect(asked).toEqual([total, rest, rest]);
    expect(await readFile(file, "utf8")).toBe(line);
  });

  test("an fsync that keeps failing with EBUSY makes the journal broken after 3 more tries", async () => {
    const { fs, sleeps } = failingFs([], ["EBUSY", "EBUSY", "EBUSY", "EBUSY"]);
    const { journal } = await journalWith(fs);

    expect(() => journal.append(RECORD)).toThrow("could not record it");

    expect(sleeps).toEqual([50, 50, 50]);
    const state = journal.state();
    expect(state.status).toBe("broken");
    expect(state.reason).toBe("the append of entry 1 failed (EBUSY)");
  });

  test("an error that does not pass is not tried again", async () => {
    const { fs, sleeps } = failingFs(["ENOSPC"]);
    const { journal } = await journalWith(fs);

    expect(() => journal.append(RECORD)).toThrow("could not record it");

    expect(sleeps).toEqual([]);
    expect(journal.state().reason).toBe("the append of entry 1 failed (ENOSPC)");
  });

  test("EPERM is tried again on Windows only", async () => {
    const { fs, sleeps } = failingFs(["EPERM"]);
    const { journal } = await journalWith(fs);

    if (process.platform === "win32") {
      journal.append(RECORD);
      expect(sleeps).toEqual([50]);
      expect(journal.state().status).toBe("ok");
    } else {
      expect(() => journal.append(RECORD)).toThrow("could not record it");
      expect(sleeps).toEqual([]);
      expect(journal.state().status).toBe("broken");
    }
  });
});

describe("the read-only list", () => {
  test("the list in the source is the list of BR-8", () => {
    expect([...READ_ONLY_REQUESTS].sort()).toEqual([...EXPECTED_READ_ONLY].sort());
  });

  test("each tool and internal command of the auditor role is on the list", () => {
    for (const name of [...AUDITOR_TOOLS, ...AUDITOR_INTERNAL_COMMANDS]) {
      expect(READ_ONLY_REQUESTS.has(name)).toBe(true);
    }
  });

  test("no write is on the list", () => {
    for (const name of [...CORE_WRITES, ...EXTENSION_WRITES, "set_selection"]) {
      expect(READ_ONLY_REQUESTS.has(name)).toBe(false);
    }
  });

  test("the written-out writes are each write of the plugin source", async () => {
    const code = await readFile(join(REPO_ROOT, "plugin", "src", "main", "code.ts"), "utf8");
    const block = /const EDIT_REQUEST_TYPES = new Set<RequestType>\(\[([\s\S]*?)\]\);/.exec(code);
    expect(block).not.toBeNull();
    const core = [...block![1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    expect(core.sort()).toEqual([...CORE_WRITES].sort());

    const folder = join(REPO_ROOT, "plugin", "src", "main", "extensions");
    const extension: string[] = [];
    for (const name of await readdir(folder)) {
      const source = await readFile(join(folder, name), "utf8");
      for (const match of source.matchAll(/^\s+([a-z_0-9]+): \{ edit: true,/gm)) {
        extension.push(match[1]);
      }
    }
    expect(extension.sort()).toEqual([...EXTENSION_WRITES].sort());
  });
});

describe("the file", () => {
  test(
    "a new journal file gets the folder and file modes of the token file",
    async () => {
      const file = join(await h.tempDir("state"), "nested", "write-journal.jsonl");
      const { follower } = await bridge({ env: { FIGMA_BRIDGE_JOURNAL_FILE: file } });
      expect(existsSync(file)).toBe(false);

      await outcomeOk(follower, "set_node_properties", {
        nodeId: NODE_ID,
        x: 5,
        fileKey: FILE_KEY,
      });

      expect(existsSync(file)).toBe(true);
      if (process.platform !== "win32") {
        expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
    },
    TIMEOUT_MS
  );
});
