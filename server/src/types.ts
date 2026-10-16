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

export enum Role {
  Unknown = 0,
  Leader = 1,
  Follower = 2,
}
