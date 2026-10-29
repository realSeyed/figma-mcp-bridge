/**
 * The context-safe reads: the fitted screenshot export, the budgeted page
 * reads with `depth` and `detail`, the filters of `get_variable_defs`, and the
 * discovery tools `find_nodes` and `get_design_system`. Each test calls
 * `handleRequest` on a fake file of synthetic nodes.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { pluginMain, resetFakeFigma } from "./helpers/plugin-globals";
import { installFakeFile, pngHeader, pngSize } from "./helpers/fake-figma";
import { component, componentSet, frame, page, rectangle, solid, text } from "./helpers/nodes";
import type { FakeNode } from "./helpers/nodes";
import { serializeNode } from "../src/main/serializer";
import type { SerializableNode, SerializedNode } from "../src/main/serializer";

const BUDGET = 35_000;

beforeEach(() => {
  resetFakeFigma();
});

let counter = 0;
const call = async (type: string, params: Record<string, unknown> = {}, nodeIds?: string[]) => {
  const response = await pluginMain.handleRequest({
    type: type as never,
    requestId: `r${++counter}`,
    params,
    nodeIds,
  });
  return response;
};

const dataOf = async (
  type: string,
  params: Record<string, unknown> = {},
  nodeIds?: string[]
): Promise<any> => {
  const response = await call(type, params, nodeIds);
  if (response.error !== undefined) throw new Error(response.error);
  return response.data;
};

const label = (index: number, at: number) => `Label ${index}.${at}`;

/**
 * A page of `frames` frames, each with `per` text nodes: the shape of a real
 * screen, and far more than one read may return.
 */
const bigPage = (id: string, frames: number, per: number): FakeNode =>
  page(id, "Big page", {
    children: Array.from({ length: frames }, (_, index) =>
      frame(`${index + 10}:1`, `Screen ${index}`, {
        x: index * 1500,
        width: 1440,
        height: 900,
        fills: [solid(1, 1, 1)],
        children: Array.from({ length: per }, (_, at) =>
          text(`${index + 10}:${at + 2}`, label(index, at), [
            { start: 0, end: 9, characters: "Some text" },
          ])
        ),
      })
    ),
  });

/** A text with a long string, to check the cut of the outline. */
const LONG_TEXT = "x".repeat(120);

const smallPage = (): FakeNode =>
  page("1:1", "Small page", {
    children: [
      frame("1:2", "Card", {
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        children: [
          text("1:3", "Title", [{ start: 0, end: 120, characters: LONG_TEXT }]),
          frame("1:4", "Row", {
            children: [rectangle("1:5", "Dot"), rectangle("1:6", "Hidden", { visible: false })],
          }),
        ],
      }),
    ],
  });

describe("get_screenshot with maxEdge", () => {
  const install = () =>
    installFakeFile({
      pages: [
        page("1:1", "Page", {
          children: [
            frame("1:2", "Desktop", {
              width: 1440,
              height: 900,
              absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
              absoluteRenderBounds: { x: 0, y: 0, width: 1440, height: 900 },
            }),
            frame("1:3", "Card", {
              width: 300,
              height: 200,
              absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
              // A shadow makes the render box larger than the logical one.
              absoluteRenderBounds: { x: -20, y: -20, width: 340, height: 240 },
            }),
          ],
        }),
      ],
      exportAsync: (node, settings) => {
        if (settings.format === "SVG") return new TextEncoder().encode("<svg/>");
        const scale = (settings.constraint as { value: number }).value;
        const box = (
          settings.useAbsoluteBounds ? node.absoluteBoundingBox : node.absoluteRenderBounds
        ) as { width: number; height: number };
        return pngHeader(Math.round(box.width * scale), Math.round(box.height * scale));
      },
    });

  test("fits a desktop frame to the edge and keeps a small card at scale 2", async () => {
    const { exports } = install();
    const data = await dataOf("get_screenshot", { maxEdge: 1024 }, ["1:2", "1:3"]);

    expect(data.exports[0].scale).toBeCloseTo(1024 / 1440, 6);
    expect(data.exports[0].scale).toBeCloseTo(0.711, 3);
    expect(pngSize(data.exports[0].base64)).toEqual({ width: 1024, height: 640 });
    expect(data.exports[1].scale).toBe(2);
    expect(pngSize(data.exports[1].base64)).toEqual({ width: 680, height: 480 });
    expect(exports.map((entry) => entry.nodeId)).toEqual(["1:2", "1:3"]);
  });

  test("takes the asked scale as an upper bound, and the logical box with clip", async () => {
    install();
    const low = await dataOf("get_screenshot", { maxEdge: 1024, scale: 0.5 }, ["1:2"]);
    expect(low.exports[0].scale).toBe(0.5);

    const clipped = await dataOf("get_screenshot", { maxEdge: 150, clip: true }, ["1:3"]);
    expect(clipped.exports[0].scale).toBe(0.5);
    expect(pngSize(clipped.exports[0].base64)).toEqual({ width: 150, height: 100 });
  });

  test("never goes below a scale of 0.01", async () => {
    installFakeFile({
      pages: [
        page("1:1", "Page", {
          children: [
            frame("1:2", "Huge", {
              width: 100_000,
              height: 10,
              absoluteRenderBounds: { x: 0, y: 0, width: 100_000, height: 10 },
            }),
          ],
        }),
      ],
    });
    const data = await dataOf("get_screenshot", { maxEdge: 64 }, ["1:2"]);
    expect(data.exports[0].scale).toBe(0.01);
  });

  test("without maxEdge (save_screenshots), exports as before and reports no scale", async () => {
    const { exports } = install();
    const data = await dataOf("get_screenshot", {}, ["1:2"]);
    expect(exports[0].settings).toEqual({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    expect("scale" in data.exports[0]).toBe(false);
    expect(pngSize(data.exports[0].base64)).toEqual({ width: 2880, height: 1800 });
  });

  test("an SVG ignores maxEdge", async () => {
    const { exports } = install();
    await dataOf("get_screenshot", { maxEdge: 1024, format: "SVG" }, ["1:2"]);
    expect(exports[0].settings).toEqual({ format: "SVG" });
  });
});

describe("the budgeted page reads", () => {
  test("get_document on a 3,000-node page stays within the budget and says it was cut", async () => {
    installFakeFile({ pages: [bigPage("5:1", 30, 99)] });
    const data = await dataOf("get_document");
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(BUDGET);
    expect(data.truncated).toBe(true);
    expect(data.note).toContain("35000 characters");
    expect(data.childCount).toBe(30);
    expect(data.children.length).toBeLessThan(30);
  });

  test("get_document with outline and depth 1 maps the whole big page", async () => {
    installFakeFile({ pages: [bigPage("5:1", 30, 99)] });
    const data = await dataOf("get_document", { detail: "outline", depth: 1 });
    expect(data.truncated).toBeUndefined();
    expect(data.children).toHaveLength(30);
    expect(data.children[0]).toEqual({
      id: "10:1",
      name: "Screen 0",
      type: "FRAME",
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      childCount: 99,
    });
  });

  test("get_document reads another page by pageId, and loads it first", async () => {
    const { loads } = installFakeFile({ pages: [smallPage(), page("2:1", "Other")] });
    const data = await dataOf("get_document", { pageId: "2:1" });
    expect(data.id).toBe("2:1");
    expect(loads.get("2:1")).toBe(1);

    const missing = await call("get_document", { pageId: "9:9" });
    expect(missing.error).toContain("found no page with the ID 9:9");
    expect(missing.error).toContain("get_metadata");
  });

  test("a small page reads as before when it fits", async () => {
    installFakeFile({ pages: [smallPage()] });
    const data = await dataOf("get_document");
    const expected = serializeNode(smallPage() as unknown as SerializableNode);
    expect(JSON.stringify(data)).toBe(JSON.stringify(expected));
  });

  test("outline nodes carry id, name, type, bounds and 80 characters of text", async () => {
    installFakeFile({ pages: [smallPage()] });
    const data = await dataOf("get_node", { detail: "outline" }, ["1:2"]);
    expect(data).toEqual({
      id: "1:2",
      name: "Card",
      type: "FRAME",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      children: [
        {
          id: "1:3",
          name: "Title",
          type: "TEXT",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          characters: `${"x".repeat(80)}…`,
        },
        {
          id: "1:4",
          name: "Row",
          type: "FRAME",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          // The hidden rectangle is left out, as in every read.
          children: [
            {
              id: "1:5",
              name: "Dot",
              type: "RECTANGLE",
              bounds: { x: 0, y: 0, width: 100, height: 100 },
            },
          ],
        },
      ],
    });
  });

  test("depth 0 is the node alone with its childCount; depth 1 stops one level down", async () => {
    installFakeFile({ pages: [smallPage()] });
    const alone = await dataOf("get_node", { depth: 0 }, ["1:2"]);
    expect(alone.children).toBeUndefined();
    expect(alone.childCount).toBe(2);
    expect(alone.styles).toBeDefined();

    const one = await dataOf("get_node", { depth: 1, detail: "outline" }, ["1:2"]);
    expect(one.children.map((child: SerializedNode) => child.id)).toEqual(["1:3", "1:4"]);
    expect(one.children[1].childCount).toBe(1);
    expect(one.children[1].children).toBeUndefined();
  });

  test("get_node without depth and detail keeps its own output", async () => {
    installFakeFile({ pages: [smallPage()] });
    const data = await dataOf("get_node", {}, ["1:2"]);
    const card = smallPage().children?.[0] as FakeNode;
    expect(JSON.stringify(data)).toBe(
      JSON.stringify(serializeNode(card as unknown as SerializableNode))
    );
  });

  test("get_selection shares one budget; a node past it is a stub", async () => {
    const big = bigPage("5:1", 30, 99);
    installFakeFile({
      pages: [big],
      selection: (big.children ?? []).map((child) => child.id),
    });
    const data = await dataOf("get_selection");
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(BUDGET);
    expect(data).toHaveLength(30);
    expect(data[0].truncated).toBe(true);
    expect(data[0].note).toContain("35000 characters");
    expect(data[29]).toEqual({
      id: "39:1",
      name: "Screen 29",
      type: "FRAME",
      childCount: 99,
      truncated: true,
    });
  });

  test("get_selection of a small selection reads as before", async () => {
    installFakeFile({ pages: [smallPage()], selection: ["1:3", "1:4"] });
    const data = await dataOf("get_selection");
    const fresh = smallPage();
    const expected = ["1:3", "1:4"].map((id) =>
      serializeNode(
        (fresh.children?.[0].children ?? []).find(
          (node) => node.id === id
        ) as unknown as SerializableNode
      )
    );
    expect(JSON.stringify(data)).toBe(JSON.stringify(expected));
  });
});

/**
 * The get_design_context of the code before the budget, kept as the reference
 * of its output: the full subtree at each level, cut at the depth.
 */
const referenceDesignContext = (root: SerializableNode, depth: number): SerializedNode => {
  const walk = (node: SerializableNode, level: number): SerializedNode => {
    const serialized = serializeNode(node);
    const visible =
      "children" in node ? node.children.filter((child) => child.visible !== false) : [];
    if (level >= depth && serialized.children) {
      return { ...serialized, children: undefined, childCount: visible.length };
    }
    if (serialized.children) {
      return { ...serialized, children: visible.map((child) => walk(child, level + 1)) };
    }
    return serialized;
  };
  return walk(root, 0);
};

describe("get_design_context", () => {
  test("is unchanged for a small tree, at the default depth and at depth 1", async () => {
    const { figma } = installFakeFile({ pages: [smallPage()] });
    for (const depth of [undefined, 1]) {
      const data = await dataOf("get_design_context", depth === undefined ? {} : { depth });
      expect(JSON.stringify(data)).toBe(
        JSON.stringify({
          fileName: "Test file",
          currentPage: { id: "1:1", name: "Small page" },
          selectionCount: 0,
          context: [
            referenceDesignContext(figma.currentPage as unknown as SerializableNode, depth ?? 2),
          ],
        })
      );
    }
  });

  test("is budgeted for a big tree, and says so", async () => {
    installFakeFile({ pages: [bigPage("5:1", 30, 99)] });
    const data = await dataOf("get_design_context", { depth: 5 });
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(BUDGET);
    expect(data.truncated).toBe(true);
    expect(data.note).toContain("35000 characters");
    expect(data.context[0].childCount).toBe(30);
  });
});

describe("get_variable_defs filters", () => {
  const install = () =>
    installFakeFile({
      pages: [page("1:1", "Page")],
      collections: [
        {
          id: "VariableCollectionId:1:1",
          name: "Colors",
          defaultModeId: "1:0",
          modes: [{ modeId: "1:0", name: "Light" }],
          variableIds: ["VariableID:1:2", "VariableID:1:3"],
        },
        {
          id: "VariableCollectionId:2:1",
          name: "Spacing",
          defaultModeId: "2:0",
          modes: [{ modeId: "2:0", name: "Default" }],
          variableIds: ["VariableID:2:2"],
        },
      ],
      variables: [
        {
          id: "VariableID:1:2",
          name: "brand/primary",
          resolvedType: "COLOR",
          valuesByMode: { "1:0": { r: 1, g: 0, b: 0, a: 1 } },
        },
        {
          id: "VariableID:1:3",
          name: "text/body",
          resolvedType: "COLOR",
          valuesByMode: { "1:0": { r: 0, g: 0, b: 0, a: 1 } },
        },
        {
          id: "VariableID:2:2",
          name: "space/md",
          resolvedType: "FLOAT",
          valuesByMode: { "2:0": 16 },
        },
      ],
    });

  test("query keeps the matching variables and drops a collection with none", async () => {
    install();
    const data = await dataOf("get_variable_defs", { query: "PRIMARY" });
    expect(data.collections).toHaveLength(1);
    expect(data.collections[0].variables.map((v: { name: string }) => v.name)).toEqual([
      "brand/primary",
    ]);
  });

  test("collectionId keeps one collection, and an unknown one is an error", async () => {
    install();
    const data = await dataOf("get_variable_defs", { collectionId: "VariableCollectionId:2:1" });
    expect(data.collections.map((c: { name: string }) => c.name)).toEqual(["Spacing"]);

    const missing = await call("get_variable_defs", { collectionId: "VariableCollectionId:9:9" });
    expect(missing.error).toContain("found no local collection");
  });

  test("without filters lists every collection", async () => {
    install();
    const data = await dataOf("get_variable_defs");
    expect(data.collections).toHaveLength(2);
  });
});

describe("find_nodes", () => {
  const install = () =>
    installFakeFile({
      pages: [
        page("1:1", "Home", {
          children: [
            frame("1:2", "Hero", {
              x: 10,
              y: 20,
              children: [
                frame("1:3", "Button / Primary", { x: 4, y: 8, width: 120, height: 40 }),
                text("1:4", "Button label", [{ start: 0, end: 2, characters: "Go" }]),
                frame("1:5", "button / ghost", { visible: false }),
              ],
            }),
          ],
        }),
        page("2:1", "Other", {
          children: [frame("2:2", "Button / Other page")],
        }),
      ],
    });

  test("by name, without regard to case, in document order", async () => {
    install();
    const data = await dataOf("find_nodes", { name: "button" });
    expect(data.truncated).toBe(false);
    expect(data.items).toEqual([
      {
        id: "1:3",
        name: "Button / Primary",
        type: "FRAME",
        pageId: "1:1",
        parentId: "1:2",
        x: 4,
        y: 8,
        width: 120,
        height: 40,
      },
      {
        id: "1:4",
        name: "Button label",
        type: "TEXT",
        pageId: "1:1",
        parentId: "1:2",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        characters: "Go",
      },
      {
        id: "1:5",
        name: "button / ghost",
        type: "FRAME",
        pageId: "1:1",
        parentId: "1:2",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        visible: false,
      },
    ]);
  });

  test("by types, by both, and by an exact name", async () => {
    install();
    const texts = await dataOf("find_nodes", { types: ["TEXT"] });
    expect(texts.items.map((item: { id: string }) => item.id)).toEqual(["1:4"]);

    const both = await dataOf("find_nodes", { name: "button", types: ["FRAME"] });
    expect(both.items.map((item: { id: string }) => item.id)).toEqual(["1:3", "1:5"]);

    const exact = await dataOf("find_nodes", { name: "Button / Primary", exactName: true });
    expect(exact.items.map((item: { id: string }) => item.id)).toEqual(["1:3"]);
    const wrongCase = await dataOf("find_nodes", { name: "button / primary", exactName: true });
    expect(wrongCase.items).toEqual([]);
  });

  test("with a limit, it stops and says it was cut", async () => {
    install();
    const data = await dataOf("find_nodes", { name: "button", limit: 2 });
    expect(data.items).toHaveLength(2);
    expect(data.truncated).toBe(true);
  });

  test("allPages loads every page; withinId searches one node", async () => {
    const { loads } = install();
    const all = await dataOf("find_nodes", { name: "button", allPages: true });
    expect(all.items.map((item: { id: string }) => item.id)).toEqual(["1:3", "1:4", "1:5", "2:2"]);
    expect(loads.get("*")).toBe(1);

    const other = await dataOf("find_nodes", { name: "button", withinId: "2:1" });
    expect(other.items.map((item: { id: string }) => item.id)).toEqual(["2:2"]);
    expect(loads.get("2:1")).toBe(1);
  });

  test("stays within the budget on a large page", async () => {
    installFakeFile({ pages: [bigPage("5:1", 10, 99)] });
    const data = await dataOf("find_nodes", { types: ["TEXT"], limit: 500 });
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(BUDGET);
    expect(data.truncated).toBe(true);
  });

  test("needs name or types, and refuses an unknown type", async () => {
    install();
    expect((await call("find_nodes", {})).error).toContain("requires name, types, or both");
    expect((await call("find_nodes", { types: ["PAGE"] })).error).toContain('received "PAGE"');
    expect((await call("find_nodes", { name: "x", withinId: "9:9" })).error).toContain(
      "found no node with the ID 9:9"
    );
  });
});

describe("get_design_system", () => {
  const buttonSet = () =>
    componentSet("3:1", "Button", {
      componentPropertyDefinitions: {
        Variant: { type: "VARIANT", defaultValue: "Primary", variantOptions: ["Primary", "Ghost"] },
        "Label#1:0": { type: "TEXT", defaultValue: "Go" },
      },
      children: [component("3:2", "Variant=Primary"), component("3:3", "Variant=Ghost")],
    });

  const install = (extra: { variables?: number } = {}) => {
    const many = extra.variables ?? 0;
    return installFakeFile({
      pages: [
        page("1:1", "Components", {
          children: [
            buttonSet(),
            component("3:4", "Icon", {
              componentPropertyDefinitions: { "Size#2:0": { type: "TEXT", defaultValue: "md" } },
            }),
          ],
        }),
      ],
      collections: [
        {
          id: "VariableCollectionId:1:1",
          name: "Tokens",
          defaultModeId: "1:0",
          modes: [
            { modeId: "1:0", name: "Light" },
            { modeId: "1:9", name: "Dark" },
          ],
          variableIds: [
            "VariableID:1:2",
            "VariableID:1:3",
            "VariableID:1:4",
            ...Array.from({ length: many }, (_, index) => `VariableID:8:${index}`),
          ],
        },
      ],
      variables: [
        {
          id: "VariableID:1:2",
          name: "brand/primary",
          resolvedType: "COLOR",
          valuesByMode: { "1:0": { r: 1, g: 0, b: 0, a: 1 }, "1:9": { r: 0, g: 0, b: 0, a: 1 } },
        },
        {
          id: "VariableID:1:3",
          name: "button/fill",
          resolvedType: "COLOR",
          valuesByMode: { "1:0": { type: "VARIABLE_ALIAS", id: "VariableID:1:2" } },
        },
        {
          id: "VariableID:1:4",
          name: "space/md",
          resolvedType: "FLOAT",
          valuesByMode: { "1:0": 16 },
        },
        ...Array.from({ length: many }, (_, index) => ({
          id: `VariableID:8:${index}`,
          name: `generated/a-rather-long-token-name-to-fill-the-budget/${index}`,
          resolvedType: "FLOAT" as const,
          valuesByMode: { "1:0": index },
        })),
      ],
      textStyles: [
        {
          id: "S:text-body,",
          name: "Body",
          fontName: { family: "Inter", style: "Regular" },
          fontSize: 16,
          lineHeight: { unit: "PIXELS", value: 24 },
          letterSpacing: { unit: "PERCENT", value: 0 },
        },
      ],
      paintStyles: [
        { id: "S:paint-brand,", name: "Brand", paints: [solid(0, 0, 1, { opacity: 0.5 })] },
        { id: "S:paint-mixed,", name: "Mixed", paints: [solid(0, 0, 1), solid(1, 1, 1)] },
      ],
      effectStyles: [{ id: "S:effect-card,", name: "Card shadow", effects: [] }],
    });
  };

  test("reports each part in a compact shape", async () => {
    install();
    const data = await dataOf("get_design_system");
    expect(data).toEqual({
      counts: { variables: 3, textStyles: 1, paintStyles: 2, effectStyles: 1, components: 2 },
      variables: [
        {
          collection: { id: "VariableCollectionId:1:1", name: "Tokens" },
          items: [
            { id: "VariableID:1:2", name: "brand/primary", type: "COLOR", value: "#ff0000" },
            {
              id: "VariableID:1:3",
              name: "button/fill",
              type: "COLOR",
              value: { alias: "brand/primary" },
            },
            { id: "VariableID:1:4", name: "space/md", type: "FLOAT", value: 16 },
          ],
        },
      ],
      textStyles: [
        {
          id: "S:text-body,",
          name: "Body",
          fontFamily: "Inter",
          fontStyle: "Regular",
          fontSize: 16,
          lineHeight: { value: 24, unit: "PIXELS" },
          letterSpacing: { value: 0, unit: "PERCENT" },
        },
      ],
      paintStyles: [
        { id: "S:paint-brand,", name: "Brand", hex: "#0000ff80" },
        { id: "S:paint-mixed,", name: "Mixed" },
      ],
      effectStyles: [{ id: "S:effect-card,", name: "Card shadow" }],
      components: [
        {
          id: "3:1",
          name: "Button",
          type: "COMPONENT_SET",
          pageName: "Components",
          variantProperties: { Variant: ["Primary", "Ghost"] },
          properties: [{ name: "Label#1:0", type: "TEXT" }],
        },
        {
          id: "3:4",
          name: "Icon",
          type: "COMPONENT",
          pageName: "Components",
          properties: [{ name: "Size#2:0", type: "TEXT" }],
        },
      ],
    });
  });

  test("include reads only the parts asked for", async () => {
    install();
    const data = await dataOf("get_design_system", { include: ["paintStyles"] });
    expect(Object.keys(data)).toEqual(["counts", "paintStyles"]);
    expect(data.counts).toEqual({ paintStyles: 2 });
  });

  test("cuts the longest list to fit the budget and keeps its count", async () => {
    install({ variables: 2_000 });
    const data = await dataOf("get_design_system");
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(BUDGET);
    expect(data.truncated).toBe(true);
    expect(data.note).toContain("counts holds the full size");
    expect(data.counts.variables).toBe(2_003);
    expect(data.variables[0].items.length).toBeLessThan(2_003);
    // The short lists are kept whole.
    expect(data.components).toHaveLength(2);
    expect(data.textStyles).toHaveLength(1);
  });

  test("refuses an unknown part", async () => {
    install();
    const response = await call("get_design_system", { include: ["grids"] });
    expect(response.error).toContain("requires include as a non-empty array");
  });
});
