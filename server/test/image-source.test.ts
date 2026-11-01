/**
 * The image sources of `create_image` and `set_image_fill`: the format and
 * size check of `inspectImage`, the data URI form, and the folders a local
 * image may come from. Runs in the test process; no server starts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ASSET_ROOT_VARIABLE, inspectImage, loadImageSource } from "../src/image-source.js";
import { gifWithSize, jpgWithSize, PNG_1X1_BASE64, pngWithSize } from "./helpers/plugin.js";

const FORMAT_GUIDANCE =
  "Figma's createImage takes PNG, JPEG, or GIF. Request a PNG or JPEG rendition (for many CDNs add fm=jpg or format=jpg) or convert the file.";

const dataUri = (bytes: Buffer, mime = "image/png") =>
  `data:${mime};base64,${bytes.toString("base64")}`;

/** The start of a WebP file: RIFF, a size, WEBP, and a VP8 chunk. */
const webp = (): Buffer =>
  Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x24, 0, 0, 0]),
    Buffer.from("WEBPVP8 ", "ascii"),
    Buffer.alloc(16),
  ]);

/** The start of an ISO media file with the given brand: AVIF or HEIC. */
const isoMedia = (brand: string): Buffer =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0x1c]),
    Buffer.from(`ftyp${brand}`, "ascii"),
    Buffer.alloc(16),
  ]);

const refusal = async (source: string): Promise<string> => {
  try {
    await loadImageSource(source);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`${source.slice(0, 40)} was accepted`);
};

describe("inspectImage", () => {
  test("takes a PNG, a JPEG, and a GIF, with their pixel size", () => {
    expect(inspectImage(Buffer.from(PNG_1X1_BASE64, "base64"))).toEqual({
      format: "PNG",
      width: 1,
      height: 1,
    });
    expect(inspectImage(jpgWithSize(640, 480))).toEqual({
      format: "JPEG",
      width: 640,
      height: 480,
    });
    expect(inspectImage(gifWithSize(32, 16))).toEqual({ format: "GIF", width: 32, height: 16 });
    expect(inspectImage(pngWithSize(4096, 4096))).toEqual({
      format: "PNG",
      width: 4096,
      height: 4096,
    });
  });

  test("refuses WebP, AVIF, HEIC, and SVG with the way round it", () => {
    for (const [bytes, name] of [
      [webp(), "WebP"],
      [isoMedia("avif"), "AVIF"],
      [isoMedia("heic"), "HEIC"],
      [Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "SVG"],
    ] as const) {
      expect(() => inspectImage(bytes)).toThrow(`The image is ${name}. ${FORMAT_GUIDANCE}`);
    }
  });

  test("refuses an unknown format and a damaged header", () => {
    expect(() => inspectImage(Buffer.from("BM\u0000\u0001"))).toThrow(
      "The image is not a PNG, JPEG, or GIF (its first bytes are 42 4d 00 01)"
    );
    expect(() => inspectImage(Buffer.alloc(0))).toThrow("the file is empty");
    expect(() => inspectImage(pngWithSize(8, 8).subarray(0, 12))).toThrow(
      "The PNG header gives no pixel size"
    );
  });

  test("refuses a side over 4096 pixels", () => {
    expect(() => inspectImage(pngWithSize(5000, 300))).toThrow(
      "The image is 5000 x 300 pixels, and Figma's createImage takes at most 4096 pixels per side: request a smaller rendition (for many CDNs add w=2048), or scale the file down."
    );
    expect(() => inspectImage(jpgWithSize(100, 4097))).toThrow("request a smaller rendition");
  });
});

describe("a data URI", () => {
  test("loads base64 into the bytes, the base64 text, the format, and the size", async () => {
    const loaded = await loadImageSource(`data:image/png;base64,${PNG_1X1_BASE64}`);
    expect(loaded).toMatchObject({ base64: PNG_1X1_BASE64, format: "PNG", width: 1, height: 1 });
    expect(loaded.bytes.equals(Buffer.from(PNG_1X1_BASE64, "base64"))).toBe(true);
  });

  test("refuses WebP and a large PNG before anything is sent", async () => {
    expect(await refusal(dataUri(webp(), "image/webp"))).toContain(FORMAT_GUIDANCE);
    expect(await refusal(dataUri(pngWithSize(5000, 10)))).toContain(
      "request a smaller rendition (for many CDNs add w=2048)"
    );
  });

  test("refuses a data URI that is not base64", async () => {
    expect(await refusal("data:image/svg+xml,<svg></svg>")).toContain(
      "A data URI source must be base64"
    );
    expect(await refusal("data:image/png;base64,")).toContain("no valid base64");
  });
});

describe("a local path", () => {
  const made: string[] = [];
  const saved = process.env[ASSET_ROOT_VARIABLE];

  afterEach(async () => {
    if (saved === undefined) delete process.env[ASSET_ROOT_VARIABLE];
    else process.env[ASSET_ROOT_VARIABLE] = saved;
    while (made.length > 0) await rm(made.pop()!, { recursive: true, force: true });
  });

  const tempFolder = async (label: string): Promise<string> => {
    const folder = await mkdtemp(path.join(tmpdir(), `figma-bridge-image-${label}-`));
    made.push(folder);
    return folder;
  };

  test("is refused outside the working directory, the output root, and the asset roots", async () => {
    delete process.env[ASSET_ROOT_VARIABLE];
    const folder = await tempFolder("outside");
    const file = path.join(folder, "photo.png");
    await writeFile(file, pngWithSize(20, 10));
    const message = await refusal(file);
    expect(message).toContain(
      `Image source ${file} is outside the folders the bridge reads images from`
    );
    expect(message).toContain("(working directory)");
    expect(message).toContain(`add its folder to ${ASSET_ROOT_VARIABLE}`);
  });

  test("is read inside a folder of FIGMA_BRIDGE_ASSET_ROOT, one of several", async () => {
    const first = await tempFolder("first");
    const second = await tempFolder("second");
    const file = path.join(second, "nested", "photo.gif");
    await mkdir(path.dirname(file));
    await writeFile(file, gifWithSize(64, 48));
    process.env[ASSET_ROOT_VARIABLE] = `${first}${path.delimiter}${second}`;
    expect(await loadImageSource(file)).toMatchObject({ format: "GIF", width: 64, height: 48 });
  });

  test("is checked by real path, so a link inside an asset root cannot reach out of it", async () => {
    const root = await tempFolder("root");
    const outside = await tempFolder("elsewhere");
    await writeFile(path.join(outside, "photo.png"), pngWithSize(4, 4));
    await symlink(
      outside,
      path.join(root, "link"),
      process.platform === "win32" ? "junction" : "dir"
    );
    process.env[ASSET_ROOT_VARIABLE] = root;
    expect(await refusal(path.join(root, "link", "photo.png"))).toContain(
      "is outside the folders the bridge reads images from"
    );
  });

  test("that does not exist names where it looked", async () => {
    expect(await refusal("no-such-image.png")).toContain(
      "Image source not found: no-such-image.png"
    );
  });
});
