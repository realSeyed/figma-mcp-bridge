/**
 * The end-to-end scenario: an agent builds a small shop through an executor
 * follower with the design tool set, as a model would, across a crash of the
 * leader. A plain leader L, an executor follower E, and the stateful scenario
 * plugin, whose document survives each reconnect.
 *
 * 1. `list_files`, `get_design_system`.
 * 2. A batch of tokens (a collection, then color, spacing and radius
 *    variables via ref) and four text styles.
 * 3. A batch for the Button set: three auto-layout frames with labels, three
 *    components, the set, a TEXT property, and its bindings.
 * 4. A batch for the ProductCard component: an image rectangle, a title, a
 *    price, a rating icon, a sale badge, and a Button instance; then the
 *    component, its Title, Price and Sale properties, and the bindings.
 * 5. `create_page` PLP, then a batch for a page frame, a header, a wrapping
 *    grid, 8 instances with their properties, and one image fill for all 8.
 * 6. SIGKILL L, and continue on E: `find_nodes`, `get_node`, `get_screenshot`.
 * 7. The batch of step 5 again with the same batchId: a replay.
 *
 * The scenario data is invented.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Harness } from "./helpers/harness.js";
import { PNG_1X1_BASE64 } from "./helpers/plugin.js";
import { ScenarioDocument, scenarioHandlers } from "./helpers/scenario-plugin.js";
import type { RawToolResult, ServerProcess } from "./helpers/server-process.js";

const FILE_KEY = "shop-file";

/** The most MCP calls of the whole scenario. */
const MAX_CALLS = 15;

/** The backstop of a tool result: no text block is longer. */
const MAX_TEXT_CHARS = 38_000;

/** How long E may take to serve a call after the kill. */
const MAX_RECOVERY_MS = 10_000;

/** The reconnect delay of the plugin window. */
const PLUGIN_RECONNECT_MS = 1_500;

const IMAGE = `data:image/png;base64,${PNG_1X1_BASE64}`;
const STAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="16" viewBox="0 0 80 16"><path d="M8 0l2 6h6l-5 4 2 6-5-4-5 4 2-6-5-4h6z" fill="#F59E0B"/></svg>';

type Json = Record<string, any>;

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** An agent on one server: each call is counted and checked. */
class Agent {
  readonly results: { tool: string; raw: RawToolResult }[] = [];

  constructor(private readonly server: ServerProcess) {}

  /** Calls a tool and returns its raw result. A tool error throws. */
  async raw(tool: string, args: Json = {}): Promise<RawToolResult> {
    const raw = await this.server.callToolRaw(tool, args);
    this.results.push({ tool, raw });
    if (raw.isError) {
      throw new Error(`${tool} failed: ${raw.content.map((block) => block.text).join("\n")}`);
    }
    return raw;
  }

  /** Calls a tool and parses its first text block. */
  async call(tool: string, args: Json = {}): Promise<Json> {
    const raw = await this.raw(tool, args);
    return JSON.parse(raw.content.find((block) => block.type === "text")?.text ?? "null");
  }

  /** Runs a batch, which must succeed whole. */
  async batch(args: Json): Promise<Json> {
    const result = await this.call("batch", args);
    const failed = (result.results as Json[]).filter((entry) => !entry.ok);
    if (!result.ok) throw new Error(`batch did not succeed: ${JSON.stringify(failed)}`);
    return result;
  }
}

/** The data of the op with an id in a batch result. */
const op = (result: Json, id: string): Json =>
  (result.results as Json[]).find((entry) => entry.id === id)?.data;

test("an agent builds a shop on the design set, across a leader crash", async () => {
  const env = {
    FIGMA_BRIDGE_OUTPUT_ROOT: await h.tempDir("root"),
    // A follower that takes over waits for the plugin to reconnect.
    FIGMA_BRIDGE_CONNECT_GRACE_MS: "10000",
  };
  const port = await h.freePort();
  const leader = await h.server({ port, cwd: await h.tempDir("cwd"), env });
  expect(leader.role).toBe("LEADER");
  const doc = new ScenarioDocument();
  const plugin = await h.plugin({
    port,
    fileKey: FILE_KEY,
    fileName: "Shop",
    handlers: scenarioHandlers(doc),
    reconnectMs: PLUGIN_RECONNECT_MS,
  });
  const executor = await h.server({
    port,
    cwd: await h.tempDir("cwd"),
    env: { ...env, FIGMA_BRIDGE_TOOLSET: "design" },
  });
  expect(executor.role).toBe("FOLLOWER");
  const agent = new Agent(executor);

  // 1. What is connected, and what the file holds.
  const files = await agent.call("list_files");
  expect(files.files.map((file: Json) => file.fileKey)).toEqual([FILE_KEY]);
  const before = await agent.call("get_design_system");
  expect(before.counts.components).toBe(0);

  // 2. Tokens and the type ramp.
  const tokens = await agent.batch({
    batchId: "shop-tokens",
    ops: [
      { id: "tokens", tool: "create_variable_collection", args: { name: "Tokens" } },
      {
        id: "colors",
        tool: "create_variables",
        args: {
          collectionId: { ref: "tokens" },
          variables: [
            { name: "color/brand", type: "COLOR", value: "#4F46E5" },
            { name: "color/text", type: "COLOR", value: "#111827" },
            { name: "color/surface", type: "COLOR", value: "#FFFFFF" },
          ],
        },
      },
      {
        id: "space",
        tool: "create_variables",
        args: {
          collectionId: { ref: "tokens" },
          variables: [
            { name: "space/8", type: "FLOAT", value: 8 },
            { name: "space/16", type: "FLOAT", value: 16 },
            { name: "space/24", type: "FLOAT", value: 24 },
          ],
        },
      },
      {
        id: "radius",
        tool: "create_variables",
        args: {
          collectionId: { ref: "tokens" },
          variables: [
            { name: "radius/md", type: "FLOAT", value: 8 },
            { name: "radius/lg", type: "FLOAT", value: 16 },
          ],
        },
      },
      ...[
        ["Display", "Bold", 40],
        ["Heading", "Semi Bold", 24],
        ["Body", "Regular", 16],
        ["Caption", "Regular", 12],
      ].map(([name, fontStyle, fontSize]) => ({
        id: `style${name}`,
        tool: "create_text_style",
        args: { name: `Type/${name}`, fontFamily: "Inter", fontStyle, fontSize },
      })),
    ],
  });
  const brand = op(tokens, "colors").results[0].id as string;
  const surface = op(tokens, "colors").results[2].id as string;
  const spaceS = op(tokens, "space").results[0].id as string;
  const radiusMd = op(tokens, "radius").results[0].id as string;
  const radiusLg = op(tokens, "radius").results[1].id as string;
  const bodyStyle = op(tokens, "styleBody").id as string;
  const headingStyle = op(tokens, "styleHeading").id as string;
  expect(doc.variables.size).toBe(8);
  expect(doc.textStyles.size).toBe(4);

  // 3. The Button set, on a page of its own.
  const variants = ["Primary", "Secondary", "Ghost"];
  const button = await agent.batch({
    batchId: "shop-button",
    ops: [
      { id: "page", tool: "create_page", args: { name: "Components" } },
      ...variants.flatMap((variant) => [
        {
          id: `frame${variant}`,
          tool: "create_frame",
          args: {
            name: `Variant=${variant}`,
            parentId: { ref: "page" },
            layoutMode: "HORIZONTAL",
            padding: 12,
            itemSpacing: 8,
            fillHex: "#4F46E5",
            cornerRadius: 8,
          },
        },
        {
          id: `label${variant}`,
          tool: "create_text",
          args: { name: "Button/Label", parentId: { ref: `frame${variant}` }, characters: "Buy" },
        },
      ]),
      {
        tool: "bind_variables",
        args: {
          bindings: variants.flatMap((variant) => [
            {
              nodeId: { ref: `frame${variant}` },
              field: "fills",
              variableId: brand,
              paintIndex: 0,
            },
            { nodeId: { ref: `frame${variant}` }, field: "cornerRadius", variableId: radiusMd },
            { nodeId: { ref: `frame${variant}` }, field: "itemSpacing", variableId: spaceS },
          ]),
        },
      },
      {
        tool: "apply_text_style",
        args: {
          nodeIds: variants.map((variant) => ({ ref: `label${variant}` })),
          styleId: bodyStyle,
        },
      },
      ...variants.map((variant) => ({
        id: `component${variant}`,
        tool: "create_component",
        args: { fromNodeId: { ref: `frame${variant}` } },
      })),
      {
        id: "set",
        tool: "combine_as_variants",
        args: {
          componentIds: variants.map((variant) => ({ ref: `component${variant}` })),
          name: "Button",
        },
      },
      {
        tool: "add_component_property",
        args: { componentId: { ref: "set" }, name: "Label", type: "TEXT", defaultValue: "Buy" },
      },
      ...variants.map((variant) => ({
        tool: "bind_component_property",
        args: { nodeId: { ref: `label${variant}` }, field: "characters", propertyName: "Label" },
      })),
    ],
  });
  const componentsPage = op(button, "page").pageId as string;
  const buttonSet = op(button, "set").id as string;
  expect(op(button, "set").variantIds).toHaveLength(3);

  // 4. The ProductCard component.
  const card = await agent.batch({
    batchId: "shop-product-card",
    ops: [
      {
        id: "card",
        tool: "create_frame",
        args: {
          name: "ProductCard",
          parentId: componentsPage,
          x: 400,
          width: 320,
          layoutMode: "VERTICAL",
          layoutSizingVertical: "HUG",
          padding: 16,
          itemSpacing: 12,
          fillHex: "#FFFFFF",
          cornerRadius: 16,
        },
      },
      {
        id: "image",
        tool: "create_shape",
        args: {
          shapeType: "RECTANGLE",
          name: "Card/Image",
          parentId: { ref: "card" },
          height: 240,
          layoutSizingHorizontal: "FILL",
        },
      },
      {
        id: "title",
        tool: "create_text",
        args: {
          name: "Card/Title",
          parentId: { ref: "card" },
          characters: "Product name",
          layoutSizingHorizontal: "FILL",
          textAutoResize: "HEIGHT",
          textStyleId: headingStyle,
        },
      },
      {
        id: "price",
        tool: "create_text",
        args: { name: "Card/Price", parentId: { ref: "card" }, characters: "$49" },
      },
      {
        tool: "create_svg",
        args: { name: "Icon/Rating", parentId: { ref: "card" }, svg: STAR_SVG, width: 80 },
      },
      {
        id: "sale",
        tool: "create_text",
        args: {
          name: "Card/Sale",
          parentId: { ref: "card" },
          characters: "Sale",
          layoutPositioning: "ABSOLUTE",
          x: 24,
          y: 24,
        },
      },
      {
        tool: "create_instance",
        args: {
          componentId: buttonSet,
          parentId: { ref: "card" },
          variantProperties: [{ name: "Variant", value: "Primary" }],
        },
      },
      {
        tool: "bind_variables",
        args: {
          bindings: [
            { nodeId: { ref: "card" }, field: "fills", variableId: surface, paintIndex: 0 },
            { nodeId: { ref: "card" }, field: "cornerRadius", variableId: radiusLg },
          ],
        },
      },
      { id: "component", tool: "create_component", args: { fromNodeId: { ref: "card" } } },
      ...[
        ["Title", "TEXT", "Product name"],
        ["Price", "TEXT", "$49"],
        ["Sale", "BOOLEAN", "true"],
      ].map(([name, type, defaultValue]) => ({
        tool: "add_component_property",
        args: { componentId: { ref: "component" }, name, type, defaultValue },
      })),
      ...[
        ["title", "characters", "Title"],
        ["price", "characters", "Price"],
        ["sale", "visible", "Sale"],
      ].map(([layer, field, propertyName]) => ({
        tool: "bind_component_property",
        args: { nodeId: { ref: layer }, field, propertyName },
      })),
    ],
  });
  const productCard = op(card, "component").id as string;
  expect(doc.get(productCard).type).toBe("COMPONENT");
  expect(doc.get(productCard).children.map((id) => doc.get(id).name)).toEqual([
    "Card/Image",
    "Card/Title",
    "Card/Price",
    "Icon/Rating",
    "Card/Sale",
    "Button",
  ]);

  // 5. The product listing page: a page frame, a header, and a grid of 8 cards.
  const plp = await agent.call("create_page", { name: "PLP", setAsCurrent: true });
  const products = Array.from({ length: 8 }, (_, index) => ({
    title: `Ceramic mug ${index + 1}`,
    price: `$${12 + index * 3}`,
    sale: index % 3 === 0 ? "true" : "false",
  }));
  const gridBatch = {
    batchId: "shop-plp-grid",
    ops: [
      {
        id: "screen",
        tool: "create_frame",
        args: {
          name: "PLP/Desktop",
          parentId: plp.pageId,
          width: 1440,
          layoutMode: "VERTICAL",
          layoutSizingVertical: "HUG",
          padding: 32,
          itemSpacing: 24,
        },
      },
      {
        id: "header",
        tool: "create_frame",
        args: {
          name: "PLP/Header",
          parentId: { ref: "screen" },
          layoutMode: "HORIZONTAL",
          layoutSizingHorizontal: "FILL",
          height: 72,
        },
      },
      {
        tool: "create_text",
        args: {
          name: "PLP/Heading",
          parentId: { ref: "header" },
          characters: "All mugs",
          textStyleId: headingStyle,
        },
      },
      {
        id: "grid",
        tool: "create_frame",
        args: {
          name: "PLP/Grid",
          parentId: { ref: "screen" },
          layoutMode: "HORIZONTAL",
          layoutWrap: "WRAP",
          itemSpacing: 24,
          counterAxisSpacing: 24,
          layoutSizingHorizontal: "FILL",
          layoutSizingVertical: "HUG",
        },
      },
      ...products.map((_, index) => ({
        id: `card${index}`,
        tool: "create_instance",
        args: { componentId: productCard, parentId: { ref: "grid" } },
      })),
      ...products.map((product, index) => ({
        tool: "set_instance_properties",
        args: {
          nodeId: { ref: `card${index}` },
          properties: [
            { name: "Title", value: product.title },
            { name: "Price", value: product.price },
            { name: "Sale", value: product.sale },
          ],
        },
      })),
      {
        tool: "set_image_fill",
        args: {
          items: products.map((_, index) => ({
            nodeId: { ref: `card${index}`, path: "children.0.id" },
            source: IMAGE,
          })),
        },
      },
    ],
  };
  const grid = await agent.batch(gridBatch);
  const gridId = op(grid, "grid").nodeId as string;
  // One upload for the 8 items that share one source.
  expect(doc.uploads).toEqual([1]);
  const cards = doc.get(gridId).children.map((id) => doc.get(id));
  expect(cards).toHaveLength(8);
  cards.forEach((instance, index) => {
    const values = Object.fromEntries(
      Object.entries(instance.componentProperties ?? {}).map(([name, value]) => [
        name.split("#")[0],
        value.value,
      ])
    );
    expect(values).toEqual({
      Title: products[index].title,
      Price: products[index].price,
      Sale: products[index].sale === "true",
    });
    const image = doc.get(instance.children[0]);
    expect(image.name).toBe("Card/Image");
    expect(image.fields.imageHash).toBeDefined();
  });

  // 6. The leader crashes; the agent goes on with E.
  leader.kill("SIGKILL");
  const killedAt = Date.now();
  const located = await agent.call("find_nodes", {
    name: "ProductCard",
    types: ["INSTANCE"],
    withinId: gridId,
  });
  const recoveryMs = Date.now() - killedAt;
  expect(located.items).toHaveLength(8);
  expect(recoveryMs).toBeLessThanOrEqual(MAX_RECOVERY_MS);
  expect(plugin.connections).toBe(2);

  const outline = await agent.call("get_node", { nodeId: gridId, depth: 1, detail: "outline" });
  expect(outline.children).toHaveLength(8);
  expect(outline.children.every((child: Json) => child.childCount === 6)).toBe(true);

  const shot = await agent.raw("get_screenshot", { nodeIds: [gridId] });
  const imageBlocks = shot.content.filter((block) => block.type === "image");
  expect(imageBlocks).toHaveLength(1);
  const meta = JSON.parse(shot.content.find((block) => block.type === "text")!.text!);
  const entry = Array.isArray(meta) ? meta[0] : meta;
  expect(Math.max(entry.pixelWidth, entry.pixelHeight)).toBeLessThanOrEqual(1024);

  // 7. The same batch again, as after a lost answer: a replay that writes nothing.
  const snapshot = doc.snapshot();
  const requestsBefore = plugin.requests.length;
  const replay = await agent.batch(gridBatch);
  expect(replay.replayed).toBe(true);
  expect(doc.snapshot()).toBe(snapshot);
  expect(plugin.requests.length).toBe(requestsBefore);
  expect(doc.uploads).toEqual([1]);

  // The budget of the whole scenario.
  expect(agent.results.length).toBeLessThanOrEqual(MAX_CALLS);
  expect(agent.results.filter((result) => result.raw.isError)).toEqual([]);
  for (const { tool, raw } of agent.results) {
    for (const block of raw.content) {
      if (block.type === "text") {
        expect({ tool, chars: block.text!.length }).toEqual({
          tool,
          chars: Math.min(block.text!.length, MAX_TEXT_CHARS),
        });
      }
    }
  }
}, 120_000);
