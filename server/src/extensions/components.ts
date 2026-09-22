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
      "A node to convert into a component in place, keeping its children, size, position, and paint. A SECTION is refused: put the content in a frame and convert the frame. Give this, or width and height."
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
    .describe(
      "The page, frame, group, component, or section to put the component in, defaulting to the current page. x and y are relative to it."
    ),
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

/** The most components one preferredValues list carries. */
const MAX_PREFERRED_VALUES = 50;

const propertyOwnerField = createFigmaNodeIdSchema().describe(
  "The component, or the component set, that owns the property. A variant is refused with the ID of its set: a variant owns no properties of its own."
);

const propertyNameField = z
  .string()
  .min(1)
  .describe(
    'The property, named either the way Figma shows it ("Label") or in full with the suffix Figma appends ("Label#12:0"). A display name that matches two properties comes back with both full names.'
  );

const preferredValuesField = z
  .array(createFigmaNodeIdSchema())
  .max(MAX_PREFERRED_VALUES)
  .optional()
  .describe(
    "IDs of the components or component sets the instance swap menu offers first, up to 50. Belongs to an INSTANCE_SWAP property only."
  );

const propertyValueDescription =
  "BOOLEAN takes true or false, TEXT and VARIANT take a string, and INSTANCE_SWAP takes the node ID of the component an instance starts on, e.g. '4029:12345'.";

/**
 * The form of `edit_component_property`: at least one field to change.
 *
 * `server.tool` takes the object's `.shape`, which a refinement would hide, so
 * the plain object and the refined schema are kept apart.
 */
const editComponentPropertyShape = z.object({
  componentId: propertyOwnerField,
  propertyName: propertyNameField,
  newName: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The new display name, without a "#" suffix. The call returns the full name the file carries afterwards, which Figma changes when the new name collides with another property of this component.'
    ),
  newDefaultValue: z
    .union([z.string(), z.boolean()])
    .optional()
    .describe(
      `The new default value an instance starts on. ${propertyValueDescription} A VARIANT property takes none: the first variant of the set is the default.`
    ),
  preferredValues: preferredValuesField,
  fileKey: fileKeyField,
});

const editComponentPropertyInput = editComponentPropertyShape.refine(
  (value) =>
    value.newName !== undefined ||
    value.newDefaultValue !== undefined ||
    value.preferredValues !== undefined,
  "edit_component_property needs at least one of newName, newDefaultValue, and preferredValues: a field left out keeps the value it has"
);

/** Tool name to Zod object schema. Spread into `toolInputSchemas`. */
export const schemas = {
  list_components: z.object({
    scope: z
      .enum(["currentPage", "allPages"])
      .optional()
      .describe(
        "Which components to list: currentPage reads the page open in Figma, allPages the whole file. currentPage. Ignored when sectionId is given."
      ),
    sectionId: createFigmaNodeIdSchema()
      .optional()
      .describe(
        "Keeps only the components inside this section, at any depth. Must name a SECTION; call list_sections for the ID."
      ),
    query: z
      .string()
      .optional()
      .describe("Keeps the components whose name contains this text, ignoring case"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("How many items to return, defaulting to 100"),
    fileKey: fileKeyField,
  }),

  get_component: z.object({
    nodeId: createFigmaNodeIdSchema().describe("The component or component set to read"),
    fileKey: fileKeyField,
  }),

  get_instance: z.object({
    nodeId: createFigmaNodeIdSchema().describe("The instance to read"),
    fileKey: fileKeyField,
  }),

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
        "The page, frame, group, component, or section to put the set in, defaulting to where the components already are"
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
      .describe(
        "The page, frame, group, component, or section to put the instance in, defaulting to the current page. x and y are relative to it."
      ),
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

  add_component_property: z.object({
    componentId: propertyOwnerField,
    name: z
      .string()
      .min(1)
      .describe(
        'The property name Figma shows, e.g. "Label". Leave the "#" suffix out — Figma appends one, and the call returns the full name to pass back.'
      ),
    type: z
      .enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"])
      .describe(
        "The property type. VARIANT is an axis of a component set and is refused on a single component. SLOT is not supported."
      ),
    defaultValue: z
      .union([z.string(), z.boolean()])
      .describe(`The value an instance starts on. ${propertyValueDescription}`),
    preferredValues: preferredValuesField,
    fileKey: fileKeyField,
  }),

  edit_component_property: editComponentPropertyInput,

  delete_component_property: z.object({
    componentId: propertyOwnerField,
    propertyName: propertyNameField,
    confirm: z.boolean().describe("Must be true to confirm deletion"),
    fileKey: fileKeyField,
  }),

  bind_component_property: z.object({
    nodeId: createFigmaNodeIdSchema().describe(
      "The layer inside the component, or inside one variant of the component set, to drive from a property"
    ),
    field: z
      .enum(["characters", "visible", "mainComponent"])
      .describe(
        "The field the property drives: characters is the text of a TEXT layer and reads a TEXT property, visible reads a BOOLEAN property, and mainComponent is the component an INSTANCE layer follows and reads an INSTANCE_SWAP property."
      ),
    propertyName: propertyNameField
      .nullable()
      .describe(
        "The property to link the field to, named in display or full form, or null to remove the link. The layer then keeps the value it last showed."
      ),
    fileKey: fileKeyField,
  }),

  set_instance_properties: z.object({
    nodeId: createFigmaNodeIdSchema().describe("The instance to change"),
    properties: z
      .record(z.union([z.string(), z.boolean()]))
      .describe(
        `The properties to set, as property name to value, e.g. { "Label": "Buy", "Show icon": false }. Each name is the display name or the full name. ${propertyValueDescription}`
      ),
    fileKey: fileKeyField,
  }),
} satisfies ExtensionSchemaMap;

/** Tool name to RPC wire mapper. Spread into `rpcToArgs`. */
export const rpcToArgs = {
  list_components: (_nodeIds, params) => ({ ...params }),
  get_component: (nodeIds, params) => ({ ...params, nodeId: nodeIds?.[0] }),
  get_instance: (nodeIds, params) => ({ ...params, nodeId: nodeIds?.[0] }),
  create_component: (_nodeIds, params) => ({ ...params }),
  combine_as_variants: (_nodeIds, params) => ({ ...params }),
  create_instance: (_nodeIds, params) => ({ ...params }),
  swap_instance: (nodeIds, params) => ({ ...params, nodeId: nodeIds?.[0] }),
  detach_instance: (nodeIds, params) => ({ nodeIds, ...params }),
  add_component_property: (_nodeIds, params) => ({ ...params }),
  edit_component_property: (_nodeIds, params) => ({ ...params }),
  delete_component_property: (_nodeIds, params) => ({ ...params }),
  bind_component_property: (nodeIds, params) => ({ ...params, nodeId: nodeIds?.[0] }),
  set_instance_properties: (nodeIds, params) => ({ ...params, nodeId: nodeIds?.[0] }),
} satisfies ExtensionRpcMap;

/**
 * Registers this area's tools.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 */
export function register(server: McpServer, node: Node): void {
  server.tool(
    "list_components",
    'List the local components and component sets of the current page, or of the whole file with scope: "allPages". Each item carries its ID, name, page, the nearest section that holds it as sectionId and sectionName, and its description; a component set also carries how many variants it holds and every variant property with the values it takes, so one call is enough to know what create_instance can ask for. A variant is not listed on its own — it belongs to the set that reports it. Narrow to one section with sectionId, which searches that section at any depth and takes the place of scope. Filter by name with query, and cap the list with limit; truncated says whether more matched than were returned. Reads local components only: a team library needs a paid plan and is not exposed. When multiple files are connected, specify fileKey.',
    schemas.list_components.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.list_components, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("list_components", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "get_component",
    "Read one component or component set: its description, the page it sits on, and the component properties an instance of it takes — each with its full name, the short name Figma shows, its type, its default, and the values a VARIANT property accepts. A component set also reports its variants and which one is the default; a variant reports the set it belongs to and that set's properties, because a variant does not own properties of its own. Call list_components first to find the ID. When multiple files are connected, specify fileKey.",
    schemas.get_component.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.get_component, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeId } = parsed.data;
      return renderResponse(() => node.sendWithParams("get_component", [nodeId], {}, fileKey));
    }
  );

  server.tool(
    "get_instance",
    "Read one instance: the main component it follows, with the component set that component belongs to and whether it comes from a library; the value of every component property, keyed by the full property name; the instances it exposes; and the overrides made on it, as the node overridden and the fields changed on it. Use it to see how one placed component differs from its main. When multiple files are connected, specify fileKey.",
    schemas.get_instance.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.get_instance, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeId } = parsed.data;
      return renderResponse(() => node.sendWithParams("get_instance", [nodeId], {}, fileKey));
    }
  );

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

  server.tool(
    "add_component_property",
    'Add one component property to a component or a component set, so an instance of it can be configured without being edited. A BOOLEAN property drives whether a layer shows, TEXT the words of a text layer, INSTANCE_SWAP the component a nested instance follows, and VARIANT a new axis of a component set. Figma appends a unique suffix to a BOOLEAN, TEXT, or INSTANCE_SWAP name, so the call returns the full name — "Label#12:0" — and that is the name the other tools take; a VARIANT name carries no suffix. Figma also keeps the display names of one component apart, so a name that collides with another property is stored with a number appended and the returned name reflects that. Pass the component set, not one of its variants: a variant owns no properties, and a property on the set reaches every variant. SLOT properties are not supported. Use bind_component_property next to point a layer at the new property. When multiple files are connected, specify fileKey.',
    schemas.add_component_property.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.add_component_property, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("add_component_property", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "edit_component_property",
    "Change the name, the default value, or the preferred values of one component property, and return the full name the file carries afterwards — Figma keeps the display names of one component apart, so a new name that collides with another property is stored with a number appended, and the returned name is the one to pass from then on. Name the property by the display name Figma shows or by the full name. newDefaultValue belongs to a BOOLEAN, TEXT, or INSTANCE_SWAP property — a VARIANT property takes none, because the first variant of the set is the default — and preferredValues to an INSTANCE_SWAP property. A field left out keeps the value it has. When multiple files are connected, specify fileKey.",
    editComponentPropertyShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(editComponentPropertyInput, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("edit_component_property", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "delete_component_property",
    "Remove one component property from a component or a component set. This is destructive and requires confirm: true — it drops the property from every instance as well, and each layer the property drove keeps the value it last showed. Name the property by its display name or its full name. A VARIANT property cannot be removed this way: it is an axis of the set, carried in the name of every variant. When multiple files are connected, specify fileKey.",
    schemas.delete_component_property.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.delete_component_property, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("delete_component_property", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "bind_component_property",
    "Point one field of a layer inside a component at a component property, so an instance drives that field through the property. The field must match the property type: characters reads a TEXT property and belongs to a TEXT layer, visible reads a BOOLEAN property, and mainComponent reads an INSTANCE_SWAP property and belongs to an INSTANCE layer. The layer must sit inside the component, or inside one variant of the component set, that owns the property — a layer inside an instance is refused, because the link lives on the main component. The other links on the layer are kept. Pass propertyName: null to remove the link and leave the layer as it looks. When multiple files are connected, specify fileKey.",
    schemas.bind_component_property.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.bind_component_property, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeId, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("bind_component_property", [nodeId], params, fileKey)
      );
    }
  );

  server.tool(
    "set_instance_properties",
    "Set the component property values of one instance: the text it shows, whether a layer of it is visible, the component a nested instance follows, and which variant of a component set it is. Name each property by the display name Figma shows or by the full name; a display name that matches two properties comes back with both full names. A VARIANT value that the set does not have comes back with the values it does have, and the fonts of the text layers a TEXT property drives are loaded before the change. Every value is checked before the first write, so a call with a bad value leaves the instance as it was. Call get_instance or get_component to see what an instance takes. When multiple files are connected, specify fileKey.",
    schemas.set_instance_properties.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(schemas.set_instance_properties, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, nodeId, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("set_instance_properties", [nodeId], params, fileKey)
      );
    }
  );
}
