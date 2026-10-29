/**
 * BR-3: the auditor role. A process with FIGMA_BRIDGE_ROLE=auditor registers
 * 16 read tools and marks each request it sends; the leader refuses a marked
 * request for any other tool. Runs real server processes and a simulated
 * plugin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { AUDITOR_TOOLS } from "../src/role.js";
import { chunker, STYLES, SYNTHETIC_TREE, VARIABLE_DEFS } from "./helpers/dump-tree.js";
import { Harness } from "./helpers/harness.js";
import { pngScreenshot, type PluginHandler, type SimulatedPlugin } from "./helpers/plugin.js";
import { rawRpc } from "./helpers/rpc.js";
import { SERVER_ENTRY, serverEnv, type ServerProcess } from "./helpers/server-process.js";

const FILE_KEY = "role-file";
const NODE_ID = "1:1";
const TIMEOUT_MS = 60_000;
const MARK = { "X-Figma-Bridge-Role": "auditor" };

/** The 16 names of BR-3 and BR-8, written out here so a change to the list needs a change to its test. */
const EXPECTED_AUDITOR_TOOLS = [
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
  "dump_journal",
];

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

const AUDITOR_ENV = { FIGMA_BRIDGE_ROLE: "auditor" };

/** The handlers of a simulated plugin for the read tools and the writes of these tests. */
function handlers(): Record<string, PluginHandler> {
  return {
    get_node: () => ({ id: NODE_ID, name: "synthetic-root", type: "FRAME" }),
    set_node_properties: () => ({ ok: true }),
    delete_nodes: () => ({ deleted: 1 }),
    dump_nodes_chunk: chunker(SYNTHETIC_TREE),
    get_variable_defs: () => VARIABLE_DEFS,
    get_styles: () => STYLES,
    get_screenshot: pngScreenshot,
  };
}

/** Starts a process with its own output root and working folder. */
async function start(port: number, env: Record<string, string | undefined> = {}) {
  const root = await h.tempDir("root");
  const cwd = await h.tempDir("cwd");
  const server = await h.server({
    port,
    cwd,
    env: { FIGMA_BRIDGE_OUTPUT_ROOT: root, ...env },
  });
  return { server, root };
}

async function connectPlugin(port: number): Promise<SimulatedPlugin> {
  return h.plugin({ port, fileKey: FILE_KEY, handlers: handlers() });
}

function requestTypes(plugin: SimulatedPlugin): string[] {
  return plugin.requests.map((request) => request.type);
}

/** Runs the server with a closed standard input, for a start that fails. */
function runWithRole(
  tokenFile: string,
  journalFile: string,
  logFile: string,
  port: number,
  role: string
) {
  return spawnSync("node", [SERVER_ENTRY], {
    env: serverEnv({
      port,
      env: {
        FIGMA_BRIDGE_TOKEN_FILE: tokenFile,
        FIGMA_BRIDGE_JOURNAL_FILE: journalFile,
        FIGMA_BRIDGE_LOG_FILE: logFile,
        FIGMA_BRIDGE_ROLE: role,
      },
    }),
    input: "",
    encoding: "utf8",
    timeout: 15_000,
  });
}

async function outcomeOk(server: ServerProcess, name: string, args: Record<string, unknown>) {
  const outcome = await server.callTool(name, args);
  if (!outcome.ok) throw new Error(`${name} failed: ${outcome.error}`);
  return outcome.data;
}

describe("the tool list", () => {
  test(
    "an auditor process lists exactly the 16 tools",
    async () => {
      const { server } = await start(await h.freePort(), AUDITOR_ENV);
      const names = await server.listTools();
      expect(names).toHaveLength(16);
      expect(new Set(names)).toEqual(new Set(EXPECTED_AUDITOR_TOOLS));
      expect(names).not.toContain("get_screenshot");
      expect(names).not.toContain("delete_nodes");
      expect(server.stderr.some((line) => line.includes("tools: auditor"))).toBe(true);
    },
    TIMEOUT_MS
  );

  test("the list in the source is the list of BR-3", () => {
    expect([...AUDITOR_TOOLS]).toEqual(EXPECTED_AUDITOR_TOOLS);
  });

  test(
    "a process without the role lists the full set",
    async () => {
      const { server } = await start(await h.freePort());
      const names = await server.listTools();
      expect(names.length).toBeGreaterThan(16);
      for (const tool of EXPECTED_AUDITOR_TOOLS) expect(names).toContain(tool);
      expect(names).toContain("delete_nodes");
      expect(names).toContain("get_screenshot");
      expect(server.stderr.some((line) => line.includes("tools: full"))).toBe(true);
    },
    TIMEOUT_MS
  );

  test(
    "an empty FIGMA_BRIDGE_ROLE gives the full set",
    async () => {
      const { server } = await start(await h.freePort(), { FIGMA_BRIDGE_ROLE: "" });
      expect(await server.listTools()).toContain("delete_nodes");
    },
    TIMEOUT_MS
  );
});

describe("the start check", () => {
  for (const role of ["Auditor", "x", "auditor ", "executor"]) {
    test(
      `FIGMA_BRIDGE_ROLE=${JSON.stringify(role)} stops the process at start`,
      async () => {
        const tokenFile = await h.tokenFile();
        const result = runWithRole(
          tokenFile,
          await h.journalFile(),
          await h.logFile(),
          await h.freePort(),
          role
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("FIGMA_BRIDGE_ROLE");
        expect(result.stderr).toContain("auditor");
      },
      TIMEOUT_MS
    );
  }
});

describe("the auditor process in the bridge", () => {
  test(
    "as the leader, it relays the write of another process",
    async () => {
      const port = await h.freePort();
      const { server: auditor } = await start(port, AUDITOR_ENV);
      expect(auditor.role).toBe("LEADER");
      const plugin = await connectPlugin(port);
      const { server: executor } = await start(port);
      expect(executor.role).toBe("FOLLOWER");

      await outcomeOk(executor, "set_node_properties", {
        nodeId: NODE_ID,
        x: 5,
        fileKey: FILE_KEY,
      });
      expect(requestTypes(plugin)).toContain("set_node_properties");

      await outcomeOk(executor, "delete_nodes", {
        nodeIds: [NODE_ID],
        confirm: true,
        fileKey: FILE_KEY,
      });
      expect(requestTypes(plugin)).toContain("delete_nodes");
    },
    TIMEOUT_MS
  );

  test(
    "as a follower, it reads through the leader",
    async () => {
      const port = await h.freePort();
      const { server: leader } = await start(port);
      expect(leader.role).toBe("LEADER");
      const plugin = await connectPlugin(port);
      const { server: auditor } = await start(port, AUDITOR_ENV);
      expect(auditor.role).toBe("FOLLOWER");

      const data = (await outcomeOk(auditor, "get_node", {
        nodeId: NODE_ID,
        fileKey: FILE_KEY,
      })) as { id: string };
      expect(data.id).toBe(NODE_ID);
      expect(requestTypes(plugin)).toContain("get_node");
    },
    TIMEOUT_MS
  );

  test(
    "as a follower, it runs dump_nodes and save_screenshots under its own root",
    async () => {
      const port = await h.freePort();
      const { server: leader, root: leaderRoot } = await start(port);
      expect(leader.role).toBe("LEADER");
      const plugin = await connectPlugin(port);
      const { server: auditor, root } = await start(port, AUDITOR_ENV);
      expect(auditor.role).toBe("FOLLOWER");

      await outcomeOk(auditor, "dump_nodes", {
        nodeIds: [NODE_ID],
        outputPath: "dumps/run-1",
        fileKey: FILE_KEY,
      });
      expect(existsSync(join(root, "dumps", "run-1", "manifest.json"))).toBe(true);
      expect(existsSync(join(root, "dumps", "run-1", "1_1.json"))).toBe(true);

      await outcomeOk(auditor, "save_screenshots", {
        items: [{ nodeId: NODE_ID, outputPath: "shots/one.png" }],
        fileKey: FILE_KEY,
      });
      expect(existsSync(join(root, "shots", "one.png"))).toBe(true);

      // The commands behind both calls went through the leader.
      expect(requestTypes(plugin)).toContain("dump_nodes_chunk");
      expect(requestTypes(plugin)).toContain("get_screenshot");
      expect(await readdir(leaderRoot)).toEqual([]);
    },
    TIMEOUT_MS
  );
});

describe("the leader and a marked /rpc request", () => {
  /** A leader and a plugin; returns the token and the plugin. */
  async function leaderWithPlugin() {
    const port = await h.freePort();
    const { server } = await start(port);
    expect(server.role).toBe("LEADER");
    const plugin = await connectPlugin(port);
    const token = await h.token();
    const headers = (extra: Record<string, string> = {}) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...extra,
    });
    return { port, plugin, headers };
  }

  test(
    "refuses delete_nodes with 403 and sends nothing to the plugin",
    async () => {
      const { port, plugin, headers } = await leaderWithPlugin();
      const answer = await rawRpc(port, {
        headers: headers(MARK),
        body: JSON.stringify({
          tool: "delete_nodes",
          nodeIds: [NODE_ID],
          params: { confirm: true },
          fileKey: FILE_KEY,
        }),
      });
      expect(answer.status).toBe(403);
      expect(answer.body.error).toContain("delete_nodes");
      expect(answer.body.error).toContain("auditor");
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "refuses a tool that exists only in the full set, get_selection, with 403",
    async () => {
      const { port, plugin, headers } = await leaderWithPlugin();
      const answer = await rawRpc(port, {
        headers: headers(MARK),
        body: JSON.stringify({ tool: "get_selection", fileKey: FILE_KEY }),
      });
      expect(answer.status).toBe(403);
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "allows dump_nodes_chunk and get_screenshot",
    async () => {
      const { port, plugin, headers } = await leaderWithPlugin();
      const chunk = await rawRpc(port, {
        headers: headers(MARK),
        body: JSON.stringify({
          tool: "dump_nodes_chunk",
          params: { rootId: NODE_ID, cursor: null, maxNodes: 5, includeHidden: true },
          fileKey: FILE_KEY,
        }),
      });
      expect(chunk.status).toBe(200);
      expect(chunk.body.error).toBeUndefined();

      const shot = await rawRpc(port, {
        headers: headers(MARK),
        body: JSON.stringify({ tool: "get_screenshot", nodeIds: [NODE_ID], fileKey: FILE_KEY }),
      });
      expect(shot.status).toBe(200);
      expect(shot.body.error).toBeUndefined();
      expect(requestTypes(plugin)).toEqual(["dump_nodes_chunk", "get_screenshot"]);
    },
    TIMEOUT_MS
  );

  test(
    "allows a read tool of the list",
    async () => {
      const { port, headers } = await leaderWithPlugin();
      const answer = await rawRpc(port, {
        headers: headers(MARK),
        body: JSON.stringify({ tool: "get_node", nodeIds: [NODE_ID], fileKey: FILE_KEY }),
      });
      expect(answer.status).toBe(200);
      expect((answer.body.data as { id: string }).id).toBe(NODE_ID);
    },
    TIMEOUT_MS
  );

  test(
    "answers 400 to another role value",
    async () => {
      const { port, plugin, headers } = await leaderWithPlugin();
      for (const value of ["executor", "Auditor", ""]) {
        const answer = await rawRpc(port, {
          headers: headers({ "X-Figma-Bridge-Role": value }),
          body: JSON.stringify({ tool: "get_node", nodeIds: [NODE_ID], fileKey: FILE_KEY }),
        });
        expect(answer.status).toBe(400);
        expect(answer.body.error).toContain("X-Figma-Bridge-Role");
      }
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "relays a write that has no mark",
    async () => {
      const { port, plugin, headers } = await leaderWithPlugin();
      const answer = await rawRpc(port, {
        headers: headers(),
        body: JSON.stringify({
          tool: "set_node_properties",
          nodeIds: [NODE_ID],
          params: { x: 5 },
          fileKey: FILE_KEY,
        }),
      });
      expect(answer.status).toBe(200);
      expect(requestTypes(plugin)).toEqual(["set_node_properties"]);
    },
    TIMEOUT_MS
  );
});
