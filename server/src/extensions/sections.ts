import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../node.js";
import { createFigmaNodeIdSchema, createHexColorSchema, fileKeyField } from "../schema-common.js";
import { parseToolInput, renderResponse } from "../tool-helpers.js";
import type { ToolResult } from "../tool-helpers.js";
import type { ExtensionRpcMap, ExtensionSchemaMap } from "./types.js";

/**
 * Section tools.
 *
 * Import only from `schema-common.js`, `tool-helpers.js`, packages, and types.
 * Importing `schema.js` or `tools.js` here would close an import cycle.
 */

/** The most nodes one create_section or move_to_section call takes. */
const MAX_NODES_PER_CALL = 200;

/**
 * The two forms of `create_section`: wrapping existing nodes, or building an
 * empty section from a size.
 *
 * `server.tool` takes the object's `.shape`, which a refinement would hide, so
 * the plain object and the refined schema are kept apart.
 */
const createSectionShape = z.object({
  nodeIds: z
    .array(createFigmaNodeIdSchema())
    .min(1)
    .max(MAX_NODES_PER_CALL)
    .optional()
    .describe(
      "1 to 200 nodes to wrap in a new section, all sharing one parent. Give this, or width and height."
    ),
  padding: z
    .number()
    .min(0)
    .optional()
    .describe("Margin left around the wrapped nodes, in pixels, defaulting to 80. Takes nodeIds."),
  width: z.number().min(0.01).optional().describe("Width of a new empty section, in pixels"),
  height: z.number().min(0.01).optional().describe("Height of a new empty section, in pixels"),
  name: z.string().min(1).optional().describe("The section name"),
  parentId: createFigmaNodeIdSchema()
    .optional()
    .describe(
      "The page or the section to put the new section in, defaulting to the current page. A frame, a group, a component, and an instance are refused. Takes no nodeIds."
    ),
  x: z
    .number()
    .optional()
    .describe("Position on the x axis, within the parent, defaulting to 0. Takes no nodeIds."),
  y: z
    .number()
    .optional()
    .describe("Position on the y axis, within the parent, defaulting to 0. Takes no nodeIds."),
  fillHex: createHexColorSchema()
    .optional()
    .describe("Background of the section, e.g. '#F5F5F5'. Without it, Figma's own is kept."),
  fileKey: fileKeyField,
});

const createSectionInput = createSectionShape
  .refine(
    (value) =>
      value.nodeIds !== undefined || (value.width !== undefined && value.height !== undefined),
    "create_section needs nodeIds to wrap existing nodes, or width and height to make an empty section"
  )
  .refine(
    (value) =>
      value.nodeIds === undefined ||
      (value.width === undefined &&
        value.height === undefined &&
        value.parentId === undefined &&
        value.x === undefined &&
        value.y === undefined),
    "create_section takes nodeIds, or parentId, x, y, width, and height, not both: the wrapped nodes decide where the section goes and how big it is"
  )
  .refine(
    (value) => value.nodeIds !== undefined || value.padding === undefined,
    "create_section takes padding only with nodeIds: padding is the margin left around the wrapped nodes"
  );

/**
 * `move_to_section`, whose `padding` belongs to its `fit` form.
 *
 * As above, `server.tool` takes the object's `.shape`, which a refinement
 * would hide, so the plain object and the refined schema are kept apart.
 */
const moveToSectionShape = z.object({
  sectionId: createFigmaNodeIdSchema().describe("The section to move the nodes into"),
  nodeIds: z
    .array(createFigmaNodeIdSchema())
    .min(1)
    .max(MAX_NODES_PER_CALL)
    .describe("1 to 200 nodes to move into the section. Every one must be on the section's page."),
  fit: z
    .boolean()
    .optional()
    .describe(
      "Size the section to what it then holds, as fit_section does. Defaults to false, which leaves the section's box alone."
    ),
  padding: z
    .number()
    .min(0)
    .optional()
    .describe("Margin the fit leaves on each side, in pixels, defaulting to 80. Takes fit: true."),
  fileKey: fileKeyField,
});

const moveToSectionInput = moveToSectionShape.refine(
  (value) => value.fit === true || value.padding === undefined,
  "move_to_section takes padding only with fit: true: padding is the margin the fit leaves around the children"
);

/** Tool name to Zod object schema. Spread into `toolInputSchemas`. */
export const schemas = {
  list_sections: z.object({
    scope: z
      .enum(["currentPage", "allPages"])
      .optional()
      .describe(
        "Which sections to list: currentPage reads the page open in Figma, allPages the whole file. Defaults to currentPage."
      ),
    query: z
      .string()
      .optional()
      .describe("Keeps the sections whose name contains this text, ignoring case"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("How many items to return, defaulting to 100"),
    fileKey: fileKeyField,
  }),

  get_section: z.object({
    nodeId: createFigmaNodeIdSchema().describe("The section to read"),
    fileKey: fileKeyField,
  }),

  create_section: createSectionInput,

  move_to_section: moveToSectionInput,

  move_out_of_section: z.object({
    nodeIds: z
      .array(createFigmaNodeIdSchema())
      .min(1)
      .max(MAX_NODES_PER_CALL)
      .describe("1 to 200 nodes to lift out of the sections holding them"),
    fileKey: fileKeyField,
  }),

  fit_section: z.object({
    nodeId: createFigmaNodeIdSchema().describe("The section to fit around its children"),
    padding: z
      .number()
      .min(0)
      .optional()
      .describe("Margin left around the children on each side, in pixels, defaulting to 80"),
    fileKey: fileKeyField,
  }),
} satisfies ExtensionSchemaMap;

/** Tool name to RPC wire mapper. Spread into `rpcToArgs`. */
export const rpcToArgs = {
  list_sections: (_nodeIds, params) => ({ ...params }),
  get_section: (nodeIds, params) => ({ ...params, nodeId: nodeIds?.[0] }),
  create_section: (nodeIds, params) => ({ nodeIds, ...params }),
  move_to_section: (nodeIds, params) => ({ nodeIds, ...params }),
  move_out_of_section: (nodeIds, params) => ({ nodeIds, ...params }),
  fit_section: (nodeIds, params) => ({ ...params, nodeId: nodeIds?.[0] }),
} satisfies ExtensionRpcMap;

/**
 * Registers this area's tools.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 */
export function register(server: McpServer, node: Node): void {
  server.tool(
    "list_sections",
    'List the sections of the current page, or of the whole file with scope: "allPages". Each item carries its ID, name, page, position, size, how many children it holds, and whether its contents are hidden. A section nested inside another reports the section that holds it as parentSectionId and how deeply it is nested as depth, so one call is enough to see the shape of the file: sections come back by page, then in document order, so a nested section follows its parent. Filter by name with query, and cap the list with limit; truncated says whether more matched than were returned. When multiple files are connected, specify fileKey.',
    schemas.list_sections.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.list_sections, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("list_sections", undefined, params, fileKey));
    }
  );

  server.tool(
    "get_section",
    "Read one section: where it sits on its page and on the canvas, whether its contents are hidden, and its direct children with their position, size, and visibility. A section does not clip and does not move its children when it resizes, so what it holds and where it is drawn can come apart: contentBounds is the box the visible children really occupy, relative to the section, and overflowIds names the visible children hanging outside its edges, with overflowCount saying how many there are. Both are measured over every visible child, while children and overflowIds each list at most 200; truncated says the section has more than 200 direct children. Call list_sections first to find the ID. When multiple files are connected, specify fileKey.",
    schemas.get_section.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.get_section, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeId } = parsed.data;
      return renderResponse(() => node.sendWithParams("get_section", [nodeId], {}, fileKey));
    }
  );
  server.tool(
    "create_section",
    "Create a section: Figma's top-level container for organising a page. Give width and height for an empty one, or nodeIds to wrap nodes that are already there. Wrapping keeps every node exactly where it is on the canvas and in the stack, and sizes the section to the nodes plus padding, so the page looks the same afterwards. The nodes must share one parent, and that parent must be a page or another section — Figma keeps a section outside the frame tree, so nothing inside a frame, a group, a component, or an instance can be wrapped where it stands, and parentId, x, y, width, and height belong to the empty form only. Every node is checked before the first write, and a write that fails afterwards is undone: the nodes go back to their old parent, stack position, and position, and the section is removed. When multiple files are connected, specify fileKey.",
    createSectionShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(createSectionInput, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeIds, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("create_section", nodeIds, params, fileKey));
    }
  );

  server.tool(
    "move_to_section",
    "Move nodes into a section, leaving every one of them exactly where it is on the canvas. Only a section's own page supplies its children, so each node must already be on that page; move it across first if it is not. A node that already hangs off the section is reported with unchanged: true and left alone, so a second call is a no-op, and the nodes that do move land on top of what the section holds, in the order the page drew them. Refused: the section itself, anything holding it, a layer of an instance, and a variant, which only ever sits in its set — pass the set instead. Every node is checked before the first write, so a refusal moves nothing. With fit: true the section is then sized to what it holds, as fit_section does. results gives each node's position relative to the section, and section its box after the call. When multiple files are connected, specify fileKey.",
    moveToSectionShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(moveToSectionInput, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeIds, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("move_to_section", nodeIds, params, fileKey));
    }
  );

  server.tool(
    "move_out_of_section",
    "Lift nodes out of the sections holding them, one level, leaving every one of them exactly where it is on the canvas. Each node rises to whatever holds its section — the page, or the section around it — and lands directly above that section in the stack, where the eye expects it; nodes that came from one section keep the order they had inside it. Every node's parent must be a section: to take a node out of a frame, a group, or a component, call reparent_nodes instead. Nodes from several sections travel in one call, each to its own destination. Every node is checked before the first write, so a refusal moves nothing. When multiple files are connected, specify fileKey.",
    schemas.move_out_of_section.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.move_out_of_section, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeIds } = parsed.data;
      return renderResponse(() => node.sendWithParams("move_out_of_section", nodeIds, {}, fileKey));
    }
  );

  server.tool(
    "fit_section",
    "Draw a section tight around the children it holds, leaving padding on each side. A section is the one container that does not carry its children when it resizes, so its box and the box of its content drift apart as the content is edited; this pulls the two back together. Nothing moves on the canvas: the section takes the box of its visible content, and every child is slid back by the distance the section travelled, so the page looks the same afterwards and only the section's own frame changes. Hidden children are left out of the measurement but still slide back. A section with no visible child is refused, since there would be nothing to measure. When multiple files are connected, specify fileKey.",
    schemas.fit_section.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.fit_section, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeId, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("fit_section", [nodeId], params, fileKey));
    }
  );
}
