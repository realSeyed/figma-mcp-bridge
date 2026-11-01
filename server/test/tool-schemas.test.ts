/**
 * Portable schemas: the advertised input schema of each tool follows rules
 * that a strict schema reader (Gemini CLI, Moonshot) accepts. Lists the tools
 * of a real `McpServer` over an in-memory transport, so the test sees the
 * JSON Schema that a client gets, not the Zod source.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  listRegisteredTools,
  OPEN_OBJECT_ALLOWLIST,
  violations,
  walk,
  type ListedTool,
} from "./helpers/schema-lint.js";

/** The most characters of the whole `tools/list` result. */
const MAX_TOOLS_LIST_CHARS = 150_000;

let tools: ListedTool[] = [];
let listText = "";

beforeAll(async () => {
  ({ tools, text: listText } = await listRegisteredTools());
});

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
