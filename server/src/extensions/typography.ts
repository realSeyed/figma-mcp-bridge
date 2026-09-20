import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../node.js";
import {
  createFigmaNodeIdSchema,
  createTextStyleIdSchema,
  createVariableIdSchema,
  fileKeyField,
} from "../schema-common.js";
import { parseToolInput, renderResponse } from "../tool-helpers.js";
import type { ToolResult } from "../tool-helpers.js";
import type { ExtensionRpcMap, ExtensionSchemaMap } from "./types.js";

/**
 * Text style tools.
 *
 * Import only from `schema-common.js`, `tool-helpers.js`, packages, and types.
 * Importing `schema.js` or `tools.js` here would close an import cycle.
 */

const styleIdField = createTextStyleIdSchema().describe(
  "The text style ID, as reported by get_styles"
);

/**
 * A line height.
 *
 * `value` is optional here because the AUTO form carries none. A union of the
 * two forms would report only "Invalid input" when both branches fail, which
 * buries the reason; the plugin checks the pair and answers with the cause and
 * the correction instead.
 */
const lineHeightField = z
  .object({
    unit: z.enum(["AUTO", "PIXELS", "PERCENT"]),
    value: z.number().min(0).optional().describe("Required for PIXELS and PERCENT, omit for AUTO"),
  })
  .describe(
    'Line height: { "unit": "AUTO" } for the line height of the font itself, or { "unit": "PIXELS" | "PERCENT", "value": <number> }'
  );

const letterSpacingField = z
  .object({
    unit: z.enum(["PIXELS", "PERCENT"]),
    value: z.number().describe("May be negative to tighten the text"),
  })
  .describe('Letter spacing: { "unit": "PIXELS" | "PERCENT", "value": <number> }');

const styleVariableIdField = createVariableIdSchema()
  .nullable()
  .optional()
  .describe("The variable to bind, or null to remove the binding from this field");

/**
 * The variables driving the fields of a text style.
 *
 * Strict so a field name that is not bindable comes back named, rather than
 * being dropped and leaving the caller to wonder why nothing changed.
 */
const styleBoundVariablesField = z
  .object({
    fontFamily: styleVariableIdField,
    fontStyle: styleVariableIdField,
    fontSize: styleVariableIdField,
    fontWeight: styleVariableIdField,
    letterSpacing: styleVariableIdField,
    lineHeight: styleVariableIdField,
    paragraphSpacing: styleVariableIdField,
    paragraphIndent: styleVariableIdField,
  })
  .strict()
  .describe(
    "Variables to drive the fields of this style. fontFamily and fontStyle take a STRING variable, every other field a FLOAT variable. A field set to null loses its binding and keeps its last value."
  );

/** The optional style fields both create_text_style and update_text_style take. */
const styleFields = {
  lineHeight: lineHeightField.optional(),
  letterSpacing: letterSpacingField.optional(),
  paragraphSpacing: z.number().min(0).optional().describe("Space below each paragraph, in pixels"),
  paragraphIndent: z
    .number()
    .min(0)
    .optional()
    .describe("Indent of the first line of each paragraph, in pixels"),
  textCase: z
    .enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"])
    .optional()
    .describe("Letter case Figma renders the text in"),
  textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
  leadingTrim: z
    .enum(["NONE", "CAP_HEIGHT"])
    .optional()
    .describe("CAP_HEIGHT trims the space above the caps and below the baseline"),
  description: z.string().optional().describe("Description, shown beside the style in Figma"),
  boundVariables: styleBoundVariablesField.optional(),
};

const updateTextStyleShape = z.object({
  styleId: styleIdField,
  name: z
    .string()
    .min(1)
    .optional()
    .describe("A new name. Must not already name another local text style."),
  fontFamily: z
    .string()
    .min(1)
    .optional()
    .describe("A font family Figma has. Call list_fonts to see them."),
  fontStyle: z
    .string()
    .min(1)
    .optional()
    .describe("A style of that family, for example 'Regular' or 'Bold'"),
  fontSize: z.number().min(1).optional().describe("Font size in pixels"),
  ...styleFields,
  fileKey: fileKeyField,
});

/**
 * An update with nothing to change would report success while writing nothing,
 * so it is refused at the edge. `server.tool` takes the object's `.shape`, which
 * a refinement would hide, so the two are kept apart.
 */
const updateTextStyleInput = updateTextStyleShape.refine(
  (value) =>
    value.name !== undefined ||
    value.fontFamily !== undefined ||
    value.fontStyle !== undefined ||
    value.fontSize !== undefined ||
    Object.keys(styleFields).some(
      (field) => (value as Record<string, unknown>)[field] !== undefined
    ),
  "update_text_style needs at least one of name, fontFamily, fontStyle, fontSize, or a style field to change"
);

/** Tool name to Zod object schema. Spread into `toolInputSchemas`. */
export const schemas = {
  list_fonts: z.object({
    query: z
      .string()
      .optional()
      .describe("Keeps the families whose name contains this text, ignoring case"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("How many families to return, defaulting to 50"),
    fileKey: fileKeyField,
  }),

  create_text_style: z.object({
    name: z
      .string()
      .min(1)
      .describe(
        "Style name. A '/' makes a group, e.g. 'Body/Small'. Must not name a local text style already."
      ),
    fontFamily: z.string().min(1).describe("A font family Figma has. Call list_fonts to see them."),
    fontStyle: z
      .string()
      .min(1)
      .describe("A style of that family, for example 'Regular' or 'Bold'"),
    fontSize: z.number().min(1).describe("Font size in pixels"),
    ...styleFields,
    fileKey: fileKeyField,
  }),

  update_text_style: updateTextStyleInput,

  delete_text_style: z.object({
    styleId: styleIdField,
    confirm: z.boolean().describe("Must be true to confirm deletion"),
    fileKey: fileKeyField,
  }),

  apply_text_style: z.object({
    nodeIds: z
      .array(createFigmaNodeIdSchema())
      .min(1)
      .max(200)
      .describe("The text nodes to style, 1 to 200 per call"),
    styleId: styleIdField
      .nullable()
      .describe("The text style to apply, or null to remove the style link"),
    range: z
      .object({
        start: z.number().int().min(0).describe("First character, counting from 0"),
        end: z.number().int().min(1).describe("One past the last character"),
      })
      .optional()
      .describe(
        "Styles these characters only, instead of the whole node. Takes one node at a time."
      ),
    fileKey: fileKeyField,
  }),
} satisfies ExtensionSchemaMap;

/** Tool name to RPC wire mapper. Spread into `rpcToArgs`. */
export const rpcToArgs = {
  list_fonts: (_nodeIds, params) => ({ ...params }),
  create_text_style: (_nodeIds, params) => ({ ...params }),
  update_text_style: (_nodeIds, params) => ({ ...params }),
  delete_text_style: (_nodeIds, params) => ({ ...params }),
  apply_text_style: (nodeIds, params) => ({ nodeIds, ...params }),
} satisfies ExtensionRpcMap;

/**
 * Registers this area's tools.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 */
export function register(server: McpServer, node: Node): void {
  server.tool(
    "list_fonts",
    "List the fonts Figma can use, grouped by family and sorted by family name. Pass query to keep the families whose name contains it, ignoring case. The response reports truncated: true when the limit cut the list short. Check a font here before naming it in create_text_style or update_text_style. When multiple files are connected, specify fileKey.",
    schemas.list_fonts.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.list_fonts, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("list_fonts", undefined, params, fileKey));
    }
  );

  server.tool(
    "create_text_style",
    "Create a local text style. The name, font, and size are required; every other field falls back to the Figma default. A '/' in the name makes a group. boundVariables hands a field to a variable — a STRING variable for fontFamily and fontStyle, a FLOAT variable for the rest — and overrides a literal value given for the same field. The font must be one Figma has: an unavailable family comes back with the closest names, and nothing is written. Local styles work on a free (Starter) plan; publishing them to a team library does not and is not exposed. When multiple files are connected, specify fileKey.",
    schemas.create_text_style.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.create_text_style, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("create_text_style", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "update_text_style",
    "Change a local text style. Every field the call leaves out stays as it is, and the text nodes linked to the style pick the change up. Pass a boundVariables field as null to drop its binding and keep the last value. The font must be one Figma has: an unavailable family comes back with the closest names, and nothing is written. When multiple files are connected, specify fileKey.",
    updateTextStyleShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(updateTextStyleInput, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("update_text_style", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "delete_text_style",
    "Delete a local text style. This is destructive and requires confirm: true. The text nodes that used it keep the look they had: Figma leaves the values on them and drops the link. When multiple files are connected, specify fileKey.",
    schemas.delete_text_style.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.delete_text_style, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("delete_text_style", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "apply_text_style",
    'Apply a text style to up to 200 text nodes, or pass styleId: null to remove the style link and leave each node looking as it did. A style applied to a whole node replaces every text property it carries. Pass range to style a stretch of characters instead, which takes one node at a time and leaves get_node reporting textStyleId: "mixed". Every item is checked before the first write: a batch with a bad item writes nothing and reports every item to correct. When multiple files are connected, specify fileKey.',
    schemas.apply_text_style.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.apply_text_style, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeIds, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("apply_text_style", nodeIds, params, fileKey)
      );
    }
  );
}
