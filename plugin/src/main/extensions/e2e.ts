import { loadFontsForTextNode, pageOf, parseHexColor } from "../shared";
import {
  describeValue,
  describeWriteError,
  readOptionalBoolean,
  readRequiredString,
} from "./batch";
import type { ExtensionHandler, ExtensionRequest } from "./types";

/**
 * Test helper commands.
 *
 * `e2e_fixture` builds the parts of the dump-conformance fixture that no tool
 * writes: a hidden paint, a second paint, a reaction, a fill on a range of
 * characters, the flow starting points of a page, and the flag
 * `figma.skipInvisibleInstanceChildren`. Only the end-to-end script sends it,
 * with a raw `/rpc` request. No MCP tool has its name, and no role lists it,
 * so a marked request of the auditor process for it gets 403.
 *
 * Each operation on a node refuses a node outside the test page `MCP E2E`, or
 * under a top-level node whose name does not start with `mcp-e2e/`. Thus the
 * command writes nothing that the cleanup of the script does not remove.
 */

const TOOL = "e2e_fixture";

/** The one page each node operation may write on. */
const TEST_PAGE = "MCP E2E";

/** The prefix of each top-level node that a node operation may write under. */
const TEST_PREFIX = "mcp-e2e/";

type Params = Record<string, unknown>;

/**
 * Finds a node and refuses it unless it belongs to the test fixture.
 * @param params - The request params.
 * @returns The node.
 */
const findFixtureNode = async (params: Params): Promise<SceneNode> => {
  const nodeId = readRequiredString(params, "nodeId", TOOL);
  let node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    const page = figma.root.children.find((candidate) => candidate.name === TEST_PAGE);
    if (page) {
      await page.loadAsync();
      node = await figma.getNodeByIdAsync(nodeId);
    }
  }
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
    throw new Error(
      `found no scene node with the ID ${nodeId} for nodeId. Pass the ID of a node that the script made on the page "${TEST_PAGE}".`
    );
  }
  const page = pageOf(node);
  if (!page || page.name !== TEST_PAGE) {
    throw new Error(
      `refuses ${nodeId} "${node.name}": it is on the page "${page ? page.name : "none"}", not on "${TEST_PAGE}". This helper writes only to the test page.`
    );
  }
  let top: BaseNode = node;
  while (top.parent && top.parent.type !== "PAGE") top = top.parent;
  if (!top.name.startsWith(TEST_PREFIX)) {
    throw new Error(
      `refuses ${nodeId} "${node.name}": its top-level node ${top.id} "${top.name}" does not start with "${TEST_PREFIX}". This helper writes only under the nodes of the script.`
    );
  }
  return node as SceneNode;
};

/**
 * Reads `target` as the paint list of a node.
 * @param params - The request params.
 * @returns "fills" or "strokes".
 */
const readTarget = (params: Params): "fills" | "strokes" => {
  const target = params.target;
  if (target !== "fills" && target !== "strokes") {
    throw new Error(
      `requires target as "fills" or "strokes", received ${typeof target === "string" ? `"${target}"` : describeValue(target)}.`
    );
  }
  return target;
};

/**
 * Reads an integer of 0 or more.
 * @param params - The request params.
 * @param key - The parameter name.
 * @returns The value.
 */
const readIndex = (params: Params, key: string): number => {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `requires ${key} as an integer of 0 or more, received ${typeof value === "number" ? value : describeValue(value)}.`
    );
  }
  return value;
};

/**
 * Reads the paint list of a node.
 * @param node - The node.
 * @param target - "fills" or "strokes".
 * @returns The paints.
 */
const paintsOf = (node: SceneNode, target: "fills" | "strokes"): readonly Paint[] => {
  if (!(target in node)) {
    throw new Error(`refuses ${node.id} "${node.name}": a ${node.type} node has no ${target}.`);
  }
  const paints = (node as GeometryMixin)[target];
  if (typeof paints === "symbol") {
    throw new Error(
      `refuses ${node.id} "${node.name}": its ${target} are mixed. Pass a node with one paint list.`
    );
  }
  return paints;
};

/**
 * Writes the paint list of a node.
 * @param node - The node.
 * @param target - "fills" or "strokes".
 * @param paints - The new list.
 */
const setPaints = (node: SceneNode, target: "fills" | "strokes", paints: Paint[]): void => {
  try {
    (node as unknown as Record<"fills" | "strokes", Paint[]>)[target] = paints;
  } catch (err) {
    throw describeWriteError(`could not write the ${target} of ${node.id} "${node.name}"`, err);
  }
};

/**
 * Appends a solid paint: no tool gives a node a second paint.
 * @param params - `{ nodeId, target, hex }`.
 * @returns The node and the paint count after the write.
 */
const addPaint = async (params: Params): Promise<unknown> => {
  const node = await findFixtureNode(params);
  const target = readTarget(params);
  const color = parseHexColor(readRequiredString(params, "hex", TOOL));
  const paints = paintsOf(node, target);
  setPaints(node, target, [...paints, { type: "SOLID", color }]);
  return { nodeId: node.id, target, count: paints.length + 1 };
};

/**
 * Sets `visible: false` on one paint.
 * @param params - `{ nodeId, target, index }`.
 * @returns The node and the index of the hidden paint.
 */
const hidePaint = async (params: Params): Promise<unknown> => {
  const node = await findFixtureNode(params);
  const target = readTarget(params);
  const index = readIndex(params, "index");
  const paints = paintsOf(node, target);
  if (index >= paints.length) {
    throw new Error(
      `requires index below ${paints.length}: ${node.id} "${node.name}" has ${paints.length} ${target}, received ${index}.`
    );
  }
  setPaints(
    node,
    target,
    paints.map((paint, at) => (at === index ? { ...paint, visible: false } : paint))
  );
  return { nodeId: node.id, target, index };
};

/**
 * Sets the reactions of a node.
 * @param params - `{ nodeId, reactions }`.
 * @returns The node and the reaction count.
 */
const setReactions = async (params: Params): Promise<unknown> => {
  const node = await findFixtureNode(params);
  const reactions = params.reactions;
  if (!Array.isArray(reactions)) {
    throw new Error(`requires reactions as an array, received ${describeValue(reactions)}.`);
  }
  if (!("setReactionsAsync" in node)) {
    throw new Error(`refuses ${node.id} "${node.name}": a ${node.type} node takes no reactions.`);
  }
  try {
    await node.setReactionsAsync(reactions as Reaction[]);
  } catch (err) {
    throw describeWriteError(`could not set the reactions of ${node.id} "${node.name}"`, err);
  }
  return { nodeId: node.id, count: node.reactions.length };
};

/**
 * Sets a solid fill on a range of characters.
 * @param params - `{ nodeId, start, end, hex }`.
 * @returns The node and the range.
 */
const setRangeFill = async (params: Params): Promise<unknown> => {
  const node = await findFixtureNode(params);
  if (node.type !== "TEXT") {
    throw new Error(`refuses ${node.id} "${node.name}": it is a ${node.type} node, not TEXT.`);
  }
  const start = readIndex(params, "start");
  const end = readIndex(params, "end");
  const color = parseHexColor(readRequiredString(params, "hex", TOOL));
  if (end <= start || end > node.characters.length) {
    throw new Error(
      `requires 0 <= start < end <= ${node.characters.length}, the length of ${node.id} "${node.name}", received start ${start} and end ${end}.`
    );
  }
  await loadFontsForTextNode(node);
  try {
    node.setRangeFills(start, end, [{ type: "SOLID", color }]);
  } catch (err) {
    throw describeWriteError(`could not fill ${start} to ${end} of ${node.id} "${node.name}"`, err);
  }
  return { nodeId: node.id, start, end };
};

/**
 * Reads the flag that hides the invisible children of instances.
 * @returns `{ value }`.
 */
const getSkipInvisibleInstanceChildren = async (): Promise<unknown> => ({
  value: figma.skipInvisibleInstanceChildren,
});

/**
 * Sets the flag that hides the invisible children of instances.
 * @param params - `{ value }`.
 * @returns `{ previous, value }`.
 */
const setSkipInvisibleInstanceChildren = async (params: Params): Promise<unknown> => {
  const value = readOptionalBoolean(params, "value", TOOL);
  if (value === undefined) throw new Error("requires value as true or false.");
  const previous = figma.skipInvisibleInstanceChildren;
  figma.skipInvisibleInstanceChildren = value;
  return { previous, value };
};

/**
 * Sets the flow starting points of the test page.
 * @param params - `{ pageId, points }`, each point `{ nodeId, name }`.
 * @returns `{ previous, points }`, each as `{ nodeId, name }`.
 */
const setFlowStartingPoints = async (params: Params): Promise<unknown> => {
  const pageId = readRequiredString(params, "pageId", TOOL);
  const page = figma.root.children.find((candidate) => candidate.id === pageId);
  if (!page) {
    throw new Error(`found no page with the ID ${pageId} for pageId. Call get_metadata.`);
  }
  if (page.name !== TEST_PAGE) {
    throw new Error(
      `refuses the page ${pageId} "${page.name}": this helper sets the flow starting points of "${TEST_PAGE}" only.`
    );
  }
  const raw = params.points;
  if (
    !Array.isArray(raw) ||
    !raw.every(
      (point) =>
        typeof point === "object" &&
        point !== null &&
        typeof (point as Params).nodeId === "string" &&
        typeof (point as Params).name === "string"
    )
  ) {
    throw new Error(
      `requires points as an array of { nodeId, name }, received ${describeValue(raw)}.`
    );
  }
  const points = (raw as Params[]).map((point) => ({
    nodeId: point.nodeId as string,
    name: point.name as string,
  }));
  await page.loadAsync();
  const copy = (list: PageNode["flowStartingPoints"]) =>
    list.map((point) => ({ nodeId: point.nodeId, name: point.name }));
  const previous = copy(page.flowStartingPoints);
  try {
    page.flowStartingPoints = points;
  } catch (err) {
    throw describeWriteError(`could not set the flow starting points of "${page.name}"`, err);
  }
  return { previous, points: copy(page.flowStartingPoints) };
};

/** A map, not an object: `op` must not reach a key of `Object.prototype`. */
const OPERATIONS = new Map<string, (params: Params) => Promise<unknown>>([
  ["addPaint", addPaint],
  ["hidePaint", hidePaint],
  ["setReactions", setReactions],
  ["setRangeFill", setRangeFill],
  ["getSkipInvisibleInstanceChildren", getSkipInvisibleInstanceChildren],
  ["setSkipInvisibleInstanceChildren", setSkipInvisibleInstanceChildren],
  ["setFlowStartingPoints", setFlowStartingPoints],
]);

/**
 * Runs the operation that `op` names.
 * @param req - The extension request.
 * @returns What the operation returns.
 */
const e2eFixture = async (req: ExtensionRequest): Promise<unknown> => {
  const op = req.params.op;
  const run = typeof op === "string" ? OPERATIONS.get(op) : undefined;
  if (!run) {
    throw new Error(
      `requires op as one of ${[...OPERATIONS.keys()].join(", ")}, received ${typeof op === "string" ? `"${op}"` : describeValue(op)}.`
    );
  }
  return run(req.params);
};

export const e2eHandlers = {
  e2e_fixture: { edit: true, run: e2eFixture },
} satisfies Record<string, ExtensionHandler>;
