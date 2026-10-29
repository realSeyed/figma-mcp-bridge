/**
 * The budgeted reads: `get_node` with `depth` or `detail`, `get_document`,
 * `get_selection`, and `get_design_context`.
 *
 * Each one walks its tree one time, in one of two details: `full`, the form of
 * `serializeSelf`, and `outline`, the id, the name, the type, the bounds, and
 * the start of the text. The walk stops a branch at `depth`, and stops adding
 * nodes when the budget runs out. A node it stopped at reports `childCount`,
 * the visible children it has, beside the `children` it carries.
 *
 * A read that fits comes back as the walk made it, with no mark. A read that
 * was cut carries `truncated` and `note`. The default `get_node` keeps its own
 * path, `serializeNodeWithinBudget`, so its output stays byte for byte.
 */

import { getBounds, MAX_NODE_RESULT_CHARS, serializeSelf, visibleChildrenOf } from "./serializer";
import type { SerializableNode, SerializedNode } from "./serializer";

export type ReadDetail = "full" | "outline";

export type ReadOptions = {
  /** The levels below the root to list; 0 lists the root only. No limit when absent. */
  depth?: number;
  detail?: ReadDetail;
};

/**
 * Reads `depth` and `detail` from the params of a request. The server checks
 * both, so a value of another form is ignored here.
 * @param params - The params of the request.
 * @returns The options.
 */
export const readOptionsOf = (params: Record<string, unknown> | undefined): ReadOptions => {
  const options: ReadOptions = {};
  const depth = params?.depth;
  if (typeof depth === "number" && Number.isInteger(depth) && depth >= 0) options.depth = depth;
  if (params?.detail === "full" || params?.detail === "outline") options.detail = params.detail;
  return options;
};

/** The most characters of text that an outline node carries. */
const OUTLINE_TEXT_CHARS = 80;

/**
 * The start of a text, cut at `max` characters with "…" when it is longer.
 * @param text - The text.
 * @param max - The most characters to keep.
 * @returns The text, or its start.
 */
export const clipText = (text: string, max = OUTLINE_TEXT_CHARS): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * One node in the outline detail, without its children.
 * @param node - The node.
 * @returns `{ id, name, type, bounds, characters? }`.
 */
const outlineSelf = (node: SerializableNode): SerializedNode => {
  const self: SerializedNode = { id: node.id, name: node.name, type: node.type };
  const bounds = getBounds(node);
  if (bounds) self.bounds = bounds;
  if (node.type === "TEXT") self.characters = clipText(node.characters);
  return self;
};

/**
 * The note of a cut read.
 * @param budget - The budget of the read.
 * @returns The note.
 */
export const cutNote = (budget: number): string =>
  `The result is larger than ${budget} characters, so it was cut where the budget ran out. A node whose childCount is higher than the children it carries has that many more: call get_node on it with depth and detail: "outline", or find_nodes, to read them.`;

/** What one walk over a list of roots made. */
export type Walked = {
  /** One node for each root, in order. */
  nodes: SerializedNode[];
  /** For each root, whether the budget cut its subtree or left it out. */
  cut: boolean[];
};

/**
 * Walks each root, in order, until `allowance` characters are spent. A root
 * that the budget reaches before its walk starts becomes a stub: `{ id, name,
 * type, childCount, truncated: true }`. The first root always gets its walk.
 * @param roots - The roots.
 * @param options - The depth and the detail.
 * @param allowance - The characters that the nodes may spend.
 * @returns The nodes and the cut of each root.
 */
const walkRoots = (
  roots: readonly SerializableNode[],
  options: ReadOptions,
  allowance: number
): Walked => {
  const detail = options.detail ?? "full";
  let spent = 0;
  let cutHere = false;

  const walk = (node: SerializableNode, level: number): SerializedNode => {
    const self = detail === "outline" ? outlineSelf(node) : serializeSelf(node);
    spent += JSON.stringify(self).length;

    const visible = visibleChildrenOf(node);
    if (visible.length === 0) return self;
    if (options.depth !== undefined && level >= options.depth) {
      return { ...self, childCount: visible.length };
    }

    const kept: SerializedNode[] = [];
    for (const child of visible) {
      if (spent >= allowance) {
        cutHere = true;
        break;
      }
      kept.push(walk(child, level + 1));
    }
    if (kept.length === 0) return { ...self, childCount: visible.length };
    if (kept.length < visible.length) {
      return { ...self, children: kept, childCount: visible.length };
    }
    return { ...self, children: kept };
  };

  const nodes: SerializedNode[] = [];
  const cut: boolean[] = [];
  roots.forEach((root, index) => {
    if (index > 0 && spent >= allowance) {
      const stub: SerializedNode = {
        id: root.id,
        name: root.name,
        type: root.type,
        childCount: visibleChildrenOf(root).length,
        truncated: true,
      };
      spent += JSON.stringify(stub).length;
      nodes.push(stub);
      cut.push(true);
      return;
    }
    cutHere = false;
    nodes.push(walk(root, 0));
    cut.push(cutHere);
  });
  return { nodes, cut };
};

/**
 * Reads a list of roots within a budget, and shapes the result.
 *
 * The walk counts each node on its own, so the commas and the brackets that
 * hold them, and what `shape` adds, land on top of what it counted. Rather
 * than model that, the overshoot comes off the allowance and the walk runs
 * again: it converges in a step or two, as in `serializeNodeWithinBudget`. The
 * first walk already stops at the budget, so a large page is never serialized
 * whole.
 * @param roots - The roots.
 * @param options - The depth and the detail.
 * @param shape - Builds the result from the walk.
 * @param budget - The most characters of the result.
 * @returns The result of `shape`.
 */
export const readWithinBudget = <T>(
  roots: readonly SerializableNode[],
  options: ReadOptions,
  shape: (walked: Walked) => T,
  budget = MAX_NODE_RESULT_CHARS
): T => {
  let allowance = budget;
  let result = shape(walkRoots(roots, options, allowance));
  for (let attempt = 0; attempt < 8; attempt++) {
    const over = JSON.stringify(result).length - budget;
    if (over <= 0) break;
    allowance = Math.max(0, allowance - over - 64);
    result = shape(walkRoots(roots, options, allowance));
  }
  return result;
};

/**
 * Reads one node within the budget, marked `truncated` with the note when it
 * was cut: the read of `get_node` with options, and of `get_document`.
 * @param node - The node.
 * @param options - The depth and the detail.
 * @param budget - The most characters of the result.
 * @returns The node.
 */
export const readNode = (
  node: SerializableNode,
  options: ReadOptions,
  budget = MAX_NODE_RESULT_CHARS
): SerializedNode =>
  readWithinBudget(
    [node],
    options,
    ({ nodes, cut }) =>
      cut[0] ? { ...nodes[0], truncated: true, note: cutNote(budget) } : nodes[0],
    budget
  );

/**
 * Reads the selection within one budget: the read of `get_selection`. A node
 * that the budget cut carries `truncated`, and the first one also the note.
 * @param nodes - The selected nodes.
 * @param options - The depth and the detail.
 * @param budget - The most characters of the result.
 * @returns One node for each selected node.
 */
export const readNodes = (
  nodes: readonly SerializableNode[],
  options: ReadOptions,
  budget = MAX_NODE_RESULT_CHARS
): SerializedNode[] =>
  readWithinBudget(
    nodes,
    options,
    ({ nodes: read, cut }) => {
      let noted = false;
      return read.map((node, index) => {
        if (!cut[index]) return node;
        const marked: SerializedNode = { ...node, truncated: true };
        if (!noted) {
          marked.note = cutNote(budget);
          noted = true;
        }
        return marked;
      });
    },
    budget
  );
