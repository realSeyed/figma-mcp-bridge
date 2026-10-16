/** A raw HTTP `/rpc` request to the leader, as a follower sends it. */

export interface RpcAnswer {
  status: number;
  body: { data?: unknown; error?: string };
}

/**
 * Posts one JSON request to `http://127.0.0.1:<port>/rpc`.
 * @param port - The leader port.
 * @param body - The request: `tool`, and optionally `nodeIds`, `params`, `fileKey`.
 * @returns The status and the parsed body.
 */
export async function postRpc(port: number, body: Record<string, unknown>): Promise<RpcAnswer> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: (await response.json()) as RpcAnswer["body"] };
}
