import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../node.js";
import { fileKeyField } from "../schema-common.js";
import { parseToolInput, renderResponse } from "../tool-helpers.js";
import type { ToolResult } from "../tool-helpers.js";
import type { ExtensionRpcMap, ExtensionSchemaMap } from "./types.js";

/**
 * Variable and variable-collection tools.
 *
 * Import only from `schema-common.js`, `tool-helpers.js`, packages, and types.
 * Importing `schema.js` or `tools.js` here would close an import cycle.
 */

/**
 * Creates a Zod schema that validates a variable collection ID.
 * @returns A Zod string schema for collection IDs.
 */
const createCollectionIdSchema = () =>
  z
    .string()
    .regex(
      /^VariableCollectionId:.+$/,
      "Collection ID must start with 'VariableCollectionId:' — use an ID from get_variable_defs"
    );

const collectionIdField = createCollectionIdSchema().describe(
  "The variable collection ID, as reported by get_variable_defs"
);

/** Tool name to Zod object schema. Spread into `toolInputSchemas`. */
export const schemas = {
  create_variable_collection: z.object({
    name: z.string().min(1).describe("Name of the new collection"),
    fileKey: fileKeyField,
  }),

  update_variable_collection: z.object({
    collectionId: collectionIdField,
    name: z.string().min(1).describe("The new collection name"),
    fileKey: fileKeyField,
  }),

  delete_variable_collection: z.object({
    collectionId: collectionIdField,
    confirm: z.boolean().describe("Must be true to confirm deletion"),
    fileKey: fileKeyField,
  }),
} satisfies ExtensionSchemaMap;

/** Tool name to RPC wire mapper. Spread into `rpcToArgs`. */
export const rpcToArgs = {
  create_variable_collection: (_nodeIds, params) => ({ ...params }),
  update_variable_collection: (_nodeIds, params) => ({ ...params }),
  delete_variable_collection: (_nodeIds, params) => ({ ...params }),
} satisfies ExtensionRpcMap;

/**
 * Registers this area's tools.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 */
export function register(server: McpServer, node: Node): void {
  server.tool(
    "create_variable_collection",
    "Create a local variable collection to hold design tokens. Figma gives the new collection one mode and returns its defaultModeId; create_variables writes values to that mode. Adding further modes requires a paid Figma plan and is not supported. When multiple files are connected, specify fileKey.",
    schemas.create_variable_collection.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.create_variable_collection, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("create_variable_collection", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "update_variable_collection",
    "Rename a local variable collection. Nothing else about the collection changes. When multiple files are connected, specify fileKey.",
    schemas.update_variable_collection.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.update_variable_collection, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("update_variable_collection", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "delete_variable_collection",
    "Delete a local variable collection and every variable in it. This is destructive and requires confirm: true. Nodes bound to one of those variables keep their last resolved value. When multiple files are connected, specify fileKey.",
    schemas.delete_variable_collection.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.delete_variable_collection, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("delete_variable_collection", undefined, params, fileKey)
      );
    }
  );
}
