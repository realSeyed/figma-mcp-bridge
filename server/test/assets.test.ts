/**
 * The asset tools and the image checks: `set_image_fill` and `create_svg`
 * through a follower, the wire shape `rpcSchemas` validates on `/rpc`, one
 * load per distinct source, the format and size refusals of `create_image`
 * and `set_image_fill`, and the local-path folders. Runs real server
 * processes and a simulated plugin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Harness } from "./helpers/harness.js";
import { PNG_1X1_BASE64, pngWithSize } from "./helpers/plugin.js";
import type { PluginHandler, SimulatedPlugin } from "./helpers/plugin.js";
import { postRpc } from "./helpers/rpc.js";
import type { ServerProcess } from "./helpers/server-process.js";

const FILE_KEY = "assets-file";
const TIMEOUT_MS = 60_000;
const PNG_URI = `data:image/png;base64,${PNG_1X1_BASE64}`;
const FORMAT_GUIDANCE = "Request a PNG or JPEG rendition (for many CDNs add fm=jpg or format=jpg)";
const SIZE_GUIDANCE = "request a smaller rendition (for many CDNs add w=2048)";

/** A WebP header as a data URI. */
const WEBP_URI = `data:image/webp;base64,${Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WEBPVP8 ", "ascii"),
  Buffer.alloc(16),
]).toString("base64")}`;

const LARGE_PNG_URI = `data:image/png;base64,${pngWithSize(5000, 10).toString("base64")}`;

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** Echoes the request back, so a test can read what the plugin got. */
const echo: PluginHandler = (request) => ({ nodeIds: request.nodeIds, params: request.params });

const fillHandler: PluginHandler = (request) => ({
  results: ((request.params?.items ?? []) as Array<{ nodeId: string }>).map((item, index) => ({
    index,
    ok: true,
    nodeId: item.nodeId,
    imageHash: `hash-${index}`,
  })),
});

async function start(port: number, env: Record<string, string | undefined> = {}) {
  const root = await h.tempDir("root");
  const cwd = await h.tempDir("cwd");
  return h.server({ port, cwd, env: { FIGMA_BRIDGE_OUTPUT_ROOT: root, ...env } });
}

/** A leader, a connected plugin, and a follower. */
async function bridge(followerEnv: Record<string, string | undefined> = {}) {
  const port = await h.freePort();
  const leader = await start(port);
  expect(leader.role).toBe("LEADER");
  const plugin: SimulatedPlugin = await h.plugin({
    port,
    fileKey: FILE_KEY,
    handlers: {
      set_image_fill: fillHandler,
      create_image: echo,
      create_svg: echo,
      create_frame: echo,
      create_text: echo,
    },
  });
  const follower = await start(port, followerEnv);
  expect(follower.role).toBe("FOLLOWER");
  return { port, leader, plugin, follower };
}

/** Calls a tool and returns the refusal text, a thrown one or an error result. */
async function refusal(server: ServerProcess, tool: string, args: Record<string, unknown>) {
  try {
    const outcome = await server.callTool(tool, { fileKey: FILE_KEY, ...args });
    if (outcome.ok) throw new Error(`${tool} accepted an input it should refuse.`);
    return outcome.error;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("set_image_fill", () => {
  test(
    "a data-URI PNG reaches the plugin through a follower, one image for two items with the same source",
    async () => {
      const { plugin, follower } = await bridge();
      const outcome = await follower.callTool("set_image_fill", {
        fileKey: FILE_KEY,
        items: [
          { nodeId: "2:1", source: PNG_URI },
          { nodeId: "I3:1;3:2", source: PNG_URI, scaleMode: "FIT" },
          { nodeId: "2:3", imageHash: "abc123" },
        ],
      });

      expect(outcome.ok).toBe(true);
      expect(plugin.requests).toHaveLength(1);
      const request = plugin.requests[0];
      expect(request.type).toBe("set_image_fill");
      expect(request.params).toEqual({
        items: [
          { nodeId: "2:1", image: 0, scaleMode: "FILL" },
          { nodeId: "I3:1;3:2", image: 0, scaleMode: "FIT" },
          { nodeId: "2:3", imageHash: "abc123", scaleMode: "FILL" },
        ],
        images: [PNG_1X1_BASE64],
      });
      const { results } = (outcome as { data: { results: Array<Record<string, unknown>> } }).data;
      expect(results.map((entry) => entry.nodeId)).toEqual(["2:1", "I3:1;3:2", "2:3"]);
    },
    TIMEOUT_MS
  );

  test(
    "refuses a WebP and a 5000-pixel PNG with the guidance, and sends nothing",
    async () => {
      const { plugin, follower } = await bridge();
      const message = await refusal(follower, "set_image_fill", {
        items: [
          { nodeId: "2:1", source: WEBP_URI },
          { nodeId: "2:2", source: PNG_URI },
          { nodeId: "2:3", source: LARGE_PNG_URI },
        ],
      });
      expect(message).toContain("set_image_fill wrote nothing");
      expect(message).toContain("items[0].source: The image is WebP.");
      expect(message).toContain(FORMAT_GUIDANCE);
      expect(message).toContain("items[2].source: The image is 5000 x 10 pixels");
      expect(message).toContain(SIZE_GUIDANCE);
      expect(message).not.toContain("items[1]");
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "refuses an item with both or neither of source and imageHash, and a repeated node",
    async () => {
      const { plugin, follower } = await bridge();
      expect(
        await refusal(follower, "set_image_fill", {
          items: [{ nodeId: "2:1", source: PNG_URI, imageHash: "abc" }],
        })
      ).toContain("exactly one of source and imageHash");
      expect(await refusal(follower, "set_image_fill", { items: [{ nodeId: "2:1" }] })).toContain(
        "exactly one of source and imageHash"
      );
      expect(
        await refusal(follower, "set_image_fill", {
          items: [
            { nodeId: "2:1", imageHash: "a" },
            { nodeId: "2:1", imageHash: "b" },
          ],
        })
      ).toContain("items[1]: 2:1 repeats items[0]");
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "the leader validates the wire shape on /rpc, not the advertised one",
    async () => {
      const { port, plugin } = await bridge();
      const token = await h.token();

      const valid = await postRpc(port, token, {
        tool: "set_image_fill",
        fileKey: FILE_KEY,
        params: {
          items: [{ nodeId: "2:1", image: 0, scaleMode: "FILL" }],
          images: [PNG_1X1_BASE64],
        },
      });
      expect(valid.status).toBe(200);
      expect(plugin.requests).toHaveLength(1);

      const pastTheEnd = await postRpc(port, token, {
        tool: "set_image_fill",
        fileKey: FILE_KEY,
        params: { items: [{ nodeId: "2:1", image: 1 }], images: [PNG_1X1_BASE64] },
      });
      expect(pastTheEnd.status).toBe(400);
      expect(pastTheEnd.body.error).toContain("past the end of images");
      expect(plugin.requests).toHaveLength(1);
    },
    TIMEOUT_MS
  );
});

describe("create_image", () => {
  test(
    "uses the same checks: WebP and a 5000-pixel PNG are refused before anything is sent",
    async () => {
      const { plugin, follower } = await bridge();
      const webp = await refusal(follower, "create_image", { source: WEBP_URI });
      expect(webp).toContain("The image is WebP.");
      expect(webp).toContain(FORMAT_GUIDANCE);
      expect(await refusal(follower, "create_image", { source: LARGE_PNG_URI })).toContain(
        SIZE_GUIDANCE
      );
      expect(plugin.requests).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a PNG reaches the plugin through a follower with its child-layout fields",
    async () => {
      const { plugin, follower } = await bridge();
      const outcome = await follower.callTool("create_image", {
        fileKey: FILE_KEY,
        source: PNG_URI,
        parentId: "2:1",
        layoutSizingHorizontal: "FILL",
        index: 0,
      });
      expect(outcome.ok).toBe(true);
      expect(plugin.requests[0].params).toEqual({
        parentId: "2:1",
        layoutSizingHorizontal: "FILL",
        index: 0,
        imageBase64: PNG_1X1_BASE64,
      });
    },
    TIMEOUT_MS
  );

  test(
    "reads a local file inside FIGMA_BRIDGE_ASSET_ROOT of the serving process, and refuses one outside",
    async () => {
      const assets = await h.tempDir("assets");
      const file = path.join(assets, "products", "photo.png");
      await mkdir(path.dirname(file));
      await writeFile(file, Buffer.from(PNG_1X1_BASE64, "base64"));

      const { plugin, follower, leader } = await bridge({ FIGMA_BRIDGE_ASSET_ROOT: assets });
      expect(await refusal(leader, "create_image", { source: file })).toContain(
        "is outside the folders the bridge reads images from"
      );
      expect(plugin.requests).toEqual([]);

      const outcome = await follower.callTool("create_image", { fileKey: FILE_KEY, source: file });
      expect(outcome.ok).toBe(true);
      expect(plugin.requests[0].params?.imageBase64).toBe(PNG_1X1_BASE64);
    },
    TIMEOUT_MS
  );
});

describe("the create tools through a follower", () => {
  test(
    "create_svg, create_frame, and create_text carry their new fields to the plugin",
    async () => {
      const { plugin, follower } = await bridge();
      const svg = '<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg"></svg>';
      expect(
        (
          await follower.callTool("create_svg", {
            fileKey: FILE_KEY,
            svg,
            name: "icon/star",
            parentId: "2:1",
            width: 48,
            index: 1,
          })
        ).ok
      ).toBe(true);
      expect(
        (
          await follower.callTool("create_frame", {
            fileKey: FILE_KEY,
            layoutMode: "VERTICAL",
            padding: 16,
            itemSpacing: 8,
            width: 320,
            layoutSizingVertical: "HUG",
            cornerRadius: 12,
            clipsContent: true,
            strokeHex: "#E0E0E0",
            strokeWeight: 1,
          })
        ).ok
      ).toBe(true);
      expect(
        (
          await follower.callTool("create_text", {
            fileKey: FILE_KEY,
            parentId: "2:1",
            characters: "Title",
            textStyleId: "S:abc,",
            textAlignVertical: "CENTER",
            layoutSizingHorizontal: "FILL",
          })
        ).ok
      ).toBe(true);

      expect(plugin.requests.map((request) => request.params)).toEqual([
        { svg, name: "icon/star", parentId: "2:1", width: 48, index: 1 },
        {
          layoutMode: "VERTICAL",
          padding: 16,
          itemSpacing: 8,
          width: 320,
          layoutSizingVertical: "HUG",
          cornerRadius: 12,
          clipsContent: true,
          strokeHex: "#E0E0E0",
          strokeWeight: 1,
        },
        {
          parentId: "2:1",
          characters: "Title",
          textStyleId: "S:abc,",
          textAlignVertical: "CENTER",
          layoutSizingHorizontal: "FILL",
        },
      ]);

      expect(await refusal(follower, "create_svg", { svg: "x".repeat(200_001) })).toMatch(
        /200000|too big|at most/i
      );
    },
    TIMEOUT_MS
  );
});
