/**
 * BR-9: `clear_paints`. The input check, the path from a follower through
 * `/rpc` to the plugin, and the auditor role, which neither registers the tool
 * nor lets the leader relay it. Runs real server processes and a simulated
 * plugin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Harness } from "./helpers/harness.js";
import type { PluginHandler, PluginRequest, SimulatedPlugin } from "./helpers/plugin.js";
import { rawRpc } from "./helpers/rpc.js";
import type { ServerProcess } from "./helpers/server-process.js";

const FILE_KEY = "paints-file";
const TIMEOUT_MS = 60_000;
const MARK = { "X-Figma-Bridge-Role": "auditor" };

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** The answer of the simulated plugin: one ok entry per node. */
const clearPaintsHandler: PluginHandler = (request: PluginRequest) => ({
  results: (request.nodeIds ?? []).map((nodeId, index) => ({
    index,
    ok: true,
    nodeId,
    nodeName: `node ${nodeId}`,
    target: request.params?.target,
    previous: [{ type: "SOLID", color: "#ff0000" }],
    previousCount: 1,
    previousStyleId: null,
    applied: true,
  })),
});

async function start(port: number, env: Record<string, string | undefined> = {}) {
  const root = await h.tempDir("root");
  const cwd = await h.tempDir("cwd");
  return h.server({ port, cwd, env: { FIGMA_BRIDGE_OUTPUT_ROOT: root, ...env } });
}

async function connectPlugin(port: number): Promise<SimulatedPlugin> {
  return h.plugin({ port, fileKey: FILE_KEY, handlers: { clear_paints: clearPaintsHandler } });
}

/** A leader, a connected plugin, and a follower. */
async function bridge() {
  const port = await h.freePort();
  const leader = await start(port);
  expect(leader.role).toBe("LEADER");
  const plugin = await connectPlugin(port);
  const follower = await start(port);
  expect(follower.role).toBe("FOLLOWER");
  return { port, leader, plugin, follower };
}

/**
 * Calls the tool and returns the refusal text. A client may report an input
 * the schema refuses as an error result or as a thrown error.
 */
async function refusal(server: ServerProcess, args: Record<string, unknown>): Promise<string> {
  try {
    const outcome = await server.callTool("clear_paints", { fileKey: FILE_KEY, ...args });
    if (outcome.ok) throw new Error("clear_paints accepted an input that the schema refuses.");
    return outcome.error;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `2:${i + 1}`);

describe("the input check", () => {
  test(
    "refuses 0 IDs and 201 IDs, and takes 200",
    async () => {
      const { plugin, follower } = await bridge();

      expect(await refusal(follower, { nodeIds: [] })).toMatch(/at least 1|too small/i);
      expect(await refusal(follower, { nodeIds: ids(201) })).toMatch(/at most 200|too big/i);
      expect(plugin.requests).toEqual([]);

      const outcome = await follower.callTool("clear_paints", {
        nodeIds: ids(200),
        fileKey: FILE_KEY,
      });
      expect(outcome.ok).toBe(true);
      expect(plugin.requests).toHaveLength(1);
      expect(plugin.requests[0].nodeIds).toHaveLength(200);
    },
    TIMEOUT_MS
  );

  test(
    "refuses a repeated ID with its index",
    async () => {
      const { plugin, follower, leader } = await bridge();

      for (const server of [follower, leader]) {
        const message = await refusal(server, { nodeIds: ["2:1", "2:2", "2:1"] });
        expect(message).toContain("nodeIds[2]: 2:1 repeats nodeIds[0]");
      }
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "refuses a bad target and a bad node ID",
    async () => {
      const { plugin, follower } = await bridge();

      expect(await refusal(follower, { nodeIds: ["2:1"], target: "backgrounds" })).toMatch(
        /fills|strokes|invalid/i
      );
      expect(await refusal(follower, { nodeIds: ["not-an-id"] })).toMatch(/node id/i);
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );
});

describe("a call through a follower", () => {
  test(
    "reaches the plugin through /rpc with nodeIds and target, and returns its results",
    async () => {
      const { plugin, follower } = await bridge();

      const outcome = await follower.callTool("clear_paints", {
        nodeIds: ["2:1", "I3:1;3:2"],
        target: "strokes",
        fileKey: FILE_KEY,
      });

      expect(outcome.ok).toBe(true);
      expect(plugin.requests).toHaveLength(1);
      expect(plugin.requests[0].type).toBe("clear_paints");
      expect(plugin.requests[0].nodeIds).toEqual(["2:1", "I3:1;3:2"]);
      expect(plugin.requests[0].params?.target).toBe("strokes");
      const { results } = (outcome as { data: { results: Array<Record<string, unknown>> } }).data;
      expect(results.map((entry) => entry.nodeId)).toEqual(["2:1", "I3:1;3:2"]);
      expect(results.every((entry) => entry.ok === true && entry.target === "strokes")).toBe(true);
    },
    TIMEOUT_MS
  );

  test(
    "sends target fills when the call names none",
    async () => {
      const { plugin, follower } = await bridge();

      const outcome = await follower.callTool("clear_paints", {
        nodeIds: ["2:1"],
        fileKey: FILE_KEY,
      });

      expect(outcome.ok).toBe(true);
      expect(plugin.requests[0].params?.target).toBe("fills");
    },
    TIMEOUT_MS
  );

  test(
    "reaches the plugin from the leader too",
    async () => {
      const { plugin, leader } = await bridge();

      const outcome = await leader.callTool("clear_paints", {
        nodeIds: ["2:1"],
        fileKey: FILE_KEY,
      });

      expect(outcome.ok).toBe(true);
      expect(plugin.requests.map((request) => request.type)).toEqual(["clear_paints"]);
    },
    TIMEOUT_MS
  );
});

describe("the auditor role", () => {
  test(
    "does not list clear_paints in tools/list",
    async () => {
      const auditor = await start(await h.freePort(), { FIGMA_BRIDGE_ROLE: "auditor" });

      const names = await auditor.listTools();

      expect(names).toHaveLength(16);
      expect(names).not.toContain("clear_paints");
    },
    TIMEOUT_MS
  );

  test(
    "is refused by the leader for a marked /rpc request, and the plugin receives nothing",
    async () => {
      const port = await h.freePort();
      const leader = await start(port);
      expect(leader.role).toBe("LEADER");
      const plugin = await connectPlugin(port);
      const token = await h.token();

      const answer = await rawRpc(port, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...MARK,
        },
        body: JSON.stringify({
          tool: "clear_paints",
          nodeIds: ["2:1"],
          params: { target: "fills" },
          fileKey: FILE_KEY,
        }),
      });

      expect(answer.status).toBe(403);
      expect(answer.body.error).toContain("clear_paints");
      expect(answer.body.error).toContain("auditor");
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );
});
