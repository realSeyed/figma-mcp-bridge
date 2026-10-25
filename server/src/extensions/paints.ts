import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../node.js";
import { createFigmaNodeIdSchema, fileKeyField } from "../schema-common.js";
import { parseToolInput, renderResponse } from "../tool-helpers.js";
import type { ToolResult } from "../tool-helpers.js";
import type { ExtensionRpcMap, ExtensionSchemaMap } from "./types.js";

/**
 * Paint tools.
 *
 * Import only from `schema-common.js`, `tool-helpers.js`, packages, and types.
 * Importing `schema.js` or `tools.js` here would close an import cycle.
 */

const TOOL = "clear_paints";

/** The most nodes one clear_paints call accepts. */
const MAX_NODES_PER_CALL = 200;

/**
 * The form of `clear_paints`. The plain object feeds `server.tool`, which takes
 * `.shape` and would lose it behind a refinement; the refined schema parses.
 */
const clearPaintsShape = z.object({
  nodeIds: z
    .array(createFigmaNodeIdSchema())
    .min(1)
    .max(MAX_NODES_PER_CALL)
    .describe(
      "1 to 200 nodes to clear, each once. Top-level IDs such as '4029:12345' and instance-child IDs such as 'I12740:17806;12740:17793'."
    ),
  target: z
    .enum(["fills", "strokes"])
    .optional()
    .describe("Which paint list to empty: fills or strokes. fills."),
  fileKey: fileKeyField,
});

const clearPaintsInput = clearPaintsShape.superRefine((value, ctx) => {
  const first = new Map<string, number>();
  const repeats: string[] = [];
  value.nodeIds.forEach((id, index) => {
    const earlier = first.get(id);
    if (earlier === undefined) first.set(id, index);
    else repeats.push(`nodeIds[${index}]: ${id} repeats nodeIds[${earlier}]`);
  });
  if (repeats.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nodeIds"],
      message: `${TOOL} takes each node once. ${repeats.join("; ")}. Remove the repeated IDs.`,
    });
  }
});

/** Tool name to Zod object schema. Spread into `toolInputSchemas`. */
export const schemas = {
  clear_paints: clearPaintsInput,
} satisfies ExtensionSchemaMap;

/** Tool name to RPC wire mapper. Spread into `rpcToArgs`. */
export const rpcToArgs = {
  clear_paints: (nodeIds, params) => ({ nodeIds, ...params }),
} satisfies ExtensionRpcMap;

/**
 * Registers this area's tools.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 */
export function register(server: McpServer, node: Node): void {
  server.tool(
    TOOL,
    'Set the whole fills list, or the whole strokes list, of up to 200 nodes to an empty list, which removes every paint of that list. The answer holds one entry per node, in input order, with previous: the paint list the node carried before, with each paint\'s type, colour, and opacity, visible: false on a hidden paint, and the variable it was bound to; previousCount, which counts every paint including the types previous leaves out; previousStyleId, the paint style the list was linked to; and for a text node whose fills differ per range, previous is "mixed" and previousSegments lists the fills of each range. A bound variable goes with its paint, and the variable itself stays in the file. A paint style link goes with the list. On an instance sublayer the write is an override, and the instance stays an instance. Every item is checked before the first write: a batch with a bad item writes nothing and reports every item to correct. Afterwards get_node shows no fills field (or no strokes field) on the node: a missing field is the empty list. When multiple files are connected, specify fileKey.',
    clearPaintsShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(clearPaintsInput, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeIds, target } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams(TOOL, nodeIds, { target: target ?? "fills" }, fileKey)
      );
    }
  );
}
