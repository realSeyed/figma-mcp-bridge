import { BRIDGE_COMMIT } from "./build-info.js";
import { logEvent } from "./diagnostics.js";
import { AUDITOR_ROLE, ROLE_HEADER } from "./role.js";
import type { ProcessRole } from "./role.js";
import { rpcToken } from "./rpc-token.js";
import { followerTimeoutMs, seconds } from "./timeouts.js";
import type {
  BridgeResponse,
  Health,
  IdentityReport,
  LeaderIdentity,
  RPCRequest,
  RPCResponse,
} from "./types.js";

/**
 * A request to the leader that got no answer because the connection failed.
 * `refused`: the leader refused the connection, so it never got the request.
 * `broken`: the connection broke after the request started, so the leader may
 * have sent it to the plugin. An HTTP status is not a connection failure.
 */
export class LeaderConnectionError extends Error {
  constructor(
    readonly tool: string,
    readonly kind: "refused" | "broken",
    cause: unknown
  ) {
    super(
      `${tool}: the connection to the bridge leader ${kind === "refused" ? "was refused" : "broke"} (${describeCause(cause)}).`,
      { cause }
    );
    this.name = "LeaderConnectionError";
  }
}

/**
 * Follower proxies MCP tool calls to the leader via HTTP /rpc. Each request
 * carries the install token in `Authorization: Bearer <token>`. A process with
 * the auditor role also sends `X-Figma-Bridge-Role: auditor`.
 */
export class Follower {
  constructor(
    private leaderUrl: string,
    private processRole: ProcessRole = null
  ) {}

  send(requestType: string, nodeIds?: string[], fileKey?: string): Promise<BridgeResponse> {
    return this.sendWithParams(requestType, nodeIds, undefined, fileKey);
  }

  async sendWithParams(
    requestType: string,
    nodeIds?: string[],
    params?: Record<string, unknown>,
    fileKey?: string
  ): Promise<BridgeResponse> {
    const rpcReq: RPCRequest = { tool: requestType };
    if (nodeIds && nodeIds.length > 0) rpcReq.nodeIds = nodeIds;
    if (params && Object.keys(params).length > 0) rpcReq.params = params;
    if (fileKey) rpcReq.fileKey = fileKey;

    const rpcResp = await this.post(rpcReq, followerTimeoutMs(requestType));

    if (rpcResp.error) {
      throw new Error(rpcResp.error);
    }

    return {
      type: requestType,
      requestId: "",
      data: rpcResp.data,
    };
  }

  /**
   * The identity report of this process: the commit of this build, and what the
   * leader reports about its own build, its start time, and the connected files.
   */
  async identityReport(): Promise<IdentityReport> {
    const rpcResp = await this.post({ tool: "list_files" }, IDENTITY_TIMEOUT_MS);
    if (rpcResp.error) {
      throw new Error(rpcResp.error);
    }

    const leader = rpcResp.data as Partial<LeaderIdentity> | undefined;
    if (
      typeof leader !== "object" ||
      leader === null ||
      !Array.isArray(leader.files) ||
      typeof leader.leaderCommit !== "string" ||
      typeof leader.leaderStartedAt !== "string"
    ) {
      throw new Error(
        "The leader answered list_files in an old shape. It runs an older build of the bridge: stop the leader process, then restart the bridge processes from the current build."
      );
    }
    // A leader of an older build sends no health.
    const sent = leader.health;
    const health: Health =
      typeof sent === "object" && sent !== null && Array.isArray(sent.events)
        ? { events: sent.events, pending: sent.pending, warnings: [...(sent.warnings ?? [])] }
        : { events: [], pending: 0, warnings: [] };
    if (leader.leaderCommit !== BRIDGE_COMMIT) {
      // A standalone leader keeps running across an update until it is restarted.
      health.warnings.push(
        `This MCP server runs the build ${BRIDGE_COMMIT}, but the leader runs ${leader.leaderCommit}. Restart the process of the older build: a standalone leader keeps running across an update until it is restarted.`
      );
    }
    return {
      bridgeCommit: BRIDGE_COMMIT,
      leaderCommit: leader.leaderCommit,
      leaderStartedAt: leader.leaderStartedAt,
      files: leader.files,
      // A leader of an older build sends no journal.
      journal:
        typeof leader.journal === "object" && leader.journal !== null ? leader.journal : null,
      health,
    };
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.leaderUrl}/ping`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Sends one request to `/rpc` and reads the answer.
   * @param rpcReq - The request.
   * @param timeoutMs - How long to wait for the whole answer.
   * @returns The body of a 200 answer.
   * @throws The error of the body for another status, a time-out error, or a
   *   `LeaderConnectionError` when the connection failed.
   */
  private async post(rpcReq: RPCRequest, timeoutMs: number): Promise<RPCResponse> {
    // Outside the try: a bad token file is not a connection failure.
    const headers = rpcHeaders(this.processRole);
    const payload = JSON.stringify(rpcReq);
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.leaderUrl}/rpc`, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === "TimeoutError") {
        logEvent("leader_timeout", { tool: rpcReq.tool, ms: timeoutMs });
        throw new Error(
          `${rpcReq.tool} timed out: no answer from the bridge leader within ${seconds(timeoutMs)} s. ` +
            `The leader may be busy, and a write may still complete in Figma. ` +
            `Check with get_node before you retry; if it repeats, ask the user to restart the bridge.`
        );
      }
      throw new LeaderConnectionError(rpcReq.tool, notConnected(err) ? "refused" : "broken", err);
    }

    let body: RPCResponse | null = null;
    try {
      body = JSON.parse(text) as RPCResponse;
    } catch {
      // Not JSON: the status speaks for itself.
    }
    if (!response.ok || body === null) {
      // The leader answers validation failures with a 400 whose body names the
      // offending field — surface it instead of a bare status code (#35).
      throw new Error(body?.error ?? `Leader returned status ${response.status}`);
    }
    return body;
  }
}

/** How long a follower waits for the identity report of the leader. */
const IDENTITY_TIMEOUT_MS = 5_000;

/** The codes of a connection that never opened: the request did not leave this process. */
const NOT_CONNECTED_CODES = new Set(["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * Whether a failed fetch never opened its connection. fetch wraps the cause:
 * an error with a code, or an AggregateError when it tried more than one address.
 */
function notConnected(err: unknown): boolean {
  const cause = (err as { cause?: unknown } | null)?.cause as
    { code?: unknown; errors?: unknown } | undefined;
  if (typeof cause?.code === "string" && NOT_CONNECTED_CODES.has(cause.code)) return true;
  return (
    Array.isArray(cause?.errors) &&
    cause.errors.length > 0 &&
    cause.errors.every((one: { code?: unknown } | null) =>
      NOT_CONNECTED_CODES.has(String(one?.code))
    )
  );
}

/** The code or the message of the cause of a failed fetch. */
function describeCause(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause ?? err;
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return cause instanceof Error ? cause.message : String(cause);
}

function rpcHeaders(role: ProcessRole): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${rpcToken()}`,
  };
  if (role === AUDITOR_ROLE) headers[ROLE_HEADER] = AUDITOR_ROLE;
  return headers;
}
