/**
 * Image sources for the tools that put an image into Figma: `create_image`
 * and `set_image_fill`.
 *
 * A source is an http or https URL, a base64 data URI, or a local path. A URL
 * must resolve to a public address, at each redirect: no loopback, private,
 * link-local, or multicast range. A local path must lie, by real path, inside
 * the working directory, the output root, or a folder of
 * `FIGMA_BRIDGE_ASSET_ROOT` (one or more folders, separated by the path
 * delimiter of the system); a relative path resolves against the working
 * directory.
 *
 * Figma's `createImage` takes a PNG, a JPEG, or a GIF of at most 4096 pixels
 * per side, and refuses any other only after the bytes reached the plugin. So
 * `inspectImage` reads the format and the size from the header first, and
 * refuses a WebP, an AVIF, a HEIC, an SVG, or a larger image with the way
 * round it.
 *
 * Imports Node built-in modules, `image-size.ts`, and `output-root.ts` only.
 */

import { lookup } from "node:dns/promises";
import { readFile, realpath, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { readImageSize } from "./image-size.js";
import { isInside, outputRootPath } from "./output-root.js";

export const ASSET_ROOT_VARIABLE = "FIGMA_BRIDGE_ASSET_ROOT";

/** The longest side, in pixels, Figma's createImage takes. */
export const MAX_IMAGE_SIDE = 4096;

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_REDIRECTS = 5;

/** The formats Figma's createImage takes. */
export type ImageFormat = "PNG" | "JPEG" | "GIF";

/** An image ready for Figma: its bytes, its format, and its pixel size. */
export interface LoadedImage {
  bytes: Buffer;
  base64: string;
  format: ImageFormat;
  width: number;
  height: number;
}

const FORMAT_GUIDANCE =
  "Figma's createImage takes PNG, JPEG, or GIF. Request a PNG or JPEG rendition (for many CDNs add fm=jpg or format=jpg) or convert the file.";

/**
 * Loads an image source and checks that Figma takes it.
 * @param source - An http or https URL, a base64 data URI, or a local path.
 * @returns The bytes, the base64 text, the format, and the pixel size.
 * @throws With the cause and the correction, before anything reaches Figma.
 */
export async function loadImageSource(source: string): Promise<LoadedImage> {
  const bytes = await readSourceBytes(source);
  const { format, width, height } = inspectImage(bytes);
  return { bytes, base64: bytes.toString("base64"), format, width, height };
}

/**
 * Reads the format and the pixel size of an image from its header, and
 * refuses one Figma's createImage does not take.
 * @param bytes - The file.
 * @returns The format and the size.
 * @throws For a format other than PNG, JPEG, or GIF, an unreadable header, or
 * a side over 4096 pixels.
 */
export function inspectImage(bytes: Uint8Array): {
  format: ImageFormat;
  width: number;
  height: number;
} {
  const format = detectFormat(bytes);
  if (format === null) {
    throw new Error(
      `The image is not a PNG, JPEG, or GIF (its first bytes are ${firstBytes(bytes)}). ${FORMAT_GUIDANCE}`
    );
  }
  if (format !== "PNG" && format !== "JPEG" && format !== "GIF") {
    throw new Error(`The image is ${format}. ${FORMAT_GUIDANCE}`);
  }
  const size = readImageSize(bytes, format === "JPEG" ? "JPG" : format);
  if (size === null) {
    throw new Error(
      `The ${format} header gives no pixel size: the file is cut short or damaged. Load the file again, or convert it.`
    );
  }
  if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE) {
    throw new Error(
      `The image is ${size.width} x ${size.height} pixels, and Figma's createImage takes at most ${MAX_IMAGE_SIDE} pixels per side: request a smaller rendition (for many CDNs add w=2048), or scale the file down.`
    );
  }
  return { format, ...size };
}

/**
 * Names the format of a file from its first bytes.
 * @param bytes - The file.
 * @returns PNG, JPEG, or GIF; the name of a format Figma refuses; or null.
 */
function detectFormat(bytes: Uint8Array): ImageFormat | "WebP" | "AVIF" | "HEIC" | "SVG" | null {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.byteLength)));
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((value, index) => bytes[index] === value)) return "PNG";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "JPEG";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "GIF";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "WebP";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "AVIF";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      return "HEIC";
    }
  }
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("utf8").replace(/^﻿/, "").trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head)) return "SVG";
  return null;
}

function firstBytes(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return "none: the file is empty";
  return Array.from(bytes.subarray(0, 4), (value) => value.toString(16).padStart(2, "0")).join(" ");
}

/**
 * Reads the bytes of a source.
 * @param source - An http or https URL, a base64 data URI, or a local path.
 * @returns The bytes.
 */
async function readSourceBytes(source: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(source)) return fetchImageBytes(source);
  if (/^data:/i.test(source)) return decodeDataUri(source);
  return readLocalImage(source);
}

/**
 * Decodes a base64 data URI.
 * @param source - The data URI.
 * @returns The bytes.
 */
function decodeDataUri(source: string): Buffer {
  const comma = source.indexOf(",");
  const meta = comma < 0 ? "" : source.slice(5, comma);
  if (comma < 0 || !/;base64$/i.test(meta)) {
    throw new Error(
      "A data URI source must be base64, as in data:image/png;base64,iVBORw0KGgo… Encode the file as base64, or pass a URL or a local path."
    );
  }
  const payload = source.slice(comma + 1).replace(/\s+/g, "");
  if (payload === "" || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) {
    throw new Error(
      "The data URI holds no valid base64 after the comma. Encode the file as base64 again."
    );
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
  return bytes;
}

/**
 * The folders a local image may come from, by real path: the working
 * directory, the output root, and each folder of `FIGMA_BRIDGE_ASSET_ROOT`
 * that exists.
 * @returns Each folder with the name of its source, for a message.
 */
async function allowedRoots(): Promise<Array<{ real: string; label: string }>> {
  const candidates: Array<{ path: string; label: string }> = [
    { path: process.cwd(), label: "working directory" },
    { path: outputRootPath(), label: "output root" },
  ];
  for (const entry of (process.env[ASSET_ROOT_VARIABLE] ?? "").split(path.delimiter)) {
    if (entry.trim() !== "") {
      candidates.push({ path: path.resolve(entry.trim()), label: ASSET_ROOT_VARIABLE });
    }
  }
  const roots: Array<{ real: string; label: string }> = [];
  for (const candidate of candidates) {
    try {
      roots.push({ real: await realpath(candidate.path), label: candidate.label });
    } catch {
      // A folder that does not exist holds no image.
    }
  }
  return roots;
}

/**
 * Reads a local image inside one of the allowed folders.
 *
 * The path is resolved to its real location before the check, so a link
 * inside an allowed folder cannot point the read outside it.
 * @param source - A path, relative to the working directory or absolute.
 * @returns The bytes.
 */
async function readLocalImage(source: string): Promise<Buffer> {
  const lexical = path.resolve(process.cwd(), source);
  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    throw new Error(
      `Image source not found: ${source} (resolved to ${lexical}). A relative path resolves against the working directory of the MCP server; pass an absolute path, a URL, or a data URI.`
    );
  }
  const roots = await allowedRoots();
  if (!roots.some((root) => isInside(root.real, real))) {
    throw new Error(
      `Image source ${source} is outside the folders the bridge reads images from: ${roots
        .map((root) => `${root.real} (${root.label})`)
        .join(", ")}. Move the file into one of them, or add its folder to ${ASSET_ROOT_VARIABLE}.`
    );
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`Image source is not a regular file: ${source}`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
  return readFile(real);
}

/**
 * Fetches image bytes from a remote URL with redirect and timeout limits.
 * @param source - HTTP or HTTPS image URL.
 * @returns Raw image bytes.
 */
async function fetchImageBytes(source: string): Promise<Buffer> {
  let url = new URL(source);
  let redirects = 0;

  while (true) {
    await assertSafeHttpUrl(url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Timed out fetching image after ${IMAGE_FETCH_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) {
        throw new Error(`Image redirect missing Location header: ${resp.status}`);
      }
      redirects += 1;
      if (redirects > MAX_IMAGE_REDIRECTS) {
        throw new Error(`Image fetch exceeded ${MAX_IMAGE_REDIRECTS} redirects`);
      }
      url = new URL(location, url);
      continue;
    }

    if (!resp.ok) {
      throw new Error(`Failed to fetch image: ${resp.status} ${resp.statusText}`);
    }

    const contentLength = resp.headers.get("content-length");
    if (contentLength !== null) {
      const size = Number(contentLength);
      if (!Number.isFinite(size) || size < 0) {
        throw new Error("Invalid image Content-Length header");
      }
      if (size > MAX_IMAGE_BYTES) {
        throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
      }
    }

    return readBoundedResponse(resp, MAX_IMAGE_BYTES);
  }
}

/**
 * Validates that an image URL uses a safe public HTTP(S) endpoint.
 * @param url - URL to validate.
 */
async function assertSafeHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Image URL must use http or https");
  }
  if (!url.hostname) {
    throw new Error("Image URL must include a hostname");
  }

  const hostname = normalizeHostname(url.hostname);
  const literalIp = isIP(hostname);
  if (literalIp !== 0) {
    if (isBlockedIp(hostname)) {
      throw new Error("Image URL resolves to a blocked internal address");
    }
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error("Image URL hostname did not resolve");
  }
  if (addresses.some((address) => isBlockedIp(address.address))) {
    throw new Error("Image URL resolves to a blocked internal address");
  }
}

/**
 * Checks whether an IP address is in a private, loopback, or otherwise blocked range.
 * @param address - IPv4 or IPv6 address string.
 * @returns True if the address is blocked for SSRF protection.
 */
function isBlockedIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isBlockedIp(normalized.slice("::ffff:".length));
  }

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]:/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

/**
 * Strips surrounding brackets from an IPv6 hostname so it can be parsed as an IP.
 * @param hostname - Hostname string, possibly bracketed.
 * @returns Normalized hostname without brackets.
 */
function normalizeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Reads a response body up to a maximum byte limit.
 * @param resp - Fetch response with a readable body.
 * @param maxBytes - Maximum number of bytes to accept.
 * @returns Concatenated response bytes.
 */
async function readBoundedResponse(resp: Response, maxBytes: number): Promise<Buffer> {
  if (!resp.body) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of resp.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw new Error(`Image exceeds ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}
