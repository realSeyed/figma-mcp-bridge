/**
 * A synthetic node tree, and a `dump_nodes_chunk` handler that walks it with
 * the protocol of the plugin: pre-order records of `{ depth, childCount, node }`,
 * a child-index cursor, and `nextCursor: null` at the end.
 *
 * The nodes are made up for the tests. Their keys are not in sorted order, so
 * a dump file shows that the server sorts them.
 */

import type { PluginHandler, PluginRequest } from "./plugin.js";

export interface TreeNode {
  id: string;
  name: string;
  type: string;
  children?: TreeNode[];
  [field: string]: unknown;
}

/** A node with the given fields; `hidden` sets `styles.visible: false`, as the plugin marks it. */
function node(
  type: string,
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
  children?: TreeNode[],
  hidden = false
): TreeNode {
  const styles: Record<string, unknown> = { ...((extra.styles as object) ?? {}) };
  if (hidden) styles.visible = false;
  const made: TreeNode = {
    type,
    name,
    id,
    bounds: { y: 0, x: 0, width: 10, height: 10 },
    ...extra,
    styles,
  };
  if (children) made.children = children;
  return made;
}

const text = (id: string, name: string, characters: string, hidden = false): TreeNode =>
  node(
    "TEXT",
    id,
    name,
    { characters, styles: { fontSize: 14, fontFamily: "Inter" } },
    undefined,
    hidden
  );

/**
 * A root frame of 30 nodes. Five of them are hidden: `1:4`, `1:10`,
 * `I1:12;1:13`, `1:21`, and `1:25`. The two component sets hold 3 and 2
 * variants, one of them hidden.
 */
export const SYNTHETIC_TREE: TreeNode = node(
  "FRAME",
  "1:1",
  "synthetic-root",
  { styles: { fills: [{ type: "SOLID", color: "#FFFFFF" }] } },
  [
    node("FRAME", "1:2", "synthetic-header", {}, [
      text("1:3", "synthetic-title", "Title"),
      node("RECTANGLE", "1:4", "synthetic-underline", {}, undefined, true),
    ]),
    node("COMPONENT_SET", "1:5", "synthetic-button-set", {}, [
      node("COMPONENT", "1:6", "Size=Small", {}, [text("1:7", "synthetic-label", "Small")]),
      node("COMPONENT", "1:8", "Size=Medium", {}, [text("1:9", "synthetic-label", "Medium")]),
      node("COMPONENT", "1:10", "Size=Large", {}, [text("1:11", "synthetic-label", "Large")], true),
    ]),
    node(
      "INSTANCE",
      "1:12",
      "synthetic-instance",
      { mainComponentId: "1:6", componentSetId: "1:5", componentProperties: { State: "Default" } },
      [
        text("I1:12;1:7", "synthetic-label", "Small"),
        node(
          "FRAME",
          "I1:12;1:13",
          "synthetic-icon-slot",
          {},
          [node("VECTOR", "I1:12;1:14", "synthetic-icon")],
          true
        ),
      ]
    ),
    node("FRAME", "1:15", "synthetic-cards", {}, [
      node("FRAME", "1:16", "synthetic-card-a", {}, [
        text("1:17", "synthetic-card-a-text", "A"),
        node("RECTANGLE", "1:18", "synthetic-card-a-box"),
      ]),
      node("FRAME", "1:19", "synthetic-card-b", {}, [
        text("1:20", "synthetic-card-b-text", "B"),
        node("ELLIPSE", "1:21", "synthetic-card-b-dot", {}, undefined, true),
      ]),
      node("COMPONENT_SET", "1:22", "synthetic-badge-set", {}, [
        node("COMPONENT", "1:23", "Tone=Info"),
        node("COMPONENT", "1:24", "Tone=Warn"),
      ]),
    ]),
    node(
      "GROUP",
      "1:25",
      "synthetic-decor",
      {},
      [
        node("RECTANGLE", "1:26", "synthetic-decor-a"),
        node("RECTANGLE", "1:27", "synthetic-decor-b"),
      ],
      true
    ),
    text("1:28", "synthetic-footer", 'Ünïcödé — ✓ 😀 "quoted" \\ end'),
    node("LINE", "1:29", "synthetic-divider", {
      reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "BACK" }] }],
    }),
  ]
);

/** Each node of a tree, in pre-order. */
export function allNodes(root: TreeNode): TreeNode[] {
  return [root, ...(root.children ?? []).flatMap(allNodes)];
}

const isHidden = (candidate: TreeNode): boolean =>
  (candidate.styles as { visible?: boolean } | undefined)?.visible === false;

interface Entry {
  path: number[];
  depth: number;
  childCount: number;
  node: Record<string, unknown>;
}

/** The pre-order walk of a subtree, as the plugin gives it. */
function walk(root: TreeNode, includeHidden: boolean): Entry[] {
  const entries: Entry[] = [];
  const visit = (current: TreeNode, path: number[]): void => {
    const children = (current.children ?? []).filter((child) => includeHidden || !isHidden(child));
    const { children: _children, ...self } = current;
    entries.push({ path, depth: path.length, childCount: children.length, node: self });
    children.forEach((child, index) => visit(child, [...path, index]));
  };
  visit(root, []);
  return entries;
}

/**
 * A `dump_nodes_chunk` handler over a tree.
 * @param tree - The tree; any node of it can be a root.
 * @returns The handler.
 */
export function chunker(tree: TreeNode): PluginHandler {
  return (request: PluginRequest) => {
    const params = request.params ?? {};
    const rootId = params.rootId as string;
    const root = allNodes(tree).find((candidate) => candidate.id === rootId);
    if (!root) throw new Error(`dump_nodes_chunk found no node with the ID ${rootId} for rootId.`);
    const entries = walk(root, params.includeHidden as boolean);
    const cursor = (params.cursor as number[] | null) ?? [];
    const start = entries.findIndex((entry) => entry.path.join(",") === cursor.join(","));
    if (start < 0) throw new Error("dump_nodes_chunk: the tree changed during the dump.");
    const maxNodes = params.maxNodes as number;
    const records = entries
      .slice(start, start + maxNodes)
      .map(({ depth, childCount, node: self }) => ({ depth, childCount, node: self }));
    const next = entries[start + maxNodes];
    return { rootId, records, nextCursor: next ? next.path : null };
  };
}

/** A fixed `get_variable_defs` answer. Its keys are not in sorted order. */
export const VARIABLE_DEFS = {
  collections: [
    {
      name: "synthetic-tokens",
      id: "VariableCollectionId:1:1",
      modes: [{ name: "Default", modeId: "1:0" }],
      defaultModeId: "1:0",
      variables: [
        {
          resolvedType: "COLOR",
          name: "color/brand",
          id: "VariableID:1:2",
          scopes: ["ALL_SCOPES"],
          valuesByMode: { "1:0": "#FF7755" },
        },
        {
          resolvedType: "FLOAT",
          name: "space/4",
          id: "VariableID:1:3",
          scopes: ["GAP"],
          valuesByMode: { "1:0": 16 },
          description: "",
        },
      ],
    },
  ],
};

/** A fixed `get_styles` answer. Its keys are not in sorted order. */
export const STYLES = {
  text: [
    {
      name: "synthetic/body",
      id: "S:abc,",
      fontSize: 14,
      fontName: { style: "Regular", family: "Inter" },
    },
  ],
  paint: [{ name: "synthetic/brand", id: "S:def,", paints: [{ type: "SOLID", color: "#FF7755" }] }],
  effect: [],
  grid: [],
};
