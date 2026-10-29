/**
 * BR-6: save_screenshots returns a manifest with the SHA-256 and the pixel
 * size of each capture and no image data, and get_screenshot returns a small
 * raster capture as an image block. Runs real server processes and a
 * simulated plugin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, folderTimestamp } from "../src/evidence.js";
import { Harness } from "./helpers/harness.js";
import {
  jpgWithSize,
  PNG_1X1_BASE64,
  pngWithSize,
  screenshotHandler,
  type PluginHandler,
  type SimulatedCapture,
  type SimulatedPlugin,
} from "./helpers/plugin.js";
import type { RawToolResult, ServerProcess, ToolOutcome } from "./helpers/server-process.js";

const FILE_KEY = "capture-file";
const PLUGIN_BUILD = "capture-build-1";
const TIMEOUT_MS = 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MANIFEST_NAME = /^save_screenshots-\d{8}T\d{6}Z\.manifest\.json$/;
const AUDITOR_ENV = { FIGMA_BRIDGE_ROLE: "auditor" };

/** The PNG that the simulated plugin returns: 7 x 5 pixels. */
const PNG_7X5 = pngWithSize(7, 5, 40);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>');

interface CaptureEntry {
  kind: string;
  index: number;
  nodeId: string;
  nodeName: string;
  path: string;
  format: string;
  scale: number | null;
  pixelWidth: number | null;
  pixelHeight: number | null;
  bytes: number;
  sha256: string;
  ok: true;
}

interface FailedEntry {
  index: number;
  nodeId: string;
  ok: false;
  error: string;
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
  startedAt: string;
  finishedAt: string;
  files: Array<CaptureEntry | FailedEntry>;
  manifestPath: string | null;
  total: number;
  succeeded: number;
  failed: number;
  hasErrors: boolean;
}

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A capture builder: a PNG for every node except `9:9`, which Figma does not find. */
const defaultCapture = (nodeId: string): SimulatedCapture => {
  if (nodeId === "9:9") throw new Error("Node not found: 9:9");
  return { format: "PNG", bytes: PNG_7X5 };
};

function pluginHandlers(handler: PluginHandler = screenshotHandler(defaultCapture)) {
  return { get_screenshot: handler };
}

/** Starts a leader with its own root, and connects the plugin. */
async function leaderWithPlugin(handler?: PluginHandler) {
  const port = await h.freePort();
  const root = await h.tempDir("root");
  const leader = await h.server({
    port,
    cwd: await h.tempDir("cwd"),
    env: { FIGMA_BRIDGE_OUTPUT_ROOT: root },
  });
  expect(leader.role).toBe("LEADER");
  const plugin = await h.plugin({
    port,
    fileKey: FILE_KEY,
    pluginBuild: PLUGIN_BUILD,
    handlers: pluginHandlers(handler),
  });
  return { port, root, leader, plugin };
}

/** Starts a follower with its own root, and, when asked, the auditor role. */
async function follower(port: number, env: Record<string, string> = {}) {
  const root = await h.tempDir("follower-root");
  const server = await h.server({
    port,
    cwd: await h.tempDir("follower-cwd"),
    env: { FIGMA_BRIDGE_OUTPUT_ROOT: root, ...env },
  });
  expect(server.role).toBe("FOLLOWER");
  return { root, server };
}

async function save(server: ServerProcess, args: Record<string, unknown>): Promise<ToolOutcome> {
  return server.callTool("save_screenshots", { fileKey: FILE_KEY, ...args });
}

async function saveOk(server: ServerProcess, args: Record<string, unknown>): Promise<Manifest> {
  const outcome = await save(server, args);
  if (!outcome.ok) throw new Error(`save_screenshots failed: ${outcome.error}`);
  return outcome.data as Manifest;
}

function saveError(outcome: ToolOutcome): string {
  if (outcome.ok) {
    throw new Error(
      `save_screenshots was expected to fail, but returned ${JSON.stringify(outcome.data)}`
    );
  }
  return outcome.error;
}

function captureOf(manifest: Manifest, index: number): CaptureEntry {
  const entry = manifest.files.find((file) => file.index === index);
  if (!entry || !entry.ok) {
    throw new Error(`item ${index} was not written: ${JSON.stringify(manifest.files)}`);
  }
  return entry;
}

function screenshotRequests(plugin: SimulatedPlugin) {
  return plugin.requests.filter((request) => request.type === "get_screenshot");
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

describe("the capture manifest", () => {
  test(
    "an auditor follower writes under its own root; the sha256 and the pixel size match the files",
    async () => {
      const { port, root: leaderRoot, plugin } = await leaderWithPlugin();
      const { root, server } = await follower(port, AUDITOR_ENV);
      // The auditor role has no get_screenshot, so it captures with save_screenshots.
      expect(await server.listTools()).not.toContain("get_screenshot");

      const raw = await server.callToolRaw("save_screenshots", {
        items: [
          { nodeId: "1:1", outputPath: "shots/a.png" },
          { nodeId: "1:2", outputPath: "shots/b.png" },
        ],
        scale: 1,
        fileKey: FILE_KEY,
      });
      expect(raw.isError).toBe(false);
      // One text block: the manifest. No image block, and no base64 of a capture.
      expect(raw.content.map((block) => block.type)).toEqual(["text"]);
      const text = raw.content[0].text ?? "";
      expect(text).not.toContain(PNG_7X5.toString("base64").slice(0, 40));
      const manifest = JSON.parse(text) as Manifest;

      expect(manifest.tool).toBe("save_screenshots");
      expect(manifest.fileKey).toBe(FILE_KEY);
      expect(manifest.pluginBuild).toBe(PLUGIN_BUILD);
      expect(manifest.epoch).toBe(1);
      expect(manifest.bridgeCommit).toMatch(/\S/);
      expect(manifest.leaderCommit).toMatch(/\S/);
      expect(manifest.leaderStartedAt).toMatch(ISO_UTC);
      expect(manifest.startedAt).toMatch(ISO_UTC);
      expect(manifest.finishedAt).toMatch(ISO_UTC);
      expect(manifest.outputRoot).toBe(await realpath(root));
      expect([manifest.total, manifest.succeeded, manifest.failed, manifest.hasErrors]).toEqual([
        2,
        2,
        0,
        false,
      ]);

      for (const [index, name] of ["a", "b"].entries()) {
        const entry = captureOf(manifest, index);
        expect(entry.kind).toBe("capture");
        expect(entry.path).toBe(`shots/${name}.png`);
        expect(entry.format).toBe("PNG");
        expect(entry.scale).toBe(1);
        const file = await readFile(join(root, "shots", `${name}.png`));
        expect(file).toEqual(PNG_7X5);
        expect(entry.bytes).toBe(file.byteLength);
        expect(entry.sha256).toMatch(SHA256);
        expect(entry.sha256).toBe(sha256(file));
        // The pixel size is the one in the PNG header.
        expect([entry.pixelWidth, entry.pixelHeight]).toEqual([
          file.readUInt32BE(16),
          file.readUInt32BE(20),
        ]);
        expect([entry.pixelWidth, entry.pixelHeight]).toEqual([7, 5]);
      }

      // The commands went through the leader, which wrote nothing.
      const captures = screenshotRequests(plugin);
      expect(captures.map((request) => request.nodeIds)).toEqual([["1:1"], ["1:2"]]);
      expect(captures[0].params).toMatchObject({ format: "PNG", scale: 1 });
      expect(await readdir(leaderRoot)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a capture without a scale records the default scale of 2, and the plugin gets none",
    async () => {
      const { root, leader, plugin } = await leaderWithPlugin();
      const manifest = await saveOk(leader, { items: [{ nodeId: "1:1", outputPath: "a.png" }] });
      expect(captureOf(manifest, 0).scale).toBe(2);
      const params = screenshotRequests(plugin)[0].params ?? {};
      expect(params.format).toBe("PNG");
      expect("scale" in params).toBe(false);
      // save_screenshots keeps the full-scale export: it never fits to an edge.
      expect("maxEdge" in params).toBe(false);
      expect(existsSync(join(root, "a.png"))).toBe(true);
    },
    TIMEOUT_MS
  );

  test(
    "an SVG has no scale and no pixel size; a JPG gets its size from the SOF segment",
    async () => {
      const { root, leader } = await leaderWithPlugin(
        screenshotHandler((_nodeId, request) =>
          request.params?.format === "SVG"
            ? { format: "SVG", bytes: SVG }
            : { format: "JPG", bytes: jpgWithSize(640, 480) }
        )
      );
      const manifest = await saveOk(leader, {
        items: [
          { nodeId: "1:1", outputPath: "vector.svg" },
          { nodeId: "1:2", outputPath: "photo.jpg", scale: 3 },
        ],
      });

      const svg = captureOf(manifest, 0);
      expect(svg.format).toBe("SVG");
      expect([svg.scale, svg.pixelWidth, svg.pixelHeight]).toEqual([null, null, null]);
      expect(svg.sha256).toBe(sha256(SVG));
      expect(svg.bytes).toBe(SVG.byteLength);

      const jpg = captureOf(manifest, 1);
      expect(jpg.format).toBe("JPG");
      expect([jpg.scale, jpg.pixelWidth, jpg.pixelHeight]).toEqual([3, 640, 480]);
      expect(jpg.sha256).toBe(sha256(await readFile(join(root, "photo.jpg"))));
    },
    TIMEOUT_MS
  );

  test(
    "an item for a node that does not exist fails alone; the other items are written",
    async () => {
      const { root, leader, plugin } = await leaderWithPlugin();
      const manifest = await saveOk(leader, {
        items: [
          { nodeId: "1:1", outputPath: "shots/a.png" },
          { nodeId: "9:9", outputPath: "shots/missing.png" },
          { nodeId: "1:3", outputPath: "shots/c.png" },
        ],
      });

      expect([manifest.total, manifest.succeeded, manifest.failed, manifest.hasErrors]).toEqual([
        3,
        2,
        1,
        true,
      ]);
      const failed = manifest.files[1];
      expect(failed.ok).toBe(false);
      expect(failed).toEqual({
        index: 1,
        nodeId: "9:9",
        ok: false,
        error: expect.stringContaining("Node not found: 9:9"),
      });
      expect(captureOf(manifest, 0).path).toBe("shots/a.png");
      expect(captureOf(manifest, 2).path).toBe("shots/c.png");

      expect(screenshotRequests(plugin)).toHaveLength(3);
      const files = await filesUnder(root);
      expect(files).toHaveLength(3);
      expect(files).toContain("shots/a.png");
      expect(files).toContain("shots/c.png");
      expect(files).not.toContain("shots/missing.png");
      expect(files.some((file) => file.endsWith(".partial"))).toBe(false);
    },
    TIMEOUT_MS
  );

  test(
    "an item that repeats the path of an earlier item fails alone",
    async () => {
      const { root, leader, plugin } = await leaderWithPlugin();
      const manifest = await saveOk(leader, {
        items: [
          { nodeId: "1:1", outputPath: "same.png" },
          { nodeId: "1:2", outputPath: "same.png" },
        ],
      });
      expect([manifest.succeeded, manifest.failed]).toEqual([1, 1]);
      const repeat = manifest.files[1];
      expect(repeat.ok).toBe(false);
      expect(repeat.ok === false && repeat.error).toContain("items[1]");
      expect(repeat.ok === false && repeat.error).toContain("repeats items[0]");
      expect(screenshotRequests(plugin)).toHaveLength(1);
      expect(await readFile(join(root, "same.png"))).toEqual(PNG_7X5);
    },
    TIMEOUT_MS
  );

  test(
    "a new plugin connection during the call fails it, and no file of the call remains",
    async () => {
      let captures = 0;
      let replacement: Promise<SimulatedPlugin> | undefined;
      const inner = screenshotHandler(defaultCapture);
      const port = await h.freePort();
      const root = await h.tempDir("root");
      const leader = await h.server({
        port,
        cwd: await h.tempDir("cwd"),
        env: { FIGMA_BRIDGE_OUTPUT_ROOT: root },
      });
      const first: SimulatedPlugin = await h.plugin({
        port,
        fileKey: FILE_KEY,
        pluginBuild: PLUGIN_BUILD,
        handlers: pluginHandlers(async (request) => {
          captures += 1;
          if (captures === 2) {
            // The leader replaces this connection and closes it. Its close
            // frame waits unread, so the answer below still arrives: epoch 2.
            first.pause();
            replacement = h.plugin({
              port,
              fileKey: FILE_KEY,
              pluginBuild: PLUGIN_BUILD,
              handlers: pluginHandlers(),
            });
            await replacement;
          }
          return inner(request);
        }),
      });

      const error = saveError(
        await save(leader, {
          items: [
            { nodeId: "1:1", outputPath: "shots/a.png" },
            { nodeId: "1:2", outputPath: "shots/b.png" },
            { nodeId: "1:3", outputPath: "other/c.png" },
          ],
        })
      );
      expect(error).toContain(
        "save_screenshots failed for the file capture-file: the plugin session changed during the capture (epoch 1 -> 2)"
      );
      expect(error).toContain("No file of this call remains.");
      // The third capture went to the new connection; only the identity check failed the call.
      expect(screenshotRequests(await replacement!)).toHaveLength(1);
      expect(await filesUnder(root)).toEqual([]);
    },
    TIMEOUT_MS
  );
});

describe("the manifest file", () => {
  test(
    "lands beside the first capture, and holds the manifest the call returned",
    async () => {
      const { root, leader } = await leaderWithPlugin();
      const raw = await leader.callToolRaw("save_screenshots", {
        items: [
          { nodeId: "1:1", outputPath: "first/a.png" },
          { nodeId: "1:2", outputPath: "second/b.png" },
        ],
        fileKey: FILE_KEY,
      });
      const manifest = JSON.parse(raw.content[0].text ?? "") as Manifest;

      expect(manifest.manifestPath).toMatch(
        /^first\/save_screenshots-\d{8}T\d{6}Z\.manifest\.json$/
      );
      const name = (manifest.manifestPath ?? "").split("/")[1];
      expect(name).toMatch(MANIFEST_NAME);
      expect(await filesUnder(root)).toEqual(
        ["first/a.png", `first/${name}`, "second/b.png"].sort()
      );

      // The file is the canonical JSON of the result, manifestPath included.
      const onDisk = await readFile(join(root, "first", name), "utf8");
      expect(onDisk).toBe(raw.content[0].text ?? "");
      expect(onDisk).toBe(canonicalJson(JSON.parse(onDisk)));
      expect((JSON.parse(onDisk) as Manifest).manifestPath).toBe(manifest.manifestPath);
    },
    TIMEOUT_MS
  );

  test(
    "is never overwritten: a name that exists refuses the call before the first capture",
    async () => {
      const { root, leader, plugin } = await leaderWithPlugin();
      const folder = join(root, "shots");
      await mkdir(folder);
      // The name holds the start time to the second. Take the next few seconds.
      const taken: string[] = [];
      for (let ahead = 0; ahead < 4; ahead += 1) {
        const stamp = folderTimestamp(new Date(Date.now() + ahead * 1_000));
        const name = `save_screenshots-${stamp}.manifest.json`;
        await writeFile(join(folder, name), "old");
        taken.push(name);
      }

      const error = saveError(
        await save(leader, { items: [{ nodeId: "1:1", outputPath: "shots/a.png" }] })
      );
      expect(error).toContain("save_screenshots failed before the first capture");
      expect(error).toContain(".manifest.json");
      expect(error).toContain("Evidence is never overwritten");
      expect(screenshotRequests(plugin)).toHaveLength(0);
      expect(await filesUnder(root)).toEqual(taken.map((name) => `shots/${name}`).sort());
      for (const name of taken) expect(await readFile(join(folder, name), "utf8")).toBe("old");
    },
    TIMEOUT_MS
  );
});

describe("get_screenshot without the auditor role", () => {
  const LONG_EDGE = 1_568;
  const BYTE_LIMIT = 3_750_000;

  /** Calls get_screenshot on the leader, with a plugin that answers with the capture. */
  async function shoot(capture: SimulatedCapture): Promise<RawToolResult> {
    const { leader } = await leaderWithPlugin(screenshotHandler(() => capture));
    return leader.callToolRaw("get_screenshot", { nodeIds: ["1:1"], fileKey: FILE_KEY });
  }

  /** The text of an answer that is a tool error: one text block, no base64. */
  function errorText(result: RawToolResult): string {
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.type)).toEqual(["text"]);
    return result.content[0].text ?? "";
  }

  test(
    "an SVG is its markup as text; a long SVG and a PDF are errors that point to save_screenshots",
    async () => {
      const svg = await shoot({ format: "SVG", bytes: SVG });
      expect(svg.isError).toBe(false);
      expect(svg.content.map((block) => block.type)).toEqual(["text", "text"]);
      expect(JSON.parse(svg.content[0].text ?? "")).toEqual({
        nodeId: "1:1",
        nodeName: "node 1:1",
        format: "SVG",
        chars: SVG.toString("utf8").length,
      });
      expect(svg.content[1].text).toBe(SVG.toString("utf8"));

      const long = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg">${"x".repeat(35_000)}</svg>`
      );
      const longError = errorText(await shoot({ format: "SVG", bytes: long }));
      expect(longError).toContain("get_screenshot: the SVG of 1:1 is");
      expect(longError).toContain("save_screenshots");
      expect(longError).not.toContain(long.toString("base64").slice(0, 40));

      const pdf = Buffer.from("%PDF-1.4 synthetic");
      const pdfError = errorText(await shoot({ format: "PDF", bytes: pdf }));
      expect(pdfError).toContain("is a PDF");
      expect(pdfError).toContain("save_screenshots");
      expect(pdfError).not.toContain(pdf.toString("base64"));
    },
    TIMEOUT_MS
  );

  test(
    "a raster export with a long edge above 1568 pixels is an error with guidance; one at 1568 is an image block",
    async () => {
      const wide = errorText(await shoot({ format: "PNG", bytes: pngWithSize(LONG_EDGE + 1, 10) }));
      expect(wide).toBe(
        `get_screenshot: the export of 1:1 is ${LONG_EDGE + 1}×10 px / 33 bytes, over what a tool result may carry. Pass a smaller maxEdge, fewer nodeIds, or use save_screenshots to write it to disk.`
      );

      const tall = errorText(await shoot({ format: "PNG", bytes: pngWithSize(10, LONG_EDGE + 1) }));
      expect(tall).toContain(`10×${LONG_EDGE + 1} px`);

      const edge = await shoot({ format: "PNG", bytes: pngWithSize(LONG_EDGE, LONG_EDGE) });
      expect(edge.content.map((block) => block.type)).toEqual(["image", "text"]);
    },
    TIMEOUT_MS
  );

  test(
    "a raster export above 3750000 bytes is an error with guidance; one at 3750000 bytes is an image block",
    async () => {
      const over = errorText(
        await shoot({ format: "PNG", bytes: pngWithSize(10, 10, BYTE_LIMIT - 33 + 1) })
      );
      expect(over).toContain(`10×10 px / ${BYTE_LIMIT + 1} bytes`);
      expect(over).toContain("save_screenshots");

      const exact = await shoot({ format: "PNG", bytes: pngWithSize(10, 10, BYTE_LIMIT - 33) });
      expect(exact.content.map((block) => block.type)).toEqual(["image", "text"]);
      expect(JSON.parse(exact.content[1].text ?? "")).toMatchObject({ bytes: BYTE_LIMIT });
    },
    TIMEOUT_MS
  );

  test(
    "a raster export with no readable header is an error",
    async () => {
      const error = errorText(await shoot({ format: "PNG", bytes: Buffer.from("not a png") }));
      expect(error).toContain("has no readable header");
      expect(error).not.toContain(Buffer.from("not a png").toString("base64"));
    },
    TIMEOUT_MS
  );

  test(
    "the call sends maxEdge, 1024 by default, and the metadata carries the scale of the export",
    async () => {
      const png = Buffer.from(PNG_1X1_BASE64, "base64");
      const { leader, plugin } = await leaderWithPlugin((request) => ({
        exports: (request.nodeIds ?? []).map((nodeId) => ({
          nodeId,
          nodeName: "Frame",
          format: "PNG",
          base64: png.toString("base64"),
          width: 1,
          height: 1,
          scale: 0.5,
        })),
      }));

      const fitted = await leader.callToolRaw("get_screenshot", {
        nodeIds: ["1:1", "1:2"],
        fileKey: FILE_KEY,
      });
      expect(fitted.content.map((block) => block.type)).toEqual(["image", "text", "image", "text"]);
      expect(JSON.parse(fitted.content[1].text ?? "")).toMatchObject({ scale: 0.5 });

      await leader.callToolRaw("get_screenshot", {
        nodeIds: ["1:1"],
        maxEdge: 512,
        scale: 3,
        fileKey: FILE_KEY,
      });
      const sent = screenshotRequests(plugin).map((request) => request.params);
      expect(sent[0]).toMatchObject({ maxEdge: 1024 });
      expect(sent[1]).toMatchObject({ maxEdge: 512, scale: 3 });
    },
    TIMEOUT_MS
  );

  test(
    "more than 4 nodeIds and a maxEdge outside 64 to 1568 are refused before the plugin",
    async () => {
      const { leader, plugin } = await leaderWithPlugin();
      const many = await leader.callToolRaw("get_screenshot", {
        nodeIds: ["1:1", "1:2", "1:3", "1:4", "1:5"],
        fileKey: FILE_KEY,
      });
      expect(many.isError).toBe(true);
      const big = await leader.callToolRaw("get_screenshot", {
        nodeIds: ["1:1"],
        maxEdge: 4000,
        fileKey: FILE_KEY,
      });
      expect(big.isError).toBe(true);
      expect(screenshotRequests(plugin)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a plugin error is a tool error",
    async () => {
      const { leader } = await leaderWithPlugin(
        screenshotHandler(() => {
          throw new Error("No nodes to export");
        })
      );
      const result = await leader.callToolRaw("get_screenshot", {
        nodeIds: ["1:1"],
        fileKey: FILE_KEY,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No nodes to export");
    },
    TIMEOUT_MS
  );
});
