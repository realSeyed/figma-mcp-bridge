/**
 * Synthetic nodes for the plugin tests.
 *
 * Plain objects that carry the fields the serializer and the dump read, at
 * Figma's defaults unless a case sets a value. Each ID, name, and value is made
 * up; none comes from a design file.
 *
 * The guard test of the get_node output reads `guardPage`. Its cases also carry
 * the fields only a dump reads (reactions, detachedInfo, the bindings of a
 * paint, the main component, the styled segments, the flow starting points),
 * so the guard proves that the read tools leave them out. Add a case; do not
 * change one: the expected values of the guard test are fixed against them.
 */

/** Stands in for `figma.mixed`: the serializer tests for a symbol. */
export const MIXED: unique symbol = Symbol("figma.mixed");

export type FakeNode = Record<string, unknown> & {
  id: string;
  name: string;
  type: string;
  parent?: FakeNode | null;
  children?: FakeNode[];
};

export const alias = (id: string) => ({ type: "VARIABLE_ALIAS", id });

export const solid = (
  r: number,
  g: number,
  b: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  type: "SOLID",
  visible: true,
  opacity: 1,
  blendMode: "NORMAL",
  color: { r, g, b },
  boundVariables: {},
  ...extra,
});

export const linearGradient = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "GRADIENT_LINEAR",
  visible: true,
  opacity: 1,
  blendMode: "NORMAL",
  gradientStops: [
    { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
    { position: 1, color: { r: 0, g: 0, b: 0, a: 0.5 } },
  ],
  gradientTransform: [
    [1, 0, 0],
    [0, 1, 0],
  ],
  ...extra,
});

export const dropShadow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "DROP_SHADOW",
  visible: true,
  color: { r: 0, g: 0, b: 0, a: 0.25 },
  offset: { x: 0, y: 4 },
  radius: 8,
  spread: 0,
  blendMode: "NORMAL",
  showShadowBehindNode: false,
  boundVariables: {},
  ...extra,
});

export const layerBlur = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "LAYER_BLUR",
  visible: true,
  radius: 4,
  boundVariables: {},
  ...extra,
});

const geometry = () => ({
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  visible: true,
  fills: [] as unknown[],
  strokes: [] as unknown[],
  strokeWeight: 1,
  strokeAlign: "INSIDE",
  dashPattern: [] as number[],
  boundVariables: {},
});

const blendable = () => ({
  opacity: 1,
  blendMode: "PASS_THROUGH",
  effects: [] as unknown[],
  rotation: 0,
  constraints: { horizontal: "MIN", vertical: "MIN" },
  reactions: [] as unknown[],
});

const corners = () => ({
  cornerRadius: 0,
  topLeftRadius: 0,
  topRightRadius: 0,
  bottomRightRadius: 0,
  bottomLeftRadius: 0,
  cornerSmoothing: 0,
});

const frameLayout = () => ({
  layoutMode: "NONE",
  itemSpacing: 0,
  primaryAxisAlignItems: "MIN",
  counterAxisAlignItems: "MIN",
  primaryAxisSizingMode: "AUTO",
  counterAxisSizingMode: "AUTO",
  layoutWrap: "NO_WRAP",
  counterAxisSpacing: 0,
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  clipsContent: false,
});

export const rectangle = (
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
): FakeNode => ({
  id,
  name,
  type: "RECTANGLE",
  ...geometry(),
  ...blendable(),
  ...corners(),
  ...overrides,
});

export const frame = (
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
): FakeNode => ({
  id,
  name,
  type: "FRAME",
  ...geometry(),
  ...blendable(),
  ...corners(),
  ...frameLayout(),
  detachedInfo: null,
  children: [],
  ...overrides,
});

export const component = (
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
): FakeNode => ({
  ...frame(id, name, overrides),
  type: "COMPONENT",
});

export const componentSet = (
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
): FakeNode => ({
  ...frame(id, name, overrides),
  type: "COMPONENT_SET",
});

/**
 * An instance. `main` is what `getMainComponentAsync` resolves to.
 */
export const instance = (
  id: string,
  name: string,
  main: FakeNode | null,
  overrides: Record<string, unknown> = {}
): FakeNode => ({
  ...frame(id, name),
  type: "INSTANCE",
  componentProperties: {},
  getMainComponentAsync: async () => main,
  ...overrides,
});

export type FakeSegment = Record<string, unknown> & {
  start: number;
  end: number;
  characters: string;
};

/**
 * A text node. `segments` is what `getStyledTextSegments` reads from: each
 * segment carries every field, and the fake returns the asked ones.
 */
export const text = (
  id: string,
  name: string,
  segments: FakeSegment[],
  overrides: Record<string, unknown> = {}
): FakeNode => ({
  id,
  name,
  type: "TEXT",
  ...geometry(),
  ...blendable(),
  characters: segments.map((segment) => segment.characters).join(""),
  textStyleId: "",
  fillStyleId: "",
  fontName: { family: "Inter", style: "Regular" },
  fontSize: 12,
  fontWeight: 400,
  textDecoration: "NONE",
  lineHeight: { unit: "AUTO" },
  letterSpacing: { value: 0, unit: "PERCENT" },
  textAlignHorizontal: "LEFT",
  textAlignVertical: "TOP",
  textAutoResize: "WIDTH_AND_HEIGHT",
  getStyledTextSegments: (fields: string[]) =>
    segments.map((segment) => {
      const picked: Record<string, unknown> = {
        characters: segment.characters,
        start: segment.start,
        end: segment.end,
      };
      for (const field of fields) picked[field] = segment[field];
      return picked;
    }),
  ...overrides,
});

export const section = (
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
): FakeNode => ({
  id,
  name,
  type: "SECTION",
  ...geometry(),
  ...corners(),
  sectionContentsHidden: false,
  children: [],
  ...overrides,
});

export const page = (
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
): FakeNode => ({
  id,
  name,
  type: "PAGE",
  backgrounds: [solid(0.96, 0.96, 0.96)],
  flowStartingPoints: [],
  children: [],
  loadAsync: async () => {},
  ...overrides,
});

/**
 * Sets the `parent` of each node in a tree, as Figma does.
 * @param root - The top node.
 * @returns The same root.
 */
export const linkParents = <T extends FakeNode>(root: T): T => {
  for (const child of root.children ?? []) {
    child.parent = root;
    linkParents(child);
  }
  return root;
};

/** The main component of the guard instance, a variant of a set. */
export const guardButtonSet = (): FakeNode =>
  linkParents(
    componentSet("20:1", "Button", {
      children: [component("20:2", "Variant=Primary"), component("20:3", "Variant=Ghost")],
    })
  );

/**
 * The guard page. Each case of the guard test is one of its descendants:
 *
 * - `1:2` a frame with a visible child (`1:3`) and a hidden child (`1:4`);
 * - `1:5` a node with a hidden paint and visible paints, one of them bound;
 * - `1:6` a node with one hidden effect and one visible effect;
 * - `1:7` a node whose effects are all hidden;
 * - `1:8` an instance with component properties;
 * - `1:9` a text node with a mixed text style;
 * - `1:10` a section that holds a frame (`1:11`).
 */
export const guardPage = (): FakeNode => {
  const set = guardButtonSet();
  const primary = (set.children ?? [])[0];
  return linkParents(
    page("1:1", "Guard page", {
      flowStartingPoints: [{ nodeId: "1:2", name: "Guard flow" }],
      children: [
        frame("1:2", "Card", {
          x: 10,
          y: 20,
          width: 320,
          height: 200,
          fills: [solid(1, 1, 1)],
          cornerRadius: 12,
          topLeftRadius: 12,
          topRightRadius: 12,
          bottomRightRadius: 12,
          bottomLeftRadius: 12,
          layoutMode: "VERTICAL",
          itemSpacing: 8,
          paddingTop: 16,
          paddingRight: 16,
          paddingBottom: 16,
          paddingLeft: 16,
          clipsContent: true,
          detachedInfo: { type: "local", componentId: "20:2" },
          reactions: [
            {
              actions: [
                {
                  type: "NODE",
                  destinationId: "1:10",
                  navigation: "NAVIGATE",
                  transition: null,
                  preserveScrollPosition: false,
                },
              ],
              trigger: { type: "ON_CLICK" },
            },
          ],
          children: [
            rectangle("1:3", "Visible child", { width: 40, height: 40 }),
            rectangle("1:4", "Hidden child", { width: 40, height: 40, visible: false }),
          ],
        }),
        rectangle("1:5", "Paints", {
          x: 400,
          fills: [
            solid(1, 0, 0, { visible: false }),
            solid(0, 0, 1, {
              opacity: 0.5,
              boundVariables: { color: alias("VariableID:9:1") },
            }),
            linearGradient(),
          ],
          strokes: [solid(0, 0, 0, { visible: false })],
          strokeWeight: 2,
          boundVariables: { fills: [alias("VariableID:9:1")] },
        }),
        rectangle("1:6", "Effects", {
          x: 520,
          effects: [dropShadow({ visible: false }), layerBlur()],
        }),
        rectangle("1:7", "All effects hidden", {
          x: 640,
          effects: [dropShadow({ type: "INNER_SHADOW", visible: false })],
        }),
        instance("1:8", "Button", primary, {
          x: 760,
          width: 120,
          height: 40,
          componentProperties: {
            "Label#1:0": { type: "TEXT", value: "Go" },
            "Icon#2:0": { type: "BOOLEAN", value: true },
            Variant: { type: "VARIANT", value: "Primary" },
          },
        }),
        text(
          "1:9",
          "Mixed text",
          [
            {
              start: 0,
              end: 6,
              characters: "Hello ",
              fills: [solid(0, 0, 0)],
              textStyleId: "S:guard-body,",
              fillStyleId: "",
              fontName: { family: "Inter", style: "Regular" },
              fontSize: 16,
              fontWeight: 400,
              textDecoration: "NONE",
              lineHeight: { unit: "AUTO" },
              letterSpacing: { value: 0, unit: "PERCENT" },
            },
            {
              start: 6,
              end: 11,
              characters: "world",
              fills: [solid(0, 0, 0)],
              textStyleId: "S:guard-strong,",
              fillStyleId: "",
              fontName: { family: "Inter", style: "Bold" },
              fontSize: 16,
              fontWeight: 700,
              textDecoration: "UNDERLINE",
              lineHeight: { unit: "AUTO" },
              letterSpacing: { value: 0, unit: "PERCENT" },
            },
          ],
          {
            x: 10,
            y: 300,
            fills: [solid(0, 0, 0)],
            textStyleId: MIXED,
            fontName: MIXED,
            fontSize: 16,
            fontWeight: MIXED,
            textDecoration: MIXED,
          }
        ),
        section("1:10", "Section", {
          x: 0,
          y: 600,
          width: 800,
          height: 400,
          fills: [solid(1, 1, 1)],
          sectionContentsHidden: true,
          children: [frame("1:11", "Inside", { x: 80, y: 80 })],
        }),
      ],
    })
  );
};

/**
 * An auto-layout card for the layout sizing cases, apart from the guard page
 * so that page and its expected values stay as they are:
 *
 * - `30:1` a vertical auto-layout frame that hugs its content, with a min and a max width;
 * - `30:2` a child that fills the width and hugs the height;
 * - `30:3` a child that is FIXED on both axes, which reports no layoutSizing;
 * - `30:4` a child out of the flow (ABSOLUTE).
 *
 * Each child carries the sizing fields Figma gives a child of an auto-layout
 * frame. `30:5`, a frame without auto layout, holds `30:6`, which carries them
 * too and reports none: outside auto layout they say nothing.
 */
export const autoLayoutCard = (): FakeNode =>
  linkParents(
    page("30:0", "Layout page", {
      children: [
        frame("30:1", "Responsive card", {
          layoutMode: "VERTICAL",
          layoutSizingHorizontal: "HUG",
          layoutSizingVertical: "HUG",
          layoutPositioning: "AUTO",
          minWidth: 200,
          maxWidth: 480,
          minHeight: null,
          maxHeight: null,
          children: [
            rectangle("30:2", "Fill", {
              layoutSizingHorizontal: "FILL",
              layoutSizingVertical: "HUG",
              layoutPositioning: "AUTO",
            }),
            rectangle("30:3", "Fixed", {
              layoutSizingHorizontal: "FIXED",
              layoutSizingVertical: "FIXED",
              layoutPositioning: "AUTO",
            }),
            rectangle("30:4", "Badge", {
              layoutSizingHorizontal: "FIXED",
              layoutSizingVertical: "FIXED",
              layoutPositioning: "ABSOLUTE",
            }),
          ],
        }),
        frame("30:5", "Plain frame", {
          children: [
            rectangle("30:6", "Plain child", {
              layoutSizingHorizontal: "FIXED",
              layoutSizingVertical: "FIXED",
              layoutPositioning: "ABSOLUTE",
            }),
          ],
        }),
      ],
    })
  );

/**
 * Finds a node of a fake tree by its ID.
 * @param root - The top node.
 * @param id - The node ID.
 * @returns The node.
 */
export const findFake = (root: FakeNode, id: string): FakeNode => {
  const walk = (node: FakeNode): FakeNode | undefined => {
    if (node.id === id) return node;
    for (const child of node.children ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  const found = walk(root);
  if (!found) throw new Error(`No fake node ${id} under ${root.id}`);
  return found;
};
