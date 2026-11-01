/**
 * A fake file for the plugin tests: pages of synthetic nodes, the selection,
 * the node lookup and search, `exportAsync`, and the local variables and
 * styles. It builds on the fake `figma` of `plugin-globals.ts` and the nodes of
 * `nodes.ts`, and is generic on purpose: a test of a read adds what it reads, a
 * test of a write what it writes.
 *
 * `installFakeFile` resets the fake first. The reset of the next test removes
 * each member it added, and puts `root` and `currentPage` back.
 */

import { createHash } from "node:crypto";
import { clearFontFamilyCache } from "../../src/main/shared";
import { fakeFigma, resetFakeFigma } from "./plugin-globals";
import type { FakeFigma } from "./plugin-globals";
import { frame, linkParents, rectangle, solid, text } from "./nodes";
import type { FakeNode } from "./nodes";

/** A local variable collection, as `figma.variables` reports it. */
export type FakeCollection = {
  id: string;
  name: string;
  defaultModeId: string;
  modes: { modeId: string; name: string }[];
  variableIds: string[];
};

/** A local variable. */
export type FakeVariable = {
  id: string;
  name: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  description?: string;
  scopes?: string[];
  valuesByMode: Record<string, unknown>;
};

/** What one export call asked for. */
export type ExportCall = { nodeId: string; settings: Record<string, unknown> };

export type FakeFile = {
  pages: FakeNode[];
  /** The page open in Figma, defaulting to the first. */
  currentPageId?: string;
  /** The IDs of the selected nodes, on the current page. */
  selection?: string[];
  collections?: FakeCollection[];
  variables?: FakeVariable[];
  paintStyles?: unknown[];
  textStyles?: unknown[];
  effectStyles?: unknown[];
  gridStyles?: unknown[];
  /** Builds the bytes of an export. Without it, `exportAsync` gives one byte. */
  exportAsync?: (node: FakeNode, settings: Record<string, unknown>) => Uint8Array;
  /** Turns on the write model: creation, tree operations, layout rules, fonts, images. */
  writes?: FakeWrites;
};

export type InstalledFile = {
  figma: FakeFigma;
  /** Each export call, in order. */
  exports: ExportCall[];
  /** How many times each page was loaded, by page ID, and the document by "*". */
  loads: Map<string, number>;
  /** What the write model recorded, or null when the file has none. */
  writes: WriteRecord | null;
  /** Looks a node up by ID in the tree as it is now. */
  node: (id: string) => FakeNode | null;
};

/**
 * Each node under a root, before its children, the root left out: the order
 * of Figma's `findAll`.
 * @param root - The root.
 * @returns The nodes.
 */
const descendants = (root: FakeNode): FakeNode[] => {
  const found: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    for (const child of node.children ?? []) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
};

/**
 * Gives a node with children `findAll` and `findAllWithCriteria`, and each
 * node `exportAsync`.
 * @param node - The node.
 * @param file - The file.
 * @param exports - The list of export calls.
 */
const equip = (node: FakeNode, file: FakeFile, exports: ExportCall[]): void => {
  if (node.children) {
    node.findAll = (callback?: (candidate: FakeNode) => boolean) =>
      descendants(node).filter((candidate) => (callback ? callback(candidate) : true));
    node.findAllWithCriteria = (criteria: { types?: string[] }) =>
      descendants(node).filter(
        (candidate) => !criteria.types || criteria.types.includes(candidate.type)
      );
  }
  if (node.type !== "PAGE") {
    node.exportAsync = async (settings: Record<string, unknown>) => {
      exports.push({ nodeId: node.id, settings });
      return file.exportAsync ? file.exportAsync(node, settings) : new Uint8Array([0]);
    };
  }
  for (const child of node.children ?? []) equip(child, file, exports);
};

/**
 * Installs a fake file on the fake `figma`.
 * @param file - The file.
 * @returns The fake and what the calls recorded.
 */
export const installFakeFile = (file: FakeFile): InstalledFile => {
  const fake = resetFakeFigma();
  const exports: ExportCall[] = [];
  const loads = new Map<string, number>();
  const count = (key: string) => loads.set(key, (loads.get(key) ?? 0) + 1);

  const root: FakeNode = {
    id: "0:0",
    name: fake.root.name,
    type: "DOCUMENT",
    children: file.pages,
  };
  for (const page of file.pages) {
    linkParents(page);
    page.parent = root;
    page.loadAsync = async () => {
      count(page.id);
    };
  }
  equip(root, file, exports);
  delete root.exportAsync;

  const current = file.pages.find((page) => page.id === file.currentPageId) ?? file.pages[0];
  // The tree as it is at each call: a write can add, move, or remove nodes.
  const byId = (id: string) => [root, ...descendants(root)].find((node) => node.id === id) ?? null;
  current.selection = (file.selection ?? []).map((id) => {
    const node = byId(id);
    if (!node) throw new Error(`The fake selection names no node ${id}`);
    return node;
  });

  fake.root = root as unknown as FakeFigma["root"];
  fake.currentPage = current as unknown as FakeFigma["currentPage"];
  fake.getNodeByIdAsync = async (id: string) => byId(id);
  fake.loadAllPagesAsync = async () => {
    count("*");
  };
  fake.base64Encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  fake.variables = {
    getLocalVariableCollectionsAsync: async () => file.collections ?? [],
    getLocalVariablesAsync: async () => file.variables ?? [],
  };
  fake.getLocalPaintStylesAsync = async () => file.paintStyles ?? [];
  fake.getLocalTextStylesAsync = async () => file.textStyles ?? [];
  fake.getLocalEffectStylesAsync = async () => file.effectStyles ?? [];
  fake.getLocalGridStylesAsync = async () => file.gridStyles ?? [];
  fake.getStyleByIdAsync = async (id: string) =>
    [
      ...(file.paintStyles ?? []),
      ...(file.textStyles ?? []),
      ...(file.effectStyles ?? []),
      ...(file.gridStyles ?? []),
    ].find((style) => (style as { id?: string }).id === id) ?? null;
  // Each file brings its own fonts, so the font list of the last one goes.
  clearFontFamilyCache();
  const writes = file.writes ? installWriteModel(fake, root, file, file.writes) : null;
  return { figma: fakeFigma, exports, loads, writes, node: byId };
};

/**
 * The start of a PNG: the signature and the IHDR chunk, which is all a reader
 * of the pixel size needs.
 * @param width - Pixels.
 * @param height - Pixels.
 * @returns The bytes.
 */
export const pngHeader = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
};

/**
 * Reads the pixel size back from `pngHeader`.
 * @param base64 - The PNG as base64.
 * @returns The size.
 */
export const pngSize = (base64: string): { width: number; height: number } => {
  const bytes = Buffer.from(base64, "base64");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

/*
 * The write model. `installFakeFile({ ..., writes: {} })` turns it on: the
 * creation calls, the tree operations, resize and rescale, the layout rules,
 * fonts, images, and text styles. Each node of the file becomes live: its
 * ruled fields are accessors that throw where Figma throws.
 *
 * Each rule names its source. "typings" is the doc comment of the field in
 * `plugin/node_modules/@figma/plugin-typings/plugin-api.d.ts`. Where the fake
 * simplifies Figma (the layout engine, the text metrics), the comment says so.
 */

/** A font, as `listAvailableFontsAsync` lists it. */
export type FakeFont = { family: string; style: string };

/** The fonts of a write model that names none. */
export const DEFAULT_FONTS: FakeFont[] = [
  { family: "Inter", style: "Regular" },
  { family: "Inter", style: "Medium" },
  { family: "Inter", style: "Bold" },
  { family: "Roboto", style: "Regular" },
];

/** The write model of a fake file. */
export type FakeWrites = {
  /** What `listAvailableFontsAsync` lists, and all `loadFontAsync` loads. */
  fonts?: FakeFont[];
};

/** What the write model records. */
export type WriteRecord = {
  /** Each node a create call made, in order, removed ones included. */
  created: FakeNode[];
  /** The ID of each node `remove()` took out of the tree. */
  removed: string[];
  /** The fonts loaded, as "family/style". */
  loadedFonts: Set<string>;
  /** Each image `createImage` made, by hash. */
  images: Map<string, Uint8Array>;
};

type Sizing = "FIXED" | "HUG" | "FILL";

/** The hidden state of a live node. */
type LiveState = {
  x: number;
  y: number;
  /** The sizing set on an axis; a text derives the rest from textAutoResize. */
  sizingH?: Sizing;
  sizingV?: Sizing;
  positioning: "AUTO" | "ABSOLUTE";
  removed: boolean;
};

/** The node types that hold children. */
const CONTAINERS = new Set([
  "PAGE",
  "FRAME",
  "GROUP",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "SECTION",
]);

/** The frame fields that move the children of an auto-layout frame. */
const LAYOUT_FIELDS = [
  "layoutMode",
  "itemSpacing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
];

/** The text fields Figma writes only through a loaded font (typings: "Setting this property requires the font the be loaded"). */
const FONT_FIELDS = [
  "characters",
  "fontSize",
  "fontName",
  "textAlignHorizontal",
  "textAlignVertical",
  "lineHeight",
  "letterSpacing",
  "textAutoResize",
];

/** The text fields that change the size of an auto-resizing text. */
const TEXT_SIZE_FIELDS = new Set(["characters", "fontSize", "textAutoResize"]);

const fontKey = (font: { family: string; style: string }): string => `${font.family}/${font.style}`;

const isAuto = (node: FakeNode | null | undefined): boolean =>
  !!node && typeof node.layoutMode === "string" && node.layoutMode !== "NONE";

/**
 * Reads the pixel size of a PNG, a GIF, or a JPEG header, as Figma's
 * `createImage` does before it takes the file.
 * @param bytes - The file.
 * @returns The size, or null when the bytes are none of the three.
 */
const imageSize = (bytes: Uint8Array): { width: number; height: number } | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0, 4)) === "GIF8") {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      }
      at += 2 + view.getUint16(at + 2);
    }
  }
  return null;
};

/**
 * Turns on the write model of a fake file.
 * @param fake - The fake `figma`.
 * @param root - The document node.
 * @param file - The file.
 * @param writes - The write model options.
 * @returns What the model records.
 */
const installWriteModel = (
  fake: FakeFigma,
  root: FakeNode,
  file: FakeFile,
  writes: FakeWrites
): WriteRecord => {
  const fonts = writes.fonts ?? DEFAULT_FONTS;
  const record: WriteRecord = {
    created: [],
    removed: [],
    loadedFonts: new Set(),
    images: new Map(),
  };
  const states = new WeakMap<FakeNode, LiveState>();
  const state = (node: FakeNode): LiveState => {
    const found = states.get(node);
    if (!found) throw new Error(`The fake node ${node.id} is not live`);
    return found;
  };
  let nextId = 1;

  // --- Text metrics: a fake simplification. A character is half the font
  // size wide and a line 1.25 font sizes high; nothing else is measured.
  const fitText = (node: FakeNode): void => {
    const size = node.fontSize as number;
    const charWidth = size * 0.5;
    const lineHeight = size * 1.25;
    const paragraphs = String(node.characters).split("\n");
    const mode = node.textAutoResize;
    // A text that fills its parent's width takes that width and wraps.
    const wraps =
      mode === "HEIGHT" || (mode === "WIDTH_AND_HEIGHT" && state(node).sizingH === "FILL");
    if (wraps) {
      const perLine = Math.max(1, Math.floor((node.width as number) / charWidth));
      const lines = paragraphs.reduce(
        (total, paragraph) => total + Math.max(1, Math.ceil(paragraph.length / perLine)),
        0
      );
      node.height = lines * lineHeight;
    } else if (mode === "WIDTH_AND_HEIGHT") {
      node.width = Math.max(...paragraphs.map((paragraph) => paragraph.length)) * charWidth;
      node.height = paragraphs.length * lineHeight;
    }
  };

  const sizingOf = (node: FakeNode, axis: "H" | "V"): Sizing =>
    node[axis === "H" ? "layoutSizingHorizontal" : "layoutSizingVertical"] as Sizing;

  const setDimension = (node: FakeNode, dimension: "width" | "height", value: number): void => {
    if (node[dimension] === value) return;
    node[dimension] = value;
    if (node.type === "TEXT") fitText(node);
    if (isAuto(node)) relayout(node, false);
  };

  // --- The layout engine: a fake simplification of Figma's, with the
  // meaning of FIXED, HUG, and FILL the typings draw for
  // layoutSizingHorizontal. One line or column; no wrap, no min or max.
  const relayout = (frame: FakeNode | null | undefined, climb = true): void => {
    if (!frame || !isAuto(frame)) return;
    const horizontal = frame.layoutMode === "HORIZONTAL";
    const main = horizontal ? "width" : "height";
    const cross = horizontal ? "height" : "width";
    const mainAxis = horizontal ? "H" : "V";
    const crossAxis = horizontal ? "V" : "H";
    const mainStart = (horizontal ? frame.paddingLeft : frame.paddingTop) as number;
    const mainEnd = (horizontal ? frame.paddingRight : frame.paddingBottom) as number;
    const crossStart = (horizontal ? frame.paddingTop : frame.paddingLeft) as number;
    const crossEnd = (horizontal ? frame.paddingBottom : frame.paddingRight) as number;
    const gap = frame.itemSpacing as number;
    const flow = (frame.children ?? []).filter(
      (child) => child.visible !== false && state(child).positioning !== "ABSOLUTE"
    );
    const gaps = gap * Math.max(0, flow.length - 1);

    if (sizingOf(frame, crossAxis) !== "HUG") {
      for (const child of flow) {
        if (sizingOf(child, crossAxis) === "FILL") {
          setDimension(child, cross, (frame[cross] as number) - crossStart - crossEnd);
        }
      }
    }
    if (sizingOf(frame, mainAxis) !== "HUG") {
      const fills = flow.filter((child) => sizingOf(child, mainAxis) === "FILL");
      if (fills.length > 0) {
        const taken = flow
          .filter((child) => sizingOf(child, mainAxis) !== "FILL")
          .reduce((total, child) => total + (child[main] as number), 0);
        const share = ((frame[main] as number) - mainStart - mainEnd - gaps - taken) / fills.length;
        for (const child of fills) setDimension(child, main, Math.max(0.01, share));
      }
    } else {
      frame[main] =
        mainStart +
        mainEnd +
        gaps +
        flow.reduce((total, child) => total + (child[main] as number), 0);
    }
    if (sizingOf(frame, crossAxis) === "HUG") {
      frame[cross] =
        crossStart + crossEnd + Math.max(0, ...flow.map((child) => child[cross] as number));
    }

    let cursor = mainStart;
    for (const child of flow) {
      const childState = state(child);
      if (horizontal) {
        childState.x = cursor;
        childState.y = crossStart;
      } else {
        childState.x = crossStart;
        childState.y = cursor;
      }
      cursor += (child[main] as number) + gap;
    }
    if (climb) relayout(frame.parent);
  };

  // --- Fonts. loadFontAsync loads a font the account has and rejects any
  // other; the text fields throw until their font is loaded (typings).
  const requireLoaded = (font: unknown, field: string): void => {
    const name = font as { family: string; style: string };
    if (!record.loadedFonts.has(fontKey(name))) {
      throw new Error(
        `in set_${field}: Cannot write to node with unloaded font "${name.family} ${name.style}". Please call figma.loadFontAsync({ family: "${name.family}", style: "${name.style}" }) and await the returned promise first.`
      );
    }
  };

  /** Writes a text field without the font rule: Figma's own side effects. */
  const textValues = new WeakMap<FakeNode, Record<string, unknown>>();
  const setTextRaw = (node: FakeNode, field: string, value: unknown): void => {
    textValues.get(node)![field] = value;
    if (TEXT_SIZE_FIELDS.has(field)) fitText(node);
  };

  const detach = (node: FakeNode): FakeNode | null => {
    const parent = node.parent ?? null;
    if (parent?.children) {
      const at = parent.children.indexOf(node);
      if (at >= 0) parent.children.splice(at, 1);
    }
    node.parent = null;
    return parent;
  };

  /**
   * Makes a node live: its ruled fields become accessors, and it gets the
   * tree operations, resize, and rescale.
   * @param node - The node.
   */
  const makeLive = (node: FakeNode): void => {
    const readSizing = (field: string): Sizing | undefined => {
      const value = node[field];
      delete node[field];
      return value === "FIXED" || value === "HUG" || value === "FILL" ? value : undefined;
    };
    const s: LiveState = {
      x: typeof node.x === "number" ? node.x : 0,
      y: typeof node.y === "number" ? node.y : 0,
      sizingH: readSizing("layoutSizingHorizontal"),
      sizingV: readSizing("layoutSizingVertical"),
      positioning: node.layoutPositioning === "ABSOLUTE" ? "ABSOLUTE" : "AUTO",
      removed: false,
    };
    states.set(node, s);
    const define = (field: string, get: () => unknown, set?: (value: unknown) => void): void => {
      Object.defineProperty(node, field, { enumerable: true, configurable: true, get, set });
    };

    if (CONTAINERS.has(node.type)) {
      node.children = node.children ?? [];
      node.appendChild = (child: FakeNode) => {
        const from = detach(child);
        node.children!.push(child);
        child.parent = node;
        relayout(node);
        if (from !== node) relayout(from);
      };
      // typings: insertChild past the end of the children throws.
      node.insertChild = (index: number, child: FakeNode) => {
        const from = detach(child);
        if (index > node.children!.length) {
          throw new Error(`insertChild: index ${index} is past the end (${node.children!.length})`);
        }
        node.children!.splice(index, 0, child);
        child.parent = node;
        relayout(node);
        if (from !== node) relayout(from);
      };
    }
    if (node.type === "PAGE" || node.type === "DOCUMENT") return;

    define("removed", () => s.removed);
    node.remove = () => {
      relayout(detach(node));
      s.removed = true;
      record.removed.push(node.id);
    };

    // typings: x and y of a child of an auto-layout frame are computed, and
    // setting them is a no-op; an ABSOLUTE child takes them.
    const inFlow = () => isAuto(node.parent) && s.positioning !== "ABSOLUTE";
    define(
      "x",
      () => s.x,
      (value) => {
        if (!inFlow()) s.x = value as number;
      }
    );
    define(
      "y",
      () => s.y,
      (value) => {
        if (!inFlow()) s.y = value as number;
      }
    );

    // typings: "HUG" is only valid on auto-layout frames and text nodes,
    // "FILL" only on auto-layout children, and a value that does not apply
    // throws. A text derives its sizing from textAutoResize, as the text
    // resizing modes of the Figma UI do: auto width hugs both axes, auto
    // height hugs the height, fixed size hugs neither.
    for (const [field, axis] of [
      ["layoutSizingHorizontal", "H"],
      ["layoutSizingVertical", "V"],
    ] as const) {
      const key = axis === "H" ? "sizingH" : "sizingV";
      define(
        field,
        () => {
          const raw = s[key];
          if (node.type !== "TEXT" || raw === "FILL") return raw ?? "FIXED";
          const mode = node.textAutoResize;
          if (mode === "WIDTH_AND_HEIGHT") return "HUG";
          if (mode === "HEIGHT") return axis === "H" ? "FIXED" : "HUG";
          return "FIXED";
        },
        (value) => {
          if (value === "HUG" && node.type !== "TEXT" && !isAuto(node)) {
            throw new Error(
              `in set_${field}: "HUG" is only valid on auto-layout frames and text nodes`
            );
          }
          if (value === "FILL" && !isAuto(node.parent)) {
            throw new Error(`in set_${field}: "FILL" is only valid on auto-layout children`);
          }
          if (node.type === "TEXT") {
            const mode = node.textAutoResize;
            s[key] = value === "FILL" ? "FILL" : undefined;
            if (value === "HUG") {
              setTextRaw(
                node,
                "textAutoResize",
                axis === "H" || mode === "WIDTH_AND_HEIGHT" ? "WIDTH_AND_HEIGHT" : "HEIGHT"
              );
            } else if (value === "FIXED") {
              if (axis === "H" && mode === "WIDTH_AND_HEIGHT")
                setTextRaw(node, "textAutoResize", "HEIGHT");
              if (axis === "V" && mode !== "NONE") setTextRaw(node, "textAutoResize", "NONE");
            } else {
              fitText(node);
            }
          } else {
            s[key] = value as Sizing;
          }
          if (isAuto(node)) relayout(node, false);
          relayout(node.parent);
        }
      );
    }

    // typings: layoutPositioning applies to direct children of auto-layout
    // frames only; changing it recomputes the parent.
    define(
      "layoutPositioning",
      () => s.positioning,
      (value) => {
        if (!isAuto(node.parent)) {
          throw new Error(
            "in set_layoutPositioning: only children of auto-layout frames can be positioned"
          );
        }
        s.positioning = value as LiveState["positioning"];
        relayout(node.parent);
      }
    );

    // typings: the min and max sizes apply to auto-layout frames and their
    // direct children only.
    for (const field of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) {
      let limit = (node[field] as number | null | undefined) ?? null;
      define(
        field,
        () => limit,
        (value) => {
          if (!isAuto(node) && !isAuto(node.parent)) {
            throw new Error(
              `in set_${field}: ${field} applies to auto-layout frames and their children only`
            );
          }
          limit = value as number | null;
        }
      );
    }

    if (typeof node.layoutMode === "string") {
      for (const field of LAYOUT_FIELDS) {
        let value = node[field];
        define(
          field,
          () => value,
          (next) => {
            value = next;
            relayout(node);
          }
        );
      }
      // typings: layoutSizing is a shorthand for the axis sizing modes of an
      // auto-layout frame; AUTO is HUG.
      for (const [field, primary] of [
        ["primaryAxisSizingMode", true],
        ["counterAxisSizingMode", false],
      ] as const) {
        define(
          field,
          () => {
            const horizontal = (node.layoutMode === "HORIZONTAL") === primary;
            return (horizontal ? s.sizingH : s.sizingV) === "HUG" ? "AUTO" : "FIXED";
          },
          (value) => {
            const horizontal = (node.layoutMode === "HORIZONTAL") === primary;
            s[horizontal ? "sizingH" : "sizingV"] = value === "AUTO" ? "HUG" : "FIXED";
            relayout(node);
          }
        );
      }
    }

    if (node.type === "TEXT") {
      const values: Record<string, unknown> = {};
      textValues.set(node, values);
      for (const field of FONT_FIELDS) {
        values[field] = node[field];
        define(
          field,
          () => values[field],
          (value) => {
            requireLoaded(field === "fontName" ? value : values.fontName, field);
            setTextRaw(node, field, value);
            relayout(node.parent);
          }
        );
      }
      node.getRangeAllFontNames = () => [values.fontName];
      node.getStyledTextSegments = (fields: string[]) => {
        const segment: Record<string, unknown> = {
          characters: values.characters,
          start: 0,
          end: String(values.characters).length,
        };
        for (const field of fields) segment[field] = node[field];
        return [segment];
      };
      // typings: setTextStyleIdAsync requires the font to be loaded.
      node.setTextStyleIdAsync = async (styleId: string) => {
        const style = (file.textStyles ?? []).find(
          (candidate) => (candidate as { id?: string }).id === styleId
        ) as Record<string, unknown> | undefined;
        if (!style) throw new Error(`in setTextStyleIdAsync: no text style ${styleId}`);
        requireLoaded(style.fontName, "textStyleId");
        node.textStyleId = styleId;
        setTextRaw(node, "fontName", style.fontName);
        if (typeof style.fontSize === "number") setTextRaw(node, "fontSize", style.fontSize);
        relayout(node.parent);
      };
    }

    // typings: width and height must be 0.01 or more, and a LINE must be
    // given a height of exactly 0. The community report "What's the correct
    // way of using textAutoResize" (Figma forum): resize() drops an
    // auto-resize set before it.
    node.resize = (width: number, height: number) => {
      const lineOk = node.type === "LINE" ? height === 0 : height >= 0.01;
      if (!(width >= 0.01) || !lineOk) {
        throw new Error(
          node.type === "LINE"
            ? "in resize: a LINE must be given a height of exactly 0"
            : "in resize: width and height must be >= 0.01"
        );
      }
      node.width = width;
      node.height = height;
      if (node.type === "TEXT") {
        const values = textValues.get(node)!;
        s.sizingH = undefined;
        s.sizingV = undefined;
        if (values.textAutoResize === "WIDTH_AND_HEIGHT" || values.textAutoResize === "HEIGHT") {
          values.textAutoResize = "NONE";
        }
      }
      if (isAuto(node)) relayout(node, false);
      relayout(node.parent);
    };

    // typings: rescale scales from the top-left corner; the factor must be
    // 0.01 or more.
    node.rescale = (scale: number) => {
      if (!(scale >= 0.01)) throw new Error("in rescale: the scale factor must be >= 0.01");
      const scaleTree = (target: FakeNode, top: boolean): void => {
        target.width = (target.width as number) * scale;
        target.height = (target.height as number) * scale;
        if (!top) {
          const targetState = state(target);
          targetState.x *= scale;
          targetState.y *= scale;
        }
        for (const child of target.children ?? []) scaleTree(child, false);
      };
      scaleTree(node, true);
      relayout(node.parent);
    };
  };

  const walk = (node: FakeNode): void => {
    makeLive(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);

  /**
   * Makes a node the way a create call does: live, and on top of the open
   * page (typings: "By default, the new node is parented under
   * figma.currentPage").
   */
  const create = (node: FakeNode): FakeNode => {
    makeLive(node);
    record.created.push(node);
    (fake.currentPage as unknown as FakeNode).appendChild!(node);
    return node;
  };
  const newId = (): string => `900:${nextId++}`;

  fake.createFrame = () => create(frame(newId(), "Frame", { fills: [solid(1, 1, 1)] }));
  fake.createRectangle = () =>
    create(rectangle(newId(), "Rectangle", { fills: [solid(0.85, 0.85, 0.85)] }));
  fake.createEllipse = () => {
    const node = rectangle(newId(), "Ellipse", { fills: [solid(0.85, 0.85, 0.85)] });
    node.type = "ELLIPSE";
    for (const field of [
      "cornerRadius",
      "topLeftRadius",
      "topRightRadius",
      "bottomRightRadius",
      "bottomLeftRadius",
      "cornerSmoothing",
    ]) {
      delete node[field];
    }
    return create(node);
  };
  fake.createLine = () => {
    const node = rectangle(newId(), "Line", { height: 0, fills: [], strokes: [solid(0, 0, 0)] });
    node.type = "LINE";
    for (const field of [
      "cornerRadius",
      "topLeftRadius",
      "topRightRadius",
      "bottomRightRadius",
      "bottomLeftRadius",
      "cornerSmoothing",
    ]) {
      delete node[field];
    }
    return create(node);
  };
  fake.createText = () => {
    // A new text holds no characters in Inter Regular 12, and hugs it.
    const node = text(newId(), "Text", [], { width: 0, height: 15, fills: [solid(0, 0, 0)] });
    return create(node);
  };

  // typings: createImage takes a PNG, JPEG, or GIF of at most 4096 pixels per
  // side, and throws on any other. The two messages are the ones the Figma
  // docs name: "Image type is unsupported" and "Image is too large".
  const makeImage = (hash: string, size: { width: number; height: number }) => ({
    hash,
    getSizeAsync: async () => size,
    getBytesAsync: async () => record.images.get(hash),
  });
  fake.createImage = (bytes: Uint8Array) => {
    const size = imageSize(bytes);
    if (!size) throw new Error("Image type is unsupported");
    if (size.width > 4096 || size.height > 4096) throw new Error("Image is too large");
    const hash = createHash("sha1").update(bytes).digest("hex");
    record.images.set(hash, bytes);
    return makeImage(hash, size);
  };
  // typings: getImageByHash returns null when no image has the hash.
  fake.getImageByHash = (hash: string) => {
    const bytes = record.images.get(hash);
    return bytes ? makeImage(hash, imageSize(bytes)!) : null;
  };
  fake.base64Decode = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

  // typings: createNodeFromSvg makes a frame, as the SVG import of the editor
  // does. Figma throws on markup its import cannot read; the fake throws on
  // anything that is not one closed <svg> element, and reads the size from
  // its width and height attributes.
  fake.createNodeFromSvg = (svg: string) => {
    const open = /^\s*<svg\b([^>]*)>/i.exec(svg);
    if (!open || !/<\/svg>\s*$/i.test(svg)) throw new Error("Failed to parse SVG");
    const attribute = (name: string) => {
      const match = new RegExp(`\\b${name}="([0-9.]+)`).exec(open[1]);
      return match ? Number(match[1]) : 100;
    };
    const width = attribute("width");
    const height = attribute("height");
    const vector = rectangle(newId(), "Vector", { width, height, fills: [solid(0, 0, 0)] });
    vector.type = "VECTOR";
    const node = frame(newId(), "svg", { width, height, fills: [], children: [vector] });
    vector.parent = node;
    makeLive(vector);
    return create(node);
  };

  fake.listAvailableFontsAsync = async () => fonts.map((font) => ({ fontName: { ...font } }));
  fake.loadFontAsync = async (font: FakeFont) => {
    if (!fonts.some((known) => fontKey(known) === fontKey(font))) {
      throw new Error(`The font "${font.family} ${font.style}" could not be loaded`);
    }
    record.loadedFonts.add(fontKey(font));
  };
  return record;
};
