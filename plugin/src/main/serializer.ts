// --- Serialized paint types (discriminated union) ---
type SerializedSolidPaint = {
  type: "SOLID";
  color: string;
  opacity?: number;
};

type SerializedGradientPaint = {
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  gradientStops: { color: string; opacity: number; position: number }[];
  gradientTransform: Transform;
  opacity?: number;
};

type SerializedImagePaint = {
  type: "IMAGE";
  scaleMode: string;
  imageHash?: string | null;
  imageTransform?: Transform;
  opacity?: number;
};

type SerializedPaint = SerializedSolidPaint | SerializedGradientPaint | SerializedImagePaint;

// --- Serialized effect types ---
type SerializedShadowEffect = {
  type: "DROP_SHADOW" | "INNER_SHADOW";
  color: string;
  opacity: number;
  offset: { x: number; y: number };
  radius: number;
  spread?: number;
  blendMode: string;
};

type SerializedBlurEffect = {
  type: "LAYER_BLUR" | "BACKGROUND_BLUR";
  radius: number;
};

type SerializedEffect = SerializedShadowEffect | SerializedBlurEffect;

// --- Serialized auto-layout ---
type SerializedAutoLayout = {
  direction: "HORIZONTAL" | "VERTICAL";
  gap: number;
  primaryAxisAlign: string;
  counterAxisAlign: string;
  primaryAxisSizing: string;
  counterAxisSizing: string;
  wrap?: string;
  counterAxisSpacing?: number;
};

// --- Serialized styles ---
type SerializedStyles = {
  opacity?: number;
  blendMode?: string;
  visible?: boolean;
  fills?: SerializedPaint[] | "mixed";
  strokes?: SerializedPaint[] | "mixed";
  strokeWeight?: number | "mixed";
  strokeAlign?: string;
  dashPattern?: number[];
  effects?: SerializedEffect[];
  cornerRadius?: number | "mixed";
  cornerRadii?: {
    topLeft: number;
    topRight: number;
    bottomRight: number;
    bottomLeft: number;
  };
  cornerSmoothing?: number;
  autoLayout?: SerializedAutoLayout;
  padding?: { top: number; right: number; bottom: number; left: number };
  clipsContent?: boolean;
  rotation?: number;
  constraints?: { horizontal: string; vertical: string };
};

/**
 * The variables a node binds, as field to variable ID. An array field such as
 * `fills` maps to one ID per entry, and `componentProperties` keeps its own
 * property names. IDs only: resolving one to a variable name needs an async
 * lookup, and this serializer is synchronous.
 */
type SerializedBoundVariables = Record<string, string | string[] | Record<string, string>>;

type SerializedBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SerializedNode = {
  id: string;
  name: string;
  type: string;
  bounds?: SerializedBounds;
  characters?: string;
  textStyleId?: string;
  styles?: SerializedStyles;
  boundVariables?: SerializedBoundVariables;
  componentProperties?: Record<string, string | boolean>;
  sectionContentsHidden?: boolean;
  children?: SerializedNode[];
  childCount?: number;
  truncated?: boolean;
  note?: string;
};

const isMixed = (value: unknown): value is symbol => typeof value === "symbol";

const toHex = (color: RGB): string => {
  const clamp = (value: number) => Math.min(255, Math.max(0, Math.round(value * 255)));
  const [r, g, b] = [clamp(color.r), clamp(color.g), clamp(color.b)];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

const serializeGradientStops = (
  stops: readonly ColorStop[]
): { color: string; opacity: number; position: number }[] =>
  stops.map((stop) => ({
    color: toHex(stop.color),
    opacity: stop.color.a,
    position: stop.position,
  }));

const serializePaints = (
  paints: readonly Paint[] | symbol | undefined
): SerializedPaint[] | "mixed" => {
  if (isMixed(paints)) return "mixed";
  if (!paints || !Array.isArray(paints)) return [];

  return paints
    .filter((paint) => paint.visible !== false)
    .flatMap((paint): SerializedPaint[] => {
      switch (paint.type) {
        case "SOLID":
          return [
            {
              type: "SOLID",
              color: toHex(paint.color),
              // Left out at the default, like the style fields around it: a
              // paint is opaque unless it says otherwise.
              ...(paint.opacity === 1 ? {} : { opacity: paint.opacity }),
            },
          ];
        case "GRADIENT_LINEAR":
        case "GRADIENT_RADIAL":
        case "GRADIENT_ANGULAR":
        case "GRADIENT_DIAMOND":
          return [
            {
              type: paint.type,
              gradientStops: serializeGradientStops(paint.gradientStops),
              gradientTransform: paint.gradientTransform,
              opacity: paint.opacity,
            },
          ];
        case "IMAGE":
          return [
            {
              type: "IMAGE",
              scaleMode: paint.scaleMode,
              imageHash: paint.imageHash,
              imageTransform: paint.imageTransform,
              opacity: paint.opacity,
            },
          ];
        default:
          return [];
      }
    });
};

const serializeEffects = (effects: readonly Effect[]): SerializedEffect[] =>
  effects
    .filter((effect) => effect.visible !== false)
    .flatMap((effect): SerializedEffect[] => {
      switch (effect.type) {
        case "DROP_SHADOW":
        case "INNER_SHADOW":
          return [
            {
              type: effect.type,
              color: toHex(effect.color),
              opacity: effect.color.a,
              offset: effect.offset,
              radius: effect.radius,
              spread: effect.spread,
              blendMode: effect.blendMode,
            },
          ];
        case "LAYER_BLUR":
        case "BACKGROUND_BLUR":
          return [{ type: effect.type, radius: effect.radius }];
        default:
          return [];
      }
    });

const serializeLineHeight = (lineHeight: LineHeight | symbol) => {
  if (isMixed(lineHeight)) return "mixed";
  if ("value" in lineHeight) {
    return { value: lineHeight.value, unit: lineHeight.unit };
  }
  return { unit: lineHeight.unit };
};

const serializeLetterSpacing = (letterSpacing: LetterSpacing | symbol) => {
  if (isMixed(letterSpacing)) return "mixed";
  return { value: letterSpacing.value, unit: letterSpacing.unit };
};

const getBounds = (node: SerializableNode): SerializedBounds | undefined => {
  if ("x" in node && "y" in node && "width" in node && "height" in node) {
    return {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    };
  }
  return undefined;
};

const serializeText = (node: TextNode, base: SerializedNode) => {
  let fontFamily: string | undefined;
  let fontStyle: string | undefined;
  if (typeof node.fontName === "symbol") {
    fontFamily = "mixed";
    fontStyle = "mixed";
  } else if (node.fontName) {
    fontFamily = node.fontName.family;
    fontStyle = node.fontName.style;
  }
  // Figma reports the mixed symbol when the ranges of the node carry different
  // text styles, and "" when the node is linked to no text style at all.
  const textStyleId = isMixed(node.textStyleId) ? "mixed" : node.textStyleId;
  return {
    ...base,
    characters: node.characters,
    ...(textStyleId === "" ? {} : { textStyleId }),
    styles: {
      ...base.styles,
      fontSize: isMixed(node.fontSize) ? "mixed" : node.fontSize,
      fontFamily,
      fontStyle,
      fontWeight: isMixed(node.fontWeight) ? "mixed" : node.fontWeight,
      textDecoration: isMixed(node.textDecoration) ? "mixed" : node.textDecoration,
      lineHeight: serializeLineHeight(node.lineHeight),
      letterSpacing: serializeLetterSpacing(node.letterSpacing),
      textAlignHorizontal: isMixed(node.textAlignHorizontal) ? "mixed" : node.textAlignHorizontal,
      textAlignVertical: isMixed(node.textAlignVertical) ? "mixed" : node.textAlignVertical,
      textAutoResize: node.textAutoResize,
    },
  };
};

/**
 * A style field is left out when it carries Figma's default.
 *
 * Every node used to report `opacity`, `blendMode`, `visible`, `strokes`,
 * `strokeWeight`, `strokeAlign`, `cornerRadius`, `clipsContent`, and
 * `constraints` whether or not any of them had been touched, which on a frame
 * of a few hundred instances was over half the result and pushed `get_node`
 * past what one tool call should hand an agent. Nothing is lost: a field that
 * is absent holds the default named here, the same way `effects`, `rotation`,
 * and `padding` have always been left out at theirs.
 */
const DEFAULT_BLEND_MODES = new Set(["PASS_THROUGH", "NORMAL"]);

const serializeStyles = (node: SerializableNode): SerializedStyles => {
  const styles: SerializedStyles = {};

  if ("opacity" in node && node.opacity !== 1) {
    styles.opacity = node.opacity as number;
  }
  if ("blendMode" in node && !DEFAULT_BLEND_MODES.has(node.blendMode as string)) {
    styles.blendMode = node.blendMode as string;
  }
  if ("visible" in node && node.visible !== true) {
    styles.visible = node.visible;
  }

  if ("fills" in node) {
    const fills = serializePaints(node.fills);
    if (fills === "mixed" || fills.length > 0) {
      styles.fills = fills;
    }
  }
  if ("strokes" in node) {
    const strokes = serializePaints(node.strokes);
    if (strokes === "mixed" || strokes.length > 0) {
      styles.strokes = strokes;
    }
  }
  // Weight and alignment stand on their own rather than going out with an
  // empty stroke list: a variable binds to strokeWeight whether or not the
  // node is painting a stroke yet, and the value it left has to read back.
  if ("strokeWeight" in node && node.strokeWeight !== 1) {
    styles.strokeWeight = isMixed(node.strokeWeight) ? "mixed" : (node.strokeWeight as number);
  }
  if ("strokeAlign" in node && node.strokeAlign !== "INSIDE") {
    styles.strokeAlign = node.strokeAlign as string;
  }
  if ("dashPattern" in node) {
    const pattern = node.dashPattern as readonly number[];
    if (pattern.length > 0) {
      styles.dashPattern = [...pattern];
    }
  }

  if ("effects" in node) {
    const effects = node.effects as readonly Effect[];
    if (effects.length > 0) {
      styles.effects = serializeEffects(effects);
    }
  }

  if ("cornerRadius" in node && node.cornerRadius !== 0) {
    styles.cornerRadius = isMixed(node.cornerRadius) ? "mixed" : (node.cornerRadius as number);
  }
  if ("topLeftRadius" in node) {
    const tl = node.topLeftRadius as number;
    const tr = node.topRightRadius as number;
    const br = node.bottomRightRadius as number;
    const bl = node.bottomLeftRadius as number;
    if (tl !== tr || tr !== br || br !== bl) {
      styles.cornerRadii = {
        topLeft: tl,
        topRight: tr,
        bottomRight: br,
        bottomLeft: bl,
      };
    }
  }
  if ("cornerSmoothing" in node) {
    const smoothing = node.cornerSmoothing as number;
    if (smoothing > 0) {
      styles.cornerSmoothing = smoothing;
    }
  }

  if ("layoutMode" in node) {
    const mode = node.layoutMode as string;
    if (mode !== "NONE") {
      styles.autoLayout = {
        direction: mode as "HORIZONTAL" | "VERTICAL",
        gap: (node as FrameNode).itemSpacing,
        primaryAxisAlign: (node as FrameNode).primaryAxisAlignItems as string,
        counterAxisAlign: (node as FrameNode).counterAxisAlignItems as string,
        primaryAxisSizing: (node as FrameNode).primaryAxisSizingMode as string,
        counterAxisSizing: (node as FrameNode).counterAxisSizingMode as string,
        wrap: "layoutWrap" in node ? (node.layoutWrap as string) : undefined,
        counterAxisSpacing:
          "counterAxisSpacing" in node ? (node.counterAxisSpacing as number) : undefined,
      };
    }
  }

  if ("paddingLeft" in node) {
    const top = node.paddingTop as number;
    const right = node.paddingRight as number;
    const bottom = node.paddingBottom as number;
    const left = node.paddingLeft as number;
    if (top > 0 || right > 0 || bottom > 0 || left > 0) {
      styles.padding = { top, right, bottom, left };
    }
  }

  if ("clipsContent" in node && node.clipsContent !== false) {
    styles.clipsContent = node.clipsContent as boolean;
  }
  if ("rotation" in node) {
    const rotation = node.rotation as number;
    if (rotation !== 0) {
      styles.rotation = rotation;
    }
  }
  if ("constraints" in node) {
    const c = node.constraints as Constraints;
    if (c.horizontal !== "MIN" || c.vertical !== "MIN") {
      styles.constraints = { horizontal: c.horizontal, vertical: c.vertical };
    }
  }

  return styles;
};

/**
 * Reads the variable ID out of a bound-variable alias.
 * @param value - One entry of a node's `boundVariables`.
 * @returns The variable ID, or undefined when the entry is not an alias.
 */
const toAliasId = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("id" in value)) return undefined;
  const id = (value as VariableAlias).id;
  return typeof id === "string" ? id : undefined;
};

/**
 * Maps every field of a `boundVariables` record to the ID of the variable bound
 * to it. Exported for `get_styles`, where a style carries the same record.
 * @param raw - The `boundVariables` record of a node or a style.
 * @returns The bindings, or undefined when nothing is bound.
 */
export const serializeBoundVariableMap = (
  raw: Record<string, unknown>
): SerializedBoundVariables | undefined => {
  const bound: SerializedBoundVariables = {};
  for (const [field, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      const ids = value.map(toAliasId).filter((id): id is string => id !== undefined);
      if (ids.length > 0) bound[field] = ids;
      continue;
    }
    const id = toAliasId(value);
    if (id !== undefined) {
      bound[field] = id;
      continue;
    }
    // `componentProperties` keys its aliases by property name instead.
    if (typeof value === "object" && value !== null) {
      const byProperty: Record<string, string> = {};
      for (const [property, alias] of Object.entries(value as Record<string, unknown>)) {
        const aliasId = toAliasId(alias);
        if (aliasId !== undefined) byProperty[property] = aliasId;
      }
      if (Object.keys(byProperty).length > 0) bound[field] = byProperty;
    }
  }
  return Object.keys(bound).length > 0 ? bound : undefined;
};

/**
 * Maps every field a node binds to the ID of the variable bound to it.
 * @param node - The node to read.
 * @returns The bindings, or undefined when the node binds nothing.
 */
const serializeBoundVariables = (node: SerializableNode): SerializedBoundVariables | undefined =>
  "boundVariables" in node && node.boundVariables
    ? serializeBoundVariableMap(node.boundVariables as Record<string, unknown>)
    : undefined;

/**
 * Reads the component property values an instance carries, as the full
 * property name to its value.
 *
 * The name keeps the `#12:0` suffix Figma gives it, because that is the name
 * get_component reports and the name the write APIs take.
 * @param node - The instance to read.
 * @returns The values, or undefined when the instance takes no properties.
 */
const serializeComponentProperties = (
  node: InstanceNode
): Record<string, string | boolean> | undefined => {
  const properties: Record<string, string | boolean> = {};
  for (const [name, property] of Object.entries(node.componentProperties)) {
    properties[name] = property.value;
  }
  return Object.keys(properties).length > 0 ? properties : undefined;
};

/**
 * `serializeNode` is also called with the current page (get_document,
 * get_design_context), which shares the id/name/type/children surface it reads.
 * Every property beyond that is read behind an `in` check.
 */
export type SerializableNode = SceneNode | PageNode;

/**
 * Serializes one node on its own, without its children.
 * @param node - The node.
 * @returns The node, with no `children`.
 */
const serializeSelf = (node: SerializableNode): SerializedNode => {
  const base: SerializedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    bounds: getBounds(node),
    styles: serializeStyles(node),
  };

  const boundVariables = serializeBoundVariables(node);
  if (boundVariables) base.boundVariables = boundVariables;

  if (node.type === "INSTANCE") {
    const componentProperties = serializeComponentProperties(node);
    if (componentProperties) base.componentProperties = componentProperties;
  }

  // A FigJam flag, and this plugin runs in Figma Design, so it is reported and
  // never written. False is Figma's default and is left out with the rest of
  // them; true says the section is collapsed and hides what it holds.
  if (node.type === "SECTION" && node.sectionContentsHidden) {
    base.sectionContentsHidden = true;
  }

  if (node.type === "TEXT") {
    return serializeText(node, base);
  }

  return base;
};

/**
 * The children of a node that the read tools report: the visible ones.
 * @param node - The node.
 * @returns Its visible children, empty when it takes none.
 */
const visibleChildrenOf = (node: SerializableNode): readonly SceneNode[] =>
  "children" in node ? node.children.filter((child) => child.visible !== false) : [];

export const serializeNode = (node: SerializableNode): SerializedNode => {
  const base = serializeSelf(node);
  const visible = visibleChildrenOf(node);
  // An empty list says only that the node takes children, which its type
  // already says. Left out, like the style fields sitting at their default.
  if (visible.length === 0) return base;
  return { ...base, children: visible.map((child) => serializeNode(child)) };
};

/** The most characters one node read hands back before it starts cutting. */
export const MAX_NODE_RESULT_CHARS = 50_000;

/**
 * Serializes a node, cutting the subtree short when it will not fit.
 *
 * A node read is unbounded by nature: the result is the whole subtree, and a
 * frame holding a few hundred instances runs past what one tool call should
 * hand an agent. A tree that fits comes back untouched, which is nearly every
 * call. One that does not is filled in child by child until the budget runs
 * out, rather than by dropping whole levels — a frame of 200 instances would
 * otherwise have to choose between all of them and none, and none is what it
 * would get.
 *
 * A node the walk stopped at reports `childCount`, the children it really has,
 * beside the `children` it managed to carry. The two together say what is
 * missing, and the note says which call reads it.
 * @param node - The node to serialize.
 * @param budget - The most characters to return.
 * @returns The subtree, marked `truncated` when it was cut.
 */
export const serializeNodeWithinBudget = (
  node: SerializableNode,
  budget = MAX_NODE_RESULT_CHARS
): SerializedNode => {
  const full = serializeNode(node);
  if (JSON.stringify(full).length <= budget) return full;

  const note = `The subtree is larger than ${budget} characters, so it was cut where the budget ran out. A node whose childCount is higher than the children it carries has that many more: call get_node on it, or get_design_context with depth, to read them.`;

  const build = (allowance: number): SerializedNode => {
    let spent = 0;
    const walk = (current: SerializableNode): SerializedNode => {
      const self = serializeSelf(current);
      spent += JSON.stringify(self).length;

      const visible = visibleChildrenOf(current);
      if (visible.length === 0) return self;

      const kept: SerializedNode[] = [];
      for (const child of visible) {
        if (spent >= allowance) break;
        kept.push(walk(child));
      }
      if (kept.length === 0) return { ...self, childCount: visible.length };
      if (kept.length < visible.length) {
        return { ...self, children: kept, childCount: visible.length };
      }
      return { ...self, children: kept };
    };
    return { ...walk(node), truncated: true, note };
  };

  // The walk counts each node on its own, so the commas and the `children`
  // brackets holding them, and this note, land on top of what it counted and
  // carry the result past the budget. Rather than model that overhead, take
  // the overshoot off the allowance and walk again: it converges in a step or
  // two, and a walk is cheap next to the round trip that asked for it.
  let allowance = budget;
  let result = build(allowance);
  for (let attempt = 0; attempt < 8; attempt++) {
    const over = JSON.stringify(result).length - budget;
    if (over <= 0) break;
    allowance = Math.max(0, allowance - over - 64);
    result = build(allowance);
  }
  return result;
};
