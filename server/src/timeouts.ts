/**
 * How long the bridge waits for the Figma plugin, for each request type.
 *
 * The leader starts the clock when it sends a request to the plugin, and sends
 * the value as `timeoutMs` in the request: the request queue of the plugin
 * stops waiting at the same time. A follower waits longer than the leader, so
 * the leader answers first, with its own message.
 *
 * The table is keyed by request type: a new tool that needs another time adds
 * a row. `FIGMA_BRIDGE_REQUEST_TIMEOUT_MS` changes the default only, not a row.
 *
 * This module imports nothing.
 */

export const REQUEST_TIMEOUT_VARIABLE = "FIGMA_BRIDGE_REQUEST_TIMEOUT_MS";

/** The time of a request type that has no row in the table. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** The request types that need another time than the default. */
export const REQUEST_TIMEOUTS_MS: ReadonlyMap<string, number> = new Map([
  ["get_screenshot", 120_000],
  ["create_image", 120_000],
  ["import_html_layers", 300_000],
  // Its own row, so a change of the default leaves the dumps as they are.
  ["dump_nodes_chunk", 60_000],
]);

/** What a follower adds to the time of the leader, for the HTTP round trip. */
const FOLLOWER_MARGIN_MS = 15_000;

/**
 * How long the leader waits for the plugin to answer one request.
 * @param type - The request type.
 * @returns Milliseconds.
 */
export function requestTimeoutMs(type: string): number {
  return REQUEST_TIMEOUTS_MS.get(type) ?? defaultRequestTimeoutMs();
}

/**
 * How long a follower waits for the leader to answer one `/rpc` request.
 * @param type - The request type.
 * @returns Milliseconds.
 */
export function followerTimeoutMs(type: string): number {
  return requestTimeoutMs(type) + FOLLOWER_MARGIN_MS;
}

/**
 * The default time, from `FIGMA_BRIDGE_REQUEST_TIMEOUT_MS` when it is set.
 * @returns Milliseconds.
 * @throws If the variable is set, but not to an integer of 1 or more.
 */
export function defaultRequestTimeoutMs(): number {
  return readMilliseconds(REQUEST_TIMEOUT_VARIABLE, DEFAULT_REQUEST_TIMEOUT_MS, 1);
}

/**
 * Reads each timing variable one time. The process calls it at start, so a
 * bad value stops the process there and not at the first tool call.
 * @throws With the variable, the value, and the correction.
 */
export function checkTimingSettings(): void {
  defaultRequestTimeoutMs();
}

/**
 * A time in seconds for a message.
 * @param ms - Milliseconds.
 * @returns Whole seconds, or seconds with one decimal for a part of a second.
 */
export function seconds(ms: number): string {
  const value = ms / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function readMilliseconds(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) {
    throw new Error(
      `Invalid ${name} "${raw}": it must be an integer of ${min} or more, in milliseconds. Correct it or unset it, then restart the server.`
    );
  }
  return value;
}
