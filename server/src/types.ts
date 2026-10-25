export interface BridgeRequest {
  type: string;
  requestId: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
}

export interface BridgeResponse {
  type: string;
  requestId: string;
  data?: unknown;
  error?: string;
}

export interface RPCRequest {
  tool: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
  fileKey?: string;
}

export interface RPCResponse {
  data?: unknown;
  error?: string;
}

export interface ConnectedFile {
  fileKey: string;
  fileName: string;
  /** The build of the plugin that holds the connection, or "unknown". */
  pluginBuild: string;
  /**
   * How many times a plugin has connected for this file key since the leader
   * started. A connection that replaces a live one counts too. A disconnect and
   * a read leave it as it is.
   */
  epoch: number;
}

/** The state of the write journal of the leader (BR-8). */
export interface JournalState {
  /** `broken` when the chain failed its check or an append failed. */
  status: "ok" | "broken";
  /** The entries in the file. */
  entryCount: number;
  /** The `hash` of the last entry, or the genesis hash. */
  headHash: string;
  /** Why the journal is broken: the line and the cause. Only with `broken`. */
  reason?: string;
}

/** What the leader knows: its own build, its start time, and the connected files. */
export interface LeaderIdentity {
  /** The commit of the leader build. */
  leaderCommit: string;
  /** When the process became the leader, as an ISO 8601 UTC time. */
  leaderStartedAt: string;
  files: ConnectedFile[];
  /** The write journal of the leader, or null from a leader of an older build. */
  journal: JournalState | null;
}

/**
 * The report of `/ping` (less the status and the version) and of `list_files`.
 * `bridgeCommit` is the commit of the process that serves the call. It equals
 * `leaderCommit` when that process is the leader.
 */
export interface IdentityReport extends LeaderIdentity {
  bridgeCommit: string;
}

/** The identity of one file, as a manifest records it. */
export interface FileIdentity extends ConnectedFile {
  bridgeCommit: string;
  leaderCommit: string;
  leaderStartedAt: string;
}

export enum Role {
  Unknown = 0,
  Leader = 1,
  Follower = 2,
}
