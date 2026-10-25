/**
 * `clear_paints`: the paint list of a node set to an empty list, the record of
 * the old list, and the check of every item before the first write. A small
 * fake on `globalThis.figma` stands in for the Plugin API.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { paintsHandlers } from "../src/main/extensions/paints";
import {
  MIXED,
  alias,
  frame,
  instance,
  linearGradient,
  linkParents,
  page,
  rectangle,
  solid,
  text,
} from "./helpers/nodes";
import type { FakeNode } from "./helpers/nodes";

type Result = Record<string, unknown> & { index: number; ok: boolean };

/**
 * Installs the fake API over a tree.
 * @param pages - The pages of the document; the first one is the current page.
 * @returns The pages that `loadAsync` was called on.
 */
const installFigma = (pages: FakeNode[]): string[] => {
  const loaded: string[] = [];
  const root: FakeNode = { id: "0:0", name: "Document", type: "DOCUMENT", children: pages };
  const byId = new Map<string, FakeNode>();
  const index = (node: FakeNode): void => {
    byId.set(node.id, node);
    for (const child of node.children ?? []) index(child);
  };
  for (const pageNode of pages) {
    pageNode.loadAsync = async () => {
      loaded.push(pageNode.id);
    };
    index(pageNode);
  }
  (globalThis as unknown as { figma: unknown }).figma = {
    root,
    currentPage: pages[0],
    getNodeByIdAsync: async (id: string) => (id === root.id ? root : (byId.get(id) ?? null)),
  };
  return loaded;
};

afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const clear = (nodeIds: string[], target?: string): Promise<{ results: Result[] }> =>
  paintsHandlers.clear_paints.run({
    nodeIds,
    params: target === undefined ? {} : { target },
  }) as Promise<{ results: Result[] }>;

const clearError = async (nodeIds: string[], target?: string): Promise<string> => {
  try {
    await clear(nodeIds, target);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("clear_paints did not throw.");
};

/** One page with the given children, linked as Figma links them. */
const onePage = (...children: FakeNode[]): FakeNode =>
  linkParents(page("1:0", "Test page", { children }));

/**
 * A copy of the fields of one node, so two states compare field by field. The
 * parent and the children are left out: each child is a node of its own.
 */
const snapshot = (node: FakeNode): string =>
  JSON.stringify(node, (key, value) =>
    key === "parent" || key === "children" ? undefined : value
  );

/** Makes `fills` of a node throw on write, as a refusal of Figma does. */
const refuseWrites = (node: FakeNode, message: string): void => {
  const paints = node.fills;
  Object.defineProperty(node, "fills", {
    enumerable: true,
    get: () => paints,
    set: () => {
      throw new Error(message);
    },
  });
};

describe("clear_paints", () => {
  test("empties the fills of a frame with one solid fill and records the paint", async () => {
    const card = frame("2:1", "Card", { fills: [solid(1, 0, 0)] });
    installFigma([onePage(card)]);

    const { results } = await clear(["2:1"]);

    expect(card.fills).toEqual([]);
    expect(results).toEqual([
      {
        index: 0,
        ok: true,
        nodeId: "2:1",
        nodeName: "Card",
        target: "fills",
        previous: [{ type: "SOLID", color: "#ff0000" }],
        previousCount: 1,
        previousStyleId: null,
        applied: true,
      },
    ]);
  });

  test("records the variable a fill was bound to, and the binding goes with the paint", async () => {
    const card = frame("2:1", "Card", {
      fills: [solid(0, 0, 1, { boundVariables: { color: alias("VariableID:9:1") } })],
    });
    installFigma([onePage(card)]);

    const { results } = await clear(["2:1"]);

    expect(results[0].previous).toEqual([
      { type: "SOLID", color: "#0000ff", boundVariables: { color: "VariableID:9:1" } },
    ]);
    expect(card.fills).toEqual([]);
  });

  test("records a hidden paint with visible: false, and counts both paints", async () => {
    const card = frame("2:1", "Card", {
      fills: [solid(1, 0, 0, { visible: false }), solid(0, 1, 0, { opacity: 0.5 })],
    });
    installFigma([onePage(card)]);

    const { results } = await clear(["2:1"]);

    expect(results[0].previous).toEqual([
      { type: "SOLID", color: "#ff0000", visible: false },
      { type: "SOLID", color: "#00ff00", opacity: 0.5 },
    ]);
    expect(results[0].previousCount).toBe(2);
    expect(card.fills).toEqual([]);
  });

  test("records the fills of each range of a text node whose fills are mixed", async () => {
    const label = text(
      "2:1",
      "Label",
      [
        { start: 0, end: 5, characters: "Hello", fills: [solid(0, 0, 0)] },
        {
          start: 5,
          end: 11,
          characters: " world",
          fills: [solid(1, 0, 0), linearGradient({ visible: false })],
        },
      ],
      { fills: MIXED }
    );
    installFigma([onePage(label)]);

    const { results } = await clear(["2:1"]);

    expect(results[0].previous).toBe("mixed");
    expect(results[0].previousSegments).toEqual([
      { start: 0, end: 5, fills: [{ type: "SOLID", color: "#000000" }] },
      {
        start: 5,
        end: 11,
        fills: [
          { type: "SOLID", color: "#ff0000" },
          expect.objectContaining({ type: "GRADIENT_LINEAR", visible: false }),
        ],
      },
    ]);
    expect(results[0].previousCount).toBe(3);
    expect(label.fills).toEqual([]);
  });

  test("with target strokes, changes the strokes and leaves the fills", async () => {
    const card = frame("2:1", "Card", {
      fills: [solid(1, 1, 1)],
      strokes: [solid(0, 0, 0)],
      strokeStyleId: "S:line,",
    });
    installFigma([onePage(card)]);

    const { results } = await clear(["2:1"], "strokes");

    expect(card.strokes).toEqual([]);
    expect(card.fills).toEqual([solid(1, 1, 1)]);
    expect(results[0]).toMatchObject({
      target: "strokes",
      previous: [{ type: "SOLID", color: "#000000" }],
      previousCount: 1,
      previousStyleId: "S:line,",
    });
  });

  test("counts a paint type that the read form leaves out, and does not report it", async () => {
    const card = frame("2:1", "Card", {
      fills: [solid(1, 0, 0), { type: "VIDEO", visible: true, opacity: 1, blendMode: "NORMAL" }],
    });
    installFigma([onePage(card)]);

    const { results } = await clear(["2:1"]);

    expect(results[0].previousCount).toBe(2);
    expect(results[0].previous).toEqual([{ type: "SOLID", color: "#ff0000" }]);
    expect(card.fills).toEqual([]);
  });

  test("names the paint style of the list in previousStyleId", async () => {
    const card = frame("2:1", "Card", { fills: [solid(1, 0, 0)], fillStyleId: "S:brand," });
    installFigma([onePage(card)]);

    const { results } = await clear(["2:1"]);

    expect(results[0].previousStyleId).toBe("S:brand,");
    expect(card.fills).toEqual([]);
  });

  test("reports mixed for a style that differs per range", async () => {
    const label = text(
      "2:1",
      "Label",
      [
        { start: 0, end: 1, characters: "A", fills: [solid(0, 0, 0)] },
        { start: 1, end: 2, characters: "B", fills: [solid(1, 1, 1)] },
      ],
      { fills: MIXED, fillStyleId: MIXED }
    );
    installFigma([onePage(label)]);

    const { results } = await clear(["2:1"]);

    expect(results[0].previousStyleId).toBe("mixed");
  });

  test("defaults the target to fills", async () => {
    const card = frame("2:1", "Card", { fills: [solid(1, 0, 0)], strokes: [solid(0, 0, 0)] });
    installFigma([onePage(card)]);

    const { results } = await clear(["2:1"]);

    expect(results[0].target).toBe("fills");
    expect(card.strokes).toEqual([solid(0, 0, 0)]);
  });

  test("refuses another target", async () => {
    installFigma([onePage(frame("2:1", "Card"))]);

    const message = await clearError(["2:1"], "backgrounds");

    expect(message).toContain("clear_paints requires target");
    expect(message).toContain('"backgrounds"');
    expect(message).toContain('"strokes"');
  });

  test("writes nothing for a batch with a group, an unknown ID, and a page, and names each", async () => {
    const group = { id: "2:1", name: "Wrapper", type: "GROUP", children: [] };
    const card = frame("2:4", "Card", { fills: [solid(1, 0, 0)] });
    installFigma([onePage(group, card)]);
    const before = snapshot(card);

    const message = await clearError(["2:1", "2:99", "1:0", "2:4"]);

    expect(message).toContain("clear_paints wrote nothing");
    expect(message).toContain('nodeIds[0]: 2:1 "Wrapper" is a GROUP node and carries no fills');
    expect(message).toContain("nodeIds[1]: node not found: 2:99");
    expect(message).toContain('nodeIds[2]: 1:0 "Test page" is a page');
    expect(message).not.toContain("nodeIds[3]");
    expect(snapshot(card)).toBe(before);
  });

  test("refuses the document, a repeated ID, and an item that is not an ID", async () => {
    const card = frame("2:1", "Card", { fills: [solid(1, 0, 0)] });
    installFigma([onePage(card)]);

    const message = await clearError(["0:0", "2:1", "2:1"]);
    expect(message).toContain("nodeIds[0]: 0:0 is the document");
    expect(message).toContain("nodeIds[2]: 2:1 repeats nodeIds[1]");

    const bad = await paintsHandlers.clear_paints
      .run({ nodeIds: [42] as unknown as string[], params: {} })
      .catch((err: Error) => err.message);
    expect(bad).toContain("nodeIds[0]: each item must be a node ID");
    expect(card.fills).toEqual([solid(1, 0, 0)]);
  });

  test("refuses an empty list and a list over 200 IDs", async () => {
    installFigma([onePage()]);

    expect(await clearError([])).toContain("1 to 200");
    expect(await clearError(Array.from({ length: 201 }, (_, i) => `2:${i}`))).toContain(
      "at most 200"
    );
  });

  test("stops at the first refused write: ok, failed, not written", async () => {
    const first = frame("2:1", "First", { fills: [solid(1, 0, 0)] });
    const second = frame("2:2", "Second", { fills: [solid(0, 1, 0)] });
    const third = frame("2:3", "Third", { fills: [solid(0, 0, 1)] });
    refuseWrites(second, "Cannot write fills");
    installFigma([onePage(first, second, third)]);

    const { results } = await clear(["2:1", "2:2", "2:3"]);

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ index: 0, ok: true, nodeId: "2:1" });
    expect(results[1]).toEqual({ index: 1, ok: false, error: "Cannot write fills." });
    expect(results[2]).toEqual({ index: 2, ok: false, error: "not written" });
    expect(first.fills).toEqual([]);
    expect(third.fills).toEqual([solid(0, 0, 1)]);
  });

  test("names the plan limit when Figma refuses because of one", async () => {
    const card = frame("2:1", "Card", { fills: [solid(1, 0, 0)] });
    refuseWrites(card, "This feature needs a paid plan upgrade");
    installFigma([onePage(card)]);

    const { results } = await clear(["2:1"]);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("plan limit");
  });

  test("writes to the sublayer of an instance and does not detach it", async () => {
    const label = rectangle("I3:1;3:2", "Slot", { fills: [solid(1, 0, 0)] });
    let detached = 0;
    const button = instance("3:1", "Button", null, {
      fills: [solid(0, 0, 1)],
      children: [label],
      detachInstance: () => {
        detached += 1;
      },
    });
    installFigma([onePage(button)]);

    const { results } = await clear(["I3:1;3:2"]);

    expect(results[0]).toMatchObject({ ok: true, nodeId: "I3:1;3:2", applied: true });
    expect(label.fills).toEqual([]);
    expect(button.fills).toEqual([solid(0, 0, 1)]);
    expect(button.type).toBe("INSTANCE");
    expect(detached).toBe(0);
  });

  test("loads the page of a node that is missing until its page loads", async () => {
    const far = frame("5:1", "Far", { fills: [solid(1, 0, 0)] });
    const other = linkParents(page("4:0", "Other page", { children: [far] }));
    const loaded = installFigma([onePage(), other]);
    const fake = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
    const resolve = fake.getNodeByIdAsync as (id: string) => Promise<FakeNode | null>;
    // Under dynamic-page access a node of an unloaded page is not found.
    fake.getNodeByIdAsync = async (id: string) =>
      id === "5:1" && !loaded.includes("4:0") ? null : resolve(id);

    const { results } = await clear(["5:1"]);

    expect(results[0].ok).toBe(true);
    expect(far.fills).toEqual([]);
    expect(loaded).toEqual(["4:0"]);
  });

  test("changes no field of any node but the target", async () => {
    const label = text(
      "2:3",
      "Label",
      [{ start: 0, end: 2, characters: "Hi", fills: [solid(0, 0, 0)] }],
      { fills: [solid(0, 0, 0)], fillStyleId: "S:ink," }
    );
    const card = frame("2:1", "Card", {
      fills: [solid(1, 0, 0), linearGradient()],
      strokes: [solid(0, 0, 0)],
      fillStyleId: "S:brand,",
      cornerRadius: 8,
      layoutMode: "VERTICAL",
      itemSpacing: 4,
      children: [rectangle("2:2", "Inner", { fills: [solid(0, 1, 0)] }), label],
    });
    installFigma([onePage(card)]);
    const nodes = [card, ...(card.children ?? [])];
    const before = nodes.map(snapshot);

    await clear(["2:1", "2:3"]);

    const withoutTarget = (node: FakeNode): Record<string, unknown> => {
      const copy = JSON.parse(snapshot(node)) as Record<string, unknown>;
      delete copy.fills;
      return copy;
    };
    nodes.forEach((node, i) => {
      const expected = JSON.parse(before[i]) as Record<string, unknown>;
      delete expected.fills;
      expect(withoutTarget(node)).toEqual(expected);
    });
    expect(card.fills).toEqual([]);
    expect(label.fills).toEqual([]);
    // The node that was not named keeps its fills.
    expect((card.children ?? [])[0].fills).toEqual([solid(0, 1, 0)]);
  });
});
