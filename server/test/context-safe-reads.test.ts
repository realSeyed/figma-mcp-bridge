/**
 * The context-safe reads on the server: the size backstop of `renderResponse`
 * (`FIGMA_BRIDGE_MAX_RESULT_CHARS`), the read options that reach the plugin,
 * and the discovery tools `find_nodes` and `get_design_system`, through a
 * follower and in the auditor role. Runs real server processes and a
 * simulated plugin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Harness } from "./helpers/harness.js";
import type { PluginHandler } from "./helpers/plugin.js";
import { rawRpc } from "./helpers/rpc.js";
import type { ServerProcess } from "./helpers/server-process.js";

const FILE_KEY = "reads-file";
const TIMEOUT_MS = 60_000;
const MARK = { "X-Figma-Bridge-Role": "auditor" };

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** A string that makes the JSON text of an answer about 50,000 characters. */
const BIG = "x".repeat(50_000);

const handlers: Record<string, PluginHandler> = {
  get_styles: () => ({ paints: [{ id: "S:1,", name: "Big", note: BIG }] }),
  set_node_visibility: () => ({ results: [{ nodeId: "1:1", note: BIG }] }),
  get_document: () => ({ id: "0:1", name: "Page", type: "PAGE" }),
  get_node: () => ({ id: "1:1", name: "Node", type: "FRAME" }),
  find_nodes: () => ({ items: [{ id: "1:2", name: "Button", type: "FRAME" }], truncated: false }),
  get_design_system: () => ({ counts: { components: 0 }, components: [] }),
};

async function start(port: number, env: Record<string, string | undefined> = {}) {
  const root = await h.tempDir("root");
  const cwd = await h.tempDir("cwd");
  return h.server({ port, cwd, env: { FIGMA_BRIDGE_OUTPUT_ROOT: root, ...env } });
}

/** A leader, a connected plugin, and a follower, each with the given environment. */
async function bridge(env: Record<string, string | undefined> = {}) {
  const port = await h.freePort();
  const leader = await start(port, env);
  expect(leader.role).toBe("LEADER");
  const plugin = await h.plugin({ port, fileKey: FILE_KEY, handlers });
  const follower = await start(port, env);
  expect(follower.role).toBe("FOLLOWER");
  return { port, leader, plugin, follower };
}

/** The error text of a call that must fail; a client can also throw it. */
async function failure(
  server: ServerProcess,
  tool: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    const outcome = await server.callTool(tool, { fileKey: FILE_KEY, ...args });
    if (outcome.ok) throw new Error(`${tool} succeeded: ${JSON.stringify(outcome.data)}`);
    return outcome.error;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("the result size backstop", () => {
  test(
    "refuses a 50,000-character read with the tool name and a way to narrow it",
    async () => {
      const { leader, follower } = await bridge();
      for (const server of [leader, follower]) {
        const error = await failure(server, "get_styles", {});
        expect(error).toMatch(/^get_styles returned \d+ characters/);
        expect(error).toContain("(38000)");
        expect(error).toContain("find_nodes or get_design_system");
        expect(error).not.toContain(BIG.slice(0, 100));
      }
    },
    TIMEOUT_MS
  );

  test(
    "returns a write over the limit as a success with resultOmitted",
    async () => {
      const { leader, plugin } = await bridge();
      const outcome = await leader.callTool("set_node_visibility", {
        items: [{ nodeId: "1:1", visible: true }],
        fileKey: FILE_KEY,
      });
      expect(outcome.ok).toBe(true);
      const data = (outcome as { data: Record<string, unknown> }).data;
      expect(data.ok).toBe(true);
      expect(data.resultOmitted).toBe(true);
      expect(data.chars as number).toBeGreaterThan(50_000);
      expect(data.note).toContain("The call succeeded");
      expect(plugin.requests.map((request) => request.type)).toEqual(["set_node_visibility"]);
    },
    TIMEOUT_MS
  );

  test(
    "FIGMA_BRIDGE_MAX_RESULT_CHARS raises the limit",
    async () => {
      const { follower } = await bridge({ FIGMA_BRIDGE_MAX_RESULT_CHARS: "100000" });
      const outcome = await follower.callTool("get_styles", { fileKey: FILE_KEY });
      expect(outcome.ok).toBe(true);
      const paints = (outcome as { data: { paints: { note: string }[] } }).data.paints;
      expect(paints[0].note).toBe(BIG);
    },
    TIMEOUT_MS
  );
});

describe("the read options", () => {
  test(
    "reach the plugin from a follower",
    async () => {
      const { plugin, follower } = await bridge();
      const document = await follower.callTool("get_document", {
        pageId: "2:1",
        depth: 1,
        detail: "outline",
        fileKey: FILE_KEY,
      });
      expect(document.ok).toBe(true);
      const node = await follower.callTool("get_node", {
        nodeId: "1:1",
        depth: 0,
        fileKey: FILE_KEY,
      });
      expect(node.ok).toBe(true);

      const [documentRequest, nodeRequest] = plugin.requests;
      expect(documentRequest.params).toMatchObject({ pageId: "2:1", depth: 1, detail: "outline" });
      expect(nodeRequest.nodeIds).toEqual(["1:1"]);
      expect(nodeRequest.params).toMatchObject({ depth: 0 });
    },
    TIMEOUT_MS
  );

  test(
    "refuse a bad detail and a negative depth before the plugin",
    async () => {
      const { plugin, follower } = await bridge();
      expect(await failure(follower, "get_document", { detail: "summary" })).toMatch(
        /full|outline|invalid/i
      );
      expect(await failure(follower, "get_node", { nodeId: "1:1", depth: -1 })).toMatch(/0|small/i);
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );
});

describe("the discovery tools", () => {
  test(
    "find_nodes and get_design_system work through a follower",
    async () => {
      const { plugin, follower } = await bridge();
      const found = await follower.callTool("find_nodes", {
        name: "Button",
        types: ["FRAME", "INSTANCE"],
        limit: 10,
        fileKey: FILE_KEY,
      });
      expect(found.ok).toBe(true);
      expect((found as { data: { items: unknown[] } }).data.items).toHaveLength(1);

      const system = await follower.callTool("get_design_system", {
        include: ["components"],
        fileKey: FILE_KEY,
      });
      expect(system.ok).toBe(true);

      expect(plugin.requests.map((request) => request.type)).toEqual([
        "find_nodes",
        "get_design_system",
      ]);
      expect(plugin.requests[0].params).toMatchObject({
        name: "Button",
        types: ["FRAME", "INSTANCE"],
        limit: 10,
      });
      expect(plugin.requests[1].params).toMatchObject({ include: ["components"] });
    },
    TIMEOUT_MS
  );

  test(
    "find_nodes needs name or types, and takes a limit of 500 at most",
    async () => {
      const { plugin, follower } = await bridge();
      expect(await failure(follower, "find_nodes", {})).toContain("name, types, or both");
      expect(await failure(follower, "find_nodes", { name: "x", limit: 501 })).toMatch(/500|big/i);
      expect(await failure(follower, "find_nodes", { types: ["PAGE"] })).toMatch(/invalid|enum/i);
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "the auditor role does not register them, and the leader refuses a marked request",
    async () => {
      const auditor = await start(await h.freePort(), { FIGMA_BRIDGE_ROLE: "auditor" });
      const names = await auditor.listTools();
      expect(names).toHaveLength(16);
      expect(names).not.toContain("find_nodes");
      expect(names).not.toContain("get_design_system");

      const { port, plugin } = await bridge();
      const token = await h.token();
      for (const tool of ["find_nodes", "get_design_system"]) {
        const answer = await rawRpc(port, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...MARK,
          },
          body: JSON.stringify({ tool, params: { name: "x" }, fileKey: FILE_KEY }),
        });
        expect(answer.status).toBe(403);
        expect(answer.body.error).toContain(tool);
      }
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );
});
