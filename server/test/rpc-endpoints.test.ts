/**
 * BR-4: the leader listens on 127.0.0.1 only, and /rpc runs a tool only for a
 * JSON request with the install token. Runs real server processes and a
 * simulated plugin. Each process reads a token file in a temporary folder.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { Harness } from "./helpers/harness.js";
import type { SimulatedPlugin } from "./helpers/plugin.js";
import { postRpc, rawRpc } from "./helpers/rpc.js";
import { SERVER_ENTRY, serverEnv } from "./helpers/server-process.js";

const FILE_KEY = "harness-file";
const DOCUMENT = { id: "0:1", name: "Harness page", type: "PAGE" };
const TIMEOUT_MS = 60_000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.cleanup();
});

/** Starts a leader and connects the plugin, which answers get_document. */
async function leaderWithPlugin() {
  const port = await h.freePort();
  const leader = await h.server({ port, cwd: await h.tempDir("cwd") });
  expect(leader.role).toBe("LEADER");
  const plugin = await h.plugin({
    port,
    fileKey: FILE_KEY,
    handlers: { get_document: () => DOCUMENT },
  });
  return { port, leader, plugin };
}

const GET_DOCUMENT = JSON.stringify({ tool: "get_document", fileKey: FILE_KEY });

function pluginRequests(plugin: SimulatedPlugin) {
  return plugin.requests.map((request) => request.type);
}

/** Opens a TCP connection, then closes it. */
function tryConnect(host: string, port: number): Promise<{ open: boolean; code?: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 5_000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve({ open: true });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ open: false, code: "TIMEOUT" });
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve({ open: false, code: err.code });
    });
  });
}

/** Runs the server with a closed standard input, for a start that fails. */
function runServer(tokenFile: string, port: number) {
  return spawnSync("node", [SERVER_ENTRY], {
    env: serverEnv({ port, env: { FIGMA_BRIDGE_TOKEN_FILE: tokenFile } }),
    input: "",
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("the /rpc checks", () => {
  test(
    "a request without the token gets 401, and no tool runs",
    async () => {
      const { port, plugin } = await leaderWithPlugin();

      const answer = await rawRpc(port, {
        headers: { "Content-Type": "application/json" },
        body: GET_DOCUMENT,
      });
      expect(answer.status).toBe(401);
      expect(answer.body.error).toContain("Authorization: Bearer <token>");
      expect(answer.body.error).toContain("restart each bridge process");
      expect(answer.body.error).not.toContain(await h.token());
      expect(pluginRequests(plugin)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a request with a wrong token gets 403, and no tool runs",
    async () => {
      const { port, plugin } = await leaderWithPlugin();
      const token = await h.token();
      const wrong = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");

      const answers = [
        await postRpc(port, wrong, { tool: "get_document", fileKey: FILE_KEY }),
        await postRpc(port, "short", { tool: "get_document", fileKey: FILE_KEY }),
      ];
      for (const answer of answers) {
        expect(answer.status).toBe(403);
        expect(answer.body.error).toContain("is not the install token");
        expect(answer.body.error).not.toContain(token);
      }
      expect(pluginRequests(plugin)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a request with the token and another content type gets 415, and no tool runs",
    async () => {
      const { port, plugin } = await leaderWithPlugin();
      const authorization = `Bearer ${await h.token()}`;

      for (const contentType of [
        "text/plain",
        "application/x-www-form-urlencoded",
        "application/json; boundary=x",
        undefined,
      ]) {
        const headers: Record<string, string> = { Authorization: authorization };
        if (contentType !== undefined) headers["Content-Type"] = contentType;
        const answer = await rawRpc(port, { headers, body: GET_DOCUMENT });
        expect(answer.status).toBe(415);
        expect(answer.body.error).toContain("Content-Type: application/json");
      }
      expect(pluginRequests(plugin)).toEqual([]);
    },
    TIMEOUT_MS
  );

  test(
    "a JSON request with the token gets 200 and the tool result",
    async () => {
      const { port, plugin } = await leaderWithPlugin();
      const token = await h.token();

      const answer = await postRpc(port, token, { tool: "get_document", fileKey: FILE_KEY });
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ data: DOCUMENT });

      const withCharset = await rawRpc(port, {
        headers: {
          "Content-Type": "Application/JSON; charset=utf-8",
          Authorization: `bearer ${token}`,
        },
        body: GET_DOCUMENT,
      });
      expect(withCharset.status).toBe(200);
      expect(withCharset.body).toEqual({ data: DOCUMENT });

      expect(pluginRequests(plugin)).toEqual(["get_document", "get_document"]);
    },
    TIMEOUT_MS
  );

  test(
    "OPTIONS /rpc gets 405, and no answer allows a cross-origin caller",
    async () => {
      const { port, plugin } = await leaderWithPlugin();

      const preflight = await rawRpc(port, {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, authorization",
        },
      });
      expect(preflight.status).toBe(405);

      const answers = [
        preflight,
        await rawRpc(port, {
          headers: { Origin: "https://example.com", "Content-Type": "text/plain" },
          body: GET_DOCUMENT,
        }),
        await postRpc(port, await h.token(), { tool: "get_document", fileKey: FILE_KEY }),
      ];
      for (const answer of answers) {
        for (const name of answer.headers.keys()) {
          expect(name.toLowerCase().startsWith("access-control-allow")).toBe(false);
        }
      }
      expect(pluginRequests(plugin)).toEqual(["get_document"]);
    },
    TIMEOUT_MS
  );
});

describe("the bind", () => {
  test(
    "the leader accepts a connection on 127.0.0.1 only",
    async () => {
      const { port, leader } = await leaderWithPlugin();
      expect(leader.stderr.join("\n")).toContain(`Leader listening on 127.0.0.1:${port}`);

      expect(await tryConnect("127.0.0.1", port)).toEqual({ open: true });

      const external = Object.values(networkInterfaces())
        .flat()
        .filter((info) => info !== undefined && info.family === "IPv4" && !info.internal)
        .map((info) => info!.address);
      if (external.length === 0) {
        console.log(
          "The machine has no non-internal IPv4 address: the external bind check is skipped."
        );
        return;
      }
      for (const address of external) {
        const outcome = await tryConnect(address, port);
        expect({ address, open: outcome.open }).toEqual({ address, open: false });
      }
    },
    TIMEOUT_MS
  );
});

describe("the followers and the token file", () => {
  test(
    "the leader makes the token file, and a follower reads it and completes a tool call",
    async () => {
      const tokenFile = await h.tokenFile();
      expect(existsSync(tokenFile)).toBe(false);

      const { port, leader, plugin } = await leaderWithPlugin();
      const token = await h.token();
      expect(token).toMatch(TOKEN_PATTERN);
      if (process.platform !== "win32") {
        expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      }

      const follower = await h.server({ port, cwd: await h.tempDir("follower-cwd") });
      expect(follower.role).toBe("FOLLOWER");

      const outcome = await follower.callTool("get_document", { fileKey: FILE_KEY });
      expect(outcome).toEqual({ ok: true, data: DOCUMENT });
      expect(pluginRequests(plugin)).toEqual(["get_document"]);

      const files = await follower.callTool("list_files");
      expect(files.ok).toBe(true);
      expect(JSON.stringify(files)).toContain(FILE_KEY);

      // The follower read the token of the leader; it made no new one.
      expect(await h.token()).toBe(token);

      for (const line of [...leader.stderr, ...follower.stderr]) {
        expect(line).not.toContain(token);
      }
    },
    TIMEOUT_MS
  );

  test(
    "a token file that holds no valid token stops the process, and the error does not show the content",
    async () => {
      const tokenFile = join(await h.tempDir("bad-token"), "rpc-token");
      const content = "not-a-token-0123";
      await writeFile(tokenFile, content, { mode: 0o600 });

      const run = runServer(tokenFile, await h.freePort());
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(`The install token file ${tokenFile} holds no valid token`);
      expect(run.stderr).toContain("Remove the file");
      expect(run.stderr).not.toContain(content);
      expect(await readFile(tokenFile, "utf8")).toBe(content);
    },
    TIMEOUT_MS
  );

  test.skipIf(process.platform === "win32")(
    "on POSIX a token file that others can read stops the process",
    async () => {
      const tokenFile = join(await h.tempDir("open-token"), "rpc-token");
      const content = "0123456789abcdef".repeat(4);
      await writeFile(tokenFile, content);
      await chmod(tokenFile, 0o644);

      const run = runServer(tokenFile, await h.freePort());
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(`The install token file ${tokenFile} can be read`);
      expect(run.stderr).toContain(`chmod 600 ${tokenFile}`);
      expect(run.stderr).not.toContain(content);
    },
    TIMEOUT_MS
  );
});
