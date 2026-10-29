import type { ExtensionHandlerMap, ExtensionRequest } from "./types";
import { describeValue, readOptionalBoolean, readOptionalString } from "./batch";
import { describeProperties, variantOptionsOf } from "./components";
import { clipText } from "../reads";
import { MAX_NODE_RESULT_CHARS, serializeLetterSpacing, serializeLineHeight } from "../serializer";
import { pageOf } from "../shared";

/**
 * Discovery tools: `find_nodes` and `get_design_system`. Both are reads.
 *
 * They are the cheap way in for an agent that has lost its node IDs, or that
 * needs to know what a file already holds before it builds. Each answer stays
 * within the read budget of `MAX_NODE_RESULT_CHARS`, and says when it was cut.
 */

/** The node types `find_nodes` takes. The server enum lists the same. */
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

type FindableType = (typeof FINDABLE_TYPES)[number];

/**
 * What `find_nodes` searches under: a page, a node with children, or the
 * document, whose search also meets its pages.
 */
type Searchable = {
  findAll(callback: (node: BaseNode) => boolean): readonly BaseNode[];
  findAllWithCriteria(criteria: { types: FindableType[] }): readonly BaseNode[];
};

const DEFAULT_FIND_LIMIT = 50;
const MAX_FIND_LIMIT = 500;

/** What `find_nodes` reports for one node. */
type FoundNode = {
  id: string;
  name: string;
  type: string;
  pageId: string | null;
  parentId: string | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: false;
  characters?: string;
};

/**
 * Reads the `types` param of `find_nodes`.
 * @param raw - The param.
 * @returns The types, or undefined when the param is absent.
 */
const readTypes = (raw: unknown): FindableType[] | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const tool = "find_nodes";
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `${tool} requires types as a non-empty array of node types, received ${describeValue(raw)}.`
    );
  }
  const bad = raw.filter(
    (type) => typeof type !== "string" || !(FINDABLE_TYPES as readonly string[]).includes(type)
  );
  if (bad.length > 0) {
    throw new Error(
      `${tool} requires each of types to be one of ${FINDABLE_TYPES.join(", ")}, received ${bad.map((type) => JSON.stringify(type)).join(", ")}.`
    );
  }
  return raw as FindableType[];
};

/**
 * Resolves where `find_nodes` searches.
 * @param withinId - The node or the page to search in, when given.
 * @param allPages - Whether to search the whole file.
 * @returns The node to search under.
 */
const searchScope = async (
  withinId: string | undefined,
  allPages: boolean
): Promise<Searchable> => {
  const tool = "find_nodes";
  if (withinId !== undefined) {
    const page = figma.root.children.find((candidate) => candidate.id === withinId);
    if (page) {
      await page.loadAsync();
      return page as unknown as Searchable;
    }
    const node = await figma.getNodeByIdAsync(withinId);
    if (!node || node.type === "DOCUMENT") {
      throw new Error(
        `${tool} found no node with the ID ${withinId} for withinId. Pass a page ID from get_metadata or a node ID, or drop withinId to search the current page.`
      );
    }
    if (!("findAll" in node)) {
      throw new Error(
        `${tool} cannot search in ${withinId} "${node.name}": a ${node.type} node has no children. Pass its parent as withinId.`
      );
    }
    const holder = pageOf(node);
    if (holder) await holder.loadAsync();
    return node as unknown as Searchable;
  }
  if (allPages) {
    // Under `dynamic-page` the document is searched only once every page is loaded.
    await figma.loadAllPagesAsync();
    return figma.root as unknown as Searchable;
  }
  return figma.currentPage as unknown as Searchable;
};

/**
 * Describes one node that `find_nodes` found.
 * @param node - The node.
 * @returns Its entry.
 */
const describeFound = (node: SceneNode): FoundNode => {
  const page = pageOf(node);
  const found: FoundNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    pageId: page ? page.id : null,
    parentId: node.parent ? node.parent.id : null,
  };
  if ("x" in node && "y" in node) {
    found.x = node.x;
    found.y = node.y;
  }
  if ("width" in node && "height" in node) {
    found.width = node.width;
    found.height = node.height;
  }
  if (node.visible === false) found.visible = false;
  if (node.type === "TEXT") found.characters = clipText(node.characters);
  return found;
};

/**
 * Finds nodes by name, by type, or both, in document order.
 *
 * The entries stop at `limit` and at the read budget; either sets `truncated`.
 * @param req - The extension request.
 * @returns `{ items, truncated }`.
 */
const findNodes = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "find_nodes";
  const name = readOptionalString(req.params, "name", tool);
  const types = readTypes(req.params.types);
  const exactName = readOptionalBoolean(req.params, "exactName", tool) ?? false;
  const withinId = readOptionalString(req.params, "withinId", tool);
  const allPages = readOptionalBoolean(req.params, "allPages", tool) ?? false;
  if (name === undefined && types === undefined) {
    throw new Error(
      `${tool} requires name, types, or both. Pass a part of the layer name as name, or a list of node types as types.`
    );
  }

  let limit = DEFAULT_FIND_LIMIT;
  const rawLimit = req.params.limit;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (
      typeof rawLimit !== "number" ||
      !Number.isInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > MAX_FIND_LIMIT
    ) {
      throw new Error(
        `${tool} requires limit as a whole number from 1 to ${MAX_FIND_LIMIT}, received ${typeof rawLimit === "number" ? rawLimit : describeValue(rawLimit)}.`
      );
    }
    limit = rawLimit;
  }

  const scope = await searchScope(withinId, allPages);
  const needle = name === undefined ? "" : name.toLowerCase();
  // A search of the document meets its pages too; a page is not a result.
  const matches = (node: BaseNode): node is SceneNode =>
    node.type !== "PAGE" &&
    node.type !== "DOCUMENT" &&
    (name === undefined ||
      (exactName ? node.name === name : node.name.toLowerCase().includes(needle)));
  const found = types
    ? scope.findAllWithCriteria({ types }).filter(matches)
    : scope.findAll(matches).filter(matches);

  const items: FoundNode[] = [];
  // The brackets, the flag, and the commas around the entries.
  let spent = 32;
  let truncated = found.length > limit;
  for (const node of found.slice(0, limit)) {
    const item = describeFound(node);
    const size = JSON.stringify(item).length + 1;
    if (spent + size > MAX_NODE_RESULT_CHARS) {
      truncated = true;
      break;
    }
    spent += size;
    items.push(item);
  }
  return { items, truncated };
};

/** The parts of a design system that `get_design_system` can report. */
const DESIGN_SYSTEM_PARTS = [
  "variables",
  "textStyles",
  "paintStyles",
  "effectStyles",
  "components",
] as const;

type DesignSystemPart = (typeof DESIGN_SYSTEM_PARTS)[number];

/**
 * A color as hex: `#rrggbb`, with two more digits when it is not opaque.
 * @param color - The color.
 * @param alpha - The opacity, from the color or the paint.
 * @returns The hex.
 */
const hexOf = (color: RGB, alpha = 1): string => {
  const byte = (value: number) =>
    Math.min(255, Math.max(0, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0");
  const rgb = `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
  return alpha < 1 ? `${rgb}${byte(alpha)}` : rgb;
};

/** One variable of `get_design_system`, kept beside its collection while the lists are cut. */
type VariableEntry = {
  collection: { id: string; name: string };
  item: { id: string; name: string; type: string; value: unknown };
};

/**
 * The value of a variable in the default mode of its collection.
 * @param value - The raw value.
 * @param names - The name of each local variable, by ID.
 * @returns A hex for a color, `{ alias }` for an alias, else the raw value.
 */
const defaultValueOf = (value: VariableValue | undefined, names: Map<string, string>): unknown => {
  if (typeof value === "object" && value !== null) {
    if ("type" in value && value.type === "VARIABLE_ALIAS") {
      return { alias: names.get(value.id) ?? value.id };
    }
    if ("r" in value && "g" in value && "b" in value) {
      return hexOf(value, "a" in value ? value.a : 1);
    }
  }
  return value ?? null;
};

/**
 * Reads the local variables, one entry each, with the default-mode value.
 * @returns The entries, collection by collection.
 */
const readVariables = async (): Promise<VariableEntry[]> => {
  const [collections, variables] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
  ]);
  const byId = new Map(variables.map((variable) => [variable.id, variable]));
  const names = new Map(variables.map((variable) => [variable.id, variable.name]));
  return collections.flatMap((collection) =>
    collection.variableIds.flatMap((id) => {
      const variable = byId.get(id);
      if (!variable) return [];
      return [
        {
          collection: { id: collection.id, name: collection.name },
          item: {
            id: variable.id,
            name: variable.name,
            type: variable.resolvedType,
            value: defaultValueOf(variable.valuesByMode[collection.defaultModeId], names),
          },
        },
      ];
    })
  );
};

/**
 * Reads the local components and component sets of every page. A variant is
 * carried by its set, as in `list_components`.
 * @returns One entry each, by name.
 */
const readComponents = async (): Promise<unknown[]> => {
  await figma.loadAllPagesAsync();
  const found = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
  return found
    .filter((node) => !(node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
    .map((node) => {
      let properties: { name: string; type: string }[] = [];
      try {
        properties = describeProperties(node)
          // A set reports its variant properties under variantProperties.
          .filter((property) => property.type !== "VARIANT")
          .map((property) => ({ name: property.name, type: property.type }));
      } catch {
        // A set whose variants conflict refuses its definitions; it still lists.
      }
      const page = pageOf(node);
      return {
        id: node.id,
        name: node.name,
        type: node.type,
        pageName: page ? page.name : null,
        ...(node.type === "COMPONENT_SET" ? { variantProperties: variantOptionsOf(node) } : {}),
        properties,
      };
    });
};

/**
 * Reads the parts of the design system asked for.
 * @param include - The parts.
 * @returns The list of each part.
 */
const readParts = async (include: readonly DesignSystemPart[]) => {
  const lists: Partial<Record<DesignSystemPart, unknown[]>> = {};
  if (include.includes("variables")) lists.variables = await readVariables();
  if (include.includes("textStyles")) {
    lists.textStyles = (await figma.getLocalTextStylesAsync()).map((style) => ({
      id: style.id,
      name: style.name,
      fontFamily: style.fontName.family,
      fontStyle: style.fontName.style,
      fontSize: style.fontSize,
      lineHeight: serializeLineHeight(style.lineHeight),
      letterSpacing: serializeLetterSpacing(style.letterSpacing),
    }));
  }
  if (include.includes("paintStyles")) {
    lists.paintStyles = (await figma.getLocalPaintStylesAsync()).map((style) => {
      const visible = style.paints.filter((paint) => paint.visible !== false);
      const only = visible.length === 1 ? visible[0] : undefined;
      // A hex says it all for one solid paint; anything else is read with get_styles.
      return only && only.type === "SOLID"
        ? { id: style.id, name: style.name, hex: hexOf(only.color, only.opacity ?? 1) }
        : { id: style.id, name: style.name };
    });
  }
  if (include.includes("effectStyles")) {
    lists.effectStyles = (await figma.getLocalEffectStylesAsync()).map((style) => ({
      id: style.id,
      name: style.name,
    }));
  }
  if (include.includes("components")) lists.components = await readComponents();
  return lists;
};

/**
 * Groups the variable entries by collection again, in their order.
 * @param entries - The entries.
 * @returns One group for each collection that holds an entry.
 */
const groupVariables = (entries: readonly VariableEntry[]) => {
  const groups: { collection: { id: string; name: string }; items: VariableEntry["item"][] }[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.collection.id === entry.collection.id) last.items.push(entry.item);
    else groups.push({ collection: entry.collection, items: [entry.item] });
  }
  return groups;
};

/**
 * Reports what a file holds to reuse: its variables with their default-mode
 * values, its text, paint and effect styles, and its local components.
 *
 * The answer stays within the read budget: when it does not fit, the longest
 * list loses entries from its end first. `counts` keeps the full size of each
 * list, and `truncated` says that one was cut.
 * @param req - The extension request.
 * @returns The design system.
 */
const getDesignSystem = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "get_design_system";
  const rawInclude = req.params.include;
  let include: readonly DesignSystemPart[] = DESIGN_SYSTEM_PARTS;
  if (rawInclude !== undefined && rawInclude !== null) {
    const valid =
      Array.isArray(rawInclude) &&
      rawInclude.length > 0 &&
      rawInclude.every((part) => (DESIGN_SYSTEM_PARTS as readonly unknown[]).includes(part));
    if (!valid) {
      throw new Error(
        `${tool} requires include as a non-empty array of ${DESIGN_SYSTEM_PARTS.join(", ")}, received ${describeValue(rawInclude)}. Drop include to read every part.`
      );
    }
    include = DESIGN_SYSTEM_PARTS.filter((part) => (rawInclude as unknown[]).includes(part));
  }

  const lists = await readParts(include);
  const counts: Partial<Record<DesignSystemPart, number>> = {};
  for (const part of include) counts[part] = lists[part]?.length ?? 0;

  const build = (cut: boolean) => {
    const result: Record<string, unknown> = { counts };
    for (const part of include) {
      const list = lists[part] ?? [];
      result[part] = part === "variables" ? groupVariables(list as VariableEntry[]) : list;
    }
    if (cut) {
      result.truncated = true;
      result.note = `The lists were cut from their end to fit ${MAX_NODE_RESULT_CHARS} characters; counts holds the full size of each. Read a part in full with include, get_variable_defs with collectionId or query, list_components with query, or get_styles.`;
    }
    return result;
  };

  let cut = false;
  let result = build(cut);
  let size = JSON.stringify(result).length;
  while (size > MAX_NODE_RESULT_CHARS) {
    let longest: DesignSystemPart | undefined;
    let longestChars = 0;
    for (const part of include) {
      const list = lists[part] ?? [];
      const chars = list.length === 0 ? 0 : JSON.stringify(list).length;
      if (chars > longestChars) {
        longest = part;
        longestChars = chars;
      }
    }
    if (longest === undefined) break;
    const list = lists[longest] ?? [];
    const perEntry = longestChars / list.length;
    // The note adds about 300 characters the first time.
    const drop = Math.max(1, Math.ceil((size - MAX_NODE_RESULT_CHARS + 400) / perEntry));
    list.length = Math.max(0, list.length - drop);
    cut = true;
    result = build(cut);
    size = JSON.stringify(result).length;
  }
  return result;
};

export const discoveryHandlers = {
  find_nodes: { edit: false, run: findNodes },
  get_design_system: { edit: false, run: getDesignSystem },
} satisfies ExtensionHandlerMap;
