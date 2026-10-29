import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../node.js";
import { createFigmaNodeIdSchema, fileKeyField } from "../schema-common.js";
import { parseToolInput, renderResponse } from "../tool-helpers.js";
import type { ToolResult } from "../tool-helpers.js";
import type { ExtensionRpcMap, ExtensionSchemaMap } from "./types.js";

/**
 * Discovery tools: `find_nodes` and `get_design_system`. Both are reads, on
 * `READ_ONLY_REQUESTS`, and not on `AUDITOR_TOOLS`.
 *
 * Import only from `schema-common.js`, `tool-helpers.js`, packages, and types.
 * Importing `schema.js` or `tools.js` here would close an import cycle.
 */

/** The node types `find_nodes` takes. The plugin checks the same list. */
const FINDABLE_TYPES = [
  "FRAME",
  "TEXT",
  "INSTANCE",
  "COMPONENT",
  "COMPONENT_SET",
  "SECTION",
  "GROUP",
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "POLYGON",
] as const;

/** The parts `get_design_system` reports. */
const DESIGN_SYSTEM_PARTS = [
  "variables",
  "textStyles",
  "paintStyles",
  "effectStyles",
  "components",
] as const;

/**
 * `server.tool` takes the object's `.shape`, which a refinement would hide, so
 * the plain object and the refined schema are kept apart.
 */
const findNodesShape = z.object({
  name: z
    .string()
    .min(1)
    .optional()
    .describe("A part of the layer name, ignoring case. With exactName, the whole name."),
  types: z
    .array(z.enum(FINDABLE_TYPES))
    .min(1)
    .optional()
    .describe("Only nodes of these types. Give this, name, or both."),
  exactName: z
    .boolean()
    .optional()
    .describe("When true, name must match the whole layer name, with its case"),
  withinId: createFigmaNodeIdSchema()
    .optional()
    .describe("The page or the node to search in, defaulting to the current page"),
  allPages: z
    .boolean()
    .optional()
    .describe("When true, search every page of the file. Ignored with withinId. Slower."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("The most nodes to return, 1 to 500 (default 50)"),
  fileKey: fileKeyField,
});

const findNodesInput = findNodesShape.refine(
  (value) => value.name !== undefined || value.types !== undefined,
  "find_nodes needs name, types, or both: a part of the layer name, or a list of node types"
);

export const schemas = {
  find_nodes: findNodesInput,
  get_design_system: z.object({
    include: z
      .array(z.enum(DESIGN_SYSTEM_PARTS))
      .min(1)
      .optional()
      .describe(
        "The parts to report: variables, textStyles, paintStyles, effectStyles, components. Default: all of them."
      ),
    fileKey: fileKeyField,
  }),
} satisfies ExtensionSchemaMap;

export const rpcToArgs = {
  find_nodes: (_nodeIds, params) => ({ ...params }),
  get_design_system: (_nodeIds, params) => ({ ...params }),
} satisfies ExtensionRpcMap;

/**
 * Registers the discovery tools.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 */
export function register(server: McpServer, node: Node): void {
  server.tool(
    "find_nodes",
    "Find nodes by a part of their name, by type, or both, in document order: the cheap way to get a node ID back without reading a page. Searches the current page, withinId, or with allPages the whole file. Returns { items, truncated }; each item has id, name, type, pageId, parentId, x, y, width, height, visible: false for a hidden node, and the first 80 characters of a text. truncated is true when limit (default 50) or the 35000-character budget cut the list. When multiple files are connected, specify fileKey.",
    findNodesShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(findNodesInput, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("find_nodes", undefined, params, fileKey), {
        tool: "find_nodes",
      });
    }
  );

  server.tool(
    "get_design_system",
    "Learn in one call what a file holds to reuse: its local variables with the default-mode value (hex for a color, { alias } for an alias), its text styles (font, size, line height, letter spacing), its paint styles (hex for one solid paint), its effect styles, and its local components across all pages with their variant and component properties. counts holds the size of each list. The answer stays within 35000 characters: the longest list is cut first, and truncated is set. Use include to read only some parts. When multiple files are connected, specify fileKey.",
    schemas.get_design_system.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.get_design_system, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(
        () => node.sendWithParams("get_design_system", undefined, params, fileKey),
        { tool: "get_design_system" }
      );
    }
  );
}
