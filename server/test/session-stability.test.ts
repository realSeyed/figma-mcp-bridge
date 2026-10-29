/**
 * Session stability: the request path of a long session. Runs real server
 * processes and a simulated plugin, and needs no Figma.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Harness } from "./helpers/harness.js";
import { pngScreenshot, type PluginHandler } from "./helpers/plugin.js";
import { postRpc } from "./helpers/rpc.js";

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
async function waitFor<T>(what: string, check: () => T | undefined, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out while waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
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
