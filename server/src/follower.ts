import { BRIDGE_COMMIT } from "./build-info.js";
import { AUDITOR_ROLE, ROLE_HEADER } from "./role.js";
import type { ProcessRole } from "./role.js";
import { rpcToken } from "./rpc-token.js";
import type {
  BridgeResponse,
  IdentityReport,
  LeaderIdentity,
  RPCRequest,
  RPCResponse,
} from "./types.js";

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

    const response = await fetch(`${this.leaderUrl}/rpc`, {
      method: "POST",
      headers: rpcHeaders(this.processRole),
      body: JSON.stringify(rpcReq),
      signal: AbortSignal.timeout(210_000),
    });

    if (!response.ok) {
      // The leader answers validation failures with a 400 whose body names the
      // offending field — surface it instead of a bare status code (#35).
      const body = (await response.json().catch(() => null)) as RPCResponse | null;
      throw new Error(body?.error ?? `Leader returned status ${response.status}`);
    }

    const rpcResp = (await response.json()) as RPCResponse;

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
    const response = await fetch(`${this.leaderUrl}/rpc`, {
      method: "POST",
      headers: rpcHeaders(this.processRole),
      body: JSON.stringify({ tool: "list_files" } as RPCRequest),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as RPCResponse | null;
      throw new Error(body?.error ?? `Leader returned status ${response.status}`);
    }

    const rpcResp = (await response.json()) as RPCResponse;
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
    return {
      bridgeCommit: BRIDGE_COMMIT,
      leaderCommit: leader.leaderCommit,
      leaderStartedAt: leader.leaderStartedAt,
      files: leader.files,
      // A leader of an older build sends no journal.
      journal:
        typeof leader.journal === "object" && leader.journal !== null ? leader.journal : null,
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
}

function rpcHeaders(role: ProcessRole): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${rpcToken()}`,
  };
  if (role === AUDITOR_ROLE) headers[ROLE_HEADER] = AUDITOR_ROLE;
  return headers;
}
