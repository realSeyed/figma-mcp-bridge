/**
 * The output root: the one folder tree this process writes evidence files in
 * (captures, dumps, and their manifests).
 *
 * `FIGMA_BRIDGE_OUTPUT_ROOT` names the root. The process reads it one time, at
 * start. When it is unset or empty, the root is the working directory of the
 * process. When it is set, the process never makes the folder and never falls
 * back to the working directory: a missing or unusable root fails each write.
 *
 * Interface:
 *   describeOutputRoot()             The start log line.
 *   checkOutputRoot()                Fails unless the root exists, is a folder,
 *                                    and is writable. Returns its real path.
 *   resolveEvidencePath(outputPath)  Resolves a relative path against the root,
 *                                    and refuses a path whose real location is
 *                                    outside the real root. Makes nothing.
 *                                    Returns the absolute path.
 *   writeEvidenceFile(path, bytes)   Does the same checks again, makes each
 *                                    missing folder one level at a time with a
 *                                    real-path check after each one, and writes
 *                                    a new file. It never overwrites a file,
 *                                    and a write that fails removes the file
 *                                    it opened. Returns the number of bytes
 *                                    written.
 *
 * Containment is by real path, so a `..` segment, an absolute path elsewhere,
 * and a symbolic link or a junction inside the root that points out of it are
 * all refused. On Windows the compare ignores case.
 */

import { constants, existsSync } from "node:fs";
import { access, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";

const ROOT_VARIABLE = "FIGMA_BRIDGE_OUTPUT_ROOT";

interface OutputRoot {
  /** The absolute root, as configured. It can hold a link; the checks use its real path. */
  path: string;
  /** Where the root came from. */
  source: "variable" | "working directory";
}

function readOutputRoot(): OutputRoot {
  const raw = process.env[ROOT_VARIABLE]?.trim();
  if (raw) return { path: path.resolve(raw), source: "variable" };
  return { path: process.cwd(), source: "working directory" };
}

const ROOT = readOutputRoot();

/**
 * The line the server logs at start.
 * @returns For example `Output root: C:\audit-output (FIGMA_BRIDGE_OUTPUT_ROOT)`.
 */
export function describeOutputRoot(): string {
  const source = ROOT.source === "variable" ? ROOT_VARIABLE : "working directory";
  const missing =
    ROOT.source === "variable" && !existsSync(ROOT.path)
      ? ` - the folder does not exist, so each write fails until it does`
      : "";
  return `Output root: ${ROOT.path} (${source})${missing}`;
}

/**
 * Makes sure that the root exists, is a folder, and is writable.
 * @returns The real path of the root.
 */
export async function checkOutputRoot(): Promise<string> {
  const unusable = (cause: string): Error => {
    const where =
      ROOT.source === "variable"
        ? `${ROOT_VARIABLE} names ${ROOT.path}`
        : `The output root is the working directory ${ROOT.path}, because ${ROOT_VARIABLE} is not set`;
    const correction =
      ROOT.source === "variable"
        ? `Make that folder, or set ${ROOT_VARIABLE} to a writable folder and restart the server.`
        : `Set ${ROOT_VARIABLE} to a writable folder and restart the server.`;
    return new Error(`${where}, but ${cause}. ${correction}`);
  };

  let info;
  try {
    info = await stat(ROOT.path);
  } catch (err) {
    if (errorCode(err) === "ENOENT") throw unusable("that folder does not exist");
    throw unusable(`it cannot be read (${errorMessage(err)})`);
  }
  if (!info.isDirectory()) throw unusable("it is not a folder");
  try {
    await access(ROOT.path, constants.W_OK);
  } catch (err) {
    throw unusable(`it is not writable (${errorMessage(err)})`);
  }
  return realpath(ROOT.path);
}

/**
 * Resolves an output path against the root and makes sure that its real
 * location is inside the real root. Makes nothing.
 * @param outputPath - A path relative to the root, or an absolute path inside it.
 * @returns The absolute path.
 */
export async function resolveEvidencePath(outputPath: string): Promise<string> {
  const realRoot = await checkOutputRoot();
  const target = path.resolve(ROOT.path, outputPath);
  await assertContained(outputPath, target, realRoot);
  return target;
}

/**
 * Writes a new evidence file inside the root.
 * @param outputPath - A path relative to the root, or an absolute path inside it.
 * @param bytes - The file contents.
 * @returns The number of bytes written.
 */
export async function writeEvidenceFile(outputPath: string, bytes: Uint8Array): Promise<number> {
  const realRoot = await checkOutputRoot();
  const target = path.resolve(ROOT.path, outputPath);
  await assertContained(outputPath, target, realRoot);

  // Make each missing folder one level at a time, and check where it really
  // landed before going one level deeper. A link that appears between two
  // steps then cannot carry the write out of the root.
  const missing: string[] = [];
  let existing = path.dirname(target);
  while (!(await exists(existing))) {
    missing.unshift(existing);
    existing = path.dirname(existing);
  }
  for (const folder of missing) {
    try {
      await mkdir(folder);
    } catch (err) {
      if (errorCode(err) !== "EEXIST") {
        throw new Error(
          `Could not make the folder ${folder} for outputPath "${outputPath}": ${errorMessage(err)}`
        );
      }
    }
    let realFolder: string;
    try {
      realFolder = await realpath(folder);
    } catch (err) {
      throw refusal(
        outputPath,
        `the folder ${folder} cannot be resolved (${errorMessage(err)})`,
        realRoot
      );
    }
    if (!isInside(realRoot, realFolder)) {
      throw refusal(outputPath, `the folder ${folder} resolves to ${realFolder}`, realRoot);
    }
  }

  // Open the file in its real folder, so only the final name is left to the
  // file system. The flag `wx` fails on any entry with that name, a link too.
  const realFolder = await realpath(path.dirname(target));
  if (!isInside(realRoot, realFolder)) {
    throw refusal(outputPath, `its folder resolves to ${realFolder}`, realRoot);
  }
  const finalPath = path.join(realFolder, path.basename(target));
  let handle;
  try {
    handle = await open(finalPath, "wx");
  } catch (err) {
    if (errorCode(err) === "EEXIST") {
      throw new Error(
        `File already exists at outputPath: ${target}. The output root never overwrites a file. Choose a new name.`
      );
    }
    throw new Error(
      `Could not write outputPath "${outputPath}" at ${target}: ${errorMessage(err)}`
    );
  }
  try {
    await handle.writeFile(bytes);
  } catch (err) {
    // The file is this call's own, so a write that fails leaves no part of it.
    await handle.close().catch(() => undefined);
    await unlink(finalPath).catch(() => undefined);
    throw new Error(
      `Could not write outputPath "${outputPath}" at ${target}: ${errorMessage(err)}`
    );
  }
  await handle.close();
  return bytes.byteLength;
}

/**
 * Refuses the root itself, and a target whose deepest existing folder or file
 * is really outside the real root.
 */
async function assertContained(
  outputPath: string,
  target: string,
  realRoot: string
): Promise<void> {
  if (samePath(target, ROOT.path)) {
    throw refusal(outputPath, "it names the output root itself, not a file in it", realRoot);
  }

  let existing = target;
  let realExisting: string | null = null;
  for (;;) {
    try {
      realExisting = await realpath(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }

  if (realExisting !== null && isInside(realRoot, realExisting)) {
    if (samePath(realExisting, realRoot) && existing === target) {
      throw refusal(outputPath, "it names the output root itself, not a file in it", realRoot);
    }
    return;
  }

  let cause: string;
  if (!isInside(ROOT.path, target) && !isInside(realRoot, target)) {
    cause = path.isAbsolute(outputPath)
      ? `the absolute path ${target} is outside the root`
      : `a ".." segment leads out of the root to ${target}`;
  } else if (realExisting === null) {
    cause = `no part of ${target} exists`;
  } else {
    cause = `${existing} is a link that resolves to ${realExisting}`;
  }
  throw refusal(outputPath, cause, realRoot);
}

function refusal(outputPath: string, cause: string, realRoot: string): Error {
  return new Error(
    `outputPath "${outputPath}" is refused: ${cause}. The real output root is ${realRoot}. Use a path inside the output root, for example a relative path such as "captures/frame.png".`
  );
}

/** True when `candidate` is `root` or lies under it. Ignores case on Windows. */
function isInside(root: string, candidate: string): boolean {
  const a = comparable(root);
  const b = comparable(candidate);
  return b === a || b.startsWith(a + path.sep);
}

function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

function comparable(p: string): string {
  const trimmed = path.normalize(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
