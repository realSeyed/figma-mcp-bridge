/**
 * The write journal (BR-8): the leader records each write request that it
 * sends to a plugin connection, with its response, in an append-only file
 * with a hash chain.
 *
 * The file:
 *   FIGMA_BRIDGE_JOURNAL_FILE                               when it is set and not empty
 *   <state folder of the install>/write-journal.jsonl       else (see rpc-token.ts)
 *
 * JSON Lines: one line for each entry, the canonical JSON of the whole entry,
 * then `\n`. UTF-8, no BOM. The `hash` of an entry is the SHA-256 of the
 * canonical JSON of the entry without `hash`; that JSON holds `prevHash`, the
 * `hash` of the entry before, or the genesis hash for the first entry.
 *
 * A request on `READ_ONLY_REQUESTS` adds no entry. Each other request that
 * reaches a plugin connection adds one, an unknown request type included.
 *
 * At start the leader reads the file and checks each line. A failure makes the
 * journal broken: the leader reports it, refuses each write, and never
 * truncates, repairs or rewrites the file. The journal keeps the count and the
 * head in memory, not the entries.
 *
 * The journal holds the params and the responses of each write: it is private
 * data of the owner.
 *
 * This module imports only Node built-in modules, `evidence.ts`,
 * `rpc-token.ts` and types.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalBytes, canonicalJson, sha256Hex, utcTimestamp } from "./evidence.js";
import { installStateFolder } from "./rpc-token.js";
import type { JournalState } from "./types.js";

export const JOURNAL_FILE_VARIABLE = "FIGMA_BRIDGE_JOURNAL_FILE";

/** The name of the journal file in the state folder of the install. */
export const JOURNAL_FILE_NAME = "write-journal.jsonl";

/** The `prevHash` of the first entry, and the head of an empty journal. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * The requests that add no entry. The list is a record of its own, written
 * out: it is not built from `AUDITOR_TOOLS`. A new read joins it only on
 * purpose, with its test.
 */
export const READ_ONLY_REQUESTS: ReadonlySet<string> = new Set([
  // The tools of the auditor role.
  "list_files",
  "get_document",
  "get_metadata",
  "get_node",
  "get_instance",
  "get_component",
  "list_components",
  "get_variable_defs",
  "get_styles",
  "list_fonts",
  "list_sections",
  "get_section",
  "dump_nodes",
  "save_screenshots",
  "scroll_and_zoom_into_view",
  // The internal commands of the auditor role.
  "dump_nodes_chunk",
  "get_screenshot",
  // The core reads that the auditor role does not register.
  "get_selection",
  "get_design_context",
  "get_motion_styles",
  "get_node_motion",
]);

/** What the plugin answered, or why the wait ended. */
export type JournalResponse = { data: unknown } | { error: string };

export interface JournalEntry {
  seq: number;
  timestamp: string;
  fileKey: string;
  epoch: number;
  auditor: boolean;
  tool: string;
  nodeIds: string[] | null;
  params: Record<string, unknown> | null;
  response: JournalResponse;
  prevHash: string;
  hash: string;
}

/** What the caller of `append` gives. The journal adds the rest. */
export type JournalRecord = Omit<JournalEntry, "seq" | "timestamp" | "prevHash" | "hash">;

const ENTRY_FIELDS = [
  "seq",
  "timestamp",
  "fileKey",
  "epoch",
  "auditor",
  "tool",
  "nodeIds",
  "params",
  "response",
  "prevHash",
  "hash",
] as const;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The path of the journal file of this process.
 * @returns The value of FIGMA_BRIDGE_JOURNAL_FILE, or the file in the state folder of the install.
 */
export function journalFilePath(): string {
  const set = process.env[JOURNAL_FILE_VARIABLE];
  if (set !== undefined && set.trim() !== "") return set.trim();
  return join(installStateFolder(), JOURNAL_FILE_NAME);
}

/**
 * The hash of an entry: the SHA-256 of the canonical JSON of the entry without
 * `hash`, as UTF-8.
 * @param entry - The entry, with or without `hash`.
 * @returns 64 lowercase hexadecimal characters.
 */
export function entryHash(entry: Omit<JournalEntry, "hash"> | JournalEntry): string {
  const fields: Record<string, unknown> = { ...entry };
  delete fields.hash;
  return sha256Hex(canonicalBytes(fields));
}

/**
 * The journal file of one leader. `load` reads and checks it; `append` adds
 * one entry and calls `fsync`. Only the leader makes one: a follower never
 * opens the file.
 */
export class WriteJournal {
  private entryCount = 0;
  private headHash = GENESIS_HASH;
  private brokenReason: string | null = null;
  private fd: number | null = null;

  /** @param file - The journal file. The default is `journalFilePath()`. */
  constructor(readonly file: string = journalFilePath()) {}

  /**
   * Reads the file and checks each line. A missing file is an empty journal.
   * Each other failure makes the journal broken and is logged one time. It
   * never throws, and it never changes the file.
   */
  load(): void {
    this.entryCount = 0;
    this.headHash = GENESIS_HASH;
    this.brokenReason = null;

    let bytes: Buffer;
    try {
      bytes = readFileSync(this.file);
    } catch (err) {
      if (errorCode(err) === "ENOENT") return;
      this.markBroken(`the file could not be read (${describe(err)})`);
      return;
    }

    const failure = this.checkLines(bytes);
    if (failure !== null) this.markBroken(failure);
  }

  /** The state for `/ping` and `list_files`. */
  state(): JournalState {
    const state: JournalState = {
      status: this.brokenReason === null ? "ok" : "broken",
      entryCount: this.entryCount,
      headHash: this.headHash,
    };
    if (this.brokenReason !== null) state.reason = this.brokenReason;
    return state;
  }

  /** Whether a request of this type adds an entry. */
  records(tool: string): boolean {
    return !READ_ONLY_REQUESTS.has(tool);
  }

  /**
   * The error of a write that the leader refuses because the journal is broken.
   * @param tool - The request type.
   * @returns The message, or null when the journal is not broken.
   */
  refusal(tool: string): string | null {
    if (this.brokenReason === null) return null;
    return (
      `${tool} was not sent to the plugin: the write journal ${this.file} is broken ` +
      `(${this.brokenReason}), and the leader refuses each write until the repair. ` +
      REPAIR
    );
  }

  /**
   * Adds one entry and calls `fsync`. Makes the folder (mode 0o700) and the
   * file (mode 0o600) at the first append.
   * @param record - What the leader sent and what came back.
   * @returns The entry as written.
   * @throws If the journal is broken, or the append fails. A failed append
   *   makes the journal broken.
   */
  append(record: JournalRecord): JournalEntry {
    const refused = this.refusal(record.tool);
    if (refused !== null) throw new Error(refused);

    const unhashed: Omit<JournalEntry, "hash"> = {
      seq: this.entryCount + 1,
      timestamp: utcTimestamp(),
      fileKey: record.fileKey,
      epoch: record.epoch,
      auditor: record.auditor,
      tool: record.tool,
      nodeIds: record.nodeIds,
      params: record.params,
      response: record.response,
      prevHash: this.headHash,
    };
    let entry: JournalEntry = { ...unhashed, hash: GENESIS_HASH };

    try {
      entry = { ...unhashed, hash: entryHash(unhashed) };
      const line = Buffer.from(`${canonicalJson(entry)}\n`, "utf8");
      const fd = this.open();
      for (let written = 0; written < line.length;) {
        written += writeSync(fd, line, written, line.length - written);
      }
      fsyncSync(fd);
    } catch (err) {
      const cause = `the append of entry ${entry.seq} failed (${describe(err)})`;
      this.markBroken(cause);
      throw new Error(
        `${record.tool}: the leader sent the request to the plugin, so the change can be in ` +
          `the Figma file, but the write journal ${this.file} could not record it: ${cause}. ` +
          `The journal is now broken, and the leader refuses each write until the repair. ` +
          REPAIR
      );
    }

    this.entryCount = entry.seq;
    this.headHash = entry.hash;
    return entry;
  }

  /** Closes the file. A later append opens it again. */
  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // The file is closed either way.
    }
    this.fd = null;
  }

  private open(): number {
    if (this.fd === null) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      this.fd = openSync(this.file, "a", 0o600);
    }
    return this.fd;
  }

  private markBroken(reason: string): void {
    if (this.brokenReason !== null) return;
    this.brokenReason = reason;
    console.error(`The write journal ${this.file} is broken: ${reason}. ${REPAIR}`);
  }

  /**
   * Checks each line, and sets the count and the head of the valid lines
   * before the first failure.
   * @returns The first failure as `line <n>: <cause>`, or null.
   */
  private checkLines(bytes: Buffer): string | null {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let previousHash = GENESIS_HASH;
    let lineNumber = 0;
    let start = 0;

    while (start < bytes.length) {
      lineNumber++;
      const end = bytes.indexOf(0x0a, start);
      if (end === -1) {
        return `line ${lineNumber}: the line does not end with a newline (a torn append)`;
      }

      let text: string;
      try {
        text = decoder.decode(bytes.subarray(start, end));
      } catch {
        return `line ${lineNumber}: the line is not valid UTF-8`;
      }
      start = end + 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return `line ${lineNumber}: the line is not JSON`;
      }
      let canonical: string;
      try {
        canonical = canonicalJson(parsed);
      } catch {
        canonical = "";
      }
      if (canonical !== text) {
        return `line ${lineNumber}: the line is not the canonical JSON of its entry`;
      }

      const fieldFailure = checkFields(parsed);
      if (fieldFailure !== null) return `line ${lineNumber}: ${fieldFailure}`;

      const entry = parsed as JournalEntry;
      if (entry.seq !== lineNumber) {
        return `line ${lineNumber}: seq is ${entry.seq}, not the line number ${lineNumber}`;
      }
      if (entry.prevHash !== previousHash) {
        return lineNumber === 1
          ? `line 1: prevHash is not the genesis hash`
          : `line ${lineNumber}: prevHash is not the hash of line ${lineNumber - 1}`;
      }
      if (entryHash(entry) !== entry.hash) {
        return `line ${lineNumber}: hash is not the SHA-256 of the entry without hash`;
      }
      previousHash = entry.hash;
      // The valid lines so far: a broken journal reports the count and the
      // head of the lines before the first bad one.
      this.entryCount = lineNumber;
      this.headHash = previousHash;
    }
    return null;
  }
}

/** The correction of a broken journal. */
const REPAIR =
  "To repair it: stop each bridge process, move the journal file aside and keep it for the " +
  "auditor, then start the bridge again; a new chain then starts at the genesis hash. Tell the auditor.";

/**
 * Checks that each field of an entry is present, with its type, and that no
 * other field is.
 * @returns The cause, or null.
 */
function checkFields(value: unknown): string | null {
  if (!isRecord(value)) return "the line is not a JSON object";
  for (const field of ENTRY_FIELDS) {
    if (!(field in value)) return `the field ${field} is missing`;
  }
  for (const field of Object.keys(value)) {
    if (!(ENTRY_FIELDS as readonly string[]).includes(field)) {
      return `the field ${field} is not a field of an entry`;
    }
  }

  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) {
    return "seq is not an integer of 1 or more";
  }
  if (typeof value.timestamp !== "string") return "timestamp is not a string";
  if (typeof value.fileKey !== "string") return "fileKey is not a string";
  if (!Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0) {
    return "epoch is not an integer of 0 or more";
  }
  if (typeof value.auditor !== "boolean") return "auditor is not a boolean";
  if (typeof value.tool !== "string") return "tool is not a string";
  if (
    value.nodeIds !== null &&
    !(Array.isArray(value.nodeIds) && value.nodeIds.every((id) => typeof id === "string"))
  ) {
    return "nodeIds is not null or an array of strings";
  }
  if (value.params !== null && !isRecord(value.params)) return "params is not null or an object";

  const response = value.response;
  const responseKeys = isRecord(response) ? Object.keys(response) : [];
  const validResponse =
    isRecord(response) &&
    responseKeys.length === 1 &&
    (responseKeys[0] === "data" ||
      (responseKeys[0] === "error" && typeof response.error === "string"));
  if (!validResponse) return 'response is not { "data": <data> } or { "error": <string> }';

  if (typeof value.prevHash !== "string" || !HASH_PATTERN.test(value.prevHash)) {
    return "prevHash is not 64 lowercase hexadecimal characters";
  }
  if (typeof value.hash !== "string" || !HASH_PATTERN.test(value.hash)) {
    return "hash is not 64 lowercase hexadecimal characters";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function describe(err: unknown): string {
  return errorCode(err) ?? (err instanceof Error ? err.message : String(err));
}
