/**
 * The chunk walk of `dump_nodes_chunk`: records that do not depend on where
 * the chunk boundaries fall, the cursor, and the skipInvisibleInstanceChildren
 * rule. A small fake on `globalThis.figma` stands in for the Plugin API.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CHUNK_TIME_LIMIT_MS, dumpsHandlers } from "../src/main/extensions/dumps";
import type { DumpChunk, DumpRecord } from "../src/main/extensions/dumps";
import {
  component,
  frame,
  instance,
  linkParents,
  page,
  rectangle,
  section,
  solid,
  text,
} from "./helpers/nodes";
import type { FakeNode } from "./helpers/nodes";

type FakeFigma = {
  skipInvisibleInstanceChildren: boolean;
  root: FakeNode;
  currentPage: FakeNode;
  getNodeByIdAsync: (id: string) => Promise<FakeNode | null>;
  /** The flag as each instance read found it, in the order of the reads. */
  flagReads: boolean[];
  /** The pages that `loadAsync` was called on. */
  loaded: string[];
};

const fakeFigma = (): FakeFigma => (globalThis as unknown as { figma: FakeFigma }).figma;

/**
 * Makes an instance that behaves as Figma does: with the flag on, its hidden
 * children are not in `children`. Each read records the flag it found.
 */
const flaggedInstance = (id: string, name: string, kids: FakeNode[]): FakeNode => {
  const node = instance(id, name, null, {
    getMainComponentAsync: async () => {
      fakeFigma().flagReads.push(fakeFigma().skipInvisibleInstanceChildren);
      return main;
    },
  });
  Object.defineProperty(node, "children", {
    enumerable: true,
    get: () =>
      fakeFigma()?.skipInvisibleInstanceChildren ? kids.filter((kid) => kid.visible) : kids,
  });
  for (const kid of kids) kid.parent = node;
  return node;
};

const main = component("8:900", "Main");

/** About 50 nodes on two levels of frames, with hidden ones at each level. */
const buildTree = (): FakeNode => {
  let next = 1;
  const id = () => `8:${next++}`;
  const branch = (n: number): FakeNode =>
    frame(id(), `Branch ${n}`, {
      children: [
        rectangle(id(), `Leaf ${n}.1`),
        rectangle(id(), `Leaf ${n}.2`, { visible: n % 2 === 0 }),
        frame(id(), `Group ${n}`, {
          visible: n !== 3,
          children: [
            rectangle(id(), `Leaf ${n}.3`),
            rectangle(id(), `Leaf ${n}.4`, { visible: false }),
            text(id(), `Label ${n}`, [
              { start: 0, end: 5, characters: "Label", fills: [solid(0, 0, 0)] },
            ]),
          ],
        }),
        flaggedInstance(id(), `Instance ${n}`, [
          rectangle(id(), `Slot ${n}.1`),
          rectangle(id(), `Slot ${n}.2`, { visible: false }),
        ]),
      ],
    });
  return linkParents(
    page("8:0", "Chunk page", {
      children: [
        branch(1),
        branch(2),
        branch(3),
        branch(4),
        frame(id(), "Hidden branch", {
          visible: false,
          children: [rectangle(id(), "Under hidden 1"), rectangle(id(), "Under hidden 2")],
        }),
        section(id(), "Section", {
          children: [frame(id(), "In section 1"), frame(id(), "In section 2", { visible: false })],
        }),
      ],
    })
  );
};

/**
 * Installs the fake API over a tree.
 * @param pages - The pages of the document; the first one is the current page.
 */
const installFigma = (pages: FakeNode[]): FakeFigma => {
  const byId = new Map<string, FakeNode>();
  const index = (node: FakeNode): void => {
    byId.set(node.id, node);
    for (const child of node.children ?? []) index(child);
  };
  const root: FakeNode = { id: "0:0", name: "Document", type: "DOCUMENT", children: pages };
  const fake: FakeFigma = {
    skipInvisibleInstanceChildren: true,
    root,
    currentPage: pages[0],
    getNodeByIdAsync: async (id) => {
      if (id === root.id) return root;
      // Read the tree again: a test can change it between two chunks.
      byId.clear();
      for (const pageNode of pages) index(pageNode);
      return byId.get(id) ?? null;
    },
    flagReads: [],
    loaded: [],
  };
  for (const pageNode of pages) {
    pageNode.loadAsync = async () => {
      fake.loaded.push(pageNode.id);
    };
  }
  (globalThis as unknown as { figma: FakeFigma }).figma = fake;
  return fake;
};

const runChunk = (params: Record<string, unknown>): Promise<DumpChunk> =>
  dumpsHandlers.dump_nodes_chunk.run({ params }) as Promise<DumpChunk>;

/**
 * Dumps a root chunk by chunk, as the server does.
 * @returns Each chunk, in order.
 */
const dumpAll = async (
  rootId: string,
  maxNodes: number,
  includeHidden: boolean
): Promise<DumpChunk[]> => {
  const chunks: DumpChunk[] = [];
  let cursor: number[] | null = null;
  do {
    const chunk = await runChunk({ rootId, cursor, maxNodes, includeHidden });
    chunks.push(chunk);
    cursor = chunk.nextCursor;
    if (chunks.length > 1_000) throw new Error("The walk does not end.");
  } while (cursor !== null);
  return chunks;
};

const joined = (chunks: DumpChunk[]): DumpRecord[] => chunks.flatMap((chunk) => chunk.records);

/**
 * The pre-order of a fake tree, computed apart from the walk.
 * @returns One entry per node: its ID, depth, and walked child count.
 */
const expectedOrder = (
  root: FakeNode,
  includeHidden: boolean
): { id: string; depth: number; childCount: number }[] => {
  const saved = fakeFigma().skipInvisibleInstanceChildren;
  fakeFigma().skipInvisibleInstanceChildren = false;
  const out: { id: string; depth: number; childCount: number }[] = [];
  const visit = (node: FakeNode, depth: number): void => {
    const kids = (node.children ?? []).filter((kid) => includeHidden || kid.visible !== false);
    out.push({ id: node.id, depth, childCount: kids.length });
    for (const kid of kids) visit(kid, depth + 1);
  };
  visit(root, 0);
  fakeFigma().skipInvisibleInstanceChildren = saved;
  return out;
};

let tree: FakeNode;
let realNow: () => number;

beforeEach(() => {
  tree = buildTree();
  installFigma([tree, page("9:0", "Other page")]);
  realNow = Date.now;
});

afterEach(() => {
  Date.now = realNow;
  delete (globalThis as { figma?: unknown }).figma;
});

describe("the chunk walk", () => {
  test("the tree holds about 50 nodes, hidden ones included", () => {
    const all = expectedOrder(tree, true).length;
    const visible = expectedOrder(tree, false).length;
    expect(all).toBeGreaterThanOrEqual(45);
    expect(all).toBeLessThanOrEqual(60);
    expect(visible).toBeLessThan(all);
  });

  for (const includeHidden of [true, false]) {
    describe(`with includeHidden ${includeHidden}`, () => {
      test("the joined records are equal for maxNodes 1, 3, 7, and 1000", async () => {
        const texts: string[] = [];
        for (const maxNodes of [1, 3, 7, 1_000]) {
          const chunks = await dumpAll("8:0", maxNodes, includeHidden);
          for (const chunk of chunks) {
            expect(chunk.rootId).toBe("8:0");
            expect(chunk.records.length).toBeGreaterThan(0);
            expect(chunk.records.length).toBeLessThanOrEqual(maxNodes);
          }
          texts.push(JSON.stringify(joined(chunks)));
        }
        expect(new Set(texts).size).toBe(1);
      });

      test("the records are the pre-order, with the depth and the walked child count", async () => {
        const records = joined(await dumpAll("8:0", 7, includeHidden));
        expect(
          records.map((record) => ({
            id: record.node.id,
            depth: record.depth,
            childCount: record.childCount,
          }))
        ).toEqual(expectedOrder(tree, includeHidden));
        for (const record of records) expect("children" in record.node).toBe(false);
      });

      test("a chunk cut by the time limit gives the same records", async () => {
        const whole = JSON.stringify(joined(await dumpAll("8:0", 1_000, includeHidden)));
        let clock = 0;
        Date.now = () => (clock += CHUNK_TIME_LIMIT_MS + 1);
        const chunks = await dumpAll("8:0", 1_000, includeHidden);
        Date.now = realNow;
        expect(chunks.every((chunk) => chunk.records.length === 1)).toBe(true);
        expect(JSON.stringify(joined(chunks))).toBe(whole);
      });
    });
  }

  test("with includeHidden, each hidden node is in the dump; without it, none", async () => {
    const withHidden = joined(await dumpAll("8:0", 1_000, true)).map((record) => record.node);
    const visibleOnly = joined(await dumpAll("8:0", 1_000, false)).map((record) => record.node);
    expect(withHidden.some((node) => node.styles?.visible === false)).toBe(true);
    expect(visibleOnly.some((node) => node.styles?.visible === false)).toBe(false);
    expect(withHidden.map((node) => node.name)).toContain("Slot 1.2");
    expect(visibleOnly.map((node) => node.name)).not.toContain("Slot 1.2");
  });

  test("the cursor names the child-index path of the next node", async () => {
    const first = await runChunk({ rootId: "8:0", cursor: null, maxNodes: 3, includeHidden: true });
    // The page, Branch 1, Leaf 1.1: the next node is Leaf 1.2.
    expect(first.records.map((record) => record.node.name)).toEqual([
      "Chunk page",
      "Branch 1",
      "Leaf 1.1",
    ]);
    expect(first.nextCursor).toEqual([0, 1]);
    const second = await runChunk({
      rootId: "8:0",
      cursor: first.nextCursor,
      maxNodes: 1,
      includeHidden: true,
    });
    expect(second.records.map((record) => record.node.name)).toEqual(["Leaf 1.2"]);
    expect(second.records[0].depth).toBe(2);
  });

  test("a subtree root starts at depth 0 and ends with its own subtree", async () => {
    const records = joined(await dumpAll("8:4", 2, true));
    expect(records.map((record) => [record.node.name, record.depth])).toEqual([
      ["Group 1", 0],
      ["Leaf 1.3", 1],
      ["Leaf 1.4", 1],
      ["Label 1", 1],
    ]);
  });

  test("a page root is loaded first", async () => {
    await runChunk({ rootId: "9:0", cursor: null, maxNodes: 5, includeHidden: true });
    expect(fakeFigma().loaded).toContain("9:0");
  });

  test("a node root has its page loaded", async () => {
    await runChunk({ rootId: "8:4", cursor: null, maxNodes: 5, includeHidden: true });
    expect(fakeFigma().loaded).toContain("8:0");
  });
});

describe("the errors of the walk", () => {
  test("a cursor that names a child that is gone fails: the tree changed", async () => {
    const first = await runChunk({ rootId: "8:0", cursor: null, maxNodes: 4, includeHidden: true });
    expect(first.nextCursor).toEqual([0, 2]);
    // Branch 1 loses its last two children between two chunks.
    const branch = (tree.children ?? [])[0];
    branch.children = (branch.children ?? []).slice(0, 2);
    await expect(
      runChunk({ rootId: "8:0", cursor: first.nextCursor, maxNodes: 4, includeHidden: true })
    ).rejects.toThrow(
      /dump_nodes_chunk: the tree changed during the dump\. cursor\[1\] is 2, but 8:1 "Branch 1" now has 2 children\. Dump the root again from the start\./
    );
  });

  test("a cursor that goes below a leaf fails the same way", async () => {
    await expect(
      runChunk({ rootId: "8:0", cursor: [0, 0, 0], maxNodes: 4, includeHidden: true })
    ).rejects.toThrow(/the tree changed during the dump/);
  });

  test("a root that does not exist names the ID and the correction", async () => {
    await expect(
      runChunk({ rootId: "404:1", cursor: null, maxNodes: 4, includeHidden: true })
    ).rejects.toThrow(/found no node with the ID 404:1 for rootId\. Call get_metadata/);
  });

  test("the document is refused", async () => {
    await expect(
      runChunk({ rootId: "0:0", cursor: null, maxNodes: 4, includeHidden: true })
    ).rejects.toThrow(/cannot dump the document 0:0: rootId must name a page or a node on a page/);
  });

  test("each bad param is refused with its field", async () => {
    const base = { rootId: "8:0", cursor: null, maxNodes: 4, includeHidden: true };
    await expect(runChunk({ ...base, rootId: "" })).rejects.toThrow(/requires rootId/);
    await expect(runChunk({ ...base, cursor: [0, -1] })).rejects.toThrow(/requires cursor/);
    await expect(runChunk({ ...base, cursor: "0" })).rejects.toThrow(/requires cursor/);
    await expect(runChunk({ ...base, maxNodes: 0 })).rejects.toThrow(/requires maxNodes/);
    await expect(runChunk({ ...base, maxNodes: 2.5 })).rejects.toThrow(/requires maxNodes/);
    const { includeHidden: _omitted, ...withoutFlag } = base;
    await expect(runChunk(withoutFlag)).rejects.toThrow(/requires includeHidden/);
  });
});

describe("skipInvisibleInstanceChildren", () => {
  test("is false during the walk and true again after it", async () => {
    expect(fakeFigma().skipInvisibleInstanceChildren).toBe(true);
    const records = joined(await dumpAll("8:0", 5, true));
    expect(fakeFigma().flagReads.length).toBeGreaterThan(0);
    expect(fakeFigma().flagReads.every((flag) => flag === false)).toBe(true);
    expect(fakeFigma().skipInvisibleInstanceChildren).toBe(true);
    // The hidden child of an instance is there although the flag was on.
    expect(records.map((record) => record.node.name)).toContain("Slot 2.2");
  });

  test("is set back after an error in the walk", async () => {
    const branch = (tree.children ?? [])[0];
    const broken = flaggedInstance("8:950", "Broken", []);
    broken.getMainComponentAsync = async () => {
      fakeFigma().flagReads.push(fakeFigma().skipInvisibleInstanceChildren);
      throw new Error("main component unavailable");
    };
    branch.children = [...(branch.children ?? []), broken];
    await expect(
      runChunk({ rootId: "8:0", cursor: null, maxNodes: 1_000, includeHidden: true })
    ).rejects.toThrow(/main component unavailable/);
    expect(fakeFigma().flagReads.at(-1)).toBe(false);
    expect(fakeFigma().skipInvisibleInstanceChildren).toBe(true);
  });

  test("is set back after a stale cursor and after a missing root", async () => {
    await expect(
      runChunk({ rootId: "8:0", cursor: [99], maxNodes: 1, includeHidden: true })
    ).rejects.toThrow(/the tree changed/);
    expect(fakeFigma().skipInvisibleInstanceChildren).toBe(true);
    await expect(
      runChunk({ rootId: "404:1", cursor: null, maxNodes: 1, includeHidden: true })
    ).rejects.toThrow(/found no node/);
    expect(fakeFigma().skipInvisibleInstanceChildren).toBe(true);
  });

  test("keeps a value of false that it found", async () => {
    fakeFigma().skipInvisibleInstanceChildren = false;
    await dumpAll("8:0", 5, true);
    expect(fakeFigma().skipInvisibleInstanceChildren).toBe(false);
  });
});
