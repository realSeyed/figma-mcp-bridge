import { dumpChildrenOf, dumpNodeSelf } from "../dump";
import type { DumpedNode, DumpOptions } from "../dump";
import type { SerializableNode } from "../serializer";
import { pageOf } from "../shared";
import { describeValue, readOptionalBoolean, readRequiredString } from "./batch";
import type { ExtensionHandler, ExtensionRequest } from "./types";

/**
 * Dump commands.
 *
 * `dump_nodes_chunk` is internal: the server sends it to build one dump of a
 * subtree, and no MCP tool has this name. One dump takes as many chunks as the
 * subtree needs, so each plugin request ends well inside the request timeout
 * of the bridge.
 *
 * The walk is pre-order: a node, then its children in order. A chunk starts at
 * the cursor, the child-index path from the root to the next node, and it
 * stops after `maxNodes` records, after `CHUNK_TIME_LIMIT_MS`, or at the end
 * of the subtree. A record holds nothing that depends on the chunk, so the
 * records of a dump are the same wherever its chunk boundaries fall.
 *
 * The serialization runs on the main thread of Figma, and the editor freezes
 * while a chunk runs.
 */

const TOOL = "dump_nodes_chunk";

/** The longest a chunk walks before it hands back what it has. */
export const CHUNK_TIME_LIMIT_MS = 15_000;

/** One node of a dump. */
export type DumpRecord = {
  /** 0 for the root. */
  depth: number;
  /** The children the walk gives for this node, as the cursor counts them. */
  childCount: number;
  /** The dump form of the node, without `children`. */
  node: DumpedNode;
};

export type DumpChunk = {
  rootId: string;
  records: DumpRecord[];
  /** The child-index path of the next node, or null when the walk is complete. */
  nextCursor: number[] | null;
};

/**
 * A node whose children the walk is going through.
 *
 * `next` is the index of the next child to emit, and `path` the child-index
 * path of the node itself.
 */
type Frame = {
  children: readonly SceneNode[];
  next: number;
  path: number[];
};

/**
 * Reads the cursor: null at the start, else a path of child indexes.
 * @param params - The request params.
 * @returns The path; empty for the root.
 */
const readCursor = (params: Record<string, unknown>): number[] => {
  const raw = params.cursor;
  if (raw === undefined || raw === null) return [];
  if (
    !Array.isArray(raw) ||
    !raw.every((index) => typeof index === "number" && Number.isInteger(index) && index >= 0)
  ) {
    throw new Error(
      `${TOOL} requires cursor as null or an array of child indexes (integers of 0 or more), received ${describeValue(raw)}. Pass null to start, or the nextCursor of the last chunk.`
    );
  }
  return raw as number[];
};

/**
 * Reads the most records one chunk may return.
 * @param params - The request params.
 * @returns An integer of 1 or more.
 */
const readMaxNodes = (params: Record<string, unknown>): number => {
  const raw = params.maxNodes;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(
      `${TOOL} requires maxNodes as an integer of 1 or more, received ${typeof raw === "number" ? raw : describeValue(raw)}. Pass the most records one chunk may return.`
    );
  }
  return raw;
};

/**
 * Reads whether the walk keeps the hidden content.
 * @param params - The request params.
 * @returns The value.
 */
const readIncludeHidden = (params: Record<string, unknown>): boolean => {
  const value = readOptionalBoolean(params, "includeHidden", TOOL);
  if (value === undefined) {
    throw new Error(
      `${TOOL} requires includeHidden as true or false. Pass true for audit evidence.`
    );
  }
  return value;
};

/**
 * Finds the root of the dump, and loads the page it is on.
 *
 * Under `documentAccess: "dynamic-page"` the children of a page can be read
 * only after the page is loaded, and a node on a page that is not loaded can
 * be missing from `getNodeByIdAsync` until it is.
 * @param rootId - The node ID.
 * @returns The root.
 */
const findRoot = async (rootId: string): Promise<SerializableNode> => {
  if (rootId === figma.root.id) {
    throw new Error(
      `${TOOL} cannot dump the document ${rootId}: rootId must name a page or a node on a page. Call get_metadata to list the page IDs, and dump each page.`
    );
  }

  const page = figma.root.children.find((candidate) => candidate.id === rootId);
  if (page) {
    await page.loadAsync();
    return page;
  }

  let node = await figma.getNodeByIdAsync(rootId);
  if (!node) {
    for (const candidate of figma.root.children) {
      if (candidate.id === figma.currentPage.id) continue;
      await candidate.loadAsync();
      node = await figma.getNodeByIdAsync(rootId);
      if (node) break;
    }
  }
  if (!node) {
    throw new Error(
      `${TOOL} found no node with the ID ${rootId} for rootId. Call get_metadata to list the page IDs, or get_document to list the node IDs of the current page.`
    );
  }
  if (node.type === "DOCUMENT") {
    throw new Error(
      `${TOOL} cannot dump the document ${rootId}: rootId must name a page or a node on a page. Call get_metadata to list the page IDs, and dump each page.`
    );
  }
  const holder = pageOf(node);
  if (holder) await holder.loadAsync();
  return node;
};

/**
 * Goes down from the root along the cursor, and stacks the nodes it passes.
 *
 * The stack is the one the walk had when it stopped before that node: the top
 * frame points at the node the cursor names, so the walk emits it next, and
 * each frame below it points past the child that the walk is inside, which
 * the earlier chunks emitted.
 * @param root - The root of the dump.
 * @param cursor - The child-index path of the next node, not empty.
 * @param options - The dump options.
 * @returns The stack.
 */
const resumeAt = (root: SerializableNode, cursor: number[], options: DumpOptions): Frame[] => {
  const stack: Frame[] = [];
  let node: SerializableNode = root;
  let path: number[] = [];
  cursor.forEach((index, level) => {
    const children = dumpChildrenOf(node, options);
    if (index >= children.length) {
      throw new Error(
        `${TOOL}: the tree changed during the dump. cursor[${level}] is ${index}, but ${node.id} "${node.name}" now has ${children.length} ${options.includeHidden ? "children" : "visible children"}. Dump the root again from the start.`
      );
    }
    const last = level === cursor.length - 1;
    stack.push({ children, next: last ? index : index + 1, path });
    path = [...path, index];
    node = children[index];
  });
  return stack;
};

/**
 * Names the next node of the walk, and drops each frame that is done.
 * @param stack - The stack of the walk.
 * @returns The child-index path of the next node, or null at the end.
 */
const nextCursorOf = (stack: Frame[]): number[] | null => {
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.next < top.children.length) return [...top.path, top.next];
    stack.pop();
  }
  return null;
};

/**
 * Walks one chunk of the subtree.
 * @param root - The root of the dump.
 * @param cursor - The child-index path of the first node; empty for the root.
 * @param maxNodes - The most records to return.
 * @param options - The dump options.
 * @param startedAt - When the chunk started, as `Date.now()` gives it.
 * @returns The records and the cursor of the next chunk.
 */
const walkChunk = async (
  root: SerializableNode,
  cursor: number[],
  maxNodes: number,
  options: DumpOptions,
  startedAt: number
): Promise<{ records: DumpRecord[]; nextCursor: number[] | null }> => {
  const records: DumpRecord[] = [];
  const stack = cursor.length === 0 ? [] : resumeAt(root, cursor, options);

  const emit = async (node: SerializableNode, path: number[]): Promise<void> => {
    const children = dumpChildrenOf(node, options);
    records.push({
      depth: path.length,
      childCount: children.length,
      node: await dumpNodeSelf(node, options),
    });
    stack.push({ children, next: 0, path });
  };

  if (cursor.length === 0) await emit(root, []);

  // The time limit applies only once the chunk holds a record, so each chunk
  // returns one record at least and a dump always moves on.
  const inTime = (): boolean => Date.now() - startedAt < CHUNK_TIME_LIMIT_MS;
  while (records.length < maxNodes && (records.length === 0 || inTime())) {
    const top = stack[stack.length - 1];
    if (!top) break;
    if (top.next >= top.children.length) {
      stack.pop();
      continue;
    }
    const index = top.next;
    top.next += 1;
    await emit(top.children[index], [...top.path, index]);
  }

  return { records, nextCursor: nextCursorOf(stack) };
};

/**
 * Returns one chunk of the dump of a subtree.
 *
 * Figma sets `skipInvisibleInstanceChildren` in Dev Mode, and the invisible
 * children of instances then disappear from the tree. So each chunk turns it
 * off for its own run and sets back the value it found, whatever that was and
 * whether the walk ends or fails.
 * @param req - The extension request.
 * @returns The records, and the cursor of the next chunk.
 */
const dumpNodesChunk = async (req: ExtensionRequest): Promise<DumpChunk> => {
  const rootId = readRequiredString(req.params, "rootId", TOOL);
  const cursor = readCursor(req.params);
  const maxNodes = readMaxNodes(req.params);
  const options: DumpOptions = { includeHidden: readIncludeHidden(req.params) };

  const startedAt = Date.now();
  const saved = figma.skipInvisibleInstanceChildren;
  figma.skipInvisibleInstanceChildren = false;
  try {
    const root = await findRoot(rootId);
    const { records, nextCursor } = await walkChunk(root, cursor, maxNodes, options, startedAt);
    return { rootId, records, nextCursor };
  } finally {
    figma.skipInvisibleInstanceChildren = saved;
  }
};

export const dumpsHandlers = {
  dump_nodes_chunk: { edit: false, run: dumpNodesChunk },
} satisfies Record<string, ExtensionHandler>;
