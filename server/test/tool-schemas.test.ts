/**
 * Portable schemas: the advertised input schema of each tool follows rules
 * that a strict schema reader (Gemini CLI, Moonshot) accepts. Lists the tools
 * of a real `McpServer` over an in-memory transport, so the test sees the
 * JSON Schema that a client gets, not the Zod source.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../src/node.js";
import { registerTools } from "../src/tools.js";

/**
 * The paths where an open object is allowed, each with its reason. A path is
 * `<tool>.<property>`, with `[]` for the items of an array.
 */
const OPEN_OBJECT_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ["apply_animation_style.animationStyleData", "beta motion record, passed to Figma as it is"],
  ["apply_manual_keyframe_track.field", "beta motion record, passed to Figma as it is"],
  ["apply_manual_keyframe_track.track", "beta motion record, passed to Figma as it is"],
  ["remove_manual_keyframe_track.field", "beta motion record, passed to Figma as it is"],
  ["batch.ops[].args", "the args of any tool; argsJson is the portable alternative"],
]);

/** The most characters of the whole `tools/list` result. */
const MAX_TOOLS_LIST_CHARS = 150_000;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;

type Schema = Record<string, unknown>;

interface ListedTool {
  name: string;
  inputSchema: Schema;
}

let tools: ListedTool[] = [];
let listText = "";

beforeAll(async () => {
  const server = new McpServer({ name: "schema-test", version: "0.0.0" });
  // Registration stores the node for the handlers and calls nothing on it.
  registerTools(server, {} as Node, 0);
  const client = new Client({ name: "schema-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.listTools();
  tools = result.tools as unknown as ListedTool[];
  listText = JSON.stringify(result);
  await client.close();
  await server.close();
});

/**
 * Each sub-schema of a schema, with its path.
 * @param schema - The schema to walk.
 * @param path - The path of the schema.
 */
function* walk(schema: unknown, path: string): Generator<[string, Schema]> {
  if (schema === null || typeof schema !== "object") return;
  const node = schema as Schema;
  yield [path, node];
  const properties = node.properties as Record<string, unknown> | undefined;
  if (properties !== undefined) {
    for (const [key, value] of Object.entries(properties)) yield* walk(value, `${path}.${key}`);
  }
  if (node.items !== undefined) yield* walk(node.items, `${path}[]`);
  if (typeof node.additionalProperties === "object") {
    yield* walk(node.additionalProperties, `${path}{}`);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const list = node[key];
    if (Array.isArray(list)) for (const item of list) yield* walk(item, path);
  }
  if (node.not !== undefined) yield* walk(node.not, path);
}

/**
 * The violations of the portability rules in one tool.
 * @param tool - The listed tool.
 */
function violations(tool: ListedTool): string[] {
  const found: string[] = [];
  const text = JSON.stringify(tool.inputSchema);
  for (const key of ["$ref", "$defs", "definitions"]) {
    if (text.includes(`"${key}"`)) found.push(`${tool.name}: has ${key}`);
  }
  if (!TOOL_NAME.test(tool.name)) found.push(`${tool.name}: name does not match ${TOOL_NAME}`);

  for (const [path, node] of walk(tool.inputSchema, tool.name)) {
    const allowed = OPEN_OBJECT_ALLOWLIST.has(path);
    const additional = node.additionalProperties;
    if (additional !== undefined && additional !== false && !allowed) {
      found.push(`${path}: additionalProperties is ${JSON.stringify(additional)}`);
    }
    const type = node.type;
    if (Array.isArray(type) && !(type.length === 2 && type[1] === "null")) {
      found.push(`${path}: type array ${JSON.stringify(type)}`);
    }
    if (type === "object" && path !== tool.name && !allowed) {
      const properties = node.properties as Record<string, unknown> | undefined;
      if (properties === undefined || Object.keys(properties).length === 0) {
        found.push(`${path}: object without properties`);
      }
    }
    if (node.enum !== undefined) {
      const values = node.enum as unknown[];
      if (!values.every((value) => typeof value === "string" && value !== "")) {
        found.push(`${path}: enum ${JSON.stringify(values)} is not of non-empty strings`);
      }
    }
  }

  const properties = (tool.inputSchema.properties ?? {}) as Record<string, Schema>;
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value.description !== "string" || value.description === "") {
      found.push(`${tool.name}.${key}: no description`);
    }
  }
  return found;
}

describe("advertised tool schemas", () => {
  test("every tool follows the portability rules", () => {
    expect(tools.length).toBeGreaterThan(50);
    expect(tools.flatMap(violations)).toEqual([]);
  });

  test("each allowlisted path exists", () => {
    const paths = new Set(
      tools.flatMap((tool) => [...walk(tool.inputSchema, tool.name)].map(([p]) => p))
    );
    for (const path of OPEN_OBJECT_ALLOWLIST.keys()) expect(paths.has(path)).toBe(true);
  });

  test(`the tools/list result is at most ${MAX_TOOLS_LIST_CHARS} characters`, () => {
    expect(listText.length).toBeLessThanOrEqual(MAX_TOOLS_LIST_CHARS);
  });
});
