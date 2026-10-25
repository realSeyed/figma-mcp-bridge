import { Leader, leaderUrl } from "./leader.js";
import { Follower } from "./follower.js";
import { AUDITOR_ROLE } from "./role.js";
import type { ProcessRole } from "./role.js";
import { Role } from "./types.js";
import type { BridgeResponse, IdentityReport } from "./types.js";

/**
 * Node is the dynamic handler that switches between leader and follower roles.
 * It routes MCP tool calls to the appropriate backend based on its current role.
 */
export class Node {
  private _role: Role = Role.Unknown;
  private leader: Leader | null = null;
  private follower: Follower;

  /**
   * @param port - The bridge port.
   * @param processRole - The `FIGMA_BRIDGE_ROLE` of this process. The follower marks each
   *   request with it, and the write journal of a leader records it with each own call.
   */
  constructor(
    private port: number,
    private processRole: ProcessRole = null
  ) {
    this.follower = new Follower(leaderUrl(port), processRole);
  }

  get role(): Role {
    return this._role;
  }

  get roleName(): string {
    switch (this._role) {
      case Role.Leader:
        return "LEADER";
      case Role.Follower:
        return "FOLLOWER";
      default:
        return "UNKNOWN";
    }
  }

  send(requestType: string, nodeIds?: string[], fileKey?: string): Promise<BridgeResponse> {
    return this.sendWithParams(requestType, nodeIds, undefined, fileKey);
  }

  sendWithParams(
    requestType: string,
    nodeIds?: string[],
    params?: Record<string, unknown>,
    fileKey?: string
  ): Promise<BridgeResponse> {
    if (this._role === Role.Leader && this.leader) {
      return this.leader
        .getBridge()
        .sendWithParams(requestType, nodeIds, params, fileKey, this.processRole === AUDITOR_ROLE);
    }
    return this.follower.sendWithParams(requestType, nodeIds, params, fileKey);
  }

  /**
   * The identity of the instrument: the commit of this process, the commit and
   * the start time of the leader, and each connected file with its plugin build
   * and epoch. A follower asks the leader.
   */
  async identityReport(): Promise<IdentityReport> {
    if (this._role === Role.Leader && this.leader) {
      return this.leader.identityReport();
    }
    return this.follower.identityReport();
  }

  async becomeLeader(): Promise<void> {
    if (this._role === Role.Leader) return;

    const leader = new Leader(this.port);
    await leader.start();

    this.leader = leader;
    this._role = Role.Leader;
    console.error("Became LEADER");
  }

  becomeFollower(): void {
    if (this._role === Role.Follower) return;

    if (this.leader) {
      this.leader.stop();
      this.leader = null;
    }

    this._role = Role.Follower;
    console.error("Became FOLLOWER");
  }

  stop(): void {
    if (this.leader) {
      this.leader.stop();
      this.leader = null;
    }
    this._role = Role.Unknown;
  }
}
