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
 * At start the leader reads the file and checks each line. One defect is
 * recovered: a last line with no newline (a torn append) after valid lines.
 * Its bytes move to `<journal>.torn-<UTC time>`, the file is cut back to the
 * end of the last valid line, and a `journal_recovered` entry records the move
 * in the chain. Each other failure makes the journal broken: the leader
 * reports it, refuses each write, and never truncates, repairs or rewrites
 * the file. The journal keeps the count, the head and the byte offset of each
 * line in memory, not the entries.
 *
 * `dump_journal_chunk` is the internal command of `dump_journal`: the leader
 * serves it itself with `chunk`, from the file, and never sends it to a plugin.
 *
 * The journal holds the params and the responses of each write: it is private
 * data of the owner.
 *
 * This module imports only Node built-in modules, `evidence.ts`,
 * `rpc-token.ts` and types.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  canonicalBytes,
  canonicalJson,
  folderTimestamp,
  sha256Hex,
  utcTimestamp,
} from "./evidence.js";
import { installStateFolder } from "./rpc-token.js";
import type { JournalState } from "./types.js";

export const JOURNAL_FILE_VARIABLE = "FIGMA_BRIDGE_JOURNAL_FILE";

/** The name of the journal file in the state folder of the install. */
export const JOURNAL_FILE_NAME = "write-journal.jsonl";

/** The `prevHash` of the first entry, and the head of an empty journal. */
export const GENESIS_HASH = "0".repeat(64);

/** The tool of the entry that records a torn last line moved aside. It is no request. */
export const RECOVERED_TOOL = "journal_recovered";

/**
 * The internal command that fetches the entries for `dump_journal`. The leader
 * serves it itself, from the journal file: it never goes to the plugin.
 */
export const JOURNAL_CHUNK_REQUEST = "dump_journal_chunk";

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
  // The dump of the journal. The leader serves the chunk command itself.
  "dump_journal",
  JOURNAL_CHUNK_REQUEST,
]);

/** The most bytes of entry text in one chunk, unless the chunk would be empty. */
export const MAX_CHUNK_BYTES = 4_000_000;

/** The params of one `dump_journal_chunk` request. */
export interface JournalChunkParams {
  /** The entries after this `seq` come back. */
  afterSeq: number;
  /** The last `seq` of the dump, or null on the first request: the current count. */
  throughSeq: number | null;
  /** The most entries in the answer. */
  maxEntries: number;
}

/** The answer of one `dump_journal_chunk` request. */
export interface JournalChunk {
  status: "ok";
  /** The count of the journal when the leader read the chunk. */
  entryCount: number;
  /** The head of the journal when the leader read the chunk. */
  headHash: string;
  /** The entries with `afterSeq < seq <= throughSeq`, in `seq` order. */
  entries: JournalEntry[];
}

/**
 * Reads the params of a `dump_journal_chunk` request.
 * @param params - The params of the request.
 * @returns The params.
 * @throws With the field, the cause and the correction.
 */
export function parseChunkParams(params: unknown): JournalChunkParams {
  const value = isRecord(params) ? params : {};
  const problems: string[] = [];
  const { afterSeq, throughSeq, maxEntries } = value;
  if (!Number.isSafeInteger(afterSeq) || (afterSeq as number) < 0) {
    problems.push(`afterSeq is ${show(afterSeq)}, but it must be an integer of 0 or more`);
  }
  if (throughSeq !== null && (!Number.isSafeInteger(throughSeq) || (throughSeq as number) < 0)) {
    problems.push(
      `throughSeq is ${show(throughSeq)}, but it must be an integer of 0 or more, or null`
    );
  }
  if (!Number.isSafeInteger(maxEntries) || (maxEntries as number) < 1) {
    problems.push(`maxEntries is ${show(maxEntries)}, but it must be an integer of 1 or more`);
  }
  if (problems.length > 0) {
    throw new Error(
      `${JOURNAL_CHUNK_REQUEST}: ${problems.join("; ")}. Send { afterSeq, throughSeq, maxEntries } as the dump_journal tool does.`
    );
  }
  return {
    afterSeq: afterSeq as number,
    throughSeq: throughSeq as number | null,
    maxEntries: maxEntries as number,
  };
}

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
  /**
   * The byte offset after each line: line `n` (the entry with `seq` n) spans
   * `[lineEnds[n - 2] ?? 0, lineEnds[n - 1])`. One number for each entry, so a
   * chunk reads its own lines and not the whole file.
   */
  private lineEnds: number[] = [];

  /** @param file - The journal file. The default is `journalFilePath()`. */
  constructor(readonly file: string = journalFilePath()) {}

  /**
   * Reads the file and checks each line. A missing file is an empty journal.
   * A torn last line after valid lines is moved aside (`recoverTornTail`).
   * Each other failure makes the journal broken and is logged one time. It
   * never throws, and it changes the file only to move a torn line aside.
   */
  load(): void {
    this.entryCount = 0;
    this.headHash = GENESIS_HASH;
    this.brokenReason = null;
    this.lineEnds = [];

    let bytes: Buffer;
    try {
      bytes = readFileSync(this.file);
    } catch (err) {
      if (errorCode(err) === "ENOENT") return;
      this.markBroken(`the file could not be read (${describe(err)})`);
      return;
    }

    const check = this.checkLines(bytes);
    if (check.status === "broken") this.markBroken(check.reason);
    if (check.status === "torn") this.recoverTornTail(bytes, check.validBytes, check.reason);
  }

  /**
   * Moves a torn last line aside. An append that stopped halfway leaves it,
   * and each line before it is valid. Its bytes go to a new file
   * `<journal>.torn-<UTC time>` (flag `wx`, mode 0o600, with `fsync`), the
   * journal is cut back to the end of the last valid line, and the entry
   * `journal_recovered` records the move. A failure of any step makes the
   * journal broken, as each other defect does.
   * @param bytes - The whole file.
   * @param validBytes - The length of the valid lines.
   * @param defect - The failure of the check, for the log.
   */
  private recoverTornTail(bytes: Buffer, validBytes: number, defect: string): void {
    const torn = bytes.subarray(validBytes);
    const savedTo = `${this.file}.torn-${folderTimestamp()}`;
    try {
      const fd = openSync(savedTo, "wx", 0o600);
      try {
        for (let written = 0; written < torn.length;) {
          written += writeSync(fd, torn, written, torn.length - written);
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      truncateSync(this.file, validBytes);
    } catch (err) {
      this.markBroken(`${defect}, and moving it aside failed (${describe(err)})`);
      return;
    }

    try {
      this.append({
        tool: RECOVERED_TOOL,
        fileKey: "",
        epoch: 0,
        auditor: false,
        nodeIds: null,
        params: { tornBytes: torn.length, tornSha256: sha256Hex(torn), savedTo },
        response: { data: null },
      });
    } catch {
      // The failed append made the journal broken and logged it.
      return;
    }
    console.error(
      `The write journal ${this.file} ended with a torn line (${defect}): its ${torn.length} bytes ` +
        `moved to ${savedTo}, and entry ${this.entryCount} (${RECOVERED_TOOL}) records it.`
    );
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
    let lineBytes = 0;

    try {
      entry = { ...unhashed, hash: entryHash(unhashed) };
      const line = Buffer.from(`${canonicalJson(entry)}\n`, "utf8");
      lineBytes = line.length;
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
    this.lineEnds.push(this.endOfFile() + lineBytes);
    return entry;
  }

  /**
   * The entries of one `dump_journal_chunk` request, read from the file: those
   * with `afterSeq < seq <= throughSeq`, at most `maxEntries`, and at most
   * `MAX_CHUNK_BYTES` of entry text, but one entry at least when one remains.
   * The count and the head of the answer are those of this moment.
   * @param params - The params of the request.
   * @returns The chunk.
   * @throws If the journal is broken, the range is not in the journal, or the
   *   file does not hold the lines that the load and the appends counted.
   */
  chunk(params: JournalChunkParams): JournalChunk {
    if (this.brokenReason !== null) {
      throw new Error(
        `${JOURNAL_CHUNK_REQUEST}: the write journal ${this.file} is broken (${this.brokenReason}), ` +
          `so it cannot be dumped. ${REPAIR}`
      );
    }
    const throughSeq = params.throughSeq ?? this.entryCount;
    if (throughSeq > this.entryCount || params.afterSeq > throughSeq) {
      throw new Error(
        `${JOURNAL_CHUNK_REQUEST}: the range afterSeq ${params.afterSeq} to throughSeq ${throughSeq} ` +
          `is not in the journal, which holds ${this.entryCount} entries. A new leader may serve ` +
          `the dump: call dump_journal again.`
      );
    }

    const first = params.afterSeq;
    const start = first === 0 ? 0 : this.lineEnds[first - 1];
    let last = first;
    while (last < throughSeq && last - first < params.maxEntries) {
      if (last > first && this.lineEnds[last] - start > MAX_CHUNK_BYTES) break;
      last++;
    }
    const end = last === 0 ? 0 : this.lineEnds[last - 1];

    const entries: JournalEntry[] = [];
    if (end > start) {
      const bytes = Buffer.alloc(end - start);
      const fd = openSync(this.file, "r");
      try {
        for (let read = 0; read < bytes.length;) {
          const count = readSync(fd, bytes, read, bytes.length - read, start + read);
          if (count === 0) break;
          read += count;
        }
      } finally {
        closeSync(fd);
      }
      const lines = bytes.toString("utf8").split("\n");
      for (let index = 0; index < last - first; index++) {
        const seq = first + index + 1;
        let entry: unknown;
        try {
          entry = JSON.parse(lines[index]);
        } catch {
          entry = null;
        }
        if (!isRecord(entry) || entry.seq !== seq) {
          throw new Error(
            `${JOURNAL_CHUNK_REQUEST}: line ${seq} of the write journal ${this.file} is not the ` +
              `entry that the leader counted, so the file changed outside the leader. ${REPAIR}`
          );
        }
        entries.push(entry as unknown as JournalEntry);
      }
    }
    return { status: "ok", entryCount: this.entryCount, headHash: this.headHash, entries };
  }

  /** The byte offset after the last line that the load and the appends counted. */
  private endOfFile(): number {
    return this.lineEnds.length === 0 ? 0 : this.lineEnds[this.lineEnds.length - 1];
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
   * @returns `ok`; `torn` when the only failure is a last line with no
   *   newline, with the length of the valid lines before it; else `broken`
   *   with the first failure as `line <n>: <cause>`.
   */
  private checkLines(bytes: Buffer): LineCheck {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let previousHash = GENESIS_HASH;
    let lineNumber = 0;
    let start = 0;
    const broken = (reason: string): LineCheck => ({ status: "broken", reason });

    while (start < bytes.length) {
      lineNumber++;
      const end = bytes.indexOf(0x0a, start);
      if (end === -1) {
        return {
          status: "torn",
          reason: `line ${lineNumber}: the line does not end with a newline (a torn append)`,
          validBytes: start,
        };
      }

      let text: string;
      try {
        text = decoder.decode(bytes.subarray(start, end));
      } catch {
        return broken(`line ${lineNumber}: the line is not valid UTF-8`);
      }
      start = end + 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return broken(`line ${lineNumber}: the line is not JSON`);
      }
      let canonical: string;
      try {
        canonical = canonicalJson(parsed);
      } catch {
        canonical = "";
      }
      if (canonical !== text) {
        return broken(`line ${lineNumber}: the line is not the canonical JSON of its entry`);
      }

      const fieldFailure = checkFields(parsed);
      if (fieldFailure !== null) return broken(`line ${lineNumber}: ${fieldFailure}`);

      const entry = parsed as JournalEntry;
      if (entry.seq !== lineNumber) {
        return broken(`line ${lineNumber}: seq is ${entry.seq}, not the line number ${lineNumber}`);
      }
      if (entry.prevHash !== previousHash) {
        return broken(
          lineNumber === 1
            ? `line 1: prevHash is not the genesis hash`
            : `line ${lineNumber}: prevHash is not the hash of line ${lineNumber - 1}`
        );
      }
      if (entryHash(entry) !== entry.hash) {
        return broken(`line ${lineNumber}: hash is not the SHA-256 of the entry without hash`);
      }
      previousHash = entry.hash;
      // The valid lines so far: a broken journal reports the count and the
      // head of the lines before the first bad one.
      this.entryCount = lineNumber;
      this.headHash = previousHash;
      this.lineEnds.push(start);
    }
    return { status: "ok" };
  }
}

/** The result of the check of the lines of a journal file. */
type LineCheck =
  | { status: "ok" }
  | { status: "torn"; reason: string; validBytes: number }
  | { status: "broken"; reason: string };

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

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function describe(err: unknown): string {
  return errorCode(err) ?? (err instanceof Error ? err.message : String(err));
}
