/**
 * A stateful simulated plugin for the end-to-end scenario: an in-memory
 * document that the handlers read and write, with result shapes copied from
 * the real handlers of `plugin/src/main`. The document lives in the test
 * process, so it survives each reconnect of the plugin socket.
 *
 * It implements only the request types the scenario sends, and checks only
 * what the scenario needs: a node that does not exist, a property that does
 * not exist, a variant that matches nothing.
 */

import { createHash } from "node:crypto";
import { pngWithSize, type PluginHandler, type PluginRequest } from "./plugin.js";

type Json = Record<string, unknown>;

/** One property definition of a component or a component set. */
interface PropertyDefinition {
  type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "VARIANT";
  defaultValue: string | boolean;
}

export interface ScenarioNode {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  children: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  /** Every other field the handlers wrote: layout, text, fills, links. */
  fields: Json;
  /** For a component or a component set: its property definitions, by stored name. */
  properties?: Record<string, PropertyDefinition>;
  /** For a variant: its values, by property name. */
  variantProperties?: Record<string, string>;
  /** For an instance: its main component, and its property values by stored name. */
  mainComponentId?: string;
  componentProperties?: Record<string, { type: string; value: string | boolean }>;
}

/** The document of the scenario plugin. */
export class ScenarioDocument {
  readonly nodes = new Map<string, ScenarioNode>();
  readonly pages: string[] = [];
  currentPageId: string;
  readonly collections = new Map<string, { id: string; name: string }>();
  readonly variables = new Map<
    string,
    { id: string; name: string; type: string; collectionId: string; value: unknown }
  >();
  readonly textStyles = new Map<string, { id: string; name: string; fontSize: number }>();
  /** The image hashes the file holds. */
  readonly images = new Set<string>();
  /** The `images` array of each `set_image_fill` request: one entry is one upload. */
  readonly uploads: number[] = [];
  private next = 1;

  constructor() {
    this.currentPageId = this.addPage("Page 1").id;
  }

  /** A new node ID, as Figma writes one. */
  newId(): string {
    return `20:${this.next++}`;
  }

  addPage(name: string): ScenarioNode {
    const page = this.add({ id: `0:${this.pages.length + 1}`, name, type: "PAGE", parentId: null });
    this.pages.push(page.id);
    return page;
  }

  add(node: Partial<ScenarioNode> & { id: string; name: string; type: string }): ScenarioNode {
    const full: ScenarioNode = {
      parentId: null,
      children: [],
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fields: {},
      ...node,
    };
    this.nodes.set(full.id, full);
    return full;
  }

  get(id: unknown, label = "node"): ScenarioNode {
    const node = typeof id === "string" ? this.nodes.get(id) : undefined;
    if (!node) throw new Error(`Node not found: ${String(id)} (${label})`);
    return node;
  }

  /** Puts a node into a parent at an index, or on top. */
  insert(node: ScenarioNode, parentId: string, index?: number): void {
    if (node.parentId !== null) this.detach(node);
    const parent = this.get(parentId, "parentId");
    if (index === undefined || index >= parent.children.length) parent.children.push(node.id);
    else parent.children.splice(index, 0, node.id);
    node.parentId = parent.id;
  }

  detach(node: ScenarioNode): void {
    if (node.parentId === null) return;
    const parent = this.get(node.parentId);
    parent.children = parent.children.filter((id) => id !== node.id);
    node.parentId = null;
  }

  /** Removes a node and its subtree. */
  remove(node: ScenarioNode): void {
    this.detach(node);
    const drop = (id: string) => {
      const item = this.nodes.get(id);
      if (!item) return;
      item.children.forEach(drop);
      this.nodes.delete(id);
    };
    drop(node.id);
  }

  pageOf(node: ScenarioNode): ScenarioNode | null {
    let current: ScenarioNode | undefined = node;
    while (current && current.type !== "PAGE") {
      current = current.parentId === null ? undefined : this.nodes.get(current.parentId);
    }
    return current ?? null;
  }

  /** Each node under a root, before its children, the root left out. */
  descendants(root: ScenarioNode): ScenarioNode[] {
    return root.children.flatMap((id) => {
      const child = this.get(id);
      return [child, ...this.descendants(child)];
    });
  }

  /** The IDs, names and parents of every scene node, for a compare. */
  snapshot(): string {
    return JSON.stringify(
      [...this.nodes.values()].map((node) => [node.id, node.name, node.parentId, node.children])
    );
  }
}

/** The first `n` characters of a text, as the outline and find_nodes clip it. */
const clip = (text: unknown): string | undefined =>
  typeof text === "string" ? text.slice(0, 80) : undefined;

/** The layout state of a node, as `layoutState` in `plugin/src/main/layout.ts` reports it. */
function layoutState(doc: ScenarioDocument, node: ScenarioNode): Json {
  const state: Json = {};
  const parent = node.parentId === null ? undefined : doc.nodes.get(node.parentId);
  const inFlow = parent !== undefined && hasAutoLayout(parent);
  if (node.fields.layoutMode !== undefined) state.layoutMode = node.fields.layoutMode;
  if (inFlow || hasAutoLayout(node) || node.type === "TEXT") {
    state.layoutSizingHorizontal = node.fields.layoutSizingHorizontal ?? "FIXED";
    state.layoutSizingVertical = node.fields.layoutSizingVertical ?? "FIXED";
  }
  if (inFlow) state.layoutPositioning = node.fields.layoutPositioning ?? "AUTO";
  return state;
}

const hasAutoLayout = (node: ScenarioNode): boolean =>
  node.fields.layoutMode === "HORIZONTAL" || node.fields.layoutMode === "VERTICAL";

/** The result of a create, as `describeCreated` reports it. */
function describeCreated(doc: ScenarioDocument, node: ScenarioNode): Json {
  const parent = node.parentId === null ? undefined : doc.nodes.get(node.parentId);
  return {
    nodeId: node.id,
    nodeName: node.name,
    type: node.type,
    parentId: parent?.id,
    pageId: doc.pageOf(node)?.id,
    index: parent ? parent.children.indexOf(node.id) : undefined,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    ...layoutState(doc, node),
  };
}

/** The fields of a create that the scenario reads back. */
const LAYOUT_FIELDS = [
  "layoutMode",
  "itemSpacing",
  "counterAxisSpacing",
  "padding",
  "layoutWrap",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
  "layoutPositioning",
  "textAutoResize",
  "fillHex",
  "cornerRadius",
  "characters",
  "fontSize",
  "textStyleId",
];

/** Makes a scene node from the params of a create. */
function create(doc: ScenarioDocument, type: string, params: Json, defaults: Json = {}): Json {
  const parentId = typeof params.parentId === "string" ? params.parentId : doc.currentPageId;
  doc.get(parentId, "parentId");
  const fields: Json = {};
  for (const key of LAYOUT_FIELDS) if (params[key] !== undefined) fields[key] = params[key];
  const node = doc.add({
    id: doc.newId(),
    name: typeof params.name === "string" ? params.name : String(defaults.name ?? type),
    type,
    x: typeof params.x === "number" ? params.x : 0,
    y: typeof params.y === "number" ? params.y : 0,
    width: typeof params.width === "number" ? params.width : Number(defaults.width ?? 100),
    height: typeof params.height === "number" ? params.height : Number(defaults.height ?? 100),
    fields,
  });
  doc.insert(node, parentId, typeof params.index === "number" ? params.index : undefined);
  return describeCreated(doc, node);
}

/** The pairs form or the object form of a name-to-value list. */
function pairs(raw: unknown): [string, string | boolean][] {
  if (Array.isArray(raw)) {
    return raw.map((item) => [String((item as Json).name), (item as Json).value as string]);
  }
  if (typeof raw === "object" && raw !== null) {
    return Object.entries(raw as Record<string, string | boolean>);
  }
  return [];
}

/** The component or set that owns the properties of a component. */
function propertyOwner(doc: ScenarioDocument, node: ScenarioNode): ScenarioNode {
  const parent = node.parentId === null ? undefined : doc.nodes.get(node.parentId);
  return node.type === "COMPONENT" && parent?.type === "COMPONENT_SET" ? parent : node;
}

/** The nearest component or component set above a layer, the layer included. */
function layerOwner(doc: ScenarioDocument, node: ScenarioNode): ScenarioNode {
  let current: ScenarioNode | undefined = node;
  while (current && current.type !== "COMPONENT" && current.type !== "COMPONENT_SET") {
    current = current.parentId === null ? undefined : doc.nodes.get(current.parentId);
  }
  if (!current) throw new Error(`${node.id} is not inside a component`);
  return propertyOwner(doc, current);
}

/** The stored name of a property, found by its display name or its full name. */
function storedName(owner: ScenarioNode, name: string): string {
  for (const key of Object.keys(owner.properties ?? {})) {
    if (key === name || key.split("#")[0] === name) return key;
  }
  throw new Error(`${owner.name} has no property "${name}"`);
}

/** Copies the subtree of a component under an instance, with instance-child IDs. */
function cloneChildren(
  doc: ScenarioDocument,
  source: ScenarioNode,
  target: ScenarioNode,
  instanceId: string
): void {
  for (const id of source.children) {
    const child = doc.get(id);
    const tail = child.id.includes(";") ? child.id.split(";").slice(1).join(";") : child.id;
    const copy = doc.add({
      ...child,
      id: `I${instanceId};${tail}`,
      parentId: null,
      children: [],
      fields: { ...child.fields },
    });
    doc.insert(copy, target.id);
    cloneChildren(doc, child, copy, instanceId);
  }
}

/** The outline of a node, as `reads.ts` walks it with detail outline. */
function outline(
  doc: ScenarioDocument,
  node: ScenarioNode,
  depth: number | undefined,
  level = 0
): Json {
  const self: Json = {
    id: node.id,
    name: node.name,
    type: node.type,
    bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
  };
  if (node.type === "TEXT") self.characters = clip(node.fields.characters);
  if (node.children.length === 0) return self;
  if (depth !== undefined && level >= depth) return { ...self, childCount: node.children.length };
  return {
    ...self,
    children: node.children.map((id) => outline(doc, doc.get(id), depth, level + 1)),
  };
}

/** An entry of `find_nodes`, as `describeFound` writes it. */
function found(doc: ScenarioDocument, node: ScenarioNode): Json {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    pageId: doc.pageOf(node)?.id ?? null,
    parentId: node.parentId,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    ...(node.type === "TEXT" ? { characters: clip(node.fields.characters) } : {}),
  };
}

/** The results of a batch write, as `runBatchWrites` returns them. */
const results = (entries: Json[]): Json => ({
  results: entries.map((entry, index) => ({ index, ok: true, ...entry })),
});

/**
 * The handlers of the scenario plugin, over one document.
 * @param doc - The document the handlers read and write.
 * @returns The handlers, by request type.
 */
export function scenarioHandlers(doc: ScenarioDocument): Record<string, PluginHandler> {
  const params = (request: PluginRequest): Json => request.params ?? {};
  const first = (request: PluginRequest): ScenarioNode => doc.get(request.nodeIds?.[0], "nodeId");

  return {
    create_page: (request) => {
      const page = doc.addPage(String(params(request).name ?? `Page ${doc.pages.length + 1}`));
      if (params(request).setAsCurrent === true) doc.currentPageId = page.id;
      return {
        pageId: page.id,
        pageName: page.name,
        index: doc.pages.indexOf(page.id),
        isCurrentPage: doc.currentPageId === page.id,
      };
    },
    create_frame: (request) => create(doc, "FRAME", params(request), { name: "Frame" }),
    create_text: (request) =>
      create(doc, "TEXT", params(request), { name: params(request).characters, height: 20 }),
    create_shape: (request) =>
      create(doc, String(params(request).shapeType ?? "RECTANGLE"), params(request)),
    create_svg: (request) =>
      create(doc, "FRAME", params(request), { name: "svg", width: 24, height: 24 }),

    set_node_properties: (request) => {
      const node = first(request);
      const applied: Json = {};
      for (const key of ["name", "x", "y", "width", "height", "visible"] as const) {
        const value = params(request)[key];
        if (value === undefined) continue;
        if (key === "visible") node.fields.visible = value;
        else (node as unknown as Json)[key] = value;
        applied[key] = value;
      }
      return { nodeId: node.id, nodeName: node.name, applied };
    },

    create_component: (request) => {
      const p = params(request);
      let component: ScenarioNode;
      if (typeof p.fromNodeId === "string") {
        // Figma makes a new node and moves the children into it.
        const source = doc.get(p.fromNodeId, "fromNodeId");
        const parentId = source.parentId as string;
        const index = doc.get(parentId).children.indexOf(source.id);
        component = doc.add({
          ...source,
          id: doc.newId(),
          type: "COMPONENT",
          parentId: null,
          children: [],
          fields: { ...source.fields },
          properties: {},
        });
        for (const id of [...source.children]) doc.insert(doc.get(id), component.id);
        doc.remove(source);
        doc.insert(component, parentId, index);
      } else {
        component = doc.add({
          id: doc.newId(),
          name: String(p.name ?? "Component"),
          type: "COMPONENT",
          width: Number(p.width),
          height: Number(p.height),
          properties: {},
        });
        doc.insert(component, typeof p.parentId === "string" ? p.parentId : doc.currentPageId);
      }
      if (typeof p.name === "string") component.name = p.name;
      return {
        id: component.id,
        name: component.name,
        parentId: component.parentId,
        x: component.x,
        y: component.y,
        width: component.width,
        height: component.height,
      };
    },

    combine_as_variants: (request) => {
      const p = params(request);
      const components = (p.componentIds as string[]).map((id) => doc.get(id, "componentIds"));
      const parentId =
        typeof p.parentId === "string" ? p.parentId : (components[0].parentId as string);
      const set = doc.add({
        id: doc.newId(),
        name: String(p.name ?? components[0].name),
        type: "COMPONENT_SET",
        properties: {},
      });
      doc.insert(set, parentId);
      for (const component of components) {
        component.variantProperties = Object.fromEntries(
          component.name.split(",").map((part) => part.trim().split("=") as [string, string])
        );
        for (const [name, value] of Object.entries(component.variantProperties)) {
          set.properties![name] ??= { type: "VARIANT", defaultValue: value };
        }
        doc.insert(component, set.id);
      }
      return {
        id: set.id,
        name: set.name,
        variantIds: components.map((component) => component.id),
        width: set.width,
        height: set.height,
      };
    },

    add_component_property: (request) => {
      const p = params(request);
      const owner = doc.get(p.componentId, "componentId");
      const type = p.type as PropertyDefinition["type"];
      const stored = type === "VARIANT" ? String(p.name) : `${String(p.name)}#${doc.newId()}`;
      owner.properties ??= {};
      owner.properties[stored] = {
        type,
        defaultValue: type === "BOOLEAN" ? p.defaultValue === "true" : String(p.defaultValue),
      };
      return { componentId: owner.id, propertyName: stored };
    },

    bind_component_property: (request) => {
      const node = first(request);
      const owner = layerOwner(doc, node);
      const field = String(params(request).field);
      const references = (node.fields.componentPropertyReferences ?? {}) as Json;
      references[field] = storedName(owner, String(params(request).propertyName));
      node.fields.componentPropertyReferences = references;
      return { nodeId: node.id, componentPropertyReferences: references };
    },

    create_instance: (request) => {
      const p = params(request);
      const target = doc.get(p.componentId, "componentId");
      let component = target;
      if (target.type === "COMPONENT_SET") {
        const wanted = pairs(p.variantProperties);
        const variants = target.children.map((id) => doc.get(id));
        const match = variants.find((variant) =>
          wanted.every(([name, value]) => variant.variantProperties?.[name] === value)
        );
        if (!match)
          throw new Error(`No variant of ${target.name} matches ${JSON.stringify(wanted)}`);
        component = match;
      }
      const owner = propertyOwner(doc, component);
      const instance = doc.add({
        id: doc.newId(),
        name: owner.name,
        type: "INSTANCE",
        width: component.width,
        height: component.height,
        mainComponentId: component.id,
        componentProperties: Object.fromEntries(
          Object.entries(owner.properties ?? {}).map(([name, definition]) => [
            name,
            {
              type: definition.type,
              value:
                definition.type === "VARIANT"
                  ? (component.variantProperties?.[name] ?? String(definition.defaultValue))
                  : definition.defaultValue,
            },
          ])
        ),
      });
      doc.insert(instance, typeof p.parentId === "string" ? p.parentId : doc.currentPageId);
      cloneChildren(doc, component, instance, instance.id);
      return {
        id: instance.id,
        name: instance.name,
        mainComponentId: component.id,
        children: instance.children.map((id) => {
          const child = doc.get(id);
          return { id: child.id, name: child.name, type: child.type };
        }),
      };
    },

    set_instance_properties: (request) => {
      const node = first(request);
      if (node.type !== "INSTANCE") throw new Error(`${node.id} is not an INSTANCE`);
      const properties = node.componentProperties ?? {};
      for (const [name, value] of pairs(params(request).properties)) {
        const key = Object.keys(properties).find(
          (stored) => stored === name || stored.split("#")[0] === name
        );
        if (key === undefined) throw new Error(`${node.name} has no property "${name}"`);
        properties[key].value =
          properties[key].type === "BOOLEAN" ? value === true || value === "true" : value;
      }
      return { id: node.id, properties };
    },

    create_variable_collection: (request) => {
      const id = `VariableCollectionId:${doc.newId()}`;
      const collection = { id, name: String(params(request).name) };
      doc.collections.set(id, collection);
      return { ...collection, defaultModeId: `${id.split(":").slice(1).join(":")}:0` };
    },

    create_variables: (request) => {
      const collectionId = String(params(request).collectionId);
      if (!doc.collections.has(collectionId)) {
        throw new Error(`Variable collection not found: ${collectionId}`);
      }
      const items = params(request).variables as Json[];
      return results(
        items.map((item) => {
          const id = `VariableID:${doc.newId()}`;
          doc.variables.set(id, {
            id,
            name: String(item.name),
            type: String(item.type),
            collectionId,
            value: item.value,
          });
          return { id, name: item.name };
        })
      );
    },

    bind_variables: (request) => {
      const bindings = params(request).bindings as Json[];
      for (const binding of bindings) {
        doc.get(binding.nodeId, "bindings.nodeId");
        if (binding.variableId !== null && !doc.variables.has(String(binding.variableId))) {
          throw new Error(`Variable not found: ${String(binding.variableId)}`);
        }
      }
      return results(
        bindings.map((binding) => {
          const node = doc.get(binding.nodeId);
          const bound = (node.fields.boundVariables ?? {}) as Json;
          bound[String(binding.field)] = binding.variableId;
          node.fields.boundVariables = bound;
          return { nodeId: node.id, field: binding.field };
        })
      );
    },

    create_text_style: (request) => {
      const p = params(request);
      const id = `S:${createHash("sha1").update(String(p.name)).digest("hex")},`;
      doc.textStyles.set(id, { id, name: String(p.name), fontSize: Number(p.fontSize) });
      return { id, name: p.name };
    },

    apply_text_style: (request) => {
      const styleId = params(request).styleId;
      if (styleId !== null && !doc.textStyles.has(String(styleId))) {
        throw new Error(`Text style not found: ${String(styleId)}`);
      }
      return results(
        (request.nodeIds ?? []).map((id) => {
          const node = doc.get(id);
          node.fields.textStyleId = styleId;
          return { nodeId: node.id };
        })
      );
    },

    set_image_fill: (request) => {
      const p = params(request);
      const images = p.images as string[];
      doc.uploads.push(images.length);
      const hashes = images.map((base64) => {
        const hash = createHash("sha1").update(Buffer.from(base64, "base64")).digest("hex");
        doc.images.add(hash);
        return hash;
      });
      const items = p.items as Json[];
      for (const item of items) doc.get(item.nodeId, "items.nodeId");
      return results(
        items.map((item) => {
          const imageHash =
            typeof item.image === "number" ? hashes[item.image] : String(item.imageHash);
          doc.get(item.nodeId).fields.imageHash = imageHash;
          return { nodeId: item.nodeId, imageHash };
        })
      );
    },

    get_node: (request) => {
      const node = first(request);
      const depth =
        typeof params(request).depth === "number" ? Number(params(request).depth) : undefined;
      return outline(doc, node, depth);
    },

    find_nodes: (request) => {
      const p = params(request);
      const scope =
        typeof p.withinId === "string" ? doc.get(p.withinId) : doc.get(doc.currentPageId);
      const name = typeof p.name === "string" ? p.name : undefined;
      const types = Array.isArray(p.types) ? (p.types as string[]) : undefined;
      const limit = typeof p.limit === "number" ? p.limit : 50;
      const matches = doc
        .descendants(scope)
        .filter(
          (node) =>
            (types === undefined || types.includes(node.type)) &&
            (name === undefined ||
              (p.exactName === true
                ? node.name === name
                : node.name.toLowerCase().includes(name.toLowerCase())))
        );
      return {
        items: matches.slice(0, limit).map((node) => found(doc, node)),
        truncated: matches.length > limit,
      };
    },

    get_design_system: () => {
      const groups: { collection: { id: string; name: string }; items: Json[] }[] = [];
      for (const variable of doc.variables.values()) {
        const collection = doc.collections.get(variable.collectionId)!;
        let group = groups.find((item) => item.collection.id === collection.id);
        if (!group) groups.push((group = { collection, items: [] }));
        group.items.push({
          id: variable.id,
          name: variable.name,
          type: variable.type,
          value: variable.value,
        });
      }
      const components = [...doc.nodes.values()]
        .filter(
          (node) =>
            node.type === "COMPONENT_SET" ||
            (node.type === "COMPONENT" && propertyOwner(doc, node) === node)
        )
        .map((node) => ({
          id: node.id,
          name: node.name,
          type: node.type,
          pageName: doc.pageOf(node)?.name ?? null,
          properties: node.properties ?? {},
        }));
      const textStyles = [...doc.textStyles.values()];
      return {
        counts: {
          variables: doc.variables.size,
          textStyles: textStyles.length,
          paintStyles: 0,
          effectStyles: 0,
          components: components.length,
        },
        variables: groups,
        textStyles,
        paintStyles: [],
        effectStyles: [],
        components,
      };
    },

    get_screenshot: (request) => {
      const p = params(request);
      const scale = typeof p.scale === "number" ? p.scale : 2;
      const maxEdge = typeof p.maxEdge === "number" ? p.maxEdge : undefined;
      return {
        exports: (request.nodeIds ?? []).map((id) => {
          const node = doc.get(id);
          const longEdge = Math.max(node.width, node.height);
          const used = maxEdge === undefined ? scale : Math.min(scale, maxEdge / longEdge);
          const png = pngWithSize(
            Math.max(1, Math.round(node.width * used)),
            Math.max(1, Math.round(node.height * used))
          );
          return {
            nodeId: node.id,
            nodeName: node.name,
            format: "PNG",
            base64: png.toString("base64"),
            width: node.width,
            height: node.height,
            scale: used,
          };
        }),
      };
    },

    delete_nodes: (request) => {
      const nodes = (request.nodeIds ?? []).map((id) => doc.get(id));
      const deletions = nodes.map((node) => ({
        nodeId: node.id,
        nodeName: node.name,
        parentId: node.parentId,
      }));
      for (const node of nodes) doc.remove(node);
      return { deletedCount: deletions.length, deletions };
    },
  };
}
