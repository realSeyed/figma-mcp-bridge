import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { selectFile } from "./identity.js";
import { READ_ONLY_REQUESTS } from "./journal.js";
import type { JournalResponse, WriteJournal } from "./journal.js";
import { connectGraceMs, requestTimeoutMs, seconds } from "./timeouts.js";
import type { BridgeRequest, BridgeResponse, ConnectedFile } from "./types.js";

/** How often the leader pings each plugin. A plugin that misses one ping is closed. */
const PING_INTERVAL_MS = 10_000;

/** What the user does to connect the plugin of a file again. */
const RUN_PLUGIN =
  "Plugins › Development › Figma MCP Bridge (Fork) in that file (running another plugin closes this one), then retry.";

/** The last disconnect of the plugin of one file key. */
interface Disconnect {
  at: number;
  fileName: string;
  /** Why the connection ended: the close code and reason, a missed ping, or an error. */
  reason: string;
}

/** A request that waits for a plugin to connect: for one file key, or for any file. */
interface ConnectionWaiter {
  fileKey: string | undefined;
  /** Ends the wait: true when a matching plugin connected. */
  settle: (connected: boolean) => void;
}

interface PendingRequest {
  /** The request type, for the messages. */
  type: string;
  resolve: (resp: BridgeResponse) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  ws: WebSocket;
}

interface ConnectionEntry {
  ws: WebSocket;
  fileKey: string;
  fileName: string;
  pluginBuild: string;
  isAlive: boolean;
}

export class Bridge {
  private wss: WebSocketServer;
  private connections = new Map<string, ConnectionEntry>();
  /** The epoch of each file key. It lives in memory: a new leader starts again. */
  private epochs = new Map<string, number>();
  private pending = new Map<string, PendingRequest>();
  private counter = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** When this leader started: a request waits for the plugins that connect again after a takeover. */
  private readonly startedAt = Date.now();
  /** The last disconnect of each file key that has no connection now. */
  private disconnects = new Map<string, Disconnect>();
  private waiters = new Set<ConnectionWaiter>();

  /**
   * @param journal - The write journal of the leader. Each request that is
   *   sent to a plugin connection and that it records adds one entry here.
   */
  constructor(private journal: WriteJournal) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("error", (err) => {
      console.error("WebSocketServer error:", err);
    });

    this.pingTimer = setInterval(() => {
      for (const [fileKey, entry] of this.connections) {
        if (!entry.isAlive) {
          entry.ws.terminate();
          this.connections.delete(fileKey);
          this.recordDisconnect(
            fileKey,
            entry.fileName,
            `it did not answer a ping within ${seconds(PING_INTERVAL_MS)} s`
          );
          console.error(`Plugin dead (no pong): ${entry.fileName} (${fileKey})`);
          continue;
        }
        entry.isAlive = false;
        entry.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (request.url == undefined) {
      console.error("Plugin connected without url, rejecting");
      socket.destroy();
      return;
    }

    const url = new URL(request.url, "http://localhost");
    const { fileKey, fileName = "Unknown", pluginBuild } = Object.fromEntries(url.searchParams);

    if (!fileKey) {
      console.error("Plugin connected without fileKey, rejecting");
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleConnection(ws, fileKey, fileName, pluginBuild?.trim().slice(0, 200) || "unknown");
    });
  }

  private handleConnection(
    ws: WebSocket,
    fileKey: string,
    fileName: string,
    pluginBuild: string
  ): void {
    // Replace existing connection for the same file
    const existing = this.connections.get(fileKey);
    if (existing) {
      existing.ws.close();
    }
    // Count before the connection is stored, so no read sees the new
    // connection with the old epoch.
    const epoch = (this.epochs.get(fileKey) ?? 0) + 1;
    this.epochs.set(fileKey, epoch);
    this.connections.set(fileKey, {
      ws,
      fileKey,
      fileName,
      pluginBuild,
      isAlive: true,
    });
    this.disconnects.delete(fileKey);
    console.error(`Plugin connected: ${fileName} (${fileKey})`);
    for (const waiter of [...this.waiters]) {
      if (waiter.fileKey === undefined || waiter.fileKey === fileKey) waiter.settle(true);
    }

    ws.on("pong", () => {
      const entry = this.connections.get(fileKey);
      if (entry && entry.ws === ws) entry.isAlive = true;
    });

    ws.on("message", (data) => {
      try {
        const resp: BridgeResponse = JSON.parse(data.toString());
        const pending = this.pending.get(resp.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(resp.requestId);
          pending.resolve(resp);
        }
      } catch {
        console.error("Invalid response from plugin");
      }
    });

    ws.on("close", (code, reason) => {
      const current = this.connections.get(fileKey);
      if (current?.ws === ws) {
        this.connections.delete(fileKey);
        this.recordDisconnect(fileKey, fileName, describeClose(code, reason));
        console.error(`Plugin disconnected: ${fileName} (${fileKey})`);
      }
      this.rejectPendingForSocket(ws, `Plugin disconnected: ${fileName} (${fileKey})`);
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
      const current = this.connections.get(fileKey);
      if (current?.ws === ws) {
        this.connections.delete(fileKey);
        this.recordDisconnect(fileKey, fileName, `a connection error (${err.message})`);
      }
      this.rejectPendingForSocket(
        ws,
        `Plugin disconnected: ${fileName} (${fileKey}) after a connection error (${err.message})`
      );
    });
  }

  /**
   * Fails each request that waits on the socket.
   * @param reason - What happened to the socket. The message adds the tool,
   *   and for a write that the change may already be in the file.
   */
  private rejectPendingForSocket(ws: WebSocket, reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.ws === ws) {
        clearTimeout(p.timeout);
        this.pending.delete(id);
        p.reject(new Error(`${reason} while ${p.type} was running.${writeNote(p.type)}`));
      }
    }
  }

  /**
   * Resolve which connection to use.
   * - If fileKey is provided, use that specific connection.
   * - If only one file is connected and no fileKey given, use it (backward compat).
   * - If multiple files connected and no fileKey, throw with a helpful message.
   * @returns The socket, and the file with its epoch now.
   */
  private resolveConnection(fileKey?: string): { ws: WebSocket; file: ConnectedFile } {
    const file = selectFile(this.listConnectedFiles(), fileKey);
    return { ws: this.connections.get(file.fileKey)!.ws, file };
  }

  /**
   * The connection of a request. When no connection matches (the key is given
   * and absent, or no key is given and no file is connected), the request
   * waits for a plugin to connect, but only inside the grace after the start
   * of this leader or after a disconnect of a matching file: a plugin connects
   * again 1.5 s after it lost its leader. Else it fails at once, so an unknown
   * key fails fast. Several files and no key fail at once, as before.
   * @param fileKey - The key the caller gave, if any.
   * @returns The socket, and the file with its epoch now.
   * @throws If no plugin connects in time, or `selectFile` throws.
   */
  private async connectionFor(
    fileKey: string | undefined
  ): Promise<{ ws: WebSocket; file: ConnectedFile }> {
    const key = fileKey || undefined;
    const absent = key !== undefined ? !this.connections.has(key) : this.connections.size === 0;
    if (absent) {
      const waitMs = this.graceWaitMs(key);
      const connected = waitMs > 0 && (await this.waitForConnection(key, waitMs));
      // A file that was connected before gets the message that says when and why it left.
      if (!connected && (waitMs > 0 || this.lastDisconnect(key) !== undefined)) {
        throw new Error(this.noPluginMessage(key));
      }
    }
    return this.resolveConnection(key);
  }

  /**
   * How long a request for a missing plugin may still wait.
   * @param key - The file key, or undefined for any file.
   * @returns The rest of the grace after the start of this leader or after the
   *   last matching disconnect, whichever is later; 0 when it is over.
   */
  private graceWaitMs(key: string | undefined): number {
    const grace = connectGraceMs();
    const since = Math.max(this.startedAt, this.lastDisconnect(key)?.at ?? 0);
    return Math.max(0, since + grace - Date.now());
  }

  /** The last disconnect of the key, or the latest one of any key when no key is given. */
  private lastDisconnect(key: string | undefined): Disconnect | undefined {
    if (key !== undefined) return this.disconnects.get(key);
    let latest: Disconnect | undefined;
    for (const record of this.disconnects.values()) {
      if (latest === undefined || record.at > latest.at) latest = record;
    }
    return latest;
  }

  /**
   * Waits for a plugin of the key, or of any file, to connect.
   * @returns True when one connected in time.
   */
  private waitForConnection(key: string | undefined, waitMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter: ConnectionWaiter = {
        fileKey: key,
        settle: (connected) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(connected);
        },
      };
      const timer = setTimeout(() => waiter.settle(false), waitMs);
      this.waiters.add(waiter);
    });
  }

  private recordDisconnect(fileKey: string, fileName: string, reason: string): void {
    this.disconnects.set(fileKey, { at: Date.now(), fileName, reason });
  }

  /**
   * The error of a request that found no plugin. Each variant holds the text
   * "No plugin connected".
   * @param key - The file key, or undefined for any file.
   */
  private noPluginMessage(key: string | undefined): string {
    const now = Date.now();
    const files = this.listConnectedFiles();
    const others =
      files.length > 0
        ? ` Connected files: ${files.map((f) => `"${f.fileName}" (fileKey: ${f.fileKey})`).join(", ")}.`
        : "";
    const record = this.lastDisconnect(key);
    if (record !== undefined) {
      return `No plugin connected for "${record.fileName}" (it disconnected ${seconds(roundTenth(now - record.at))} s ago: ${record.reason}). Ask the user to run ${RUN_PLUGIN}${others}`;
    }
    const age = seconds(roundTenth(now - this.startedAt));
    if (key !== undefined) {
      return `No plugin connected for fileKey "${key}" (this bridge leader started ${age} s ago, and no plugin has connected for that key since). Ask the user to run ${RUN_PLUGIN}${others}`;
    }
    return `No plugin connected (this bridge leader started ${age} s ago, and no plugin has connected since). Ask the user to open the Figma file and run ${RUN_PLUGIN.replace(" in that file", "")}`;
  }

  listConnectedFiles(): ConnectedFile[] {
    return [...this.connections.values()].map((entry) => ({
      fileKey: entry.fileKey,
      fileName: entry.fileName,
      pluginBuild: entry.pluginBuild,
      epoch: this.epochs.get(entry.fileKey) ?? 0,
    }));
  }

  send(requestType: string, nodeIds?: string[], fileKey?: string): Promise<BridgeResponse> {
    return this.sendWithParams(requestType, nodeIds, undefined, fileKey);
  }

  /**
   * Sends one request to a plugin connection and waits for the answer. This is
   * the one place that the own calls of the leader and the `/rpc` calls of a
   * follower both pass, so the write journal records here: a request that the
   * journal records adds one entry when the plugin answers or the wait ends.
   * A request that reaches no connection adds none.
   * @param auditor - Whether the request comes from the auditor role: the
   *   `/rpc` mark, or the role of a leader process for its own calls.
   */
  async sendWithParams(
    requestType: string,
    nodeIds?: string[],
    params?: Record<string, unknown>,
    fileKey?: string,
    auditor = false
  ): Promise<BridgeResponse> {
    const recorded = this.journal.records(requestType);
    // A broken journal refuses each write before it reaches the plugin. The
    // check runs again after a wait for the plugin: an append of another
    // request can break the journal in that time.
    const refuseIfBroken = (): void => {
      const refusal = recorded ? this.journal.refusal(requestType) : null;
      if (refusal !== null) throw new Error(refusal);
    };
    refuseIfBroken();
    const { ws: conn, file } = await this.connectionFor(fileKey);
    refuseIfBroken();

    if (conn.readyState !== WebSocket.OPEN) {
      throw new Error(
        `No plugin connected for "${file.fileName}" (${file.fileKey}): its connection is closing. Retry in a few seconds.`
      );
    }

    return new Promise((resolve, reject) => {
      const requestId = this.nextId();
      const timeoutMs = requestTimeoutMs(requestType);
      const request: BridgeRequest = {
        type: requestType,
        requestId,
        timeoutMs,
      };
      if (nodeIds && nodeIds.length > 0) {
        request.nodeIds = nodeIds;
      }
      if (params && Object.keys(params).length > 0) {
        request.params = params;
      }

      /** Appends the entry of a recorded request. Returns the error of a failed append. */
      const record = (response: JournalResponse): Error | null => {
        if (!recorded) return null;
        try {
          this.journal.append({
            fileKey: file.fileKey,
            epoch: file.epoch,
            auditor,
            tool: requestType,
            nodeIds: request.nodeIds ?? null,
            params: request.params ?? null,
            response,
          });
          return null;
        } catch (err) {
          return err instanceof Error ? err : new Error(String(err));
        }
      };
      const answered = (resp: BridgeResponse): void => {
        const failure = record(
          resp.error ? { error: resp.error } : { data: resp.data === undefined ? null : resp.data }
        );
        if (failure) reject(failure);
        else resolve(resp);
      };
      const failed = (err: Error): void => {
        reject(record({ error: err.message }) ?? err);
      };

      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        failed(
          new Error(
            `${requestType} timed out: no answer from the Figma plugin within ${seconds(timeoutMs)} s. ` +
              `The plugin may be busy or frozen, and a write may still complete in Figma. ` +
              `Check with get_node before you retry; if it repeats, ask the user to re-run the plugin.`
          )
        );
      }, timeoutMs);

      this.pending.set(requestId, {
        type: requestType,
        resolve: answered,
        reject: failed,
        timeout,
        ws: conn,
      });

      conn.send(JSON.stringify(request), (err) => {
        // A close of the socket can settle the request first: record it once.
        if (err && this.pending.has(requestId)) {
          clearTimeout(timeout);
          this.pending.delete(requestId);
          failed(
            new Error(
              `Plugin disconnected: ${file.fileName} (${file.fileKey}) before ${requestType} could be sent (${err.message}). The request did not reach the plugin; retry it.`
            )
          );
        }
      });
    });
  }

  private nextId(): string {
    this.counter++;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `req-${hh}${mm}${ss}-${this.counter}`;
  }

  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    // Reject all pending requests
    for (const [, { type, reject, timeout }] of this.pending) {
      clearTimeout(timeout);
      reject(new Error(`The bridge leader stopped while ${type} was running.${writeNote(type)}`));
    }
    this.pending.clear();
    // A request that waits for a plugin fails now: no plugin connects to a closed bridge.
    for (const waiter of [...this.waiters]) waiter.settle(false);

    for (const [, entry] of this.connections) {
      entry.ws.close();
    }
    this.connections.clear();
    this.wss.close();
  }
}

/**
 * Why a plugin connection closed, from the close frame.
 * @param code - The close code: 1005 when the frame had none, 1006 when the connection dropped.
 * @param reason - The close reason.
 */
function describeClose(code: number, reason: Buffer): string {
  const text = reason.toString("utf8").trim();
  const meaning =
    code === 1001
      ? "the plugin window closed"
      : code === 1006
        ? "the connection dropped"
        : "the plugin closed the connection";
  return `${meaning}, code ${code}${text === "" ? "" : `: ${text}`}`;
}

/** Milliseconds rounded to a tenth of a second, for `seconds`. */
function roundTenth(ms: number): number {
  return Math.round(ms / 100) * 100;
}

/**
 * The end of a message for a request that stopped after it reached the plugin.
 * @param type - The request type.
 * @returns For a write, that the change may already be in the file; else "".
 */
function writeNote(type: string): string {
  return READ_ONLY_REQUESTS.has(type)
    ? ""
    : " The change may or may not be in the file; check before you retry.";
}
