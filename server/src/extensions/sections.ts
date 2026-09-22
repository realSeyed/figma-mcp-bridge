import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../node.js";
import { createFigmaNodeIdSchema, fileKeyField } from "../schema-common.js";
import { parseToolInput, renderResponse } from "../tool-helpers.js";
import type { ToolResult } from "../tool-helpers.js";
import type { ExtensionRpcMap, ExtensionSchemaMap } from "./types.js";

/**
 * Section tools.
 *
 * Import only from `schema-common.js`, `tool-helpers.js`, packages, and types.
 * Importing `schema.js` or `tools.js` here would close an import cycle.
 */

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
} satisfies ExtensionSchemaMap;

/** Tool name to RPC wire mapper. Spread into `rpcToArgs`. */
export const rpcToArgs = {
  list_sections: (_nodeIds, params) => ({ ...params }),
  get_section: (nodeIds, params) => ({ ...params, nodeId: nodeIds?.[0] }),
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
}
