#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Node } from "./node.js";
import { BRIDGE_COMMIT } from "./build-info.js";
import { logEvent } from "./diagnostics.js";
import { Election } from "./election.js";
import { LEADER_HOST, leaderUrl } from "./leader.js";
import { describeOutputRoot } from "./output-root.js";
import { AUDITOR_TOOLS, missingTools, parseRole, restrictServer, ROLE_VARIABLE } from "./role.js";
import type { ProcessRole } from "./role.js";
import { rpcToken } from "./rpc-token.js";
import { checkTimingSettings } from "./timeouts.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

// This fork defaults to 1995 so it runs beside a stock bridge on 1994 without
// joining its leader election. Still overridable. The plugin must be built with
// the matching VITE_FIGMA_BRIDGE_WS URL (which must also be listed in the
// plugin manifest's networkAccess.allowedDomains).
function resolvePort(): number {
  const raw = process.env.FIGMA_BRIDGE_PORT;
  if (raw === undefined) return 1995;
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    // An explicitly set but invalid value must not silently join another
    // bridge's election — fail loudly instead.
    console.error(`Invalid FIGMA_BRIDGE_PORT "${raw}" — expected an integer between 1 and 65535`);
    process.exit(1);
  }
  return port;
}
const PORT = resolvePort();

// A set role other than exactly "auditor" stops the process at start: a typo
// must not give the full tool set to a process that was meant to only read.
function resolveRole(): ProcessRole {
  try {
    return parseRole(process.env[ROLE_VARIABLE]);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
const ROLE = resolveRole();

// A bad timing value stops the process at start, not at the first tool call.
try {
  checkTimingSettings();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// A standalone leader serves the plugin and the followers, and has no MCP
// client: it lives until a signal, not as long as the first MCP client.
const STANDALONE_VARIABLE = "FIGMA_BRIDGE_STANDALONE";
function resolveStandalone(): boolean {
  if (process.argv.slice(2).includes("--standalone")) return true;
  const raw = process.env[STANDALONE_VARIABLE]?.trim();
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  console.error(
    `Invalid ${STANDALONE_VARIABLE} "${raw}": set it to 1 for a standalone leader, or unset it.`
  );
  process.exit(1);
}
const STANDALONE = resolveStandalone();

/**
 * Runs the standalone leader: it binds the port or exits with 1, and never
 * follows. No MCP transport and no standard input handler: only a signal stops it.
 */
async function runStandalone(): Promise<void> {
  rpcToken();
  logEvent("start", {
    version: VERSION,
    bridgeCommit: BRIDGE_COMMIT,
    port: PORT,
    standalone: true,
  });
  const node = new Node(PORT, ROLE);
  try {
    await node.becomeLeader();
  } catch (err) {
    const holder = await readPing(PORT);
    console.error(
      holder !== null
        ? `A bridge leader already listens on ${LEADER_HOST}:${PORT} (version ${holder.version ?? "unknown"}, leaderStartedAt ${holder.leaderStartedAt ?? "unknown"}, bridgeCommit ${holder.bridgeCommit ?? "unknown"}). Stop it first, or set another FIGMA_BRIDGE_PORT.`
        : `The standalone leader could not listen on ${LEADER_HOST}:${PORT}: ${err instanceof Error ? err.message : String(err)}. Free the port, or set another FIGMA_BRIDGE_PORT.`
    );
    process.exit(1);
  }
  console.error(`Standalone leader listening on ${LEADER_HOST}:${PORT}`);

  let shuttingDown = false;
  const shutdown = (reason: string, code = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Shutting down (${reason})...`);
    logEvent("shutdown", { reason });
    node.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
  });
}

/** What `/ping` of the leader on `port` reports, or null when nothing answers. */
async function readPing(
  port: number
): Promise<{ version?: string; leaderStartedAt?: string; bridgeCommit?: string } | null> {
  try {
    const response = await fetch(`${leaderUrl(port)}/ping`, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? ((await response.json()) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (STANDALONE) {
    await runStandalone();
    return;
  }
  console.error(describeOutputRoot());
  // Read the install token now: a bad token file stops the process at start,
  // not at the first tool call. The token itself is never logged.
  rpcToken();
  logEvent("start", {
    version: VERSION,
    bridgeCommit: BRIDGE_COMMIT,
    port: PORT,
    standalone: false,
    tools: ROLE ?? "full",
  });

  const node = new Node(PORT, ROLE);
  const election = new Election(PORT, node);
  // A call that lost its leader runs an election check at once, not at the next tick.
  node.setRecovery(() => election.checkNow());
  await election.start();

  let transport: StdioServerTransport | null = null;
  let shuttingDown = false;
  const shutdown = async (reason: string, code: number = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Shutting down (${reason})...`);
    logEvent("shutdown", { reason });

    const force = setTimeout(() => {
      console.error("Shutdown timeout exceeded, forcing exit");
      process.exit(code);
    }, 5000);
    force.unref();

    election.stop();
    node.stop();
    if (transport) {
      try {
        await transport.close();
      } catch (err) {
        console.error("Transport close error:", err);
      }
    }
    process.exit(code);
  };

  process.stdin.on("end", () => void shutdown("stdin end"));
  process.stdin.on("close", () => void shutdown("stdin close"));

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  process.on("uncaughtException", async (err) => {
    console.error("Uncaught exception:", err);
    await shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
  });

  const server = new McpServer({
    name: "figma-bridge",
    version: VERSION,
  });

  if (ROLE === null) {
    registerTools(server, node, PORT);
  } else {
    const restricted = restrictServer(server, AUDITOR_TOOLS);
    registerTools(restricted.server, node, PORT);
    // A renamed tool must not make the list shorter without notice.
    const missing = missingTools(restricted.registered, AUDITOR_TOOLS);
    if (missing.length > 0) {
      console.error(
        `The ${ROLE} role lists tools that no code registers: ${missing.join(", ")}. Correct AUDITOR_TOOLS in server/src/role.ts or the tool names.`
      );
      await shutdown("auditor tool list mismatch", 1);
      return;
    }
  }

  console.error(`Starting MCP server (role: ${node.roleName}, tools: ${ROLE ?? "full"})`);

  transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
