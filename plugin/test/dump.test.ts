/**
 * The dump form of a node: equal to the read form apart from the added
 * fields, with the hidden content kept and marked when `includeHidden` is set.
 */

import { describe, expect, test } from "bun:test";
import { dumpChildrenOf, dumpNodeSelf } from "../src/main/dump";
import type { DumpedNode } from "../src/main/dump";
import { serializeNode } from "../src/main/serializer";
import type { SerializableNode } from "../src/main/serializer";
import {
  MIXED,
  component,
  findFake,
  frame,
  guardPage,
  instance,
  linkParents,
  page,
  solid,
  text,
} from "./helpers/nodes";
import type { FakeNode } from "./helpers/nodes";

const asNode = (fake: unknown): SerializableNode => fake as SerializableNode;
const guardNode = (id: string): SerializableNode => asNode(findFake(guardPage(), id));

const HIDDEN = { includeHidden: true };
const VISIBLE_ONLY = { includeHidden: false };

/** The fields a dump adds at node level. */
const ADDED_FIELDS = [
  "mainComponentId",
  "componentSetId",
  "detachedInfo",
  "reactions",
  "flowStartingPoints",
  "styledTextSegments",
];

/**
 * Removes what a dump adds: the node-level fields and the bindings inside each
 * paint. What is left must be the read form, key order included.
 */
const withoutAddedFields = (dumped: DumpedNode): Record<string, unknown> => {
  const rest: Record<string, unknown> = { ...dumped };
  for (const field of ADDED_FIELDS) delete rest[field];
  const styles = rest.styles as Record<string, unknown> | undefined;
  if (styles) {
    const copy: Record<string, unknown> = { ...styles };
    for (const key of ["fills", "strokes"]) {
      const paints = copy[key];
      if (Array.isArray(paints)) {
        copy[key] = paints.map(({ boundVariables: _bound, ...paint }) => paint);
      }
    }
    rest.styles = copy;
  }
  return rest;
};

/** The read form of one node on its own. */
const readFormOf = (node: SerializableNode): Record<string, unknown> => {
  const { children: _children, ...self } = serializeNode(node);
  return self;
};

/** Each node of a fake tree, the root first. */
const allNodes = (root: FakeNode): FakeNode[] => [
  root,
  ...(root.children ?? []).flatMap((child) => allNodes(child)),
];

describe("the dump form without includeHidden", () => {
  for (const fake of allNodes(guardPage())) {
    test(`${fake.id} "${fake.name}" equals its read form, apart from the added fields`, async () => {
      const node = asNode(fake);
      const dumped = await dumpNodeSelf(node, VISIBLE_ONLY);
      expect(JSON.stringify(withoutAddedFields(dumped))).toBe(JSON.stringify(readFormOf(node)));
    });
  }

  test("walks the visible children only", () => {
    const ids = dumpChildrenOf(guardNode("1:2"), VISIBLE_ONLY).map((child) => child.id);
    expect(ids).toEqual(["1:3"]);
  });

  test("marks no paint and no effect visible or hidden", async () => {
    for (const fake of allNodes(guardPage())) {
      const { styles } = await dumpNodeSelf(asNode(fake), VISIBLE_ONLY);
      for (const entries of [styles?.fills, styles?.strokes, styles?.effects]) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) expect("visible" in entry).toBe(false);
      }
    }
  });
});

describe("the dump form with includeHidden", () => {
  test("walks each child, and the hidden child reads styles.visible false", async () => {
    const card = guardNode("1:2");
    const children = dumpChildrenOf(card, HIDDEN);
    expect(children.map((child) => child.id)).toEqual(["1:3", "1:4"]);
    const hidden = await dumpNodeSelf(children[1], HIDDEN);
    expect(hidden.styles).toEqual({ visible: false });
    const visible = await dumpNodeSelf(children[0], HIDDEN);
    expect(visible.styles).toEqual({});
  });

  test("keeps the hidden paints, marked, and leaves the visible ones unmarked", async () => {
    const dumped = await dumpNodeSelf(guardNode("1:5"), HIDDEN);
    expect(JSON.stringify(dumped.styles)).toBe(
      JSON.stringify({
        fills: [
          { type: "SOLID", color: "#ff0000", visible: false },
          {
            type: "SOLID",
            color: "#0000ff",
            opacity: 0.5,
            boundVariables: { color: "VariableID:9:1" },
          },
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
        strokes: [{ type: "SOLID", color: "#000000", visible: false }],
        strokeWeight: 2,
      })
    );
  });

  test("keeps the hidden effect, marked, beside the visible one", async () => {
    const dumped = await dumpNodeSelf(guardNode("1:6"), HIDDEN);
    expect(JSON.stringify(dumped.styles)).toBe(
      JSON.stringify({
        effects: [
          {
            type: "DROP_SHADOW",
            color: "#000000",
            opacity: 0.25,
            offset: { x: 0, y: 4 },
            radius: 8,
            spread: 0,
            blendMode: "NORMAL",
            visible: false,
          },
          { type: "LAYER_BLUR", radius: 4 },
        ],
      })
    );
  });

  test("keeps each effect of a node whose effects are all hidden", async () => {
    const dumped = await dumpNodeSelf(guardNode("1:7"), HIDDEN);
    expect(dumped.styles?.effects).toEqual([
      {
        type: "INNER_SHADOW",
        color: "#000000",
        opacity: 0.25,
        offset: { x: 0, y: 4 },
        radius: 8,
        spread: 0,
        blendMode: "NORMAL",
        visible: false,
      },
    ]);
  });

  test("marks the hidden paints of a styled segment", async () => {
    const node = text("5:1", "Segments", [
      {
        start: 0,
        end: 1,
        characters: "a",
        fills: [solid(1, 0, 0, { visible: false }), solid(0, 0, 0)],
        textStyleId: "",
        fillStyleId: "",
        fontName: { family: "Inter", style: "Regular" },
        fontSize: 12,
        fontWeight: 400,
        textDecoration: "NONE",
        lineHeight: { unit: "AUTO" },
        letterSpacing: { value: 0, unit: "PERCENT" },
      },
    ]);
    node.fills = MIXED;
    const withHidden = await dumpNodeSelf(asNode(node), HIDDEN);
    expect(withHidden.styledTextSegments?.[0].fills).toEqual([
      { type: "SOLID", color: "#ff0000", visible: false },
      { type: "SOLID", color: "#000000" },
    ]);
    const visibleOnly = await dumpNodeSelf(asNode(node), VISIBLE_ONLY);
    expect(visibleOnly.styledTextSegments?.[0].fills).toEqual([
      { type: "SOLID", color: "#000000" },
    ]);
  });
});

describe("the added fields", () => {
  test("an instance names its main component and the set of that component", async () => {
    const dumped = await dumpNodeSelf(guardNode("1:8"), HIDDEN);
    expect(dumped.mainComponentId).toBe("20:2");
    expect(dumped.componentSetId).toBe("20:1");
  });

  test("an instance of a lone component names no set", async () => {
    const lone = linkParents(page("6:0", "Library", { children: [component("6:1", "Lone")] }));
    const dumped = await dumpNodeSelf(
      asNode(instance("6:2", "Lone instance", findFake(lone, "6:1"))),
      HIDDEN
    );
    expect(dumped.mainComponentId).toBe("6:1");
    expect("componentSetId" in dumped).toBe(false);
  });

  test("an instance whose main component Figma does not return reads null", async () => {
    const dumped = await dumpNodeSelf(asNode(instance("6:3", "Orphan", null)), HIDDEN);
    expect(dumped.mainComponentId).toBeNull();
    expect("componentSetId" in dumped).toBe(false);
  });

  test("a detached frame reports detachedInfo as Figma gives it", async () => {
    const local = await dumpNodeSelf(guardNode("1:2"), VISIBLE_ONLY);
    expect(JSON.stringify(local.detachedInfo)).toBe(
      JSON.stringify({ type: "local", componentId: "20:2" })
    );
    const library = await dumpNodeSelf(
      asNode(
        frame("6:4", "From a library", { detachedInfo: { type: "library", componentKey: "k1" } })
      ),
      VISIBLE_ONLY
    );
    expect(JSON.stringify(library.detachedInfo)).toBe(
      JSON.stringify({ type: "library", componentKey: "k1" })
    );
  });

  test("reactions are plain JSON with the names and the order of Figma", async () => {
    const fake = findFake(guardPage(), "1:2");
    const dumped = await dumpNodeSelf(asNode(fake), VISIBLE_ONLY);
    expect(JSON.stringify(dumped.reactions)).toBe(JSON.stringify(fake.reactions));
    expect(dumped.reactions).not.toBe(fake.reactions);
  });

  test("a page reports its flow starting points", async () => {
    const dumped = await dumpNodeSelf(asNode(guardPage()), VISIBLE_ONLY);
    expect(dumped.flowStartingPoints).toEqual([{ nodeId: "1:2", name: "Guard flow" }]);
  });

  test("a text node with a mixed style reports its styled segments", async () => {
    const dumped = await dumpNodeSelf(guardNode("1:9"), VISIBLE_ONLY);
    const shared = {
      fills: [{ type: "SOLID", color: "#000000" }],
      fillStyleId: "",
      fontSize: 16,
      lineHeight: { unit: "AUTO" },
      letterSpacing: { value: 0, unit: "PERCENT" },
    };
    expect(JSON.stringify(dumped.styledTextSegments)).toBe(
      JSON.stringify([
        {
          start: 0,
          end: 6,
          characters: "Hello ",
          fills: shared.fills,
          textStyleId: "S:guard-body,",
          fillStyleId: shared.fillStyleId,
          fontName: { family: "Inter", style: "Regular" },
          fontSize: shared.fontSize,
          fontWeight: 400,
          textDecoration: "NONE",
          lineHeight: shared.lineHeight,
          letterSpacing: shared.letterSpacing,
        },
        {
          start: 6,
          end: 11,
          characters: "world",
          fills: shared.fills,
          textStyleId: "S:guard-strong,",
          fillStyleId: shared.fillStyleId,
          fontName: { family: "Inter", style: "Bold" },
          fontSize: shared.fontSize,
          fontWeight: 700,
          textDecoration: "UNDERLINE",
          lineHeight: shared.lineHeight,
          letterSpacing: shared.letterSpacing,
        },
      ])
    );
  });

  test("a text node with one style reports no segments", async () => {
    const node = text("6:5", "Plain", [
      { start: 0, end: 5, characters: "Plain", fills: [solid(0, 0, 0)] },
    ]);
    let read = false;
    node.getStyledTextSegments = () => {
      read = true;
      return [];
    };
    const dumped = await dumpNodeSelf(asNode(node), VISIBLE_ONLY);
    expect("styledTextSegments" in dumped).toBe(false);
    expect(read).toBe(false);
  });

  test("a node with nothing to add carries none of the added fields", async () => {
    for (const id of ["1:3", "1:4", "1:5", "1:6", "1:7", "1:10", "1:11"]) {
      const dumped = await dumpNodeSelf(guardNode(id), HIDDEN);
      for (const field of ADDED_FIELDS) expect(field in dumped).toBe(false);
    }
  });
});
