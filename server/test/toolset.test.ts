/**
 * The tool set (`FIGMA_BRIDGE_TOOLSET`) and the MCP annotations of each tool.
 * The lists come from a real `McpServer` over an in-memory transport; the
 * start checks run real server processes.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { AUDITOR_TOOLS } from "../src/role.js";
import { DESIGN_EXCLUDED_TOOLS, toolsetAllows } from "../src/toolset.js";
import { Harness } from "./helpers/harness.js";
import { listRegisteredTools, violations, type ListedTool } from "./helpers/schema-lint.js";
import { SERVER_ENTRY, serverEnv } from "./helpers/server-process.js";

/** The most characters of the `tools/list` result of the design set. */
const MAX_DESIGN_LIST_CHARS = 120_000;

let full: ListedTool[] = [];
let design: ListedTool[] = [];
let designText = "";

beforeAll(async () => {
  full = (await listRegisteredTools()).tools;
  ({ tools: design, text: designText } = await listRegisteredTools(toolsetAllows("design")));
});

const byName = (tools: ListedTool[], name: string): ListedTool => {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`${name} is not listed`);
  return tool;
};

describe("annotations", () => {
  test("a read is readOnlyHint", () => {
    for (const name of ["get_node", "find_nodes", "get_screenshot", "list_files"]) {
      expect(byName(full, name).annotations).toEqual({ readOnlyHint: true });
    }
  });

  test("a read that writes a file or moves the viewport is not readOnlyHint", () => {
    for (const name of ["dump_nodes", "save_screenshots", "dump_journal"]) {
      expect(byName(full, name).annotations?.readOnlyHint).not.toBe(true);
    }
    expect(byName(full, "scroll_and_zoom_into_view").annotations).toBeUndefined();
  });

  test("a delete, detach_instance and clear_paints are destructiveHint", () => {
    for (const name of ["delete_nodes", "delete_variables", "detach_instance", "clear_paints"]) {
      expect(byName(full, name).annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    }
  });

  test("a write that adds or changes carries no hint", () => {
    for (const name of ["create_frame", "set_node_properties", "batch"]) {
      expect(byName(full, name).annotations).toBeUndefined();
    }
  });
});

describe("the design tool set", () => {
  test("drops each excluded tool and keeps every other one", () => {
    const names = design.map((tool) => tool.name);
    for (const name of DESIGN_EXCLUDED_TOOLS) expect(names).not.toContain(name);
    const expected = full
      .map((tool) => tool.name)
      .filter((name) => !DESIGN_EXCLUDED_TOOLS.has(name));
    expect(names.sort()).toEqual(expected.sort());
  });

  test("each excluded tool exists in the full set", () => {
    const names = new Set(full.map((tool) => tool.name));
    for (const name of DESIGN_EXCLUDED_TOOLS) expect(names.has(name)).toBe(true);
  });

  test("the batch enum lists only the tools of the set", () => {
    const ops = byName(design, "batch").inputSchema.properties as Record<string, any>;
    const listed: string[] = ops.ops.items.properties.tool.enum;
    expect(listed).toContain("create_frame");
    for (const name of DESIGN_EXCLUDED_TOOLS) expect(listed).not.toContain(name);
  });

  test(`its tools/list result is at most ${MAX_DESIGN_LIST_CHARS} characters`, () => {
    expect(designText.length).toBeLessThanOrEqual(MAX_DESIGN_LIST_CHARS);
  });

  test("every tool follows the portability rules", () => {
    expect(design.flatMap(violations)).toEqual([]);
  });
});

describe("FIGMA_BRIDGE_TOOLSET at start", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  /** Runs the server with the given changes until it exits, or 15 s. */
  const exitOf = async (env: Record<string, string>) => {
    const port = await h.freePort();
    const child = spawn("node", [SERVER_ENTRY], {
      cwd: await h.tempDir("cwd"),
      env: serverEnv({
        port,
        env: {
          FIGMA_BRIDGE_TOKEN_FILE: await h.tokenFile(),
          FIGMA_BRIDGE_JOURNAL_FILE: await h.journalFile(),
          FIGMA_BRIDGE_LOG_FILE: await h.logFile(),
          ...env,
        },
      }),
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill(), 15_000);
    const code = await new Promise<number | null>((done) => child.once("exit", done));
    clearTimeout(timer);
    return { code, stderr };
  };

  test("an invalid value stops the process with 1", async () => {
    const { code, stderr } = await exitOf({ FIGMA_BRIDGE_TOOLSET: "Design" });
    expect(code).toBe(1);
    expect(stderr).toContain('Invalid FIGMA_BRIDGE_TOOLSET "Design"');
  }, 30_000);

  test("a design process lists the design set", async () => {
    const port = await h.freePort();
    const server = await h.server({
      port,
      cwd: await h.tempDir("cwd"),
      env: { FIGMA_BRIDGE_TOOLSET: "design" },
    });
    const names = await server.listTools();
    expect(names.sort()).toEqual(design.map((tool) => tool.name).sort());
  }, 30_000);

  test("the auditor role ignores it, and says so in one line", async () => {
    const port = await h.freePort();
    const server = await h.server({
      port,
      cwd: await h.tempDir("cwd"),
      env: { FIGMA_BRIDGE_ROLE: "auditor", FIGMA_BRIDGE_TOOLSET: "design" },
    });
    expect((await server.listTools()).sort()).toEqual([...AUDITOR_TOOLS].sort());
    const lines = server.stderr.filter((line) => line.includes("FIGMA_BRIDGE_TOOLSET is ignored"));
    expect(lines.length).toBe(1);
  }, 30_000);
});
