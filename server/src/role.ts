/**
 * The auditor role (BR-3): a process that only reads.
 *
 * `FIGMA_BRIDGE_ROLE=auditor` makes the process register the tools of
 * `AUDITOR_TOOLS` and no other. Each `/rpc` request that the process sends
 * carries the header `X-Figma-Bridge-Role: auditor`, and the leader refuses a
 * marked request for a tool that is not allowed.
 *
 * The role keeps an agent in check. It is not a sandbox: a local process that
 * can read the install token can still send a request without the mark.
 *
 * The role governs the tools and the requests of its own process only. A
 * leader with the auditor role relays each request of another process as it
 * is, because the leader applies the rule to a request with the mark only.
 *
 * This module imports types only, so the leader, the follower, and the start
 * file can all import it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const ROLE_VARIABLE = "FIGMA_BRIDGE_ROLE";
export const AUDITOR_ROLE = "auditor";

/** The request header that marks a request of the auditor process. */
export const ROLE_HEADER = "X-Figma-Bridge-Role";

/** The tools of the auditor role. A new read tool joins this list on purpose, with its test. */
export const AUDITOR_TOOLS: readonly string[] = [
  "list_files",
  "get_document",
  "get_metadata",
  "get_node",
  "get_instance",
  "get_component",
  "list_components",
  "get_variable_defs",
  "get_styles",
  "list_fonts",
  "list_sections",
  "get_section",
  "dump_nodes",
  "save_screenshots",
  "scroll_and_zoom_into_view",
];

/**
 * The internal commands behind `dump_nodes`, `save_screenshots` and
 * `dump_journal`. A marked request may use them. `get_screenshot` is also a
 * tool, but the auditor process does not register it. No command that can
 * write is on this list.
 */
export const AUDITOR_INTERNAL_COMMANDS: readonly string[] = [
  "dump_nodes_chunk",
  "get_screenshot",
  "dump_journal_chunk",
];

export type ProcessRole = "auditor" | null;

/**
 * The role of this process.
 * @param raw - The value of `FIGMA_BRIDGE_ROLE`.
 * @returns `"auditor"`, or `null` for an unset or empty value (the full tool set).
 * @throws If the value is set, not empty, and not exactly `auditor`.
 */
export function parseRole(raw: string | undefined): ProcessRole {
  if (raw === undefined || raw === "") return null;
  if (raw === AUDITOR_ROLE) return AUDITOR_ROLE;
  throw new Error(
    `Invalid ${ROLE_VARIABLE} "${raw}": the only allowed value is "${AUDITOR_ROLE}" (exactly, in lowercase). Unset ${ROLE_VARIABLE} for the full tool set.`
  );
}

/**
 * Whether the leader runs a marked request for `tool`.
 * @param tool - The tool or the internal command of the request.
 */
export function auditorMayCall(tool: string): boolean {
  return AUDITOR_TOOLS.includes(tool) || AUDITOR_INTERNAL_COMMANDS.includes(tool);
}

export interface RestrictedServer {
  /** Pass this to `registerTools`: it drops each tool outside the list. */
  server: McpServer;
  /** The names that reached the real server. */
  registered: ReadonlySet<string>;
}

/**
 * Wraps the server so that `tool` and `registerTool` register a tool of
 * `allowed` only. A tool outside the list never exists, not for a moment.
 * @param server - The MCP server.
 * @param allowed - The names that may be registered.
 */
export function restrictServer(server: McpServer, allowed: readonly string[]): RestrictedServer {
  const registered = new Set<string>();
  // A stand-in for the handle of a tool that was not registered.
  const skipped = { remove() {}, enable() {}, disable() {}, update() {}, enabled: false };

  const guard =
    (method: "tool" | "registerTool") =>
    (name: string, ...rest: unknown[]): unknown => {
      if (!allowed.includes(name)) return skipped;
      registered.add(name);
      return (server[method] as (...args: unknown[]) => unknown)(name, ...rest);
    };

  const proxy = new Proxy(server, {
    get(target, property) {
      if (property === "tool" || property === "registerTool") return guard(property);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { server: proxy, registered };
}

/**
 * The tools of `expected` that are not in `registered`.
 * @param registered - The names that were registered.
 * @param expected - The names that must be registered.
 */
export function missingTools(
  registered: ReadonlySet<string>,
  expected: readonly string[]
): string[] {
  return expected.filter((name) => !registered.has(name));
}
