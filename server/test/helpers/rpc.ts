/** A raw HTTP `/rpc` request to the leader, as a follower sends it. */

export interface RpcAnswer {
  status: number;
  headers: Headers;
  body: { data?: unknown; error?: string };
}

export interface RawRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Sends one request to `http://127.0.0.1:<port>/rpc` with only the given headers.
 * @param port - The leader port.
 * @param request - Method (default POST), headers, and body.
 * @returns The status, the headers, and the parsed body (empty if it is not JSON).
 */
export async function rawRpc(port: number, request: RawRequest): Promise<RpcAnswer> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: request.method ?? "POST",
    headers: request.headers ?? {},
    body: request.body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body: RpcAnswer["body"] = {};
  try {
    body = JSON.parse(text) as RpcAnswer["body"];
  } catch {
    // Not JSON: keep the empty body.
  }
  return { status: response.status, headers: response.headers, body };
}

/**
 * Posts one JSON request to the leader with the install token, as a follower does.
 * @param port - The leader port.
 * @param token - The install token.
 * @param body - The request: `tool`, and optionally `nodeIds`, `params`, `fileKey`.
 * @returns The status, the headers, and the parsed body.
 */
export async function postRpc(
  port: number,
  token: string,
  body: Record<string, unknown>
): Promise<RpcAnswer> {
  return rawRpc(port, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
