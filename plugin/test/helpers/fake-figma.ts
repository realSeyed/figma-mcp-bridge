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

import { fakeFigma, resetFakeFigma } from "./plugin-globals";
import type { FakeFigma } from "./plugin-globals";
import { linkParents } from "./nodes";
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
};

export type InstalledFile = {
  figma: FakeFigma;
  /** Each export call, in order. */
  exports: ExportCall[];
  /** How many times each page was loaded, by page ID, and the document by "*". */
  loads: Map<string, number>;
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
  const all = [root, ...descendants(root)];
  const byId = (id: string) => all.find((node) => node.id === id) ?? null;
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
  return { figma: fakeFigma, exports, loads };
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
