/**
 * The dump form of a node: what `dump_nodes` writes to disk for one node.
 *
 * It is the `serializeNode` form of the node without `children`, plus what a
 * read tool leaves out. Each addition is additive: a field that `get_node`
 * writes holds the same value here, and a field left out still holds its
 * default. No character budget applies.
 *
 * With `includeHidden`, a dump keeps what the read tools drop: each hidden
 * child (its `styles.visible` is false, as in a read), and each hidden paint
 * and effect, marked `visible: false`. Without it, the paints and effects are
 * those of a read, and such a dump is not audit evidence.
 *
 * The added fields, each written only when it has a value:
 *
 * - `mainComponentId` on each instance (null when Figma returns none), and
 *   `componentSetId` when the main component is a variant of a set;
 * - `detachedInfo`, as Figma gives it;
 * - `reactions`, as plain JSON with the field names and the order of Figma;
 * - `flowStartingPoints` on a page;
 * - `styledTextSegments` on a text node whose style is mixed;
 * - `boundVariables` inside a paint, from the own bindings of the paint.
 *
 * Each list keeps the order of Figma. Nothing is sorted.
 */

import {
  isMixed,
  serializeLetterSpacing,
  serializeLineHeight,
  serializePaints,
  serializeSelf,
  visibleChildrenOf,
} from "./serializer";
import type {
  SerializableNode,
  SerializedNode,
  SerializedPaint,
  SerializeOptions,
} from "./serializer";

export type DumpOptions = {
  /** Keep each hidden child, paint, and effect. */
  includeHidden: boolean;
};

/** One run of characters that share each field of `SEGMENT_FIELDS`. */
export type DumpedTextSegment = {
  start: number;
  end: number;
  characters: string;
  fills: SerializedPaint[];
  textStyleId: string;
  fillStyleId: string;
  fontName: { family: string; style: string };
  fontSize: number;
  fontWeight: number;
  textDecoration: string;
  lineHeight: ReturnType<typeof serializeLineHeight>;
  letterSpacing: ReturnType<typeof serializeLetterSpacing>;
};

export type DumpedNode = Omit<SerializedNode, "children" | "childCount" | "truncated" | "note"> & {
  mainComponentId?: string | null;
  componentSetId?: string;
  detachedInfo?: DetachedInfo;
  reactions?: unknown[];
  flowStartingPoints?: { nodeId: string; name: string }[];
  styledTextSegments?: DumpedTextSegment[];
};

/**
 * The text fields whose mix the segments resolve. A text node gets segments
 * when at least one of them is mixed, and each segment carries all of them.
 */
const SEGMENT_FIELDS = [
  "fills",
  "textStyleId",
  "fillStyleId",
  "fontName",
  "fontSize",
  "fontWeight",
  "textDecoration",
  "lineHeight",
  "letterSpacing",
] as const;

/**
 * The serializer options of a dump.
 * @param options - The dump options.
 * @returns The options for each node, paint, and effect.
 */
const serializeOptionsOf = (options: DumpOptions): SerializeOptions => ({
  includeHidden: options.includeHidden,
  paintBindings: true,
});

/**
 * The children a dump walks: each child with `includeHidden`, the visible
 * ones without it, as the read tools give them.
 * @param node - The node.
 * @param options - The dump options.
 * @returns The children, in the order of Figma; empty when the node takes none.
 */
export const dumpChildrenOf = (
  node: SerializableNode,
  options: DumpOptions
): readonly SceneNode[] => {
  if (!options.includeHidden) return visibleChildrenOf(node);
  return "children" in node ? node.children : [];
};

/**
 * Reads the styled segments of a text node whose style is mixed.
 * @param node - The text node.
 * @param options - The dump options.
 * @returns The segments, or undefined when no field of `SEGMENT_FIELDS` is mixed.
 */
const styledTextSegmentsOf = (
  node: TextNode,
  options: DumpOptions
): DumpedTextSegment[] | undefined => {
  if (!SEGMENT_FIELDS.some((field) => isMixed(node[field]))) return undefined;
  const serializeOptions = serializeOptionsOf(options);
  return node.getStyledTextSegments([...SEGMENT_FIELDS]).map((segment) => ({
    start: segment.start,
    end: segment.end,
    characters: segment.characters,
    // A segment holds one value of each field, so its fills are never mixed.
    fills: serializePaints(segment.fills, serializeOptions) as SerializedPaint[],
    textStyleId: segment.textStyleId,
    fillStyleId: segment.fillStyleId,
    fontName: { family: segment.fontName.family, style: segment.fontName.style },
    fontSize: segment.fontSize,
    fontWeight: segment.fontWeight,
    textDecoration: segment.textDecoration,
    lineHeight: serializeLineHeight(segment.lineHeight),
    letterSpacing: serializeLetterSpacing(segment.letterSpacing),
  }));
};

/**
 * Copies `detachedInfo` field by field, in the two shapes Figma gives.
 * @param info - The detached info of the node.
 * @returns A plain copy.
 */
const copyDetachedInfo = (info: DetachedInfo): DetachedInfo =>
  info.type === "local"
    ? { type: "local", componentId: info.componentId }
    : { type: "library", componentKey: info.componentKey };

/**
 * Serializes one node in the dump form, without its children.
 *
 * Async because the main component of an instance is read with
 * `getMainComponentAsync`: `mainComponent` cannot be read under
 * `documentAccess: "dynamic-page"`.
 * @param node - The node.
 * @param options - The dump options.
 * @returns The dump form of the node.
 */
export const dumpNodeSelf = async (
  node: SerializableNode,
  options: DumpOptions
): Promise<DumpedNode> => {
  const dumped: DumpedNode = serializeSelf(node, serializeOptionsOf(options));

  if (node.type === "INSTANCE") {
    const main = await node.getMainComponentAsync();
    dumped.mainComponentId = main ? main.id : null;
    const holder = main ? main.parent : null;
    if (holder && holder.type === "COMPONENT_SET") dumped.componentSetId = holder.id;
  }

  if ("detachedInfo" in node && node.detachedInfo) {
    dumped.detachedInfo = copyDetachedInfo(node.detachedInfo);
  }

  if ("reactions" in node && node.reactions.length > 0) {
    // A JSON round trip keeps the field names and the key order of Figma, and
    // drops nothing that JSON can hold.
    dumped.reactions = JSON.parse(JSON.stringify(node.reactions)) as unknown[];
  }

  if (node.type === "PAGE" && node.flowStartingPoints.length > 0) {
    dumped.flowStartingPoints = node.flowStartingPoints.map((point) => ({
      nodeId: point.nodeId,
      name: point.name,
    }));
  }

  if (node.type === "TEXT") {
    const segments = styledTextSegmentsOf(node, options);
    if (segments) dumped.styledTextSegments = segments;
  }

  return dumped;
};
