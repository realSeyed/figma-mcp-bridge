/**
 * The identifier of one plugin build, for both Vite configurations.
 *
 * `<commit>[-dirty]+<the first 16 hexadecimal characters of a SHA-256>`. The
 * commit is the full git hash, with `-dirty` when `git status --porcelain`
 * prints a line (less the temporary config files of Vite), and `unknown` without git or outside a repository. The
 * SHA-256 covers each file under `src/` and five files of the plugin folder,
 * in sorted path order. Each file adds its relative path and its bytes.
 *
 * A change to any of these files makes a new identifier, also when the commit
 * stays the same. Both builds compute it from the same files, so the window
 * and the main code get the same value.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));

/** The files outside `src/` that the identifier covers. */
const COVERED_FILES = [
  "manifest.json",
  "package.json",
  "bun.lock",
  "vite.config.ts",
  "vite.config.main.ts",
];

/**
 * Vite bundles a config file to `<config>.timestamp-<time>-<hash>.mjs` in the
 * plugin folder, imports it, and deletes it. The identifier is computed while
 * the file exists, so `git status` lists it as untracked. It is no change to
 * the tree, and counting it would make `code.js` dirty and `index.html` clean.
 */
const VITE_TEMP_CONFIG = /\.timestamp-\d+-[0-9a-f]+\.mjs$/;

/**
 * Runs git in the plugin folder.
 * @param args - The arguments of git.
 * @returns The standard output, or "" when git fails.
 */
function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: PLUGIN_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/**
 * Each file under a folder, as a path relative to the plugin folder with `/`.
 * @param folder - The relative path of the folder.
 */
function listFiles(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(PLUGIN_ROOT, folder), { withFileTypes: true })) {
    const relative = `${folder}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

/**
 * The commit part of the identifier.
 * @returns The hash, `<hash>-dirty`, or `unknown`.
 */
function commitPart(): string {
  const hash = git(["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(hash)) return "unknown";
  const changes = git(["status", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !VITE_TEMP_CONFIG.test(line));
  return changes.length === 0 ? hash : `${hash}-dirty`;
}

/**
 * The content part of the identifier.
 * @returns The first 16 hexadecimal characters of the SHA-256.
 */
function contentPart(): string {
  const paths = [...listFiles("src"), ...COVERED_FILES].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const hash = createHash("sha256");
  for (const relative of paths) {
    const bytes = readFileSync(join(PLUGIN_ROOT, relative));
    // The length keeps one file from running into the next.
    hash.update(`${relative}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * The identifier of the plugin build.
 * @returns For example `<40 hex>-dirty+0123456789abcdef`.
 */
export function pluginBuildId(): string {
  return `${commitPart()}+${contentPart()}`;
}
