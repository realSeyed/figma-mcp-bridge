/**
 * The request queue of the plugin: one server request at a time, in the order
 * the requests arrived.
 *
 * Without it each message started its handler at once, and the handlers
 * interleaved at each await (a font load, a node lookup): the order of the
 * children of an auto layout frame depended on timing, and a request that
 * the server had already reported as failed could still run later.
 *
 * Each request has a deadline: its arrival plus the `timeoutMs` that the
 * server sent with it, or `DEFAULT_REQUEST_TIMEOUT_MS`. The server stops
 * waiting at about that time. A request still queued at its deadline does not
 * start. A request that runs past it gets an error answer, the next request
 * starts, and its late result is dropped. A request whose connection closed
 * before it started is dropped: nobody waits for its answer.
 *
 * This module does not touch the Figma API, so a test runs it as it is.
 */

/** The time of a request that carries no `timeoutMs`, from an older server. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export type QueueOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export type QueueTask<T> = {
  /** The request type, for the messages. */
  tool: string;
  /** The number of the socket the request came on, or null. */
  connection: number | null;
  /** How long the server waits for the answer, from the arrival. */
  timeoutMs?: number;
  /** Runs the request. */
  run: () => Promise<T>;
  /** Gets the outcome one time. A dropped task gets none. */
  settle: (outcome: QueueOutcome<T>) => void;
};

type Entry = {
  task: QueueTask<unknown>;
  timeoutMs: number;
  deadline: number;
};

export class RequestQueue {
  private waiting: Entry[] = [];
  private running: Entry | null = null;

  /** The tasks that wait or run. */
  get size(): number {
    return this.waiting.length + (this.running === null ? 0 : 1);
  }

  /**
   * Adds a task at the end, and starts it when no task runs.
   * @param task - The request.
   */
  push<T>(task: QueueTask<T>): void {
    const timeoutMs =
      typeof task.timeoutMs === "number" && Number.isFinite(task.timeoutMs) && task.timeoutMs > 0
        ? task.timeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;
    this.waiting.push({
      task: task as QueueTask<unknown>,
      timeoutMs,
      deadline: Date.now() + timeoutMs,
    });
    this.next();
  }

  /**
   * Drops each task of a closed connection that has not started. A task that
   * runs goes on: the Plugin API cannot stop it.
   * @param connection - The number of the socket.
   * @returns How many tasks were dropped.
   */
  dropConnection(connection: number): number {
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((entry) => entry.task.connection !== connection);
    return before - this.waiting.length;
  }

  private next(): void {
    while (this.running === null && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      const remaining = entry.deadline - Date.now();
      if (remaining <= 0) {
        settle(entry.task, {
          ok: false,
          error: `${entry.task.tool}: the plugin did not start the request within ${seconds(entry.timeoutMs)} s because the requests before it were still running, so it did not run. Retry it.`,
        });
        continue;
      }
      this.start(entry, remaining);
    }
  }

  private start(entry: Entry, remaining: number): void {
    this.running = entry;
    let done = false;
    const finish = (outcome: QueueOutcome<unknown>): void => {
      // A result after the time-out is dropped.
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.running = null;
      settle(entry.task, outcome);
      this.next();
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: `${entry.task.tool}: the plugin stopped waiting after ${seconds(entry.timeoutMs)} s; the operation may still finish in Figma.`,
        }),
      remaining
    );
    let result: Promise<unknown>;
    try {
      result = entry.task.run();
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(
      (value) => finish({ ok: true, value }),
      (error) =>
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
  }
}

/** Gives a task its outcome. A throw there must not stop the queue. */
const settle = (task: QueueTask<unknown>, outcome: QueueOutcome<unknown>): void => {
  try {
    task.settle(outcome);
  } catch (error) {
    console.error(`[figma-mcp-bridge] the answer of ${task.tool} could not be sent`, error);
  }
};

/** Whole seconds, or seconds with one decimal for a part of a second. */
const seconds = (ms: number): string => {
  const value = ms / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};
