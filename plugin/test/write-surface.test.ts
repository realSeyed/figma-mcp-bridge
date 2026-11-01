/**
 * The production write surface: the order of a create, the child-layout
 * fields, the text auto-resize default, the validation before a create and
 * the cleanup after a failed one, the results, and the asset tools
 * `set_image_fill` and `create_svg`. Each test calls `handleRequest` on a fake
 * file with the write model of `fake-figma.ts`.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { pluginMain, resetFakeFigma } from "./helpers/plugin-globals";
import { installFakeFile, pngHeader } from "./helpers/fake-figma";
import type { InstalledFile } from "./helpers/fake-figma";
import { frame, instance, page, rectangle, solid, text } from "./helpers/nodes";
import type { FakeNode } from "./helpers/nodes";

beforeEach(() => {
  resetFakeFigma();
});

let counter = 0;
const call = (type: string, params: Record<string, unknown> = {}, nodeIds?: string[]) =>
  pluginMain.handleRequest({
    type: type as never,
    requestId: `w${++counter}`,
    params,
    nodeIds,
  });

const dataOf = async (
  type: string,
  params: Record<string, unknown> = {},
  nodeIds?: string[]
): Promise<any> => {
  const response = await call(type, params, nodeIds);
  if (response.error !== undefined) throw new Error(response.error);
  return response.data;
};

const errorOf = async (
  type: string,
  params: Record<string, unknown> = {},
  nodeIds?: string[]
): Promise<string> => {
  const response = await call(type, params, nodeIds);
  if (response.error === undefined) throw new Error(`${type} did not fail`);
  return response.error;
};

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/**
 * A page with a plain frame (`1:2`, holding three rectangles), a text
 * (`1:6`), and an instance (`1:7`) with an image layer (`I1:7;1:8`).
 */
const writePage = (): FakeNode =>
  page("1:1", "Write page", {
    children: [
      frame("1:2", "Plain frame", {
        width: 400,
        height: 300,
        children: [
          rectangle("1:3", "First"),
          rectangle("1:4", "Second"),
          rectangle("1:5", "Third"),
        ],
      }),
      text("1:6", "Caption", [{ start: 0, end: 13, characters: "Short caption" }], {
        width: 104,
        height: 15,
      }),
      instance("1:7", "Product card", null, {
        children: [rectangle("I1:7;1:8", "Photo", { fills: [solid(0.5, 0.5, 0.5)] })],
      }),
    ],
  });

const TEXT_STYLE = {
  id: "S:body,",
  name: "Body",
  type: "TEXT",
  fontName: { family: "Inter", style: "Medium" },
  fontSize: 18,
};

const install = (): InstalledFile =>
  installFakeFile({ pages: [writePage()], writes: {}, textStyles: [TEXT_STYLE] });

/** The IDs of the children of a node, in order. */
const childIds = (file: InstalledFile, id: string): string[] =>
  (file.node(id)?.children ?? []).map((child) => child.id);

const TITLE = "A long product title that wraps across lines";

describe("an auto-layout card", () => {
  test("gets a FILL-width text that wraps and a FILL-width image, and hugs them", async () => {
    const file = install();
    const card = await dataOf("create_frame", {
      name: "Card",
      layoutMode: "VERTICAL",
      padding: 16,
      itemSpacing: 8,
      width: 320,
      layoutSizingVertical: "HUG",
    });
    expect(card).toMatchObject({
      type: "FRAME",
      parentId: "1:1",
      pageId: "1:1",
      width: 320,
      layoutMode: "VERTICAL",
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "HUG",
    });

    const title = await dataOf("create_text", {
      parentId: card.nodeId,
      characters: TITLE,
      fontSize: 16,
      layoutSizingHorizontal: "FILL",
      textAutoResize: "HEIGHT",
    });
    const photo = await dataOf("create_image", {
      parentId: card.nodeId,
      imageBase64: base64(pngHeader(600, 320)),
      width: 300,
      height: 160,
      layoutSizingHorizontal: "FILL",
    });

    // 320 less 16 on each side; the 45 characters of 8 pixels wrap at 36.
    expect(title).toMatchObject({
      parentId: card.nodeId,
      index: 0,
      width: 288,
      height: 40,
      textAutoResize: "HEIGHT",
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "HUG",
      layoutPositioning: "AUTO",
    });
    expect(photo).toMatchObject({
      parentId: card.nodeId,
      index: 1,
      width: 288,
      height: 160,
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "FIXED",
    });
    expect(typeof photo.imageHash).toBe("string");

    const node = file.node(card.nodeId)!;
    expect({
      width: node.width,
      height: node.height,
      paddingTop: node.paddingTop,
      paddingLeft: node.paddingLeft,
      itemSpacing: node.itemSpacing,
      layoutSizingVertical: node.layoutSizingVertical,
    }).toEqual({
      width: 320,
      // 16 + 40 + 8 + 160 + 16
      height: 240,
      paddingTop: 16,
      paddingLeft: 16,
      itemSpacing: 8,
      layoutSizingVertical: "HUG",
    });
    expect(file.node(photo.nodeId)!.y).toBe(64);
  });

  test("a frame with auto layout and no size hugs its content", async () => {
    install();
    const row = await dataOf("create_frame", { layoutMode: "HORIZONTAL", padding: 4 });
    expect(row).toMatchObject({ layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG" });
    const dot = await dataOf("create_shape", {
      shapeType: "ELLIPSE",
      parentId: row.nodeId,
      width: 10,
      height: 10,
    });
    expect(dot).toMatchObject({ x: 4, y: 4, layoutPositioning: "AUTO" });
  });
});

describe("text auto-resize", () => {
  test("create_text with a width alone wraps at it and grows downward", async () => {
    install();
    const made = await dataOf("create_text", { characters: TITLE, fontSize: 16, width: 200 });
    // 25 characters of 8 pixels a line: two lines of 20 pixels.
    expect(made).toMatchObject({ width: 200, height: 40, textAutoResize: "HEIGHT" });
  });

  test("create_text with a width and a height stays as before: fixed", async () => {
    install();
    const made = await dataOf("create_text", {
      characters: "Default",
      textAutoResize: "NONE",
      width: 80,
      height: 20,
      x: 16,
      y: 14,
    });
    expect(made).toMatchObject({ width: 80, height: 20, x: 16, y: 14, textAutoResize: "NONE" });
  });

  test("create_text with no size hugs its text", async () => {
    install();
    const made = await dataOf("create_text", { characters: "Hug", fontSize: 16 });
    expect(made).toMatchObject({ width: 24, height: 20, textAutoResize: "WIDTH_AND_HEIGHT" });
  });

  test("set_text_properties with a width and HEIGHT keeps HEIGHT", async () => {
    const file = install();
    const result = await dataOf("set_text_properties", { width: 40, textAutoResize: "HEIGHT" }, [
      "1:6",
    ]);
    expect(result.applied).toMatchObject({ width: 40, textAutoResize: "HEIGHT" });
    // "Short caption", 13 characters of 6 pixels, wraps at 6 a line.
    expect(file.node("1:6")).toMatchObject({ textAutoResize: "HEIGHT", height: 45 });
  });

  test("set_text_properties refuses an unknown font with the closest families, and writes nothing", async () => {
    const file = install();
    const message = await errorOf("set_text_properties", { fontFamily: "Interr", fontSize: 30 }, [
      "1:6",
    ]);
    expect(message).toContain('fontFamily "Interr" is not available');
    expect(message).toContain('"Inter"');
    expect(file.node("1:6")!.fontSize).toBe(12);
  });

  test("set_text_properties reads the fill back from the node", async () => {
    install();
    const result = await dataOf("set_text_properties", { fillHex: "#FFAA00" }, ["1:6"]);
    expect(result.applied).toMatchObject({ fillHex: "#ffaa00", fillOpacity: 1 });
  });

  test("create_text applies a text style and its font", async () => {
    const file = install();
    const made = await dataOf("create_text", { characters: "Styled", textStyleId: "S:body," });
    expect(file.node(made.nodeId)).toMatchObject({
      textStyleId: "S:body,",
      fontName: { family: "Inter", style: "Medium" },
      fontSize: 18,
    });
    const clash = await errorOf("create_text", { textStyleId: "S:body,", fontSize: 12 });
    expect(clash).toContain("does not go with fontSize");
    expect(await errorOf("create_text", { textStyleId: "S:missing," })).toContain(
      "text style not found"
    );
  });
});

describe("a refused create leaves nothing", () => {
  const nodesOnPage = (file: InstalledFile) => childIds(file, "1:1");

  test("a bad parentId", async () => {
    const file = install();
    const before = nodesOnPage(file);
    const message = await errorOf("create_frame", { parentId: "99:99", width: 10, height: 10 });
    expect(message).toContain("create_frame wrote nothing");
    expect(message).toContain("parentId 99:99");
    expect(file.writes!.created).toEqual([]);
    expect(nodesOnPage(file)).toEqual(before);
  });

  test("an unknown font, with the closest families", async () => {
    const file = install();
    const message = await errorOf("create_text", { characters: "x", fontFamily: "Robotto" });
    expect(message).toContain(
      'fontFamily "Robotto" is not available in Figma. Did you mean "Roboto"?'
    );
    expect(file.writes!.created).toEqual([]);

    const style = await errorOf("create_text", { fontFamily: "Inter", fontStyle: "Black" });
    expect(style).toContain(
      'fontStyle "Black" is not available for "Inter". That family has: Regular, Medium, Bold.'
    );
    expect(file.writes!.created).toEqual([]);
  });

  test("a LINE with fillHex", async () => {
    const file = install();
    const message = await errorOf("create_shape", {
      shapeType: "LINE",
      fillHex: "#000000",
      strokeHex: "#000000",
    });
    expect(message).toContain("LINE shapes do not support fillHex");
    expect(file.writes!.created).toEqual([]);
  });

  test("a Figma refusal after the create removes the node", async () => {
    const file = install();
    const before = nodesOnPage(file);
    // Figma takes a LINE of height 0 only, and throws on another.
    const message = await errorOf("create_shape", {
      shapeType: "LINE",
      strokeHex: "#000000",
      width: 40,
      height: 3,
    });
    expect(message).toContain("The new node was removed");
    expect(file.writes!.created).toHaveLength(1);
    expect(file.writes!.removed).toEqual([file.writes!.created[0].id]);
    expect(nodesOnPage(file)).toEqual(before);
  });
});

describe("child-layout rules", () => {
  test("FILL on a child of a frame without auto layout names the fix, and writes nothing", async () => {
    const file = install();
    const message = await errorOf(
      "set_node_properties",
      { layoutSizingHorizontal: "FILL", name: "x" },
      ["1:3"]
    );
    expect(message).toContain('layoutSizingHorizontal "FILL" needs a parent with auto layout');
    expect(message).toContain("Call set_auto_layout on 1:2 first.");
    expect(file.node("1:3")!.name).toBe("First");

    const create = await errorOf("create_text", {
      parentId: "1:2",
      characters: "x",
      layoutSizingHorizontal: "FILL",
    });
    expect(create).toContain("Call set_auto_layout on 1:2 first.");
    expect(file.writes!.created).toEqual([]);
  });

  test("HUG needs an auto-layout frame or a text, and min/max an auto-layout frame or child", async () => {
    install();
    const message = await errorOf(
      "set_node_properties",
      { layoutSizingVertical: "HUG", minWidth: 10 },
      ["1:3"]
    );
    expect(message).toContain(
      'layoutSizingVertical "HUG" applies to an auto-layout frame or a TEXT node'
    );
    expect(message).toContain("minWidth applies to an auto-layout frame or a direct child of one");
    expect(
      await dataOf("set_node_properties", { layoutSizingVertical: "HUG" }, ["1:6"])
    ).toMatchObject({
      applied: { layoutSizingVertical: "HUG" },
    });
  });

  test("set_node_properties takes the layout fields once the parent has auto layout", async () => {
    const file = install();
    await dataOf("set_auto_layout", { layoutMode: "HORIZONTAL", padding: 10 }, ["1:2"]);
    const result = await dataOf(
      "set_node_properties",
      {
        layoutPositioning: "ABSOLUTE",
        minWidth: 20,
        x: 300,
        y: 5,
      },
      ["1:5"]
    );
    expect(result.applied).toMatchObject({
      layoutPositioning: "ABSOLUTE",
      minWidth: 20,
      x: 300,
      y: 5,
    });
    expect(await errorOf("set_node_properties", { clipsContent: true }, ["1:3"])).toContain(
      "a RECTANGLE node has no clipsContent"
    );
    const fill = await dataOf("set_node_properties", { layoutSizingVertical: "FILL" }, ["1:3"]);
    expect(fill.applied).toEqual({ layoutSizingVertical: "FILL" });
    expect(file.node("1:3")!.height).toBe(280);
  });
});

describe("index", () => {
  test("inserts a new node at the index, and clamps one past the top", async () => {
    const file = install();
    const made = await dataOf("create_shape", {
      shapeType: "RECTANGLE",
      parentId: "1:2",
      index: 1,
    });
    expect(made.index).toBe(1);
    expect(childIds(file, "1:2")).toEqual(["1:3", made.nodeId, "1:4", "1:5"]);

    const top = await dataOf("create_frame", { parentId: "1:2", index: 99 });
    expect(top.index).toBe(4);
  });

  test("reorders a node in place", async () => {
    const file = install();
    const moved = await dataOf("set_node_properties", { index: 0 }, ["1:5"]);
    expect(moved.applied).toEqual({ index: 0 });
    expect(childIds(file, "1:2")).toEqual(["1:5", "1:3", "1:4"]);
    await dataOf("set_node_properties", { index: 50 }, ["1:5"]);
    expect(childIds(file, "1:2")).toEqual(["1:3", "1:4", "1:5"]);
  });
});

describe("results", () => {
  test("a create with none of the new params makes the node it made before", async () => {
    install();
    const made = await dataOf("create_frame", { name: "Plain", x: 10, y: 20 });
    expect(made).toEqual({
      nodeId: made.nodeId,
      nodeName: "Plain",
      type: "FRAME",
      parentId: "1:1",
      pageId: "1:1",
      index: 3,
      x: 10,
      y: 20,
      width: 100,
      height: 100,
      layoutMode: "NONE",
    });
  });

  test("set_auto_layout takes padding and reads each field back", async () => {
    install();
    const result = await dataOf(
      "set_auto_layout",
      { layoutMode: "VERTICAL", padding: 12, paddingTop: 4 },
      ["1:2"]
    );
    expect(result.applied).toEqual({
      layoutMode: "VERTICAL",
      paddingTop: 4,
      paddingRight: 12,
      paddingBottom: 12,
      paddingLeft: 12,
    });
  });

  test("set_solid_fill reads the paint back", async () => {
    install();
    const result = await dataOf("set_solid_fill", { hex: "#F00", opacity: 0.5 }, ["1:3"]);
    expect(result.applied).toEqual({ target: "fill", hex: "#ff0000", opacity: 0.5 });
  });
});

describe("set_image_fill", () => {
  const png = base64(pngHeader(64, 64));

  test("puts an image on an instance layer and reuses its hash", async () => {
    const file = install();
    const first = await dataOf("set_image_fill", {
      items: [{ nodeId: "I1:7;1:8", image: 0, scaleMode: "FIT" }],
      images: [png],
    });
    expect(first.results).toHaveLength(1);
    const { imageHash } = first.results[0];
    expect(first.results[0]).toEqual({ index: 0, ok: true, nodeId: "I1:7;1:8", imageHash });
    expect(file.node("I1:7;1:8")!.fills).toEqual([{ type: "IMAGE", imageHash, scaleMode: "FIT" }]);
    expect(file.node("1:7")!.type).toBe("INSTANCE");

    const again = await dataOf("set_image_fill", {
      items: [{ nodeId: "1:3", imageHash }],
      images: [],
    });
    expect(again.results[0]).toEqual({ index: 0, ok: true, nodeId: "1:3", imageHash });
    expect(file.node("1:3")!.fills).toEqual([{ type: "IMAGE", imageHash, scaleMode: "FILL" }]);
  });

  test("checks every item before the first write", async () => {
    const file = install();
    const message = await errorOf("set_image_fill", {
      items: [
        { nodeId: "1:3", image: 0 },
        { nodeId: "1:4", imageHash: "feedface" },
        { nodeId: "99:1", image: 0 },
        { nodeId: "1:5", image: 1 },
        { nodeId: "1:1", image: 0 },
      ],
      images: [png, base64(pngHeader(5000, 10))],
    });
    expect(message).toContain("set_image_fill wrote nothing");
    expect(message).toContain('items[1]: imageHash "feedface" is no image of this file');
    expect(message).toContain("items[2]: node not found: 99:1");
    expect(message).toContain("items[3]: Figma refused the image: Image is too large");
    expect(message).toContain('items[4]: 1:1 "Write page" is a page');
    expect(message).not.toContain("items[0]");
    expect(file.node("1:3")!.fills).toEqual([]);
  });
});

describe("create_svg", () => {
  const ICON =
    '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2 2h20v20H2z"/></svg>';

  test("creates the icon and scales it by width, in an auto-layout row", async () => {
    const file = install();
    await dataOf("set_auto_layout", { layoutMode: "HORIZONTAL", itemSpacing: 4 }, ["1:2"]);
    const made = await dataOf("create_svg", {
      svg: ICON,
      name: "icon/star",
      parentId: "1:2",
      index: 0,
      width: 48,
    });
    expect(made).toMatchObject({
      nodeName: "icon/star",
      type: "FRAME",
      parentId: "1:2",
      index: 0,
      width: 48,
      height: 48,
      layoutPositioning: "AUTO",
    });
    expect(file.node(made.nodeId)!.children![0].width).toBe(48);
  });

  test("scales by height when no width is given, and refuses markup Figma cannot read", async () => {
    const file = install();
    const made = await dataOf("create_svg", { svg: ICON, height: 12 });
    expect(made).toMatchObject({ width: 12, height: 12, parentId: "1:1" });
    expect(await errorOf("create_svg", { svg: "<div>no</div>" })).toContain(
      "Figma could not read svg"
    );
    expect(await errorOf("create_svg", { svg: ICON, parentId: "99:9" })).toContain("parentId 99:9");
    // Neither refusal reached createNodeFromSvg's node: only the first icon exists.
    expect(file.writes!.created).toHaveLength(1);
  });
});
