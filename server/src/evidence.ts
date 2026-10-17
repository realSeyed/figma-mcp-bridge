/**
 * Evidence files: what a dump or a capture writes, and the manifest that
 * describes it.
 *
 * Interface:
 *   canonicalJson(value)        The canonical JSON text of a value.
 *   canonicalBytes(value)       That text as UTF-8 bytes.
 *   sha256Hex(bytes)            The SHA-256 of the bytes, as lowercase hexadecimal.
 *   utcTimestamp(date)          ISO 8601 UTC with milliseconds.
 *   folderTimestamp(date)       The same time as `YYYYMMDDTHHmmssZ`, for a folder name.
 *   sessionChange(a, b)         What changed between two identities of one file.
 *   manifestEnvelope(...)       The fields each manifest starts with.
 *   EvidenceSet                 The files of one call: each is written as
 *                               `<name>.partial` and published as `<name>` at
 *                               the end, or removed when the call fails.
 *
 * Evidence is append-only: no file is ever overwritten. A call that fails
 * leaves no file that can pass as complete.
 *
 * This module imports only Node built-in modules, `output-root.ts`, and
 * `identity.ts`, so that an extension file can import it.
 */

import { createHash } from "node:crypto";
import { link, lstat, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { fileIdentity } from "./identity.js";
import { checkOutputRoot, resolveEvidencePath, writeEvidenceFile } from "./output-root.js";

/** The identity of one file, as a manifest records it. */
export type EvidenceIdentity = ReturnType<typeof fileIdentity>;

/** The suffix of a file that is not complete yet. */
export const PARTIAL_SUFFIX = ".partial";

/**
 * The canonical JSON text of a value: object keys sorted by UTF-16 code unit,
 * arrays in their order, no whitespace, numbers and strings as
 * `JSON.stringify` writes them. An `undefined`, a function, or a symbol is
 * left out of an object and written as `null` in an array, as
 * `JSON.stringify` does. The text has no trailing newline.
 * @param value - Plain JSON data: objects, arrays, strings, numbers, booleans, null.
 * @returns The text.
 * @throws If the value has no JSON form, or holds a bigint.
 */
export function canonicalJson(value: unknown): string {
  const text = writeValue(value, "$");
  if (text === undefined) {
    throw new Error(`canonicalJson cannot write a value of the type ${typeof value}.`);
  }
  return text;
}

function writeValue(value: unknown, at: string): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "bigint":
      throw new Error(`canonicalJson cannot write the bigint at ${at}: JSON has no such number.`);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) => writeValue(item, `${at}[${index}]`) ?? "null");
    return `[${items.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  // The default sort compares UTF-16 code units.
  for (const key of Object.keys(record).sort()) {
    const text = writeValue(record[key], `${at}.${key}`);
    if (text !== undefined) fields.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${fields.join(",")}}`;
}

/**
 * The canonical JSON of a value as UTF-8, with no byte order mark.
 * @param value - Plain JSON data.
 * @returns The bytes.
 */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

/**
 * The SHA-256 of the exact bytes.
 * @param bytes - The bytes.
 * @returns 64 lowercase hexadecimal characters.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A time as ISO 8601 UTC with milliseconds.
 * @param date - The time. The default is now.
 * @returns For example `2026-01-01T00:00:00.000Z`.
 */
export function utcTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * A time in the compact UTC form, which a folder name can hold on each system.
 * @param date - The time. The default is now.
 * @returns For example `20260101T000000Z`.
 */
export function folderTimestamp(date: Date = new Date()): string {
  return utcTimestamp(date)
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

/**
 * Compares two identities of one file, read at the start and at the end of a
 * call. A changed epoch or plugin build shows that another plugin session
 * served part of the call. A changed leader start shows a restarted leader,
 * whose epochs start again at 1, so its epoch alone can look unchanged.
 * @param before - The identity at the start.
 * @param after - The identity at the end.
 * @returns Each change as `field before -> after`, or null when nothing changed.
 */
export function sessionChange(before: EvidenceIdentity, after: EvidenceIdentity): string | null {
  const fields = ["epoch", "pluginBuild", "leaderStartedAt"] as const;
  const changes = fields
    .filter((field) => before[field] !== after[field])
    .map((field) => `${field} ${before[field]} -> ${after[field]}`);
  return changes.length > 0 ? changes.join(", ") : null;
}

/** The fields each manifest starts with. A tool adds its own fields. */
export interface ManifestEnvelope<File> {
  tool: string;
  fileKey: string;
  bridgeCommit: string;
  leaderCommit: string;
  pluginBuild: string;
  epoch: number;
  leaderStartedAt: string;
  /** The real path of the output root. */
  outputRoot: string;
  startedAt: string;
  finishedAt: string;
  files: File[];
}

/**
 * The fields each manifest starts with.
 * @param tool - The tool name.
 * @param identity - The identity of the file, read at the start of the call.
 * @param outputRoot - The real path of the output root.
 * @param startedAt - When the call started.
 * @param finishedAt - When the last evidence file was published.
 * @param files - One entry for each evidence file.
 * @returns The envelope. It holds no `fileName`: the manifest names the file by its key.
 */
export function manifestEnvelope<File>(
  tool: string,
  identity: EvidenceIdentity,
  outputRoot: string,
  startedAt: string,
  finishedAt: string,
  files: File[]
): ManifestEnvelope<File> {
  return {
    tool,
    fileKey: identity.fileKey,
    bridgeCommit: identity.bridgeCommit,
    leaderCommit: identity.leaderCommit,
    pluginBuild: identity.pluginBuild,
    epoch: identity.epoch,
    leaderStartedAt: identity.leaderStartedAt,
    outputRoot,
    startedAt,
    finishedAt,
    files,
  };
}

/** One evidence file of a call, once it is written. */
export interface WrittenEvidence {
  /** The file name, without `.partial`. */
  name: string;
  /** The path relative to the output root, with `/`. */
  path: string;
  /** The SHA-256 of the bytes written. */
  sha256: string;
  /** How many bytes were written. */
  bytes: number;
}

/**
 * The evidence files of one call, in one folder under the output root.
 *
 * `open` refuses the call when a target name is taken, before the call does
 * any work. `write` writes `<name>.partial` with the flag `wx`. `publish`
 * gives each partial file its final name, and refuses a name that another
 * writer took in the meantime. `discard` removes each file this call wrote,
 * partial or published, and each folder it made that is empty again.
 */
export class EvidenceSet {
  /** The partial files of this call, as real paths, in the order written. */
  private readonly partials: string[] = [];
  /** The files this call published, as real paths. */
  private readonly published: string[] = [];

  private constructor(
    private readonly outputPath: string,
    /** The real path of the output root. */
    readonly realRoot: string,
    /** The folder of the files, as resolved against the root. */
    private readonly lexicalFolder: string,
    /** The folders that did not exist at `open`, deepest first. */
    private readonly newFolders: string[]
  ) {}

  /**
   * Checks the root and the folder, and refuses a name that is taken.
   * Makes nothing.
   * @param outputPath - The folder, relative to the output root or absolute inside it.
   * @param names - Each file name the call will publish. At least one.
   * @returns The set.
   * @throws If the root is unusable, the folder is outside it, or a name is taken.
   */
  static async open(outputPath: string, names: readonly string[]): Promise<EvidenceSet> {
    const realRoot = await checkOutputRoot();
    const taken: string[] = [];
    for (const name of names) {
      for (const candidate of [name, `${name}${PARTIAL_SUFFIX}`]) {
        const target = await resolveEvidencePath(path.join(outputPath, candidate));
        if (await entryExists(target, outputPath)) taken.push(target);
      }
    }
    if (taken.length > 0) {
      throw new EvidenceTakenError(
        `outputPath "${outputPath}" already holds ${taken.join(", ")}. Evidence is never overwritten: give a new outputPath, or leave it out for a new folder.`,
        taken
      );
    }

    const lexicalFolder = path.dirname(await resolveEvidencePath(path.join(outputPath, names[0])));
    const newFolders: string[] = [];
    let current = lexicalFolder;
    while (!(await entryExists(current, outputPath))) {
      newFolders.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return new EvidenceSet(outputPath, realRoot, lexicalFolder, newFolders);
  }

  /**
   * Writes one file as `<name>.partial`.
   * @param name - The final file name.
   * @param bytes - The exact bytes.
   * @returns The path the file will have, its SHA-256, and its size.
   */
  async write(name: string, bytes: Uint8Array): Promise<WrittenEvidence> {
    const relative = path.join(this.outputPath, `${name}${PARTIAL_SUFFIX}`);
    const target = await resolveEvidencePath(relative);
    // A failed write leaves no file of its own, so only a written file is tracked.
    const written = await writeEvidenceFile(relative, bytes);
    const real = path.join(await realpath(path.dirname(target)), path.basename(target));
    this.partials.push(real);
    return {
      name,
      path: this.relativePath(real.slice(0, -PARTIAL_SUFFIX.length)),
      sha256: sha256Hex(bytes),
      bytes: written,
    };
  }

  /**
   * Gives each partial file its final name, in the order written. A hard link
   * refuses a final name that exists, so a file that another writer made since
   * `open` is never replaced; where the file system has no hard links, the
   * name is checked and the file renamed.
   * @throws If a final name is taken. The caller then calls `discard`.
   */
  async publish(): Promise<void> {
    while (this.partials.length > 0) {
      const partial = this.partials[0];
      const final = partial.slice(0, -PARTIAL_SUFFIX.length);
      let linked = false;
      try {
        await link(partial, final);
        linked = true;
      } catch (err) {
        const code = errorCode(err);
        if (code === "EEXIST") throw takenError(final);
        if (!NO_HARD_LINK.has(code ?? "")) throw err;
      }
      if (linked) {
        this.published.push(final);
        // Until the unlink succeeds, the partial file stays tracked for `discard`.
        await unlink(partial);
      } else {
        if (await entryExists(final, this.outputPath)) throw takenError(final);
        await rename(partial, final);
        this.published.push(final);
      }
      this.partials.shift();
    }
  }

  /**
   * Removes each file this call wrote, partial or published, and each folder
   * it made that is empty again.
   * @returns Each path that could not be removed. Empty when nothing remains.
   */
  async discard(): Promise<string[]> {
    const remaining: string[] = [];
    for (const file of [...this.published, ...this.partials]) {
      try {
        await unlink(file);
      } catch (err) {
        if (errorCode(err) !== "ENOENT") remaining.push(file);
      }
    }
    this.published.length = 0;
    this.partials.length = 0;
    for (const folder of this.newFolders) {
      try {
        // Only a real folder inside the root, never a link that took its place.
        const info = await lstat(folder);
        if (!info.isDirectory() || !isInside(this.realRoot, await realpath(folder))) break;
        await rmdir(folder);
      } catch {
        // Not empty, or already gone: leave it, and each folder above it.
        break;
      }
    }
    return remaining;
  }

  /**
   * A real path inside the root, relative to the root, with `/`.
   * @param real - The real path.
   * @returns For example `dumps/20260101T000000Z/1_2.json`.
   */
  relativePath(real: string): string {
    const relative = path.relative(this.realRoot, real);
    return relative === "" ? "." : relative.split(path.sep).join("/");
  }

  /**
   * The path that `write` will report for a name, before the file exists: the
   * deepest existing part is resolved to its real path, the rest is appended.
   * A manifest can hold its own path with it. Makes nothing.
   * @param name - The final file name, as `write` takes it.
   * @returns The path relative to the output root, with `/`.
   */
  async plannedPath(name: string): Promise<string> {
    const target = await resolveEvidencePath(path.join(this.outputPath, name));
    const rest = [path.basename(target)];
    let existing = path.dirname(target);
    for (;;) {
      try {
        return this.relativePath(path.join(await realpath(existing), ...rest));
      } catch (err) {
        const parent = path.dirname(existing);
        if (parent === existing) throw err;
        rest.unshift(path.basename(existing));
        existing = parent;
      }
    }
  }

  /**
   * The real folder of the files, relative to the root, with `/`. Call it
   * after the first write, when the folder exists.
   * @returns `.` when the files are in the root itself.
   */
  async folder(): Promise<string> {
    return this.relativePath(await realpath(this.lexicalFolder));
  }
}

/** `EvidenceSet.open` refused the call because a target name is taken. */
export class EvidenceTakenError extends Error {
  constructor(
    message: string,
    /** Each path that is taken, as an absolute path. */
    readonly taken: readonly string[]
  ) {
    super(message);
    this.name = "EvidenceTakenError";
  }
}

/** The codes of a file system that has no hard links. */
const NO_HARD_LINK = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EINVAL"]);

/** True when an entry of any kind has this name. */
async function entryExists(target: string, outputPath: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return false;
    if (code === "ENOTDIR") {
      throw new Error(
        `outputPath "${outputPath}" is refused: a part of ${target} is a file, not a folder. Give a folder for outputPath.`
      );
    }
    throw err;
  }
}

function takenError(final: string): Error {
  return new Error(
    `${final} appeared during the call, so it is not overwritten. Evidence is never overwritten: give a new outputPath.`
  );
}

/** True when `candidate` is `root` or lies under it. Ignores case on Windows. */
function isInside(root: string, candidate: string): boolean {
  const comparable = (p: string): string => {
    const trimmed = path.normalize(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const a = comparable(root);
  const b = comparable(candidate);
  return b === a || b.startsWith(a + path.sep);
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}
