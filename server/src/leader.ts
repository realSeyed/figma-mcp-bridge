import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { Bridge } from "./bridge.js";
import { rpcToken, tokenFilePath } from "./rpc-token.js";
import { validateRpc } from "./schema.js";
import type { RPCRequest, RPCResponse } from "./types.js";
import { VERSION } from "./version.js";

/**
 * The leader listens on this address only, so no other machine reaches it.
 * The server processes call it by the literal address: an IPv4-only bind
 * refuses `localhost` when it resolves to `::1`.
 */
export const LEADER_HOST = "127.0.0.1";

/**
 * The base URL of the leader on `port`.
 * @param port - The bridge port.
 * @returns For example `http://127.0.0.1:1995`.
 */
export function leaderUrl(port: number): string {
  return `http://${LEADER_HOST}:${port}`;
}

/**
 * Leader owns the WebSocket bridge to Figma and exposes HTTP endpoints for followers.
 * Endpoints:
 *   /ws   — WebSocket upgrade for the Figma plugin
 *   /ping — Health check, open to each local caller
 *   /rpc  — JSON RPC for follower tool calls. Needs `Content-Type:
 *           application/json` and `Authorization: Bearer <install token>`.
 *
 * No answer carries an `Access-Control-Allow-*` header. A browser page must
 * send a preflight for a cross-origin JSON POST, and the preflight gets 405.
 */
export class Leader {
  private bridge: Bridge;
  private server: http.Server | null = null;
  /** The SHA-256 digest of the install token, for a compare in constant time. */
  private tokenDigest: Buffer | null = null;

  constructor(private port: number) {
    this.bridge = new Bridge();
  }

  getBridge(): Bridge {
    return this.bridge;
  }

  start(): Promise<void> {
    try {
      this.tokenDigest = sha256(rpcToken());
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.url === "/ping" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", version: VERSION }));
          return;
        }

        if (req.url === "/rpc") {
          if (req.method !== "POST") {
            req.resume();
            res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "/rpc accepts only POST." }));
            return;
          }
          if (!this.admitRPC(req, res)) {
            req.resume();
            return;
          }
          this.handleRPC(req, res);
          return;
        }

        res.writeHead(404);
        res.end("Not found");
      });

      server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
        const pathname = new URL(req.url ?? "", "http://localhost").pathname;
        if (pathname === "/ws") {
          this.bridge.handleUpgrade(req, socket, head);
        } else {
          socket.destroy();
        }
      });

      // Fail fast if port is already in use
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.port} already in use`));
        } else {
          console.error("Leader HTTP server error:", err);
          if (!this.server) reject(err); // reject if during startup
        }
      });

      server.listen(this.port, LEADER_HOST, () => {
        this.server = server;
        console.error(`Leader listening on ${LEADER_HOST}:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * The checks before the body is read, in this order: the content type
   * (415), the Authorization header (401), the token (403).
   * @returns `true` if the request may run. Else the refusal is sent.
   */
  private admitRPC(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!isJsonContentType(req.headers["content-type"])) {
      this.sendJSON(res, 415, {
        error:
          "/rpc accepts only a JSON body. Send the header Content-Type: application/json (a charset parameter is allowed).",
      });
      return false;
    }

    const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(req.headers.authorization ?? "");
    if (!match) {
      res.setHeader("WWW-Authenticate", "Bearer");
      this.sendJSON(res, 401, {
        error: `/rpc needs the header Authorization: Bearer <token>, with the install token from ${tokenFilePath()}. After an update, rebuild and restart each bridge process: a process of an older build sends no token.`,
      });
      return false;
    }

    if (!this.tokenDigest || !timingSafeEqual(sha256(match[1]), this.tokenDigest)) {
      this.sendJSON(res, 403, {
        error: `The token in the Authorization header is not the install token of this leader. Read the token again from ${tokenFilePath()}; a process with another FIGMA_BRIDGE_TOKEN_FILE has another token.`,
      });
      return false;
    }

    return true;
  }

  private handleRPC(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const rpcReq: RPCRequest = JSON.parse(body);

        // Handle list_files as a special RPC (not forwarded to plugin)
        if (rpcReq.tool === "list_files") {
          this.sendJSON(res, 200, {
            data: this.bridge.listConnectedFiles(),
          });
          return;
        }

        // Each process serves save_screenshots itself and writes under its own
        // output root, so the leader writes no file for another process.
        if (rpcReq.tool === "save_screenshots") {
          this.sendJSON(res, 400, {
            error:
              "save_screenshots is not served over /rpc: each process serves save_screenshots itself, and writes under its own output root (FIGMA_BRIDGE_OUTPUT_ROOT). Call the save_screenshots tool of your own MCP server; it fetches each capture with get_screenshot.",
          });
          return;
        }

        const validation = validateRpc(rpcReq.tool, rpcReq.nodeIds, rpcReq.params);
        if (validation.error) {
          this.sendJSON(res, 400, { error: validation.error });
          return;
        }

        // Forward the schema's output, not the caller's raw object: schemas may
        // normalise input (e.g. the create_* field aliases), and the plugin only
        // understands the canonical spelling.
        const validatedParams = validation.params ?? rpcReq.params;
        const fileKey = rpcReq.fileKey;

        const resp = await this.bridge.sendWithParams(
          rpcReq.tool,
          rpcReq.nodeIds,
          validatedParams,
          fileKey
        );

        this.sendJSON(res, 200, resp.error ? { error: resp.error } : { data: resp.data });
      } catch (err) {
        this.sendJSON(res, 200, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  private sendJSON(res: http.ServerResponse, status: number, body: RPCResponse): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  stop(): void {
    this.tokenDigest = null;
    this.bridge.close();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Whether the media type is `application/json`, with no parameter other than `charset`.
 * @param header - The value of the Content-Type header.
 */
function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  const [mediaType, ...parameters] = header.split(";");
  if (mediaType.trim().toLowerCase() !== "application/json") return false;
  return parameters.every((parameter) => {
    const name = parameter.split("=")[0].trim().toLowerCase();
    return name === "charset" || name === "";
  });
}
