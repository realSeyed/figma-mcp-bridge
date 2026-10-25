/**
 * The install token: a secret that each `/rpc` request to the leader carries in
 * `Authorization: Bearer <token>`. All bridge processes of one install read the
 * same file, so a follower and its leader share the token without a handshake.
 *
 * The file:
 *   FIGMA_BRIDGE_TOKEN_FILE                        when it is set and not empty
 *   %APPDATA%\figma-mcp-bridge\rpc-token           on Windows
 *   $XDG_CONFIG_HOME/figma-mcp-bridge/rpc-token    elsewhere
 *   ~/.config/figma-mcp-bridge/rpc-token           when XDG_CONFIG_HOME is not set
 *
 * The first process that finds no file makes it: 32 random bytes as
 * hexadecimal, in a folder with mode 0o700, with the flag `wx` and mode 0o600.
 * On POSIX systems a file that the group or others can read is refused. On
 * Windows the ACL is not changed: the folder is in the profile of the user,
 * which only the user and the administrators can read.
 *
 * Each process reads the token one time and keeps it in memory. The token is
 * never logged, and no error message holds it.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TOKEN_FILE_VARIABLE = "FIGMA_BRIDGE_TOKEN_FILE";

/** 128 bits as hexadecimal. */
const MIN_TOKEN_LENGTH = 32;
const TOKEN_PATTERN = /^[0-9a-fA-F]+$/;

/** A process that lost the race to make the file can read it before the winner wrote it. */
const READ_ATTEMPTS = 20;
const READ_RETRY_MS = 50;

let cached: string | undefined;

/**
 * The path of the token file of this process.
 * @returns An absolute path, or the value of FIGMA_BRIDGE_TOKEN_FILE.
 */
export function tokenFilePath(): string {
  const set = process.env[TOKEN_FILE_VARIABLE];
  if (set !== undefined && set.trim() !== "") return set.trim();
  return join(installStateFolder(), "rpc-token");
}

/**
 * The state folder of the install: the folder of the default token file. It
 * does not follow FIGMA_BRIDGE_TOKEN_FILE.
 * @returns An absolute path.
 */
export function installStateFolder(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "figma-mcp-bridge");
  }
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "figma-mcp-bridge");
}

/**
 * The install token. Reads the file at the first call, and makes it when it is
 * absent. Later calls return the token from memory.
 * @returns The token.
 * @throws If the file cannot be made or read, is readable by others, or holds no valid token.
 */
export function rpcToken(): string {
  if (cached === undefined) cached = loadToken(tokenFilePath());
  return cached;
}

function loadToken(file: string): string {
  if (!exists(file)) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (err) {
      // EEXIST: another process made the file first. Read that file.
      if (errorCode(err) !== "EEXIST") {
        throw new Error(
          `The install token file ${file} could not be made: ${describe(err)}. ` +
            `Make sure that the folder can be written, or set ${TOKEN_FILE_VARIABLE} to another path.`
        );
      }
    }
  }

  checkPermissions(file);

  for (let attempt = 1; ; attempt++) {
    let content: string;
    try {
      content = readFileSync(file, "utf8").trim();
    } catch (err) {
      throw new Error(
        `The install token file ${file} could not be read: ${describe(err)}. ` +
          `Remove the file; the next bridge process makes a new one.`
      );
    }
    if (content.length >= MIN_TOKEN_LENGTH && TOKEN_PATTERN.test(content)) return content;
    if (attempt >= READ_ATTEMPTS) {
      throw new Error(
        `The install token file ${file} holds no valid token: it must hold at least ` +
          `${MIN_TOKEN_LENGTH} hexadecimal characters. Remove the file; the next bridge ` +
          `process makes a new one.`
      );
    }
    sleep(READ_RETRY_MS);
  }
}

function checkPermissions(file: string): void {
  if (process.platform === "win32") return;
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch (err) {
    throw new Error(
      `The install token file ${file} could not be read: ${describe(err)}. ` +
        `Remove the file; the next bridge process makes a new one.`
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `The install token file ${file} can be read by the group or by others ` +
        `(mode ${(mode & 0o777).toString(8)}). Run \`chmod 600 ${file}\`.`
    );
  }
}

function exists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw new Error(
      `The install token file ${file} could not be read: ${describe(err)}. ` +
        `Make sure that the folder can be read, or set ${TOKEN_FILE_VARIABLE} to another path.`
    );
  }
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function describe(err: unknown): string {
  return errorCode(err) ?? (err instanceof Error ? err.message : String(err));
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
