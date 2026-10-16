/**
 * Writes `dist/build-info.json` after `tsc`: the git commit of this build.
 *
 * The commit is the full hash of 40 characters, plus `-dirty` when
 * `git status --porcelain` prints a line. Without git, or outside a
 * repository, it is `"unknown"`. The server reads the file at run time to
 * report `bridgeCommit`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Runs git in the server folder.
 * @param {string[]} args - The arguments of git.
 * @returns {string} The standard output, or "" when git fails.
 */
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: serverRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

const hash = git(["rev-parse", "HEAD"]).trim();
let bridgeCommit = "unknown";
if (/^[0-9a-f]{40}$/.test(hash)) {
  const dirty = git(["status", "--porcelain"]).trim() !== "";
  bridgeCommit = dirty ? `${hash}-dirty` : hash;
}

const distFolder = join(serverRoot, "dist");
mkdirSync(distFolder, { recursive: true });
writeFileSync(
  join(distFolder, "build-info.json"),
  `${JSON.stringify({ bridgeCommit }, null, 2)}\n`
);
console.log(`build-info.json: bridgeCommit ${bridgeCommit}`);
