import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../node.js";
import { loadImageSource } from "../image-source.js";
import {
  createChildLayoutFields,
  createFigmaNodeIdSchema,
  createParentIdSchema,
  fileKeyField,
} from "../schema-common.js";
import { parseToolInput, renderResponse } from "../tool-helpers.js";
import type { ToolResult } from "../tool-helpers.js";
import type { ExtensionRpcMap, ExtensionRpcSchemaMap, ExtensionSchemaMap } from "./types.js";

/**
 * Asset tools: image fills on existing nodes, and SVG icons.
 *
 * Import only from `schema-common.js`, `tool-helpers.js`, `image-source.js`,
 * packages, and types. Importing `schema.js` or `tools.js` here would close an
 * import cycle.
 */

/** The most items one set_image_fill call accepts. */
const MAX_FILL_ITEMS = 50;

/** The longest SVG markup create_svg accepts. */
const MAX_SVG_CHARS = 200_000;

/**
 * The advertised form of `set_image_fill`. The plain object feeds
 * `server.tool`, which takes `.shape`; the refined schema parses.
 */
const setImageFillShape = z.object({
  items: z
    .array(
      z.object({
        nodeId: createFigmaNodeIdSchema().describe(
          "The node to fill: a frame, a shape, or a layer of an instance (an override). Top-level IDs such as '4029:12345' and instance-child IDs such as 'I12740:17806;12740:17793'."
        ),
        source: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A new image: an http/https URL, a base64 data URI, or a local path inside the working directory, the output root, or a folder of FIGMA_BRIDGE_ASSET_ROOT. PNG, JPEG, or GIF of at most 4096 pixels per side."
          ),
        imageHash: z
          .string()
          .min(1)
          .optional()
          .describe(
            "An image this file already holds: the imageHash a create_image or set_image_fill result returned"
          ),
        scaleMode: z
          .enum(["FILL", "FIT"])
          .optional()
          .describe("FILL (default) crops the image to cover the node; FIT shows it whole"),
      })
    )
    .min(1)
    .max(MAX_FILL_ITEMS)
    .describe(
      "1 to 50 nodes, each once, with exactly one of source and imageHash. Items with the same source load it one time."
    ),
  fileKey: fileKeyField,
});

const setImageFillInput = setImageFillShape.superRefine((value, ctx) => {
  const first = new Map<string, number>();
  value.items.forEach((item, index) => {
    if ((item.source === undefined) === (item.imageHash === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index],
        message: `items[${index}]: give exactly one of source and imageHash: source for a new image, imageHash to reuse one this file already holds.`,
      });
    }
    const earlier = first.get(item.nodeId);
    if (earlier === undefined) first.set(item.nodeId, index);
    else
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "nodeId"],
        message: `items[${index}]: ${item.nodeId} repeats items[${earlier}]. Name each node once.`,
      });
  });
});

/**
 * The wire form of `set_image_fill` on the follower to leader path: the
 * handler loaded each distinct `source` into `images`, and an item names its
 * image by index there.
 */
const setImageFillRpcInput = z
  .object({
    items: z
      .array(
        z.object({
          nodeId: createFigmaNodeIdSchema().describe("The node to fill"),
          image: z.number().int().min(0).optional().describe("Index into images"),
          imageHash: z.string().min(1).optional().describe("An image this file holds"),
          scaleMode: z.enum(["FILL", "FIT"]).optional().describe("FILL or FIT"),
        })
      )
      .min(1)
      .max(MAX_FILL_ITEMS)
      .describe("The items, each with image or imageHash"),
    images: z
      .array(z.string().min(1))
      .describe("The base64 bytes of each distinct source, loaded by the handler"),
  })
  .superRefine((value, ctx) => {
    value.items.forEach((item, index) => {
      if ((item.image === undefined) === (item.imageHash === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index],
          message: `items[${index}] needs exactly one of image and imageHash`,
        });
      } else if (item.image !== undefined && item.image >= value.images.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "image"],
          message: `items[${index}].image ${item.image} is past the end of images (${value.images.length})`,
        });
      }
    });
  });

const createSvgShape = z.object({
  svg: z
    .string()
    .min(1)
    .max(MAX_SVG_CHARS)
    .describe("The markup of one <svg> element, at most 200,000 characters: an icon or a logo"),
  name: z.string().optional().describe("Optional node name, such as 'icon/search'"),
  parentId: createParentIdSchema(),
  x: z.number().optional().describe("Optional x position; ignored inside an auto-layout flow"),
  y: z.number().optional().describe("Optional y position; ignored inside an auto-layout flow"),
  width: z
    .number()
    .positive()
    .optional()
    .describe("Scales the icon to this width, keeping its proportions; wins over height"),
  height: z
    .number()
    .positive()
    .optional()
    .describe("Scales the icon to this height, keeping its proportions"),
  ...createChildLayoutFields(),
  fileKey: fileKeyField,
});

/** Tool name to Zod schema. Spread into `toolInputSchemas`. */
export const schemas = {
  set_image_fill: setImageFillInput,
  create_svg: createSvgShape,
} satisfies ExtensionSchemaMap;

/** Tool name to wire schema. Spread into `rpcInputSchemas`. */
export const rpcSchemas = {
  set_image_fill: setImageFillRpcInput,
} satisfies ExtensionRpcSchemaMap;

/** Tool name to RPC wire mapper. Spread into `rpcToArgs`. */
export const rpcToArgs = {
  set_image_fill: (_nodeIds, params) => ({ ...params }),
  create_svg: (_nodeIds, params) => ({ ...params }),
} satisfies ExtensionRpcMap;

/** A refused call, as a tool error. */
const toolError = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/**
 * Registers this area's tools.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 */
export function register(server: McpServer, node: Node): void {
  server.tool(
    "set_image_fill",
    "Put an image fill on up to 50 existing nodes: a product photo into the image layer of a component instance (an override; the instance stays an instance), a frame, or a shape. Each item gives a source (URL, base64 data URI, or local path) or the imageHash of an image the file already holds. Each distinct source loads one time and must be a PNG, JPEG, or GIF of at most 4096 pixels per side; another format or a larger image is refused before anything is sent. Every item is checked before the first write: a call with a bad item writes nothing and lists each item to correct. The write replaces the node's fills with the one image. The result has one entry per item, { index, ok, nodeId, imageHash }; reuse imageHash to put the same image elsewhere without loading it again. When multiple files are connected, specify fileKey.",
    setImageFillShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(setImageFillInput, args);
      if (!parsed.success) return parsed.error;
      const { items, fileKey } = parsed.data;

      // Each distinct source loads one time, and every one before the first
      // write: a bad source refuses the call with the items that name it.
      const images: string[] = [];
      const indexOf = new Map<string, number | Error>();
      const problems: string[] = [];
      for (const [index, item] of items.entries()) {
        if (item.source === undefined) continue;
        let loaded = indexOf.get(item.source);
        if (loaded === undefined) {
          try {
            images.push((await loadImageSource(item.source)).base64);
            loaded = images.length - 1;
          } catch (err) {
            loaded = err instanceof Error ? err : new Error(String(err));
          }
          indexOf.set(item.source, loaded);
        }
        if (loaded instanceof Error) problems.push(`items[${index}].source: ${loaded.message}`);
      }
      if (problems.length > 0) {
        return toolError(
          `set_image_fill wrote nothing. Correct these items and call it again:\n${problems.join("\n")}`
        );
      }

      const wire = items.map((item) => ({
        nodeId: item.nodeId,
        ...(item.source !== undefined
          ? { image: indexOf.get(item.source) as number }
          : { imageHash: item.imageHash }),
        scaleMode: item.scaleMode ?? "FILL",
      }));
      return renderResponse(() =>
        node.sendWithParams("set_image_fill", undefined, { items: wire, images }, fileKey)
      );
    }
  );

  server.tool(
    "create_svg",
    "Place an SVG icon or logo as a vector frame, as Figma's SVG import does. width or height scales it proportionally (width wins). Takes the child-layout fields and index of the create tools, so an icon can sit in an auto-layout row. The parent and the layout fields are checked first, and markup Figma cannot read leaves nothing. Pass parentId. Without it the node goes to the page the user is viewing; pageId in the result tells you where it went. Returns { nodeId, nodeName, type, parentId, pageId, index, x, y, width, height } and the layout state. When multiple files are connected, specify fileKey.",
    createSvgShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(createSvgShape, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("create_svg", undefined, params, fileKey));
    }
  );
}
