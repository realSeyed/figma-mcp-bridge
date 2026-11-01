/**
 * The guidance that the server gives an executor model, so that no chat has to
 * coach it: the MCP `instructions` of the server (a client adds them to its
 * system instructions) and the `design_session` prompt (a client shows it as a
 * slash command).
 *
 * Each tool name in backticks must be a tool of the set the text goes to;
 * `server/test/guide.test.ts` checks it, and the length limits.
 *
 * This module imports types only.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** The most characters of `SERVER_INSTRUCTIONS`. */
export const MAX_SERVER_INSTRUCTIONS_CHARS = 4_000;

/** The most characters of `AUDITOR_INSTRUCTIONS`. */
export const MAX_AUDITOR_INSTRUCTIONS_CHARS = 1_500;

/** The most characters of `DESIGN_SESSION_PROMPT`. */
export const MAX_DESIGN_SESSION_PROMPT_CHARS = 8_000;

/** The name of the MCP prompt. */
export const DESIGN_SESSION_PROMPT_NAME = "design_session";

/** The instructions of the full and the design tool sets. */
export const SERVER_INSTRUCTIONS = `You edit a live Figma file through a plugin. Work in this order.

1. Start: call \`list_files\`. When it lists more than one file, pass fileKey on every call. Call \`get_design_system\` to learn the variables, text styles and components. Find targets with \`find_nodes\` (name, types, withinId). Read with \`get_node\` and detail: "outline" with depth 1 or 2. Never read a whole page in full.
2. Build with \`batch\`: one component or one page section per batch. A later op takes { "ref": "<op id>" } for the node an earlier op made, or { "ref": "<op id>", "path": "results.0.id" } for a value inside its result. Give every batch a batchId: a retry with the same batchId and ops returns the first result and runs nothing. Never send writes in parallel: set wait_for_previous, or put the writes in one batch.
3. Always pass parentId. Name each node Area/Thing (Card/Title, PLP/Grid), so that \`find_nodes\` finds it after you lose context.
4. Auto layout: make the container with \`create_frame\` and layoutMode, padding, itemSpacing and its sizing. Give each child layoutSizingHorizontal: "FILL". Give a text a width or FILL and textAutoResize: "HEIGHT", so that it wraps. A badge on top of the flow takes layoutPositioning: "ABSOLUTE". A grid is a HORIZONTAL frame with layoutWrap: "WRAP" and counterAxisSpacing.
5. Design system first: variables (\`create_variable_collection\`, \`create_variables\`) bound with \`bind_variables\`; text styles (\`create_text_style\`, \`apply_text_style\`); components (\`create_component\` -> \`combine_as_variants\` -> \`add_component_property\` -> \`bind_component_property\`). Then instances: \`create_instance\` with variantProperties, and \`set_instance_properties\` with [{ "name": "Title", "value": "Mug" }].
6. Images: \`set_image_fill\` with a PNG or JPEG of at most 4096 px per side. Items with the same source load it one time; reuse the imageHash it returns. The \`create_instance\` result lists the children of the new instance, so { "ref": "card", "path": "children.0.id" } names its image layer. Icons: \`create_svg\`.
7. Verify with \`get_screenshot\` of the changed component or section, not of the page.
8. Errors:
- "may or may not be in the file": look with \`find_nodes\` or \`get_node\` before you retry.
- "No plugin connected": ask the user to run the plugin in Figma, then call \`list_files\`.
- A validation error lists every bad item: correct all of them and send again.
- A result-size error: narrow the read with detail: "outline", depth, withinId or limit.`;

/** The instructions of the auditor role. */
export const AUDITOR_INSTRUCTIONS = `Auditor role: this process only reads. No tool here changes the Figma file.

- Call \`list_files\` first. Record its bridgeCommit, pluginBuild and epoch with each finding. When it lists more than one file, pass fileKey on every call.
- Map a page with \`get_document\` or \`get_node\` and detail: "outline" with depth 1 or 2, then read the part you review in full with \`get_node\`.
- Components: \`list_components\`, \`get_component\`, \`get_instance\`. Tokens: \`get_variable_defs\`, \`get_styles\`, \`list_fonts\`. Sections: \`list_sections\`, \`get_section\`.
- Evidence goes to disk and each call returns a manifest: \`dump_nodes\` (node trees), \`save_screenshots\` (captures), \`dump_journal\` (the write journal). Cite the manifest path and the SHA-256, not the content.
- \`scroll_and_zoom_into_view\` moves the viewport only.
- A result-size error: narrow the read with depth, detail: "outline" or a smaller node.`;

/** The text of the `design_session` prompt. */
export const DESIGN_SESSION_PROMPT = `Build an e-commerce design in the open Figma file, step by step. Follow the server instructions; this prompt adds the order of work, the names and the checks.

Order of work. Finish each step before the next one.
1. Tokens: one collection "Tokens" (\`create_variable_collection\`), then color, spacing, radius and type-size variables (\`create_variables\`), named color/brand, color/text, space/4, radius/md.
2. Type ramp: text styles Display, Heading, Body and Caption (\`create_text_style\`).
3. Primitives on a page "Components" (\`create_page\`): Button, Input, Badge, Price, Rating, Icon. Make each variant an auto-layout frame, convert it (\`create_component\`), join the variants (\`combine_as_variants\`), add TEXT, BOOLEAN or INSTANCE_SWAP properties (\`add_component_property\`) and link the layers (\`bind_component_property\`). Bind fills, radii and spacing to the tokens (\`bind_variables\`) and texts to the styles (\`apply_text_style\`).
4. Composites from instances of the primitives: ProductCard, CartItem, Nav, Footer.
5. Templates: frames of 375, 768 and 1440 px wide, each an auto-layout column with Nav, a content slot and Footer.
6. Pages, one page each: PLP, PDP, Cart, Checkout, Account, Admin. Build a page in sections (header, filters, grid, footer), one \`batch\` per section.

Names.
- Pages: Components, PLP, PDP, Cart, Checkout, Account, Admin.
- Components: Button, ProductCard. Variants: Variant=Primary, Size=Large.
- Layers: Area/Thing, such as Card/Image, Card/Title, PLP/Grid, PLP/Header.
- Properties: Title, Price, Sale, Label.

Per-step checklist.
- One \`batch\` with a batchId, every op with parentId, refs between the ops.
- Text: a width or FILL, and textAutoResize: "HEIGHT".
- Children of an auto-layout frame: FILL or HUG, not a fixed size, unless the design needs one.
- Fills, radii and spacing bound to the tokens; texts on the styles.
- Product images: one \`set_image_fill\` call for all cards, one source each.
- Icons: \`create_svg\`, named Icon/<name>.
- Check the result with \`get_screenshot\` of the component or section, and \`get_node\` with detail: "outline" and depth 1.
- Fix what the screenshot shows before the next step.

Recovery.
- After a lost context, call \`list_files\`, then \`find_nodes\` with the Area/ name of the step you were on. Continue from what exists; never build a second copy.
- A batch that stopped rolled back its new nodes: correct the op it names and send the batch again with a new batchId.
- A batch that failed without a result (a time-out, a lost connection): send it again with the same batchId. A replayed result says replayed: true and runs nothing.
- "may or may not be in the file": look with \`find_nodes\` or \`get_node\` before you retry.
- "No plugin connected": ask the user to run the plugin, then call \`list_files\` again.
- A result-size error: read less (detail: "outline", depth, withinId, limit).`;

/**
 * Registers the `design_session` prompt. Call it for the full and the design
 * tool sets only: the auditor role builds nothing.
 * @param server - The MCP server.
 */
export function registerDesignSessionPrompt(server: McpServer): void {
  server.prompt(
    DESIGN_SESSION_PROMPT_NAME,
    "Build an e-commerce design system and its pages in the open Figma file: the order of work, the names, a checklist per step, and the recovery rules.",
    () => ({
      messages: [{ role: "user", content: { type: "text", text: DESIGN_SESSION_PROMPT } }],
    })
  );
}
