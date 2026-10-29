/**
 * `handleRequest` of `code.ts`: the undo commit after each edit request, and
 * the tool name in the error of a core tool. A small fake on
 * `globalThis.figma` stands in for the Plugin API.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { pluginMain, resetFakeFigma } from "./helpers/plugin-globals";

beforeEach(() => {
  resetFakeFigma();
});

describe("the undo history", () => {
  test("is committed once after each edit request, also a failed one, and never after a read", async () => {
    const fake = resetFakeFigma();
    const node = { id: "1:1", type: "FRAME", name: "box", visible: true };
    fake.getNodeByIdAsync = async (id: string) => (id === node.id ? node : null);

    const edit = await pluginMain.handleRequest({
      type: "set_node_visibility",
      requestId: "edit",
      params: { items: [{ nodeId: "1:1", visible: false }] },
    });
    expect(edit.error).toBeUndefined();
    expect(node.visible).toBe(false);
    expect(fake.undoCommits).toBe(1);

    const failed = await pluginMain.handleRequest({
      type: "set_node_visibility",
      requestId: "failed-edit",
      params: { items: [] },
    });
    expect(failed.error).toContain("items is required");
    expect(fake.undoCommits).toBe(2);

    const extension = await pluginMain.handleRequest({
      type: "e2e_fixture",
      requestId: "extension-edit",
      params: { op: "getSkipInvisibleInstanceChildren" },
    });
    expect(extension.error).toBeUndefined();
    expect(fake.undoCommits).toBe(3);

    const read = await pluginMain.handleRequest({
      type: "get_node",
      requestId: "read",
      nodeIds: ["9:9"],
    });
    expect(read.error).toContain("Node not found: 9:9");
    expect(fake.undoCommits).toBe(3);
  });

  test("a host that cannot commit does not stop the answer", async () => {
    const fake = resetFakeFigma();
    fake.commitUndo = () => {
      throw new Error("no undo history here");
    };
    const node = { id: "1:1", type: "FRAME", name: "box", visible: false };
    fake.getNodeByIdAsync = async () => node;

    const edit = await pluginMain.handleRequest({
      type: "set_node_visibility",
      requestId: "edit",
      params: { items: [{ nodeId: "1:1", visible: true }] },
    });

    expect(edit).toEqual({
      type: "set_node_visibility",
      requestId: "edit",
      data: { results: [{ nodeId: "1:1", previousVisible: false, visible: true }] },
    });
  });
});

describe("the error of a core tool", () => {
  test("names the tool one time, as the error of an extension does", async () => {
    resetFakeFigma().getNodeByIdAsync = async () => null;

    const missing = await pluginMain.handleRequest({
      type: "get_node",
      requestId: "missing",
      nodeIds: ["9:9"],
    });
    expect(missing.error).toBe("get_node: Node not found: 9:9");

    const named = await pluginMain.handleRequest({
      type: "set_node_visibility",
      requestId: "named",
      params: { items: [] },
    });
    expect(named.error).toBe("items is required for set_node_visibility");

    const extension = await pluginMain.handleRequest({
      type: "e2e_fixture",
      requestId: "extension",
      params: { op: "no_such_op" },
    });
    expect(extension.error).toStartWith("e2e_fixture: requires op as one of");
    expect(extension.error!.split("e2e_fixture").length).toBe(2);
  });
});
