/**
 * BR-5: /ping and list_files report the bridge commit, the plugin build, and
 * an epoch for each file. Runs real server processes and a simulated plugin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileIdentity, resolveFileIdentity } from "../src/identity.js";
import type { ConnectedFile, IdentityReport } from "../src/types.js";
import { Harness } from "./helpers/harness.js";

const TIMEOUT_MS = 60_000;
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** Runs git in this checkout. Returns null when git fails. */
function git(args: string[]): string | null {
  const run = spawnSync("git", args, { cwd: SERVER_ROOT, encoding: "utf8" });
  return run.status === 0 ? run.stdout : null;
}

/** The commit that `scripts/write-build-info.mjs` records for this checkout. */
function expectedCommit(): string {
  const hash = git(["rev-parse", "HEAD"])?.trim();
  if (!hash) return "unknown";
  return (git(["status", "--porcelain"]) ?? "").trim() === "" ? hash : `${hash}-dirty`;
}

interface Ping {
  status: string;
  version: string;
  bridgeCommit: string;
  leaderStartedAt: string;
  files: ConnectedFile[];
}

async function ping(port: number): Promise<Ping> {
  const response = await fetch(`http://127.0.0.1:${port}/ping`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Ping;
}

/** Polls until the check returns a value that is not undefined. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out while waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function startLeader() {
  const port = await h.freePort();
  const leader = await h.server({ port, cwd: await h.tempDir("cwd") });
  expect(leader.role).toBe("LEADER");
  return { port, leader };
}

async function listFiles(server: { callTool: (name: string) => Promise<unknown> }) {
  const outcome = (await server.callTool("list_files")) as
    { ok: true; data: IdentityReport } | { ok: false; error: string };
  if (!outcome.ok) throw new Error(`list_files failed: ${outcome.error}`);
  return outcome.data;
}

describe("the bridge commit", () => {
  test(
    "/ping and list_files report the commit of the build",
    async () => {
      const { port, leader } = await startLeader();
      const expected = expectedCommit();

      const answer = await ping(port);
      expect(answer.status).toBe("ok");
      expect(answer.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(answer.bridgeCommit).toBe(expected);
      expect(expected).toMatch(/^([0-9a-f]{40}(-dirty)?|unknown)$/);

      const report = await listFiles(leader);
      expect(report.bridgeCommit).toBe(expected);
      expect(report.leaderCommit).toBe(expected);
    },
    TIMEOUT_MS
  );
});

describe("the epoch", () => {
  test(
    "a connection, a replacement, and a reconnect count; a read does not",
    async () => {
      const { port, leader } = await startLeader();
      const key = "epoch-file";

      expect((await ping(port)).files).toEqual([]);

      await h.plugin({ port, fileKey: key, fileName: "one", pluginBuild: "test-build-1" });
      const first = (await listFiles(leader)).files;
      expect(first).toEqual([
        { fileKey: key, fileName: "one", pluginBuild: "test-build-1", epoch: 1 },
      ]);
      expect((await ping(port)).files).toEqual(first);

      // A second connection for the same key replaces the first.
      await h.plugin({ port, fileKey: key, fileName: "one", pluginBuild: "test-build-2" });
      const replaced = await waitFor("the replacement", async () => {
        const files = (await listFiles(leader)).files;
        return files[0]?.epoch === 2 ? files : undefined;
      });
      expect(replaced).toEqual([
        { fileKey: key, fileName: "one", pluginBuild: "test-build-2", epoch: 2 },
      ]);

      // Ten reads of each kind change nothing.
      for (let read = 0; read < 10; read++) {
        expect((await listFiles(leader)).files).toEqual(replaced);
        expect((await ping(port)).files).toEqual(replaced);
      }
    },
    TIMEOUT_MS
  );

  test(
    "a disconnect keeps the count, and the next connection adds 1",
    async () => {
      const { port, leader } = await startLeader();
      const key = "epoch-file";

      const plugin = await h.plugin({ port, fileKey: key, pluginBuild: "test-build-1" });
      await plugin.close();
      await waitFor("the disconnect", async () =>
        (await listFiles(leader)).files.length === 0 ? true : undefined
      );

      await h.plugin({ port, fileKey: key, pluginBuild: "test-build-1" });
      const files = (await listFiles(leader)).files;
      expect(files.map((file) => file.epoch)).toEqual([2]);
    },
    TIMEOUT_MS
  );

  test(
    "each file key has its own epoch, and a connection without pluginBuild reports unknown",
    async () => {
      const { port, leader } = await startLeader();

      await h.plugin({ port, fileKey: "file-a", fileName: "a", pluginBuild: "test-build-1" });
      await h.plugin({ port, fileKey: "file-b", fileName: "b" });
      await h.plugin({ port, fileKey: "file-b", fileName: "b" });

      const files = await waitFor("both files", async () => {
        const listed = (await listFiles(leader)).files;
        return listed.find((file) => file.fileKey === "file-b")?.epoch === 2 ? listed : undefined;
      });
      const byKey = Object.fromEntries(files.map((file) => [file.fileKey, file]));
      expect(byKey["file-a"]).toMatchObject({ pluginBuild: "test-build-1", epoch: 1 });
      expect(byKey["file-b"]).toMatchObject({ pluginBuild: "unknown", epoch: 2 });
    },
    TIMEOUT_MS
  );
});

describe("the leader start time", () => {
  test(
    "leaderStartedAt is an ISO 8601 UTC time, and a new leader process has a new value",
    async () => {
      const first = await startLeader();
      const startedFirst = (await ping(first.port)).leaderStartedAt;
      expect(startedFirst).toMatch(ISO_UTC);
      expect((await listFiles(first.leader)).leaderStartedAt).toBe(startedFirst);
      await first.leader.close();

      const second = await startLeader();
      const startedSecond = (await ping(second.port)).leaderStartedAt;
      expect(startedSecond).toMatch(ISO_UTC);
      expect(startedSecond).not.toBe(startedFirst);
      expect(Date.parse(startedSecond)).toBeGreaterThan(Date.parse(startedFirst));
    },
    TIMEOUT_MS
  );
});

describe("a follower", () => {
  test(
    "reports its own commit, the commit of the leader, and the same files",
    async () => {
      // A copy of the build whose build-info.json names another commit, so the
      // leader and the follower differ. It needs package.json (the version) and
      // node_modules (the packages) beside dist/.
      const copy = await h.tempDir("leader-build");
      await cp(join(SERVER_ROOT, "dist"), join(copy, "dist"), { recursive: true });
      await cp(join(SERVER_ROOT, "package.json"), join(copy, "package.json"));
      await h.folderLink(join(SERVER_ROOT, "node_modules"), join(copy, "node_modules"));
      const leaderCommit = "1".repeat(40);
      await writeFile(
        join(copy, "dist", "build-info.json"),
        JSON.stringify({ bridgeCommit: leaderCommit })
      );

      const port = await h.freePort();
      const leader = await h.server({
        port,
        cwd: await h.tempDir("leader-cwd"),
        entry: join(copy, "dist", "index.js"),
      });
      expect(leader.role).toBe("LEADER");
      await h.plugin({
        port,
        fileKey: "follower-file",
        fileName: "f",
        pluginBuild: "test-build-1",
      });

      const follower = await h.server({ port, cwd: await h.tempDir("follower-cwd") });
      expect(follower.role).toBe("FOLLOWER");

      const fromLeader = await listFiles(leader);
      const fromFollower = await listFiles(follower);

      expect(fromLeader.bridgeCommit).toBe(leaderCommit);
      expect(fromLeader.leaderCommit).toBe(leaderCommit);
      expect(fromFollower.bridgeCommit).toBe(expectedCommit());
      expect(fromFollower.leaderCommit).toBe(leaderCommit);
      expect(fromFollower.leaderStartedAt).toBe(fromLeader.leaderStartedAt);
      expect(fromFollower.files).toEqual(fromLeader.files);
      expect(fromFollower.files[0]).toMatchObject({ fileKey: "follower-file", epoch: 1 });
    },
    TIMEOUT_MS
  );
});

describe("the identity helper", () => {
  const report = (files: ConnectedFile[]): IdentityReport => ({
    bridgeCommit: "serving",
    leaderCommit: "leading",
    leaderStartedAt: "2000-01-01T00:00:00.000Z",
    files,
  });
  const fileA: ConnectedFile = { fileKey: "a", fileName: "A", pluginBuild: "pb-a", epoch: 4 };
  const fileB: ConnectedFile = { fileKey: "b", fileName: "B", pluginBuild: "pb-b", epoch: 7 };

  test("with one file connected and no key, it returns that file", () => {
    expect(fileIdentity(report([fileA]))).toEqual({
      ...fileA,
      bridgeCommit: "serving",
      leaderCommit: "leading",
      leaderStartedAt: "2000-01-01T00:00:00.000Z",
    });
  });

  test("with two files connected and no key, it fails and names both", () => {
    expect(() => fileIdentity(report([fileA, fileB]))).toThrow(/Multiple files connected/);
    expect(() => fileIdentity(report([fileA, fileB]))).toThrow(/"A".*"B"/);
  });

  test("with a key, it returns that file; with an unknown key or no file, it fails", () => {
    expect(fileIdentity(report([fileA, fileB]), "b")).toMatchObject({ fileKey: "b", epoch: 7 });
    expect(() => fileIdentity(report([fileA]), "c")).toThrow(/No plugin connected for fileKey "c"/);
    expect(() => fileIdentity(report([]))).toThrow(/No plugin connected/);
  });

  test("resolveFileIdentity reads the report from its source", async () => {
    const source = { identityReport: async () => report([fileB]) };
    expect(await resolveFileIdentity(source)).toMatchObject({ fileKey: "b", epoch: 7 });
  });
});
