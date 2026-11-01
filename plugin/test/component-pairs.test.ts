/**
 * The pairs form of `variantProperties` and `properties`: the server sends an
 * array of `{ name, value }` with string values, and the old object form keeps
 * working. A BOOLEAN property takes `"true"` and `"false"` as well as the
 * booleans. Synthetic component nodes on the fake `figma`.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { pluginMain, resetFakeFigma } from "./helpers/plugin-globals";
import { installFakeFile } from "./helpers/fake-figma";
import { page } from "./helpers/nodes";
import type { FakeNode } from "./helpers/nodes";

let counter = 0;
const call = (type: string, params: Record<string, unknown> = {}, nodeIds?: string[]) =>
  pluginMain.handleRequest({
    type: type as never,
    requestId: `p${++counter}`,
    params,
    nodeIds,
  });

/** Each instance a variant created, by the variant ID. */
let created: Record<string, number>;
/** The arguments of each `setProperties` call on the instance. */
let setCalls: Record<string, unknown>[];

/** A variant of the set `2:1` that counts the instances it makes. */
const variant = (id: string, size: string, state: string): FakeNode => {
  const node: FakeNode = {
    id,
    name: `Size=${size}, State=${state}`,
    type: "COMPONENT",
    variantProperties: { Size: size, State: state },
  };
  node.createInstance = () => {
    created[id] = (created[id] ?? 0) + 1;
    const instance: FakeNode = {
      id: `9:${counter}`,
      name: node.name,
      type: "INSTANCE",
      x: 0,
      y: 0,
    };
    instance.getMainComponentAsync = async () => node;
    return instance;
  };
  return node;
};

/** An instance (`3:1`) with a BOOLEAN, a TEXT and a VARIANT property, and no main component. */
const placedInstance = (): FakeNode => {
  const node: FakeNode = {
    id: "3:1",
    name: "Card",
    type: "INSTANCE",
    children: [],
    componentProperties: {
      "Show icon#1:0": { type: "BOOLEAN", value: true },
      "Label#1:1": { type: "TEXT", value: "Old" },
      Size: { type: "VARIANT", value: "Small", variantOptions: ["Small", "Large"] },
    },
  };
  node.getMainComponentAsync = async () => null;
  node.findAll = () => [];
  node.setProperties = (updates: Record<string, unknown>) => {
    setCalls.push(updates);
    const properties = node.componentProperties as Record<string, { value: unknown }>;
    for (const [name, value] of Object.entries(updates)) properties[name].value = value;
  };
  return node;
};

beforeEach(() => {
  resetFakeFigma();
  created = {};
  setCalls = [];
  installFakeFile({
    pages: [
      page("1:1", "Components", {
        children: [
          {
            id: "2:1",
            name: "Button",
            type: "COMPONENT_SET",
            children: [
              variant("2:2", "Small", "Default"),
              variant("2:3", "Large", "Default"),
              variant("2:4", "Large", "Hover"),
            ],
          },
          placedInstance(),
        ],
      }),
    ],
  });
});

describe("create_instance variantProperties", () => {
  test("takes an array of name and value pairs", async () => {
    const response = await call("create_instance", {
      componentId: "2:1",
      variantProperties: [
        { name: "Size", value: "Large" },
        { name: "State", value: "Hover" },
      ],
    });
    expect(response.error).toBeUndefined();
    expect((response.data as { mainComponentId: string }).mainComponentId).toBe("2:4");
    expect(created).toEqual({ "2:4": 1 });
  });

  test("still takes an object of name to value", async () => {
    const response = await call("create_instance", {
      componentId: "2:1",
      variantProperties: { Size: "Large", State: "Default" },
    });
    expect(response.error).toBeUndefined();
    expect(created).toEqual({ "2:3": 1 });
  });

  test("names a bad pair by its index", async () => {
    const response = await call("create_instance", {
      componentId: "2:1",
      variantProperties: [
        { name: "Size", value: "Large" },
        { name: "State", value: "" },
      ],
    });
    expect(response.error).toContain("variantProperties[1]");
    expect(created).toEqual({});
  });

  test("refuses a property named twice", async () => {
    const response = await call("create_instance", {
      componentId: "2:1",
      variantProperties: [
        { name: "Size", value: "Large" },
        { name: "Size", value: "Small" },
      ],
    });
    expect(response.error).toContain("twice");
    expect(created).toEqual({});
  });
});

describe("set_instance_properties properties", () => {
  test('takes pairs with string values, "false" for a BOOLEAN', async () => {
    const response = await call(
      "set_instance_properties",
      {
        properties: [
          { name: "Show icon", value: "false" },
          { name: "Label", value: "Buy" },
          { name: "Size", value: "Large" },
        ],
      },
      ["3:1"]
    );
    expect(response.error).toBeUndefined();
    expect(setCalls).toEqual([{ "Show icon#1:0": false, "Label#1:1": "Buy", Size: "Large" }]);
    expect(response.data).toEqual({
      id: "3:1",
      properties: {
        "Show icon#1:0": { type: "BOOLEAN", value: false },
        "Label#1:1": { type: "TEXT", value: "Buy" },
        Size: { type: "VARIANT", value: "Large" },
      },
    });
  });

  test("still takes an object with a boolean", async () => {
    const response = await call(
      "set_instance_properties",
      { properties: { "Show icon": false, Label: "Go" } },
      ["3:1"]
    );
    expect(response.error).toBeUndefined();
    expect(setCalls).toEqual([{ "Show icon#1:0": false, "Label#1:1": "Go" }]);
  });

  test("names each bad pair by its index and writes nothing", async () => {
    const response = await call(
      "set_instance_properties",
      {
        properties: [
          { name: "Show icon", value: "maybe" },
          { name: "Colour", value: "Red" },
        ],
      },
      ["3:1"]
    );
    expect(response.error).toContain("properties[0]");
    expect(response.error).toContain("properties[1]");
    expect(setCalls).toEqual([]);
  });
});
