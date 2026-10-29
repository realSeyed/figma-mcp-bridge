import { logEvent, setLogRole } from "./diagnostics.js";
import { Leader, leaderUrl } from "./leader.js";
import { Follower, LeaderConnectionError } from "./follower.js";
import { JOURNAL_CHUNK_REQUEST, READ_ONLY_REQUESTS } from "./journal.js";
import { AUDITOR_ROLE } from "./role.js";
import type { ProcessRole } from "./role.js";
import { Role } from "./types.js";
import type { BridgeResponse, IdentityReport } from "./types.js";

/** How long a call waits for the bridge to recover after it lost its leader. */
const RECOVERY_WAIT_MS = 8_000;
/** How often it checks in that time. */
const RECOVERY_POLL_MS = 250;

/**
 * Node is the dynamic handler that switches between leader and follower roles.
 * It routes MCP tool calls to the appropriate backend based on its current role.
 *
 * A call that loses its leader on the way (the follower path, also while the
 * role is still unknown) runs the recovery of `setRecovery` and waits until
 * this process is the leader or a leader answers `/ping`. Then it sends the
 * call again, once, when the leader never got it or when it is a read. A write
 * that may have reached the plugin is not sent again: its error says so.
 */
export class Node {
  private _role: Role = Role.Unknown;
  private leader: Leader | null = null;
  private follower: Follower;
  private recovery: (() => Promise<void>) | null = null;

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

  /**
   * Sets what a call runs when it lost its leader: one election check now.
   * @param recovery - `Election.checkNow` of this process.
   */
  setRecovery(recovery: () => Promise<void>): void {
    this.recovery = recovery;
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
    return this.withRecovery(requestType, () =>
      this.sendOnce(requestType, nodeIds, params, fileKey)
    );
  }

  private sendOnce(
    requestType: string,
    nodeIds?: string[],
    params?: Record<string, unknown>,
    fileKey?: string
  ): Promise<BridgeResponse> {
    if (this._role === Role.Leader && this.leader) {
      // The leader reads its own journal: the chunk command never reaches the plugin.
      if (requestType === JOURNAL_CHUNK_REQUEST) {
        const leader = this.leader;
        return new Promise((resolve) => {
          resolve({ type: requestType, requestId: "", data: leader.journalChunk(params) });
        });
      }
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
    return this.withRecovery("list_files", async () => {
      if (this._role === Role.Leader && this.leader) {
        return this.leader.identityReport();
      }
      return this.follower.identityReport();
    });
  }

  /**
   * Runs a call, and recovers once when the connection to the leader failed.
   * @param tool - The request type: a read is sent again after a broken connection.
   * @param call - The call, by the role of this process at the time it runs.
   * @returns What the call returns.
   * @throws Each error of the call that is not a connection failure, and an
   *   error that says what happened to the request when the recovery does not help.
   */
  private async withRecovery<T>(tool: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof LeaderConnectionError)) throw err;
      const resend = err.kind === "refused" || READ_ONLY_REQUESTS.has(tool);
      console.error(`${tool}: lost the bridge leader (${err.kind}); recovering`);
      logEvent("leader_lost", { tool, kind: err.kind });
      const began = Date.now();
      const recovered = await this.recover();
      logEvent(recovered ? "recovered" : "recovery_failed", { tool, ms: Date.now() - began });
      if (!recovered) throw new Error(unrecovered(tool, err.kind));
      if (!resend) {
        logEvent("ambiguous_write", { tool });
        throw new Error(
          `${tool}: the bridge leader process exited while the request was in flight, so the change may or may not be in the Figma file. The bridge has recovered; check the file with get_node before you retry.`
        );
      }
      console.error(`${tool}: the bridge recovered (${this.roleName}); sending the request again`);
      logEvent("retry", { tool });
      try {
        return await call();
      } catch (again) {
        if (again instanceof LeaderConnectionError) throw new Error(unrecovered(tool, again.kind));
        throw again;
      }
    }
  }

  /**
   * Runs the recovery and waits until this process is the leader or a leader
   * answers `/ping`.
   * @returns False when neither happened within `RECOVERY_WAIT_MS`.
   */
  private async recover(): Promise<boolean> {
    const deadline = Date.now() + RECOVERY_WAIT_MS;
    for (;;) {
      await this.recovery?.();
      if (this._role === Role.Leader || (await this.follower.ping())) return true;
      if (Date.now() + RECOVERY_POLL_MS > deadline) return false;
      await new Promise((done) => setTimeout(done, RECOVERY_POLL_MS));
    }
  }

  async becomeLeader(): Promise<void> {
    if (this._role === Role.Leader) return;

    const leader = new Leader(this.port);
    await leader.start();

    const previous = this.roleName;
    this.leader = leader;
    this._role = Role.Leader;
    setLogRole(this.roleName);
    // A follower that becomes the leader took over from a leader that stopped.
    logEvent("role", { from: previous, to: this.roleName, takeover: previous === "FOLLOWER" });
    console.error("Became LEADER");
  }

  becomeFollower(): void {
    if (this._role === Role.Follower) return;

    if (this.leader) {
      this.leader.stop();
      this.leader = null;
    }

    const previous = this.roleName;
    this._role = Role.Follower;
    setLogRole(this.roleName);
    logEvent("role", { from: previous, to: this.roleName });
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

/**
 * The error of a call whose leader was lost and whose recovery did not help.
 * @param tool - The request type.
 * @param kind - How the connection failed: a refused one never reached the plugin.
 */
function unrecovered(tool: string, kind: LeaderConnectionError["kind"]): string {
  const retry =
    "Retry in a few seconds; if it fails again, ask the user to restart the bridge (the MCP server).";
  if (kind === "refused") {
    return `${tool}: the bridge leader is not reachable, and no bridge process took over within ${RECOVERY_WAIT_MS / 1000} s, so the request was not sent to Figma. ${retry}`;
  }
  if (READ_ONLY_REQUESTS.has(tool)) {
    return `${tool}: the connection to the bridge leader broke while the request was in flight, and no bridge process took over within ${RECOVERY_WAIT_MS / 1000} s. ${retry}`;
  }
  return `${tool}: the bridge leader process exited while the request was in flight, so the change may or may not be in the Figma file, and no bridge process took over within ${RECOVERY_WAIT_MS / 1000} s. Wait a few seconds, check the file with get_node, then retry; if the bridge does not answer, ask the user to restart it.`;
}
