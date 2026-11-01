import {
  applyChildLayout,
  checkChildLayout,
  describeCreated,
  fieldError,
  findParent,
  finishOrRemove,
  placeInParent,
  readChildLayout,
} from "../layout";
import { positionNode } from "../shared";
import {
  describeValue,
  messageOf,
  readBatchArray,
  readOptionalString,
  runBatchWrites,
  validationError,
} from "./batch";
import type { ExtensionHandler, ExtensionRequest } from "./types";

/**
 * Asset tools: image fills on existing nodes, and SVG icons.
 *
 * Add a tool by adding one entry here. Set `edit` to true when the handler
 * writes to the file.
 */

/** The longest SVG markup `create_svg` takes. */
const MAX_SVG_CHARS = 200_000;

const SCALE_MODES = ["FILL", "FIT"] as const;
type ScaleMode = (typeof SCALE_MODES)[number];

/** One validated `set_image_fill` item, ready to write. */
type FillPlan = {
  node: SceneNode;
  imageHash: string;
  scaleMode: ScaleMode;
};

/**
 * Finds a node by ID on any page, loading the other pages one by one until
 * the ID resolves, as `getSceneNodeById` does.
 * @param nodeId - The node ID.
 * @returns The node, or null when no node has the ID.
 */
const findNodeById = async (nodeId: string): Promise<BaseNode | null> => {
  let node = await figma.getNodeByIdAsync(nodeId);
  if (node) return node;
  for (const page of figma.root.children) {
    if (page.id === figma.currentPage.id) continue;
    await page.loadAsync();
    node = await figma.getNodeByIdAsync(nodeId);
    if (node) return node;
  }
  return null;
};

/**
 * Puts an image fill on existing nodes: a product photo into the image layer
 * of a component instance, or an uploaded image reused by its hash.
 *
 * The server loads each distinct source once and sends its bytes in `images`;
 * an item names one by its index there, or reuses an image of the file by
 * `imageHash`. Every item is examined before the first write: each node must
 * exist and carry fills, each image must be one Figma takes, and each hash
 * must be an image of this file. The write replaces the fills of the node
 * with the one image paint; on an instance layer it is an override.
 * @param req - The extension request.
 * @returns One result entry per item, with the hash to reuse.
 */
const setImageFill = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "set_image_fill";
  const rawItems = readBatchArray(req.params, "items", tool);
  const rawImages = req.params.images ?? [];
  if (!Array.isArray(rawImages)) {
    throw new Error(
      `${tool} requires images as an array of base64 strings, received ${describeValue(rawImages)}.`
    );
  }

  const problems: string[] = [];
  // Each image is made one time, at the first item that names it.
  const hashes = new Map<number, string | Error>();
  const imageHash = (index: number): string | Error => {
    const known = hashes.get(index);
    if (known !== undefined) return known;
    let made: string | Error;
    const raw = rawImages[index];
    if (typeof raw !== "string" || raw === "") {
      made = new Error(`images[${index}] is not a base64 string.`);
    } else {
      try {
        made = figma.createImage(figma.base64Decode(raw)).hash;
      } catch (err) {
        made = new Error(
          `Figma refused the image: ${messageOf(err)}. createImage takes a PNG, JPEG, or GIF of at most 4096 pixels per side.`
        );
      }
    }
    hashes.set(index, made);
    return made;
  };

  const plans: FillPlan[] = [];
  const seen = new Map<string, number>();
  for (let index = 0; index < rawItems.length; index++) {
    const fail = (problem: string): void => {
      problems.push(`items[${index}]: ${problem}`);
    };
    const raw = rawItems[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail(`each item must be an object with nodeId, received ${describeValue(raw)}.`);
      continue;
    }
    const item = raw as Record<string, unknown>;

    let scaleMode: ScaleMode = "FILL";
    try {
      const mode = readOptionalString(item, "scaleMode", tool);
      if (mode !== undefined) {
        if (!(SCALE_MODES as readonly string[]).includes(mode)) {
          throw new Error(`scaleMode must be "FILL" or "FIT", received "${mode}".`);
        }
        scaleMode = mode as ScaleMode;
      }
    } catch (err) {
      fail(messageOf(err));
      continue;
    }

    const nodeId = item.nodeId;
    if (typeof nodeId !== "string" || nodeId.trim() === "") {
      fail(
        `nodeId must be a node ID such as "4029:12345", received ${describeValue(nodeId)}. Call get_document or find_nodes to look it up.`
      );
      continue;
    }
    const earlier = seen.get(nodeId);
    if (earlier !== undefined) {
      fail(`${nodeId} repeats items[${earlier}]. Name each node once.`);
      continue;
    }
    seen.set(nodeId, index);

    const hasImage = item.image !== undefined && item.image !== null;
    const hasHash = item.imageHash !== undefined && item.imageHash !== null;
    if (hasImage === hasHash) {
      fail(
        "give exactly one of source and imageHash: source for a new image, imageHash to reuse one this file already holds."
      );
      continue;
    }

    const node = await findNodeById(nodeId);
    if (!node) {
      fail(`node not found: ${nodeId}. Call get_document or find_nodes to look the node up.`);
      continue;
    }
    if (node.type === "DOCUMENT" || node.type === "PAGE") {
      fail(
        `${nodeId} "${node.name}" is a ${node.type === "PAGE" ? "page" : "document"}, which takes no image fill. Pass the ID of a frame, a shape, or an image layer.`
      );
      continue;
    }
    if (!("fills" in node)) {
      fail(
        `${nodeId} "${node.name}" is a ${node.type} node and carries no fills. Pass a frame, a shape, or a layer of an instance that carries fills.`
      );
      continue;
    }

    let hash: string;
    if (hasImage) {
      const imageIndex = item.image;
      if (
        typeof imageIndex !== "number" ||
        !Number.isInteger(imageIndex) ||
        imageIndex < 0 ||
        imageIndex >= rawImages.length
      ) {
        fail(
          `image must index images (0 to ${rawImages.length - 1}), received ${JSON.stringify(imageIndex)}.`
        );
        continue;
      }
      const made = imageHash(imageIndex);
      if (made instanceof Error) {
        fail(made.message);
        continue;
      }
      hash = made;
    } else {
      const wanted = item.imageHash;
      if (typeof wanted !== "string" || wanted.trim() === "") {
        fail(`imageHash must be a non-empty string, received ${describeValue(wanted)}.`);
        continue;
      }
      if (!figma.getImageByHash(wanted)) {
        fail(
          `imageHash "${wanted}" is no image of this file. Use an imageHash that create_image or set_image_fill returned for this file, or pass source.`
        );
        continue;
      }
      hash = wanted;
    }

    plans.push({ node: node as SceneNode, imageHash: hash, scaleMode });
  }

  if (problems.length > 0) throw validationError(tool, problems);

  return runBatchWrites(plans, async (plan) => {
    (plan.node as SceneNode & { fills: Paint[] }).fills = [
      { type: "IMAGE", imageHash: plan.imageHash, scaleMode: plan.scaleMode },
    ];
    return { nodeId: plan.node.id, imageHash: plan.imageHash };
  });
};

/**
 * Places an SVG icon as a vector frame, the way Figma's SVG import does.
 *
 * The parent and the layout fields are checked before the node exists, and
 * a step that fails after `createNodeFromSvg` removes the node again. `width`
 * or `height` scales the icon proportionally; width wins if both are given.
 * @param req - The extension request.
 * @returns The new node, reported as `create_frame` reports one.
 */
const createSvg = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "create_svg";
  const params = req.params;
  const problems: string[] = [];

  const svg = params.svg;
  if (typeof svg !== "string" || svg.trim() === "") {
    problems.push(`svg must be the markup of one <svg> element, received ${describeValue(svg)}.`);
  } else if (svg.length > MAX_SVG_CHARS) {
    problems.push(
      `svg holds ${svg.length} characters, more than ${MAX_SVG_CHARS}. Simplify the icon or split it.`
    );
  }
  for (const field of ["width", "height"] as const) {
    const value = params[field];
    if (value !== undefined && value !== null && !(typeof value === "number" && value > 0)) {
      problems.push(`${field} must be a number above 0, received ${JSON.stringify(value)}.`);
    }
  }
  const parent = await findParent(params.parentId, problems);
  const layout = readChildLayout(params, problems);
  const namedParent = params.parentId !== undefined && params.parentId !== null;
  if (parent) {
    // Figma's SVG import makes a plain frame: no auto layout of its own.
    checkChildLayout(layout, { type: "FRAME", autoLayout: false, parent, namedParent }, problems);
  }
  if (problems.length > 0 || !parent) throw fieldError(tool, problems);

  let node: FrameNode;
  try {
    node = figma.createNodeFromSvg(svg as string);
  } catch (err) {
    throw new Error(
      `${tool} wrote nothing: Figma could not read svg: ${messageOf(err)}. Pass the markup of one complete <svg> element.`
    );
  }

  return finishOrRemove(node, () => {
    if (typeof params.name === "string" && params.name !== "") node.name = params.name;
    if (typeof params.width === "number" && node.width > 0) {
      node.rescale(params.width / node.width);
    } else if (typeof params.height === "number" && node.height > 0) {
      node.rescale(params.height / node.height);
    }
    if (namedParent || layout.index !== undefined) placeInParent(node, parent, layout.index);
    applyChildLayout(node, layout);
    positionNode(node, params.x, params.y);
    return describeCreated(node);
  });
};

export const assetsHandlers = {
  set_image_fill: { edit: true, run: setImageFill },
  create_svg: { edit: true, run: createSvg },
} satisfies Record<string, ExtensionHandler>;
