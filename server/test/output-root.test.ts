/**
 * BR-1: each evidence file goes under the output root of the process that
 * serves the call. Runs real server processes and a simulated plugin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Harness } from "./helpers/harness.js";
import { PNG_1X1_BASE64, pngScreenshot, type SimulatedPlugin } from "./helpers/plugin.js";
import type { ServerProcess } from "./helpers/server-process.js";
import { postRpc } from "./helpers/rpc.js";

const FILE_KEY = "harness-file";
const NODE_ID = "1:2";
const PNG = Buffer.from(PNG_1X1_BASE64, "base64");
const TIMEOUT_MS = 60_000;

interface SaveResult {
  total: number;
  succeeded: number;
  failed: number;
  hasErrors: boolean;
  manifestPath: string | null;
  files: Array<{
    index: number;
    ok: boolean;
    path?: string;
    bytes?: number;
    error?: string;
  }>;
}

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** Starts a leader with the given output root, and connects the plugin. */
async function leaderWithPlugin(root: string | undefined, cwd: string) {
  const port = await h.freePort();
  const leader = await h.server({ port, cwd, env: { FIGMA_BRIDGE_OUTPUT_ROOT: root } });
  expect(leader.role).toBe("LEADER");
  const plugin = await h.plugin({
    port,
    fileKey: FILE_KEY,
    handlers: { get_screenshot: pngScreenshot },
  });
  return { port, leader, plugin };
}

async function saveOne(server: ServerProcess, outputPath: string) {
  return server.callTool("save_screenshots", {
    items: [{ nodeId: NODE_ID, outputPath }],
    fileKey: FILE_KEY,
  });
}

function onlyResult(outcome: Awaited<ReturnType<typeof saveOne>>) {
  if (!outcome.ok) throw new Error(`save_screenshots failed: ${outcome.error}`);
  const data = outcome.data as SaveResult;
  expect(data.total).toBe(1);
  return data.files[0];
}

function screenshotRequests(plugin: SimulatedPlugin) {
  return plugin.requests.filter((request) => request.type === "get_screenshot");
}

async function entries(dir: string): Promise<string[]> {
  return existsSync(dir) ? (await readdir(dir)).sort() : [];
}

describe("save_screenshots and the output root", () => {
  test(
    "a set root receives the file",
    async () => {
      const root = await h.tempDir("root");
      const cwd = await h.tempDir("cwd");
      const { leader } = await leaderWithPlugin(root, cwd);

      expect(leader.stderr.join("\n")).toContain(`Output root: ${root} (FIGMA_BRIDGE_OUTPUT_ROOT)`);

      const result = onlyResult(await saveOne(leader, "shots/frame.png"));
      expect(result.ok).toBe(true);
      expect(result.path).toBe("shots/frame.png");
      expect(result.bytes).toBe(PNG.byteLength);
      expect(await readFile(join(root, "shots", "frame.png"))).toEqual(PNG);
      expect(await entries(cwd)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "an unset root is the working directory",
    async () => {
      const cwd = await h.tempDir("cwd");
      const { leader } = await leaderWithPlugin(undefined, cwd);

      expect(leader.stderr.join("\n")).toContain("(working directory)");

      const result = onlyResult(await saveOne(leader, "frame.png"));
      expect(result.ok).toBe(true);
      expect(await readFile(join(cwd, "frame.png"))).toEqual(PNG);
    },
    TIMEOUT_MS
  );

  test(
    "a path out of the root is refused, and nothing is written outside",
    async () => {
      const base = await h.tempDir("base");
      const root = join(base, "root");
      const elsewhere = join(base, "elsewhere");
      await mkdir(root);
      await mkdir(elsewhere);
      const outside = await h.tempDir("outside");
      await h.folderLink(outside, join(root, "link"));
      const cwd = await h.tempDir("cwd");
      const { leader, plugin } = await leaderWithPlugin(root, cwd);

      const cases: Array<[string, RegExp]> = [
        ["../outside.png", /a "\.\." segment leads out of the root/],
        [join(elsewhere, "abs.png"), /the absolute path .* is outside the root/],
        ["link/through.png", /is a link that resolves to/],
        ["link/deeper/through.png", /is a link that resolves to/],
        [".", /names the output root itself/],
      ];
      for (const [outputPath, cause] of cases) {
        const outcome = await saveOne(leader, outputPath);
        const result = onlyResult(outcome);
        // With no item written there is no capture to put a manifest beside.
        expect((outcome as { data: SaveResult }).data.manifestPath).toBeNull();
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(cause);
        expect(result.error).toContain(`outputPath "${outputPath}" is refused`);
        expect(result.error).toContain("The real output root is");
      }

      // A refused path is refused before the capture.
      expect(screenshotRequests(plugin)).toHaveLength(0);
      expect(await entries(base)).toEqual(["elsewhere", "root"]);
      expect(await entries(elsewhere)).toEqual([]);
      expect(await entries(outside)).toEqual([]);
      expect(await entries(root)).toEqual(["link"]);
      expect(await entries(cwd)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test.if(process.platform === "win32")(
    "on Windows a path in another letter case is inside the root",
    async () => {
      const root = await h.tempDir("root");
      const cwd = await h.tempDir("cwd");
      const { leader } = await leaderWithPlugin(root.toUpperCase() + "\\", cwd);

      const result = onlyResult(await saveOne(leader, join(root.toLowerCase(), "case.png")));
      expect(result.ok).toBe(true);
      expect(await readFile(join(root, "case.png"))).toEqual(PNG);
    },
    TIMEOUT_MS
  );

  test(
    "a set root that is missing fails the call, and nothing lands in the working directory",
    async () => {
      const base = await h.tempDir("base");
      const missing = join(base, "missing");
      const cwd = await h.tempDir("cwd");
      const { leader, plugin } = await leaderWithPlugin(missing, cwd);

      expect(leader.stderr.join("\n")).toContain("the folder does not exist");

      const outcome = await saveOne(leader, "frame.png");
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain(`FIGMA_BRIDGE_OUTPUT_ROOT names ${missing}`);
      expect(outcome.error).toContain("does not exist");
      expect(outcome.error).toContain("Make that folder");

      expect(screenshotRequests(plugin)).toHaveLength(0);
      expect(existsSync(missing)).toBe(false);
      expect(await entries(cwd)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a follower writes under its own root, and the leader writes nothing",
    async () => {
      const leaderRoot = await h.tempDir("leader-root");
      const leaderCwd = await h.tempDir("leader-cwd");
      const followerRoot = await h.tempDir("follower-root");
      const followerCwd = await h.tempDir("follower-cwd");
      const { port, plugin } = await leaderWithPlugin(leaderRoot, leaderCwd);
      const follower = await h.server({
        port,
        cwd: followerCwd,
        env: { FIGMA_BRIDGE_OUTPUT_ROOT: followerRoot },
      });
      expect(follower.role).toBe("FOLLOWER");

      const result = onlyResult(await saveOne(follower, "shots/frame.png"));
      expect(result.ok).toBe(true);
      expect(result.path).toBe("shots/frame.png");
      expect(await readFile(join(followerRoot, "shots", "frame.png"))).toEqual(PNG);

      // The plugin talks only to the leader, so the capture travelled over /rpc.
      const captures = screenshotRequests(plugin);
      expect(captures).toHaveLength(1);
      expect(captures[0].nodeIds).toEqual([NODE_ID]);

      expect(await entries(leaderRoot)).toEqual([]);
      expect(await entries(leaderCwd)).toEqual([]);
      expect(await entries(followerCwd)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a raw /rpc request for save_screenshots gets HTTP 400 and writes nothing",
    async () => {
      const root = await h.tempDir("root");
      const cwd = await h.tempDir("cwd");
      const { port, plugin } = await leaderWithPlugin(root, cwd);

      const answer = await postRpc(port, await h.token(), {
        tool: "save_screenshots",
        params: { items: [{ nodeId: NODE_ID, outputPath: "frame.png" }] },
        fileKey: FILE_KEY,
      });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toContain("each process serves save_screenshots itself");
      expect(answer.body.error).toContain("its own output root");

      expect(screenshotRequests(plugin)).toHaveLength(0);
      expect(await entries(root)).toEqual([]);
      expect(await entries(cwd)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a file that exists is not overwritten, and the call fails before the capture",
    async () => {
      const root = await h.tempDir("root");
      const cwd = await h.tempDir("cwd");
      const existing = join(root, "frame.png");
      await writeFile(existing, "old");
      const { leader, plugin } = await leaderWithPlugin(root, cwd);

      const outcome = await saveOne(leader, "frame.png");
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain("save_screenshots failed before the first capture");
      expect(outcome.error).toContain(existing);
      expect(outcome.error).toContain("Evidence is never overwritten");
      expect(await readFile(existing, "utf8")).toBe("old");
      expect(screenshotRequests(plugin)).toHaveLength(0);
      expect(await entries(root)).toEqual(["frame.png"]);
    },
    TIMEOUT_MS
  );
});
