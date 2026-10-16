import { readFileSync } from "node:fs";

/**
 * The git commit of this build: the full hash, plus `-dirty` when the tree
 * held uncommitted changes. `scripts/write-build-info.mjs` writes
 * `build-info.json` next to the compiled modules. `"unknown"` when the file is
 * missing, as when the code runs from `src/`.
 */
function readBridgeCommit(): string {
  try {
    const info = JSON.parse(
      readFileSync(new URL("./build-info.json", import.meta.url), "utf8")
    ) as { bridgeCommit?: unknown };
    if (typeof info.bridgeCommit === "string" && info.bridgeCommit !== "") {
      return info.bridgeCommit;
    }
  } catch {
    // No file, or not JSON: the build is unknown.
  }
  return "unknown";
}

export const BRIDGE_COMMIT = readBridgeCommit();
