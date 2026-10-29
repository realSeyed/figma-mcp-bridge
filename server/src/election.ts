import { leaderUrl } from "./leader.js";
import type { Node } from "./node.js";
import { Role } from "./types.js";

/**
 * Election handles leader detection and role transitions.
 *
 * On start it attempts to become leader (by binding the port).
 * If the port is taken and a healthy leader is found, it becomes a follower.
 * A periodic ticker monitors the leader and triggers takeover if it dies.
 * A call that lost its leader runs one check at once with `checkNow`.
 */
export class Election {
  private interval: ReturnType<typeof setInterval> | null = null;
  private leaderUrl: string;
  /** The check that runs now. Each caller in that time waits for the same one. */
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private port: number,
    private node: Node
  ) {
    this.leaderUrl = leaderUrl(port);
  }

  async start(): Promise<void> {
    // Determine initial role
    await this.determineRole();

    // Continuous monitoring with random jitter (1-2 s)
    const jitter = 1_000 + Math.random() * 1_000;
    this.interval = setInterval(() => void this.checkNow(), jitter);
  }

  stop(): void {
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Runs one check now: a process with no role determines it, and a follower
   * whose leader does not answer takes over. A call while a check runs gets
   * the promise of that check. It never rejects.
   */
  checkNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running === null) {
      this.running = this.checkAndUpdateRole()
        .catch((err) => {
          console.error("Election check error:", err);
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  private async checkAndUpdateRole(): Promise<void> {
    switch (this.node.role) {
      case Role.Follower: {
        const alive = await this.pingLeader();
        if (!alive) {
          console.error("Leader not responding, attempting takeover...");
          try {
            await this.node.becomeLeader();
          } catch (err) {
            console.error("Failed to become leader:", err);
          }
        }
        break;
      }
      case Role.Leader:
        // Nothing to do — we are the leader
        break;
      case Role.Unknown:
        await this.determineRole();
        break;
    }
  }

  private async determineRole(): Promise<void> {
    // Try to become leader first
    try {
      await this.node.becomeLeader();
      return;
    } catch {
      // Port likely in use — check if there's a valid leader
    }

    if (await this.pingLeader()) {
      this.node.becomeFollower();
    }
    // If ping fails too, next tick will retry
  }

  private async pingLeader(): Promise<boolean> {
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
