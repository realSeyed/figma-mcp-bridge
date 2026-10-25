import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { Bridge } from "./bridge.js";
import { BRIDGE_COMMIT } from "./build-info.js";
import { JOURNAL_CHUNK_REQUEST, parseChunkParams, WriteJournal } from "./journal.js";
import type { JournalChunk, JournalChunkParams } from "./journal.js";
import { AUDITOR_ROLE, AUDITOR_TOOLS, ROLE_HEADER, ROLE_VARIABLE, auditorMayCall } from "./role.js";
import { rpcToken, tokenFilePath } from "./rpc-token.js";
import { validateRpc } from "./schema.js";
import type { IdentityReport, LeaderIdentity, RPCRequest, RPCResponse } from "./types.js";
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
 * The tools that write evidence files. `/rpc` refuses each of them: the
 * process that serves the call writes the files under its own output root,
 * and fetches what it needs from the plugin with the request named here.
 */
const SERVED_BY_EACH_PROCESS: ReadonlyMap<string, string> = new Map([
  ["save_screenshots", "it fetches each capture with get_screenshot"],
  ["dump_nodes", "it fetches each root in chunks with dump_nodes_chunk"],
]);

/**
 * Leader owns the WebSocket bridge to Figma and exposes HTTP endpoints for followers.
 * Endpoints:
 *   /ws   — WebSocket upgrade for the Figma plugin
 *   /ping — Health check and identity report, open to each local caller
 *   /rpc  — JSON RPC for follower tool calls. Needs `Content-Type:
 *           application/json` and `Authorization: Bearer <install token>`.
 *
 * A request with `X-Figma-Bridge-Role: auditor` may call the tools of the
 * auditor role only (see role.ts). A request without the header is relayed
 * whatever the role of the leader process is: the role of this process governs
 * its own tools, and its own MCP calls never pass /rpc.
 *
 * No answer carries an `Access-Control-Allow-*` header. A browser page must
 * send a preflight for a cross-origin JSON POST, and the preflight gets 405.
 *
 * The leader owns the write journal (journal.ts). The bridge records each
 * write that reaches a plugin connection, from /rpc and from the own calls of
 * this process alike; /ping and list_files report its state.
 */
export class Leader {
  private bridge: Bridge;
  private server: http.Server | null = null;
  /** The SHA-256 digest of the install token, for a compare in constant time. */
  private tokenDigest: Buffer | null = null;
  /** When this process became the leader: set when the port is bound. */
  private startedAt = new Date().toISOString();
  /** The write journal. Loaded when the port is bound, so a follower never opens it. */
  private journal = new WriteJournal();

  constructor(private port: number) {
    this.bridge = new Bridge(this.journal);
  }

  getBridge(): Bridge {
    return this.bridge;
  }

  /** What the leader knows: its build, its start time, and the connected files. */
  leaderIdentity(): LeaderIdentity {
    return {
      leaderCommit: BRIDGE_COMMIT,
      leaderStartedAt: this.startedAt,
      files: this.bridge.listConnectedFiles(),
      journal: this.journal.state(),
    };
  }

  /**
   * One chunk of the journal, for an own call of this process. A follower gets
   * the same answer over `/rpc`.
   * @param params - The params of the `dump_journal_chunk` request.
   * @returns The chunk.
   * @throws If the params are not valid, or the journal cannot give the chunk.
   */
  journalChunk(params: unknown): JournalChunk {
    return this.journal.chunk(parseChunkParams(params));
  }

  /** The report of the leader as the serving process: both commits are its own. */
  identityReport(): IdentityReport {
    return { bridgeCommit: BRIDGE_COMMIT, ...this.leaderIdentity() };
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
          // The leader answers, so its commit is the bridgeCommit of /ping.
          const { bridgeCommit, leaderStartedAt, files, journal } = this.identityReport();
          res.end(
            JSON.stringify({
              status: "ok",
              version: VERSION,
              bridgeCommit,
              leaderStartedAt,
              files,
              journal,
            })
          );
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
        // Synchronous, before this callback returns: no request runs before
        // the load. A process that loses the port never reads the file.
        this.journal.load();
        this.server = server;
        this.startedAt = new Date().toISOString();
        console.error(`Leader listening on ${LEADER_HOST}:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * The checks before the body is read, in this order: the content type
   * (415), the Authorization header (401), the token (403), the role header
   * (400 for a value other than `auditor`).
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

    const mark = req.headers[ROLE_HEADER.toLowerCase()];
    if (mark !== undefined && mark !== AUDITOR_ROLE) {
      this.sendJSON(res, 400, {
        error: `The header ${ROLE_HEADER} has the value "${String(mark)}". The only allowed value is "${AUDITOR_ROLE}"; send the header with that value, or send no header.`,
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

        // A marked request may call the auditor tools and the two internal
        // commands only. The plugin gets nothing from a refused request.
        if (
          req.headers[ROLE_HEADER.toLowerCase()] === AUDITOR_ROLE &&
          !auditorMayCall(rpcReq.tool)
        ) {
          this.sendJSON(res, 403, {
            error: `The tool "${rpcReq.tool}" is not allowed for the ${AUDITOR_ROLE} role (header ${ROLE_HEADER}: ${AUDITOR_ROLE}). This role may call only: ${AUDITOR_TOOLS.join(", ")}. Send the call from a process without ${ROLE_VARIABLE}.`,
          });
          return;
        }

        // Handle list_files as a special RPC (not forwarded to plugin)
        if (rpcReq.tool === "list_files") {
          this.sendJSON(res, 200, { data: this.leaderIdentity() });
          return;
        }

        // The leader serves the journal chunks itself, from the file.
        if (rpcReq.tool === JOURNAL_CHUNK_REQUEST) {
          let params: JournalChunkParams;
          try {
            params = parseChunkParams(rpcReq.params);
          } catch (err) {
            this.sendJSON(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
          }
          this.sendJSON(res, 200, { data: this.journal.chunk(params) });
          return;
        }

        // Each process serves the evidence tools itself and writes under its
        // own output root, so the leader writes no file for another process.
        const fetches = SERVED_BY_EACH_PROCESS.get(rpcReq.tool);
        if (fetches !== undefined) {
          this.sendJSON(res, 400, {
            error: `${rpcReq.tool} is not served over /rpc: each process serves ${rpcReq.tool} itself, and writes under its own output root (FIGMA_BRIDGE_OUTPUT_ROOT). Call the ${rpcReq.tool} tool of your own MCP server; ${fetches}.`,
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
          fileKey,
          req.headers[ROLE_HEADER.toLowerCase()] === AUDITOR_ROLE
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
    // The bridge first: a write that still waits is recorded with its error.
    this.bridge.close();
    this.journal.close();
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
