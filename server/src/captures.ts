/**
 * Captures: `save_screenshots` writes each capture under the output root of
 * the serving process and returns a manifest, and `get_screenshot` returns a
 * small raster capture as an image block.
 *
 * The manifest has the envelope of `evidence.ts`: the identity of the file at
 * the start of the call, one entry for each item, and the totals. It also goes
 * to disk beside the first capture. The result holds no image data.
 *
 * This module imports no `schema.ts` and no `tools.ts`: `tools.ts` imports it.
 */

import path from "node:path";
import {
  canonicalBytes,
  EvidenceSet,
  EvidenceTakenError,
  folderTimestamp,
  manifestEnvelope,
  sessionChange,
  utcTimestamp,
} from "./evidence.js";
import type { EvidenceIdentity, ManifestEnvelope } from "./evidence.js";
import { resolveFileIdentity } from "./identity.js";
import { readImageSize } from "./image-size.js";
import type { PixelSize } from "./image-size.js";
import type { Node } from "./node.js";
import { checkOutputRoot, resolveEvidencePath } from "./output-root.js";
import type { ToolContent, ToolResult } from "./tool-helpers.js";
import type { BridgeResponse } from "./types.js";

const TOOL = "save_screenshots";

export type ExportFormat = "PNG" | "SVG" | "JPG" | "PDF";

/** The scale the plugin uses for a raster export when the call gives none. */
const DEFAULT_RASTER_SCALE = 2;

/** The longest edge, in pixels, that `get_screenshot` returns as an image block. */
export const IMAGE_BLOCK_MAX_EDGE = 1_568;

/** The most bytes, before base64, that `get_screenshot` returns as an image block. */
export const IMAGE_BLOCK_MAX_BYTES = 3_750_000;

export interface SaveScreenshotItemInput {
  nodeId: string;
  outputPath: string;
  format?: ExportFormat;
  scale?: number;
  clip?: boolean;
}

export interface SaveScreenshotsInput {
  items: SaveScreenshotItemInput[];
  format?: ExportFormat;
  scale?: number;
  clip?: boolean;
  fileKey?: string;
}

/** An item that was written. */
export interface CaptureFile {
  kind: "capture";
  index: number;
  nodeId: string;
  nodeName: string;
  /** Relative to the output root, with `/`. */
  path: string;
  format: ExportFormat;
  /** The scale of a raster capture; null for SVG and PDF. */
  scale: number | null;
  /** From the image header; null for SVG and PDF. */
  pixelWidth: number | null;
  pixelHeight: number | null;
  bytes: number;
  sha256: string;
  ok: true;
}

/** An item that was not written. */
export interface FailedCapture {
  index: number;
  nodeId: string;
  ok: false;
  error: string;
}

export type CaptureManifest = ManifestEnvelope<CaptureFile | FailedCapture> & {
  /** Relative to the output root, with `/`; null when no item was written. */
  manifestPath: string | null;
  total: number;
  succeeded: number;
  failed: number;
  hasErrors: boolean;
};

/** An item whose path, format, and scale are resolved. */
interface PlannedItem {
  index: number;
  item: SaveScreenshotItemInput;
  /** The absolute target path. */
  target: string;
  format: ExportFormat;
  scale: number | undefined;
  clip: boolean | undefined;
}

/** A failure of the whole call. */
class CaptureError extends Error {}

const captureError = (where: string, cause: string, correction: string): CaptureError =>
  new CaptureError(`${TOOL} failed ${where}: ${cause.replace(/[.\s]+$/, "")}. ${correction}`);

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Infers an export format from a file path extension.
 * @param outputPath - Output file path.
 * @returns Export format, or null if the extension is unrecognized.
 */
function inferFormatFromPath(outputPath: string): ExportFormat | null {
  switch (path.extname(outputPath).toLowerCase()) {
    case ".png":
      return "PNG";
    case ".svg":
      return "SVG";
    case ".jpg":
    case ".jpeg":
      return "JPG";
    case ".pdf":
      return "PDF";
    default:
      return null;
  }
}

/**
 * Resolves the final export format, ensuring it does not conflict with the file extension.
 * @param format - Explicitly requested format.
 * @param inferredFormat - Format inferred from the output path extension.
 * @returns Resolved export format.
 */
function resolveExportFormat(
  format: ExportFormat | undefined,
  inferredFormat: ExportFormat | null
): ExportFormat {
  if (format && inferredFormat && format !== inferredFormat) {
    throw new Error(`format ${format} conflicts with outputPath extension (${inferredFormat})`);
  }
  return format ?? inferredFormat ?? "PNG";
}

/**
 * Resolves the effective screenshot scale from item and default values.
 * @param itemScale - Scale specified for the item.
 * @param defaultScale - Default scale for the batch.
 * @returns Positive scale value, or undefined if not applicable.
 */
function resolveScale(itemScale?: number, defaultScale?: number): number | undefined {
  const resolvedScale = itemScale ?? defaultScale;
  if (resolvedScale === undefined || resolvedScale <= 0) return undefined;
  return resolvedScale;
}

interface ScreenshotExport {
  nodeId: string;
  nodeName: string;
  format: ExportFormat;
  base64: string;
  width: number;
  height: number;
}

/**
 * Extracts and validates the first screenshot export from plugin response data.
 * @param data - Plugin response payload.
 * @returns Validated screenshot export object.
 */
function getSingleScreenshotExport(data: unknown): ScreenshotExport {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid screenshot response from plugin");
  }
  const exports = (data as { exports?: unknown }).exports;
  if (!Array.isArray(exports) || exports.length === 0) {
    throw new Error("No screenshot export returned by plugin");
  }
  const first = exports[0] as Record<string, unknown> | null;
  if (
    !first ||
    typeof first !== "object" ||
    typeof first.nodeId !== "string" ||
    typeof first.nodeName !== "string" ||
    typeof first.base64 !== "string"
  ) {
    throw new Error("Malformed screenshot export payload");
  }
  return first as unknown as ScreenshotExport;
}

/** The key that tells two paths apart; Windows ignores case. */
const pathKey = (target: string): string =>
  process.platform === "win32" ? target.toLowerCase() : target;

/**
 * Resolves each item's path, format, and scale. An item that cannot be
 * planned, or that repeats the path of an earlier item, fails on its own.
 * @param input - The parsed input.
 * @returns The items to capture, and the entries of the items that failed.
 */
async function planItems(
  input: SaveScreenshotsInput
): Promise<{ planned: PlannedItem[]; failures: Map<number, FailedCapture> }> {
  const planned: PlannedItem[] = [];
  const failures = new Map<number, FailedCapture>();
  const seen = new Map<string, number>();
  for (const [index, item] of input.items.entries()) {
    try {
      const target = await resolveEvidencePath(item.outputPath);
      const format = resolveExportFormat(item.format ?? input.format, inferFormatFromPath(target));
      const earlier = seen.get(pathKey(target));
      if (earlier !== undefined) {
        throw new Error(
          `items[${index}]: outputPath "${item.outputPath}" repeats items[${earlier}]. Each capture needs its own file.`
        );
      }
      seen.set(pathKey(target), index);
      planned.push({
        index,
        item,
        target,
        format,
        scale: resolveScale(item.scale, input.scale),
        clip: item.clip ?? input.clip,
      });
    } catch (err) {
      failures.set(index, { index, nodeId: item.nodeId, ok: false, error: errorMessage(err) });
    }
  }
  return { planned, failures };
}

/**
 * Captures one item, and writes it as a partial file.
 * @param node - The node of this process.
 * @param evidence - The evidence set of the call.
 * @param fileKey - The resolved file key.
 * @param plan - The item.
 * @returns The manifest entry.
 * @throws If the plugin fails, the image has no readable header, or the write fails.
 */
async function captureItem(
  node: Node,
  evidence: EvidenceSet,
  fileKey: string,
  plan: PlannedItem
): Promise<CaptureFile> {
  const params: Record<string, unknown> = { format: plan.format };
  if (plan.scale !== undefined) params.scale = plan.scale;
  if (plan.clip !== undefined) params.clip = plan.clip;

  const response = await node.sendWithParams("get_screenshot", [plan.item.nodeId], params, fileKey);
  if (response.error) throw new Error(response.error);
  const exported = getSingleScreenshotExport(response.data);
  const bytes = Buffer.from(exported.base64, "base64");

  let size: PixelSize | null = null;
  if (plan.format === "PNG" || plan.format === "JPG") {
    size = readImageSize(bytes, plan.format);
    if (size === null) {
      throw new Error(
        `the ${plan.format} data from the plugin has no readable header, so its pixel size is unknown`
      );
    }
  }
  const written = await evidence.write(plan.target, bytes);
  return {
    kind: "capture",
    index: plan.index,
    nodeId: exported.nodeId,
    nodeName: exported.nodeName,
    path: written.path,
    format: plan.format,
    scale: size === null ? null : (plan.scale ?? DEFAULT_RASTER_SCALE),
    pixelWidth: size === null ? null : size.width,
    pixelHeight: size === null ? null : size.height,
    bytes: written.bytes,
    sha256: written.sha256,
    ok: true,
  };
}

/**
 * Reads the identity of the file again, and fails when another plugin
 * session served part of the call.
 * @param node - The node of this process.
 * @param before - The identity at the start of the call.
 */
async function checkSession(node: Node, before: EvidenceIdentity): Promise<void> {
  const where = `for the file ${before.fileKey}`;
  let after: EvidenceIdentity;
  try {
    after = await resolveFileIdentity(node, before.fileKey);
  } catch (err) {
    throw captureError(
      where,
      `the identity of the file could not be read again: ${errorMessage(err)}`,
      `Make sure that the plugin stays open in the file, then call ${TOOL} again.`
    );
  }
  const change = sessionChange(before, after);
  if (change !== null) {
    throw captureError(
      where,
      `the plugin session changed during the capture (${change}), so the captures can come from two sessions`,
      `Call ${TOOL} again while the plugin stays open.`
    );
  }
}

/**
 * Runs one `save_screenshots` call in this process.
 *
 * The steps: check the root and read the identity of the file; plan each
 * item; refuse a target that exists; capture each item and write it as
 * `.partial`; read the identity again; write the manifest as `.partial`;
 * publish each file. A failure of the call removes each file of the call. An
 * item that fails on its own does not fail the call.
 * @param node - The node of this process.
 * @param input - The parsed input.
 * @returns The manifest, which the manifest file also holds.
 */
export async function executeSaveScreenshots(
  node: Node,
  input: SaveScreenshotsInput
): Promise<CaptureManifest> {
  const startedAt = new Date();
  let realRoot: string;
  let before: EvidenceIdentity;
  let plan: Awaited<ReturnType<typeof planItems>>;
  let evidence: EvidenceSet | null = null;
  // The manifest goes beside the first capture. It is named after the start time.
  let manifestTarget: string | null = null;

  try {
    realRoot = await checkOutputRoot();
    before = await resolveFileIdentity(node, input.fileKey);
    plan = await planItems(input);
    if (plan.planned.length > 0) {
      manifestTarget = path.join(
        path.dirname(plan.planned[0].target),
        `${TOOL}-${folderTimestamp(startedAt)}.manifest.json`
      );
      // The names are absolute, so the set takes an empty outputPath: `path.join("", name)` is the name.
      evidence = await EvidenceSet.open("", [
        ...plan.planned.map((entry) => entry.target),
        manifestTarget,
      ]);
    }
  } catch (err) {
    const cause =
      err instanceof EvidenceTakenError
        ? `${err.taken.join(", ")} already exists. Evidence is never overwritten`
        : errorMessage(err);
    throw captureError(
      "before the first capture",
      cause,
      err instanceof EvidenceTakenError
        ? "Give a new outputPath to each item. No file was written."
        : "No file was written."
    );
  }

  const entries = new Map<number, CaptureFile | FailedCapture>(plan.failures);
  if (evidence === null || manifestTarget === null) {
    return buildManifest(startedAt, before, realRoot, entries, input.items.length, null);
  }

  try {
    for (const planned of plan.planned) {
      try {
        entries.set(planned.index, await captureItem(node, evidence, before.fileKey, planned));
      } catch (err) {
        entries.set(planned.index, {
          index: planned.index,
          nodeId: planned.item.nodeId,
          ok: false,
          error: errorMessage(err),
        });
      }
    }

    await checkSession(node, before);

    const manifestPath = await evidence.plannedPath(manifestTarget);
    const manifest = buildManifest(
      startedAt,
      before,
      evidence.realRoot,
      entries,
      input.items.length,
      manifestPath
    );
    const written = await evidence.write(manifestTarget, canonicalBytes(manifest));
    if (written.path !== manifestPath) {
      throw new Error(`the manifest went to ${written.path}, not to the planned ${manifestPath}`);
    }
    await evidence.publish();
    return manifest;
  } catch (err) {
    const message =
      err instanceof CaptureError
        ? err.message
        : `${TOOL} failed while it wrote the files: ${errorMessage(err).replace(/[.\s]+$/, "")}. Correct the cause, then call ${TOOL} again.`;
    const remaining = await evidence.discard();
    throw new Error(
      remaining.length === 0
        ? `${message} No file of this call remains.`
        : `${message} These files of the call could not be removed and are not evidence: ${remaining.join(", ")}`
    );
  }
}

/**
 * Builds the manifest from the entries.
 * @param startedAt - When the call started.
 * @param identity - The identity of the file at the start of the call.
 * @param realRoot - The real path of the output root.
 * @param entries - The entry of each item, by index.
 * @param total - The number of items.
 * @param manifestPath - The path of the manifest file, or null when none is written.
 * @returns The manifest.
 */
function buildManifest(
  startedAt: Date,
  identity: EvidenceIdentity,
  realRoot: string,
  entries: Map<number, CaptureFile | FailedCapture>,
  total: number,
  manifestPath: string | null
): CaptureManifest {
  const files = [...entries.values()].sort((a, b) => a.index - b.index);
  const succeeded = files.filter((file) => file.ok).length;
  return {
    ...manifestEnvelope(TOOL, identity, realRoot, utcTimestamp(startedAt), utcTimestamp(), files),
    manifestPath,
    total,
    succeeded,
    failed: total - succeeded,
    hasErrors: total - succeeded > 0,
  };
}

/**
 * The blocks of one export when it fits an image block.
 * @param value - One element of `exports`.
 * @returns An image block and a text block with the metadata, or null.
 */
function imageBlocks(value: unknown): ToolContent[] | null {
  if (typeof value !== "object" || value === null) return null;
  const exported = value as Record<string, unknown>;
  const { nodeId, nodeName, format, base64 } = exported;
  if (typeof nodeId !== "string" || typeof nodeName !== "string" || typeof base64 !== "string") {
    return null;
  }
  if (format !== "PNG" && format !== "JPG") return null;
  // Four base64 characters hold at most 3 bytes: skip the decode for a capture that is far too big.
  if (base64.length > Math.ceil(IMAGE_BLOCK_MAX_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > IMAGE_BLOCK_MAX_BYTES) return null;
  const size = readImageSize(bytes, format);
  if (size === null || Math.max(size.width, size.height) > IMAGE_BLOCK_MAX_EDGE) return null;
  return [
    { type: "image", data: base64, mimeType: format === "PNG" ? "image/png" : "image/jpeg" },
    {
      type: "text",
      text: JSON.stringify({
        nodeId,
        nodeName,
        format,
        pixelWidth: size.width,
        pixelHeight: size.height,
        bytes: bytes.byteLength,
      }),
    },
  ];
}

/**
 * The tool result of `get_screenshot`. When every export is a PNG or a JPG
 * that fits the limits, each one becomes an image block and a text block with
 * its metadata, and no base64 text. Any other answer (an SVG, a PDF, a larger
 * raster export) is the JSON text of the answer.
 * @param response - The plugin response.
 * @returns The tool result.
 */
export function screenshotToolResult(response: BridgeResponse): ToolResult {
  if (response.error) {
    return { content: [{ type: "text", text: response.error }], isError: true };
  }
  const exports = (response.data as { exports?: unknown } | null | undefined)?.exports;
  if (Array.isArray(exports) && exports.length > 0) {
    const content: ToolContent[] = [];
    for (const entry of exports) {
      const blocks = imageBlocks(entry);
      if (blocks === null) {
        content.length = 0;
        break;
      }
      content.push(...blocks);
    }
    if (content.length > 0) return { content };
  }
  return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
}
