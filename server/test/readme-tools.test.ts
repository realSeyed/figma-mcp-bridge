/**
 * The tool tables of the README match the tools a full process registers:
 * no tool is missing from the tables, and no row names a tool that does not
 * exist. A row marked _(full)_ is a tool that the design set leaves out.
 */

import { beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_EXCLUDED_TOOLS } from "../src/toolset.js";
import { listRegisteredTools } from "./helpers/schema-lint.js";

const README = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "README.md");

let rows: { name: string; fullOnly: boolean }[] = [];
let registered: string[] = [];

beforeAll(async () => {
  const text = await readFile(README, "utf8");
  const start = text.indexOf("\n## Available Tools");
  const end = text.indexOf("\n### Reading Notes", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  rows = [...text.slice(start, end).matchAll(/^\| `([a-z_]+)`( _\(full\)_)? +\|/gm)].map(
    (match) => ({ name: match[1], fullOnly: match[2] !== undefined })
  );
  registered = (await listRegisteredTools()).tools.map((tool) => tool.name);
});

test("the README tool tables list each registered tool once", () => {
  const names = rows.map((row) => row.name);
  expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  expect([...names].sort()).toEqual([...registered].sort());
});

test("the README marks exactly the tools the design set leaves out", () => {
  const marked = rows.filter((row) => row.fullOnly).map((row) => row.name);
  expect(marked.sort()).toEqual([...DESIGN_EXCLUDED_TOOLS].sort());
});
