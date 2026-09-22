import {
  getParentNodeById,
  getSceneNodeById,
  loadFontsForTextNode,
  pageOf,
  parseHexColor,
  positionNode,
  sectionAncestorsOf,
  supportsChildren,
} from "../shared";
import {
  describeValue,
  describeWriteError,
  messageOf,
  readBatchArray,
  readOptionalNumber,
  readOptionalString,
  readRequiredString,
  runBatchWrites,
  validationError,
} from "./batch";
import type { ExtensionHandler, ExtensionRequest } from "./types";

/**
 * Component and component-set tools.
 *
 * Add a tool by adding one entry here. Set `edit` to true when the handler
 * writes to the file.
 */

/** The most components one combine_as_variants call accepts. */
const MAX_VARIANTS = 50;

/** The gap and the padding combine_as_variants lays a new set out with. */
const DEFAULT_VARIANT_GAP = 24;
const DEFAULT_VARIANT_PADDING = 24;

/** How many items list_components returns by default, and at most. */
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

const VARIANT_NAME_FORM =
  'use "Property=Value", or several pairs separated by commas, as in "Size=Small, State=Hover"';

/** The properties a variant name carries, or the reason the name is not one. */
type VariantNameResult =
  { ok: true; properties: Map<string, string> } | { ok: false; problem: string };

/**
 * Reads the variant properties a component name encodes.
 *
 * Figma stores a variant's properties in its name, so the name is what decides
 * whether a component can join a set. The reason is phrased to follow a node
 * ID, as in `4:5 is named "Button", which ...`.
 * @param name - The component name.
 * @returns The properties, or the reason the name is not a variant name.
 */
const parseVariantName = (name: string): VariantNameResult => {
  const properties = new Map<string, string>();
  for (const pair of name.split(",")) {
    const parts = pair.split("=");
    const property = parts.length === 2 ? parts[0].trim() : "";
    const value = parts.length === 2 ? parts[1].trim() : "";
    if (property === "" || value === "") {
      return {
        ok: false,
        problem: `is named "${name}", which is not the variant form: ${VARIANT_NAME_FORM}.`,
      };
    }
    if (properties.has(property)) {
      return {
        ok: false,
        problem: `is named "${name}", which names the property "${property}" twice: give each property once.`,
      };
    }
    properties.set(property, value);
  }
  return { ok: true, properties };
};

/**
 * Reads the variants of a component set.
 * @param set - The component set.
 * @returns Its component children, in the order the set holds them.
 */
const variantsOf = (set: ComponentSetNode): ComponentNode[] =>
  set.children.filter((child): child is ComponentNode => child.type === "COMPONENT");

/**
 * Reads the values one variant carries.
 *
 * `variantProperties` is what Figma itself reports; the name is the fallback,
 * so a set assembled outside these tools still reads correctly.
 * @param variant - A component inside a component set.
 * @returns The property name to value map.
 */
const variantValuesOf = (variant: ComponentNode): Map<string, string> => {
  const properties = variant.variantProperties;
  if (properties) return new Map(Object.entries(properties));
  const parsed = parseVariantName(variant.name);
  return parsed.ok ? parsed.properties : new Map();
};

/** Orders two names, so a listing and a message read the same way every time. */
const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Writes a property map as `Size=Small, State=Hover`, in a stable order. */
const describeValues = (values: Map<string, string>): string =>
  [...values.entries()]
    .sort(([left], [right]) => compareNames(left, right))
    .map(([property, value]) => `${property}=${value}`)
    .join(", ");

/**
 * Reads the `variantProperties` parameter.
 * @param raw - The parameter value.
 * @param tool - The tool name, for the error message.
 * @returns The wanted values, empty when the parameter is absent.
 */
const readVariantProperties = (raw: unknown, tool: string): Map<string, string> => {
  const wanted = new Map<string, string>();
  if (raw === undefined || raw === null) return wanted;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${tool} requires variantProperties as an object of property name to value, such as { "Size": "Large" }, received ${describeValue(raw)}.`
    );
  }
  for (const [property, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `${tool} requires every value of variantProperties to be a non-empty string, but variantProperties["${property}"] is ${describeValue(value)}. A variant value is text in Figma, so write 24 as "24".`
      );
    }
    wanted.set(property.trim(), value.trim());
  }
  return wanted;
};

/**
 * Finds the component an instance should be made from or swapped to.
 *
 * A component is returned as it is; a component set is narrowed to the one
 * variant the caller named, or to its default variant when it named none. A
 * set that still matches several variants is refused rather than picked from,
 * so an under-specified call never lands on an arbitrary variant.
 * @param componentId - The ID of a component or a component set.
 * @param rawVariantProperties - The `variantProperties` parameter, unexamined.
 * @param tool - The tool name, for the error messages.
 * @returns The component to instantiate.
 */
export const resolveVariant = async (
  componentId: string,
  rawVariantProperties: unknown,
  tool: string
): Promise<ComponentNode> => {
  const node = await figma.getNodeByIdAsync(componentId);
  if (!node) {
    throw new Error(
      `${tool} found no node with the ID ${componentId}. Call get_document or get_selection to list the node IDs of this page.`
    );
  }
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new Error(
      `${componentId} "${node.name}" is a ${node.type} node, not a COMPONENT or a COMPONENT_SET. ${tool} takes a component or a component set; call create_component to make one.`
    );
  }

  const wanted = readVariantProperties(rawVariantProperties, tool);

  if (node.type === "COMPONENT") {
    if (wanted.size > 0) {
      throw new Error(
        `variantProperties applies to a component set, but ${componentId} "${node.name}" is a single COMPONENT. Drop variantProperties, or pass the ID of the component set that holds the variants.`
      );
    }
    return node;
  }

  const variants = variantsOf(node);
  if (variants.length === 0) {
    throw new Error(
      `${componentId} "${node.name}" is a COMPONENT_SET that holds no variants, so there is nothing to instantiate. Call combine_as_variants to build a set from components.`
    );
  }
  if (wanted.size === 0) return node.defaultVariant;

  const options = new Map<string, string[]>();
  for (const variant of variants) {
    for (const [property, value] of variantValuesOf(variant)) {
      const values = options.get(property) ?? [];
      if (!values.includes(value)) values.push(value);
      options.set(property, values);
    }
  }
  const describeOptions = (): string =>
    [...options.entries()]
      .map(([property, values]) => `${property}: ${values.join(", ")}`)
      .join("; ");

  const unknown = [...wanted.keys()].filter((property) => !options.has(property));
  if (unknown.length > 0) {
    throw new Error(
      `${componentId} "${node.name}" has no variant property named ${unknown.join(", ")}. Its properties and their values are ${describeOptions()}. Name one of those properties in variantProperties.`
    );
  }

  const matches = variants.filter((variant) => {
    const values = variantValuesOf(variant);
    return [...wanted.entries()].every(([property, value]) => values.get(property) === value);
  });
  if (matches.length === 0) {
    throw new Error(
      `${componentId} "${node.name}" has no variant with ${describeValues(wanted)}. Its properties and their values are ${describeOptions()}. Give one of the listed values for each property.`
    );
  }
  if (matches.length > 1) {
    const missing = [...options.keys()].filter((property) => !wanted.has(property));
    throw new Error(
      `${componentId} "${node.name}" has ${matches.length} variants with ${describeValues(wanted)}, so the variant is ambiguous. Add a value for ${missing.join(", ")} to variantProperties. Its properties and their values are ${describeOptions()}.`
    );
  }
  return matches[0];
};

/**
 * Names the component, component set, or instance a node sits inside.
 * @param node - The node to check.
 * @returns The nearest such ancestor, or null when the node is free-standing.
 */
const findComponentAncestor = (node: SceneNode): BaseNode | null => {
  let current: BaseNode | null = node.parent;
  while (current) {
    if (
      current.type === "COMPONENT" ||
      current.type === "COMPONENT_SET" ||
      current.type === "INSTANCE"
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

/**
 * Names the instance a node sits inside, if any.
 * @param node - The node to check.
 * @returns The nearest instance ancestor, or null.
 */
const findInstanceAncestor = (node: SceneNode): InstanceNode | null => {
  let current: BaseNode | null = node.parent;
  while (current) {
    if (current.type === "INSTANCE") return current;
    current = current.parent;
  }
  return null;
};

/**
 * Strips the unique suffix Figma appends to a component property name.
 *
 * A boolean, text, or instance-swap property is reported as `Label#12:0`. The
 * suffix keeps two properties of one name apart and is what the API takes, so
 * both forms are returned: the full name to pass back, the short one to read.
 * A variant property carries no suffix and passes through unchanged.
 * @param name - The full property name.
 * @returns The name without the suffix.
 */
const displayNameOf = (name: string): string => {
  const hash = name.lastIndexOf("#");
  return hash > 0 ? name.slice(0, hash) : name;
};

/**
 * Reads the variant properties of a set as property name to its values.
 *
 * `componentPropertyDefinitions` is what Figma reports, but it throws on a set
 * whose variants conflict. The variants themselves still answer the question,
 * so one broken set does not cost the caller the whole listing.
 * @param set - The component set.
 * @returns Each variant property and the values it takes.
 */
const variantOptionsOf = (set: ComponentSetNode): Record<string, string[]> => {
  const options: Record<string, string[]> = {};
  try {
    for (const [property, definition] of Object.entries(set.componentPropertyDefinitions)) {
      if (definition.type === "VARIANT") options[property] = definition.variantOptions ?? [];
    }
    return options;
  } catch {
    for (const variant of variantsOf(set)) {
      for (const [property, value] of variantValuesOf(variant)) {
        const values = options[property] ?? [];
        if (!values.includes(value)) values.push(value);
        options[property] = values;
      }
    }
    return options;
  }
};

/**
 * Reads the node ID of a tool that takes one node.
 *
 * The ID travels in the request's own `nodeIds` field, as it does for the core
 * tools that take one node: the leader drops a `nodeId` param on the follower
 * RPC path, so one passed there never reaches this handler.
 * @param req - The extension request.
 * @param tool - The tool name, for the error message.
 * @param what - What the node is, for the error message.
 * @returns The node ID.
 */
const readNodeId = (req: ExtensionRequest, tool: string, what: string): string => {
  const nodeId = req.nodeIds && req.nodeIds[0];
  if (typeof nodeId !== "string" || nodeId.trim() === "") {
    throw new Error(
      `${tool} requires nodeId, ${what}. Call get_document or get_selection to list the node IDs of this page.`
    );
  }
  return nodeId;
};

/**
 * Looks a node up for a read tool.
 * @param nodeId - The node ID.
 * @param tool - The tool name, for the error message.
 * @returns The node.
 */
const readNodeById = async (nodeId: string, tool: string): Promise<BaseNode> => {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(
      `${tool} found no node with the ID ${nodeId}. Call list_components or get_document to list the node IDs of this file.`
    );
  }
  return node;
};

/**
 * Resolves the parent a new node is appended to.
 * @param parentId - The `parentId` parameter, or undefined.
 * @returns The parent, or undefined when the caller named none.
 */
const resolveParent = async (
  parentId: string | undefined
): Promise<(BaseNode & ChildrenMixin) | undefined> =>
  parentId === undefined ? undefined : await getParentNodeById(parentId);

/**
 * Picks the parent a new component set lands in when the caller named none.
 *
 * The components' own parent keeps the set where the work already is, which
 * matters because the page open in Figma is not always the page being built.
 * @param component - The first component of the set.
 * @returns The parent to combine into.
 */
const defaultParentFor = async (component: ComponentNode): Promise<BaseNode & ChildrenMixin> => {
  const parent = component.parent;
  if (parent && parent.type !== "DOCUMENT" && supportsChildren(parent)) {
    if (parent.type === "PAGE") await parent.loadAsync();
    return parent;
  }
  return figma.currentPage;
};

/**
 * Creates a component, either from an existing node or from nothing.
 *
 * Both forms check every field before the first write, so a call that is
 * refused leaves the file as it was. `fromNodeId` converts in place, which is
 * why the size and the fill belong to the other form only: the converted node
 * keeps the geometry and the paint it already had.
 * @param req - The extension request.
 * @returns The new component.
 */
const createComponent = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "create_component";
  const fromNodeId = readOptionalString(req.params, "fromNodeId", tool);
  const name = readOptionalString(req.params, "name", tool);
  const parentId = readOptionalString(req.params, "parentId", tool);
  const x = readOptionalNumber(req.params, "x", tool);
  const y = readOptionalNumber(req.params, "y", tool);
  const width = readOptionalNumber(req.params, "width", tool, 0.01);
  const height = readOptionalNumber(req.params, "height", tool, 0.01);
  const fillHex = readOptionalString(req.params, "fillHex", tool);

  let component: ComponentNode;

  if (fromNodeId !== undefined) {
    if (width !== undefined || height !== undefined) {
      throw new Error(
        `${tool} takes either fromNodeId or width and height, not both. A converted node keeps its own size; call set_node_properties to resize it afterwards.`
      );
    }
    if (fillHex !== undefined) {
      throw new Error(
        `${tool} takes fillHex only without fromNodeId. A converted node keeps its own fill; call set_solid_fill to change it afterwards.`
      );
    }

    const source = await getSceneNodeById(fromNodeId);
    if (source.type === "COMPONENT" || source.type === "COMPONENT_SET") {
      throw new Error(
        `${fromNodeId} "${source.name}" is already a ${source.type}, so there is nothing to convert. Pass the ID of a frame or another plain node.`
      );
    }
    if (source.type === "SECTION") {
      throw new Error(
        `${fromNodeId} "${source.name}" is a SECTION, and Figma makes a component out of a node in the frame tree, which a section sits outside of. Call create_frame to make a frame, move the content into it with reparent_nodes, and convert that frame instead.`
      );
    }
    if (source.type === "INSTANCE") {
      throw new Error(
        `${fromNodeId} "${source.name}" is an INSTANCE, which already follows a main component. Call detach_instance first to turn it into a frame, then convert that frame.`
      );
    }
    const ancestor = findComponentAncestor(source);
    if (ancestor) {
      throw new Error(
        `${fromNodeId} "${source.name}" sits inside the ${ancestor.type} ${ancestor.id} "${ancestor.name}", and Figma cannot make a component out of a node inside one. Move it out with reparent_nodes, or convert the ${ancestor.type} instead.`
      );
    }

    const parent = await resolveParent(parentId);
    try {
      component = figma.createComponentFromNode(source);
      if (parent) parent.appendChild(component);
    } catch (err) {
      throw describeWriteError(`${tool} could not convert ${fromNodeId} "${source.name}"`, err);
    }
  } else {
    if (width === undefined || height === undefined) {
      throw new Error(
        `${tool} needs fromNodeId to convert an existing node, or width and height to make an empty component. Received neither.`
      );
    }
    // Parsed before the write so a bad colour leaves nothing behind.
    const fill = fillHex === undefined ? undefined : parseHexColor(fillHex);
    const parent = await resolveParent(parentId);

    try {
      component = figma.createComponent();
      component.resize(width, height);
      if (fill) component.fills = [{ type: "SOLID", color: fill }];
      if (parent) parent.appendChild(component);
    } catch (err) {
      throw describeWriteError(`${tool} could not create the component`, err);
    }
  }

  if (name !== undefined) component.name = name;
  positionNode(component, x, y);

  return {
    id: component.id,
    name: component.name,
    parentId: component.parent ? component.parent.id : null,
    x: component.x,
    y: component.y,
    width: component.width,
    height: component.height,
  };
};

/** One checked component on its way into a set. */
type VariantPlan = {
  index: number;
  component: ComponentNode;
  properties: Map<string, string>;
};

/**
 * Combines components into one component set.
 *
 * Every component is checked first: it must be a free component, and its name
 * must encode the same properties as the others with a combination no other
 * component repeats. Figma refuses a set that breaks any of those, so the
 * check turns what would be one opaque throw into a list of names to correct.
 *
 * `figma.combineAsVariants` stacks every variant at the same spot, so the set
 * is laid out and resized afterwards; without that it reads as a single
 * variant with the rest hidden behind it.
 * @param req - The extension request.
 * @returns The new component set.
 */
const combineAsVariants = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "combine_as_variants";
  const name = readOptionalString(req.params, "name", tool);
  const parentId = readOptionalString(req.params, "parentId", tool);
  const rawLayout = readOptionalString(req.params, "layout", tool);
  if (rawLayout !== undefined && rawLayout !== "ROW" && rawLayout !== "COLUMN") {
    throw new Error(
      `${tool} requires layout to be ROW or COLUMN, received "${rawLayout}". ROW lays the variants out left to right, COLUMN top to bottom.`
    );
  }
  const layout = rawLayout ?? "ROW";
  const gap = readOptionalNumber(req.params, "gap", tool, 0) ?? DEFAULT_VARIANT_GAP;
  const padding = readOptionalNumber(req.params, "padding", tool, 0) ?? DEFAULT_VARIANT_PADDING;

  const rawIds = req.params.componentIds;
  if (!Array.isArray(rawIds) || rawIds.length < 2) {
    throw new Error(
      `${tool} requires componentIds as an array of 2 to ${MAX_VARIANTS} component IDs, received ${describeValue(rawIds)}. A component set needs at least two variants.`
    );
  }
  if (rawIds.length > MAX_VARIANTS) {
    throw new Error(
      `${tool} accepts at most ${MAX_VARIANTS} components per call, received ${rawIds.length}. Combine fewer components, or build the set in more than one step.`
    );
  }

  const problems: string[] = [];
  const plans: VariantPlan[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < rawIds.length; index++) {
    const rawId = rawIds[index];
    const fail = (problem: string): void => {
      problems.push(`items[${index}]: ${problem}`);
    };

    if (typeof rawId !== "string" || rawId.trim() === "") {
      fail(
        `each item must be a component ID such as "4029:12345", received ${describeValue(rawId)}. Call get_document to list the node IDs of this page.`
      );
      continue;
    }
    if (seen.has(rawId)) {
      fail(`${rawId} is listed more than once in componentIds. Name each component once.`);
      continue;
    }
    seen.add(rawId);

    const node = await figma.getNodeByIdAsync(rawId);
    if (!node) {
      fail(
        `node not found: ${rawId}. Call get_document or get_selection to list the node IDs of this page.`
      );
      continue;
    }
    if (node.type !== "COMPONENT") {
      fail(
        `${rawId} "${node.name}" is a ${node.type} node, not a COMPONENT. Call create_component with fromNodeId to convert it first.`
      );
      continue;
    }
    const holder = node.parent;
    if (holder && holder.type === "COMPONENT_SET") {
      fail(
        `${rawId} "${node.name}" is already a variant of the component set ${holder.id} "${holder.name}". A component belongs to one set; move it out with reparent_nodes to combine it elsewhere.`
      );
      continue;
    }

    const parsed = parseVariantName(node.name);
    if (!parsed.ok) {
      fail(`${rawId} ${parsed.problem} Rename it with set_node_properties before combining.`);
      continue;
    }
    plans.push({ index, component: node, properties: parsed.properties });
  }

  if (plans.length > 1) {
    const signatureOf = (properties: Map<string, string>): string =>
      [...properties.keys()].sort().join(", ");
    const first = plans[0];
    const firstSignature = signatureOf(first.properties);
    for (const plan of plans.slice(1)) {
      const signature = signatureOf(plan.properties);
      if (signature !== firstSignature) {
        problems.push(
          `items[${plan.index}]: ${plan.component.id} "${plan.component.name}" names the properties ${signature}, but items[${first.index}] "${first.component.name}" names ${firstSignature}. Every variant of one set names the same properties.`
        );
      }
    }

    const combinations = new Map<string, VariantPlan>();
    for (const plan of plans) {
      const key = describeValues(plan.properties);
      const earlier = combinations.get(key);
      if (earlier) {
        problems.push(
          `items[${plan.index}]: ${plan.component.id} "${plan.component.name}" repeats the values of items[${earlier.index}] "${earlier.component.name}". Each variant needs its own combination of values.`
        );
      } else {
        combinations.set(key, plan);
      }
    }
  }

  if (problems.length > 0) throw validationError(tool, problems);

  const components = plans.map((plan) => plan.component);
  const parent = (await resolveParent(parentId)) ?? (await defaultParentFor(components[0]));

  let set: ComponentSetNode;
  try {
    set = figma.combineAsVariants(components, parent);
  } catch (err) {
    throw describeWriteError(`${tool} could not combine the ${components.length} components`, err);
  }

  if (name !== undefined) set.name = name;

  try {
    let cursor = padding;
    let cross = 0;
    for (const component of components) {
      if (layout === "ROW") {
        component.x = cursor;
        component.y = padding;
        cursor += component.width + gap;
        cross = Math.max(cross, component.height);
      } else {
        component.x = padding;
        component.y = cursor;
        cursor += component.height + gap;
        cross = Math.max(cross, component.width);
      }
    }
    const along = Math.max(cursor - gap + padding, 0.01);
    const across = Math.max(cross + padding * 2, 0.01);
    // Constraints would drag the variants along with the frame and undo the
    // layout that was just written.
    set.resizeWithoutConstraints(
      layout === "ROW" ? along : across,
      layout === "ROW" ? across : along
    );
  } catch (err) {
    throw describeWriteError(`${tool} combined the components but could not lay the set out`, err);
  }

  return {
    id: set.id,
    name: set.name,
    variantIds: components.map((component) => component.id),
    width: set.width,
    height: set.height,
  };
};

/**
 * Creates an instance of a component or of one variant of a component set.
 * @param req - The extension request.
 * @returns The new instance.
 */
const createInstance = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "create_instance";
  const componentId = readRequiredString(req.params, "componentId", tool);
  const parentId = readOptionalString(req.params, "parentId", tool);
  const x = readOptionalNumber(req.params, "x", tool);
  const y = readOptionalNumber(req.params, "y", tool);

  const component = await resolveVariant(componentId, req.params.variantProperties, tool);
  const parent = await resolveParent(parentId);

  let instance: InstanceNode;
  try {
    instance = component.createInstance();
    if (parent) parent.appendChild(instance);
  } catch (err) {
    throw describeWriteError(
      `${tool} could not create an instance of ${component.id} "${component.name}"`,
      err
    );
  }
  positionNode(instance, x, y);

  const main = await instance.getMainComponentAsync();
  return {
    id: instance.id,
    name: instance.name,
    mainComponentId: main ? main.id : null,
  };
};

/**
 * Points an instance at another component, keeping its place in the file.
 * @param req - The extension request.
 * @returns The instance and the component it now follows.
 */
const swapInstance = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "swap_instance";
  const nodeId = readNodeId(req, tool, "the instance to point at another component");
  const componentId = readRequiredString(req.params, "componentId", tool);

  const node = await getSceneNodeById(nodeId);
  if (node.type !== "INSTANCE") {
    throw new Error(
      `${nodeId} "${node.name}" is a ${node.type} node, not an INSTANCE. ${tool} changes the component an instance follows; call create_instance to make one.`
    );
  }
  const component = await resolveVariant(componentId, req.params.variantProperties, tool);

  try {
    node.swapComponent(component);
  } catch (err) {
    throw describeWriteError(
      `${tool} could not point ${nodeId} "${node.name}" at ${component.id} "${component.name}"`,
      err
    );
  }

  const main = await node.getMainComponentAsync();
  return {
    id: node.id,
    mainComponentId: main ? main.id : null,
  };
};

/**
 * Turns instances back into plain frames.
 *
 * An instance inside another instance is refused: `detachInstance` on a nested
 * instance detaches every instance above it too, so one item would silently
 * take its ancestors with it.
 * @param req - The extension request.
 * @returns One result entry per item.
 */
const detachInstance = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "detach_instance";
  // The node IDs travel in the request's own `nodeIds` field, as they do for
  // the core tools that take a list of nodes, not among the params.
  const rawNodeIds = readBatchArray({ nodeIds: req.nodeIds }, "nodeIds", tool);
  const problems: string[] = [];
  const plans: InstanceNode[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < rawNodeIds.length; index++) {
    const rawNodeId = rawNodeIds[index];
    const fail = (problem: string): void => {
      problems.push(`items[${index}]: ${problem}`);
    };

    if (typeof rawNodeId !== "string" || rawNodeId.trim() === "") {
      fail(
        `each item must be a node ID such as "4029:12345", received ${describeValue(rawNodeId)}. Call get_document or get_selection to list them.`
      );
      continue;
    }
    if (seen.has(rawNodeId)) {
      fail(`${rawNodeId} is listed more than once in nodeIds. Name each instance once.`);
      continue;
    }
    seen.add(rawNodeId);

    const node = await figma.getNodeByIdAsync(rawNodeId);
    if (!node) {
      fail(
        `node not found: ${rawNodeId}. Call get_document or get_selection to list the node IDs of this page.`
      );
      continue;
    }
    if (node.type !== "INSTANCE") {
      fail(
        `${rawNodeId} "${node.name}" is a ${node.type} node, not an INSTANCE. ${tool} detaches instances only.`
      );
      continue;
    }

    const ancestor = findInstanceAncestor(node);
    if (ancestor) {
      fail(
        `${rawNodeId} "${node.name}" sits inside the instance ${ancestor.id} "${ancestor.name}", and detaching it would detach that instance as well. Detach ${ancestor.id} instead, or move the nested instance out with reparent_nodes first.`
      );
      continue;
    }
    plans.push(node);
  }

  if (problems.length > 0) throw validationError(tool, problems);

  return runBatchWrites(plans, async (instance) => {
    const nodeId = instance.id;
    const frame = instance.detachInstance();
    return { nodeId, frameId: frame.id };
  });
};

/**
 * Lists the components and the component sets of a page, of one section, or of
 * the whole file.
 *
 * A variant is not listed on its own: it belongs to its set, which carries it
 * under `variantProperties`, and a file of 4-variant sets would otherwise read
 * as five times as many entries as it has components.
 *
 * Each item names the nearest section that holds it, so a file that organises
 * its components in sections can be read one section at a time.
 * @param req - The extension request.
 * @returns The items and whether the limit cut the list short.
 */
const listComponents = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "list_components";
  const rawScope = readOptionalString(req.params, "scope", tool);
  if (rawScope !== undefined && rawScope !== "currentPage" && rawScope !== "allPages") {
    throw new Error(
      `${tool} requires scope to be currentPage or allPages, received "${rawScope}". currentPage reads the page open in Figma, allPages the whole file.`
    );
  }
  const query = readOptionalString(req.params, "query", tool);
  const sectionId = readOptionalString(req.params, "sectionId", tool);

  let limit = DEFAULT_LIST_LIMIT;
  const rawLimit = req.params.limit;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1) {
      throw new Error(
        `${tool} requires limit as a whole number of 1 or more, received ${describeValue(rawLimit)}.`
      );
    }
    limit = Math.min(rawLimit, MAX_LIST_LIMIT);
  }

  let section: SectionNode | null = null;
  if (sectionId !== undefined) {
    const node = await figma.getNodeByIdAsync(sectionId);
    if (!node) {
      throw new Error(
        `${tool} found no node with the ID ${sectionId} for sectionId. Call list_sections to list the sections of this file.`
      );
    }
    if (node.type !== "SECTION") {
      throw new Error(
        `${tool} requires sectionId to name a SECTION, but ${sectionId} "${node.name}" is a ${node.type} node. Call list_sections for a section ID, or drop sectionId to list a whole page.`
      );
    }
    section = node;
  }

  let found: readonly (PageNode | SceneNode)[];
  if (section) {
    // A section sits on one page, so searching its own subtree answers the
    // question whatever scope says, and reads far less of the file.
    const page = pageOf(section);
    if (page) await page.loadAsync();
    found = section.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
  } else if (rawScope === "allPages") {
    // Under `dynamic-page` a page's contents stay unloaded until they are
    // asked for, and searching the document is refused until every page is.
    await figma.loadAllPagesAsync();
    found = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
  } else {
    found = figma.currentPage.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
  }

  const needle = query === undefined ? "" : query.trim().toLowerCase();
  const matched = found
    .filter(
      (node): node is ComponentNode | ComponentSetNode =>
        node.type === "COMPONENT" || node.type === "COMPONENT_SET"
    )
    .filter((node) => !(node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET"))
    .filter((node) => needle === "" || node.name.toLowerCase().includes(needle))
    // A stable order, so the same call twice keeps the same items either side
    // of the limit. The ID breaks a tie between two components of one name.
    .sort((a, b) => compareNames(a.name, b.name) || compareNames(a.id, b.id));

  const items = matched.slice(0, limit).map((node) => {
    const page = pageOf(node);
    const holder = sectionAncestorsOf(node)[0] ?? null;
    const item = {
      type: node.type,
      id: node.id,
      name: node.name,
      pageId: page ? page.id : null,
      pageName: page ? page.name : null,
      sectionId: holder ? holder.id : null,
      sectionName: holder ? holder.name : null,
      description: node.description,
    };
    if (node.type === "COMPONENT") return item;
    return {
      ...item,
      variantCount: variantsOf(node).length,
      variantProperties: variantOptionsOf(node),
    };
  });

  return { items, truncated: matched.length > limit };
};

/**
 * Describes the component properties an instance of a component takes.
 * @param owner - The component or the component set the properties live on.
 * @returns One entry per property, in the order Figma reports them.
 */
const describeProperties = (owner: ComponentNode | ComponentSetNode): unknown[] =>
  Object.entries(owner.componentPropertyDefinitions).map(([name, definition]) => ({
    name,
    displayName: displayNameOf(name),
    type: definition.type,
    defaultValue: definition.defaultValue,
    variantOptions: definition.variantOptions,
    preferredValues: definition.preferredValues
      ? definition.preferredValues.map((preferred) => ({
          type: preferred.type,
          key: preferred.key,
        }))
      : undefined,
  }));

/**
 * Reads one component or component set: its properties and its variants.
 *
 * `componentPropertyDefinitions` throws on a variant, so a variant is read
 * through the set it belongs to. That is also the honest answer: a variant
 * does not own its properties, the set does.
 * @param req - The extension request.
 * @returns The component, its properties, and its variants when it is a set.
 */
const getComponent = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "get_component";
  const nodeId = readNodeId(req, tool, "the component or component set to read");
  const node = await readNodeById(nodeId, tool);
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new Error(
      `${nodeId} "${node.name}" is a ${node.type} node, not a COMPONENT or a COMPONENT_SET. ${tool} reads a component or a component set; call get_instance for an instance, or get_node for any other node.`
    );
  }

  const parent = node.parent;
  const set =
    node.type === "COMPONENT" && parent && parent.type === "COMPONENT_SET" ? parent : null;
  const page = pageOf(node);

  const result: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    name: node.name,
    description: node.description,
    pageId: page ? page.id : null,
    properties: describeProperties(set ?? node),
  };

  if (set) result.parentSetId = set.id;

  if (node.type === "COMPONENT_SET") {
    const variants = variantsOf(node);
    result.defaultVariantId = variants.length > 0 ? node.defaultVariant.id : null;
    result.variants = variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      variantProperties: Object.fromEntries(variantValuesOf(variant)),
    }));
  }

  return result;
};

/**
 * Reads one instance: the component it follows, its property values, and what
 * has been overridden on it.
 * @param req - The extension request.
 * @returns The instance.
 */
const getInstance = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "get_instance";
  const nodeId = readNodeId(req, tool, "the instance to read");
  const node = await readNodeById(nodeId, tool);
  if (node.type !== "INSTANCE") {
    throw new Error(
      `${nodeId} "${node.name}" is a ${node.type} node, not an INSTANCE. ${tool} reads an instance; call get_component for a component or a component set, or get_node for any other node.`
    );
  }

  // `mainComponent` is write-only under `dynamic-page`.
  const main = await node.getMainComponentAsync();
  const mainParent = main ? main.parent : null;
  const set = mainParent && mainParent.type === "COMPONENT_SET" ? mainParent : null;

  const properties: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(node.componentProperties)) {
    properties[name] = { type: property.type, value: property.value };
  }

  return {
    id: node.id,
    name: node.name,
    mainComponent: main
      ? {
          id: main.id,
          name: main.name,
          parentSetId: set ? set.id : null,
          parentSetName: set ? set.name : null,
          remote: main.remote,
        }
      : null,
    properties,
    exposedInstanceIds: node.exposedInstances.map((exposed) => exposed.id),
    overrides: node.overrides.map((override) => ({
      id: override.id,
      overriddenFields: override.overriddenFields,
    })),
  };
};

/** The component property types these tools cover. */
const PROPERTY_TYPES = ["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"] as const;

type SupportedPropertyType = (typeof PROPERTY_TYPES)[number];

/** The most components one preferredValues list carries. */
const MAX_PREFERRED_VALUES = 50;

/**
 * The property type each node field reads, keyed as Figma keys them in
 * `componentPropertyReferences`.
 */
const REFERENCE_FIELDS = {
  characters: "TEXT",
  visible: "BOOLEAN",
  mainComponent: "INSTANCE_SWAP",
} as const;

type ReferenceField = keyof typeof REFERENCE_FIELDS;

/** One property of a component, as the name lookup needs it. */
type PropertyEntry = {
  /** The full name, suffix and all, which is the name the API takes. */
  name: string;
  type: ComponentPropertyType;
  /** The values a VARIANT property accepts. */
  variantOptions?: string[];
};

/** Writes a node as `4:5 "mcp-test/Button"`, the way these errors name one. */
const labelOf = (node: BaseNode): string => `${node.id} "${node.name}"`;

/** Picks the article a property type takes, so INSTANCE_SWAP reads right. */
const articleFor = (type: string): string => (type.startsWith("I") ? "an" : "a");

/** Lists the linkable fields with the property type each one reads. */
const describeReferenceFields = (): string =>
  (Object.keys(REFERENCE_FIELDS) as ReferenceField[])
    .map((field) => {
      const type = REFERENCE_FIELDS[field];
      return `${field} reads ${articleFor(type)} ${type} property`;
    })
    .join(", ");

/**
 * Reads the `type` parameter of `add_component_property`.
 * @param raw - The parameter value.
 * @param tool - The tool name, for the error messages.
 * @returns The property type.
 */
const readPropertyType = (raw: string, tool: string): SupportedPropertyType => {
  const wanted = raw.trim().toUpperCase();
  const match = PROPERTY_TYPES.find((type) => type === wanted);
  if (match) return match;
  if (wanted === "SLOT") {
    throw new Error(
      `${tool} does not add a SLOT property. A slot carries a frame contract these tools do not model, and Figma refuses to set one on an instance. Use INSTANCE_SWAP to let an instance choose the component it shows. The types ${tool} takes are ${PROPERTY_TYPES.join(", ")}.`
    );
  }
  throw new Error(
    `${tool} requires type to be one of ${PROPERTY_TYPES.join(", ")}, received "${raw}".`
  );
};

/**
 * Stops a name that already carries the suffix Figma appends itself.
 * @param name - The name the caller gave.
 * @param key - The parameter name, for the error message.
 * @param tool - The tool name, for the error message.
 */
const requireNameWithoutSuffix = (name: string, key: string, tool: string): void => {
  if (!name.includes("#")) return;
  throw new Error(
    `${tool} requires ${key} without a "#": Figma appends the suffix itself, as in "Label#12:0", and the call returns the full name. Pass the display name alone.`
  );
};

/**
 * Finds the component or component set that owns a property.
 *
 * A variant owns none of its own: `componentPropertyDefinitions` lives on the
 * set. A variant ID therefore comes back with the ID of its set rather than
 * being followed silently, because a property on the set reaches every variant
 * and a caller who named one variant may not expect that.
 * @param componentId - The ID the caller gave.
 * @param tool - The tool name, for the error messages.
 * @returns The component or the component set.
 */
const readPropertyOwner = async (
  componentId: string,
  tool: string
): Promise<ComponentNode | ComponentSetNode> => {
  const node = await readNodeById(componentId, tool);
  if (node.type === "COMPONENT_SET") return node;
  if (node.type === "COMPONENT") {
    const parent = node.parent;
    if (parent && parent.type === "COMPONENT_SET") {
      throw new Error(
        `${labelOf(node)} is one variant of the component set ${labelOf(parent)}, and a variant owns no properties of its own. Pass ${parent.id} to ${tool}: a property on the set reaches every variant of it.`
      );
    }
    return node;
  }
  throw new Error(
    `${labelOf(node)} is a ${node.type} node, not a COMPONENT or a COMPONENT_SET. ${tool} works on the component that owns the property; call list_components to find one, or get_instance to find the main component of an instance.`
  );
};

/**
 * Lists the properties of a component or a component set.
 * @param owner - The component or the component set.
 * @param tool - The tool name, for the error message.
 * @returns One entry per property.
 */
const propertyEntriesOf = (
  owner: ComponentNode | ComponentSetNode,
  tool: string
): PropertyEntry[] => {
  let definitions: ComponentPropertyDefinitions;
  try {
    definitions = owner.componentPropertyDefinitions;
  } catch (err) {
    throw new Error(
      `${tool} could not read the properties of ${labelOf(owner)}: ${messageOf(err)}. Figma reports none for a component set whose variants do not all name the same properties; give every variant the same property names and call it again.`
    );
  }
  return Object.entries(definitions).map(([name, definition]) => ({
    name,
    type: definition.type,
    variantOptions: definition.variantOptions,
  }));
};

/**
 * Finds one property by the name the caller gave.
 *
 * Both names work: the display name Figma shows, and the full name carrying
 * the suffix that keeps two properties of one display name apart. A display
 * name that matches more than one property is refused with the full names,
 * because picking one of them would be a guess.
 * @param entries - The properties of the owner.
 * @param wanted - The name the caller gave.
 * @param owner - The owner, for the error messages.
 * @param tool - The tool name, for the error messages.
 * @returns The property.
 */
const resolveProperty = (
  entries: readonly PropertyEntry[],
  wanted: string,
  owner: string,
  tool: string
): PropertyEntry => {
  const name = wanted.trim();
  if (entries.length === 0) {
    throw new Error(
      `${owner} has no component properties, so there is no "${name}" to change. Call add_component_property to add one.`
    );
  }
  const exact = entries.find((entry) => entry.name === name);
  if (exact) return exact;
  const matches = entries.filter((entry) => displayNameOf(entry.name) === name);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `${owner} has ${matches.length} properties named "${name}": ${matches.map((entry) => entry.name).join(", ")}. Pass one of those full names to ${tool}; the display name alone does not say which.`
    );
  }
  throw new Error(
    `${owner} has no property named "${name}". Its properties are ${entries.map((entry) => `${entry.name} (${entry.type})`).join(", ")}. Pass one of those names, with or without the "#" suffix.`
  );
};

/**
 * Stops a tool on a property type it does not model.
 * @param property - The property.
 * @param owner - The owner, for the error message.
 * @param tool - The tool name, for the error message.
 * @returns The property type, narrowed to the ones these tools cover.
 */
const requireSupportedProperty = (
  property: PropertyEntry,
  owner: string,
  tool: string
): SupportedPropertyType => {
  const match = PROPERTY_TYPES.find((type) => type === property.type);
  if (match) return match;
  throw new Error(
    `${property.name} of ${owner} is ${articleFor(property.type)} ${property.type} property, which ${tool} does not model. These tools cover ${PROPERTY_TYPES.join(", ")}; change ${articleFor(property.type)} ${property.type} property in Figma itself.`
  );
};

/**
 * Reads back the name Figma stored for a property just written.
 *
 * `addComponentProperty` and `editComponentProperty` hand back the name that
 * was asked for, but Figma keeps the display names of one component apart and
 * renames a colliding one behind them: a second "Text" is stored as "Text2".
 * The suffix survives that rename, so it identifies the property, and the
 * stored name is the one the other tools take.
 * @param owner - The component or the component set.
 * @param written - The name the write handed back.
 * @returns The name the file carries now.
 */
const storedPropertyName = (owner: ComponentNode | ComponentSetNode, written: string): string => {
  let names: string[];
  try {
    names = Object.keys(owner.componentPropertyDefinitions);
  } catch {
    return written;
  }
  if (names.includes(written)) return written;
  const hash = written.lastIndexOf("#");
  if (hash < 0) return written;
  const suffix = written.slice(hash);
  return names.find((name) => name.endsWith(suffix)) ?? written;
};

/**
 * Reads a node ID that names the component an instance follows.
 * @param rawId - The ID the caller gave.
 * @param key - The parameter the ID came from, for the error messages.
 * @param tool - The tool name, for the error messages.
 * @returns The component.
 */
const readSwapTarget = async (rawId: string, key: string, tool: string): Promise<ComponentNode> => {
  const node = await figma.getNodeByIdAsync(rawId);
  if (!node) {
    throw new Error(
      `${tool} found no node with the ID ${rawId} for ${key}. Call list_components to list the components of this file.`
    );
  }
  if (node.type === "COMPONENT_SET") {
    const variants = variantsOf(node);
    const example = variants.length > 0 ? `, such as ${labelOf(node.defaultVariant)}` : "";
    throw new Error(
      `${labelOf(node)} is a COMPONENT_SET, and an instance follows one component rather than a whole set. Pass the ID of one variant${example}; call get_component on the set to list them.`
    );
  }
  if (node.type !== "COMPONENT") {
    throw new Error(
      `${labelOf(node)} is a ${node.type} node, not a COMPONENT. ${key} takes the component an instance follows; call list_components to list them.`
    );
  }
  return node;
};

/**
 * Reads a property's default value, or the value one is being set to.
 * @param raw - The parameter value.
 * @param type - The type of the property the value belongs to.
 * @param key - What the value is, for the error messages.
 * @param tool - The tool name, for the error messages.
 * @returns The value, with an INSTANCE_SWAP ID checked against the file.
 */
const readPropertyValue = async (
  raw: unknown,
  type: SupportedPropertyType,
  key: string,
  tool: string
): Promise<string | boolean> => {
  if (type === "BOOLEAN") {
    if (typeof raw !== "boolean") {
      throw new Error(
        `${tool} requires ${key} as true or false for a BOOLEAN property, received ${describeValue(raw)}.`
      );
    }
    return raw;
  }
  if (type === "INSTANCE_SWAP") {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(
        `${tool} requires ${key} as the node ID of a component for an INSTANCE_SWAP property, such as "4029:12345", received ${describeValue(raw)}.`
      );
    }
    return (await readSwapTarget(raw, key, tool)).id;
  }
  if (typeof raw !== "string") {
    throw new Error(
      `${tool} requires ${key} as a string for a ${type} property, received ${describeValue(raw)}.`
    );
  }
  if (type === "VARIANT" && raw.trim() === "") {
    throw new Error(
      `${tool} requires ${key} as a non-empty string for a VARIANT property: the value names one option of the axis, such as "Small".`
    );
  }
  return raw;
};

/**
 * Reads the `preferredValues` parameter: the components Figma offers first in
 * the swap menu of an INSTANCE_SWAP property.
 * @param raw - The parameter value.
 * @param tool - The tool name, for the error messages.
 * @returns The preferred values, or undefined when the parameter is absent.
 */
const readPreferredValues = async (
  raw: unknown,
  tool: string
): Promise<InstanceSwapPreferredValue[] | undefined> => {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      `${tool} requires preferredValues as an array of component or component set IDs, received ${describeValue(raw)}.`
    );
  }
  if (raw.length > MAX_PREFERRED_VALUES) {
    throw new Error(
      `${tool} accepts at most ${MAX_PREFERRED_VALUES} preferredValues, received ${raw.length}. List the components the swap menu should offer first; the others stay reachable through the full list.`
    );
  }
  const values: InstanceSwapPreferredValue[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const rawId = raw[index];
    if (typeof rawId !== "string" || rawId.trim() === "") {
      throw new Error(
        `${tool} requires every item of preferredValues to be a node ID such as "4029:12345", but preferredValues[${index}] is ${describeValue(rawId)}.`
      );
    }
    const node = await figma.getNodeByIdAsync(rawId);
    if (!node) {
      throw new Error(
        `${tool} found no node with the ID ${rawId} at preferredValues[${index}]. Call list_components to list the components of this file.`
      );
    }
    if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
      throw new Error(
        `${labelOf(node)} at preferredValues[${index}] is a ${node.type} node, not a COMPONENT or a COMPONENT_SET. preferredValues names the components the swap menu offers first.`
      );
    }
    if (node.key === "") {
      throw new Error(
        `${labelOf(node)} at preferredValues[${index}] carries no component key, so Figma cannot list it in the swap menu. Drop it from preferredValues.`
      );
    }
    if (seen.has(node.key)) {
      throw new Error(
        `${labelOf(node)} is listed more than once in preferredValues. Name each component once.`
      );
    }
    seen.add(node.key);
    values.push({ type: node.type, key: node.key });
  }
  return values;
};

/**
 * Adds one component property to a component or a component set.
 *
 * Figma appends a unique suffix to a BOOLEAN, TEXT, or INSTANCE_SWAP name, so
 * the full name it hands back is the one the other tools take. A VARIANT name
 * carries no suffix and comes back as it went in.
 * @param req - The extension request.
 * @returns The owner and the full property name.
 */
const addComponentProperty = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "add_component_property";
  const componentId = readRequiredString(req.params, "componentId", tool);
  const name = readRequiredString(req.params, "name", tool);
  const type = readPropertyType(readRequiredString(req.params, "type", tool), tool);
  requireNameWithoutSuffix(name, "name", tool);

  const owner = await readPropertyOwner(componentId, tool);
  if (type === "VARIANT" && owner.type !== "COMPONENT_SET") {
    throw new Error(
      `${labelOf(owner)} is a COMPONENT, and a VARIANT property is an axis of a component set. Call combine_as_variants to build a set first, then add the property to the set. A single component takes a BOOLEAN, TEXT, or INSTANCE_SWAP property.`
    );
  }
  const preferredValues = await readPreferredValues(req.params.preferredValues, tool);
  if (preferredValues !== undefined && type !== "INSTANCE_SWAP") {
    throw new Error(
      `preferredValues names the components an INSTANCE_SWAP property offers first, but ${tool} was called with type ${type}. Drop preferredValues.`
    );
  }
  const defaultValue = await readPropertyValue(req.params.defaultValue, type, "defaultValue", tool);

  let propertyName: string;
  try {
    propertyName = owner.addComponentProperty(
      name,
      type,
      defaultValue,
      preferredValues ? { preferredValues } : undefined
    );
  } catch (err) {
    throw describeWriteError(
      `${tool} could not add the ${type} property "${name}" to ${labelOf(owner)}`,
      err
    );
  }
  return { componentId: owner.id, propertyName: storedPropertyName(owner, propertyName) };
};

/**
 * Changes the name, the default value, or the preferred values of a property.
 * @param req - The extension request.
 * @returns The owner and the property's name after the change.
 */
const editComponentProperty = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "edit_component_property";
  const componentId = readRequiredString(req.params, "componentId", tool);
  const wantedName = readRequiredString(req.params, "propertyName", tool);
  const owner = await readPropertyOwner(componentId, tool);
  const ownerLabel = labelOf(owner);
  const property = resolveProperty(propertyEntriesOf(owner, tool), wantedName, ownerLabel, tool);
  const type = requireSupportedProperty(property, ownerLabel, tool);

  const newName = readOptionalString(req.params, "newName", tool);
  const rawDefault = req.params.newDefaultValue;
  const hasDefault = rawDefault !== undefined && rawDefault !== null;
  const preferredValues = await readPreferredValues(req.params.preferredValues, tool);

  if (newName === undefined && !hasDefault && preferredValues === undefined) {
    throw new Error(
      `${tool} requires at least one of newName, newDefaultValue, and preferredValues. A field left out keeps the value it has.`
    );
  }
  if (newName !== undefined) requireNameWithoutSuffix(newName, "newName", tool);
  if (hasDefault && type === "VARIANT") {
    throw new Error(
      `${property.name} of ${ownerLabel} is a VARIANT property, and Figma takes no default value for one: the first variant of the set is the default. Rename the property with newName, or reorder the variants in Figma to change which one an instance starts on.`
    );
  }
  if (preferredValues !== undefined && type !== "INSTANCE_SWAP") {
    throw new Error(
      `preferredValues names the components an INSTANCE_SWAP property offers first, but ${property.name} of ${ownerLabel} is a ${type} property. Drop preferredValues.`
    );
  }

  const change: {
    name?: string;
    defaultValue?: string | boolean;
    preferredValues?: InstanceSwapPreferredValue[];
  } = {};
  if (newName !== undefined) change.name = newName;
  if (hasDefault) {
    change.defaultValue = await readPropertyValue(rawDefault, type, "newDefaultValue", tool);
  }
  if (preferredValues !== undefined) change.preferredValues = preferredValues;

  let propertyName: string;
  try {
    propertyName = owner.editComponentProperty(property.name, change);
  } catch (err) {
    throw describeWriteError(
      `${tool} could not change the property "${property.name}" of ${ownerLabel}`,
      err
    );
  }
  return { componentId: owner.id, propertyName: storedPropertyName(owner, propertyName) };
};

/**
 * Removes one component property.
 * @param req - The extension request.
 * @returns The owner and the property that was removed.
 */
const deleteComponentProperty = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "delete_component_property";
  if (req.params.confirm !== true) {
    throw new Error(
      `${tool} requires confirm: true. It removes the property from the component and from every instance of it, and each layer the property drove keeps the value it last showed.`
    );
  }
  const componentId = readRequiredString(req.params, "componentId", tool);
  const wantedName = readRequiredString(req.params, "propertyName", tool);
  const owner = await readPropertyOwner(componentId, tool);
  const ownerLabel = labelOf(owner);
  const property = resolveProperty(propertyEntriesOf(owner, tool), wantedName, ownerLabel, tool);
  const type = requireSupportedProperty(property, ownerLabel, tool);
  if (type === "VARIANT") {
    throw new Error(
      `${property.name} of ${ownerLabel} is a VARIANT property, and Figma deletes none: a variant property is an axis of the set, carried in the name of every variant. Rename the variants so they no longer name it, or rename the property with edit_component_property.`
    );
  }

  try {
    owner.deleteComponentProperty(property.name);
  } catch (err) {
    throw describeWriteError(
      `${tool} could not remove the property "${property.name}" from ${ownerLabel}`,
      err
    );
  }
  return { componentId: owner.id, propertyName: property.name };
};

/**
 * Finds the component whose properties a layer can read.
 *
 * A link lives on the main component, so an instance in the way is refused
 * rather than followed: a link written on the copy would not reach the main.
 * @param node - The layer.
 * @param tool - The tool name, for the error messages.
 * @returns The component or the component set that owns the properties.
 */
const findLayerOwner = (node: SceneNode, tool: string): ComponentNode | ComponentSetNode => {
  let current: BaseNode | null = node.parent;
  while (current) {
    if (current.type === "INSTANCE") {
      throw new Error(
        `${labelOf(node)} sits inside the instance ${labelOf(current)}, and a property link lives on the main component rather than on a copy of it. Call get_instance on ${current.id} to find the main component, then link the matching layer inside it.`
      );
    }
    if (current.type === "COMPONENT_SET") return current;
    if (current.type === "COMPONENT") {
      const parent = current.parent;
      return parent && parent.type === "COMPONENT_SET" ? parent : current;
    }
    current = current.parent;
  }
  throw new Error(
    `${labelOf(node)} sits inside no component, so it has no property to read. ${tool} takes a layer inside a component, or inside a variant of a component set; call create_component to make one.`
  );
};

/**
 * Reads the `field` parameter of `bind_component_property`.
 * @param raw - The parameter value.
 * @param tool - The tool name, for the error message.
 * @returns The field.
 */
const readReferenceField = (raw: string, tool: string): ReferenceField => {
  const fields = Object.keys(REFERENCE_FIELDS) as ReferenceField[];
  const match = fields.find((field) => field === raw.trim());
  if (match) return match;
  throw new Error(
    `${tool} requires field to be one of ${fields.join(", ")}, received "${raw}". ${describeReferenceFields()}.`
  );
};

/**
 * Stops a field the layer cannot carry.
 * @param node - The layer.
 * @param field - The field being linked.
 */
const requireFieldNode = (node: SceneNode, field: ReferenceField): void => {
  if (field === "characters" && node.type !== "TEXT") {
    throw new Error(
      `${labelOf(node)} is a ${node.type} node, and characters is the text of a text layer. Link characters on a TEXT node, or link this one through visible to a BOOLEAN property.`
    );
  }
  if (field === "mainComponent" && node.type !== "INSTANCE") {
    throw new Error(
      `${labelOf(node)} is a ${node.type} node, and mainComponent is the component an instance follows. Link mainComponent on an INSTANCE node; call create_instance to place one inside the component.`
    );
  }
};

/**
 * Links a layer inside a component to one of the component's properties, or
 * removes the link.
 *
 * Figma keeps all three links of a layer in one object, so the links the
 * caller did not name are read back and written again alongside the new one.
 * @param req - The extension request.
 * @returns The layer and every link on it after the change.
 */
const bindComponentProperty = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "bind_component_property";
  const nodeId = readNodeId(req, tool, "the layer inside the component to link");
  const field = readReferenceField(readRequiredString(req.params, "field", tool), tool);
  const rawName = req.params.propertyName;
  if (rawName === undefined) {
    throw new Error(
      `${tool} requires propertyName, the property to link ${field} to, or null to remove the link.`
    );
  }

  const node = await getSceneNodeById(nodeId);
  const owner = findLayerOwner(node, tool);
  const ownerLabel = labelOf(owner);

  const links: { characters?: string; visible?: string; mainComponent?: string } = {};
  const current = node.componentPropertyReferences;
  if (current) {
    for (const key of Object.keys(REFERENCE_FIELDS) as ReferenceField[]) {
      const value = current[key];
      if (typeof value === "string") links[key] = value;
    }
  }

  if (rawName === null) {
    delete links[field];
  } else {
    if (typeof rawName !== "string" || rawName.trim() === "") {
      throw new Error(
        `${tool} requires propertyName as a non-empty string, or null to remove the link, received ${describeValue(rawName)}.`
      );
    }
    const property = resolveProperty(propertyEntriesOf(owner, tool), rawName, ownerLabel, tool);
    const type = requireSupportedProperty(property, ownerLabel, tool);
    if (type !== REFERENCE_FIELDS[field]) {
      const wanted = REFERENCE_FIELDS[field];
      throw new Error(
        `${field} reads ${articleFor(wanted)} ${wanted} property, but ${property.name} of ${ownerLabel} is ${articleFor(type)} ${type} property. ${describeReferenceFields()}.`
      );
    }
    requireFieldNode(node, field);
    links[field] = property.name;
  }

  try {
    // Always an object, never null: Figma reports null for a layer that links
    // nothing, but its setter refuses one — removing the last link writes {}.
    node.componentPropertyReferences = links;
  } catch (err) {
    throw describeWriteError(
      `${tool} could not link ${field} of ${labelOf(node)} to a property of ${ownerLabel}`,
      err
    );
  }
  return { nodeId: node.id, componentPropertyReferences: node.componentPropertyReferences };
};

/**
 * Lists the properties an instance takes.
 *
 * The definitions on the main component carry the values a VARIANT property
 * accepts, which the instance's own map does not, so they are read first and
 * the instance answers only when the main cannot be reached.
 * @param instance - The instance.
 * @param tool - The tool name, for the error message.
 * @returns One entry per property.
 */
const instancePropertyEntriesOf = async (
  instance: InstanceNode,
  tool: string
): Promise<PropertyEntry[]> => {
  // `mainComponent` is write-only under `dynamic-page`.
  const main = await instance.getMainComponentAsync();
  if (main) {
    const parent = main.parent;
    return propertyEntriesOf(parent && parent.type === "COMPONENT_SET" ? parent : main, tool);
  }
  return Object.entries(instance.componentProperties).map(([name, property]) => ({
    name,
    type: property.type,
  }));
};

/**
 * Loads the fonts of the text layers a TEXT property drives.
 *
 * Figma refuses a text change whose font is not loaded. A layer deeper than
 * this instance reports leaves the list empty, so every text layer of the
 * instance is loaded as a fallback; a failure there stays quiet, because the
 * layer the property drives is the one that has to succeed.
 * @param instance - The instance.
 * @param propertyNames - The TEXT properties being set.
 * @param tool - The tool name, for the error messages.
 * @returns One problem line per text layer whose font cannot be loaded.
 */
const loadPropertyFonts = async (
  instance: InstanceNode,
  propertyNames: readonly string[],
  tool: string
): Promise<string[]> => {
  if (propertyNames.length === 0) return [];
  const texts = instance.findAll((child) => child.type === "TEXT") as TextNode[];
  const problems: string[] = [];
  for (const name of propertyNames) {
    const driven = texts.filter((text) => text.componentPropertyReferences?.characters === name);
    for (const text of driven.length > 0 ? driven : texts) {
      try {
        await loadFontsForTextNode(text);
      } catch (err) {
        if (driven.length === 0) continue;
        problems.push(
          `properties["${name}"]: the font of the text layer ${labelOf(text)} cannot be loaded: ${messageOf(err)}. Give that layer a font this file can use, then call ${tool} again.`
        );
      }
    }
  }
  return problems;
};

/**
 * Sets the component property values of one instance.
 *
 * Every value is checked against the property it names before the first write,
 * and Figma takes them all in one call, so a bad value leaves the instance as
 * it was.
 * @param req - The extension request.
 * @returns The instance and its property values after the change.
 */
const setInstanceProperties = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "set_instance_properties";
  const nodeId = readNodeId(req, tool, "the instance to change");
  const node = await getSceneNodeById(nodeId);
  if (node.type !== "INSTANCE") {
    throw new Error(
      `${labelOf(node)} is a ${node.type} node, not an INSTANCE. ${tool} sets the property values of one placed instance; call add_component_property or edit_component_property to change the component itself.`
    );
  }

  const raw = req.params.properties;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `${tool} requires properties as an object of property name to value, such as { "Label": "Buy" }, received ${describeValue(raw)}.`
    );
  }
  const wanted = Object.entries(raw as Record<string, unknown>);
  if (wanted.length === 0) {
    throw new Error(
      `${tool} requires properties to name at least one property. Call get_instance to list the properties this instance takes.`
    );
  }

  const entries = await instancePropertyEntriesOf(node, tool);
  const label = labelOf(node);
  const problems: string[] = [];
  const updates: Record<string, string | boolean> = {};
  const textProperties: string[] = [];
  const seen = new Set<string>();

  for (const [rawName, rawValue] of wanted) {
    const fail = (problem: string): void => {
      problems.push(`properties["${rawName}"]: ${problem}`);
    };

    let property: PropertyEntry;
    let type: SupportedPropertyType;
    try {
      property = resolveProperty(entries, rawName, label, tool);
      type = requireSupportedProperty(property, label, tool);
    } catch (err) {
      fail(messageOf(err));
      continue;
    }
    if (seen.has(property.name)) {
      fail(`${property.name} is named twice in properties. Give each property one value.`);
      continue;
    }
    seen.add(property.name);

    if (type === "VARIANT") {
      const options = property.variantOptions ?? [];
      if (typeof rawValue !== "string") {
        fail(
          `${property.name} is a VARIANT property and takes a string, received ${describeValue(rawValue)}. Every variant value is text in Figma, so write 24 as "24".`
        );
        continue;
      }
      if (options.length > 0 && !options.includes(rawValue)) {
        fail(
          `${property.name} has no value "${rawValue}". It takes ${options.join(", ")}. Give one of those.`
        );
        continue;
      }
      updates[property.name] = rawValue;
      continue;
    }

    try {
      updates[property.name] = await readPropertyValue(
        rawValue,
        type,
        `the value of ${property.name}`,
        tool
      );
    } catch (err) {
      fail(messageOf(err));
      continue;
    }
    if (type === "TEXT") textProperties.push(property.name);
  }

  if (problems.length === 0) {
    problems.push(...(await loadPropertyFonts(node, textProperties, tool)));
  }
  if (problems.length > 0) throw validationError(tool, problems);

  try {
    node.setProperties(updates);
  } catch (err) {
    throw describeWriteError(
      `${tool} could not set ${Object.keys(updates).join(", ")} on ${label}`,
      err
    );
  }

  const properties: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(node.componentProperties)) {
    properties[name] = { type: property.type, value: property.value };
  }
  return { id: node.id, properties };
};

export const componentsHandlers = {
  list_components: { edit: false, run: listComponents },
  get_component: { edit: false, run: getComponent },
  get_instance: { edit: false, run: getInstance },
  create_component: { edit: true, run: createComponent },
  combine_as_variants: { edit: true, run: combineAsVariants },
  create_instance: { edit: true, run: createInstance },
  swap_instance: { edit: true, run: swapInstance },
  detach_instance: { edit: true, run: detachInstance },
  add_component_property: { edit: true, run: addComponentProperty },
  edit_component_property: { edit: true, run: editComponentProperty },
  delete_component_property: { edit: true, run: deleteComponentProperty },
  bind_component_property: { edit: true, run: bindComponentProperty },
  set_instance_properties: { edit: true, run: setInstanceProperties },
} satisfies Record<string, ExtensionHandler>;
