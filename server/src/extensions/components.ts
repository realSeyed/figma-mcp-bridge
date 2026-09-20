import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../node.js";
import { createFigmaNodeIdSchema, createHexColorSchema, fileKeyField } from "../schema-common.js";
import { parseToolInput, renderResponse } from "../tool-helpers.js";
import type { ToolResult } from "../tool-helpers.js";
import type { ExtensionRpcMap, ExtensionSchemaMap } from "./types.js";

/**
 * Component and component-set tools.
 *
 * Import only from `schema-common.js`, `tool-helpers.js`, packages, and types.
 * Importing `schema.js` or `tools.js` here would close an import cycle.
 */

const componentIdField = createFigmaNodeIdSchema().describe(
  "The component or component set to use. A component set narrows to one variant through variantProperties."
);

const variantPropertiesField = z
  .record(z.string())
  .optional()
  .describe(
    'Which variant of a component set to use, as property name to value, e.g. { "Size": "Large", "State": "Hover" }. Every value is text in Figma, so write 24 as "24". Applies to a component set only; omitted, the set\'s default variant is used.'
  );

/**
 * The two forms of `create_component`: converting a node, or building an empty
 * component from a size.
 *
 * `server.tool` takes the object's `.shape`, which a refinement would hide, so
 * the plain object and the refined schema are kept apart.
 */
const createComponentShape = z.object({
  fromNodeId: createFigmaNodeIdSchema()
    .optional()
    .describe(
      "A node to convert into a component in place, keeping its children, size, position, and paint. Give this, or width and height."
    ),
  width: z.number().min(0.01).optional().describe("Width of a new empty component, in pixels"),
  height: z.number().min(0.01).optional().describe("Height of a new empty component, in pixels"),
  name: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The component name. Write it as "Property=Value" to prepare the component for combine_as_variants.'
    ),
  parentId: createFigmaNodeIdSchema()
    .optional()
    .describe("The frame, group, or page to put the component in, defaulting to the current page"),
  x: z.number().optional().describe("Position on the x axis, within the parent"),
  y: z.number().optional().describe("Position on the y axis, within the parent"),
  fillHex: createHexColorSchema()
    .optional()
    .describe("Fill of a new empty component, e.g. '#222222'. Takes no fromNodeId."),
  fileKey: fileKeyField,
});

const createComponentInput = createComponentShape
  .refine(
    (value) =>
      value.fromNodeId !== undefined || (value.width !== undefined && value.height !== undefined),
    "create_component needs fromNodeId to convert an existing node, or width and height to make an empty component"
  )
  .refine(
    (value) =>
      value.fromNodeId === undefined ||
      (value.width === undefined && value.height === undefined && value.fillHex === undefined),
    "create_component takes fromNodeId or width, height, and fillHex, not both: a converted node keeps the size and the fill it already has"
  );

/** Tool name to Zod object schema. Spread into `toolInputSchemas`. */
export const schemas = {
  create_component: createComponentInput,

  combine_as_variants: z.object({
    componentIds: z
      .array(createFigmaNodeIdSchema())
      .min(2)
      .max(50)
      .describe(
        'The components to combine, 2 to 50 per call. Each must be a free COMPONENT named "Property=Value", naming the same properties as the others with its own combination of values.'
      ),
    name: z.string().min(1).optional().describe("The name of the new component set"),
    parentId: createFigmaNodeIdSchema()
      .optional()
      .describe(
        "The frame, group, or page to put the set in, defaulting to where the components already are"
      ),
    layout: z
      .enum(["ROW", "COLUMN"])
      .optional()
      .describe("How the variants are laid out: ROW left to right, COLUMN top to bottom. ROW."),
    gap: z.number().min(0).optional().describe("Space between the variants, in pixels. 24."),
    padding: z
      .number()
      .min(0)
      .optional()
      .describe("Space between the variants and the edge of the set, in pixels. 24."),
    fileKey: fileKeyField,
  }),

  create_instance: z.object({
    componentId: componentIdField,
    variantProperties: variantPropertiesField,
    parentId: createFigmaNodeIdSchema()
      .optional()
      .describe("The frame, group, or page to put the instance in, defaulting to the current page"),
    x: z.number().optional().describe("Position on the x axis, within the parent"),
    y: z.number().optional().describe("Position on the y axis, within the parent"),
    fileKey: fileKeyField,
  }),

  swap_instance: z.object({
    nodeId: createFigmaNodeIdSchema().describe("The instance to point at another component"),
    componentId: componentIdField,
    variantProperties: variantPropertiesField,
    fileKey: fileKeyField,
  }),

  detach_instance: z.object({
    nodeIds: z
      .array(createFigmaNodeIdSchema())
      .min(1)
      .max(200)
      .describe("The instances to turn into frames, 1 to 200 per call"),
    fileKey: fileKeyField,
  }),
} satisfies ExtensionSchemaMap;

/** Tool name to RPC wire mapper. Spread into `rpcToArgs`. */
export const rpcToArgs = {
  create_component: (_nodeIds, params) => ({ ...params }),
  combine_as_variants: (_nodeIds, params) => ({ ...params }),
  create_instance: (_nodeIds, params) => ({ ...params }),
  swap_instance: (nodeIds, params) => ({ ...params, nodeId: nodeIds?.[0] }),
  detach_instance: (nodeIds, params) => ({ nodeIds, ...params }),
} satisfies ExtensionRpcMap;

/**
 * Registers this area's tools.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 */
export function register(server: McpServer, node: Node): void {
  server.tool(
    "create_component",
    'Create a local component, either by converting an existing node with fromNodeId or by making an empty one from width and height. Converting keeps the node\'s children, size, position, and paint, so width, height, and fillHex belong to the empty form only. A node that is already a component, a component set, or an instance is refused, as is a node inside one — Figma cannot make a component out of those. Name the component "Property=Value" to prepare it for combine_as_variants. Local components work on a free (Starter) plan; publishing them to a team library does not and is not exposed. When multiple files are connected, specify fileKey.',
    createComponentShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(createComponentInput, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("create_component", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "combine_as_variants",
    'Combine 2 to 50 components into one component set, Figma\'s variants feature. Each component must be a free COMPONENT — call create_component with fromNodeId first — and its name carries its variant properties: "Size=Small", or several pairs as in "Size=Small, State=Hover". Every component names the same properties, and no two repeat the same combination of values. Every name is checked before the first write: a call with a bad name writes nothing and reports every name to correct. Figma stacks the variants on one spot, so the set is laid out in a row or a column with gap and resized to fit the variants plus padding. When multiple files are connected, specify fileKey.',
    schemas.combine_as_variants.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.combine_as_variants, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("combine_as_variants", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "create_instance",
    "Create an instance of a component, or of one variant of a component set. Pass variantProperties to pick the variant by its property values; leave it out and the set's default variant is used. A value that matches no variant comes back with the valid values of every property, and a value that still matches several variants comes back naming the properties that need one too, so an instance never lands on an arbitrary variant. variantProperties applies to a component set only. Local components work on a free (Starter) plan. When multiple files are connected, specify fileKey.",
    schemas.create_instance.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.create_instance, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("create_instance", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "swap_instance",
    "Point an existing instance at another component, or at another variant of a component set, keeping the instance where it is in the file. The variant is picked the same way as in create_instance: variantProperties by property value, otherwise the set's default variant. Use this to move a button from Size=Small to Size=Large without deleting and re-placing it. When multiple files are connected, specify fileKey.",
    schemas.swap_instance.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.swap_instance, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeId, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("swap_instance", [nodeId], params, fileKey));
    }
  );

  server.tool(
    "detach_instance",
    "Turn up to 200 instances into plain frames, keeping what each one looks like and dropping the link to its main component. An instance inside another instance is refused: Figma detaches every instance above a nested one as well, so the call would reach further than it names — detach the outer instance instead. Every item is checked before the first write: a batch with a bad item writes nothing and reports every item to correct. When multiple files are connected, specify fileKey.",
    schemas.detach_instance.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.detach_instance, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeIds } = parsed.data;
      return renderResponse(() => node.sendWithParams("detach_instance", nodeIds, {}, fileKey));
    }
  );
}
