import type { z } from "zod";
import { READ_ONLY_REQUESTS } from "./journal.js";
import type { BridgeResponse } from "./types.js";

/**
 * Helpers shared by `tools.ts` and the tool registrations under `extensions/`.
 * Kept in their own module so an extension file never has to import
 * `tools.ts`, which would close an import cycle through `registerTools`.
 */

/** One block of a tool result. An image goes to the conversation as an image block, never as base64 in text. */
export type ToolContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
};

export const MAX_RESULT_CHARS_VARIABLE = "FIGMA_BRIDGE_MAX_RESULT_CHARS";

/**
 * The most characters of JSON text that one tool result hands an agent.
 * Gemini CLI cuts a text result over 40,000 characters to its first 8,000 and
 * last 32,000, after it wraps the text in 41 characters of tags, so the
 * default stays under that cut.
 */
export const DEFAULT_MAX_RESULT_CHARS = 38_000;

/**
 * The limit of a tool result, from `FIGMA_BRIDGE_MAX_RESULT_CHARS` when it is
 * set. `index.ts` reads it at start, so a bad value stops the process there.
 * @returns Characters.
 * @throws If the variable is set, but not to an integer of 1 or more.
 */
export function maxResultChars(): number {
  const raw = process.env[MAX_RESULT_CHARS_VARIABLE]?.trim();
  if (!raw) return DEFAULT_MAX_RESULT_CHARS;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `Invalid ${MAX_RESULT_CHARS_VARIABLE} "${raw}": it must be an integer of 1 or more, in characters. Correct it or unset it, then restart the server.`
    );
  }
  return value;
}

/** The options of `renderResponse`. */
export interface RenderOptions {
  /**
   * The tool name. A tool on `READ_ONLY_REQUESTS` gets an error when its
   * result is too large; any other tool, or none, gets `resultOmitted`.
   */
  tool?: string;
}

/**
 * The result of a call whose JSON text passes the limit.
 *
 * A read changed nothing, so it fails and says how to narrow the call. A write
 * has already changed the file: it must not look failed, or the agent calls it
 * again and makes the change twice. It succeeds with no data.
 * @param tool - The tool name, when the caller gave it.
 * @param chars - The characters of the JSON text.
 * @param limit - The limit.
 * @returns The tool result.
 */
function oversizedResult(tool: string | undefined, chars: number, limit: number): ToolResult {
  if (tool !== undefined && READ_ONLY_REQUESTS.has(tool)) {
    return {
      content: [
        {
          type: "text",
          text: `${tool} returned ${chars} characters, more than a tool result may hand an agent (${limit}). Narrow the call — a nodeId, depth, detail: "outline", query, limit, or a filter — or use find_nodes or get_design_system for a compact view.`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          resultOmitted: true,
          chars,
          note: "The call succeeded; its result was too large to return. Read what changed with find_nodes or get_node.",
        }),
      },
    ],
  };
}

/**
 * Wraps a bridge call and converts the result into a tool result. A result
 * whose JSON text passes `maxResultChars` is replaced: see `oversizedResult`.
 * @param fn - Bridge call to execute.
 * @param options - The tool name, which every read tool passes.
 * @returns Tool result with the bridge response or an error message.
 */
export async function renderResponse(
  fn: () => Promise<BridgeResponse>,
  options: RenderOptions = {}
): Promise<ToolResult> {
  try {
    const resp = await fn();
    if (resp.error) {
      return {
        content: [{ type: "text", text: resp.error }],
        isError: true,
      };
    }
    const text = JSON.stringify(resp.data);
    const limit = maxResultChars();
    if (text !== undefined && text.length > limit) {
      return oversizedResult(options.tool, text.length, limit);
    }
    return {
      content: [{ type: "text", text }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: err instanceof Error ? err.message : String(err),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Parses raw tool arguments with a Zod schema and returns a typed result or a tool error.
 * @param schema - Zod schema to validate against.
 * @param args - Raw arguments from the MCP client.
 * @returns Parsed data on success, or an error tool result on failure.
 */
export function parseToolInput<T>(
  // Input type is left open so transforming schemas (whose output differs from
  // their input, e.g. the alias-normalising set_* inputs) can be passed in.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  args: unknown
): { success: true; data: T } | { success: false; error: ToolResult } {
  const result = schema.safeParse(args);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    error: {
      content: [{ type: "text", text: result.error.issues[0].message }],
      isError: true,
    },
  };
}
