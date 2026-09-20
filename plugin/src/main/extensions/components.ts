import {
  getParentNodeById,
  getSceneNodeById,
  parseHexColor,
  positionNode,
  supportsChildren,
} from "../shared";
import {
  describeValue,
  describeWriteError,
  readBatchArray,
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

const VARIANT_NAME_FORM =
  'use "Property=Value", or several pairs separated by commas, as in "Size=Small, State=Hover"';

/**
 * Reads an optional string parameter.
 *
 * A null arrives from a client that spells an absent field out rather than
 * omitting it, so it is read as absent instead of as a bad value.
 * @param params - The request params.
 * @param key - The parameter name.
 * @param tool - The tool name, for the error message.
 * @returns The value, or undefined when the parameter is absent.
 */
const readOptionalString = (
  params: Record<string, unknown>,
  key: string,
  tool: string
): string | undefined => {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${tool} requires ${key} as a non-empty string, received ${describeValue(value)}.`
    );
  }
  return value;
};

/**
 * Reads an optional number parameter.
 * @param params - The request params.
 * @param key - The parameter name.
 * @param tool - The tool name, for the error message.
 * @param min - The smallest value the parameter accepts, when it has one.
 * @returns The value, or undefined when the parameter is absent.
 */
const readOptionalNumber = (
  params: Record<string, unknown>,
  key: string,
  tool: string,
  min?: number
): number | undefined => {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${tool} requires ${key} as a number, received ${describeValue(value)}.`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`${tool} requires ${key} to be ${min} or more, received ${value}.`);
  }
  return value;
};

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

/** Writes a property map as `Size=Small, State=Hover`, in a stable order. */
const describeValues = (values: Map<string, string>): string =>
  [...values.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
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

  const variants = node.children.filter(
    (child): child is ComponentNode => child.type === "COMPONENT"
  );
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
  // The instance ID travels in the request's own `nodeIds` field, as it does
  // for the core tools that take one node: the leader drops a `nodeId` param
  // on the follower RPC path, so one passed there never reaches this handler.
  const nodeId = req.nodeIds && req.nodeIds[0];
  if (typeof nodeId !== "string" || nodeId.trim() === "") {
    throw new Error(
      `${tool} requires nodeId, the instance to point at another component. Call get_document or get_selection to list the node IDs of this page.`
    );
  }
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

export const componentsHandlers = {
  create_component: { edit: true, run: createComponent },
  combine_as_variants: { edit: true, run: combineAsVariants },
  create_instance: { edit: true, run: createInstance },
  swap_instance: { edit: true, run: swapInstance },
  detach_instance: { edit: true, run: detachInstance },
} satisfies Record<string, ExtensionHandler>;
