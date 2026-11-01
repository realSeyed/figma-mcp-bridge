import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../node.js";
import * as variables from "./variables.js";
import * as typography from "./typography.js";
import * as components from "./components.js";
import * as sections from "./sections.js";
import * as paints from "./paints.js";
import * as assets from "./assets.js";
import * as dumps from "./dumps.js";
import * as journal from "./journal.js";
import * as discovery from "./discovery.js";

export type {
  ExtensionRegister,
  ExtensionRpcMap,
  ExtensionRpcSchemaMap,
  ExtensionSchemaMap,
  RpcArgMapper,
} from "./types.js";

/**
 * Every extension tool schema, merged from the area files. Spread into
 * `toolInputSchemas` in `schema.ts`.
 *
 * Declared without a type annotation so the key literals survive: `ToolName` is
 * `keyof typeof toolInputSchemas`, and widening it to `string` would stop the
 * compiler reporting a tool that has no RPC mapper.
 */
export const extensionSchemas = {
  ...variables.schemas,
  ...typography.schemas,
  ...components.schemas,
  ...sections.schemas,
  ...paints.schemas,
  ...assets.schemas,
  ...dumps.schemas,
  ...journal.schemas,
  ...discovery.schemas,
};

/** Every extension RPC mapper, merged from the area files. */
export const extensionRpcToArgs = {
  ...variables.rpcToArgs,
  ...typography.rpcToArgs,
  ...components.rpcToArgs,
  ...sections.rpcToArgs,
  ...paints.rpcToArgs,
  ...assets.rpcToArgs,
  ...dumps.rpcToArgs,
  ...journal.rpcToArgs,
  ...discovery.rpcToArgs,
};

/**
 * Every wire-shape override, merged from the area files that export one.
 * Spread into `rpcInputSchemas` in `schema.ts`, after the advertised schemas.
 */
export const extensionRpcSchemas = {
  ...assets.rpcSchemas,
};

/**
 * Registers every extension tool. Called at the end of `registerTools`.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 */
export function registerExtensionTools(server: McpServer, node: Node): void {
  variables.register(server, node);
  typography.register(server, node);
  components.register(server, node);
  sections.register(server, node);
  paints.register(server, node);
  assets.register(server, node);
  dumps.register(server, node);
  journal.register(server, node);
  discovery.register(server, node);
}
