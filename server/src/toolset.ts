/**
 * The tool set of a process and the MCP annotations of each tool.
 *
 * `FIGMA_BRIDGE_TOOLSET=design` drops the tools that an executor building a
 * design never needs: the beta motion tools, the evidence tools, the HTML
 * import, `get_design_context` (superseded by `get_node` with `depth`) and
 * `set_selection`. Each turn of the executor then carries fewer tool
 * definitions. Unset or `full` keeps every tool, so an existing MCP
 * configuration keeps working. The auditor role ignores the variable.
 *
 * This module imports `journal.ts` for `READ_ONLY_REQUESTS`, and types.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { READ_ONLY_REQUESTS } from "./journal.js";

export const TOOLSET_VARIABLE = "FIGMA_BRIDGE_TOOLSET";

export type Toolset = "full" | "design";

/** The tools that the `design` set drops. */
export const DESIGN_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "get_motion_styles",
  "get_node_motion",
  "apply_animation_style",
  "remove_animation_style",
  "apply_manual_keyframe_track",
  "remove_manual_keyframe_track",
  "set_timeline_duration",
  "dump_nodes",
  "dump_journal",
  "save_screenshots",
  "import_html_layers",
  "get_design_context",
  "set_selection",
]);

/**
 * The tool set of this process.
 * @param raw - The value of `FIGMA_BRIDGE_TOOLSET`.
 * @returns `"full"` for an unset or empty value or `full`, else `"design"`.
 * @throws If the value is set, not empty, and neither `full` nor `design`.
 */
export function parseToolset(raw: string | undefined): Toolset {
  if (raw === undefined || raw === "" || raw === "full") return "full";
  if (raw === "design") return "design";
  throw new Error(
    `Invalid ${TOOLSET_VARIABLE} "${raw}": the allowed values are "full" and "design" (exactly, in lowercase). Unset ${TOOLSET_VARIABLE} for the full tool set.`
  );
}

/**
 * Whether a tool set registers a tool.
 * @param toolset - The tool set.
 * @returns The predicate for `restrictServer`.
 */
export function toolsetAllows(toolset: Toolset): (name: string) => boolean {
  return toolset === "design" ? (name) => !DESIGN_EXCLUDED_TOOLS.has(name) : () => true;
}

/**
 * The reads that still change something: a file on disk, or the viewport of
 * the editor. They are on `READ_ONLY_REQUESTS` because they write nothing to
 * the Figma file, but a client must not run them as free reads.
 */
const READS_WITH_EFFECTS: ReadonlySet<string> = new Set([
  "dump_nodes",
  "save_screenshots",
  "dump_journal",
  "scroll_and_zoom_into_view",
]);

/** The tools that remove something that only an undo in Figma brings back. */
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set(["detach_instance", "clear_paints"]);

/**
 * The MCP annotations of a tool: `readOnlyHint` for a tool that changes
 * neither the Figma file nor a local file, `destructiveHint` for a tool that
 * removes something.
 * @param name - The tool name.
 * @returns The annotations, or undefined for a write that only adds or changes.
 */
export function toolAnnotations(name: string): ToolAnnotations | undefined {
  if (READ_ONLY_REQUESTS.has(name) && !READS_WITH_EFFECTS.has(name)) {
    return { readOnlyHint: true };
  }
  if (name.startsWith("delete_") || DESTRUCTIVE_TOOLS.has(name)) {
    return { readOnlyHint: false, destructiveHint: true };
  }
  return undefined;
}
