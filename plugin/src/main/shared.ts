/**
 * Helpers shared by the core request handlers in `code.ts` and by the tool
 * handlers under `extensions/`. Moved here verbatim so a new tool does not have
 * to reach into `code.ts` or duplicate node lookup, colour, font, and placement
 * logic.
 */

export const isSceneNode = (node: BaseNode | null): node is SceneNode =>
  node !== null && node.type !== "DOCUMENT" && node.type !== "PAGE";

export const isTextNode = (node: BaseNode | null): node is TextNode =>
  node !== null && node.type === "TEXT";

export const supportsChildren = (node: BaseNode): node is BaseNode & ChildrenMixin =>
  "appendChild" in node;

export const getSceneNodeById = async (nodeId: string): Promise<SceneNode> => {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!isSceneNode(node)) {
    throw new Error(`Node not found: ${nodeId}`);
  }
  return node;
};

export const getTextNodeById = async (nodeId: string): Promise<TextNode> => {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!isTextNode(node)) {
    throw new Error(`Text node not found: ${nodeId}`);
  }
  return node;
};

export const getParentNodeById = async (parentId: string): Promise<BaseNode & ChildrenMixin> => {
  const parent = await figma.getNodeByIdAsync(parentId);
  if (!parent || parent.type === "DOCUMENT" || !supportsChildren(parent)) {
    throw new Error(`Parent does not support children: ${parentId}`);
  }
  // Under `documentAccess: "dynamic-page"` a page's children are inaccessible
  // until the page is explicitly loaded, so every caller would otherwise have
  // to guard before appending.
  if (parent.type === "PAGE") {
    await parent.loadAsync();
  }
  return parent;
};

export const parseHexColor = (hex: string): RGB => {
  const normalized = hex.trim().replace(/^#/, "");
  if (normalized.length !== 3 && normalized.length !== 6) {
    throw new Error(`Invalid hex color: ${hex}`);
  }

  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }

  return {
    r: parseInt(expanded.slice(0, 2), 16) / 255,
    g: parseInt(expanded.slice(2, 4), 16) / 255,
    b: parseInt(expanded.slice(4, 6), 16) / 255,
  };
};

export const loadFontsForTextNode = async (node: TextNode): Promise<void> => {
  const fonts = new Map<string, FontName>();

  if (node.characters.length > 0) {
    for (const font of node.getRangeAllFontNames(0, node.characters.length)) {
      fonts.set(`${font.family}::${font.style}`, font);
    }
  } else if (typeof node.fontName !== "symbol") {
    fonts.set(`${node.fontName.family}::${node.fontName.style}`, node.fontName);
  } else {
    throw new Error(`Cannot determine font for empty mixed-font text node: ${node.id}`);
  }

  await Promise.all([...fonts.values()].map((font) => figma.loadFontAsync(font)));
};

export const ensureFont = async (family: string, style: string): Promise<FontName> => {
  const font: FontName = { family, style };
  await figma.loadFontAsync(font);
  return font;
};

export const positionNode = (node: SceneNode, x: unknown, y: unknown): void => {
  if ("x" in node && typeof x === "number") {
    node.x = x;
  }
  if ("y" in node && typeof y === "number") {
    node.y = y;
  }
};

export const resizeNodeIfSupported = (node: SceneNode, width: unknown, height: unknown): void => {
  if (typeof width !== "number" && typeof height !== "number") {
    return;
  }
  if (!("resize" in node) || typeof node.resize !== "function") {
    throw new Error(`Node does not support resizing: ${node.id}`);
  }
  const nextWidth = typeof width === "number" ? width : node.width;
  const nextHeight = typeof height === "number" ? height : node.height;
  node.resize(nextWidth, nextHeight);
};

export const appendToParentIfProvided = async (
  node: SceneNode,
  parentId: unknown
): Promise<void> => {
  if (typeof parentId !== "string") {
    return;
  }
  const parent = await getParentNodeById(parentId);
  parent.appendChild(node);
};

export const serializeVariableValue = (value: VariableValue): unknown => {
  if (typeof value === "object" && value !== null) {
    if ("type" in value && value.type === "VARIABLE_ALIAS") {
      return { type: "VARIABLE_ALIAS", id: value.id };
    }
    if ("r" in value && "g" in value && "b" in value) {
      // It's an RGB or RGBA color
      const color = value as RGBA;
      return {
        type: "COLOR",
        r: color.r,
        g: color.g,
        b: color.b,
        a: "a" in color ? color.a : 1,
      };
    }
  }
  return value;
};

/**
 * Names the page a node sits on.
 * @param node - The node to check.
 * @returns The page, or null when the node hangs outside the page tree.
 */
export const pageOf = (node: BaseNode): PageNode | null => {
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === "PAGE") return current;
    current = current.parent;
  }
  return null;
};

/**
 * The IDs of everything a node sits inside, up to the document.
 * @param node - The node to walk up from.
 * @returns The ancestor IDs.
 */
export const ancestorIdsOf = (node: BaseNode): Set<string> => {
  const ids = new Set<string>();
  let current: BaseNode | null = node.parent;
  while (current) {
    ids.add(current.id);
    current = current.parent;
  }
  return ids;
};

/**
 * The sections a node sits inside, nearest first.
 *
 * Only a page or another section holds a section, so for a section this chain
 * is also how deeply it is nested.
 * @param node - The node to walk up from.
 * @returns The sections around it, nearest first.
 */
export const sectionAncestorsOf = (node: SceneNode): SectionNode[] => {
  const chain: SectionNode[] = [];
  let current: BaseNode | null = node.parent;
  while (current) {
    if (current.type === "SECTION") chain.push(current);
    current = current.parent;
  }
  return chain;
};

/**
 * A container a section can sit in, and that a section's children sit in.
 *
 * Figma keeps a section outside the frame tree: its parent is a page or
 * another section, never a frame, a group, a component, or an instance.
 */
export type SectionParent = PageNode | SectionNode;

/**
 * The absolute position a container's children measure from.
 *
 * Read off `absoluteTransform` rather than `absoluteBoundingBox`, which is
 * nullable. A section does not rotate, so the two agree; a page is the canvas
 * origin itself.
 * @param container - The page or section.
 * @returns Its absolute x and y.
 */
export const absoluteOriginOf = (container: SectionParent): { x: number; y: number } => {
  if (container.type === "PAGE") return { x: 0, y: 0 };
  const transform = container.absoluteTransform;
  return { x: transform[0][2], y: transform[1][2] };
};

/**
 * Loads a container that is a page, so its children can be read and written.
 *
 * Under `documentAccess: "dynamic-page"` a page's contents stay unloaded until
 * they are asked for. Anything else is already readable, so this is a no-op.
 * @param container - The container to load.
 */
export const loadIfPage = async (container: BaseNode): Promise<void> => {
  if (container.type === "PAGE") await container.loadAsync();
};

/**
 * Moves a node into a container and leaves it where it is on the canvas.
 *
 * `appendChild` keeps the node's own x and y, which are read against whatever
 * parent it has, so a plain move slides the node by the distance between the
 * old parent and the new one. Reading `absoluteTransform` before the move and
 * writing it back as `relativeTransform` afterwards, less the new parent's own
 * absolute position, puts the node back where the user left it. Neither a page
 * nor a section rotates, so the rest of the transform carries across as it is.
 * @param node - The node to move.
 * @param parent - The page or section to move it into.
 * @param at - Where to place the node in the parent's stack, topmost by default.
 */
export const moveKeepingCanvasPosition = (
  node: SceneNode,
  parent: SectionParent,
  at?: number
): void => {
  const before = node.absoluteTransform;
  if (at === undefined) parent.appendChild(node);
  else parent.insertChild(at, node);
  const origin = absoluteOriginOf(parent);
  node.relativeTransform = [
    [before[0][0], before[0][1], before[0][2] - origin.x],
    [before[1][0], before[1][1], before[1][2] - origin.y],
  ];
};
