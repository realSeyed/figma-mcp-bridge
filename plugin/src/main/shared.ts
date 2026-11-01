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
  let node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    for (const page of figma.root.children) {
      if (page.id !== figma.currentPage.id) {
        await page.loadAsync();
        node = await figma.getNodeByIdAsync(nodeId);
        if (node) break;
      }
    }
  }
  if (!isSceneNode(node)) {
    throw new Error(`Node not found: ${nodeId}`);
  }
  return node;
};

export const getTextNodeById = async (nodeId: string): Promise<TextNode> => {
  let node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    for (const page of figma.root.children) {
      if (page.id !== figma.currentPage.id) {
        await page.loadAsync();
        node = await figma.getNodeByIdAsync(nodeId);
        if (node) break;
      }
    }
  }
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

/** How long the font list of `listFontFamilies` stays cached. */
const FONT_LIST_TTL_MS = 5 * 60 * 1000;

let fontFamilyCache: { at: number; families: Map<string, string[]> } | null = null;

/**
 * Forgets the cached font list, so the next call asks Figma again. The tests
 * call it when they install another set of fonts.
 */
export const clearFontFamilyCache = (): void => {
  fontFamilyCache = null;
};

/**
 * Groups every font Figma can use by family, in the order Figma lists them.
 *
 * `listAvailableFontsAsync` returns every font of the account, which is slow
 * to ask for at each text call, and the list changes only when the user
 * installs a font. So the map is cached for the plugin session, for five
 * minutes at most.
 * @returns Family name to its styles.
 */
export const listFontFamilies = async (): Promise<Map<string, string[]>> => {
  if (fontFamilyCache && Date.now() - fontFamilyCache.at < FONT_LIST_TTL_MS) {
    return fontFamilyCache.families;
  }
  const families = new Map<string, string[]>();
  for (const font of await figma.listAvailableFontsAsync()) {
    const styles = families.get(font.fontName.family);
    if (styles) {
      if (!styles.includes(font.fontName.style)) styles.push(font.fontName.style);
    } else {
      families.set(font.fontName.family, [font.fontName.style]);
    }
  }
  fontFamilyCache = { at: Date.now(), families };
  return families;
};

/**
 * Orders two names.
 *
 * A plain comparison rather than `localeCompare`: the plugin sandbox is not a
 * browser, so its Intl support is not something to depend on, and a font list
 * that reorders itself with the host locale is harder to test against.
 * @param a - One name.
 * @param b - The other name.
 * @returns Negative when a sorts first, positive when b does, 0 when equal.
 */
export const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Counts the characters two names open with.
 * @param a - One name.
 * @param b - The other name.
 * @returns How many leading characters they share.
 */
const sharedPrefixLength = (a: string, b: string): number => {
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared++;
  return shared;
};

/**
 * Names the families closest to one Figma does not have, so a misspelling
 * comes back with the spellings to try.
 * @param wanted - The family the caller asked for.
 * @param families - Every family Figma can use.
 * @returns Up to five family names, closest first.
 */
export const similarFamilies = (wanted: string, families: Iterable<string>): string[] => {
  const needle = wanted.trim().toLowerCase();
  const scored: { name: string; score: number }[] = [];

  for (const name of families) {
    const candidate = name.toLowerCase();
    let score: number;
    if (candidate.startsWith(needle) || needle.startsWith(candidate)) {
      score = 0;
    } else if (candidate.includes(needle) || needle.includes(candidate)) {
      score = 1;
    } else {
      const shared = sharedPrefixLength(candidate, needle);
      if (shared === 0) continue;
      score = 2 + (needle.length - shared);
    }
    scored.push({ name, score });
  }

  scored.sort((a, b) => a.score - b.score || compareNames(a.name, b.name));
  return scored.slice(0, 5).map((entry) => entry.name);
};

/**
 * Resolves a family and a style to a font Figma has, and loads it.
 *
 * A text property cannot be written until its font is loaded, so this runs
 * during validation: a font the file cannot use is reported before anything
 * is written, with the closest families or the styles the family has.
 * @param family - The font family.
 * @param style - The font style within that family.
 * @param problems - Collects the complaint when the font is unavailable.
 * @returns The loaded font, or undefined when there is none to load.
 */
export const resolveFont = async (
  family: string,
  style: string,
  problems: string[]
): Promise<FontName | undefined> => {
  const families = await listFontFamilies();
  const styles = families.get(family);

  if (!styles) {
    const near = similarFamilies(family, families.keys());
    const suggestion =
      near.length > 0 ? ` Did you mean ${near.map((name) => `"${name}"`).join(", ")}?` : "";
    problems.push(
      `fontFamily "${family}" is not available in Figma.${suggestion} Call list_fonts to see the families this file can use.`
    );
    return undefined;
  }
  if (!styles.includes(style)) {
    problems.push(
      `fontStyle "${style}" is not available for "${family}". That family has: ${styles.join(", ")}.`
    );
    return undefined;
  }

  const font: FontName = { family, style };
  try {
    await figma.loadFontAsync(font);
  } catch (err) {
    problems.push(
      `the font "${family} ${style}" could not be loaded: ${err instanceof Error ? err.message : String(err)}. Call list_fonts to see the families this file can use.`
    );
    return undefined;
  }
  return font;
};

/**
 * Looks a text style up by ID.
 *
 * `getStyleByIdAsync` throws on a malformed ID and resolves to null on an
 * unknown one, and the ID of another kind of style resolves to that style, so
 * each case comes back as the sentence that names it.
 * @param styleId - The style ID.
 * @returns The style, or the sentence explaining why there is none.
 */
export const findTextStyle = async (styleId: string): Promise<TextStyle | string> => {
  let style: BaseStyle | null = null;
  try {
    style = await figma.getStyleByIdAsync(styleId);
  } catch {
    style = null;
  }
  if (!style) {
    return `text style not found: ${styleId}. Call get_styles to list the text style IDs of this file.`;
  }
  if (style.type !== "TEXT") {
    return `${styleId} is a ${style.type} style, not a text style. Call get_styles and use an ID from its "text" list.`;
  }
  return style as TextStyle;
};

/**
 * Writes a colour as the lowercase `#rrggbb` the read tools report.
 * @param color - The colour, each channel from 0 to 1.
 * @returns The hex string.
 */
export const rgbToHex = (color: RGB): string => {
  const clamp = (value: number) => Math.min(255, Math.max(0, Math.round(value * 255)));
  return `#${[clamp(color.r), clamp(color.g), clamp(color.b)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
};
