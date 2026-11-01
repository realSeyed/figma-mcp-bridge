/**
 * The guidance texts of `guide.ts`: each tool name they put in backticks is a
 * tool of the set the text goes to, each stays inside its length limit, and a
 * real process gives the instructions and the `design_session` prompt to its
 * client by role.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  AUDITOR_INSTRUCTIONS,
  DESIGN_SESSION_PROMPT,
  MAX_AUDITOR_INSTRUCTIONS_CHARS,
  MAX_DESIGN_SESSION_PROMPT_CHARS,
  MAX_SERVER_INSTRUCTIONS_CHARS,
  SERVER_INSTRUCTIONS,
} from "../src/guide.js";
import { AUDITOR_TOOLS } from "../src/role.js";
import { toolsetAllows } from "../src/toolset.js";
import { Harness } from "./helpers/harness.js";
import { listRegisteredTools } from "./helpers/schema-lint.js";

const TOOL_NAME = /^[a-z]+(_[a-z]+)+$/;

/**
 * Each backticked identifier of a text that has the shape of a tool name.
 * @param text - The guidance text.
 */
function toolNamesIn(text: string): string[] {
  const names = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  return [...new Set(names.filter((name) => TOOL_NAME.test(name)))];
}

let fullTools = new Set<string>();
let designTools = new Set<string>();
let auditorTools = new Set<string>();

beforeAll(async () => {
  const names = async (allows?: (name: string) => boolean) =>
    new Set((await listRegisteredTools(allows)).tools.map((tool) => tool.name));
  fullTools = await names();
  designTools = await names(toolsetAllows("design"));
  auditorTools = await names((name) => AUDITOR_TOOLS.includes(name));
});

describe("tool names in the texts", () => {
  test("each text names tools", () => {
    expect(toolNamesIn(SERVER_INSTRUCTIONS).length).toBeGreaterThan(10);
    expect(toolNamesIn(AUDITOR_INSTRUCTIONS).length).toBeGreaterThan(5);
    expect(toolNamesIn(DESIGN_SESSION_PROMPT).length).toBeGreaterThan(10);
  });

  test("the server instructions name tools of the full and the design sets only", () => {
    const names = toolNamesIn(SERVER_INSTRUCTIONS);
    expect(names.filter((name) => !fullTools.has(name))).toEqual([]);
    expect(names.filter((name) => !designTools.has(name))).toEqual([]);
  });

  test("the auditor instructions name tools of the auditor role only", () => {
    expect(toolNamesIn(AUDITOR_INSTRUCTIONS).filter((name) => !auditorTools.has(name))).toEqual([]);
  });

  test("the design_session prompt names tools of the design set only", () => {
    expect(toolNamesIn(DESIGN_SESSION_PROMPT).filter((name) => !designTools.has(name))).toEqual([]);
  });
});

describe("length limits", () => {
  test(`the server instructions are at most ${MAX_SERVER_INSTRUCTIONS_CHARS} characters`, () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_SERVER_INSTRUCTIONS_CHARS);
  });

  test(`the auditor instructions are at most ${MAX_AUDITOR_INSTRUCTIONS_CHARS} characters`, () => {
    expect(AUDITOR_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_AUDITOR_INSTRUCTIONS_CHARS);
  });

  test(`the design_session prompt is at most ${MAX_DESIGN_SESSION_PROMPT_CHARS} characters`, () => {
    expect(DESIGN_SESSION_PROMPT.length).toBeLessThanOrEqual(MAX_DESIGN_SESSION_PROMPT_CHARS);
  });
});

describe("what a client gets", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const start = async (env: Record<string, string>) =>
    h.server({ port: await h.freePort(), cwd: await h.tempDir("cwd"), env });

  test("a full process lists design_session and sends the server instructions", async () => {
    const server = await start({});
    expect(await server.listPrompts()).toEqual(["design_session"]);
    expect(server.instructions()).toBe(SERVER_INSTRUCTIONS);
  }, 30_000);

  test("a design process lists design_session and sends the server instructions", async () => {
    const server = await start({ FIGMA_BRIDGE_TOOLSET: "design" });
    expect(await server.listPrompts()).toEqual(["design_session"]);
    expect(server.instructions()).toBe(SERVER_INSTRUCTIONS);
  }, 30_000);

  test("an auditor process lists no prompt and sends the auditor instructions", async () => {
    const server = await start({ FIGMA_BRIDGE_ROLE: "auditor" });
    expect(await server.listPrompts()).toEqual([]);
    expect(server.instructions()).toBe(AUDITOR_INSTRUCTIONS);
  }, 30_000);
});
