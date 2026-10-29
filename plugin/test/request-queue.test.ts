/**
 * The request queue of the plugin: one server request at a time in arrival
 * order, the deadline of each request, and the drop of the queued requests of
 * a closed socket. Then the same through the message handler of `code.ts`,
 * with a small fake on `globalThis.figma`.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { RequestQueue, type QueueOutcome } from "../src/main/request-queue";
import { answers, pluginMain, resetFakeFigma, waitUntil } from "./helpers/plugin-globals";

/** A promise and the function that resolves it. */
const gate = <T>() => {
  let open: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/** Lets each pending promise callback run. */
const settleCallbacks = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("the request queue", () => {
  test("runs one task at a time, in the order the tasks arrived", async () => {
    const queue = new RequestQueue();
    const events: string[] = [];
    const outcomes: Array<QueueOutcome<string>> = [];
    const gates = [gate<string>(), gate<string>(), gate<string>()];
    gates.forEach((one, index) =>
      queue.push({
        tool: `tool_${index}`,
        connection: 1,
        timeoutMs: 5_000,
        run: async () => {
          events.push(`start ${index}`);
          const value = await one.promise;
          events.push(`end ${index}`);
          return value;
        },
        settle: (outcome) => {
          outcomes.push(outcome);
        },
      })
    );

    expect(events).toEqual(["start 0"]);
    expect(queue.size).toBe(3);
    // The later tasks are ready first; they still wait for their turn.
    gates[2].open("c");
    gates[1].open("b");
    await settleCallbacks();
    expect(events).toEqual(["start 0"]);

    gates[0].open("a");
    await waitUntil("three outcomes", () => outcomes.length === 3);
    expect(events).toEqual(["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]);
    expect(outcomes).toEqual([
      { ok: true, value: "a" },
      { ok: true, value: "b" },
      { ok: true, value: "c" },
    ]);
    expect(queue.size).toBe(0);
  });

  test("a task past its time gets an error, the next one starts, and the late result is dropped", async () => {
    const queue = new RequestQueue();
    const slow = gate<string>();
    const outcomes: Array<[string, QueueOutcome<string>]> = [];
    queue.push({
      tool: "slow_tool",
      connection: 1,
      timeoutMs: 100,
      run: () => slow.promise,
      settle: (outcome) => outcomes.push(["slow", outcome]),
    });
    queue.push({
      tool: "next_tool",
      connection: 1,
      timeoutMs: 5_000,
      run: async () => "next",
      settle: (outcome) => outcomes.push(["next", outcome]),
    });

    await waitUntil("two outcomes", () => outcomes.length === 2);
    expect(outcomes).toEqual([
      [
        "slow",
        {
          ok: false,
          error:
            "slow_tool: the plugin stopped waiting after 0.1 s; the operation may still finish in Figma.",
        },
      ],
      ["next", { ok: true, value: "next" }],
    ]);

    slow.open("late");
    await settleCallbacks();
    expect(outcomes).toHaveLength(2);
  });

  test("a task that waited past its time does not start", async () => {
    const queue = new RequestQueue();
    const ran: string[] = [];
    const outcomes: Array<QueueOutcome<string>> = [];
    // The second deadline passes while the first task still runs.
    queue.push({
      tool: "slow_tool",
      connection: 1,
      timeoutMs: 200,
      run: () => new Promise<string>(() => undefined),
      settle: (outcome) => outcomes.push(outcome),
    });
    queue.push({
      tool: "queued_tool",
      connection: 1,
      timeoutMs: 100,
      run: async () => {
        ran.push("queued_tool");
        return "never";
      },
      settle: (outcome) => outcomes.push(outcome),
    });

    await waitUntil("two outcomes", () => outcomes.length === 2);
    expect(ran).toEqual([]);
    expect(outcomes[1]).toEqual({
      ok: false,
      error:
        "queued_tool: the plugin did not start the request within 0.1 s because the requests before it were still running, so it did not run. Retry it.",
    });
  });

  test("a closed connection drops its queued tasks, not the running one or those of another", async () => {
    const queue = new RequestQueue();
    const first = gate<string>();
    const settled: string[] = [];
    const task = (tool: string, connection: number, run: () => Promise<string>) => ({
      tool,
      connection,
      timeoutMs: 5_000,
      run,
      settle: (outcome: QueueOutcome<string>) => {
        settled.push(`${tool}:${outcome.ok ? "ok" : "error"}`);
      },
    });
    queue.push(task("a", 1, () => first.promise));
    queue.push(task("b", 1, async () => "b"));
    queue.push(task("c", 2, async () => "c"));

    expect(queue.dropConnection(1)).toBe(1);
    first.open("a");
    await waitUntil("two outcomes", () => settled.length === 2);
    expect(settled).toEqual(["a:ok", "c:ok"]);
  });

  test("a request with no time gets the default of 120 s", async () => {
    const queue = new RequestQueue();
    const outcomes: Array<QueueOutcome<string>> = [];
    queue.push({
      tool: "old_server",
      connection: null,
      run: async () => "done",
      settle: (outcome) => outcomes.push(outcome),
    });
    await waitUntil("the outcome", () => outcomes.length === 1);
    expect(outcomes).toEqual([{ ok: true, value: "done" }]);
  });
});

describe("the message handler of the plugin", () => {
  beforeEach(() => {
    resetFakeFigma();
  });

  test("answers one request at a time in arrival order, and drops the queued ones of a closed socket", async () => {
    const fake = resetFakeFigma();
    const lookups: string[] = [];
    const release = new Map<string, () => void>();
    fake.getNodeByIdAsync = (id: string) => {
      lookups.push(id);
      return new Promise((resolve) => release.set(id, () => resolve(null)));
    };
    const request = (requestId: string, nodeId: string, connection: number) =>
      pluginMain.onPluginMessage({
        type: "server-request",
        connection,
        payload: { type: "get_node", requestId, nodeIds: [nodeId], timeoutMs: 5_000 },
      });

    request("r1", "1:1", 1);
    request("r2", "1:2", 1);
    request("r3", "1:3", 2);
    await settleCallbacks();
    expect(lookups).toEqual(["1:1"]);

    // The socket of r1 and r2 closed: r2 never starts, r1 runs to its end.
    pluginMain.onPluginMessage({ type: "connection-closed", connection: 1 });
    release.get("1:1")!();
    await waitUntil("the lookup of r3", () => lookups.length === 2);
    expect(lookups).toEqual(["1:1", "1:3"]);
    release.get("1:3")!();

    await waitUntil("two answers", () => answers().length === 2);
    expect(answers().map((answer) => answer.requestId)).toEqual(["r1", "r3"]);
  });

  test("a request past the time it carries is answered with an error, and the next one runs", async () => {
    const fake = resetFakeFigma();
    fake.getNodeByIdAsync = (id: string) =>
      id === "1:1" ? new Promise(() => undefined) : Promise.resolve(null);

    pluginMain.onPluginMessage({
      type: "server-request",
      connection: 1,
      payload: { type: "get_node", requestId: "slow", nodeIds: ["1:1"], timeoutMs: 100 },
    });
    pluginMain.onPluginMessage({
      type: "server-request",
      connection: 1,
      payload: { type: "get_node", requestId: "next", nodeIds: ["1:2"], timeoutMs: 5_000 },
    });

    await waitUntil("two answers", () => answers().length === 2);
    const [slow, next] = answers();
    expect(slow).toEqual({
      type: "get_node",
      requestId: "slow",
      error:
        "get_node: the plugin stopped waiting after 0.1 s; the operation may still finish in Figma.",
    });
    expect(next.requestId).toBe("next");
    expect(next.error).toContain("Node not found: 1:2");
  });
});
