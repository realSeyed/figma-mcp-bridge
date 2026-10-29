/**
 * The diagnostics log: one JSON line for each event of a session, so a person
 * can read one file to see why a session failed.
 *
 * The file:
 *   FIGMA_BRIDGE_LOG_FILE                        when it is set and not empty
 *   <state folder of the install>/bridge.log     else (see rpc-token.ts)
 *
 * Each process of the install appends to the same file, one line at a time
 * with `appendFileSync`, so no handle stays open and the file can be renamed
 * at any time. Above 5 MB a process renames it to `bridge.log.1`, which
 * replaces the older one. Two processes that rotate at the same time can lose
 * a few lines; a log tolerates that.
 *
 * Each line holds `at`, `pid`, `role`, `event`, and the fields of the event.
 * No line holds params, data, node content, or the token. A failed write
 * never stops a call: the process reports the first one on standard error.
 *
 * Each process keeps its last 50 events in memory. The leader reports the
 * last 20 in the `health` of `/ping` and `list_files`.
 *
 * This module imports only Node built-in modules and `rpc-token.ts`.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { installStateFolder } from "./rpc-token.js";

export const LOG_FILE_VARIABLE = "FIGMA_BRIDGE_LOG_FILE";

/** The name of the log file in the state folder of the install. */
export const LOG_FILE_NAME = "bridge.log";

/** Above this size, the next line goes to a new file. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** The events of this process that stay in memory. */
const KEPT_EVENTS = 50;

/** The events of the leader in `health`. */
export const HEALTH_EVENTS = 20;

/** The longest error message in a log line. */
const MAX_ERROR_CHARS = 300;

/** One line of the log. */
export interface DiagnosticEvent {
  /** ISO 8601 UTC time. */
  at: string;
  pid: number;
  /** `LEADER`, `FOLLOWER`, or `UNKNOWN`: the role of the process at that time. */
  role: string;
  event: string;
  [field: string]: unknown;
}

let role = "UNKNOWN";
const recent: DiagnosticEvent[] = [];
let folderMade = false;
let failureReported = false;

/**
 * The path of the log file of this process.
 * @returns The value of FIGMA_BRIDGE_LOG_FILE, or the file in the state folder of the install.
 */
export function logFilePath(): string {
  const set = process.env[LOG_FILE_VARIABLE];
  if (set !== undefined && set.trim() !== "") return set.trim();
  return join(installStateFolder(), LOG_FILE_NAME);
}

/** Sets the role that each later line of this process holds. */
export function setLogRole(next: string): void {
  role = next;
}

/**
 * Appends one event to the log and keeps it in memory. It never throws.
 * @param event - The name of the event.
 * @param fields - The facts of the event. Never params, data, node content, or the token.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const line: DiagnosticEvent = { at: new Date().toISOString(), pid: process.pid, role, event };
  // The four fields come first in the line, and no field of the event replaces one.
  for (const [key, value] of Object.entries(fields)) {
    if (!(key in line)) line[key] = value;
  }
  recent.push(line);
  if (recent.length > KEPT_EVENTS) recent.shift();
  append(line);
}

/**
 * The last events of this process, oldest first.
 * @param count - How many.
 */
export function recentEvents(count = HEALTH_EVENTS): DiagnosticEvent[] {
  return recent.slice(-count);
}

/**
 * An error message for a log line: at most `MAX_ERROR_CHARS` characters.
 * @param message - The message.
 */
export function shortError(message: string): string {
  return message.length <= MAX_ERROR_CHARS ? message : `${message.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

function append(line: DiagnosticEvent): void {
  const file = logFilePath();
  try {
    if (!folderMade) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      folderMade = true;
    }
    rotateIfLarge(file);
    appendFileSync(file, `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    if (failureReported) return;
    failureReported = true;
    const cause = (err as NodeJS.ErrnoException).code ?? String(err);
    console.error(
      `The diagnostics log ${file} cannot be written (${cause}); the bridge works on without it.`
    );
  }
}

function rotateIfLarge(file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size <= MAX_LOG_BYTES) return;
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // Another process rotated it first.
  }
}
