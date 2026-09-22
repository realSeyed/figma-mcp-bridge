#!/usr/bin/env bun
/**
 * Measures this fork's tools against a live Figma file and reports whether
 * each call stays inside the budget a tool call has to meet:
 *
 *   - 30 seconds, well under the 3 minutes `server/src/bridge.ts` allows
 *     before it gives up on a request.
 *   - 50,000 characters of result with the default input, so one call cannot
 *     fill an agent's context on its own.
 *
 * Run it from `server/` with `bun run perf`, with the Figma plugin connected.
 * Like the e2e script it starts its own `node dist/index.js`, which joins the
 * running bridge as a follower, so a measurement covers the follower to leader
 * `/rpc` hop an agent's calls actually take.
 *
 * The read measurements want a big file — a community UI kit duplicated into
 * Drafts does nicely. The write measurements build their own load and need a
 * file you do not mind writing to. Point them at different files with the two
 * environment variables below, or at one file by setting only `FIGMA_FILE_KEY`.
 *
 * Everything the run makes is named `mcp-test/...` on the page `MCP Test`, and
 * a `finally` block removes it again — after a failure as well.
 *
 * Environment:
 *   FIGMA_FILE_KEY       the file the write measurements build load in. Falls
 *                        back to the single connected file.
 *   FIGMA_READ_FILE_KEY  the file the read measurements read. Defaults to
 *                        FIGMA_FILE_KEY.
 *   FIGMA_BRIDGE_PORT    forwarded to the spawned server, as in production.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(SCRIPT_DIR, "..");
const SERVER_ENTRY = join(SERVER_ROOT, "dist", "index.js");

/** The page the write measurements build their load on. */
const PAGE_NAME = "MCP Test";

/** Every object a run makes carries this prefix, so a leftover is recognisable. */
const PREFIX = "mcp-test/";

/** How many items the batch measurements send. The most a batch tool accepts. */
const BATCH = 200;

/** The budget one call has to meet. */
const MAX_MS = 30_000;
const MAX_CHARS = 50_000;

/** Longer than the budget, so a call that blows it is measured, not cut off. */
const CALL_TIMEOUT_MS = 180_000;

type Json = Record<string, unknown>;
type ToolOutcome = { ok: true; data: unknown; chars: number } | { ok: false; error: string };

let client: Client;
let writeKey: string | undefined;
let readKey: string | undefined;

/** True when the run builds its own read load instead of reading a real file. */
let synthetic = false;

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

/**
 * Calls one tool and parses its result.
 * @param name - The tool name.
 * @param args - The tool arguments.
 * @param key - The file to call against.
 * @returns The parsed data with the size of the text the tool returned, or the
 * error it reported.
 */
const callTool = async (
  name: string,
  args: Json,
  key: string | undefined
): Promise<ToolOutcome> => {
  const withKey = key === undefined ? args : { fileKey: key, ...args };
  const result = await client.callTool({ name, arguments: withKey }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });

  const parts = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");

  if (result.isError === true) return { ok: false, error: text };
  if (text === "") return { ok: true, data: null, chars: 0 };
  try {
    return { ok: true, data: JSON.parse(text) as unknown, chars: text.length };
  } catch {
    return { ok: false, error: `${name} returned text that is not JSON: ${text}` };
  }
};

/**
 * Calls a tool that must succeed, without measuring it. Used for the setup and
 * the teardown of the load, which are not what this script reports on.
 * @param name - The tool name.
 * @param args - The tool arguments.
 * @param key - The file to call against.
 * @returns The parsed data.
 */
const ok = async (name: string, args: Json = {}, key = writeKey): Promise<unknown> => {
  const result = await callTool(name, args, key);
  if (!result.ok) throw new Error(`${name} failed: ${result.error}`);
  return result.data;
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type Row = {
  label: string;
  input: string;
  ms: number;
  chars: number;
  note: string;
  /** False for a core tool measured for context, which the budget does not govern. */
  budgeted: boolean;
  failed?: string;
};

const rows: Row[] = [];

/**
 * Times one call and records it against the budget.
 * @param label - How the row names the call.
 * @param input - What the call was given, for the row.
 * @param name - The tool name.
 * @param args - The tool arguments.
 * @param key - The file to call against.
 * @param budgeted - False for a core tool measured only for context.
 * @returns The parsed data, or undefined when the call failed.
 */
const measure = async (
  label: string,
  input: string,
  name: string,
  args: Json = {},
  key = writeKey,
  budgeted = true
): Promise<unknown> => {
  const started = performance.now();
  const result = await callTool(name, args, key);
  const ms = Math.round(performance.now() - started);

  if (!result.ok) {
    rows.push({ label, input, ms, chars: 0, note: "", budgeted, failed: result.error });
    console.log(`FAIL  ${label}\n      ${result.error}`);
    return undefined;
  }

  const over = [
    ms > MAX_MS ? `over ${MAX_MS / 1000}s` : "",
    result.chars > MAX_CHARS ? `over ${MAX_CHARS} chars` : "",
  ].filter(Boolean);
  const note =
    over.length === 0 ? "within budget" : budgeted ? over.join(", ") : `${over.join(", ")} (core)`;
  rows.push({ label, input, ms, chars: result.chars, note, budgeted });
  const mark = over.length === 0 ? "ok  " : budgeted ? "OVER" : "note";
  console.log(
    `${mark}  ${label.padEnd(42)} ${String(ms).padStart(6)} ms  ${String(result.chars).padStart(7)} chars`
  );
  return result.data;
};

/**
 * Prints the measurements as the Markdown table the PR body carries.
 * @returns The process exit code: 1 when a call failed or blew the budget.
 */
const report = (): number => {
  const budgeted = rows.filter((row) => row.budgeted);
  const bad = budgeted.filter((row) => row.failed !== undefined || row.note !== "within budget");
  console.log("\n\n| Call | Input | Time | Result | Budget |");
  console.log("| ---- | ----- | ---- | ------ | ------ |");
  for (const row of rows) {
    const time = row.failed === undefined ? `${(row.ms / 1000).toFixed(2)} s` : "—";
    const size = row.failed === undefined ? `${row.chars.toLocaleString("en-US")} chars` : "—";
    const verdict = row.failed === undefined ? row.note : `failed: ${row.failed.slice(0, 120)}`;
    console.log(`| \`${row.label}\` | ${row.input} | ${time} | ${size} | ${verdict} |`);
  }
  console.log(
    `\n${budgeted.length - bad.length}/${budgeted.length} budgeted calls within ${MAX_MS / 1000}s and ${MAX_CHARS.toLocaleString("en-US")} chars.`
  );
  return bad.length === 0 ? 0 : 1;
};

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Reads a value as an object.
 * @param value - The value.
 * @param what - What it was, for the error.
 * @returns The object.
 */
const asRecord = (value: unknown, what: string): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object: ${JSON.stringify(value)?.slice(0, 200)}`);
  }
  return value as Json;
};

/**
 * Reads a value as an array of objects.
 * @param value - The value.
 * @param what - What it was, for the error.
 * @returns The array.
 */
const asList = (value: unknown, what: string): Json[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${what} is not an array: ${JSON.stringify(value)?.slice(0, 200)}`);
  }
  return value.map((item, index) => asRecord(item, `${what}[${index}]`));
};

/**
 * Reads a value as a node ID.
 * @param value - The value.
 * @param what - What it was, for the error.
 * @returns The ID.
 */
const asId = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${what} is not a node ID: ${JSON.stringify(value)}`);
  }
  return value;
};

// ---------------------------------------------------------------------------
// Picking what to measure against
// ---------------------------------------------------------------------------

/**
 * Resolves the two file keys from the environment and the connected files.
 */
const resolveFileKeys = async (): Promise<void> => {
  const fromEnv = process.env.FIGMA_FILE_KEY?.trim();
  if (fromEnv) {
    writeKey = fromEnv;
  } else {
    const listed = asList(
      await callTool("list_files", {}, undefined).then((r) => (r.ok ? r.data : [])),
      "list_files"
    );
    if (listed.length === 0) {
      throw new Error(
        "No Figma file is connected. Run the plugin in the file you want to measure, then run this again."
      );
    }
    if (listed.length > 1) {
      const names = listed.map((file) => `${String(file.fileName)} (${String(file.fileKey)})`);
      throw new Error(
        `${listed.length} Figma files are connected, so the write file is ambiguous. Set FIGMA_FILE_KEY to one of: ${names.join(", ")}.`
      );
    }
    writeKey = String(listed[0].fileKey);
  }

  const readFromEnv = process.env.FIGMA_READ_FILE_KEY?.trim();
  readKey = readFromEnv || writeKey;
  synthetic = !readFromEnv;
  console.log(`write file: ${writeKey}`);
  console.log(
    `read file:  ${readKey}${readKey === writeKey ? " (same; the run builds its own read load)" : ""}\n`
  );
};

/**
 * Walks a serialized node tree, counting the instances under each node.
 *
 * `get_node` is measured on the heaviest frame a file has, which is the one an
 * agent reading a real screen would land on. Counting the instances finds it:
 * an instance costs the serializer its component properties and its bindings
 * on top of the node itself.
 * @param node - The node to walk.
 * @returns The node with the most instances under it, and that count.
 */
const heaviestFrame = (node: Json): { id: string; name: string; instances: number } | undefined => {
  let best: { id: string; name: string; instances: number } | undefined;

  const walk = (current: Json): number => {
    const children = Array.isArray(current.children) ? (current.children as Json[]) : [];
    let instances = current.type === "INSTANCE" ? 1 : 0;
    for (const child of children) instances += walk(child);

    const type = String(current.type);
    const container = type === "FRAME" || type === "GROUP" || type === "SECTION";
    if (container && (best === undefined || instances > best.instances)) {
      best = { id: String(current.id), name: String(current.name), instances };
    }
    return instances;
  };

  walk(node);
  return best;
};

// ---------------------------------------------------------------------------
// Read load
// ---------------------------------------------------------------------------

/** What a run built, so the teardown can remove it again. */
type Load = { pageId: string; nodeIds: string[]; collectionId?: string; styleId?: string };

/** The component set and the frame the read measurements read. */
type ReadTargets = {
  set: { id: string; name: string; variants: number };
  frame: { id: string; name: string; instances: number };
};

/** Variants in the synthetic component set. The most combine_as_variants takes. */
const SET_VARIANTS = 50;

/**
 * Standalone components the synthetic load adds beside the set.
 *
 * As many as `list_components` shows by default, so with the set beside them
 * the file holds more than one default call returns — the case the 50,000
 * character budget is really about.
 */
const LOOSE_COMPONENTS = 100;

/** Instances in the synthetic frame, matching a busy screen in a real kit. */
const FRAME_INSTANCES = 200;

/**
 * Builds components, a variant set, and an instance-heavy frame to read.
 *
 * Used when no separate read file is named. A real UI kit is the better
 * measurement — it nests instances deeper than this does — but this runs
 * anywhere and puts a floor under the numbers.
 * @param load - Records every node it makes, for the teardown.
 * @returns What the read measurements should read.
 */
const buildReadLoad = async (load: Load): Promise<ReadTargets> => {
  console.log(
    `building read load: ${SET_VARIANTS} variants, ${LOOSE_COMPONENTS} components, ${FRAME_INSTANCES} instances`
  );

  // A variant set: the components are named "Property=Value" so
  // combine_as_variants takes them, and two axes give it something to report.
  const variantIds: string[] = [];
  for (let index = 0; index < SET_VARIANTS; index++) {
    const made = asRecord(
      await ok("create_component", {
        name: `Size=S${String(index).padStart(2, "0")}, State=Default`,
        parentId: load.pageId,
        width: 80,
        height: 32,
        fillHex: "#3366FF",
      }),
      "create_component result"
    );
    variantIds.push(asId(made.id, "component id"));
  }
  const set = asRecord(
    await ok("combine_as_variants", {
      componentIds: variantIds,
      name: `${PREFIX}kit-set`,
      parentId: load.pageId,
    }),
    "combine_as_variants result"
  );
  const setId = asId(set.id, "component set id");
  load.nodeIds.push(setId);

  // Properties on the set, so get_component has definitions to report and the
  // measurement covers what makes its result big.
  await ok("add_component_property", {
    componentId: setId,
    name: "Label",
    type: "TEXT",
    defaultValue: "Button",
  });
  await ok("add_component_property", {
    componentId: setId,
    name: "Show icon",
    type: "BOOLEAN",
    defaultValue: true,
  });

  // A section for the section reads to land on. It is made before the
  // components it ends up holding, because the teardown removes the load
  // newest first and a container has to go out after its children.
  const section = asRecord(
    await ok("create_section", {
      name: `${PREFIX}kit-section`,
      parentId: load.pageId,
      x: 0,
      y: 0,
      width: 600,
      height: 400,
    }),
    "create_section result"
  );
  load.nodeIds.push(asId(section.id, "section id"));

  // Loose components, to fill list_components' default page.
  const looseIds: string[] = [];
  for (let index = 0; index < LOOSE_COMPONENTS; index++) {
    const made = asRecord(
      await ok("create_component", {
        name: `${PREFIX}kit/part-${String(index).padStart(3, "0")}`,
        parentId: load.pageId,
        width: 24,
        height: 24,
        fillHex: "#222222",
      }),
      "create_component result"
    );
    looseIds.push(asId(made.id, "component id"));
    load.nodeIds.push(asId(made.id, "component id"));
  }
  await ok("move_to_section", {
    sectionId: asId(section.id, "section id"),
    nodeIds: looseIds,
    fit: true,
  });

  // A frame of instances: what an agent reading one screen lands on.
  const frame = asRecord(
    await ok("create_frame", {
      name: `${PREFIX}kit-screen`,
      parentId: load.pageId,
      width: 1200,
      height: 2400,
    }),
    "create_frame result"
  );
  const frameId = asId(frame.nodeId, "frame id");
  load.nodeIds.push(frameId);

  const seed = asRecord(
    await ok("create_instance", { componentId: setId, parentId: frameId }),
    "create_instance result"
  );
  await growTo(asId(seed.id, "instance id"), FRAME_INSTANCES, load, frameId);

  // Handed straight to the measurements rather than rediscovered: the load
  // sits on the test page, which is not necessarily the page Figma has open,
  // and `get_document` only ever sees the open one.
  return {
    set: { id: setId, name: `${PREFIX}kit-set`, variants: SET_VARIANTS },
    frame: { id: frameId, name: `${PREFIX}kit-screen`, instances: FRAME_INSTANCES },
  };
};

// ---------------------------------------------------------------------------
// Read measurements
// ---------------------------------------------------------------------------

/**
 * Measures the section reads against the read file.
 *
 * The listing is also what finds the section worth reading, so the two calls
 * are measured in the order an agent would make them. A file with no section
 * skips the second rather than reporting a call it never made.
 */
const measureSectionReads = async (): Promise<void> => {
  const listed = await measure(
    "list_sections",
    'scope: "allPages"',
    "list_sections",
    { scope: "allPages" },
    readKey
  );
  if (listed === undefined) return;

  // The section holding the most children: the one whose get_section result
  // has the most to carry.
  let biggest: { id: string; name: string; children: number } | undefined;
  for (const item of asList(asRecord(listed, "list_sections result").items, "items")) {
    const children = typeof item.childCount === "number" ? item.childCount : 0;
    if (biggest === undefined || children > biggest.children) {
      biggest = { id: asId(item.id, "section id"), name: String(item.name), children };
    }
  }
  if (biggest === undefined) {
    console.log("skip  get_section - the read file has no section");
    return;
  }

  await measure(
    "get_section",
    `largest section: "${biggest.name}" (${biggest.children} children)`,
    "get_section",
    { nodeId: biggest.id },
    readKey
  );
};

/**
 * Measures the read tools against the read file.
 * @param targets - What to read, when the run built its own load. Left out for
 * a real read file, whose heaviest component set and frame are found instead.
 */
const measureReads = async (targets?: ReadTargets): Promise<void> => {
  console.log("reads");

  await measure("list_components", "default scope (currentPage)", "list_components", {}, readKey);

  const allPages = await measure(
    "list_components",
    'scope: "allPages"',
    "list_components",
    { scope: "allPages" },
    readKey
  );

  // The largest component set in the file: the one whose get_component result
  // has the most to carry.
  let set = targets?.set;
  if (set === undefined && allPages !== undefined) {
    const items = asList(asRecord(allPages, "list_components result").items, "items");
    for (const item of items) {
      const variants = typeof item.variantCount === "number" ? item.variantCount : 0;
      if (variants > (set?.variants ?? -1)) {
        set = { id: asId(item.id, "component id"), name: String(item.name), variants };
      }
    }
  }
  if (set === undefined) {
    console.log("skip  get_component — the read file has no local component");
  } else {
    await measure(
      "get_component",
      `largest set: "${set.name}" (${set.variants} variants)`,
      "get_component",
      { nodeId: set.id },
      readKey
    );
  }

  await measureSectionReads();

  let frame = targets?.frame;
  if (frame === undefined) {
    // `get_document` is a core tool this fork did not add, so it is measured
    // for context rather than against the budget — it is also how the heaviest
    // frame of a real read file is found.
    const document = await measure(
      "get_document",
      "the open page",
      "get_document",
      {},
      readKey,
      false
    );
    if (document === undefined) return;
    const found = heaviestFrame(asRecord(document, "get_document result"));
    if (found !== undefined && found.instances > 0) frame = found;
  }
  if (frame === undefined) {
    console.log("skip  get_node — the read file has no frame holding an instance");
    return;
  }
  await measure(
    "get_node",
    `frame "${frame.name}" (${frame.instances} instances)`,
    "get_node",
    { nodeId: frame.id },
    readKey
  );
};

// ---------------------------------------------------------------------------
// Write measurements
// ---------------------------------------------------------------------------

/**
 * Makes `count` copies of one node by doubling: 8 calls reach 256, where one
 * call per node would be 256 round trips.
 *
 * Figma's `clone()` parents a copy under the page Figma has open rather than
 * under the node it copied, so the copies land wherever the editor happens to
 * be. `parentId` puts them back; every ID is recorded either way, because a
 * copy left on the open page is a copy the teardown has to find.
 * @param seedId - The node to copy.
 * @param count - How many nodes the caller needs in total, seed included.
 * @param load - Records every node made, for the teardown.
 * @param parentId - Where the copies belong, when that is not where they land.
 * @returns The IDs, `count` of them.
 */
const growTo = async (
  seedId: string,
  count: number,
  load: Load,
  parentId?: string
): Promise<string[]> => {
  let ids = [seedId];
  load.nodeIds.push(seedId);
  while (ids.length < count) {
    const want = Math.min(ids.length, count - ids.length);
    const made = await ok("duplicate_nodes", { nodeIds: ids.slice(0, want) });
    const copies = asList(asRecord(made, "duplicate_nodes result").duplicates, "duplicates").map(
      (copy) => asId(copy.nodeId, "duplicated node id")
    );
    // Recorded as they appear: a failure part way still leaves the teardown
    // every node the run had made by then.
    load.nodeIds.push(...copies);
    if (parentId !== undefined) await ok("reparent_nodes", { nodeIds: copies, parentId });
    ids = ids.concat(copies);
  }
  return ids;
};

/**
 * Builds the load, measures the batch tools against it, and reports what it
 * made so the teardown can remove it.
 * @param load - Filled in as each piece is made, so a failure half way still
 * leaves the teardown something to work with.
 */
const measureWrites = async (load: Load): Promise<void> => {
  console.log("\nwrites");

  // A rectangle and a text node, each grown to a full batch. Both sit on the
  // test page, so the teardown finds them by walking it.
  const rectangle = asRecord(
    await ok("create_shape", {
      shapeType: "RECTANGLE",
      name: `${PREFIX}load-rect`,
      parentId: load.pageId,
      width: 40,
      height: 40,
      fillHex: "#3366FF",
    }),
    "create_shape result"
  );
  const rectangleIds = await growTo(
    asId(rectangle.nodeId, "rectangle id"),
    BATCH,
    load,
    load.pageId
  );

  const text = asRecord(
    await ok("create_text", {
      name: `${PREFIX}load-text`,
      parentId: load.pageId,
      characters: "mcp-test",
      fontSize: 16,
    }),
    "create_text result"
  );
  const textIds = await growTo(asId(text.nodeId, "text id"), BATCH, load, load.pageId);
  console.log(`load: ${rectangleIds.length} rectangles, ${textIds.length} text nodes`);

  const collection = asRecord(
    await ok("create_variable_collection", { name: `${PREFIX}perf` }),
    "create_variable_collection result"
  );
  load.collectionId = asId(collection.id, "collection id");

  const created = await measure(
    "create_variables",
    `${BATCH} FLOAT variables`,
    "create_variables",
    {
      collectionId: load.collectionId,
      variables: Array.from({ length: BATCH }, (_, index) => ({
        name: `${PREFIX}num/${index}`,
        type: "FLOAT",
        value: index + 1,
      })),
    }
  );
  if (created === undefined) return;

  const variableIds = asList(asRecord(created, "create_variables result").results, "results").map(
    (result) => asId(result.id, "created variable id")
  );

  await measure("update_variables", `${BATCH} values`, "update_variables", {
    updates: variableIds.map((variableId, index) => ({ variableId, value: index * 2 })),
  });

  await measure("bind_variables", `${BATCH} bindings to opacity`, "bind_variables", {
    bindings: rectangleIds.map((nodeId, index) => ({
      nodeId,
      field: "opacity",
      variableId: variableIds[index],
    })),
  });

  const style = asRecord(
    await ok("create_text_style", {
      name: `${PREFIX}perf-style`,
      fontFamily: "Inter",
      fontStyle: "Regular",
      fontSize: 18,
    }),
    "create_text_style result"
  );
  load.styleId = asId(style.id, "style id");

  await measure("apply_text_style", `${BATCH} text nodes`, "apply_text_style", {
    styleId: load.styleId,
    nodeIds: textIds,
  });

  const wrapped = await measure("create_section", `wrapping ${BATCH} nodes`, "create_section", {
    nodeIds: rectangleIds,
    name: `${PREFIX}load-section`,
  });
  if (wrapped === undefined) return;
  const sectionId = asId(asRecord(wrapped, "create_section result").id, "section id");
  // Recorded ahead of the load rather than after it: the teardown removes the
  // load newest first, and this section wraps rectangles that were made
  // before it, so it has to be the last thing to go.
  load.nodeIds.unshift(sectionId);

  await measure("move_out_of_section", `${BATCH} nodes`, "move_out_of_section", {
    nodeIds: rectangleIds,
  });

  await measure("move_to_section", `${BATCH} nodes, fit: true`, "move_to_section", {
    sectionId,
    nodeIds: rectangleIds,
    fit: true,
  });

  // get_section lists at most 200 children, and this section holds exactly
  // that many, so this is the largest result it can return. It is measured
  // here rather than only against the read file, because a file is free to
  // hold no section at all and the cap still has to be held to the budget.
  await measure("get_section", `${BATCH} children, the listing cap`, "get_section", {
    nodeId: sectionId,
  });
};

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

/**
 * Finds the test page, making it when the file has none.
 * @returns The page ID.
 */
const resolvePage = async (): Promise<string> => {
  const metadata = asRecord(await ok("get_metadata"), "get_metadata result");
  const pages = asList(metadata.pages ?? [], "pages");
  const existing = pages.find((page) => page.name === PAGE_NAME);
  if (existing) return asId(existing.id, "page id");

  const made = asRecord(await ok("create_page", { name: PAGE_NAME }), "create_page result");
  return asId(made.pageId, "page id");
};

/**
 * Removes everything the run made: the load nodes, the collection with its
 * variables, and the text style. The page itself stays — the tools cannot
 * remove a page, so the next run reuses it.
 * @param load - What the run made.
 * @returns One line per thing that could not be removed.
 */
const teardown = async (load: Load): Promise<string[]> => {
  const problems: string[] = [];

  // Newest first, so a node goes out before the frame it was put in: removing
  // the frame first would take its children with it and leave their IDs
  // pointing at nothing, which fails the whole chunk they sit in.
  // delete_nodes takes as many IDs as the batch tools do, so the load goes
  // back out in the same size chunks it came in.
  const doomed = [...load.nodeIds].reverse();
  for (let start = 0; start < doomed.length; start += BATCH) {
    const chunk = doomed.slice(start, start + BATCH);
    try {
      await ok("delete_nodes", { nodeIds: chunk, confirm: true });
    } catch (err) {
      problems.push(
        `load nodes ${start}-${start + chunk.length - 1}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (load.styleId !== undefined) {
    try {
      await ok("delete_text_style", { styleId: load.styleId, confirm: true });
    } catch (err) {
      problems.push(`text style: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (load.collectionId !== undefined) {
    try {
      await ok("delete_variable_collection", { collectionId: load.collectionId, confirm: true });
    } catch (err) {
      problems.push(`variable collection: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return problems;
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Connects to a server of this repository over stdio and runs the measurements.
 * @returns The process exit code.
 */
const main = async (): Promise<number> => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRY],
    cwd: SERVER_ROOT,
    stderr: "pipe",
  });

  const serverLog: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line !== "") serverLog.push(line);
  });

  client = new Client({ name: "figma-bridge-perf", version: "1.0.0" }, { capabilities: {} });

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

  const load: Load = { pageId: "", nodeIds: [] };
  try {
    await resolveFileKeys();
    load.pageId = await resolvePage();

    try {
      // Without a read file of its own there is nothing in the write file to
      // read, so the run makes something first. The teardown takes it out with
      // the rest of the load.
      const targets = synthetic ? await buildReadLoad(load) : undefined;
      await measureReads(targets);
      await measureWrites(load);
    } finally {
      const problems = await teardown(load);
      if (problems.length > 0) {
        console.log("\nnote: some objects could not be removed:");
        for (const problem of problems) console.log(`      ${problem}`);
      }
    }
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    if (serverLog.length > 0) console.error(`\nserver log:\n${serverLog.join("\n")}`);
    return 1;
  } finally {
    await client.close().catch(() => undefined);
  }

  return report();
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
