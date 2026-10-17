/**
 * BR-7: the normalisation of the dump-conformance test. Synthetic dumps of the
 * conformance fixture, with the IDs of two different runs. Needs no Figma.
 */

import { describe, expect, test } from "bun:test";
import {
  comparableForm,
  normaliseGolden,
  Normaliser,
  visibleDifferences,
  visibleProjection,
} from "../scripts/conformance.js";

/** The run-specific IDs of one synthetic run. */
type RunIds = {
  /** The first number of each node ID of this run. */
  base: number;
  style: string;
  variable: string;
  /** The ID part of the TEXT property suffix. */
  property: string;
};

/**
 * The three roots of the fixture as one run dumps them.
 * @param ids - The IDs of the run.
 * @returns Each root key to its dump.
 */
const fixtureDumps = (ids: RunIds) => {
  const id = (n: number): string => `${ids.base + n}:${n}`;
  const set = id(1);
  const defaultVariant = id(2);
  const badge = id(3);
  const hoverVariant = id(4);
  const screen = id(5);
  const instance = id(6);
  const detached = id(7);
  const buttonArea = id(8);
  const target = id(9);
  const text = id(10);

  return {
    "button-set": {
      id: set,
      name: "mcp-e2e/conformance/Button",
      type: "COMPONENT_SET",
      children: [
        {
          id: defaultVariant,
          name: "State=Default",
          type: "COMPONENT",
          children: [
            {
              id: badge,
              name: "mcp-e2e/conformance/badge",
              type: "FRAME",
              styles: { visible: false },
            },
          ],
        },
        { id: hoverVariant, name: "State=Hover", type: "COMPONENT" },
      ],
    },
    screen: {
      id: screen,
      name: "mcp-e2e/conformance/Screen",
      type: "FRAME",
      children: [
        {
          id: instance,
          name: "mcp-e2e/conformance/Default instance",
          type: "INSTANCE",
          mainComponentId: defaultVariant,
          componentSetId: set,
          componentProperties: { State: "Default", [`Label#${ids.property}`]: "Buy" },
          boundVariables: {
            fills: [ids.variable],
            componentProperties: { [`Label#${ids.property}`]: ids.variable },
          },
          children: [
            {
              id: `I${instance};${badge}`,
              name: "mcp-e2e/conformance/badge",
              type: "FRAME",
              styles: { visible: false },
            },
          ],
        },
        {
          id: detached,
          name: "mcp-e2e/conformance/Hover detached",
          type: "FRAME",
          detachedInfo: { type: "local", componentId: hoverVariant },
        },
        {
          id: text,
          name: "mcp-e2e/conformance/Mixed text",
          type: "TEXT",
          textStyleId: "mixed",
          styledTextSegments: [
            { start: 0, end: 4, textStyleId: ids.style, fillStyleId: "" },
            { start: 4, end: 9, textStyleId: "", fillStyleId: "" },
          ],
        },
        {
          id: buttonArea,
          name: "mcp-e2e/conformance/Button area",
          type: "FRAME",
          reactions: [
            {
              action: { type: "NODE", destinationId: target, navigation: "NAVIGATE" },
              actions: [{ type: "NODE", destinationId: target, navigation: "NAVIGATE" }],
              trigger: { type: "ON_CLICK" },
            },
          ],
        },
      ],
    },
    target: { id: target, name: "mcp-e2e/conformance/Target", type: "FRAME" },
  };
};

const RUN_A: RunIds = {
  base: 10,
  style: "S:1111aaaa,12:0",
  variable: "VariableID:20:1",
  property: "30:0",
};
const RUN_B: RunIds = {
  base: 70,
  style: "S:2222bbbb,75:0",
  variable: "VariableID:80:4",
  property: "91:2",
};

describe("the normalisation of the conformance dumps", () => {
  test("two dumps of the same tree with different IDs give the same value", () => {
    const a = normaliseGolden(fixtureDumps(RUN_A));
    const b = normaliseGolden(fixtureDumps(RUN_B));
    expect(comparableForm(a)).toBe(comparableForm(b));
    expect(comparableForm(fixtureDumps(RUN_A))).not.toBe(comparableForm(fixtureDumps(RUN_B)));
  });

  test("a different tree gives a different value", () => {
    const dumps = fixtureDumps(RUN_A);
    const changed = fixtureDumps(RUN_A);
    changed.target.name = "mcp-e2e/conformance/Other";
    expect(comparableForm(normaliseGolden(changed))).not.toBe(
      comparableForm(normaliseGolden(dumps))
    );
  });

  test("the placeholders follow document order, roots in golden order", () => {
    const result = normaliseGolden(fixtureDumps(RUN_A)) as Record<string, any>;
    const set = result["button-set"];
    expect(set.id).toBe("N1");
    expect(set.children[0].id).toBe("N2");
    expect(set.children[0].children[0].id).toBe("N3");
    expect(set.children[1].id).toBe("N4");
    expect(result.screen.id).toBe("N5");
    expect(result.screen.children[0].id).toBe("N6");
  });

  test("an instance-child ID maps part by part", () => {
    const normaliser = new Normaliser();
    expect(normaliser.nodeId("12:3")).toBe("N1");
    expect(normaliser.nodeId("I12:3;45:6")).toBe("IN1;N2");
    expect(normaliser.nodeId("I12:3;45:6;78:9")).toBe("IN1;N2;N3");
    expect(normaliser.nodeId("45:6")).toBe("N2");

    const result = normaliseGolden(fixtureDumps(RUN_A)) as Record<string, any>;
    // The instance is N6 and the badge in the variant N3.
    expect(result.screen.children[0].children[0].id).toBe("IN6;N3");
  });

  test("each reference field is rewritten", () => {
    const result = normaliseGolden(fixtureDumps(RUN_B)) as Record<string, any>;
    const [instance, detached, text, buttonArea] = result.screen.children;

    expect(instance.mainComponentId).toBe("N2");
    expect(instance.componentSetId).toBe("N1");
    expect(detached.detachedInfo).toEqual({ type: "local", componentId: "N4" });

    // Target is seen in the reaction before its own root.
    const reaction = buttonArea.reactions[0];
    expect(reaction.actions[0].destinationId).toBe(result.target.id);
    expect(reaction.action.destinationId).toBe(result.target.id);
    expect(result.target.id).toMatch(/^N\d+$/);

    expect(text.textStyleId).toBe("mixed");
    expect(text.styledTextSegments[0].textStyleId).toBe("S1");
    expect(text.styledTextSegments[0].fillStyleId).toBe("");
    expect(text.styledTextSegments[1].textStyleId).toBe("");

    expect(instance.componentProperties).toEqual({ State: "Default", "Label#P1": "Buy" });
    expect(instance.boundVariables).toEqual({
      componentProperties: { "Label#P1": "V1" },
      fills: ["V1"],
    });
  });

  test("flowStartingPoints and a page ID are rewritten", () => {
    const normaliser = new Normaliser();
    const page = normaliser.node({
      id: "0:1",
      name: "MCP E2E",
      type: "PAGE",
      flowStartingPoints: [{ nodeId: "40:2", name: "mcp-e2e flow" }],
      children: [{ id: "40:2", name: "mcp-e2e/conformance/Screen", type: "FRAME" }],
    }) as Record<string, any>;
    expect(page.id).toBe("N1");
    expect(page.flowStartingPoints).toEqual([{ nodeId: "N2", name: "mcp-e2e flow" }]);
    expect(page.children[0].id).toBe("N2");
  });

  test("each other value stays as it is", () => {
    const normaliser = new Normaliser();
    const node = {
      id: "1:2",
      name: "S:not-a-style VariableID",
      type: "TEXT",
      characters: "VariableID:1:2 in text",
      bounds: { x: 1.5, y: -2, width: 10, height: 0.800000011920929 },
      styles: { visible: false, fills: [{ type: "SOLID", color: "#ff0000", visible: false }] },
    };
    const result = normaliser.node(node) as Record<string, any>;
    expect(result.name).toBe(node.name);
    expect(result.bounds).toEqual(node.bounds);
    expect(result.styles).toEqual(node.styles);
    // Only a string that is a whole variable ID is replaced.
    expect(result.characters).toBe(node.characters);
  });
});

/** A visible solid paint, as both forms write it. */
const solid = (color: string) => ({ type: "SOLID", color });

/** A hidden solid paint, as a dump with the hidden content writes it. */
const hiddenSolid = (color: string) => ({ type: "SOLID", color, visible: false });

/** A drop shadow, as both forms write it. */
const shadow = {
  type: "DROP_SHADOW",
  color: "#000000",
  opacity: 0.25,
  offset: { x: 0, y: 4 },
  radius: 8,
  spread: 0,
  blendMode: "NORMAL",
};

/**
 * A dump with the hidden content that holds each rule of `serializeStyles`
 * that the visible projection applies.
 * @returns The parsed dump of one root.
 */
const dumpWithHidden = () => ({
  id: "1:1",
  name: "Screen",
  type: "FRAME",
  styles: {
    // A hidden paint before a visible one that binds a variable.
    fills: [
      hiddenSolid("#ff0000"),
      { ...solid("#00aa55"), boundVariables: { color: "VariableID:9:1" } },
    ],
    clipsContent: true,
  },
  boundVariables: { fills: ["VariableID:9:1"] },
  children: [
    {
      id: "1:2",
      name: "Instance",
      type: "INSTANCE",
      mainComponentId: "5:1",
      componentSetId: "5:0",
      componentProperties: { State: "Default" },
      styles: { fills: [solid("#e8ecf4")] },
      children: [
        { id: "I1:2;5:2", name: "label", type: "TEXT", characters: "Go", styles: {} },
        // A hidden instance child.
        { id: "I1:2;5:3", name: "badge", type: "FRAME", styles: { visible: false } },
      ],
    },
    {
      id: "1:3",
      name: "Each paint and effect hidden",
      type: "RECTANGLE",
      styles: {
        fills: [hiddenSolid("#ff0000")],
        strokes: [hiddenSolid("#000000")],
        effects: [{ ...shadow, visible: false }],
      },
    },
    {
      id: "1:4",
      name: "One effect hidden",
      type: "RECTANGLE",
      styles: {
        effects: [
          { type: "LAYER_BLUR", radius: 4 },
          { ...shadow, visible: false },
        ],
      },
    },
    {
      id: "1:5",
      name: "Mixed text",
      type: "TEXT",
      characters: "Body text",
      textStyleId: "mixed",
      styles: { fills: "mixed" },
      styledTextSegments: [
        { start: 0, end: 4, fills: [solid("#11151c")], textStyleId: "S:1,1:0" },
        { start: 4, end: 9, fills: [solid("#d92d20")], textStyleId: "" },
      ],
    },
    {
      id: "1:6",
      name: "Detached",
      type: "FRAME",
      detachedInfo: { type: "local", componentId: "5:4" },
      reactions: [
        {
          actions: [{ type: "NODE", destinationId: "1:9", navigation: "NAVIGATE" }],
          trigger: { type: "ON_CLICK" },
        },
      ],
      styles: {},
      // Its only child is hidden, so get_node gives it no children field.
      children: [
        { id: "1:7", name: "Hidden only child", type: "FRAME", styles: { visible: false } },
      ],
    },
    {
      id: "1:8",
      name: "Hidden frame",
      type: "FRAME",
      styles: { visible: false },
      children: [{ id: "1:10", name: "Inside the hidden frame", type: "FRAME", styles: {} }],
    },
  ],
});

/**
 * The `get_node` result of the same root, written out by hand.
 * @returns The read form.
 */
const readOfDump = () => ({
  id: "1:1",
  name: "Screen",
  type: "FRAME",
  styles: { fills: [solid("#00aa55")], clipsContent: true },
  boundVariables: { fills: ["VariableID:9:1"] },
  children: [
    {
      id: "1:2",
      name: "Instance",
      type: "INSTANCE",
      componentProperties: { State: "Default" },
      styles: { fills: [solid("#e8ecf4")] },
      children: [{ id: "I1:2;5:2", name: "label", type: "TEXT", characters: "Go", styles: {} }],
    },
    {
      id: "1:3",
      name: "Each paint and effect hidden",
      type: "RECTANGLE",
      // No fills and no strokes, but effects: [] when each effect is hidden.
      styles: { effects: [] },
    },
    {
      id: "1:4",
      name: "One effect hidden",
      type: "RECTANGLE",
      styles: { effects: [{ type: "LAYER_BLUR", radius: 4 }] },
    },
    {
      id: "1:5",
      name: "Mixed text",
      type: "TEXT",
      characters: "Body text",
      textStyleId: "mixed",
      styles: { fills: "mixed" },
    },
    { id: "1:6", name: "Detached", type: "FRAME", styles: {} },
  ],
});

describe("the visible projection of a dump", () => {
  test("the projection of a dump with the hidden content equals get_node", () => {
    const projected = visibleProjection(dumpWithHidden());
    expect(projected).toEqual(readOfDump());
    expect(visibleDifferences(readOfDump(), projected)).toEqual([]);
  });

  test("each hidden effect gives effects: [], each hidden paint no paint list", () => {
    const projected = visibleProjection(dumpWithHidden()) as Record<string, any>;
    const [, allHidden, oneHidden] = projected.children;
    expect(allHidden.styles).toEqual({ effects: [] });
    expect("fills" in allHidden.styles).toBe(false);
    expect("strokes" in allHidden.styles).toBe(false);
    expect(oneHidden.styles.effects).toEqual([{ type: "LAYER_BLUR", radius: 4 }]);
  });

  test("a mixed paint list stays, and a paint loses its own bindings", () => {
    const projected = visibleProjection(dumpWithHidden()) as Record<string, any>;
    expect(projected.styles.fills).toEqual([solid("#00aa55")]);
    expect(projected.boundVariables).toEqual({ fills: ["VariableID:9:1"] });
    expect(projected.children[3].styles.fills).toBe("mixed");
    expect("styledTextSegments" in projected.children[3]).toBe(false);
  });

  test("a hidden root stays, and the added fields of a page go", () => {
    const projected = visibleProjection({
      id: "0:1",
      name: "Page",
      type: "PAGE",
      styles: { visible: false },
      flowStartingPoints: [{ nodeId: "1:1", name: "flow" }],
      children: [{ id: "1:1", name: "Screen", type: "FRAME", styles: {} }],
    });
    expect(projected).toEqual({
      id: "0:1",
      name: "Page",
      type: "PAGE",
      styles: { visible: false },
      children: [{ id: "1:1", name: "Screen", type: "FRAME", styles: {} }],
    });
  });

  test("the projection leaves the dump as it was", () => {
    const dump = dumpWithHidden();
    visibleProjection(dump);
    expect(dump).toEqual(dumpWithHidden());
  });

  test("each difference names the node and the field", () => {
    const projected = visibleProjection(dumpWithHidden()) as Record<string, any>;

    const changed = readOfDump() as Record<string, any>;
    changed.children[0].styles.fills = [solid("#ffffff")];
    changed.children[2].note = "only in get_node";
    delete changed.boundVariables;
    expect(visibleDifferences(changed, projected)).toEqual([
      '1:1.boundVariables: get_node writes nothing, the dump {"fills":["VariableID:9:1"]}',
      '1:2.styles: get_node writes {"fills":[{"color":"#ffffff","type":"SOLID"}]}, the dump {"fills":[{"color":"#e8ecf4","type":"SOLID"}]}',
      '1:4.note: get_node writes "only in get_node", the dump nothing',
    ]);

    const reordered = readOfDump() as Record<string, any>;
    reordered.children.reverse();
    expect(visibleDifferences(reordered, projected)).toEqual([
      "1:1.children: get_node gives [1:6, 1:5, 1:4, 1:3, 1:2], the dump [1:2, 1:3, 1:4, 1:5, 1:6]",
    ]);
  });
});
