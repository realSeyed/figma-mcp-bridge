/**
 * A real server process: `node dist/index.js`, driven through the MCP client
 * over stdio. Run `bun run build` in `server/` first; `bun run test` does.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SERVER_ENTRY = join(SERVER_ROOT, "dist", "index.js");

/** The variables of the developer that never leak into a test process. */
const STRIPPED_VARIABLES = [
  "FIGMA_BRIDGE_OUTPUT_ROOT",
  "FIGMA_BRIDGE_TOKEN_FILE",
  "FIGMA_BRIDGE_JOURNAL_FILE",
  "FIGMA_BRIDGE_DUMP_CHUNK_NODES",
  "FIGMA_BRIDGE_JOURNAL_CHUNK_ENTRIES",
  "FIGMA_BRIDGE_ROLE",
];

/** How long a process has to log its role. */
const ROLE_TIMEOUT_MS = 15_000;

export interface ServerOptions {
  port: number;
  /** The script to run. The default is `dist/index.js` of this checkout. */
  entry?: string;
  /** The working directory of the process. */
  cwd: string;
  /**
   * Changes to the environment of this test process. A value of `undefined`
   * removes the variable. `FIGMA_BRIDGE_OUTPUT_ROOT`,
   * `FIGMA_BRIDGE_TOKEN_FILE`, `FIGMA_BRIDGE_JOURNAL_FILE`,
   * `FIGMA_BRIDGE_DUMP_CHUNK_NODES`, `FIGMA_BRIDGE_JOURNAL_CHUNK_ENTRIES`, and
   * `FIGMA_BRIDGE_ROLE` are removed unless
   * they are given here, so a variable of the developer does not leak into a test.
   * `FIGMA_BRIDGE_TOKEN_FILE` and `FIGMA_BRIDGE_JOURNAL_FILE` are required: no
   * test reads the real token file or the real write journal.
   */
  env?: Record<string, string | undefined>;
}

export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: string };

/** One content block of a tool result, as the MCP client gives it. */
export interface RawContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface RawToolResult {
  isError: boolean;
  content: RawContentBlock[];
}

export interface ServerProcess {
  role: "LEADER" | "FOLLOWER";
  /** Each line the process wrote to standard error. */
  stderr: string[];
  /** The names that `tools/list` returns. */
  listTools(): Promise<string[]>;
  /** Calls one tool and parses its text content as JSON. */
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolOutcome>;
  /** Calls one tool and returns its content blocks as they are, images too. */
  callToolRaw(name: string, args?: Record<string, unknown>): Promise<RawToolResult>;
  close(): Promise<void>;
}

/**
 * Starts the server and waits until it logs `Became LEADER` or `Became FOLLOWER`.
 * @param options - Port, working directory, and environment changes.
 * @returns The running process.
 */
export async function startServer(options: ServerOptions): Promise<ServerProcess> {
  const env = serverEnv(options);

  const transport = new StdioClientTransport({
    command: "node",
    args: [options.entry ?? SERVER_ENTRY],
    cwd: options.cwd,
    env,
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim() !== "") stderr.push(line.trim());
    }
  });

  const client = new Client({ name: "figma-bridge-test", version: "1.0.0" }, { capabilities: {} });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close();
  };

  try {
    await client.connect(transport);
    const role = await waitForRole(stderr);
    return {
      role,
      stderr,
      close,
      async listTools() {
        const names: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor === undefined ? undefined : { cursor });
          names.push(...page.tools.map((tool) => tool.name));
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        return names;
      },
      async callToolRaw(name, args = {}) {
        const result = await client.callTool({ name, arguments: args }, undefined, {
          timeout: 30_000,
        });
        return {
          isError: result.isError === true,
          content: (result.content ?? []) as RawContentBlock[],
        };
      },
      async callTool(name, args = {}) {
        const result = await client.callTool({ name, arguments: args }, undefined, {
          timeout: 30_000,
        });
        const text = ((result.content ?? []) as Array<{ type: string; text?: string }>)
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
        if (result.isError === true) return { ok: false, error: text };
        try {
          return { ok: true, data: JSON.parse(text) as unknown };
        } catch {
          return { ok: false, error: `${name} returned text that is not JSON: ${text}` };
        }
      },
    };
  } catch (err) {
    await close().catch(() => undefined);
    const log = stderr.length > 0 ? `\nserver log:\n${stderr.join("\n")}` : "";
    throw new Error(
      `Could not start ${options.entry ?? SERVER_ENTRY} (run \`bun run build\` in server/): ${
        err instanceof Error ? err.message : String(err)
      }${log}`
    );
  }
}

/**
 * The environment of a server process: this process, less the stripped
 * variables, plus the port and the changes in `options.env`.
 * @param options - Port and environment changes.
 * @returns The environment.
 * @throws If `FIGMA_BRIDGE_TOKEN_FILE` is not given.
 */
export function serverEnv(options: Pick<ServerOptions, "port" | "env">): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !STRIPPED_VARIABLES.includes(key)) env[key] = value;
  }
  env.FIGMA_BRIDGE_PORT = String(options.port);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  if (!env.FIGMA_BRIDGE_TOKEN_FILE) {
    throw new Error(
      "A test server needs FIGMA_BRIDGE_TOKEN_FILE: no test reads the real token file."
    );
  }
  if (!env.FIGMA_BRIDGE_JOURNAL_FILE) {
    throw new Error(
      "A test server needs FIGMA_BRIDGE_JOURNAL_FILE: no test reads or writes the real write journal."
    );
  }
  return env;
}

async function waitForRole(stderr: string[]): Promise<"LEADER" | "FOLLOWER"> {
  const deadline = Date.now() + ROLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const line of stderr) {
      if (line.includes("Became LEADER")) return "LEADER";
      if (line.includes("Became FOLLOWER")) return "FOLLOWER";
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no role after ${ROLE_TIMEOUT_MS} ms`);
}
