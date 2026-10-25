import { isMixed, serializePaints } from "../serializer";
import type { SerializedPaint, SerializeOptions } from "../serializer";
import {
  describeValue,
  readBatchArray,
  readOptionalString,
  runBatchWrites,
  validationError,
} from "./batch";
import type { ExtensionHandler, ExtensionRequest } from "./types";

/**
 * Paint tools.
 *
 * Add a tool by adding one entry here. Set `edit` to true when the handler
 * writes to the file.
 */

/** The paint lists `clear_paints` empties. */
const PAINT_TARGETS = ["fills", "strokes"] as const;
type PaintTarget = (typeof PAINT_TARGETS)[number];

/** The paint style link that goes with each paint list. */
const STYLE_ID_FIELDS: Record<PaintTarget, "fillStyleId" | "strokeStyleId"> = {
  fills: "fillStyleId",
  strokes: "strokeStyleId",
};

/**
 * How `previous` is written: the dump form, so a hidden paint keeps its place
 * with `visible: false` and each paint keeps the variable it was bound to.
 */
const PREVIOUS_OPTIONS: SerializeOptions = { includeHidden: true, paintBindings: true };

/** One validated `clear_paints` item, ready to write. */
type ClearPlan = {
  node: SceneNode;
  target: PaintTarget;
};

/** One styled range of a text node whose fills differ per range. */
type PreviousSegment = {
  start: number;
  end: number;
  fills: SerializedPaint[];
};

/** What a node carried in the target list before it was cleared. */
type PreviousPaints = {
  previous: SerializedPaint[] | "mixed";
  previousCount: number;
  previousStyleId: string | null;
  previousSegments?: PreviousSegment[];
};

/**
 * Reads the `target` parameter.
 * @param params - The request params.
 * @param tool - The tool name, for the error messages.
 * @returns The paint list to clear; fills when the parameter is absent.
 */
const readTarget = (params: Record<string, unknown>, tool: string): PaintTarget => {
  const raw = readOptionalString(params, "target", tool);
  if (raw === undefined) return "fills";
  const match = PAINT_TARGETS.find((target) => target === raw);
  if (match) return match;
  throw new Error(
    `${tool} requires target to be one of ${PAINT_TARGETS.join(", ")}, received "${raw}". Pass "fills" to clear the fills, or "strokes" to clear the strokes.`
  );
};

/**
 * Finds a node by ID on any page.
 *
 * Under `documentAccess: "dynamic-page"` a node on a page that is not loaded
 * is missing from `getNodeByIdAsync`, so the other pages are loaded one by one
 * until the ID resolves, as `getSceneNodeById` does. The result keeps the
 * document and the pages, which `getSceneNodeById` refuses, so the caller can
 * name them in its own error.
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
 * Reads the paint style link of a node.
 * @param node - The node.
 * @param target - Which paint list the style belongs to.
 * @returns The style ID, "mixed" when it differs per range, or null for none.
 */
const readStyleId = (node: SceneNode, target: PaintTarget): string | null => {
  const value = (node as unknown as Record<string, unknown>)[STYLE_ID_FIELDS[target]];
  if (isMixed(value)) return "mixed";
  return typeof value === "string" && value !== "" ? value : null;
};

/**
 * Records what a node carries in the target list, before the write.
 *
 * `previousCount` counts every paint, including the types the read form
 * leaves out, so `previous` can be shorter than it. For a text node whose
 * fills differ per range there is no single list: `previous` is "mixed",
 * `previousSegments` holds the fills of each range, and `previousCount` adds
 * up the paints of all ranges.
 * @param node - The node.
 * @param target - Which paint list to read.
 * @returns The record of the old list.
 */
const readPreviousPaints = (node: SceneNode, target: PaintTarget): PreviousPaints => {
  const raw = (node as unknown as Record<string, unknown>)[target];
  const previousStyleId = readStyleId(node, target);

  if (isMixed(raw)) {
    if (node.type !== "TEXT") {
      throw new Error(
        `the ${target} of ${node.id} "${node.name}" are mixed, but it is a ${node.type} node and only a text node mixes them per range. Nothing was written for it.`
      );
    }
    const segments = node.getStyledTextSegments(["fills"]);
    return {
      previous: "mixed",
      previousCount: segments.reduce(
        (total, segment) => total + (Array.isArray(segment.fills) ? segment.fills.length : 0),
        0
      ),
      previousStyleId,
      previousSegments: segments.map((segment) => ({
        start: segment.start,
        end: segment.end,
        fills: serializePaints(segment.fills, PREVIOUS_OPTIONS) as SerializedPaint[],
      })),
    };
  }

  return {
    previous: serializePaints(raw as readonly Paint[] | undefined, PREVIOUS_OPTIONS),
    previousCount: Array.isArray(raw) ? raw.length : 0,
    previousStyleId,
  };
};

/**
 * Sets the fills or the strokes of nodes to an empty list.
 *
 * Every node is examined before the first write. The write is one assignment
 * of an empty list per node: no other field changes, and an instance sublayer
 * gets an override while its instance stays an instance. Figma needs no font
 * for it, so no font is loaded, text nodes included.
 * @param req - The extension request.
 * @returns One result entry per node, with the paints it carried before.
 */
const clearPaints = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "clear_paints";
  const target = readTarget(req.params, tool);
  // The node IDs travel in the request's own `nodeIds` field, as they do for
  // the core tools that take a list of nodes, not among the params.
  const rawNodeIds = readBatchArray({ nodeIds: req.nodeIds }, "nodeIds", tool);
  const problems: string[] = [];
  const plans: ClearPlan[] = [];
  const seen = new Map<string, number>();

  for (let index = 0; index < rawNodeIds.length; index++) {
    const rawNodeId = rawNodeIds[index];
    const fail = (problem: string): void => {
      problems.push(`nodeIds[${index}]: ${problem}`);
    };

    if (typeof rawNodeId !== "string" || rawNodeId.trim() === "") {
      fail(
        `each item must be a node ID such as "4029:12345", received ${describeValue(rawNodeId)}. Call get_document or get_selection to list them.`
      );
      continue;
    }
    const earlier = seen.get(rawNodeId);
    if (earlier !== undefined) {
      fail(`${rawNodeId} repeats nodeIds[${earlier}]. Name each node once.`);
      continue;
    }
    seen.set(rawNodeId, index);

    const node = await findNodeById(rawNodeId);
    if (!node) {
      fail(
        `node not found: ${rawNodeId}. Call get_document or get_selection to list the node IDs of this page.`
      );
      continue;
    }
    if (node.type === "DOCUMENT") {
      fail(
        `${rawNodeId} is the document, which carries no ${target}. Pass the ID of a frame, a shape, or a text node.`
      );
      continue;
    }
    if (node.type === "PAGE") {
      fail(
        `${rawNodeId} "${node.name}" is a page. A page carries backgrounds, not ${target}, and ${tool} does not change them. Pass the ID of a node on the page.`
      );
      continue;
    }
    if (!(target in node)) {
      fail(
        `${rawNodeId} "${node.name}" is a ${node.type} node and carries no ${target}. ${tool} works on nodes that carry ${target}, such as frames, shapes, and text; remove it from nodeIds, or pass its children.`
      );
      continue;
    }
    plans.push({ node, target });
  }

  if (problems.length > 0) throw validationError(tool, problems);

  return runBatchWrites(plans, async (plan) => {
    const record = readPreviousPaints(plan.node, plan.target);
    (plan.node as unknown as Record<PaintTarget, Paint[]>)[plan.target] = [];
    return {
      nodeId: plan.node.id,
      nodeName: plan.node.name,
      target: plan.target,
      ...record,
      applied: true,
    };
  });
};

export const paintsHandlers = {
  clear_paints: { edit: true, run: clearPaints },
} satisfies Record<string, ExtensionHandler>;
