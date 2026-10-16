/**
 * A simulated plugin: a `ws` client that connects to the leader as the Figma
 * plugin does, and answers each request from a map of request type to handler.
 */

import WebSocket from "ws";

export interface PluginRequest {
  type: string;
  requestId: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
}

/** Returns the `data` of the answer. A throw becomes an `error` answer. */
export type PluginHandler = (request: PluginRequest) => unknown | Promise<unknown>;

export interface PluginOptions {
  port: number;
  fileKey: string;
  fileName?: string;
  handlers?: Record<string, PluginHandler>;
}

export interface SimulatedPlugin {
  /** Each request the plugin got, in order. */
  requests: PluginRequest[];
  close(): Promise<void>;
}

/** A PNG of 1 x 1 pixel, in base64. */
export const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * A `get_screenshot` handler that answers each node with the PNG above.
 * @param request - The request.
 * @returns The plugin answer.
 */
export const pngScreenshot: PluginHandler = (request) => ({
  exports: (request.nodeIds ?? []).map((nodeId) => ({
    nodeId,
    nodeName: `node ${nodeId}`,
    format: "PNG",
    base64: PNG_1X1_BASE64,
    width: 1,
    height: 1,
  })),
});

/**
 * Connects to `ws://127.0.0.1:<port>/ws` and waits until the socket is open.
 * @param options - Port, file, and the request handlers.
 * @returns The connected plugin.
 */
export async function connectPlugin(options: PluginOptions): Promise<SimulatedPlugin> {
  const query = new URLSearchParams({
    fileKey: options.fileKey,
    fileName: options.fileName ?? "harness",
  });
  const socket = new WebSocket(`ws://127.0.0.1:${options.port}/ws?${query.toString()}`);
  const requests: PluginRequest[] = [];
  const handlers = options.handlers ?? {};

  socket.on("message", async (raw) => {
    const request = JSON.parse(raw.toString()) as PluginRequest;
    requests.push(request);
    const answer: Record<string, unknown> = { type: request.type, requestId: request.requestId };
    const handler = handlers[request.type];
    if (!handler) {
      answer.error = `The simulated plugin has no handler for "${request.type}"`;
    } else {
      try {
        answer.data = await handler(request);
      } catch (err) {
        answer.error = err instanceof Error ? err.message : String(err);
      }
    }
    socket.send(JSON.stringify(answer));
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  return {
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once("close", () => resolve());
        socket.close();
        setTimeout(() => {
          socket.terminate();
          resolve();
        }, 2_000).unref();
      }),
  };
}
