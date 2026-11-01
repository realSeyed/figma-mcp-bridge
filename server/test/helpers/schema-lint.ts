/**
 * The portable-schema lint (CLAUDE.md convention 23) and an in-memory server
 * to list the tools of one tool set. Shared by `tool-schemas.test.ts` and
 * `toolset.test.ts`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../../src/node.js";
import { restrictServer } from "../../src/role.js";
import { registerTools } from "../../src/tools.js";

/**
 * The paths where an open object is allowed, each with its reason. A path is
 * `<tool>.<property>`, with `[]` for the items of an array.
 */
export const OPEN_OBJECT_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ["apply_animation_style.animationStyleData", "beta motion record, passed to Figma as it is"],
  ["apply_manual_keyframe_track.field", "beta motion record, passed to Figma as it is"],
  ["apply_manual_keyframe_track.track", "beta motion record, passed to Figma as it is"],
  ["remove_manual_keyframe_track.field", "beta motion record, passed to Figma as it is"],
  ["batch.ops[].args", "the args of any tool; argsJson is the portable alternative"],
]);

const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;

export type Schema = Record<string, unknown>;

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: Schema;
  annotations?: Record<string, unknown>;
}

/**
 * The `tools/list` result of a real `McpServer` over an in-memory transport,
 * so a test sees the JSON Schema that a client gets, not the Zod source.
 * @param allows - Registers only the tools it accepts, as a role or a tool set does. Default: every tool.
 * @returns The listed tools and the JSON text of the whole result.
 */
export async function listRegisteredTools(
  allows?: (name: string) => boolean
): Promise<{ tools: ListedTool[]; text: string }> {
  const server = new McpServer({ name: "schema-test", version: "0.0.0" });
  // Registration stores the node for the handlers and calls nothing on it.
  registerTools(allows ? restrictServer(server, allows).server : server, {} as Node, 0);
  const client = new Client({ name: "schema-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.listTools();
  await client.close();
  await server.close();
  return { tools: result.tools as unknown as ListedTool[], text: JSON.stringify(result) };
}

/**
 * Each sub-schema of a schema, with its path.
 * @param schema - The schema to walk.
 * @param path - The path of the schema.
 */
export function* walk(schema: unknown, path: string): Generator<[string, Schema]> {
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
export function violations(tool: ListedTool): string[] {
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
