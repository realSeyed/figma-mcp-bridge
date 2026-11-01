/**
 * The layout fields the create and set tools share: where a node goes among
 * its parent's children, how it sizes and sits inside an auto-layout parent,
 * and the state a result reports back.
 *
 * Figma takes these fields in one order only. A child can FILL only once it is
 * in its auto-layout parent, a resize drops a text auto-resize set before it,
 * and Figma ignores the x and y of a child in an auto-layout flow. So every
 * create runs the same steps:
 *   1. validate everything, before the file is touched;
 *   2. create the node;
 *   3. name, resize, paints, corner radius, clip;
 *   4. the node's own auto layout;
 *   5. insert it into the parent, at `index` or on top;
 *   6. layoutPositioning;
 *   7. layoutSizingHorizontal and layoutSizingVertical;
 *   8. min and max sizes;
 *   9. text only: textAutoResize;
 *  10. x and y.
 * A failure after step 2 removes the node, so a refused create leaves nothing.
 */

import { getParentNodeById, pageOf, parseHexColor } from "./shared";

export const SIZING_MODES = ["FIXED", "HUG", "FILL"] as const;
export type SizingMode = (typeof SIZING_MODES)[number];

const POSITIONING_MODES = ["AUTO", "ABSOLUTE"] as const;
type PositioningMode = (typeof POSITIONING_MODES)[number];

const SIZE_LIMITS = ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const;
type SizeLimit = (typeof SIZE_LIMITS)[number];

/** The child-layout fields of a create or set call, and where the node goes in its parent. */
export type ChildLayout = {
  layoutSizingHorizontal?: SizingMode;
  layoutSizingVertical?: SizingMode;
  layoutPositioning?: PositioningMode;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** The position among the parent's children, 0 at the bottom of the stack. */
  index?: number;
};

/** What the layout rules need to know about the node a call writes. */
export type LayoutTarget = {
  /** The node type, as Figma names it. */
  type: string;
  /** Whether the node has auto layout once the call is done. */
  autoLayout: boolean;
  /** The parent the node sits in once the call is done. */
  parent: BaseNode | null;
  /** True when the caller named the parent; false when the node goes on the open page. */
  namedParent: boolean;
};

/**
 * Builds the single error a failed validation of a one-node tool returns.
 * @param tool - The tool name.
 * @param problems - One line per bad field.
 * @returns The error to throw.
 */
export const fieldError = (tool: string, problems: readonly string[]): Error =>
  new Error(
    `${tool} wrote nothing. Correct these fields and call it again:\n${problems.join("\n")}`
  );

/**
 * Whether a node has auto layout.
 * @param node - The node, or null.
 * @returns True for a frame-like node whose layoutMode is not NONE.
 */
export const hasAutoLayout = (node: BaseNode | null): boolean =>
  node !== null && "layoutMode" in node && node.layoutMode !== "NONE";

const isOneOf = <T extends string>(value: unknown, options: readonly T[]): value is T =>
  typeof value === "string" && (options as readonly string[]).includes(value);

/**
 * Reads the child-layout fields and `index` of a call.
 *
 * A null counts as absent, as it does in the extension tools: a client may
 * spell out a field it does not set.
 * @param params - The request params.
 * @param problems - Collects one line per bad field.
 * @returns The fields that were given.
 */
export const readChildLayout = (
  params: Record<string, unknown>,
  problems: string[]
): ChildLayout => {
  const layout: ChildLayout = {};
  for (const field of ["layoutSizingHorizontal", "layoutSizingVertical"] as const) {
    const value = params[field];
    if (value === undefined || value === null) continue;
    if (isOneOf(value, SIZING_MODES)) layout[field] = value;
    else
      problems.push(
        `${field} must be "FIXED", "HUG", or "FILL", received ${JSON.stringify(value)}.`
      );
  }
  const positioning = params.layoutPositioning;
  if (positioning !== undefined && positioning !== null) {
    if (isOneOf(positioning, POSITIONING_MODES)) layout.layoutPositioning = positioning;
    else
      problems.push(
        `layoutPositioning must be "AUTO" or "ABSOLUTE", received ${JSON.stringify(positioning)}.`
      );
  }
  for (const field of SIZE_LIMITS) {
    const value = params[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) layout[field] = value;
    else
      problems.push(`${field} must be a number of 0 or more, received ${JSON.stringify(value)}.`);
  }
  const index = params.index;
  if (index !== undefined && index !== null) {
    if (typeof index === "number" && Number.isInteger(index) && index >= 0) layout.index = index;
    else
      problems.push(
        `index must be a whole number of 0 or more, received ${JSON.stringify(index)}. 0 is the bottom of the parent's stack; a number past the top puts the node on top.`
      );
  }
  return layout;
};

/**
 * Names the parent a node goes into, for a message.
 * @param target - The node and its parent.
 * @returns A phrase such as `1:2 "Card"`.
 */
const describeParent = (target: LayoutTarget): string => {
  const parent = target.parent;
  if (!parent) return "no parent";
  return `${parent.id} "${parent.name}"`;
};

/**
 * The complaint about a field that needs a parent with auto layout.
 * @param field - The field and its value, as the caller wrote them.
 * @param target - The node and its parent.
 * @returns The sentence.
 */
const needsAutoLayoutParent = (field: string, target: LayoutTarget): string => {
  const parent = target.parent;
  if (!parent || parent.type === "PAGE") {
    const where = target.namedParent
      ? `the page ${describeParent(target)}`
      : "the page the user is viewing, since parentId is absent";
    return `${field} needs a parent with auto layout, but the node goes on ${where}. Pass the parentId of an auto-layout frame, or call set_auto_layout on the frame first.`;
  }
  if (!("layoutMode" in parent)) {
    return `${field} needs a parent with auto layout, and ${describeParent(target)} is a ${parent.type}, which has no auto layout. Put the node in an auto-layout frame instead.`;
  }
  return `${field} needs a parent with auto layout, and ${describeParent(target)} has none. Call set_auto_layout on ${parent.id} first.`;
};

/**
 * Checks the child-layout fields against Figma's rules, before any write.
 *
 * The rules come from the plugin typings: "HUG" is valid on auto-layout frames
 * and text nodes only, "FILL" on auto-layout children only, layoutPositioning
 * on direct children of auto-layout frames, and the min and max sizes on
 * auto-layout frames and their direct children. Figma throws on each of them,
 * so a call that breaks one would fail halfway through.
 * @param layout - The fields of the call.
 * @param target - The node and the parent it ends up in.
 * @param problems - Collects one line per broken rule.
 */
export const checkChildLayout = (
  layout: ChildLayout,
  target: LayoutTarget,
  problems: string[]
): void => {
  const inFlow = hasAutoLayout(target.parent);
  for (const field of ["layoutSizingHorizontal", "layoutSizingVertical"] as const) {
    const mode = layout[field];
    if (mode === "FILL" && !inFlow) {
      problems.push(needsAutoLayoutParent(`${field} "FILL"`, target));
    }
    if (mode === "HUG" && target.type !== "TEXT" && !target.autoLayout) {
      problems.push(
        `${field} "HUG" applies to an auto-layout frame or a TEXT node, and this ${target.type} has no auto layout. Give the frame a layoutMode, or use "FIXED".`
      );
    }
  }
  if (layout.layoutPositioning === "ABSOLUTE" && !inFlow) {
    problems.push(needsAutoLayoutParent(`layoutPositioning "ABSOLUTE"`, target));
  }
  if (!target.autoLayout && !inFlow) {
    for (const field of SIZE_LIMITS) {
      if (layout[field] === undefined) continue;
      problems.push(
        `${field} applies to an auto-layout frame or a direct child of one, and this ${target.type} is neither. Give it a layoutMode, or put it in an auto-layout frame.`
      );
    }
  }
};

/**
 * Resolves the parent of a create, before the node exists.
 * @param parentId - The parentId param, or undefined.
 * @param problems - Collects the complaint when the parent is unusable.
 * @returns The parent, the open page when parentId is absent, or undefined on a problem.
 */
export const findParent = async (
  parentId: unknown,
  problems: string[]
): Promise<(BaseNode & ChildrenMixin) | undefined> => {
  if (parentId === undefined || parentId === null) return figma.currentPage;
  if (typeof parentId !== "string" || parentId.trim() === "") {
    problems.push(
      `parentId must be a node ID such as "4029:12345", received ${JSON.stringify(parentId)}.`
    );
    return undefined;
  }
  try {
    return await getParentNodeById(parentId);
  } catch {
    problems.push(
      `parentId ${parentId} names no page, frame, group, component, or section that can hold children. Call get_document or find_nodes to look the parent up.`
    );
    return undefined;
  }
};

/**
 * Checks a colour param, before any write.
 * @param params - The request params.
 * @param field - The param name.
 * @param problems - Collects the complaint on a bad value.
 */
export const checkHex = (
  params: Record<string, unknown>,
  field: string,
  problems: string[]
): void => {
  const value = params[field];
  if (value === undefined || value === null) return;
  try {
    if (typeof value !== "string") throw new Error("not a string");
    parseHexColor(value);
  } catch {
    problems.push(
      `${field} must be a hex colour such as "#FFAA00", received ${JSON.stringify(value)}.`
    );
  }
};

/**
 * Puts a node into its parent: at `index`, clamped to the top of the stack, or
 * on top when there is no index. A node already in the parent moves in place.
 * @param node - The node.
 * @param parent - The parent.
 * @param index - The position among the parent's children, or undefined.
 */
export const placeInParent = (
  node: SceneNode,
  parent: BaseNode & ChildrenMixin,
  index: number | undefined
): void => {
  if (index === undefined) {
    parent.appendChild(node);
    return;
  }
  // Figma's insertChild throws past the end, so the index is clamped.
  const others = parent.children.filter((child) => child.id !== node.id).length;
  parent.insertChild(Math.min(index, others), node);
};

/**
 * Writes the child-layout fields, steps 6 to 8 of the order above.
 *
 * A FIXED or AUTO value where it does not apply is the state the node is
 * already in, so it is skipped instead of handed to Figma, which may throw.
 * @param node - The node, already in its parent.
 * @param layout - The fields to write.
 */
export const applyChildLayout = (node: SceneNode, layout: ChildLayout): void => {
  const inFlow = hasAutoLayout(node.parent);
  const sizes = inFlow || hasAutoLayout(node) || node.type === "TEXT";
  const writable = node as SceneNode & Record<string, unknown>;
  if (layout.layoutPositioning !== undefined && inFlow && "layoutPositioning" in node) {
    writable.layoutPositioning = layout.layoutPositioning;
  }
  for (const field of ["layoutSizingHorizontal", "layoutSizingVertical"] as const) {
    if (layout[field] !== undefined && sizes && field in node) writable[field] = layout[field];
  }
  for (const field of SIZE_LIMITS) {
    if (layout[field] !== undefined) writable[field] = layout[field];
  }
};

/**
 * Reads back the child-layout fields a call wrote.
 * @param node - The node.
 * @param layout - The fields of the call.
 * @param applied - Gets one entry per field written, with the node's value.
 */
export const readBackChildLayout = (
  node: SceneNode,
  layout: ChildLayout,
  applied: Record<string, unknown>
): void => {
  const readable = node as SceneNode & Record<string, unknown>;
  for (const field of [
    "layoutPositioning",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    ...SIZE_LIMITS,
  ] as const) {
    if (layout[field] !== undefined && field in node) applied[field] = readable[field];
  }
  if (layout.index !== undefined && node.parent) {
    applied.index = node.parent.children.indexOf(node);
  }
};

/**
 * The layout state a result reports, where it applies: the node's own
 * layoutMode, its sizing when it is an auto-layout frame, a text node, or an
 * auto-layout child, and its positioning when it is an auto-layout child.
 * @param node - The node.
 * @returns The fields.
 */
export const layoutState = (node: SceneNode): Record<string, unknown> => {
  const state: Record<string, unknown> = {};
  const readable = node as SceneNode & Record<string, unknown>;
  if ("layoutMode" in node) state.layoutMode = node.layoutMode;
  const inFlow = hasAutoLayout(node.parent);
  if ((inFlow || hasAutoLayout(node) || node.type === "TEXT") && "layoutSizingHorizontal" in node) {
    state.layoutSizingHorizontal = readable.layoutSizingHorizontal;
    state.layoutSizingVertical = readable.layoutSizingVertical;
  }
  if (inFlow && "layoutPositioning" in node) state.layoutPositioning = readable.layoutPositioning;
  return state;
};

/**
 * The result of a create: where the node went and the state it ended in.
 * @param node - The new node.
 * @param extra - The fields only this create reports.
 * @returns The result.
 */
export const describeCreated = (
  node: SceneNode,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => {
  const parent = node.parent;
  return {
    nodeId: node.id,
    nodeName: node.name,
    type: node.type,
    parentId: parent?.id,
    pageId: pageOf(node)?.id,
    index: parent && "children" in parent ? parent.children.indexOf(node) : undefined,
    x: "x" in node ? node.x : undefined,
    y: "y" in node ? node.y : undefined,
    width: "width" in node ? node.width : undefined,
    height: "height" in node ? node.height : undefined,
    ...layoutState(node),
    ...extra,
  };
};

/**
 * Runs the steps after a create, and removes the node when one fails, so a
 * refused call leaves nothing on the page and a retry does not duplicate it.
 * @param node - The new node.
 * @param steps - Everything after the create.
 * @returns What the steps return.
 */
export const finishOrRemove = async <T>(
  node: SceneNode,
  steps: () => Promise<T> | T
): Promise<T> => {
  try {
    return await steps();
  } catch (err) {
    try {
      if (!node.removed) node.remove();
    } catch {
      // Already gone, or Figma refuses; the first failure is what matters.
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message.replace(/\.$/, "")}. The new node was removed, so nothing was left in the file.`
    );
  }
};

/**
 * Writes a frame's own auto layout from the params of `set_auto_layout` or
 * `create_frame`, and reads each written field back from the node.
 *
 * layoutMode goes first and layoutWrap next: Figma takes WRAP on a horizontal
 * frame only, and the spacing between wrapped rows applies to a wrapping one.
 * `padding` sets the four sides; a side param wins over it.
 * @param frame - The frame.
 * @param params - The request params.
 * @param applied - Gets one entry per field written, with the node's value.
 */
export const applyAutoLayout = (
  frame: FrameNode,
  params: Record<string, unknown>,
  applied: Record<string, unknown>
): void => {
  const writable = frame as FrameNode & Record<string, unknown>;
  const write = (field: string, value: unknown): void => {
    writable[field] = value;
    applied[field] = writable[field];
  };

  if (isOneOf(params.layoutMode, ["NONE", "HORIZONTAL", "VERTICAL"]))
    write("layoutMode", params.layoutMode);
  if (isOneOf(params.layoutWrap, ["NO_WRAP", "WRAP"])) write("layoutWrap", params.layoutWrap);
  if (typeof params.itemSpacing === "number") write("itemSpacing", params.itemSpacing);
  if (typeof params.counterAxisSpacing === "number") {
    write("counterAxisSpacing", params.counterAxisSpacing);
  }
  for (const side of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const) {
    const value = typeof params[side] === "number" ? params[side] : params.padding;
    if (typeof value === "number") write(side, value);
  }
  if (isOneOf(params.primaryAxisAlignItems, ["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])) {
    write("primaryAxisAlignItems", params.primaryAxisAlignItems);
  }
  if (isOneOf(params.counterAxisAlignItems, ["MIN", "MAX", "CENTER", "BASELINE"])) {
    write("counterAxisAlignItems", params.counterAxisAlignItems);
  }
  if (isOneOf(params.primaryAxisSizingMode, ["FIXED", "AUTO"])) {
    write("primaryAxisSizingMode", params.primaryAxisSizingMode);
  }
  if (isOneOf(params.counterAxisSizingMode, ["FIXED", "AUTO"])) {
    write("counterAxisSizingMode", params.counterAxisSizingMode);
  }
};
