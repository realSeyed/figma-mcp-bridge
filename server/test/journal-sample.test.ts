/**
 * The sample of journal entries that the toolset tests share
 * (`tools/audit/tests/data/journal_entries.json`). The bridge code made its
 * hashes; this test calculates them again with `entryHash`, and the toolset
 * test does the same with `canonical_json`. Both languages thus agree on
 * numbers, key order, and escapes. Needs no server process.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/evidence.js";
import { entryHash, GENESIS_HASH, type JournalEntry } from "../src/journal.js";

const SAMPLE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tools",
  "audit",
  "tests",
  "data",
  "journal_entries.json"
);

const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as {
  genesisHash: string;
  entries: JournalEntry[];
};

describe("the journal sample of the toolset", () => {
  test("holds 8 to 12 entries after the genesis hash", () => {
    expect(sample.genesisHash).toBe(GENESIS_HASH);
    expect(sample.entries.length).toBeGreaterThanOrEqual(8);
    expect(sample.entries.length).toBeLessThanOrEqual(12);
  });

  test("each hash is the entryHash of its entry, and the chain holds", () => {
    let previous = GENESIS_HASH;
    sample.entries.forEach((entry, index) => {
      expect(entry.seq).toBe(index + 1);
      expect(entry.prevHash).toBe(previous);
      expect(entryHash(entry)).toBe(entry.hash);
      previous = entry.hash;
    });
  });

  test("a changed value breaks the hash", () => {
    const changed = { ...sample.entries[2], tool: "set_node_property" };
    expect(entryHash(changed)).not.toBe(sample.entries[2].hash);
  });

  test("covers the values that test the canonical form, and no real data", () => {
    const entries = sample.entries;
    // The numbers, as the canonical form writes them. The file text is
    // Prettier's, which writes 1e21 for 1e+21.
    const written = canonicalJson(entries);
    for (const number of ["0.1", "1e-7", "1e+21", "-2.5"]) {
      expect(written).toContain(number);
    }
    expect(written).toContain(":0,");

    // A key above U+FFFF and a key between U+E000 and U+FFFF in one object: the
    // order by UTF-16 code unit puts the first before the second.
    const keyed = entries
      .map((entry) => Object.keys(entry.params ?? {}))
      .find((keys) => keys.includes("\u{1F600}") && keys.includes(""));
    expect(keyed).toBeDefined();
    const canonical = canonicalJson(Object.fromEntries((keyed ?? []).map((key) => [key, 1])));
    expect(canonical.indexOf("\u{1F600}")).toBeLessThan(canonical.indexOf(""));

    const strings = JSON.stringify(entries);
    for (const piece of ['\\"', "\\\\", "\\n", "\\u0001", "\\u001f"]) {
      expect(strings).toContain(piece);
    }

    expect(entries.some((entry) => entry.nodeIds === null)).toBe(true);
    expect(entries.some((entry) => JSON.stringify(entry.response) === '{"data":null}')).toBe(true);
    expect(entries.some((entry) => "error" in entry.response)).toBe(true);
    expect(entries.every((entry) => entry.fileKey === "synthetic-file-key")).toBe(true);
  });
});
