import { z } from "zod";

/**
 * Field builders shared by `schema.ts` and the tool schemas under
 * `extensions/`. Kept in their own module so an extension file never has to
 * import `schema.ts`, which would close an import cycle through
 * `toolInputSchemas`.
 */

/**
 * Figma node IDs:
 *   - top-level node:        "4029:12345"
 *   - child inside INSTANCE: "I12740:17806;12740:17793" (and deeper, semicolon-separated)
 *
 * Both forms are valid for figma.getNodeById and are returned as-is by the plugin
 * from get_selection / get_design_context.
 */

/**
 * Creates a Zod schema that validates a Figma node ID string.
 * @returns A Zod string schema for node IDs.
 */
export const createFigmaNodeIdSchema = () =>
  z
    .string()
    .regex(
      /^(\d+:\d+|I\d+:\d+(;\d+:\d+)+)$/,
      "Node ID must use colon format, e.g. '4029:12345', or instance-child format 'I12740:17806;12740:17793'"
    );

/**
 * Creates a Zod schema that validates a CSS-style hex color string.
 * @returns A Zod string schema for hex colors.
 */
export const createHexColorSchema = () =>
  z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Color must be a hex value like '#FFAA00'");

/**
 * Creates a Zod schema that validates a variable ID.
 * @returns A Zod string schema for variable IDs.
 */
export const createVariableIdSchema = () =>
  z
    .string()
    .regex(
      /^VariableID:.+$/,
      "Variable ID must start with 'VariableID:' — use an ID from get_variable_defs"
    );

/**
 * Creates a Zod schema that validates a text style ID.
 * @returns A Zod string schema for style IDs.
 */
export const createTextStyleIdSchema = () =>
  z.string().regex(/^S:.+$/, "Text style ID must start with 'S:' — use an ID from get_styles");

/**
 * The parent of a new node. A factory, as in `schema-common.ts`, so each tool
 * gets its own copy and the listed schema holds no `$ref`.
 * @returns The optional field.
 */
export const createParentIdSchema = () =>
  createFigmaNodeIdSchema()
    .optional()
    .describe(
      "Parent node ID (page, frame, group, component, section); x and y are relative to it. Always pass it: without it the node goes to the page in view"
    );

/**
 * The child-layout fields and `index` of the create and set tools: how a
 * node sizes and sits inside an auto-layout parent, and where it goes among
 * its parent's children. A factory, so each tool gets its own copies.
 * @returns The fields, each optional.
 */
export const createChildLayoutFields = () => ({
  layoutSizingHorizontal: z
    .enum(["FIXED", "HUG", "FILL"])
    .optional()
    .describe(
      "FIXED keeps the width, HUG fits the content, FILL takes the free width of an auto-layout parent"
    ),
  layoutSizingVertical: z
    .enum(["FIXED", "HUG", "FILL"])
    .optional()
    .describe(
      "FIXED keeps the height, HUG fits the content, FILL takes the free height of an auto-layout parent"
    ),
  layoutPositioning: z
    .enum(["AUTO", "ABSOLUTE"])
    .optional()
    .describe(
      "ABSOLUTE takes the node out of the auto-layout flow, and x and y place it (a badge); AUTO puts it back"
    ),
  minWidth: z.number().min(0).optional().describe("Smallest width (auto layout)"),
  maxWidth: z.number().min(0).optional().describe("Largest width (auto layout)"),
  minHeight: z.number().min(0).optional().describe("Smallest height (auto layout)"),
  maxHeight: z.number().min(0).optional().describe("Largest height (auto layout)"),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Stack position among the parent's children: 0 is the bottom; past the end is the top"
    ),
});

export const fileKeyField = z
  .string()
  .optional()
  .describe("The file to use; required when several files are connected (see list_files)");
