/**
 * The evidence helpers on their own: the canonical JSON form, the hash, the
 * times, and the comparison of two identities. Needs no server process.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalBytes,
  canonicalJson,
  folderTimestamp,
  sessionChange,
  sha256Hex,
  utcTimestamp,
} from "../src/evidence.js";
import type { EvidenceIdentity } from "../src/evidence.js";

describe("canonicalJson", () => {
  test("sorts the keys at each level and keeps the array order", () => {
    const value = { b: 1, a: { d: [3, 1, 2], c: null }, A: true };
    expect(canonicalJson(value)).toBe('{"A":true,"a":{"c":null,"d":[3,1,2]},"b":1}');
  });

  test("sorts by UTF-16 code unit, not by code point or locale", () => {
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FFFF.
    const value = { "￿": 1, "😀": 2, é: 3, Z: 4, a: 5, "": 6 };
    expect(canonicalJson(value)).toBe('{"":6,"Z":4,"a":5,"é":3,"😀":2,"￿":1}');
  });

  test("writes numbers and strings as JSON.stringify does, and leaves undefined out", () => {
    const value = {
      n: [0, -0, 1.5, 1e21, 1e-7, Number.NaN, Number.POSITIVE_INFINITY],
      s: 'line\nbreak "quote" \\ tab\t \u0001 ✓',
      u: undefined,
      list: [undefined, 1],
    };
    expect(canonicalJson(value)).toBe(
      `{"list":[null,1],"n":[0,0,1.5,1e+21,1e-7,null,null],"s":${JSON.stringify(value.s)}}`
    );
  });

  test("has no whitespace, no byte order mark, and no trailing newline", () => {
    const bytes = canonicalBytes({ z: [1, { y: "a b" }], x: {} });
    expect(bytes.toString("utf8")).toBe('{"x":{},"z":[1,{"y":"a b"}]}');
    expect(bytes[0]).toBe(0x7b);
    expect(bytes[bytes.length - 1]).toBe(0x7d);
  });

  test("encodes as UTF-8", () => {
    expect([...canonicalBytes({ k: "é" })]).toEqual([...Buffer.from('{"k":"é"}', "utf8")]);
  });

  test("refuses a bigint", () => {
    expect(() => canonicalJson({ a: [1n] })).toThrow("$.a[0]");
  });
});

describe("the hash and the times", () => {
  test("sha256Hex covers the exact bytes", () => {
    const bytes = canonicalBytes({ a: 1 });
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update('{"a":1}').digest("hex"));
  });

  test("a time is ISO 8601 UTC with milliseconds, and a folder time is compact", () => {
    const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
    expect(utcTimestamp(date)).toBe("2026-01-02T03:04:05.006Z");
    expect(folderTimestamp(date)).toBe("20260102T030405Z");
  });
});

describe("sessionChange", () => {
  const before: EvidenceIdentity = {
    fileKey: "synthetic-key",
    fileName: "synthetic",
    pluginBuild: "build-1",
    epoch: 1,
    bridgeCommit: "c1",
    leaderCommit: "c1",
    leaderStartedAt: "2026-01-01T00:00:00.000Z",
  };

  test("finds nothing when the session is the same", () => {
    expect(sessionChange(before, { ...before })).toBeNull();
  });

  test("names each changed field", () => {
    expect(sessionChange(before, { ...before, epoch: 2 })).toBe("epoch 1 -> 2");
    expect(sessionChange(before, { ...before, pluginBuild: "build-2", epoch: 3 })).toBe(
      "epoch 1 -> 3, pluginBuild build-1 -> build-2"
    );
    // A restarted leader starts each epoch again at 1.
    expect(sessionChange(before, { ...before, leaderStartedAt: "2026-01-01T00:00:01.000Z" })).toBe(
      "leaderStartedAt 2026-01-01T00:00:00.000Z -> 2026-01-01T00:00:01.000Z"
    );
  });
});
