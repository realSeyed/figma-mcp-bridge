import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { selectFile } from "./identity.js";
import { READ_ONLY_REQUESTS } from "./journal.js";
import type { JournalResponse, WriteJournal } from "./journal.js";
import { requestTimeoutMs, seconds } from "./timeouts.js";
import type { BridgeRequest, BridgeResponse, ConnectedFile } from "./types.js";

/** How often the leader pings each plugin. A plugin that misses one ping is closed. */
const PING_INTERVAL_MS = 10_000;

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
    console.error(`Plugin connected: ${fileName} (${fileKey})`);

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

    ws.on("close", () => {
      const current = this.connections.get(fileKey);
      if (current?.ws === ws) {
        this.connections.delete(fileKey);
        console.error(`Plugin disconnected: ${fileName} (${fileKey})`);
      }
      this.rejectPendingForSocket(ws, `Plugin disconnected: ${fileName} (${fileKey})`);
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
      const current = this.connections.get(fileKey);
      if (current?.ws === ws) {
        this.connections.delete(fileKey);
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
  sendWithParams(
    requestType: string,
    nodeIds?: string[],
    params?: Record<string, unknown>,
    fileKey?: string,
    auditor = false
  ): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      const recorded = this.journal.records(requestType);
      // A broken journal refuses each write before it reaches the plugin.
      const refusal = recorded ? this.journal.refusal(requestType) : null;
      if (refusal !== null) {
        reject(new Error(refusal));
        return;
      }

      let conn: WebSocket;
      let file: ConnectedFile;
      try {
        ({ ws: conn, file } = this.resolveConnection(fileKey));
      } catch (err) {
        reject(err);
        return;
      }

      if (conn.readyState !== WebSocket.OPEN) {
        reject(new Error("Plugin not connected"));
        return;
      }

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

    for (const [, entry] of this.connections) {
      entry.ws.close();
    }
    this.connections.clear();
    this.wss.close();
  }
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
