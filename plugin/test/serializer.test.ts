/**
 * The guard of the read tools: fixes the output of `serializeNode` and of
 * `serializeNodeWithinBudget` on the synthetic guard page.
 *
 * `get_node`, `get_document`, `get_selection`, and `get_design_context` hand
 * this output to their callers, and later reads are compared with reads made
 * before the dump work. So the comparison is on the JSON text, byte for byte:
 * the key order and each field left out at its default count, not only the
 * values. Do not change an expected value to make a serializer change pass.
 */

import { describe, expect, test } from "bun:test";
import { serializeNode, serializeNodeWithinBudget } from "../src/main/serializer";
import type { SerializableNode } from "../src/main/serializer";
import { autoLayoutCard, findFake, guardPage } from "./helpers/nodes";

const asNode = (fake: unknown): SerializableNode => fake as SerializableNode;
const guardNode = (id: string): SerializableNode => asNode(findFake(guardPage(), id));

/** Compares the JSON text, so the key order and the left-out fields count. */
const expectJson = (actual: unknown, expected: unknown): void => {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
};

const CARD_SELF = {
  id: "1:2",
  name: "Card",
  type: "FRAME",
  bounds: { x: 10, y: 20, width: 320, height: 200 },
  styles: {
    fills: [{ type: "SOLID", color: "#ffffff" }],
    cornerRadius: 12,
    autoLayout: {
      direction: "VERTICAL",
      gap: 8,
      primaryAxisAlign: "MIN",
      counterAxisAlign: "MIN",
      primaryAxisSizing: "AUTO",
      counterAxisSizing: "AUTO",
      wrap: "NO_WRAP",
      counterAxisSpacing: 0,
    },
    padding: { top: 16, right: 16, bottom: 16, left: 16 },
    clipsContent: true,
  },
};

const VISIBLE_CHILD = {
  id: "1:3",
  name: "Visible child",
  type: "RECTANGLE",
  bounds: { x: 0, y: 0, width: 40, height: 40 },
  styles: {},
};

/** The hidden child `1:4` is left out, and so are the reactions and detachedInfo. */
const CARD = { ...CARD_SELF, children: [VISIBLE_CHILD] };

/** The hidden fill and the only stroke, which is hidden, are left out. */
const PAINTS = {
  id: "1:5",
  name: "Paints",
  type: "RECTANGLE",
  bounds: { x: 400, y: 0, width: 100, height: 100 },
  styles: {
    fills: [
      { type: "SOLID", color: "#0000ff", opacity: 0.5 },
      {
        type: "GRADIENT_LINEAR",
        gradientStops: [
          { color: "#ffffff", opacity: 1, position: 0 },
          { color: "#000000", opacity: 0.5, position: 1 },
        ],
        gradientTransform: [
          [1, 0, 0],
          [0, 1, 0],
        ],
        opacity: 1,
      },
    ],
    strokeWeight: 2,
  },
  boundVariables: { fills: ["VariableID:9:1"] },
};

const EFFECTS = {
  id: "1:6",
  name: "Effects",
  type: "RECTANGLE",
  bounds: { x: 520, y: 0, width: 100, height: 100 },
  styles: { effects: [{ type: "LAYER_BLUR", radius: 4 }] },
};

/** The quirk to keep: one hidden effect gives an empty list, not no list. */
const ALL_EFFECTS_HIDDEN = {
  id: "1:7",
  name: "All effects hidden",
  type: "RECTANGLE",
  bounds: { x: 640, y: 0, width: 100, height: 100 },
  styles: { effects: [] },
};

/** No main component and no set: get_node reads no async field. */
const BUTTON = {
  id: "1:8",
  name: "Button",
  type: "INSTANCE",
  bounds: { x: 760, y: 0, width: 120, height: 40 },
  styles: {},
  componentProperties: { "Label#1:0": "Go", "Icon#2:0": true, Variant: "Primary" },
};

/** No styled segments: the mixed fields read "mixed". */
const MIXED_TEXT = {
  id: "1:9",
  name: "Mixed text",
  type: "TEXT",
  bounds: { x: 10, y: 300, width: 100, height: 100 },
  styles: {
    fills: [{ type: "SOLID", color: "#000000" }],
    fontSize: 16,
    fontFamily: "mixed",
    fontStyle: "mixed",
    fontWeight: "mixed",
    textDecoration: "mixed",
    lineHeight: { unit: "AUTO" },
    letterSpacing: { value: 0, unit: "PERCENT" },
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
    textAutoResize: "WIDTH_AND_HEIGHT",
  },
  characters: "Hello world",
  textStyleId: "mixed",
};

const SECTION = {
  id: "1:10",
  name: "Section",
  type: "SECTION",
  bounds: { x: 0, y: 600, width: 800, height: 400 },
  styles: { fills: [{ type: "SOLID", color: "#ffffff" }] },
  sectionContentsHidden: true,
  children: [
    {
      id: "1:11",
      name: "Inside",
      type: "FRAME",
      bounds: { x: 80, y: 80, width: 100, height: 100 },
      styles: {},
    },
  ],
};

/** A page has no bounds and no style field; its flow starting points are left out. */
const PAGE_SELF = { id: "1:1", name: "Guard page", type: "PAGE", styles: {} };

const PAGE = {
  ...PAGE_SELF,
  children: [CARD, PAINTS, EFFECTS, ALL_EFFECTS_HIDDEN, BUTTON, MIXED_TEXT, SECTION],
};

const budgetNote = (budget: number): string =>
  `The subtree is larger than ${budget} characters, so it was cut where the budget ran out. A node whose childCount is higher than the children it carries has that many more: call get_node on it, or get_design_context with depth, to read them.`;

describe("serializeNode", () => {
  test("a frame keeps its visible child and leaves out its hidden child", () => {
    expectJson(serializeNode(guardNode("1:2")), CARD);
  });

  test("a hidden paint is left out, and a list of hidden paints too", () => {
    expectJson(serializeNode(guardNode("1:5")), PAINTS);
  });

  test("a hidden effect is left out", () => {
    expectJson(serializeNode(guardNode("1:6")), EFFECTS);
  });

  test("a node whose effects are all hidden reports an empty list", () => {
    expectJson(serializeNode(guardNode("1:7")), ALL_EFFECTS_HIDDEN);
  });

  test("an instance reports its component properties", () => {
    expectJson(serializeNode(guardNode("1:8")), BUTTON);
  });

  test("a text node with a mixed text style reports the mixed fields", () => {
    expectJson(serializeNode(guardNode("1:9")), MIXED_TEXT);
  });

  test("a section reports that its contents are hidden, and its children", () => {
    expectJson(serializeNode(guardNode("1:10")), SECTION);
  });

  test("the page holds each case in order", () => {
    expectJson(serializeNode(asNode(guardPage())), PAGE);
  });
});

describe("serializeNodeWithinBudget", () => {
  test("a tree that fits comes back as serializeNode gives it", () => {
    expectJson(serializeNodeWithinBudget(asNode(guardPage())), PAGE);
  });

  test("a cut inside a list keeps the children that fit and counts the rest", () => {
    expectJson(serializeNodeWithinBudget(asNode(guardPage()), 1500), {
      ...PAGE_SELF,
      children: [CARD, PAINTS],
      childCount: 7,
      truncated: true,
      note: budgetNote(1500),
    });
  });

  test("a cut before the first child of a node counts its children only", () => {
    expectJson(serializeNodeWithinBudget(asNode(guardPage()), 800), {
      ...PAGE_SELF,
      children: [{ ...CARD_SELF, childCount: 1 }],
      childCount: 7,
      truncated: true,
      note: budgetNote(800),
    });
  });
});

describe("the layout sizing of auto layout", () => {
  const layoutNode = (id: string): SerializableNode => asNode(findFake(autoLayoutCard(), id));
  const AUTO_LAYOUT = {
    direction: "VERTICAL",
    gap: 0,
    primaryAxisAlign: "MIN",
    counterAxisAlign: "MIN",
    primaryAxisSizing: "AUTO",
    counterAxisSizing: "AUTO",
    wrap: "NO_WRAP",
    counterAxisSpacing: 0,
  };
  const BOUNDS = { x: 0, y: 0, width: 100, height: 100 };

  test("an auto-layout frame reports how it sizes, and its min and max sizes", () => {
    expectJson(serializeNode(layoutNode("30:1")), {
      id: "30:1",
      name: "Responsive card",
      type: "FRAME",
      bounds: BOUNDS,
      styles: {
        autoLayout: AUTO_LAYOUT,
        layoutSizing: { horizontal: "HUG", vertical: "HUG" },
        minWidth: 200,
        maxWidth: 480,
      },
      children: [
        {
          id: "30:2",
          name: "Fill",
          type: "RECTANGLE",
          bounds: BOUNDS,
          styles: { layoutSizing: { horizontal: "FILL", vertical: "HUG" } },
        },
        { id: "30:3", name: "Fixed", type: "RECTANGLE", bounds: BOUNDS, styles: {} },
        {
          id: "30:4",
          name: "Badge",
          type: "RECTANGLE",
          bounds: BOUNDS,
          styles: { layoutPositioning: "ABSOLUTE" },
        },
      ],
    });
  });

  test("outside auto layout, the sizing fields are left out", () => {
    expectJson(serializeNode(layoutNode("30:5")), {
      id: "30:5",
      name: "Plain frame",
      type: "FRAME",
      bounds: BOUNDS,
      styles: {},
      children: [
        { id: "30:6", name: "Plain child", type: "RECTANGLE", bounds: BOUNDS, styles: {} },
      ],
    });
  });
});
