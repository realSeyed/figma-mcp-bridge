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
  /** How long the leader waits for the answer. */
  timeoutMs?: number;
}

/** Returns the `data` of the answer. A throw becomes an `error` answer. */
export type PluginHandler = (request: PluginRequest) => unknown | Promise<unknown>;

export interface PluginOptions {
  port: number;
  fileKey: string;
  fileName?: string;
  /** The `pluginBuild` query parameter. Omitted when not given, as an older plugin does. */
  pluginBuild?: string;
  handlers?: Record<string, PluginHandler>;
}

export interface SimulatedPlugin {
  /** Each request the plugin got, in order. */
  requests: PluginRequest[];
  /**
   * Stops reading from the socket; sending still works. A close frame of the
   * leader then waits unread, so the socket stays open on this side, and an
   * answer sent now still reaches the leader. `close` reads again first.
   */
  pause(): void;
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
 * The bytes of a PNG header with the given size: the signature and the IHDR
 * chunk, then zero padding. It is not a picture a viewer can open, but the
 * server reads only the header.
 * @param width - Pixel width.
 * @param height - Pixel height.
 * @param padding - Bytes of zero padding after the header.
 * @returns The bytes.
 */
export function pngWithSize(width: number, height: number, padding = 0): Buffer {
  const header = Buffer.alloc(33 + padding);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8; // bit depth
  header[25] = 6; // colour type
  return header;
}

/**
 * The bytes of a JPG header with the given size: SOI, an APP0 segment, one SOF0
 * segment, and EOI. The server reads only the header.
 * @param width - Pixel width.
 * @param height - Pixel height.
 * @returns The bytes.
 */
export function jpgWithSize(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  ]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // components
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** What a `screenshotHandler` callback returns for one node. */
export interface SimulatedCapture {
  format: "PNG" | "JPG" | "SVG" | "PDF";
  bytes: Uint8Array;
  nodeName?: string;
}

/**
 * A `get_screenshot` handler that answers each node with the capture that the
 * callback builds. A throw becomes an `error` answer, as in the plugin.
 * @param build - Builds the capture of one node from its ID and the request.
 * @returns The handler.
 */
export const screenshotHandler =
  (build: (nodeId: string, request: PluginRequest) => SimulatedCapture): PluginHandler =>
  (request) => ({
    exports: (request.nodeIds ?? []).map((nodeId) => {
      const capture = build(nodeId, request);
      return {
        nodeId,
        nodeName: capture.nodeName ?? `node ${nodeId}`,
        format: capture.format,
        base64: Buffer.from(capture.bytes).toString("base64"),
        width: 1,
        height: 1,
      };
    }),
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
  if (options.pluginBuild !== undefined) query.set("pluginBuild", options.pluginBuild);
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
    pause: () => socket.pause(),
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.resume();
        socket.once("close", () => resolve());
        socket.close();
        setTimeout(() => {
          socket.terminate();
          resolve();
        }, 2_000).unref();
      }),
  };
}
