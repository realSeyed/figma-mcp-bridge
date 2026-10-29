/**
 * Session stability: the request path of a long session. Runs real server
 * processes and a simulated plugin, and needs no Figma.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Harness } from "./helpers/harness.js";
import { pngScreenshot, type PluginHandler } from "./helpers/plugin.js";
import { postRpc } from "./helpers/rpc.js";
import { SERVER_ENTRY, serverEnv } from "./helpers/server-process.js";

const FILE_KEY = "stability-file";
const NODE_ID = "1:1";
const TIMEOUT_MS = 60_000;

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** A handler that never answers. */
const never: PluginHandler = () => new Promise(() => undefined);

/** Starts a process with its own output root and working folder. */
async function start(port: number, env: Record<string, string | undefined> = {}) {
  const root = await h.tempDir("root");
  const cwd = await h.tempDir("cwd");
  return h.server({ port, cwd, env: { FIGMA_BRIDGE_OUTPUT_ROOT: root, ...env } });
}

/** Polls until the check returns a value that is not undefined. */
async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out while waiting for ${what}`);
    await sleep(25);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

interface Ping {
  version: string;
  leaderStartedAt: string;
  files: Array<{ fileKey: string }>;
  health: {
    events: Array<Record<string, unknown> & { event: string; at: string }>;
    pending: number;
    warnings: string[];
  };
}

async function ping(port: number): Promise<Ping> {
  const response = await fetch(`http://127.0.0.1:${port}/ping`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Ping;
}

/** The error text of a failed call, or a failure of the test for a call that succeeded. */
function errorOf(outcome: { ok: true; data: unknown } | { ok: false; error: string }): string {
  if (outcome.ok) throw new Error(`expected a failure, got ${JSON.stringify(outcome.data)}`);
  return outcome.error;
}

describe("the time of a request", () => {
  test(
    "a handler that never answers gives the timeout message after FIGMA_BRIDGE_REQUEST_TIMEOUT_MS",
    async () => {
      const port = await h.freePort();
      const env = { FIGMA_BRIDGE_REQUEST_TIMEOUT_MS: "2000" };
      const leader = await start(port, env);
      expect(leader.role).toBe("LEADER");
      const plugin = await h.plugin({
        port,
        fileKey: FILE_KEY,
        handlers: { set_node_properties: never, get_screenshot: pngScreenshot },
      });
      const follower = await start(port, env);
      expect(follower.role).toBe("FOLLOWER");

      const began = Date.now();
      const outcome = await follower.callTool("set_node_properties", {
        nodeId: NODE_ID,
        x: 1,
        fileKey: FILE_KEY,
      });
      const elapsed = Date.now() - began;

      expect(outcome.ok).toBe(false);
      const message = outcome.ok ? "" : outcome.error;
      expect(message).toContain(
        "set_node_properties timed out: no answer from the Figma plugin within 2 s."
      );
      expect(message).toContain("a write may still complete in Figma");
      expect(message).toContain("Check with get_node before you retry");
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(6_000);

      // The plugin gets the time of each request. The variable sets the default
      // only: a type with a row in the table keeps it.
      const shot = await leader.callToolRaw("get_screenshot", {
        nodeIds: [NODE_ID],
        fileKey: FILE_KEY,
      });
      expect(shot.isError).toBe(false);
      const sent = (type: string) => plugin.requests.find((r) => r.type === type)?.timeoutMs;
      expect(sent("set_node_properties")).toBe(2_000);
      expect(sent("get_screenshot")).toBe(120_000);
    },
    TIMEOUT_MS
  );

  test(
    "a disconnect names the tool, and adds for a write only that the change may be in the file",
    async () => {
      const port = await h.freePort();
      const leader = await start(port);
      expect(leader.role).toBe("LEADER");
      const plugin = await h.plugin({
        port,
        fileKey: FILE_KEY,
        fileName: "stability",
        handlers: { set_node_properties: never, get_node: never },
      });
      const token = await h.token();

      const write = postRpc(port, token, {
        tool: "set_node_properties",
        nodeIds: [NODE_ID],
        params: { x: 1 },
        fileKey: FILE_KEY,
      });
      const read = postRpc(port, token, {
        tool: "get_node",
        nodeIds: [NODE_ID],
        fileKey: FILE_KEY,
      });
      await waitFor("both requests at the plugin", () =>
        plugin.requests.length === 2 ? true : undefined
      );
      await plugin.close();

      expect((await write).body.error).toBe(
        `Plugin disconnected: stability (${FILE_KEY}) while set_node_properties was running. The change may or may not be in the file; check before you retry.`
      );
      expect((await read).body.error).toBe(
        `Plugin disconnected: stability (${FILE_KEY}) while get_node was running.`
      );
    },
    TIMEOUT_MS
  );
});

describe("the grace for a plugin that connects again", () => {
  test(
    "a write issued while the plugin reconnects waits for it and succeeds",
    async () => {
      const port = await h.freePort();
      const env = { FIGMA_BRIDGE_CONNECT_GRACE_MS: "10000" };
      const leader = await start(port, env);
      expect(leader.role).toBe("LEADER");
      const plugin = await h.plugin({
        port,
        fileKey: FILE_KEY,
        reconnectMs: 1_000,
        handlers: { set_node_properties: (request) => ({ updated: request.nodeIds?.[0] }) },
      });
      const follower = await start(port, env);
      expect(follower.role).toBe("FOLLOWER");

      plugin.drop();
      await waitFor("the leader to see the disconnect", async () =>
        (await ping(port)).files.length === 0 ? true : undefined
      );
      const began = Date.now();
      const outcome = await follower.callTool("set_node_properties", {
        nodeId: NODE_ID,
        x: 1,
        fileKey: FILE_KEY,
      });
      const elapsed = Date.now() - began;

      expect(outcome).toEqual({ ok: true, data: { updated: NODE_ID } });
      expect(plugin.connections).toBe(2);
      expect(elapsed).toBeGreaterThan(300);
      expect(elapsed).toBeLessThan(9_000);
    },
    TIMEOUT_MS
  );

  test(
    "after the grace a call fails with the reason, and a key that never connected fails at once",
    async () => {
      const port = await h.freePort();
      const env = { FIGMA_BRIDGE_CONNECT_GRACE_MS: "1500" };
      const leader = await start(port, env);
      expect(leader.role).toBe("LEADER");
      const plugin = await h.plugin({ port, fileKey: FILE_KEY, fileName: "stability" });
      const follower = await start(port, env);

      // The grace after the start of the leader is over; only a disconnect opens it again.
      const startedAt = Date.parse((await ping(port)).leaderStartedAt);
      await sleep(Math.max(0, startedAt + 1_700 - Date.now()));
      let began = Date.now();
      const unknown = await follower.callTool("set_node_properties", {
        nodeId: NODE_ID,
        x: 1,
        fileKey: "never-connected",
      });
      expect(Date.now() - began).toBeLessThan(1_000);
      expect(errorOf(unknown)).toContain('No plugin connected for fileKey "never-connected"');

      await plugin.close();
      await waitFor("the leader to see the disconnect", async () =>
        (await ping(port)).files.length === 0 ? true : undefined
      );
      began = Date.now();
      const gone = await follower.callTool("set_node_properties", {
        nodeId: NODE_ID,
        x: 1,
        fileKey: FILE_KEY,
      });
      const elapsed = Date.now() - began;
      expect(errorOf(gone)).toMatch(
        /^No plugin connected for "stability" \(it disconnected [\d.]+ s ago: the plugin closed the connection, code \d+\)\. Ask the user to run Plugins › Development › Figma MCP Bridge \(Fork\) in that file \(running another plugin closes this one\), then retry\.$/
      );
      expect(elapsed).toBeGreaterThan(800);
      expect(elapsed).toBeLessThan(5_000);
    },
    TIMEOUT_MS
  );
});

describe("a lost leader", () => {
  const GRACE = { FIGMA_BRIDGE_CONNECT_GRACE_MS: "10000" };
  const METADATA = { fileName: "stability", currentPage: "synthetic" };

  test(
    "SIGKILL of the leader: the follower takes over, and its reads succeed again within 10 s",
    async () => {
      const port = await h.freePort();
      const leader = await start(port, GRACE);
      expect(leader.role).toBe("LEADER");
      await h.plugin({
        port,
        fileKey: FILE_KEY,
        reconnectMs: 1_500,
        handlers: { get_metadata: () => METADATA },
      });
      const follower = await start(port, GRACE);
      expect(follower.role).toBe("FOLLOWER");

      let killedAt = 0;
      const kill = setTimeout(() => {
        leader.kill("SIGKILL");
        killedAt = Date.now();
      }, 1_000);
      const failures: string[] = [];
      let recoveredAt = 0;
      try {
        while (recoveredAt === 0) {
          const outcome = await follower.callTool("get_metadata", { fileKey: FILE_KEY });
          if (!outcome.ok) failures.push(outcome.error);
          else if (killedAt > 0) recoveredAt = Date.now();
          if (killedAt > 0 && Date.now() - killedAt > 20_000) break;
          await sleep(250);
        }
      } finally {
        clearTimeout(kill);
      }

      expect(recoveredAt).toBeGreaterThan(0);
      expect(recoveredAt - killedAt).toBeLessThan(10_000);
      for (const failure of failures) {
        expect(failure).not.toContain("fetch failed");
        expect(failure).toMatch(/retry|check|ask the user/i);
      }
      expect(follower.stderr.join("\n")).toContain("Became LEADER");
    },
    TIMEOUT_MS
  );

  test(
    "a write in flight at the kill fails as ambiguous, and a read in flight is sent again",
    async () => {
      const port = await h.freePort();
      const leader = await start(port, GRACE);
      expect(leader.role).toBe("LEADER");
      let reads = 0;
      const plugin = await h.plugin({
        port,
        fileKey: FILE_KEY,
        reconnectMs: 1_500,
        handlers: {
          create_frame: never,
          // The first read never answers, so it is in flight at the kill.
          get_metadata: () => (++reads === 1 ? new Promise(() => undefined) : METADATA),
        },
      });
      const follower = await start(port, GRACE);
      expect(follower.role).toBe("FOLLOWER");

      const write = follower.callTool("create_frame", { name: "stability", fileKey: FILE_KEY });
      const read = follower.callTool("get_metadata", { fileKey: FILE_KEY });
      await waitFor("both requests at the plugin", () =>
        plugin.requests.length === 2 ? true : undefined
      );
      leader.kill("SIGKILL");

      expect(errorOf(await write)).toBe(
        "create_frame: the bridge leader process exited while the request was in flight, so the change may or may not be in the Figma file. The bridge has recovered; check the file with get_node before you retry."
      );
      expect(await read).toEqual({ ok: true, data: METADATA });
      expect(reads).toBe(2);
      expect(plugin.requests.filter((r) => r.type === "create_frame")).toHaveLength(1);
    },
    TIMEOUT_MS
  );
});

describe("the standalone leader", () => {
  test(
    "serves a follower after the other client closes, and a second standalone exits with 1",
    async () => {
      const port = await h.freePort();
      const standalone = await h.standalone({ port, cwd: await h.tempDir("cwd") });
      const metadata = { fileName: "stability" };
      await h.plugin({ port, fileKey: FILE_KEY, handlers: { get_metadata: () => metadata } });
      const first = await start(port);
      const second = await start(port);
      expect([first.role, second.role]).toEqual(["FOLLOWER", "FOLLOWER"]);
      const before = await ping(port);

      // The MCP client of one follower ends; the leader is not its process.
      await first.close();
      expect(await second.callTool("get_metadata", { fileKey: FILE_KEY })).toEqual({
        ok: true,
        data: metadata,
      });
      expect((await ping(port)).leaderStartedAt).toBe(before.leaderStartedAt);
      expect(second.stderr.join("\n")).not.toContain("Became LEADER");
      expect(standalone.stderr.join("\n")).not.toContain("Shutting down");

      // The variable starts a standalone leader too. It never follows.
      const duplicate = spawnSync("node", [SERVER_ENTRY], {
        env: serverEnv({
          port,
          env: {
            FIGMA_BRIDGE_TOKEN_FILE: await h.tokenFile(),
            FIGMA_BRIDGE_JOURNAL_FILE: await h.journalFile(),
            FIGMA_BRIDGE_LOG_FILE: await h.logFile(),
            FIGMA_BRIDGE_STANDALONE: "1",
          },
        }),
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(duplicate.status).toBe(1);
      expect(duplicate.stderr).toContain(`A bridge leader already listens on 127.0.0.1:${port}`);
      expect(duplicate.stderr).toContain(`version ${before.version}`);
      expect(duplicate.stderr).toContain(`leaderStartedAt ${before.leaderStartedAt}`);
    },
    TIMEOUT_MS
  );
});

describe("diagnostics", () => {
  test(
    "health in /ping and list_files, lines in the log, and no token, params or data in either",
    async () => {
      const port = await h.freePort();
      const env = { FIGMA_BRIDGE_REQUEST_TIMEOUT_MS: "1000" };
      const leader = await start(port, env);
      expect(leader.role).toBe("LEADER");
      await h.plugin({
        port,
        fileKey: FILE_KEY,
        handlers: { get_metadata: () => ({ marker: "data-marker-7" }), set_node_properties: never },
      });
      const follower = await start(port, env);
      expect(follower.role).toBe("FOLLOWER");

      expect((await follower.callTool("get_metadata", { fileKey: FILE_KEY })).ok).toBe(true);
      const timedOut = await follower.callTool("set_node_properties", {
        nodeId: NODE_ID,
        name: "param-marker-9",
        fileKey: FILE_KEY,
      });
      expect(errorOf(timedOut)).toContain("timed out");

      const health = (await ping(port)).health;
      expect(health.pending).toBe(0);
      expect(health.warnings).toEqual([]);
      expect(health.events.map((event) => event.event)).toEqual(
        expect.arrayContaining(["start", "role", "plugin_connect", "request", "request_timeout"])
      );
      for (const event of health.events) {
        expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(typeof event.pid).toBe("number");
        expect(typeof event.role).toBe("string");
      }
      const read = health.events.find((e) => e.event === "request" && e.tool === "get_metadata");
      expect(read).toMatchObject({ fileKey: FILE_KEY, ok: true, role: "LEADER" });
      expect(read!.requestBytes).toBeGreaterThan(0);
      expect(read!.responseBytes).toBeGreaterThan(0);
      const timeout = health.events.find((e) => e.event === "request_timeout");
      expect(timeout).toMatchObject({
        tool: "set_node_properties",
        fileKey: FILE_KEY,
        ok: false,
        responseBytes: 0,
      });
      expect(String(timeout!.error)).toContain("timed out");

      // list_files holds the same health, from the leader and through a follower.
      for (const server of [leader, follower]) {
        const outcome = await server.callTool("list_files");
        if (!outcome.ok) throw new Error(outcome.error);
        const report = outcome.data as { health: Ping["health"]; files: unknown[] };
        expect(report.files).toHaveLength(1);
        expect(report.health.pending).toBe(0);
        expect(report.health.warnings).toEqual([]);
        expect(report.health.events.length).toBeGreaterThan(0);
        expect(report.health.events.length).toBeLessThanOrEqual(20);
      }

      const log = await readFile(await h.logFile(), "utf8");
      const lines = log
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      for (const line of lines) {
        expect(Object.keys(line).slice(0, 4)).toEqual(["at", "pid", "role", "event"]);
      }
      expect(new Set(lines.map((line) => line.pid)).size).toBe(2);
      expect(lines.some((line) => line.event === "role" && line.to === "FOLLOWER")).toBe(true);
      expect(lines.some((line) => line.event === "request_timeout")).toBe(true);

      const token = await h.token();
      for (const text of [log, ...leader.stderr, ...follower.stderr]) {
        expect(text).not.toContain(token);
      }
      for (const text of [log, JSON.stringify(health)]) {
        expect(text).not.toContain("data-marker");
        expect(text).not.toContain("param-marker");
      }
    },
    TIMEOUT_MS
  );

  test(
    "a follower warns when the leader runs another build",
    async () => {
      const port = await h.freePort();
      // A leader of another build: it answers /ping, and list_files over /rpc.
      const other = createServer((request, response) => {
        request.resume();
        response.writeHead(200, { "Content-Type": "application/json" });
        if (request.url === "/ping") {
          response.end(JSON.stringify({ status: "ok" }));
          return;
        }
        response.end(
          JSON.stringify({
            data: {
              leaderCommit: "0000000-other-build",
              leaderStartedAt: "2026-01-01T00:00:00.000Z",
              files: [],
              journal: null,
              health: { events: [], pending: 0, warnings: [] },
            },
          })
        );
      });
      await new Promise<void>((done) => other.listen(port, "127.0.0.1", () => done()));
      h.defer(
        () =>
          new Promise<void>((done) => {
            other.closeAllConnections();
            other.close(() => done());
          })
      );

      const follower = await start(port);
      expect(follower.role).toBe("FOLLOWER");
      const outcome = await follower.callTool("list_files");
      if (!outcome.ok) throw new Error(outcome.error);
      const warnings = (outcome.data as { health: { warnings: string[] } }).health.warnings;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("but the leader runs 0000000-other-build");
    },
    TIMEOUT_MS
  );
});
