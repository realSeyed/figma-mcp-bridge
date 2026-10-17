#!/usr/bin/env bun
/**
 * End-to-end test of this fork's variable, text style, component, section,
 * and dump tools against a live Figma file on a free (Starter) plan.
 *
 * Run it from `server/` with `bun run e2e`, with the Figma plugin connected.
 * The script starts its own `node dist/index.js`. That process joins the
 * running bridge as a follower, so every tool call travels the follower to
 * leader `/rpc` path and exercises the `rpcToArgs` mappers as well as the
 * tools themselves.
 *
 * Everything the run makes is named `mcp-e2e/...` and lives on the page
 * `MCP E2E`, and a `finally` block removes it again — after a failure as well.
 * The page itself stays: the tools cannot remove a page, so each run reuses it.
 *
 * Environment:
 *   FIGMA_FILE_KEY     required. The test file. The script refuses to start
 *                      unless it names a connected file, and lists the
 *                      connected files. It makes no write before that check.
 *   FIGMA_BRIDGE_PORT  passed to the spawned server, which gets the whole
 *                      environment of this script.
 *
 * The script sets FIGMA_BRIDGE_OUTPUT_ROOT of the spawned server to
 * `scripts/e2e-output/`, so each file that save_screenshots or dump_nodes
 * writes lands there. The dump group removes the one folder it made.
 *
 * Group K spawns a second server with FIGMA_BRIDGE_ROLE=auditor and its own
 * output root under `scripts/e2e-output/`, and removes both at the end.
 *
 * Group L checks the capture manifest of save_screenshots against the file on
 * disk, and removes the capture and its manifest file.
 *
 * Group V builds the dump-conformance fixture (BR-7), dumps it, and compares
 * the normalised dumps with the golden dump in `scripts/golden/`. Some parts
 * of the fixture need the test helper `e2e_fixture`, a plugin command that no
 * MCP tool and no role exposes; the script sends it with a raw `/rpc` request.
 * `E2E_UPDATE_GOLDEN=1` writes the golden dump in place of the compare. A
 * change of the golden dump is a change of the serializer: commit it alone,
 * and send it for review. V5 spawns a second server with
 * FIGMA_BRIDGE_DUMP_CHUNK_NODES=2 and its own output root, and removes both at
 * the end. The last line of the run is the result line of the group:
 * `CONFORMANCE PASS bridgeCommit=<commit> pluginBuild=<build>`, or
 * `CONFORMANCE FAIL ... failed=<count>`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  comparableForm,
  GOLDEN_ROOTS,
  goldenText,
  normaliseGolden,
  visibleDifferences,
  visibleProjection,
} from "./conformance.js";
import type { GoldenRoot } from "./conformance.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(SCRIPT_DIR, "..");
const SERVER_ENTRY = join(SERVER_ROOT, "dist", "index.js");
const OUTPUT_DIR = join(SCRIPT_DIR, "e2e-output");

/** The one page every run uses. The tools cannot remove a page, so it is reused. */
const PAGE_NAME = "MCP E2E";

/** Every object a run makes carries this prefix, so a leftover is recognisable. */
const PREFIX = "mcp-e2e/";

/** Long enough for `figma.loadAllPagesAsync` on a file with some history. */
const CALL_TIMEOUT_MS = 120_000;

/**
 * The fields Figma actually writes when a variable is bound to `cornerRadius`
 * or to `strokeWeight`. Neither field is bound itself, so `get_node` reports
 * the four below instead.
 */
const SPREAD_FIELDS = {
  cornerRadius: ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"],
  strokeWeight: ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"],
} as const;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type StepOutcome = { name: string; ok: boolean; cause?: string };

const outcomes: StepOutcome[] = [];

/**
 * Records one step and prints its line.
 * @param name - The step name.
 * @param ok - Whether the step passed.
 * @param cause - Why it failed.
 */
const record = (name: string, ok: boolean, cause?: string): void => {
  outcomes.push({ name, ok, cause });
  console.log(ok ? `PASS  ${name}` : `FAIL  ${name}\n      ${cause}`);
};

/** Thrown by the assertion helpers. Carries the cause a failed step prints. */
class AssertionError extends Error {}

/**
 * Fails the current step when the condition does not hold.
 * @param condition - What must be true.
 * @param cause - The cause and the correction.
 */
const check = (condition: boolean, cause: string): void => {
  if (!condition) throw new AssertionError(cause);
};

/**
 * Runs one step and records its outcome. It never throws: a failed step leaves
 * the run going so the report covers every step, not just the ones before the
 * first failure.
 * @param name - The step name.
 * @param run - The step body.
 * @returns Whether the step passed.
 */
const step = async (name: string, run: () => Promise<void>): Promise<boolean> => {
  try {
    await run();
    record(name, true);
    return true;
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
    return false;
  }
};

/**
 * Renders a value for an assertion message.
 * @param value - The value.
 * @returns Its JSON, truncated so one long node tree cannot bury the cause.
 */
const show = (value: unknown): string => {
  const json = JSON.stringify(value);
  if (json === undefined) return String(value);
  return json.length > 400 ? `${json.slice(0, 400)}…` : json;
};

// ---------------------------------------------------------------------------
// Typed readers, so a shape that is not what the test expects names itself
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/**
 * Reads a value as an object.
 * @param value - The value.
 * @param what - What it is, for the message.
 * @returns The object.
 */
const readRecord = (value: unknown, what: string): Json => {
  check(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${what} is ${show(value)}, expected an object`
  );
  return value as Json;
};

/**
 * Reads a value as an array.
 * @param value - The value.
 * @param what - What it is, for the message.
 * @returns The array.
 */
const readArray = (value: unknown, what: string): unknown[] => {
  check(Array.isArray(value), `${what} is ${show(value)}, expected an array`);
  return value as unknown[];
};

/**
 * Reads a value as an array of objects.
 * @param value - The value.
 * @param what - What it is, for the message.
 * @returns The objects.
 */
const readRecords = (value: unknown, what: string): Json[] =>
  readArray(value, what).map((entry, index) => readRecord(entry, `${what}[${index}]`));

/**
 * Reads a value as a non-empty string.
 * @param value - The value.
 * @param what - What it is, for the message.
 * @returns The string.
 */
const readString = (value: unknown, what: string): string => {
  check(
    typeof value === "string" && value !== "",
    `${what} is ${show(value)}, expected a non-empty string`
  );
  return value as string;
};

/**
 * Reads a value as a number.
 * @param value - The value.
 * @param what - What it is, for the message.
 * @returns The number.
 */
const readNumber = (value: unknown, what: string): number => {
  check(
    typeof value === "number" && Number.isFinite(value),
    `${what} is ${show(value)}, expected a number`
  );
  return value as number;
};

/** Figma stores a channel as a float, so a hex round trip lands within one step of 255. */
const near = (actual: number, expected: number, what: string): void =>
  check(Math.abs(actual - expected) <= 0.005, `${what} is ${actual}, expected about ${expected}`);

/**
 * Fails the step when two positions differ by more than a rounding step.
 *
 * Every tool that moves a node across a section boundary rewrites its
 * transform, so what is checked is that the node came back to the same place
 * on the canvas rather than to the same bit pattern.
 * @param actual - The position read back.
 * @param expected - Where it should be.
 * @param what - What the number is, for the message.
 */
const atPosition = (actual: number, expected: number, what: string): void =>
  check(Math.abs(actual - expected) <= 0.01, `${what} is ${actual}, expected about ${expected}`);

/**
 * Finds one item of a listing by its ID.
 * @param items - The listed items.
 * @param id - The ID to find.
 * @param what - What the listing is, for the message.
 * @returns The item.
 */
const itemById = (items: readonly Json[], id: string, what: string): Json => {
  const found = items.find((item) => item.id === id);
  check(found !== undefined, `${what} ${show(items.map((item) => item.id))} does not carry ${id}`);
  return found as Json;
};

/**
 * Reads the pixel size from the IHDR chunk of a PNG.
 * @param bytes - The PNG file.
 * @returns The width and the height.
 */
const readPngHeader = (bytes: Buffer): { width: number; height: number } => {
  check(
    bytes.byteLength >= 24 && bytes.subarray(12, 16).toString("ascii") === "IHDR",
    "the data is not a PNG: no IHDR chunk"
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

/**
 * Compares two lists as sets. Figma reorders `scopes` on read, so the order a
 * call sent them in is not the order it gets back.
 * @param actual - The list read back.
 * @param expected - The list that was written.
 * @param what - What the list is, for the message.
 */
const sameMembers = (
  actual: readonly string[],
  expected: readonly string[],
  what: string
): void => {
  const left = [...actual].sort().join(", ");
  const right = [...expected].sort().join(", ");
  check(left === right, `${what} is [${left}], expected [${right}]`);
};

// ---------------------------------------------------------------------------
// MCP plumbing
// ---------------------------------------------------------------------------

type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: string };

let client: Client;
let fileKey: string | undefined;

/**
 * Calls one tool and parses its result.
 * @param name - The tool name.
 * @param args - The tool arguments. `fileKey` is added automatically.
 * @returns The parsed data, or the error the tool reported.
 */
const callTool = async (name: string, args: Json = {}): Promise<ToolOutcome> => {
  const withKey = fileKey === undefined ? args : { fileKey, ...args };
  const result = await client.callTool({ name, arguments: withKey }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });

  const parts = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");

  if (result.isError === true) return { ok: false, error: text };
  if (text === "") return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: `${name} returned text that is not JSON: ${text}` };
  }
};

/** One content block of a tool result, as the MCP client gives it. */
type RawBlock = { type: string; text?: string; data?: string; mimeType?: string };

/**
 * Calls one tool and returns its content blocks as they are, image blocks too.
 * @param name - The tool name.
 * @param args - The tool arguments. `fileKey` is added automatically.
 * @returns The blocks, and whether the tool reported an error.
 */
const callRaw = async (
  name: string,
  args: Json = {}
): Promise<{ isError: boolean; content: RawBlock[] }> => {
  const withKey = fileKey === undefined ? args : { fileKey, ...args };
  const result = await client.callTool({ name, arguments: withKey }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });
  return { isError: result.isError === true, content: (result.content ?? []) as RawBlock[] };
};

/**
 * Calls a tool that must succeed.
 * @param name - The tool name.
 * @param args - The tool arguments.
 * @returns The parsed data.
 */
const ok = async (name: string, args: Json = {}): Promise<unknown> => {
  const result = await callTool(name, args);
  check(result.ok, `${name} failed: ${result.ok ? "" : result.error}`);
  return (result as { ok: true; data: unknown }).data;
};

/**
 * Calls a tool that must succeed and reads its result as an object.
 * @param name - The tool name.
 * @param args - The tool arguments.
 * @returns The result object.
 */
const okRecord = async (name: string, args: Json = {}): Promise<Json> =>
  readRecord(await ok(name, args), `${name} result`);

/**
 * Calls a tool that must fail, and checks the message names the cause.
 * @param name - The tool name.
 * @param args - The tool arguments.
 * @param expected - Fragments the error must carry.
 */
const rejects = async (name: string, args: Json, expected: readonly string[]): Promise<void> => {
  const result = await callTool(name, args);
  check(
    !result.ok,
    `${name} was expected to fail, but returned ${show((result as { data: unknown }).data)}`
  );
  const error = (result as { ok: false; error: string }).error;
  const missing = expected.filter((needle) => !error.includes(needle));
  check(
    missing.length === 0,
    `${name} failed as expected, but the message does not name ${missing.map((m) => JSON.stringify(m)).join(" or ")}: ${error}`
  );
};

/**
 * Reads the `results` of a batch tool and checks every item was written.
 * @param data - The tool result.
 * @param tool - The tool name, for the message.
 * @param expectedCount - How many items the call carried.
 * @returns The result entries.
 */
const allWritten = (data: unknown, tool: string, expectedCount: number): Json[] => {
  const results = readRecords(readRecord(data, `${tool} result`).results, `${tool} results`);
  check(
    results.length === expectedCount,
    `${tool} returned ${results.length} results, expected ${expectedCount}`
  );
  const failed = results.filter((entry) => entry.ok !== true);
  check(failed.length === 0, `${tool} did not write ${failed.length} item(s): ${show(failed)}`);
  return results;
};

// ---------------------------------------------------------------------------
// The IDs one run threads through its steps
// ---------------------------------------------------------------------------

type Context = {
  pageId: string;
  rootId: string;
  collectionId: string;
  defaultModeId: string;
  /** Variable name to ID, filled by the create_variables step. */
  variables: Record<string, string>;
  styleId: string;
  smallComponentId: string;
  largeComponentId: string;
  smallLabelId: string;
  largeLabelId: string;
  setId: string;
  iconId: string;
  /** Component property display name to the full name Figma stored. */
  properties: Record<string, string>;
  instanceId: string;
  detachedFrameId: string;
  boundFrameId: string;
  boundTextId: string;
  styledTextId: string;
  emptySectionId: string;
  wrapSectionId: string;
  boxAId: string;
  boxBId: string;
  movedId: string;
  nestedSectionId: string;
  nestedBoxId: string;
  sectionComponentId: string;
  innerSectionId: string;
};

const ctx: Partial<Context> = {};

/**
 * Reads a value an earlier step produced.
 * @param key - The context key.
 * @returns The value.
 */
const need = <K extends keyof Context>(key: K): Context[K] => {
  const value = ctx[key];
  check(
    value !== undefined,
    `this step needs ${key} from an earlier step, which did not produce it`
  );
  return value as Context[K];
};

/**
 * Reads one variable ID by name.
 * @param name - The variable name.
 * @returns The variable ID.
 */
const variableId = (name: string): string => {
  const id = need("variables")[name];
  check(id !== undefined, `the variable "${name}" was not created by an earlier step`);
  return id;
};

/**
 * Reads one component property's full name by the display name it was added under.
 * @param displayName - The display name.
 * @returns The full name Figma stored.
 */
const propertyName = (displayName: string): string => {
  const name = need("properties")[displayName];
  check(name !== undefined, `the property "${displayName}" was not added by an earlier step`);
  return name;
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Resolves the file to test against. `FIGMA_FILE_KEY` must name a connected
 * file: with one connected file the script would otherwise write to whatever
 * file that is.
 * @returns Null when the key is good, else the refusal to print.
 */
const resolveFileKey = async (): Promise<string | null> => {
  const listed = await callTool("list_files");
  if (!listed.ok) {
    throw new Error(
      `list_files failed: ${listed.error}. Open the plugin "Figma MCP Bridge (Fork)" in the test file and run the script again.`
    );
  }
  const files = readRecords(readRecord(listed.data, "list_files result").files, "list_files files");
  const fromEnv = process.env.FIGMA_FILE_KEY?.trim();
  const match = files.find((file) => file.fileKey === fromEnv);
  if (fromEnv && match) {
    fileKey = fromEnv;
    console.log(`file: ${fileKey} (${String(match.fileName)})`);
    return null;
  }

  const cause = fromEnv
    ? `FIGMA_FILE_KEY is "${fromEnv}", but no connected file has that key.`
    : "FIGMA_FILE_KEY is not set. The script writes to the file it names, so it does not pick one.";
  const listing =
    files.length === 0
      ? "No Figma file is connected. Run the plugin in the test file first."
      : `Connected files:\n${files.map((file) => `  ${String(file.fileKey)}  ${String(file.fileName)}`).join("\n")}`;
  return [
    cause,
    listing,
    "Set FIGMA_FILE_KEY to the key of the test file and run the script again:",
    "  bash:        FIGMA_FILE_KEY='<key>' bun run e2e",
    "  PowerShell:  $env:FIGMA_FILE_KEY = '<key>'; bun run e2e",
  ].join("\n");
};

/**
 * Finds the `MCP E2E` page, creating it when it is not there.
 *
 * It has to be the page open in Figma: `list_components` with the default
 * scope reads the open page, and no tool switches pages on a page that already
 * exists.
 */
const resolvePage = async (): Promise<void> => {
  const metadata = await okRecord("get_metadata");
  const pages = readRecords(metadata.pages, "get_metadata.pages");
  const existing = pages.find((page) => page.name === PAGE_NAME);

  if (!existing) {
    const created = await okRecord("create_page", { name: PAGE_NAME, setAsCurrent: true });
    ctx.pageId = readString(created.pageId, "create_page.pageId");
    console.log(`page: ${PAGE_NAME} ${ctx.pageId} (created)`);
    return;
  }

  ctx.pageId = readString(existing.id, "get_metadata.pages[].id");
  if (metadata.currentPageId !== ctx.pageId) {
    throw new Error(
      `The page "${PAGE_NAME}" exists but is not the page open in Figma, which is "${String(metadata.currentPageName)}". ` +
        `Open "${PAGE_NAME}" in Figma and run the script again: list_components reads the open page, and no tool switches to an existing one.`
    );
  }
  console.log(`page: ${PAGE_NAME} ${ctx.pageId}`);
};

/**
 * Removes everything a run makes: the `mcp-e2e/` nodes of the test page, the
 * `mcp-e2e/` text styles, and the `mcp-e2e/` variable collections.
 *
 * Runs before the scenario as well, so a run that was killed part-way does not
 * leave the next one tripping over its nodes.
 * @returns One line per object that could not be removed.
 */
const removeArtifacts = async (): Promise<string[]> => {
  const problems: string[] = [];

  const document = await callTool("get_document");
  if (!document.ok) {
    problems.push(`get_document failed: ${document.error}`);
  } else {
    const children = readRecord(document.data, "get_document result").children;
    for (const child of Array.isArray(children) ? children : []) {
      const node = child as Json;
      const name = typeof node.name === "string" ? node.name : "";
      const id = typeof node.id === "string" ? node.id : "";
      if (id === "" || !name.startsWith(PREFIX)) continue;
      const removed = await callTool("delete_nodes", { nodeIds: [id], confirm: true });
      if (!removed.ok) problems.push(`delete_nodes ${id} "${name}" failed: ${removed.error}`);
    }
  }

  const styles = await callTool("get_styles");
  if (!styles.ok) {
    problems.push(`get_styles failed: ${styles.error}`);
  } else {
    const textStyles = readRecords(
      readRecord(styles.data, "get_styles result").text,
      "get_styles.text"
    );
    for (const style of textStyles) {
      const name = typeof style.name === "string" ? style.name : "";
      const id = typeof style.id === "string" ? style.id : "";
      if (id === "" || !name.startsWith(PREFIX)) continue;
      const removed = await callTool("delete_text_style", { styleId: id, confirm: true });
      if (!removed.ok) problems.push(`delete_text_style "${name}" failed: ${removed.error}`);
    }
  }

  const defs = await callTool("get_variable_defs");
  if (!defs.ok) {
    problems.push(`get_variable_defs failed: ${defs.error}`);
  } else {
    const collections = readRecords(
      readRecord(defs.data, "get_variable_defs result").collections,
      "get_variable_defs.collections"
    );
    for (const collection of collections) {
      const name = typeof collection.name === "string" ? collection.name : "";
      const id = typeof collection.id === "string" ? collection.id : "";
      if (id === "" || !name.startsWith(PREFIX)) continue;
      const removed = await callTool("delete_variable_collection", {
        collectionId: id,
        confirm: true,
      });
      if (!removed.ok)
        problems.push(`delete_variable_collection "${name}" failed: ${removed.error}`);
    }
  }

  return problems;
};

// ---------------------------------------------------------------------------
// T2.1 Variables
// ---------------------------------------------------------------------------

const VARIABLE_ITEMS = [
  {
    name: "mcp-e2e/color/brand",
    type: "COLOR",
    value: "#3366FF",
    scopes: ["FRAME_FILL", "SHAPE_FILL"],
  },
  {
    name: "mcp-e2e/color/accent",
    type: "COLOR",
    value: { aliasName: "mcp-e2e/color/brand" },
    scopes: ["ALL_FILLS"],
  },
  { name: "mcp-e2e/space/md", type: "FLOAT", value: 16, scopes: ["GAP", "WIDTH_HEIGHT"] },
  { name: "mcp-e2e/radius/md", type: "FLOAT", value: 12, scopes: ["CORNER_RADIUS"] },
  { name: "mcp-e2e/type/size-lg", type: "FLOAT", value: 24, scopes: ["FONT_SIZE"] },
  { name: "mcp-e2e/label/title", type: "STRING", value: "E2E", scopes: ["TEXT_CONTENT"] },
  { name: "mcp-e2e/flag/on", type: "BOOLEAN", value: true },
];

/** Creates the collection and the four variable types, and reads them back. */
const runVariableSteps = async (): Promise<void> => {
  await step("A1 create_variable_collection", async () => {
    const created = await okRecord("create_variable_collection", { name: `${PREFIX}tokens` });
    const id = readString(created.id, "create_variable_collection.id");
    check(
      id.startsWith("VariableCollectionId:"),
      `create_variable_collection returned the ID ${id}, expected one starting with "VariableCollectionId:"`
    );
    check(created.name === `${PREFIX}tokens`, `the collection is named ${show(created.name)}`);
    ctx.collectionId = id;
    ctx.defaultModeId = readString(
      created.defaultModeId,
      "create_variable_collection.defaultModeId"
    );
  });

  await step("A2 create_variables (COLOR, FLOAT, STRING, BOOLEAN, alias)", async () => {
    const data = await ok("create_variables", {
      collectionId: need("collectionId"),
      variables: VARIABLE_ITEMS,
    });
    const results = allWritten(data, "create_variables", VARIABLE_ITEMS.length);
    const variables: Record<string, string> = {};
    results.forEach((result, index) => {
      const id = readString(result.id, `create_variables results[${index}].id`);
      check(
        id.startsWith("VariableID:"),
        `create_variables results[${index}].id is ${id}, expected one starting with "VariableID:"`
      );
      variables[VARIABLE_ITEMS[index].name] = id;
    });
    ctx.variables = variables;
  });

  await step("A3 update_variables (value, scopes, description)", async () => {
    const data = await ok("update_variables", {
      updates: [
        {
          variableId: variableId("mcp-e2e/space/md"),
          value: 20,
          description: "spacing, medium",
        },
        {
          variableId: variableId("mcp-e2e/color/brand"),
          scopes: ["ALL_FILLS", "STROKE_COLOR"],
        },
      ],
    });
    allWritten(data, "update_variables", 2);
  });

  await step(
    "A4 get_variable_defs shows values, alias, scopes, description, defaultModeId",
    async () => {
      const defs = await okRecord("get_variable_defs");
      const collections = readRecords(defs.collections, "get_variable_defs.collections");
      const collection = collections.find((entry) => entry.id === need("collectionId"));
      check(collection !== undefined, `get_variable_defs does not list ${need("collectionId")}`);

      const mode = readString((collection as Json).defaultModeId, "collection.defaultModeId");
      check(
        mode === need("defaultModeId"),
        `get_variable_defs reports defaultModeId ${mode}, but create_variable_collection returned ${need("defaultModeId")}`
      );

      const variables = readRecords((collection as Json).variables, "collection.variables");
      check(
        variables.length === VARIABLE_ITEMS.length,
        `the collection holds ${variables.length} variables, expected ${VARIABLE_ITEMS.length}`
      );

      const byName = new Map(variables.map((variable) => [String(variable.name), variable]));
      const valueOf = (name: string): unknown => {
        const variable = byName.get(name);
        check(variable !== undefined, `the collection holds no variable named "${name}"`);
        const values = readRecord((variable as Json).valuesByMode, `${name}.valuesByMode`);
        check(mode in values, `${name} carries no value in the default mode ${mode}`);
        return values[mode];
      };

      const brand = readRecord(valueOf("mcp-e2e/color/brand"), "mcp-e2e/color/brand value");
      check(brand.type === "COLOR", `mcp-e2e/color/brand is ${show(brand)}, expected a COLOR`);
      near(readNumber(brand.r, "brand.r"), 0x33 / 255, "mcp-e2e/color/brand red");
      near(readNumber(brand.g, "brand.g"), 0x66 / 255, "mcp-e2e/color/brand green");
      near(readNumber(brand.b, "brand.b"), 1, "mcp-e2e/color/brand blue");
      near(readNumber(brand.a, "brand.a"), 1, "mcp-e2e/color/brand alpha");

      const accent = readRecord(valueOf("mcp-e2e/color/accent"), "mcp-e2e/color/accent value");
      check(
        accent.type === "VARIABLE_ALIAS",
        `mcp-e2e/color/accent is ${show(accent)}, expected a VARIABLE_ALIAS`
      );
      check(
        accent.id === variableId("mcp-e2e/color/brand"),
        `mcp-e2e/color/accent aliases ${show(accent.id)}, expected ${variableId("mcp-e2e/color/brand")}`
      );

      check(
        valueOf("mcp-e2e/space/md") === 20,
        "update_variables did not write mcp-e2e/space/md = 20"
      );
      check(valueOf("mcp-e2e/label/title") === "E2E", 'mcp-e2e/label/title does not hold "E2E"');
      check(valueOf("mcp-e2e/flag/on") === true, "mcp-e2e/flag/on does not hold true");

      const space = byName.get("mcp-e2e/space/md") as Json;
      check(
        space.description === "spacing, medium",
        `mcp-e2e/space/md has the description ${show(space.description)}`
      );

      const brandVariable = byName.get("mcp-e2e/color/brand") as Json;
      sameMembers(
        readArray(brandVariable.scopes, "mcp-e2e/color/brand scopes") as string[],
        ["ALL_FILLS", "STROKE_COLOR"],
        "mcp-e2e/color/brand scopes"
      );
      const radius = byName.get("mcp-e2e/radius/md") as Json;
      sameMembers(
        readArray(radius.scopes, "mcp-e2e/radius/md scopes") as string[],
        ["CORNER_RADIUS"],
        "mcp-e2e/radius/md scopes"
      );
    }
  );
};

// ---------------------------------------------------------------------------
// T2.2 Typography
// ---------------------------------------------------------------------------

/** Lists the fonts, builds a text style with a bound font size, and reads it back. */
const runTypographySteps = async (): Promise<void> => {
  await step("B1 list_fonts finds Inter", async () => {
    const fonts = await okRecord("list_fonts", { query: "Inter", limit: 50 });
    const families = readRecords(fonts.fonts, "list_fonts.fonts");
    const inter = families.find((family) => family.family === "Inter");
    check(
      inter !== undefined,
      `list_fonts(query: "Inter") returned ${show(families.map((f) => f.family))}`
    );
    const styles = readArray((inter as Json).styles, "Inter styles") as string[];
    check(
      styles.includes("Regular"),
      `Inter has the styles ${show(styles)}, expected one named "Regular"`
    );
    check(
      styles.includes("Bold"),
      `Inter has the styles ${show(styles)}, expected one named "Bold"`
    );
  });

  await step("B2 create_text_style with a FLOAT variable bound to fontSize", async () => {
    const created = await okRecord("create_text_style", {
      name: `${PREFIX}Title`,
      fontFamily: "Inter",
      fontStyle: "Bold",
      fontSize: 18,
      lineHeight: { unit: "PERCENT", value: 120 },
      letterSpacing: { unit: "PIXELS", value: -0.5 },
      paragraphSpacing: 8,
      paragraphIndent: 4,
      textCase: "UPPER",
      leadingTrim: "CAP_HEIGHT",
      description: "e2e title",
      boundVariables: { fontSize: variableId("mcp-e2e/type/size-lg") },
    });
    const id = readString(created.id, "create_text_style.id");
    check(
      id.startsWith("S:"),
      `create_text_style returned the ID ${id}, expected one starting with "S:"`
    );
    ctx.styleId = id;
  });

  await step("B3 update_text_style", async () => {
    const updated = await okRecord("update_text_style", {
      styleId: need("styleId"),
      paragraphSpacing: 12,
      description: "e2e title, revised",
    });
    check(
      updated.id === need("styleId"),
      `update_text_style returned the ID ${show(updated.id)}, expected ${need("styleId")}`
    );
  });

  await step("B4 get_styles shows description, spacing, case, trim, boundVariables", async () => {
    const styles = await okRecord("get_styles");
    const textStyles = readRecords(styles.text, "get_styles.text");
    const style = textStyles.find((entry) => entry.id === need("styleId"));
    check(style !== undefined, `get_styles does not list the text style ${need("styleId")}`);
    const found = style as Json;

    check(found.name === `${PREFIX}Title`, `the style is named ${show(found.name)}`);
    check(
      found.description === "e2e title, revised",
      `the style has the description ${show(found.description)}`
    );
    check(
      found.paragraphSpacing === 12,
      `paragraphSpacing is ${show(found.paragraphSpacing)}, expected 12`
    );
    check(
      found.paragraphIndent === 4,
      `paragraphIndent is ${show(found.paragraphIndent)}, expected 4`
    );
    check(found.textCase === "UPPER", `textCase is ${show(found.textCase)}, expected "UPPER"`);
    check(
      found.leadingTrim === "CAP_HEIGHT",
      `leadingTrim is ${show(found.leadingTrim)}, expected "CAP_HEIGHT"`
    );

    const lineHeight = readRecord(found.lineHeight, "the style's lineHeight");
    check(
      lineHeight.unit === "PERCENT",
      `lineHeight.unit is ${show(lineHeight.unit)}, expected "PERCENT"`
    );
    // Figma keeps a PERCENT line height as the float32 multiplier 1.2, so 120
    // comes back as 120.00000476837158.
    near(readNumber(lineHeight.value, "lineHeight.value"), 120, "lineHeight.value");

    const bound = readRecord(found.boundVariables, "the style's boundVariables");
    check(
      bound.fontSize === variableId("mcp-e2e/type/size-lg"),
      `boundVariables.fontSize is ${show(bound.fontSize)}, expected ${variableId("mcp-e2e/type/size-lg")}`
    );
    check(
      found.fontSize === 24,
      `fontSize is ${show(found.fontSize)}; the bound variable holds 24, so the style should resolve to it`
    );
  });
};

// ---------------------------------------------------------------------------
// T2.3 Components
// ---------------------------------------------------------------------------

/** Builds the two variants, the set, its four properties, and reads them back. */
const runComponentSteps = async (): Promise<void> => {
  await step("C1 create_frame root", async () => {
    const root = await okRecord("create_frame", {
      name: `${PREFIX}root`,
      parentId: need("pageId"),
      x: 0,
      y: 0,
      width: 840,
      height: 520,
      fillHex: "#FFFFFF",
    });
    ctx.rootId = readString(root.nodeId, "create_frame.nodeId");
  });

  await step("C2 create_frame + create_text for each variant", async () => {
    const variants: Array<{
      key: "smallComponentId" | "largeComponentId";
      label: string;
      width: number;
    }> = [
      { key: "smallComponentId", label: "Small", width: 150 },
      { key: "largeComponentId", label: "Large", width: 210 },
    ];
    const labels: string[] = [];
    const frames: string[] = [];

    for (const [index, variant] of variants.entries()) {
      const frame = await okRecord("create_frame", {
        name: `${PREFIX}variant-${variant.label.toLowerCase()}`,
        parentId: need("rootId"),
        x: 40 + index * 260,
        y: 40,
        width: variant.width,
        height: 56,
        fillHex: "#E8ECF4",
      });
      const frameId = readString(frame.nodeId, "create_frame.nodeId");
      frames.push(frameId);

      const text = await okRecord("create_text", {
        name: `${PREFIX}label`,
        parentId: frameId,
        characters: variant.label,
        fontFamily: "Inter",
        fontStyle: "Regular",
        fontSize: 14,
        fillHex: "#11151C",
        x: 16,
        y: 18,
      });
      labels.push(readString(text.nodeId, "create_text.nodeId"));
    }

    ctx.smallLabelId = labels[0];
    ctx.largeLabelId = labels[1];
    // Kept only until the next step converts them.
    ctx.smallComponentId = frames[0];
    ctx.largeComponentId = frames[1];
  });

  await step("C3 create_component from each frame, named in variant format", async () => {
    const small = await okRecord("create_component", {
      fromNodeId: need("smallComponentId"),
      name: "Size=Small",
      parentId: need("rootId"),
    });
    const large = await okRecord("create_component", {
      fromNodeId: need("largeComponentId"),
      name: "Size=Large",
      parentId: need("rootId"),
    });
    ctx.smallComponentId = readString(small.id, "create_component.id");
    ctx.largeComponentId = readString(large.id, "create_component.id");
    check(small.name === "Size=Small", `the first component is named ${show(small.name)}`);
    check(large.name === "Size=Large", `the second component is named ${show(large.name)}`);
  });

  await step("C4 the text child survives the conversion", async () => {
    // createComponentFromNode replaces the frame, so the label IDs are re-read
    // off the component rather than assumed to have survived.
    for (const [componentKey, labelKey] of [
      ["smallComponentId", "smallLabelId"],
      ["largeComponentId", "largeLabelId"],
    ] as const) {
      const component = await okRecord("get_node", { nodeId: need(componentKey) });
      const children = readRecords(component.children, `${need(componentKey)} children`);
      const label = children.find((child) => child.name === `${PREFIX}label`);
      check(label !== undefined, `${need(componentKey)} has no child named "${PREFIX}label"`);
      ctx[labelKey] = readString((label as Json).id, "the label's id");
    }
  });

  await step("C5 combine_as_variants", async () => {
    const set = await okRecord("combine_as_variants", {
      componentIds: [need("smallComponentId"), need("largeComponentId")],
      name: `${PREFIX}button`,
      parentId: need("rootId"),
      layout: "ROW",
      gap: 24,
      padding: 24,
    });
    ctx.setId = readString(set.id, "combine_as_variants.id");
    const variantIds = readArray(set.variantIds, "combine_as_variants.variantIds");
    check(variantIds.length === 2, `the set holds ${variantIds.length} variants, expected 2`);
    check(set.name === `${PREFIX}button`, `the set is named ${show(set.name)}`);
  });

  await step("C6 create_component for the swap target", async () => {
    const icon = await okRecord("create_component", {
      name: `${PREFIX}icon`,
      parentId: need("rootId"),
      width: 24,
      height: 24,
      fillHex: "#FF7755",
      x: 700,
      y: 40,
    });
    ctx.iconId = readString(icon.id, "create_component.id");
  });

  await step("C7 add_component_property TEXT, BOOLEAN, INSTANCE_SWAP, VARIANT", async () => {
    const properties: Record<string, string> = {};
    const add = async (name: string, args: Json): Promise<void> => {
      const added = await okRecord("add_component_property", {
        componentId: need("setId"),
        name,
        ...args,
      });
      check(
        added.componentId === need("setId"),
        `add_component_property("${name}") reports the owner ${show(added.componentId)}`
      );
      properties[name] = readString(
        added.propertyName,
        `add_component_property("${name}").propertyName`
      );
    };

    await add("Label", { type: "TEXT", defaultValue: "Click" });
    await add("Show icon", { type: "BOOLEAN", defaultValue: true });
    await add("Icon", {
      type: "INSTANCE_SWAP",
      defaultValue: need("iconId"),
      preferredValues: [need("iconId")],
    });
    await add("State", { type: "VARIANT", defaultValue: "Default" });

    check(
      properties["Label"].startsWith("Label#"),
      `Figma stored the TEXT property as ${show(properties["Label"])}, expected a "Label#…" suffix`
    );
    check(
      properties["State"] === "State",
      `Figma stored the VARIANT property as ${show(properties["State"])}, expected "State" with no suffix`
    );
    ctx.properties = properties;
  });

  await step("C8 bind_component_property links each label to the TEXT property", async () => {
    for (const labelKey of ["smallLabelId", "largeLabelId"] as const) {
      const bound = await okRecord("bind_component_property", {
        nodeId: need(labelKey),
        field: "characters",
        propertyName: propertyName("Label"),
      });
      const references = readRecord(
        bound.componentPropertyReferences,
        `${need(labelKey)} componentPropertyReferences`
      );
      check(
        references.characters === propertyName("Label"),
        `characters is linked to ${show(references.characters)}, expected ${propertyName("Label")}`
      );
    }
  });

  await step("C9 get_component shows every property and both variants", async () => {
    const component = await okRecord("get_component", { nodeId: need("setId") });
    check(
      component.type === "COMPONENT_SET",
      `get_component reports the type ${show(component.type)}`
    );

    const properties = readRecords(component.properties, "get_component.properties");
    const byName = new Map(properties.map((property) => [String(property.name), property]));
    const expected: Array<[string, string, unknown]> = [
      ["Label", "TEXT", "Click"],
      ["Show icon", "BOOLEAN", true],
      ["Icon", "INSTANCE_SWAP", need("iconId")],
    ];
    for (const [display, type, defaultValue] of expected) {
      const property = byName.get(propertyName(display));
      check(
        property !== undefined,
        `get_component does not report the property ${propertyName(display)}`
      );
      check(
        (property as Json).type === type,
        `${display} has the type ${show((property as Json).type)}, expected ${type}`
      );
      check(
        (property as Json).defaultValue === defaultValue,
        `${display} defaults to ${show((property as Json).defaultValue)}, expected ${show(defaultValue)}`
      );
      check(
        (property as Json).displayName === display,
        `${propertyName(display)} has the display name ${show((property as Json).displayName)}`
      );
    }

    const size = byName.get("Size");
    check(size !== undefined, "get_component does not report the VARIANT property Size");
    sameMembers(
      readArray((size as Json).variantOptions, "Size variantOptions") as string[],
      ["Small", "Large"],
      "the Size variant options"
    );
    const state = byName.get("State");
    check(state !== undefined, "get_component does not report the VARIANT property State");
    sameMembers(
      readArray((state as Json).variantOptions, "State variantOptions") as string[],
      ["Default"],
      "the State variant options"
    );

    const variants = readRecords(component.variants, "get_component.variants");
    check(variants.length === 2, `the set reports ${variants.length} variants, expected 2`);
    check(
      typeof component.defaultVariantId === "string",
      `defaultVariantId is ${show(component.defaultVariantId)}, expected a node ID`
    );
  });

  await step("C10 bind_component_property(null) removes the last link", async () => {
    // Figma's setter refuses null for componentPropertyReferences, so the
    // handler writes {} instead. Removing a layer's only link is the case that
    // path exists for.
    const removed = await okRecord("bind_component_property", {
      nodeId: need("largeLabelId"),
      field: "characters",
      propertyName: null,
    });
    const afterRemove = readRecord(
      removed.componentPropertyReferences,
      "componentPropertyReferences after the removal"
    );
    check(
      afterRemove.characters === undefined,
      `characters is still linked to ${show(afterRemove.characters)} after passing propertyName: null`
    );

    // Put it back: the instance steps read the label through this property.
    const restored = await okRecord("bind_component_property", {
      nodeId: need("largeLabelId"),
      field: "characters",
      propertyName: propertyName("Label"),
    });
    const afterRestore = readRecord(
      restored.componentPropertyReferences,
      "componentPropertyReferences after the restore"
    );
    check(
      afterRestore.characters === propertyName("Label"),
      `characters is linked to ${show(afterRestore.characters)}, expected ${propertyName("Label")}`
    );
  });
};

// ---------------------------------------------------------------------------
// T2.4 Instances
// ---------------------------------------------------------------------------

/** Places an instance, configures it by display name, swaps it, and detaches a second. */
const runInstanceSteps = async (): Promise<void> => {
  await step("D1 create_instance with variant values", async () => {
    const instance = await okRecord("create_instance", {
      componentId: need("setId"),
      variantProperties: { Size: "Large", State: "Default" },
      parentId: need("rootId"),
      x: 40,
      y: 220,
    });
    ctx.instanceId = readString(instance.id, "create_instance.id");
    check(
      instance.mainComponentId === need("largeComponentId"),
      `the instance follows ${show(instance.mainComponentId)}, expected the Size=Large variant ${need("largeComponentId")}`
    );
  });

  await step("D2 set_instance_properties by display name", async () => {
    const set = await okRecord("set_instance_properties", {
      nodeId: need("instanceId"),
      properties: { Label: "Buy now", "Show icon": false },
    });
    check(
      set.id === need("instanceId"),
      `set_instance_properties returned the ID ${show(set.id)}, expected ${need("instanceId")}`
    );
  });

  await step("D3 get_instance shows the values and the main component", async () => {
    const instance = await okRecord("get_instance", { nodeId: need("instanceId") });
    const properties = readRecord(instance.properties, "get_instance.properties");

    const label = readRecord(
      properties[propertyName("Label")],
      `properties[${propertyName("Label")}]`
    );
    check(
      label.value === "Buy now",
      `the Label property holds ${show(label.value)}, expected "Buy now"`
    );
    check(label.type === "TEXT", `the Label property has the type ${show(label.type)}`);

    const showIcon = readRecord(
      properties[propertyName("Show icon")],
      `properties[${propertyName("Show icon")}]`
    );
    check(
      showIcon.value === false,
      `the "Show icon" property holds ${show(showIcon.value)}, expected false`
    );

    const main = readRecord(instance.mainComponent, "get_instance.mainComponent");
    check(
      main.parentSetId === need("setId"),
      `the main component belongs to ${show(main.parentSetId)}, expected ${need("setId")}`
    );
    check(
      main.remote === false,
      `the main component reports remote ${show(main.remote)}, expected false`
    );
  });

  await step("D4 swap_instance to the other variant", async () => {
    const swapped = await okRecord("swap_instance", {
      nodeId: need("instanceId"),
      componentId: need("setId"),
      variantProperties: { Size: "Small", State: "Default" },
    });
    check(
      swapped.mainComponentId === need("smallComponentId"),
      `the instance now follows ${show(swapped.mainComponentId)}, expected the Size=Small variant ${need("smallComponentId")}`
    );
  });

  await step("D5 detach_instance turns a second instance into a frame", async () => {
    const second = await okRecord("create_instance", {
      componentId: need("setId"),
      variantProperties: { Size: "Large", State: "Default" },
      parentId: need("rootId"),
      x: 360,
      y: 220,
    });
    const secondId = readString(second.id, "create_instance.id");

    const data = await ok("detach_instance", { nodeIds: [secondId] });
    const results = allWritten(data, "detach_instance", 1);
    const frameId = readString(results[0].frameId, "detach_instance results[0].frameId");
    ctx.detachedFrameId = frameId;

    const frame = await okRecord("get_node", { nodeId: frameId });
    check(frame.type === "FRAME", `the detached node is a ${show(frame.type)}, expected a FRAME`);
  });
};

// ---------------------------------------------------------------------------
// T2.5 Bindings
// ---------------------------------------------------------------------------

/** Binds a fill, a padding, a corner radius, and a font size, and applies a text style. */
const runBindingSteps = async (): Promise<void> => {
  await step("E1 create_frame + create_text for the binding targets", async () => {
    const frame = await okRecord("create_frame", {
      name: `${PREFIX}bound`,
      parentId: need("rootId"),
      x: 40,
      y: 340,
      width: 240,
      height: 140,
      fillHex: "#EEEEEE",
    });
    ctx.boundFrameId = readString(frame.nodeId, "create_frame.nodeId");

    // paddingLeft only takes a variable on an auto-layout frame.
    await ok("set_auto_layout", {
      nodeId: need("boundFrameId"),
      layoutMode: "VERTICAL",
      itemSpacing: 8,
      paddingTop: 8,
      paddingLeft: 8,
    });

    const boundText = await okRecord("create_text", {
      name: `${PREFIX}bound-text`,
      parentId: need("boundFrameId"),
      characters: "bound",
      fontFamily: "Inter",
      fontStyle: "Regular",
      fontSize: 14,
    });
    ctx.boundTextId = readString(boundText.nodeId, "create_text.nodeId");

    const styledText = await okRecord("create_text", {
      name: `${PREFIX}styled-text`,
      parentId: need("rootId"),
      characters: "styled",
      fontFamily: "Inter",
      fontStyle: "Regular",
      fontSize: 14,
      x: 360,
      y: 360,
    });
    ctx.styledTextId = readString(styledText.nodeId, "create_text.nodeId");
  });

  await step("E2 bind_variables for a fill, a padding, a radius, and a font size", async () => {
    const data = await ok("bind_variables", {
      bindings: [
        {
          nodeId: need("boundFrameId"),
          field: "fills",
          variableId: variableId("mcp-e2e/color/brand"),
          paintIndex: 0,
        },
        {
          nodeId: need("boundFrameId"),
          field: "paddingLeft",
          variableId: variableId("mcp-e2e/space/md"),
        },
        {
          nodeId: need("boundFrameId"),
          field: "cornerRadius",
          variableId: variableId("mcp-e2e/radius/md"),
        },
        {
          nodeId: need("boundTextId"),
          field: "fontSize",
          variableId: variableId("mcp-e2e/type/size-lg"),
        },
      ],
    });
    allWritten(data, "bind_variables", 4);
  });

  await step("E3 apply_text_style", async () => {
    const data = await ok("apply_text_style", {
      nodeIds: [need("styledTextId")],
      styleId: need("styleId"),
    });
    allWritten(data, "apply_text_style", 1);
  });

  await step("E4 get_node shows boundVariables", async () => {
    const frame = await okRecord("get_node", { nodeId: need("boundFrameId") });
    const bound = readRecord(frame.boundVariables, `${need("boundFrameId")} boundVariables`);

    const fills = readArray(bound.fills, "boundVariables.fills") as string[];
    check(
      fills.includes(variableId("mcp-e2e/color/brand")),
      `boundVariables.fills is ${show(fills)}, expected it to carry ${variableId("mcp-e2e/color/brand")}`
    );
    check(
      bound.paddingLeft === variableId("mcp-e2e/space/md"),
      `boundVariables.paddingLeft is ${show(bound.paddingLeft)}, expected ${variableId("mcp-e2e/space/md")}`
    );
    // Figma spreads a cornerRadius binding over the four corners, so that is
    // where get_node reports it — there is no "cornerRadius" entry to read.
    check(
      bound.cornerRadius === undefined,
      `boundVariables carries cornerRadius ${show(bound.cornerRadius)}; Figma was expected to spread it over the four corners`
    );
    for (const corner of SPREAD_FIELDS.cornerRadius) {
      check(
        bound[corner] === variableId("mcp-e2e/radius/md"),
        `boundVariables.${corner} is ${show(bound[corner])}, expected ${variableId("mcp-e2e/radius/md")}`
      );
    }
    const styles = readRecord(frame.styles, `${need("boundFrameId")} styles`);
    check(
      styles.cornerRadius === 12,
      `the frame's cornerRadius is ${show(styles.cornerRadius)}, expected 12`
    );

    const text = await okRecord("get_node", { nodeId: need("boundTextId") });
    const textBound = readRecord(text.boundVariables, `${need("boundTextId")} boundVariables`);
    // A text field carries one binding per styled range, so Figma reports it
    // as a list even when the whole node shares one value.
    const fontSize = readArray(textBound.fontSize, "boundVariables.fontSize") as string[];
    sameMembers(
      fontSize,
      [variableId("mcp-e2e/type/size-lg")],
      "the font sizes bound on the text node"
    );
  });

  await step("E5 get_node shows textStyleId, and apply_text_style(null) drops it", async () => {
    const styled = await okRecord("get_node", { nodeId: need("styledTextId") });
    check(
      styled.textStyleId === need("styleId"),
      `textStyleId is ${show(styled.textStyleId)}, expected ${need("styleId")}`
    );

    const data = await ok("apply_text_style", { nodeIds: [need("styledTextId")], styleId: null });
    allWritten(data, "apply_text_style", 1);

    const unlinked = await okRecord("get_node", { nodeId: need("styledTextId") });
    check(
      unlinked.textStyleId === undefined,
      `textStyleId is ${show(unlinked.textStyleId)} after unlinking, expected it to be gone`
    );
  });

  await step("E6 bind_variables(null) removes a spread binding and keeps the value", async () => {
    // strokeWeight spreads like cornerRadius, so the unbind covers both.
    const bind = await ok("bind_variables", {
      bindings: [
        {
          nodeId: need("boundFrameId"),
          field: "strokeWeight",
          variableId: variableId("mcp-e2e/radius/md"),
        },
      ],
    });
    allWritten(bind, "bind_variables", 1);

    const bindVariables = async (): Promise<Json> => {
      const frame = await okRecord("get_node", { nodeId: need("boundFrameId") });
      return frame.boundVariables === undefined
        ? {}
        : readRecord(frame.boundVariables, "boundVariables");
    };

    const spread = await bindVariables();
    for (const side of SPREAD_FIELDS.strokeWeight) {
      check(
        spread[side] === variableId("mcp-e2e/radius/md"),
        `boundVariables.${side} is ${show(spread[side])}, expected ${variableId("mcp-e2e/radius/md")}`
      );
    }

    const unbind = await ok("bind_variables", {
      bindings: [
        { nodeId: need("boundFrameId"), field: "cornerRadius", variableId: null },
        { nodeId: need("boundFrameId"), field: "strokeWeight", variableId: null },
      ],
    });
    allWritten(unbind, "bind_variables", 2);

    const cleared = await bindVariables();
    for (const field of [...SPREAD_FIELDS.cornerRadius, ...SPREAD_FIELDS.strokeWeight]) {
      check(
        cleared[field] === undefined,
        `boundVariables.${field} is still ${show(cleared[field])} after the unbind`
      );
    }

    const frame = await okRecord("get_node", { nodeId: need("boundFrameId") });
    const styles = readRecord(frame.styles, "the frame's styles");
    check(
      styles.cornerRadius === 12,
      `the frame's cornerRadius is ${show(styles.cornerRadius)} after unbinding, expected it to keep 12`
    );
    check(
      styles.strokeWeight === 12,
      `the frame's strokeWeight is ${show(styles.strokeWeight)} after unbinding, expected it to keep 12`
    );
  });
};

// ---------------------------------------------------------------------------
// T2.6 Reads, T2.7 screenshot
// ---------------------------------------------------------------------------

/** Lists the components of the page and of the file, and exports the test frame. */
const runReadSteps = async (): Promise<void> => {
  await step("F1 list_components for the current page", async () => {
    const listed = await okRecord("list_components", { scope: "currentPage", query: PREFIX });
    const items = readRecords(listed.items, "list_components.items");
    const ids = items.map((item) => String(item.id));

    check(
      ids.includes(need("setId")),
      `the page listing ${show(ids)} does not carry the set ${need("setId")}`
    );
    check(
      ids.includes(need("iconId")),
      `the page listing ${show(ids)} does not carry the icon ${need("iconId")}`
    );
    check(
      !ids.includes(need("smallComponentId")),
      "the page listing carries a variant on its own; a variant belongs to the set that reports it"
    );

    const set = items.find((item) => item.id === need("setId")) as Json;
    check(set.type === "COMPONENT_SET", `the set is listed as ${show(set.type)}`);
    check(
      set.variantCount === 2,
      `the set reports variantCount ${show(set.variantCount)}, expected 2`
    );
    const options = readRecord(set.variantProperties, "the set's variantProperties");
    sameMembers(Object.keys(options), ["Size", "State"], "the set's variant property names");
    check(set.pageId === need("pageId"), `the set is listed on the page ${show(set.pageId)}`);
  });

  await step("F2 list_components for all pages", async () => {
    const listed = await okRecord("list_components", { scope: "allPages", query: PREFIX });
    const items = readRecords(listed.items, "list_components.items");
    const ids = items.map((item) => String(item.id));

    check(
      ids.includes(need("setId")),
      `the file listing ${show(ids)} does not carry the set ${need("setId")}`
    );
    check(
      ids.includes(need("iconId")),
      `the file listing ${show(ids)} does not carry the icon ${need("iconId")}`
    );
    for (const item of items) {
      check(
        typeof item.pageId === "string" && typeof item.pageName === "string",
        `${show(item.name)} is listed without a page: ${show(item)}`
      );
    }
  });

  await step("G1 get_screenshot of the test frame", async () => {
    // A small PNG comes back as an image block and a text block, with no base64 in text.
    const png = await callRaw("get_screenshot", {
      nodeIds: [need("rootId")],
      format: "PNG",
      scale: 1,
    });
    check(!png.isError, `get_screenshot (PNG) failed: ${show(png.content)}`);
    const types = png.content.map((block) => block.type).join(",");
    check(
      types === "image,text",
      `get_screenshot (PNG) returned the blocks ${types}, expected image,text: the frame may be above 1568 pixels or 3750000 bytes`
    );
    const image = png.content[0];
    check(image.mimeType === "image/png", `the image block is ${show(image.mimeType)}`);
    const bytes = Buffer.from(readString(image.data, "the image block's data"), "base64");
    check(bytes.byteLength > 0, "the PNG image block decoded to 0 bytes");
    const meta = readRecord(JSON.parse(png.content[1].text ?? ""), "the metadata block");
    check(meta.nodeId === need("rootId"), `the capture is of ${show(meta.nodeId)}`);
    check(meta.format === "PNG", `the capture is a ${show(meta.format)}, expected PNG`);
    check(meta.bytes === bytes.byteLength, `the metadata says ${show(meta.bytes)} bytes`);
    const header = readPngHeader(bytes);
    check(
      meta.pixelWidth === header.width && meta.pixelHeight === header.height,
      `the metadata says ${show(meta.pixelWidth)} x ${show(meta.pixelHeight)}, the header ${header.width} x ${header.height}`
    );
    check(!(png.content[1].text ?? "").includes("base64"), "the metadata block mentions base64");
    const pngFile = join(OUTPUT_DIR, "mcp-e2e-root.png");
    await writeFile(pngFile, bytes);
    console.log(`      wrote ${pngFile} (${bytes.byteLength} bytes)`);

    // An SVG stays JSON text with base64.
    const shot = await okRecord("get_screenshot", {
      nodeIds: [need("rootId")],
      format: "SVG",
    });
    const exports = readRecords(shot.exports, "get_screenshot.exports");
    check(exports.length === 1, `get_screenshot returned ${exports.length} exports, expected 1`);
    const single = exports[0];
    check(single.nodeId === need("rootId"), `the export is of ${show(single.nodeId)}`);
    check(single.format === "SVG", `the export is a ${show(single.format)}, expected SVG`);
    const svg = Buffer.from(readString(single.base64, "the export's base64"), "base64");
    check(svg.byteLength > 0, "the SVG export decoded to 0 bytes");
    const svgFile = join(OUTPUT_DIR, "mcp-e2e-root.svg");
    await writeFile(svgFile, svg);
    console.log(`      wrote ${svgFile} (${svg.byteLength} bytes)`);
  });

  await step("G2 save_screenshots writes under the output root", async () => {
    // save_screenshots never overwrites a file, so each run takes a new name.
    const name = `mcp-e2e-saved-${Date.now()}.png`;
    const saved = await okRecord("save_screenshots", {
      items: [{ nodeId: need("rootId"), outputPath: name }],
      scale: 1,
    });
    check(saved.succeeded === 1, `save_screenshots reports ${show(saved)}`);
    const result = readRecords(saved.files, "save_screenshots.files")[0];
    const file = join(OUTPUT_DIR, name);
    check(
      result.path === name,
      `the file went to ${show(result.path)}, expected ${name} in the output root`
    );
    const manifestFile = join(OUTPUT_DIR, readString(saved.manifestPath, "manifestPath"));
    try {
      const bytes = await readFile(file);
      check(
        bytes.byteLength === result.bytes,
        `the file holds ${bytes.byteLength} bytes, the result says ${show(result.bytes)}`
      );
      console.log(`      saved ${file} (${bytes.byteLength} bytes)`);
    } finally {
      await rm(file, { force: true });
      await rm(manifestFile, { force: true });
    }

    const refused = await okRecord("save_screenshots", {
      items: [{ nodeId: need("rootId"), outputPath: "../mcp-e2e-outside.png" }],
    });
    const refusal = readRecords(refused.files, "save_screenshots.files")[0];
    check(refusal.ok === false, `a path out of the root was not refused: ${show(refusal)}`);
    check(
      String(refusal.error).includes("leads out of the root"),
      `the refusal does not name its cause: ${show(refusal.error)}`
    );
  });
};

// ---------------------------------------------------------------------------
// T2.7 Sections
// ---------------------------------------------------------------------------

/**
 * Where the section steps build, clear of the component root frame at the
 * origin so a screenshot of either one shows only its own work.
 */
const SECTION_ORIGIN_X = 1200;

/** The empty section S1 makes, and S5 to S7 then fill and drain. */
const EMPTY_SECTION = { x: SECTION_ORIGIN_X, y: 0, width: 400, height: 300 };

/** The two boxes S2 wraps, on the page, at the positions they have to keep. */
const BOX_A = { x: 1700, y: 100, width: 120, height: 80 };
const BOX_B = { x: 1900, y: 220, width: 120, height: 80 };

/** The node S5 moves into a section, S6 fits around, and S7 lifts back out. */
const MOVED_BOX = { x: SECTION_ORIGIN_X + 40, y: 400, width: 100, height: 100 };

/** The margin S2 asks the wrapping form of `create_section` for. */
const WRAP_PADDING = 40;

/** The margin `create_section`, `move_to_section`, and `fit_section` leave by default. */
const DEFAULT_SECTION_PADDING = 80;

/**
 * Where a section top-left sits on the canvas.
 *
 * A child carries `x` and `y` read against the section holding it, so this is
 * what a canvas position is measured from. Neither a page nor a section
 * rotates, which is what makes the addition enough.
 * @param sectionId - The section.
 * @returns Its absolute position.
 */
const sectionOrigin = async (sectionId: string): Promise<{ x: number; y: number }> => {
  const section = await okRecord("get_section", { nodeId: sectionId });
  return {
    x: readNumber(section.absoluteX, `${sectionId} absoluteX`),
    y: readNumber(section.absoluteY, `${sectionId} absoluteY`),
  };
};

/**
 * Where a node sits inside the parent holding it.
 *
 * The serializer carries a position under `bounds` rather than on the node
 * itself, so this is where a step comparing positions reads it from.
 * @param nodeId - The node.
 * @returns Its box within its parent.
 */
const nodeBounds = async (
  nodeId: string
): Promise<{ x: number; y: number; width: number; height: number }> => {
  const node = await okRecord("get_node", { nodeId });
  const bounds = readRecord(node.bounds, `${nodeId} bounds`);
  return {
    x: readNumber(bounds.x, `${nodeId} bounds.x`),
    y: readNumber(bounds.y, `${nodeId} bounds.y`),
    width: readNumber(bounds.width, `${nodeId} bounds.width`),
    height: readNumber(bounds.height, `${nodeId} bounds.height`),
  };
};

/**
 * Builds a section, wraps nodes in one, nests one inside another, and drives
 * every tool that carries a node across a section boundary.
 *
 * Figma keeps a section outside the frame tree and reads a child position
 * against it, so each step that moves a node also checks the node stayed where
 * it was drawn.
 */
const runSectionSteps = async (): Promise<void> => {
  await step("S1 create_section makes an empty section", async () => {
    const made = await okRecord("create_section", {
      name: `${PREFIX}section/empty`,
      parentId: need("pageId"),
      fillHex: "#F2F4F8",
      ...EMPTY_SECTION,
    });
    ctx.emptySectionId = readString(made.id, "create_section.id");

    check(made.name === `${PREFIX}section/empty`, `the section is named ${show(made.name)}`);
    check(
      made.parentId === need("pageId"),
      `the section hangs off ${show(made.parentId)}, expected the test page`
    );
    atPosition(readNumber(made.x, "create_section.x"), EMPTY_SECTION.x, "the section x");
    atPosition(readNumber(made.y, "create_section.y"), EMPTY_SECTION.y, "the section y");
    atPosition(
      readNumber(made.width, "create_section.width"),
      EMPTY_SECTION.width,
      "the section width"
    );
    atPosition(
      readNumber(made.height, "create_section.height"),
      EMPTY_SECTION.height,
      "the section height"
    );
    check(
      readArray(made.childIds, "create_section.childIds").length === 0,
      `the new empty section already holds ${show(made.childIds)}`
    );
  });

  await step("S2 create_section wraps nodes and leaves them on the canvas", async () => {
    const boxes: Array<{
      key: "boxAId" | "boxBId";
      label: string;
      box: typeof BOX_A;
      fill: string;
    }> = [
      { key: "boxAId", label: "a", box: BOX_A, fill: "#3366FF" },
      { key: "boxBId", label: "b", box: BOX_B, fill: "#FF7755" },
    ];
    for (const entry of boxes) {
      const shape = await okRecord("create_shape", {
        shapeType: "RECTANGLE",
        name: `${PREFIX}section/box-${entry.label}`,
        parentId: need("pageId"),
        fillHex: entry.fill,
        ...entry.box,
      });
      ctx[entry.key] = readString(shape.nodeId, "create_shape.nodeId");
    }

    const made = await okRecord("create_section", {
      nodeIds: [need("boxAId"), need("boxBId")],
      name: `${PREFIX}section/wrap`,
      padding: WRAP_PADDING,
    });
    ctx.wrapSectionId = readString(made.id, "create_section.id");

    check(
      made.parentId === need("pageId"),
      `the wrapping section hangs off ${show(made.parentId)}, expected the parent its nodes shared`
    );
    sameMembers(
      readArray(made.childIds, "create_section.childIds").map(String),
      [need("boxAId"), need("boxBId")],
      "the wrapped children"
    );

    // The section is drawn around the two boxes plus the padding. Its own
    // parent is the page, so its x and y are already canvas coordinates.
    atPosition(readNumber(made.x, "create_section.x"), BOX_A.x - WRAP_PADDING, "the section x");
    atPosition(readNumber(made.y, "create_section.y"), BOX_A.y - WRAP_PADDING, "the section y");
    atPosition(
      readNumber(made.width, "create_section.width"),
      BOX_B.x + BOX_B.width - BOX_A.x + WRAP_PADDING * 2,
      "the section width"
    );
    atPosition(
      readNumber(made.height, "create_section.height"),
      BOX_B.y + BOX_B.height - BOX_A.y + WRAP_PADDING * 2,
      "the section height"
    );

    // What the step is really about: the boxes hang off the section now, so
    // wrapping had to rewrite their positions or they would have slid.
    const origin = await sectionOrigin(need("wrapSectionId"));
    for (const entry of boxes) {
      const child = await nodeBounds(need(entry.key));
      atPosition(origin.x + child.x, entry.box.x, `box-${entry.label} on the canvas, in x`);
      atPosition(origin.y + child.y, entry.box.y, `box-${entry.label} on the canvas, in y`);
    }
  });

  await step("S3 get_section reports the children, contentBounds, and overflowIds", async () => {
    // A section does not clip, so a child pushed past its edge is still drawn
    // and still belongs to it. get_section is what tells an agent that.
    const outsideX = 500;
    await ok("set_node_properties", { nodeId: need("boxBId"), x: outsideX });

    const section = await okRecord("get_section", { nodeId: need("wrapSectionId") });
    check(
      section.contentsHidden === false,
      `contentsHidden is ${show(section.contentsHidden)}, expected false in Figma Design`
    );
    check(
      section.childCount === 2,
      `the section holds ${show(section.childCount)} children, expected 2`
    );
    check(section.truncated === false, "the section reports more than 200 direct children");

    const children = readRecords(section.children, "get_section.children");
    sameMembers(
      children.map((child) => String(child.id)),
      [need("boxAId"), need("boxBId")],
      "the children listed"
    );
    const boxB = itemById(children, need("boxBId"), "the children listed");
    check(boxB.type === "RECTANGLE", `box-b is listed as ${show(boxB.type)}`);
    check(boxB.visible === true, `box-b is listed as visible ${show(boxB.visible)}`);
    atPosition(readNumber(boxB.x, "the x of box-b"), outsideX, "box-b inside the section, in x");

    check(
      section.overflowCount === 1,
      `overflowCount is ${show(section.overflowCount)}, expected 1`
    );
    sameMembers(
      readArray(section.overflowIds, "get_section.overflowIds").map(String),
      [need("boxBId")],
      "the children hanging outside the section"
    );

    // Measured over the children rather than over the box of the section, so
    // it reaches past the right edge with box-b.
    const bounds = readRecord(section.contentBounds, "get_section.contentBounds");
    const maxX = outsideX + BOX_B.width;
    const maxY = BOX_B.y - BOX_A.y + WRAP_PADDING + BOX_B.height;
    atPosition(readNumber(bounds.x, "contentBounds.x"), WRAP_PADDING, "contentBounds.x");
    atPosition(readNumber(bounds.y, "contentBounds.y"), WRAP_PADDING, "contentBounds.y");
    atPosition(
      readNumber(bounds.width, "contentBounds.width"),
      maxX - WRAP_PADDING,
      "contentBounds.width"
    );
    atPosition(
      readNumber(bounds.height, "contentBounds.height"),
      maxY - WRAP_PADDING,
      "contentBounds.height"
    );
  });

  await step("S4 list_sections reports a nested section at depth 1", async () => {
    const made = await okRecord("create_section", {
      name: `${PREFIX}section/nested`,
      parentId: need("wrapSectionId"),
      x: WRAP_PADDING,
      y: 160,
      width: 160,
      height: 120,
      fillHex: "#E4ECE0",
    });
    ctx.nestedSectionId = readString(made.id, "create_section.id");
    check(
      made.parentId === need("wrapSectionId"),
      `the nested section hangs off ${show(made.parentId)}, expected the wrapping section`
    );

    const listed = await okRecord("list_sections", { query: PREFIX });
    const items = readRecords(listed.items, "list_sections.items");

    const wrap = itemById(items, need("wrapSectionId"), "list_sections");
    check(wrap.depth === 0, `the wrapping section reports depth ${show(wrap.depth)}, expected 0`);
    check(
      wrap.parentSectionId === null,
      `the wrapping section reports parentSectionId ${show(wrap.parentSectionId)}, expected null`
    );
    check(wrap.childCount === 3, `the wrapping section reports ${show(wrap.childCount)} children`);

    const nested = itemById(items, need("nestedSectionId"), "list_sections");
    check(nested.depth === 1, `the nested section reports depth ${show(nested.depth)}, expected 1`);
    check(
      nested.parentSectionId === need("wrapSectionId"),
      `the nested section reports parentSectionId ${show(nested.parentSectionId)}`
    );
    check(
      nested.pageId === need("pageId"),
      `the nested section is listed on the page ${show(nested.pageId)}`
    );
    check(
      nested.contentsHidden === false,
      `the nested section reports contentsHidden ${show(nested.contentsHidden)}`
    );

    // Document order, so a nested section follows the one holding it and one
    // call is enough to read the shape of the page.
    const order = items.map((item) => String(item.id));
    check(
      order.indexOf(need("nestedSectionId")) > order.indexOf(need("wrapSectionId")),
      `the nested section is listed before the section holding it: ${show(order)}`
    );
  });

  await step("S5 move_to_section takes a node in and fits the section round it", async () => {
    const made = await okRecord("create_shape", {
      shapeType: "ELLIPSE",
      name: `${PREFIX}section/moved`,
      parentId: need("pageId"),
      fillHex: "#8855CC",
      ...MOVED_BOX,
    });
    ctx.movedId = readString(made.nodeId, "create_shape.nodeId");

    const data = await okRecord("move_to_section", {
      sectionId: need("emptySectionId"),
      nodeIds: [need("movedId")],
      fit: true,
    });
    const results = allWritten(data, "move_to_section", 1);
    check(
      results[0].nodeId === need("movedId"),
      `move_to_section reports moving ${show(results[0].nodeId)}`
    );

    // The fit draws the section round the one node it holds now, padding and
    // all, and slides the node back so nothing changes on the canvas.
    const box = readRecord(data.section, "move_to_section.section");
    atPosition(
      readNumber(box.x, "the section x"),
      MOVED_BOX.x - DEFAULT_SECTION_PADDING,
      "the fitted section, in x"
    );
    atPosition(
      readNumber(box.y, "the section y"),
      MOVED_BOX.y - DEFAULT_SECTION_PADDING,
      "the fitted section, in y"
    );
    atPosition(
      readNumber(box.width, "the section width"),
      MOVED_BOX.width + DEFAULT_SECTION_PADDING * 2,
      "the fitted section width"
    );
    atPosition(
      readNumber(box.height, "the section height"),
      MOVED_BOX.height + DEFAULT_SECTION_PADDING * 2,
      "the fitted section height"
    );

    const origin = await sectionOrigin(need("emptySectionId"));
    const child = await nodeBounds(need("movedId"));
    atPosition(origin.x + child.x, MOVED_BOX.x, "the moved node on the canvas, in x");
    atPosition(origin.y + child.y, MOVED_BOX.y, "the moved node on the canvas, in y");
  });

  await step("S6 fit_section redraws a section without moving its child", async () => {
    // Slide the child inside the section, so the box of the section and the
    // box of its content come apart: a section does not carry its children
    // when it resizes, which is the drift a fit exists to undo.
    const inside = { x: 200, y: 150 };
    await ok("set_node_properties", { nodeId: need("movedId"), x: inside.x, y: inside.y });

    const before = await sectionOrigin(need("emptySectionId"));
    const onCanvas = { x: before.x + inside.x, y: before.y + inside.y };

    const box = await okRecord("fit_section", { nodeId: need("emptySectionId") });
    check(box.id === need("emptySectionId"), `fit_section reports ${show(box.id)}`);
    atPosition(
      readNumber(box.x, "fit_section.x"),
      onCanvas.x - DEFAULT_SECTION_PADDING,
      "the fitted section, in x"
    );
    atPosition(
      readNumber(box.y, "fit_section.y"),
      onCanvas.y - DEFAULT_SECTION_PADDING,
      "the fitted section, in y"
    );
    atPosition(
      readNumber(box.width, "fit_section.width"),
      MOVED_BOX.width + DEFAULT_SECTION_PADDING * 2,
      "the fitted section width"
    );
    atPosition(
      readNumber(box.height, "fit_section.height"),
      MOVED_BOX.height + DEFAULT_SECTION_PADDING * 2,
      "the fitted section height"
    );

    const after = await sectionOrigin(need("emptySectionId"));
    const child = await nodeBounds(need("movedId"));
    atPosition(after.x + child.x, onCanvas.x, "the child on the canvas, in x");
    atPosition(after.y + child.y, onCanvas.y, "the child on the canvas, in y");
  });

  await step("S7 move_out_of_section lifts a node back to the page", async () => {
    const origin = await sectionOrigin(need("emptySectionId"));
    const child = await nodeBounds(need("movedId"));
    const onCanvas = { x: origin.x + child.x, y: origin.y + child.y };

    const data = await ok("move_out_of_section", { nodeIds: [need("movedId")] });
    const results = allWritten(data, "move_out_of_section", 1);
    check(
      results[0].parentId === need("pageId"),
      `the node rose to ${show(results[0].parentId)}, expected the page holding its section`
    );
    // The origin of a page is the origin of the canvas, so the position the
    // call reports is where the node is drawn.
    atPosition(readNumber(results[0].x, "the x reported"), onCanvas.x, "the lifted node, in x");
    atPosition(readNumber(results[0].y, "the y reported"), onCanvas.y, "the lifted node, in y");

    const emptied = await okRecord("get_section", { nodeId: need("emptySectionId") });
    check(emptied.childCount === 0, `the section still holds ${show(emptied.childCount)} children`);
    check(emptied.contentBounds === null, "the emptied section still reports contentBounds");
  });

  await step("S8 ungroup_node takes a nested section apart", async () => {
    const offset = { x: 20, y: 20 };
    const nestedOrigin = await sectionOrigin(need("nestedSectionId"));
    const made = await okRecord("create_shape", {
      shapeType: "RECTANGLE",
      name: `${PREFIX}section/nested-box`,
      parentId: need("nestedSectionId"),
      fillHex: "#11AA88",
      x: offset.x,
      y: offset.y,
      width: 60,
      height: 40,
    });
    ctx.nestedBoxId = readString(made.nodeId, "create_shape.nodeId");
    const onCanvas = { x: nestedOrigin.x + offset.x, y: nestedOrigin.y + offset.y };

    const data = await okRecord("ungroup_node", { nodeId: need("nestedSectionId") });
    check(
      data.parentId === need("wrapSectionId"),
      `the children rose to ${show(data.parentId)}, expected the section that held the nested one`
    );
    sameMembers(
      readArray(data.orphanIds, "ungroup_node.orphanIds").map(String),
      [need("nestedBoxId")],
      "the children the ungroup freed"
    );

    const wrapOrigin = await sectionOrigin(need("wrapSectionId"));
    const freed = await nodeBounds(need("nestedBoxId"));
    atPosition(wrapOrigin.x + freed.x, onCanvas.x, "the freed node on the canvas, in x");
    atPosition(wrapOrigin.y + freed.y, onCanvas.y, "the freed node on the canvas, in y");

    const listed = await okRecord("list_sections", { query: PREFIX });
    const ids = readRecords(listed.items, "list_sections.items").map((item) => String(item.id));
    check(
      !ids.includes(need("nestedSectionId")),
      `list_sections still carries the ungrouped section: ${show(ids)}`
    );
  });

  await step("S9 list_components narrows to one section", async () => {
    const made = await okRecord("create_component", {
      name: `${PREFIX}section/part`,
      parentId: need("wrapSectionId"),
      x: 240,
      y: 20,
      width: 40,
      height: 40,
      fillHex: "#88AA55",
    });
    ctx.sectionComponentId = readString(made.id, "create_component.id");

    const listed = await okRecord("list_components", { sectionId: need("wrapSectionId") });
    const items = readRecords(listed.items, "list_components.items");
    const part = itemById(items, need("sectionComponentId"), "the section listing");
    check(
      part.sectionId === need("wrapSectionId"),
      `the component reports sectionId ${show(part.sectionId)}`
    );
    check(
      part.sectionName === `${PREFIX}section/wrap`,
      `the component reports sectionName ${show(part.sectionName)}`
    );

    // sectionId searches the subtree of the section rather than a page, so the
    // components sitting outside it are gone from the listing.
    const ids = items.map((item) => String(item.id));
    check(
      !ids.includes(need("setId")),
      `the section listing carries the set, which sits outside it: ${show(ids)}`
    );
    check(
      !ids.includes(need("iconId")),
      `the section listing carries the icon, which sits outside it: ${show(ids)}`
    );

    // A component in no section reports null rather than nothing, so one
    // listing tells the two cases apart.
    const page = await okRecord("list_components", { scope: "currentPage", query: PREFIX });
    const icon = itemById(
      readRecords(page.items, "list_components.items"),
      need("iconId"),
      "the page listing"
    );
    check(icon.sectionId === null, `the icon reports sectionId ${show(icon.sectionId)}`);
    check(icon.sectionName === null, `the icon reports sectionName ${show(icon.sectionName)}`);
  });

  await step("S10 duplicate_nodes copies a nested section into its own parent", async () => {
    const inner = { x: 240, y: 120, width: 120, height: 100 };
    const made = await okRecord("create_section", {
      name: `${PREFIX}section/inner`,
      parentId: need("wrapSectionId"),
      fillHex: "#F0E0D0",
      ...inner,
    });
    ctx.innerSectionId = readString(made.id, "create_section.id");

    const data = await okRecord("duplicate_nodes", { nodeIds: [need("innerSectionId")] });
    const duplicates = readRecords(data.duplicates, "duplicate_nodes.duplicates");
    check(duplicates.length === 1, `duplicate_nodes made ${duplicates.length} copies, expected 1`);
    const copyId = readString(duplicates[0].nodeId, "duplicate_nodes.duplicates[0].nodeId");
    check(
      duplicates[0].parentId === need("wrapSectionId"),
      `the copy landed in ${show(duplicates[0].parentId)}: Figma clone() parents a copy to the open page, so the tool has to put it back beside its source`
    );

    const copy = await okRecord("get_section", { nodeId: copyId });
    check(
      copy.parentId === need("wrapSectionId"),
      `get_section reports the parent of the copy as ${show(copy.parentId)}`
    );
    check(
      copy.parentType === "SECTION",
      `get_section reports the parent type of the copy as ${show(copy.parentType)}`
    );
    atPosition(readNumber(copy.x, "the x of the copy"), inner.x, "the copy, in x");
    atPosition(readNumber(copy.y, "the y of the copy"), inner.y, "the copy, in y");

    const listed = await okRecord("list_sections", { query: PREFIX });
    const items = readRecords(listed.items, "list_sections.items");
    const nested = itemById(items, copyId, "list_sections");
    check(nested.depth === 1, `the copy reports depth ${show(nested.depth)}, expected 1`);
    check(
      nested.parentSectionId === need("wrapSectionId"),
      `the copy reports parentSectionId ${show(nested.parentSectionId)}`
    );
  });
};

// ---------------------------------------------------------------------------
// T2.8 Negative tests
// ---------------------------------------------------------------------------

/** One incorrect input per area. Each must come back naming the cause. */
const runNegativeSteps = async (): Promise<void> => {
  await step("H1 create_variables refuses a COLOR value that is not a hex", async () => {
    await rejects(
      "create_variables",
      {
        collectionId: need("collectionId"),
        variables: [{ name: `${PREFIX}bad/color`, type: "COLOR", value: "not-a-color" }],
      },
      ["wrote nothing", "items[0]", "is not a hex color"]
    );
  });

  await step("H2 create_variables refuses a scope the type cannot take", async () => {
    await rejects(
      "create_variables",
      {
        collectionId: need("collectionId"),
        variables: [{ name: `${PREFIX}bad/scope`, type: "FLOAT", value: 1, scopes: ["TEXT_FILL"] }],
      },
      ["items[0]", "cannot apply to a FLOAT variable"]
    );
  });

  await step("H3 bind_variables refuses a variable of the wrong type", async () => {
    await rejects(
      "bind_variables",
      {
        bindings: [
          {
            nodeId: need("boundTextId"),
            field: "fontSize",
            variableId: variableId("mcp-e2e/color/brand"),
          },
        ],
      },
      ["items[0]", "is a COLOR variable", 'field "fontSize" takes a FLOAT variable']
    );
  });

  await step("H4 delete_variable_collection refuses to run without confirm", async () => {
    await rejects(
      "delete_variable_collection",
      { collectionId: need("collectionId"), confirm: false },
      ["requires confirm: true"]
    );
  });

  await step("H5 create_text_style refuses a font Figma does not have", async () => {
    await rejects(
      "create_text_style",
      {
        name: `${PREFIX}bad/font`,
        fontFamily: "Nonexistent Grotesk",
        fontStyle: "Regular",
        fontSize: 12,
      },
      ["is not available in Figma", "list_fonts"]
    );
  });

  await step("H6 apply_text_style refuses a node that is not text", async () => {
    await rejects("apply_text_style", { nodeIds: [need("rootId")], styleId: need("styleId") }, [
      "items[0]",
      "not a TEXT node",
    ]);
  });

  await step("H7 create_instance refuses a variant value the set does not have", async () => {
    await rejects(
      "create_instance",
      {
        componentId: need("setId"),
        variantProperties: { Size: "Medium", State: "Default" },
        parentId: need("rootId"),
      },
      ["Medium", "Small", "Large"]
    );
  });

  await step("H8 combine_as_variants refuses a node that is not a component", async () => {
    await rejects("combine_as_variants", { componentIds: [need("rootId"), need("iconId")] }, [
      "wrote nothing",
      "items[0]",
      "not a COMPONENT",
    ]);
  });

  await step("H9 add_component_property refuses a variant as the owner", async () => {
    await rejects(
      "add_component_property",
      {
        componentId: need("smallComponentId"),
        name: "Nope",
        type: "TEXT",
        defaultValue: "x",
      },
      ["a variant owns no properties of its own", need("setId")]
    );
  });

  await step("H10 create_section refuses a frame as parentId", async () => {
    await rejects(
      "create_section",
      { name: `${PREFIX}section/refused`, width: 100, height: 100, parentId: need("rootId") },
      ["requires parentId to name a page or a SECTION", "is a FRAME node"]
    );
  });

  await step("H11 reparent_nodes refuses a section bound for a frame", async () => {
    await rejects(
      "reparent_nodes",
      { nodeIds: [need("wrapSectionId")], parentId: need("rootId") },
      ["moved nothing", "nodeIds[0]", "is a SECTION"]
    );
  });

  await step("H12 group_nodes refuses a section", async () => {
    await rejects("group_nodes", { nodeIds: [need("wrapSectionId")] }, [
      "a group cannot contain a SECTION",
      "create_section with nodeIds",
    ]);
  });

  await step("H13 move_out_of_section refuses a node hanging off the page", async () => {
    await rejects("move_out_of_section", { nodeIds: [need("rootId")] }, [
      "wrote nothing",
      "items[0]",
      "not off a section",
    ]);
  });
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// J Dumps
// ---------------------------------------------------------------------------

/**
 * The fields a dump adds to the read form of a node. J4 removes them before
 * it compares a dump with get_node. `boundVariables` is removed only inside a
 * paint: the node-level field is in both.
 */
const DUMP_ONLY_FIELDS = [
  "mainComponentId",
  "componentSetId",
  "detachedInfo",
  "reactions",
  "flowStartingPoints",
  "styledTextSegments",
];

/**
 * A copy of a value with the keys of each object in sorted order, so two
 * trees compare as JSON text whatever order their keys came in.
 * @param value - The value.
 * @returns The copy.
 */
const sortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== "object" || value === null) return value;
  const copy: Json = {};
  for (const key of Object.keys(value).sort()) copy[key] = sortedKeys((value as Json)[key]);
  return copy;
};

/**
 * The read form of a dumped node: the dump-only fields removed, at each level.
 * @param value - A dumped node, or a part of one.
 * @returns The copy.
 */
const readFormOf = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(readFormOf);
  if (typeof value !== "object" || value === null) return value;
  const copy: Json = {};
  for (const [key, field] of Object.entries(value as Json)) {
    if (DUMP_ONLY_FIELDS.includes(key)) continue;
    copy[key] = readFormOf(field);
  }
  const styles = copy.styles as Json | undefined;
  for (const paints of ["fills", "strokes"]) {
    const list = styles?.[paints];
    if (!Array.isArray(list)) continue;
    styles![paints] = list.map((paint) => {
      const { boundVariables: _bound, ...rest } = paint as Json;
      return rest;
    });
  }
  return copy;
};

/**
 * The first place where two JSON values differ, for a failure message.
 * @param a - The first value.
 * @param b - The second value.
 * @param at - The path so far.
 * @returns The path and the two values, or null when they are equal.
 */
const firstDifference = (a: unknown, b: unknown, at = "$"): string | null => {
  if (JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b))) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return `${at}: ${show(a)} against ${show(b)}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of [...keys].sort()) {
    const found = firstDifference((a as Json)[key], (b as Json)[key], `${at}.${key}`);
    if (found !== null) return found;
  }
  return `${at}: ${show(a)} against ${show(b)}`;
};

/**
 * Reads the file of one manifest entry, and checks its size and its SHA-256.
 * @param manifest - The dump_nodes result.
 * @param nodeId - The root of the file.
 * @param root - The output root of the server that wrote it.
 * @returns The file entry and the bytes on disk.
 */
const readDumpFile = async (
  manifest: Json,
  nodeId: string,
  root = OUTPUT_DIR
): Promise<{ entry: Json; bytes: Buffer }> => {
  const files = readRecords(manifest.files, "dump_nodes.files");
  const entry = files.find((file) => file.kind === "nodes" && file.nodeId === nodeId);
  check(entry !== undefined, `the manifest has no nodes file for ${nodeId}: ${show(files)}`);
  const path = readString((entry as Json).path, "the manifest path");
  const bytes = await readFile(join(root, path));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  check(
    (entry as Json).sha256 === sha256,
    `${path} hashes to ${sha256}, but the manifest says ${show((entry as Json).sha256)}`
  );
  check(
    (entry as Json).bytes === bytes.byteLength,
    `${path} holds ${bytes.byteLength} bytes, but the manifest says ${show((entry as Json).bytes)}`
  );
  return { entry: entry as Json, bytes };
};

/**
 * Dumps the test root, the set, a hidden layer, and the visible content, and
 * compares each with the read tools. Every file lands in one folder of this
 * run under the output root, which the group removes again.
 */
const runDumpSteps = async (): Promise<void> => {
  const runFolder = `mcp-e2e-dumps-${Date.now()}`;
  const runPath = join(OUTPUT_DIR, runFolder);
  check(!existsSync(runPath), `${runPath} exists already; remove it, then run again`);
  const dump = (args: Json): Promise<Json> => okRecord("dump_nodes", args);

  try {
    await step("J1 two dumps of the root are byte-identical", async () => {
      const contents: Buffer[] = [];
      for (const name of ["j1-a", "j1-b"]) {
        const manifest = await dump({
          nodeIds: [need("rootId")],
          outputPath: `${runFolder}/${name}`,
        });
        check(
          manifest.fileKey === fileKey,
          `the manifest names the file ${show(manifest.fileKey)}, not ${fileKey}`
        );
        const { entry, bytes } = await readDumpFile(manifest, need("rootId"));
        check(
          readNumber(entry.nodeCount, "nodeCount") > 1,
          `the root dump holds ${show(entry.nodeCount)} nodes`
        );
        contents.push(bytes);
      }
      check(
        contents[0].equals(contents[1]),
        `the two dumps differ: ${contents[0].byteLength} and ${contents[1].byteLength} bytes`
      );
      console.log(`      ${contents[0].byteLength} bytes, identical`);
    });

    await step("J2 the variantCount of the set equals list_components", async () => {
      const manifest = await dump({ nodeIds: [need("setId")], outputPath: `${runFolder}/j2` });
      const { entry } = await readDumpFile(manifest, need("setId"));
      const listed = await okRecord("list_components", { scope: "currentPage", query: PREFIX });
      const set = readRecords(listed.items, "list_components.items").find(
        (item) => item.id === need("setId")
      );
      check(set !== undefined, `list_components does not list the set ${need("setId")}`);
      check(
        entry.variantCount === (set as Json).variantCount,
        `the dump counts ${show(entry.variantCount)} variants, list_components ${show((set as Json).variantCount)}`
      );
    });

    await step("J3 a hidden child is in the dump and not in get_node", async () => {
      const before = await okRecord("get_node", { nodeId: need("rootId") });
      const children = readRecords(before.children, "the root's children");
      const child = children.find((candidate) => candidate.id !== need("setId"));
      check(child !== undefined, "the root has no child besides the set to hide");
      const childId = readString((child as Json).id, "the child's id");

      await ok("set_node_visibility", { items: [{ nodeId: childId, visible: false }] });
      try {
        const manifest = await dump({ nodeIds: [need("rootId")], outputPath: `${runFolder}/j3` });
        const { entry, bytes } = await readDumpFile(manifest, need("rootId"));
        const tree = readRecord(JSON.parse(bytes.toString("utf8")), "the dump");
        const dumped = readRecords(tree.children, "the dumped children").find(
          (candidate) => candidate.id === childId
        );
        check(dumped !== undefined, `the dump does not hold the hidden child ${childId}`);
        const styles = readRecord((dumped as Json).styles, "the hidden child's styles");
        check(styles.visible === false, `the hidden child has visible ${show(styles.visible)}`);
        check(
          readNumber(entry.hiddenCount, "hiddenCount") >= 1,
          `the manifest counts ${show(entry.hiddenCount)} hidden nodes`
        );

        const read = await okRecord("get_node", { nodeId: need("rootId") });
        const ids = readRecords(read.children, "the root's children").map((item) => item.id);
        check(!ids.includes(childId), `get_node still lists the hidden child ${childId}`);
      } finally {
        await ok("set_node_visibility", { items: [{ nodeId: childId, visible: true }] });
      }
    });

    await step("J4 a dump without hidden content equals get_node", async () => {
      const manifest = await dump({
        nodeIds: [need("rootId")],
        includeHidden: false,
        outputPath: `${runFolder}/j4`,
      });
      check(manifest.includeHidden === false, `the manifest says ${show(manifest.includeHidden)}`);
      const { bytes } = await readDumpFile(manifest, need("rootId"));
      const read = await okRecord("get_node", { nodeId: need("rootId") });
      check(read.truncated === undefined, "get_node cut the root, so it cannot be compared");
      const difference = firstDifference(readFormOf(JSON.parse(bytes.toString("utf8"))), read);
      check(difference === null, `the dump and get_node differ at ${difference}`);
    });
  } finally {
    // Only the folder of this run, which the run made.
    await rm(runPath, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// K Auditor role
// ---------------------------------------------------------------------------

/** The 15 tools of the auditor role (BR-3), written out here and not imported. */
const AUDITOR_TOOL_NAMES = [
  "dump_nodes",
  "get_component",
  "get_document",
  "get_instance",
  "get_metadata",
  "get_node",
  "get_section",
  "get_styles",
  "get_variable_defs",
  "list_components",
  "list_files",
  "list_fonts",
  "list_sections",
  "save_screenshots",
  "scroll_and_zoom_into_view",
];

/** The port the leader listens on: the one the spawned servers use. */
const leaderPort = (): number => {
  const raw = process.env.FIGMA_BRIDGE_PORT;
  return raw === undefined ? 1995 : Number(raw.trim());
};

/**
 * Starts a second server process with the auditor role and its own output
 * root, and checks its tool list, its files, and the refusal of the leader for
 * a marked write. The process and its output root go away at the end, also
 * after a failure.
 */
const runAuditorSteps = async (): Promise<void> => {
  const auditorRoot = join(OUTPUT_DIR, `mcp-e2e-auditor-${Date.now()}`);
  check(!existsSync(auditorRoot), `${auditorRoot} exists already; remove it, then run again`);
  await mkdir(auditorRoot, { recursive: true });

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.FIGMA_BRIDGE_OUTPUT_ROOT = auditorRoot;
  env.FIGMA_BRIDGE_ROLE = "auditor";

  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRY],
    cwd: SERVER_ROOT,
    env,
    stderr: "pipe",
  });
  const auditorLog: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line !== "") auditorLog.push(line);
  });
  const auditor = new Client(
    { name: "figma-bridge-e2e-auditor", version: "1.0.0" },
    { capabilities: {} }
  );

  const callAuditor = async (name: string, args: Json): Promise<unknown> => {
    const result = await auditor.callTool({ name, arguments: { fileKey, ...args } }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    });
    const parts = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = parts.map((part) => part.text ?? "").join("\n");
    check(result.isError !== true, `${name} through the auditor process failed: ${text}`);
    return JSON.parse(text) as unknown;
  };

  try {
    const started = await step("K1 the auditor process lists exactly the 15 tools", async () => {
      try {
        await auditor.connect(transport);
      } catch (err) {
        throw new AssertionError(
          `the auditor process did not start: ${err instanceof Error ? err.message : String(err)}\n${auditorLog.join("\n")}`
        );
      }
      const names = (await auditor.listTools()).tools.map((tool) => tool.name).sort();
      check(
        names.length === AUDITOR_TOOL_NAMES.length && names.join() === AUDITOR_TOOL_NAMES.join(),
        `the auditor process lists ${names.length} tools: ${names.join(", ")}`
      );
    });
    if (!started) return;

    await step("K2 dump_nodes and save_screenshots write under the auditor root", async () => {
      const manifest = readRecord(
        await callAuditor("dump_nodes", { nodeIds: [need("rootId")], outputPath: "dump" }),
        "dump_nodes result"
      );
      const entry = readRecords(manifest.files, "dump_nodes.files").find(
        (file) => file.kind === "nodes" && file.nodeId === need("rootId")
      );
      check(entry !== undefined, `the manifest has no nodes file for ${need("rootId")}`);
      const dumped = join(auditorRoot, readString((entry as Json).path, "the manifest path"));
      check(existsSync(dumped), `${dumped} does not exist`);

      const saved = readRecord(
        await callAuditor("save_screenshots", {
          items: [{ nodeId: need("rootId"), outputPath: "shot.png" }],
          scale: 1,
        }),
        "save_screenshots result"
      );
      check(saved.succeeded === 1, `save_screenshots reports ${show(saved)}`);
      const shot = join(auditorRoot, "shot.png");
      check(existsSync(shot), `${shot} does not exist`);
      const savedPath = readString(readRecords(saved.files, "files")[0].path, "the capture path");
      check(savedPath === "shot.png", `the manifest names the capture ${savedPath}`);
    });

    await step("K3 the leader refuses a marked delete_nodes", async () => {
      const target = readString(
        (
          await okRecord("create_frame", {
            name: `${PREFIX}k3-target`,
            parentId: need("rootId"),
            x: 0,
            y: 0,
            width: 20,
            height: 20,
          })
        ).nodeId,
        "create_frame.nodeId"
      );
      // The token is read from the file as a server process reads it, and is never printed.
      const { rpcToken } = await import("../src/rpc-token.js");
      const response = await fetch(`http://127.0.0.1:${leaderPort()}/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${rpcToken()}`,
          "X-Figma-Bridge-Role": "auditor",
        },
        body: JSON.stringify({
          tool: "delete_nodes",
          nodeIds: [target],
          params: { confirm: true },
          fileKey,
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      check(response.status === 403, `the leader answered ${response.status}, expected 403`);
      const read = await okRecord("get_node", { nodeId: target });
      check(read.id === target, `get_node no longer finds ${target}`);
    });
  } finally {
    await auditor.close().catch(() => undefined);
    await rm(auditorRoot, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// L Capture manifest
// ---------------------------------------------------------------------------

/** Captures the test root as a PNG and checks the manifest against the file. */
const runCaptureSteps = async (): Promise<void> => {
  await step("L1 save_screenshots returns a manifest that matches the file", async () => {
    const folder = `mcp-e2e-captures-${Date.now()}`;
    const name = `${folder}/root.png`;
    const dir = join(OUTPUT_DIR, folder);
    check(!existsSync(dir), `${dir} exists already; remove it, then run again`);
    try {
      const raw = await callRaw("save_screenshots", {
        items: [{ nodeId: need("rootId"), outputPath: name }],
        format: "PNG",
        scale: 1,
      });
      check(!raw.isError, `save_screenshots failed: ${show(raw.content)}`);
      check(
        raw.content.length === 1 && raw.content[0].type === "text",
        `save_screenshots returned the blocks ${raw.content.map((block) => block.type).join(",")}, expected one text block`
      );
      const manifest = readRecord(JSON.parse(raw.content[0].text ?? ""), "the manifest");
      check(manifest.tool === "save_screenshots", `the manifest is of ${show(manifest.tool)}`);
      check(
        manifest.succeeded === 1 && manifest.failed === 0,
        `the manifest reports ${show(manifest)}`
      );

      const entry = readRecords(manifest.files, "the manifest files")[0];
      check(entry.ok === true && entry.kind === "capture", `the entry is ${show(entry)}`);
      check(entry.path === name, `the entry path is ${show(entry.path)}, expected ${name}`);
      check(entry.scale === 1, `the entry scale is ${show(entry.scale)}, expected 1`);

      const file = join(OUTPUT_DIR, name);
      check(existsSync(file), `${file} does not exist`);
      const bytes = await readFile(file);
      check(entry.bytes === bytes.byteLength, `the entry says ${show(entry.bytes)} bytes`);
      const digest = createHash("sha256").update(bytes).digest("hex");
      check(entry.sha256 === digest, `the entry sha256 ${show(entry.sha256)} is not ${digest}`);
      const header = readPngHeader(bytes);
      check(
        entry.pixelWidth === header.width && entry.pixelHeight === header.height,
        `the entry says ${show(entry.pixelWidth)} x ${show(entry.pixelHeight)}, the header ${header.width} x ${header.height}`
      );

      const manifestPath = readString(manifest.manifestPath, "manifestPath");
      check(
        manifestPath.startsWith(`${folder}/save_screenshots-`) &&
          manifestPath.endsWith(".manifest.json"),
        `manifestPath ${manifestPath} is not beside the capture`
      );
      const onDisk = JSON.parse(await readFile(join(OUTPUT_DIR, manifestPath), "utf8")) as unknown;
      check(
        JSON.stringify(onDisk) === JSON.stringify(manifest),
        "the manifest file differs from the manifest the call returned"
      );
      console.log(`      ${name}: ${bytes.byteLength} bytes, ${header.width} x ${header.height}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
};

// ---------------------------------------------------------------------------
// V Dump conformance
// ---------------------------------------------------------------------------

/** Each node, style, and flow of the conformance fixture starts with this name. */
const CONFORMANCE = `${PREFIX}conformance/`;

/** The committed, normalised dump of the fixture. */
const GOLDEN_PATH = join(SCRIPT_DIR, "golden", "dump-conformance.json");

/** `E2E_UPDATE_GOLDEN=1` writes the golden dump in place of the compare. */
const UPDATE_GOLDEN = process.env.E2E_UPDATE_GOLDEN === "1";

/** The name of the flow starting point that V1 gives the page. */
const FLOW_NAME = "mcp-e2e flow";

/** The left edge of the fixture on the page, clear of the other groups. */
const FIXTURE_X = 4000;

/** The text of the mixed-style node, and its two styled ranges. */
const MIXED_TEXT = "Body text with one red word";
const STYLED_RANGE = { start: 0, end: 4 };
const RED_RANGE = { start: 19, end: 22 };

/** The IDs of the fixture, which group V threads through its steps. */
type Fixture = {
  styleId: string;
  defaultId: string;
  hoverId: string;
  setId: string;
  screenId: string;
  targetId: string;
  instanceId: string;
  detachedId: string;
  paintsId: string;
  textId: string;
  areaId: string;
};

const fixture: Partial<Fixture> = {};

/**
 * Reads an ID of the fixture.
 * @param key - The fixture key.
 * @returns The ID.
 */
const part = (key: keyof Fixture): string => {
  const value = fixture[key];
  check(value !== undefined, `this step needs ${key} from V1, which did not produce it`);
  return value as string;
};

/**
 * Sends one operation of the test helper `e2e_fixture` to the leader.
 *
 * No MCP tool has this name, so the script sends a raw `/rpc` request with the
 * install token, which it reads from the file as a server process reads it.
 * The token is never printed.
 * @param op - The operation.
 * @param params - Its params.
 * @returns The data of the answer.
 */
const fixtureOp = async (op: string, params: Json = {}): Promise<Json> => {
  const { rpcToken } = await import("../src/rpc-token.js");
  const response = await fetch(`http://127.0.0.1:${leaderPort()}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rpcToken()}` },
    body: JSON.stringify({ tool: "e2e_fixture", params: { op, ...params }, fileKey }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const body = (await response.json()) as { data?: unknown; error?: string };
  check(
    response.status === 200 && body.error === undefined,
    `e2e_fixture ${op} failed (HTTP ${response.status}): ${body.error ?? show(body)}`
  );
  return readRecord(body.data, `e2e_fixture ${op} result`);
};

/**
 * Creates one node with a tool and reads the ID it returns.
 * @param tool - The tool.
 * @param args - Its arguments.
 * @param field - The field of the result that holds the ID.
 * @returns The ID.
 */
const created = async (tool: string, args: Json, field = "nodeId"): Promise<string> =>
  readString((await okRecord(tool, args))[field], `${tool}.${field}`);

/**
 * Builds one variant: an empty component with a label and an icon frame.
 * @param state - The value of the State property.
 * @param x - The position on the page.
 * @param fillHex - The fill of the variant.
 * @returns The component ID.
 */
const buildVariant = async (state: string, x: number, fillHex: string): Promise<string> => {
  const id = await created(
    "create_component",
    {
      name: `State=${state}`,
      parentId: need("pageId"),
      x,
      y: 0,
      width: 160,
      height: 48,
      fillHex,
    },
    "id"
  );
  await created("create_text", {
    name: `${CONFORMANCE}label`,
    parentId: id,
    characters: state,
    fontFamily: "Inter",
    fontStyle: "Regular",
    fontSize: 14,
    fillHex: "#11151C",
    textAutoResize: "NONE",
    width: 80,
    height: 20,
    x: 16,
    y: 14,
  });
  await created("create_frame", {
    name: `${CONFORMANCE}icon`,
    parentId: id,
    x: 120,
    y: 12,
    width: 24,
    height: 24,
    fillHex: "#FF7755",
  });
  return id;
};

/**
 * Builds the conformance fixture on the test page. Each part has a fixed name,
 * position, and size, so two runs give the same dump but for the IDs.
 * @param saved - Receives the values that the cleanup sets back.
 */
const buildFixture = async (saved: { flow?: Json[]; skip?: boolean }): Promise<void> => {
  const skip = await fixtureOp("getSkipInvisibleInstanceChildren");
  check(typeof skip.value === "boolean", `the flag reads as ${show(skip.value)}`);
  saved.skip = skip.value as boolean;

  fixture.styleId = await created(
    "create_text_style",
    { name: `${CONFORMANCE}Body`, fontFamily: "Inter", fontStyle: "Bold", fontSize: 16 },
    "id"
  );

  // The component set: two variants, and a hidden badge in the Default one,
  // which the instance of Default carries as a hidden instance child.
  fixture.defaultId = await buildVariant("Default", FIXTURE_X, "#E8ECF4");
  const badge = await created("create_frame", {
    name: `${CONFORMANCE}badge`,
    parentId: fixture.defaultId,
    x: 140,
    y: 4,
    width: 12,
    height: 12,
    fillHex: "#D92D20",
  });
  await ok("set_node_visibility", { items: [{ nodeId: badge, visible: false }] });
  fixture.hoverId = await buildVariant("Hover", FIXTURE_X + 200, "#D0D7E6");
  fixture.setId = await created(
    "combine_as_variants",
    {
      componentIds: [fixture.defaultId, fixture.hoverId],
      name: `${CONFORMANCE}Button`,
      parentId: need("pageId"),
      layout: "ROW",
      gap: 24,
      padding: 24,
    },
    "id"
  );
  await ok("set_node_properties", { nodeId: fixture.setId, x: FIXTURE_X, y: 0 });

  fixture.screenId = await created("create_frame", {
    name: `${CONFORMANCE}Screen`,
    parentId: need("pageId"),
    x: FIXTURE_X,
    y: 200,
    width: 800,
    height: 400,
    fillHex: "#FFFFFF",
  });
  fixture.targetId = await created("create_frame", {
    name: `${CONFORMANCE}Target`,
    parentId: need("pageId"),
    x: FIXTURE_X + 900,
    y: 200,
    width: 400,
    height: 400,
    fillHex: "#F4F6FA",
  });

  fixture.instanceId = await created(
    "create_instance",
    {
      componentId: fixture.setId,
      variantProperties: { State: "Default" },
      parentId: fixture.screenId,
      x: 40,
      y: 40,
    },
    "id"
  );
  await ok("set_node_properties", {
    nodeId: fixture.instanceId,
    name: `${CONFORMANCE}Default instance`,
  });

  const hover = await created(
    "create_instance",
    {
      componentId: fixture.setId,
      variantProperties: { State: "Hover" },
      parentId: fixture.screenId,
      x: 240,
      y: 40,
    },
    "id"
  );
  await ok("set_node_properties", { nodeId: hover, name: `${CONFORMANCE}Hover detached` });
  const detached = allWritten(
    await ok("detach_instance", { nodeIds: [hover] }),
    "detach_instance",
    1
  );
  fixture.detachedId = readString(detached[0].frameId, "detach_instance results[0].frameId");

  // Two fills, the first one hidden, and a hidden drop shadow.
  fixture.paintsId = await created("create_shape", {
    shapeType: "RECTANGLE",
    name: `${CONFORMANCE}Paints`,
    parentId: fixture.screenId,
    x: 440,
    y: 40,
    width: 120,
    height: 80,
    fillHex: "#FF0000",
  });
  await fixtureOp("addPaint", { nodeId: fixture.paintsId, target: "fills", hex: "#00AA55" });
  await fixtureOp("hidePaint", { nodeId: fixture.paintsId, target: "fills", index: 0 });
  await ok("set_effects", {
    nodeId: fixture.paintsId,
    effects: [
      {
        type: "DROP_SHADOW",
        color: "#000000",
        opacity: 0.25,
        offset: { x: 0, y: 4 },
        radius: 8,
        visible: false,
      },
    ],
  });

  // Mixed styles: a text style on one range, another fill on a second range.
  fixture.textId = await created("create_text", {
    name: `${CONFORMANCE}Mixed text`,
    parentId: fixture.screenId,
    characters: MIXED_TEXT,
    fontFamily: "Inter",
    fontStyle: "Regular",
    fontSize: 16,
    fillHex: "#11151C",
    textAutoResize: "NONE",
    width: 320,
    height: 48,
    x: 40,
    y: 160,
  });
  allWritten(
    await ok("apply_text_style", {
      nodeIds: [fixture.textId],
      styleId: fixture.styleId,
      range: STYLED_RANGE,
    }),
    "apply_text_style",
    1
  );
  await fixtureOp("setRangeFill", { nodeId: fixture.textId, ...RED_RANGE, hex: "#D92D20" });

  // A reaction: on click, navigate to Target.
  fixture.areaId = await created("create_frame", {
    name: `${CONFORMANCE}Button area`,
    parentId: fixture.screenId,
    x: 40,
    y: 260,
    width: 160,
    height: 48,
    fillHex: "#3355FF",
  });
  await fixtureOp("setReactions", {
    nodeId: fixture.areaId,
    reactions: [
      {
        trigger: { type: "ON_CLICK" },
        actions: [
          {
            type: "NODE",
            destinationId: fixture.targetId,
            navigation: "NAVIGATE",
            transition: null,
          },
        ],
      },
    ],
  });

  const flow = await fixtureOp("setFlowStartingPoints", {
    pageId: need("pageId"),
    points: [{ nodeId: fixture.screenId, name: FLOW_NAME }],
  });
  saved.flow = readRecords(flow.previous, "the flow starting points before the run");
  const points = readRecords(flow.points, "the flow starting points");
  check(
    points.length === 1 && points[0].nodeId === fixture.screenId,
    `the page has the flow starting points ${show(points)}`
  );
};

/**
 * Finds the nodes of a tree that pass a test, in pre-order.
 * @param node - The root.
 * @param test - The test.
 * @returns The nodes.
 */
const findNodes = (node: unknown, test: (candidate: Json) => boolean): Json[] => {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return [];
  const found = test(node as Json) ? [node as Json] : [];
  const children = (node as Json).children;
  for (const child of Array.isArray(children) ? children : []) {
    found.push(...findNodes(child, test));
  }
  return found;
};

/**
 * Lists each part of the specification that the normalised dumps do not show,
 * so neither a compare nor a write of the golden dump passes without them.
 * @param golden - The normalised dumps.
 * @returns One line for each missing part.
 */
const missingParts = (golden: Record<GoldenRoot, unknown>): string[] => {
  const missing: string[] = [];
  const named = (root: unknown, name: string): Json | undefined =>
    findNodes(root, (node) => node.name === `${CONFORMANCE}${name}`)[0];
  const placeholder = (value: unknown): boolean =>
    typeof value === "string" && /^N\d+$/.test(value);
  const hidden = (node: Json | undefined): boolean =>
    (node?.styles as Json | undefined)?.visible === false;

  if (!hidden(named(golden["button-set"], "badge"))) {
    missing.push("the badge of the set with styles.visible false");
  }
  const instance = named(golden.screen, "Default instance");
  if (!hidden(findNodes(instance, (node) => node.name === `${CONFORMANCE}badge`)[0])) {
    missing.push("the badge of the instance with styles.visible false");
  }
  if (!placeholder(instance?.mainComponentId) || !placeholder(instance?.componentSetId)) {
    missing.push("mainComponentId and componentSetId of the instance as placeholders");
  }

  const styles = (named(golden.screen, "Paints")?.styles ?? {}) as Json;
  const hiddenEntry = (list: unknown): boolean =>
    Array.isArray(list) && list.some((entry) => (entry as Json).visible === false);
  if (!hiddenEntry(styles.fills)) missing.push("the hidden fill with visible false");
  if (!hiddenEntry(styles.effects)) missing.push("the hidden drop shadow with visible false");

  const detachedInfo = named(golden.screen, "Hover detached")?.detachedInfo as Json | undefined;
  if (!placeholder(detachedInfo?.componentId)) {
    missing.push(`detachedInfo of the detached frame (found ${show(detachedInfo ?? null)})`);
  }

  const targetId = (golden.target as Json).id;
  const reactions = named(golden.screen, "Button area")?.reactions;
  const destinations: string[] =
    JSON.stringify(reactions ?? []).match(/"destinationId":"[^"]*"/g) ?? [];
  if (!placeholder(targetId) || !destinations.includes(`"destinationId":"${String(targetId)}"`)) {
    missing.push("the reaction with Target as its destination placeholder");
  }

  const segments = named(golden.screen, "Mixed text")?.styledTextSegments;
  if (!Array.isArray(segments) || segments.length < 2) {
    missing.push("styledTextSegments on the mixed text");
  }
  return missing;
};

/**
 * The root IDs of the fixture, by golden root.
 * @returns Each golden root to its node ID.
 */
const fixtureRoots = (): Record<GoldenRoot, string> => ({
  "button-set": part("setId"),
  screen: part("screenId"),
  target: part("targetId"),
});

/** A server process that serves dump_nodes: the one of the script, or a second one. */
type DumpServer = {
  /** Calls a tool that must succeed, with the file key of the run. */
  call: (name: string, args: Json) => Promise<Json>;
  /** The output root of the process. */
  root: string;
};

/** The server process of the script. */
const MAIN_SERVER: DumpServer = { call: okRecord, root: OUTPUT_DIR };

/** What the result line of group V reports. */
const conformance = {
  /** True once the scenario started, so a run that stops early still prints the line. */
  started: false,
  /** The instrument identity of the first manifest of the run. */
  bridgeCommit: undefined as string | undefined,
  pluginBuild: undefined as string | undefined,
};

/**
 * Dumps the three roots of the fixture into one folder.
 * @param folder - The folder under the output root.
 * @param server - The server process that serves the call.
 * @returns The manifest, and the bytes of each file and its parsed tree, by golden root.
 */
const dumpFixture = async (
  folder: string,
  server: DumpServer = MAIN_SERVER
): Promise<{
  manifest: Json;
  bytes: Record<GoldenRoot, Buffer>;
  trees: Record<GoldenRoot, unknown>;
}> => {
  const roots = fixtureRoots();
  const manifest = await server.call("dump_nodes", {
    nodeIds: GOLDEN_ROOTS.map((root) => roots[root]),
    outputPath: folder,
  });
  check(
    manifest.includeHidden === true,
    `the manifest says includeHidden ${show(manifest.includeHidden)}`
  );
  const bytes = {} as Record<GoldenRoot, Buffer>;
  const trees = {} as Record<GoldenRoot, unknown>;
  for (const root of GOLDEN_ROOTS) {
    bytes[root] = (await readDumpFile(manifest, roots[root], server.root)).bytes;
    trees[root] = JSON.parse(bytes[root].toString("utf8")) as unknown;
  }
  conformance.bridgeCommit ??= String(manifest.bridgeCommit);
  conformance.pluginBuild ??= String(manifest.pluginBuild);
  console.log(
    `      bridge ${String(manifest.bridgeCommit)}, plugin build ${String(manifest.pluginBuild)}`
  );
  return { manifest, bytes, trees };
};

/**
 * Dumps one root of the fixture through the server process of the script.
 * @param nodeId - The root.
 * @param folder - The folder under the output root.
 * @returns The bytes of the file and its parsed tree.
 */
const dumpOne = async (nodeId: string, folder: string): Promise<{ bytes: Buffer; tree: Json }> => {
  const manifest = await okRecord("dump_nodes", { nodeIds: [nodeId], outputPath: folder });
  const { bytes } = await readDumpFile(manifest, nodeId);
  return { bytes, tree: readRecord(JSON.parse(bytes.toString("utf8")), `the dump of ${nodeId}`) };
};

/**
 * Starts a second server process of this checkout, with its own output root.
 * It joins the running bridge as a follower, as the server of the script does.
 * @param name - The client name.
 * @param root - Its output root, which this function makes.
 * @param extra - The variables it gets on top of the environment of the script.
 * @returns The process as a dump server, and its close.
 */
const startSecondServer = async (
  name: string,
  root: string,
  extra: Record<string, string>
): Promise<DumpServer & { close: () => Promise<void> }> => {
  await mkdir(root, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, extra, { FIGMA_BRIDGE_OUTPUT_ROOT: root });

  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRY],
    cwd: SERVER_ROOT,
    env,
    stderr: "pipe",
  });
  const log: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line !== "") log.push(line);
  });
  const second = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const close = (): Promise<void> => second.close().catch(() => undefined);
  try {
    await second.connect(transport);
  } catch (err) {
    await close();
    throw new AssertionError(
      `the second server process did not start: ${err instanceof Error ? err.message : String(err)}\n${log.join("\n")}`
    );
  }

  const call = async (tool: string, args: Json): Promise<Json> => {
    const result = await second.callTool(
      { name: tool, arguments: { fileKey, ...args } },
      undefined,
      {
        timeout: CALL_TIMEOUT_MS,
      }
    );
    const parts = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = parts.map((part) => part.text ?? "").join("\n");
    check(result.isError !== true, `${tool} through the second server process failed: ${text}`);
    return readRecord(JSON.parse(text), `${tool} result`);
  };
  return { call, root, close };
};

/**
 * The variants of the component sets in a dumped tree: the components whose
 * parent is a component set, as the manifest counts them.
 * @param tree - The dumped tree.
 * @returns The count of the sets and the count of their variants.
 */
const setsAndVariants = (tree: unknown): { sets: number; variants: number } => {
  const sets = findNodes(tree, (node) => node.type === "COMPONENT_SET");
  const variants = sets
    .map((set) => (Array.isArray(set.children) ? (set.children as Json[]) : []))
    .reduce((sum, children) => sum + children.filter((c) => c.type === "COMPONENT").length, 0);
  return { sets: sets.length, variants };
};

/** The checks of group V that the result line requires, by their number. */
const CONFORMANCE_STEPS = ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8"];

/**
 * Prints the result line of group V, once the scenario started. Each check of
 * `CONFORMANCE_STEPS` must have passed, and each other step of the group that
 * ran too; a check that did not run counts as failed, and so does a run that
 * wrote the golden dump in place of the compare.
 */
const printConformanceLine = (): void => {
  if (!conformance.started) return;
  const ran = outcomes.filter((outcome) => /^V(\d+)? /.test(outcome.name));
  const missing = CONFORMANCE_STEPS.filter(
    (id) => !ran.some((outcome) => outcome.name.startsWith(`${id} `))
  );
  let failed = ran.filter((outcome) => !outcome.ok).length + missing.length;
  if (UPDATE_GOLDEN) {
    console.log("note: E2E_UPDATE_GOLDEN=1 wrote the golden dump, so V2 compared nothing.");
    failed += 1;
  }
  const identity = `bridgeCommit=${conformance.bridgeCommit ?? "unknown"} pluginBuild=${conformance.pluginBuild ?? "unknown"}`;
  console.log("");
  console.log(
    failed === 0 ? `CONFORMANCE PASS ${identity}` : `CONFORMANCE FAIL ${identity} failed=${failed}`
  );
};

/**
 * Builds the conformance fixture, dumps it, and compares the normalised dumps
 * with the golden dump. The dumps land in one folder of this run under the
 * output root, which the group removes again. The `finally` block sets the
 * flow starting points of the page and the flag of the plugin back to their
 * values before the run; the cleanup of the script removes the nodes and the
 * text style through their prefix.
 */
const runConformanceSteps = async (): Promise<void> => {
  const runFolder = `mcp-e2e-conformance-${Date.now()}`;
  const runPath = join(OUTPUT_DIR, runFolder);
  check(!existsSync(runPath), `${runPath} exists already; remove it, then run again`);
  const saved: { flow?: Json[]; skip?: boolean } = {};
  let first: Awaited<ReturnType<typeof dumpFixture>> | undefined;

  try {
    const built = await step("V1 build the conformance fixture", () => buildFixture(saved));
    if (!built) return;

    const golden = UPDATE_GOLDEN
      ? "V2 the normalised dumps are written as the golden dump"
      : "V2 the normalised dumps equal the golden dump";
    await step(golden, async () => {
      first = await dumpFixture(`${runFolder}/v2`);
      const { trees } = first;
      const normalised = normaliseGolden(trees);
      const missing = missingParts(normalised);
      check(missing.length === 0, `the dumps do not show: ${missing.join("; ")}`);

      if (UPDATE_GOLDEN) {
        await mkdir(dirname(GOLDEN_PATH), { recursive: true });
        await writeFile(GOLDEN_PATH, await goldenText(normalised, GOLDEN_PATH), "utf8");
        console.log(`      wrote ${GOLDEN_PATH}`);
        console.log(
          "      WARNING: a change of the golden dump is a change of the serializer. Commit it alone, and send it to the auditor process for review."
        );
        return;
      }

      check(
        existsSync(GOLDEN_PATH),
        `${GOLDEN_PATH} does not exist. Make it with E2E_UPDATE_GOLDEN=1 bun run e2e, read it, and commit it alone`
      );
      const expected = JSON.parse(await readFile(GOLDEN_PATH, "utf8")) as unknown;
      if (comparableForm(expected) !== comparableForm(normalised)) {
        throw new AssertionError(
          `the normalised dumps differ from the golden dump at ${firstDifference(normalised, expected)}. A change of the serializer changes the golden dump: write it with E2E_UPDATE_GOLDEN=1, commit it alone, and send it for review`
        );
      }
    });

    await step("V3 a second dump of the fixture is byte-identical", async () => {
      check(first !== undefined, "V2 made no dump to compare with");
      const { bytes } = await dumpFixture(`${runFolder}/v3`);
      for (const root of GOLDEN_ROOTS) {
        check(
          bytes[root].equals(first!.bytes[root]),
          `the ${root} dumps differ: ${first!.bytes[root].byteLength} and ${bytes[root].byteLength} bytes`
        );
      }
    });

    await step("V4 the page dump holds the Screen frame as a flow starting point", async () => {
      const manifest = await okRecord("dump_nodes", {
        nodeIds: [need("pageId")],
        outputPath: `${runFolder}/v4`,
      });
      const { bytes } = await readDumpFile(manifest, need("pageId"));
      const page = readRecord(JSON.parse(bytes.toString("utf8")), "the page dump");
      const points = readRecords(page.flowStartingPoints, "flowStartingPoints");
      check(
        points.some((point) => point.nodeId === part("screenId") && point.name === FLOW_NAME),
        `flowStartingPoints is ${show(points)}, expected { nodeId: ${part("screenId")}, name: "${FLOW_NAME}" }`
      );
    });

    await step(
      "V5 a dump in chunks of 2 nodes is byte-identical to the dump in one chunk",
      async () => {
        check(first !== undefined, "V2 made no dump to compare with");
        // The server of the script runs without the setting, so each V2 root of
        // 1,000 nodes or less came in one chunk.
        for (const root of GOLDEN_ROOTS) {
          const entry = (await readDumpFile(first!.manifest, fixtureRoots()[root])).entry;
          const nodes = readNumber(entry.nodeCount, `the ${root} nodeCount`);
          check(nodes <= 1_000, `the V2 ${root} dump holds ${nodes} nodes, more than one chunk`);
        }

        const chunked = await startSecondServer(
          "figma-bridge-e2e-chunks",
          join(runPath, "chunk-root"),
          { FIGMA_BRIDGE_DUMP_CHUNK_NODES: "2" }
        );
        try {
          const { manifest, bytes } = await dumpFixture("v5", chunked);
          const counts: string[] = [];
          for (const root of GOLDEN_ROOTS) {
            const entry = (await readDumpFile(manifest, fixtureRoots()[root], chunked.root)).entry;
            const nodes = readNumber(entry.nodeCount, `the ${root} nodeCount`);
            // Target is one frame; the set and the Screen must span several chunks.
            check(
              root === "target" || nodes > 2,
              `the ${root} dump holds ${nodes} nodes, so it took one chunk only`
            );
            counts.push(`${root} ${nodes} nodes in ${Math.ceil(nodes / 2)} chunks or more`);
            check(
              bytes[root].equals(first!.bytes[root]),
              `the ${root} dump in chunks of 2 differs from the dump in one chunk: ${bytes[root].byteLength} and ${first!.bytes[root].byteLength} bytes`
            );
          }
          console.log(`      ${counts.join("; ")}`);
        } finally {
          await chunked.close();
        }
      }
    );

    await step("V6 the visible content of each dump equals get_node", async () => {
      check(first !== undefined, "V2 made no dump to compare with");
      const roots = fixtureRoots();
      const compared: string[] = [];
      for (const root of GOLDEN_ROOTS) {
        const read = await okRecord("get_node", { nodeId: roots[root] });
        check(
          read.truncated === undefined,
          `get_node cut the ${root} root, so it cannot be compared`
        );
        const differences = visibleDifferences(read, visibleProjection(first!.trees[root]));
        check(
          differences.length === 0,
          `the visible projection of the ${root} dump differs from get_node in ${differences.length} place(s): ${differences.slice(0, 5).join("; ")}`
        );
        compared.push(`${root} ${findNodes(read, () => true).length} nodes`);
      }
      console.log(`      compared ${compared.join(", ")}`);
    });

    await step("V7 the variant counts of the manifest equal list_components", async () => {
      check(first !== undefined, "V2 made no dump to compare with");
      const setEntry = (await readDumpFile(first!.manifest, part("setId"))).entry;
      const listed = await okRecord("list_components", {
        scope: "currentPage",
        query: CONFORMANCE,
      });
      const set = readRecords(listed.items, "list_components.items").find(
        (item) => item.id === part("setId")
      );
      check(set !== undefined, `list_components does not list the set ${part("setId")}`);
      check(
        setEntry.variantCount === (set as Json).variantCount,
        `the set dump counts ${show(setEntry.variantCount)} variants, list_components ${show((set as Json).variantCount)}`
      );

      // The Screen holds instances of the variants and no set, so the manifest
      // counts no variant for it: an instance is not a variant.
      const screenEntry = (await readDumpFile(first!.manifest, part("screenId"))).entry;
      const inScreen = setsAndVariants(first!.trees.screen);
      check(
        screenEntry.variantCount === inScreen.variants,
        `the Screen dump counts ${show(screenEntry.variantCount)} variants, but holds ${inScreen.sets} component set(s) with ${inScreen.variants} variant(s)`
      );
      console.log(
        `      set ${show(setEntry.variantCount)} variants; Screen ${show(screenEntry.variantCount)} variants in ${inScreen.sets} sets`
      );
    });

    await step("V8 dump_nodes turns skipInvisibleInstanceChildren off itself", async () => {
      const before = await fixtureOp("getSkipInvisibleInstanceChildren");
      check(typeof before.value === "boolean", `the flag reads as ${show(before.value)}`);
      try {
        await fixtureOp("setSkipInvisibleInstanceChildren", { value: true });
        const on = await dumpOne(part("screenId"), `${runFolder}/v8-on`);
        const instance = findNodes(on.tree, (node) => node.id === part("instanceId"))[0];
        const badge = findNodes(instance, (node) => node.name === `${CONFORMANCE}badge`)[0];
        check(
          (badge?.styles as Json | undefined)?.visible === false,
          `with the flag on, the dump of the instance holds no hidden badge: ${show(instance ?? null)}`
        );
        const after = await fixtureOp("getSkipInvisibleInstanceChildren");
        check(
          after.value === true,
          `the flag is ${show(after.value)} after the dump, expected true`
        );

        await fixtureOp("setSkipInvisibleInstanceChildren", { value: false });
        const off = await dumpOne(part("screenId"), `${runFolder}/v8-off`);
        check(
          off.bytes.equals(on.bytes),
          `the Screen dumps with the flag on and off differ: ${on.bytes.byteLength} and ${off.bytes.byteLength} bytes`
        );
      } finally {
        await fixtureOp("setSkipInvisibleInstanceChildren", { value: before.value });
        const now = await fixtureOp("getSkipInvisibleInstanceChildren");
        check(
          now.value === before.value,
          `the flag is ${show(now.value)}, expected ${show(before.value)}`
        );
      }
    });
  } finally {
    if (saved.flow !== undefined || saved.skip !== undefined) {
      await step("V cleanup sets the flow starting points and the flag back", async () => {
        if (saved.flow !== undefined) {
          const points = saved.flow.map((point) => ({ nodeId: point.nodeId, name: point.name }));
          const restored = await fixtureOp("setFlowStartingPoints", {
            pageId: need("pageId"),
            points,
          });
          check(
            JSON.stringify(restored.points) === JSON.stringify(points),
            `the page has the flow starting points ${show(restored.points)}, expected ${show(points)}`
          );
        }
        if (saved.skip !== undefined) {
          await fixtureOp("setSkipInvisibleInstanceChildren", { value: saved.skip });
          const now = await fixtureOp("getSkipInvisibleInstanceChildren");
          check(now.value === saved.skip, `the flag is ${show(now.value)}, expected ${saved.skip}`);
        }
      });
    }
    // Only the folder of this run, which the run made.
    await rm(runPath, { recursive: true, force: true });
  }
};

/** Runs every scenario group in order. Each step records its own outcome. */
const runScenario = async (): Promise<void> => {
  await runVariableSteps();
  await runTypographySteps();
  await runComponentSteps();
  await runInstanceSteps();
  await runBindingSteps();
  await runReadSteps();
  await runSectionSteps();
  await runNegativeSteps();
  await runDumpSteps();
  await runAuditorSteps();
  await runCaptureSteps();
  await runConformanceSteps();
};

/**
 * Prints the totals.
 * @returns The process exit code.
 */
const summarise = (): number => {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  console.log("");
  console.log("-".repeat(70));
  console.log(
    `${outcomes.length} steps: ${outcomes.length - failed.length} passed, ${failed.length} failed`
  );
  if (failed.length > 0) {
    console.log("");
    for (const outcome of failed) console.log(`FAIL  ${outcome.name}\n      ${outcome.cause}`);
  }
  return failed.length === 0 ? 0 : 1;
};

/**
 * Connects to a server of this repository over stdio and runs the scenario.
 * @returns The process exit code.
 */
const main = async (): Promise<number> => {
  // Without an explicit env, the MCP SDK gives the child only a short default
  // list of variables, and FIGMA_BRIDGE_PORT would not reach it.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.FIGMA_BRIDGE_OUTPUT_ROOT = OUTPUT_DIR;
  // V5 compares a dump in chunks of 2 with the dumps of this server, which
  // must thus use the default chunk size.
  delete env.FIGMA_BRIDGE_DUMP_CHUNK_NODES;

  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRY],
    cwd: SERVER_ROOT,
    env,
    stderr: "pipe",
  });

  // The server logs its role and its bridge errors to stderr. Collect it so a
  // failure to connect can say what the server was doing.
  const serverLog: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line !== "") serverLog.push(line);
  });

  client = new Client({ name: "figma-bridge-e2e", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (err) {
    console.error(
      `Could not start ${SERVER_ENTRY}: ${err instanceof Error ? err.message : String(err)}`
    );
    if (serverLog.length > 0) console.error(serverLog.join("\n"));
    console.error("Run `bun run build` in server/ first.");
    return 1;
  }

  try {
    const refusal = await resolveFileKey();
    if (refusal !== null) {
      console.error(refusal);
      return 1;
    }
    await mkdir(OUTPUT_DIR, { recursive: true });
    await resolvePage();

    const leftovers = await removeArtifacts();
    if (leftovers.length > 0) {
      console.log(
        `note: ${leftovers.length} object(s) from an earlier run could not be removed first:`
      );
      for (const problem of leftovers) console.log(`      ${problem}`);
    }
    console.log("");

    try {
      conformance.started = true;
      await runScenario();
    } finally {
      console.log("");
      await step("cleanup removes every object the run made", async () => {
        const problems = await removeArtifacts();
        check(problems.length === 0, problems.join("; "));
      });
    }
  } catch (err) {
    console.error("");
    console.error(err instanceof Error ? err.message : String(err));
    if (serverLog.length > 0) console.error(`\nserver log:\n${serverLog.join("\n")}`);
    printConformanceLine();
    return 1;
  } finally {
    await client.close().catch(() => undefined);
  }

  const code = summarise();
  printConformanceLine();
  return code;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
