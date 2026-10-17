import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lookup } from "node:dns/promises";
import { readFile, realpath, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { z } from "zod";
import type { Node } from "./node.js";
import {
  createFrameInput,
  createImageInput,
  createPageInput,
  importHtmlLayersInput,
  createShapeShape,
  createTextShape,
  createShapeInput,
  createTextInput,
  setNodePropertiesInput,
  setGradientFillInput,
  setSolidFillInput,
  setSolidFillShape,
  setTextContentShape,
  setEffectsShape,
  setEffectsInput,
  setStrokePropertiesInput,
  setAutoLayoutInput,
  setSelectionInput,
  scrollAndZoomIntoViewInput,
  groupNodesInput,
  ungroupNodeInput,
  setTextPropertiesShape,
  setTextPropertiesInput,
  toolInputSchemas,
} from "./schema.js";
import { parseToolInput, renderResponse } from "./tool-helpers.js";
import type { ToolResult } from "./tool-helpers.js";
import { registerExtensionTools } from "./extensions/index.js";
import { executeSaveScreenshots, screenshotToolResult } from "./captures.js";
import { canonicalJson } from "./evidence.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_REDIRECTS = 5;

/**
 * Registers all Figma bridge tools on the given MCP server.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 * @param port - The bridge port. The node makes the follower-to-leader calls, so no tool reads it now.
 */
export function registerTools(server: McpServer, node: Node, port: number): void {
  server.tool(
    "list_files",
    "List all currently connected Figma files and the identity of the instrument. Returns { bridgeCommit, leaderCommit, leaderStartedAt, files }; each file has fileKey, fileName, pluginBuild and epoch. The epoch grows at each plugin connection for that key, so a change shows a plugin reload. Use the fileKey to target a specific file in other tools.",
    async (): Promise<ToolResult> => {
      try {
        const report = await node.identityReport();
        return {
          content: [{ type: "text", text: JSON.stringify(report) }],
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
  );

  server.tool(
    "get_document",
    "Get the current Figma page document tree. When multiple files are connected, specify fileKey.",
    toolInputSchemas.get_document.shape,
    async ({ fileKey }): Promise<ToolResult> => {
      return renderResponse(() => node.send("get_document", undefined, fileKey));
    }
  );

  server.tool(
    "get_selection",
    "Get the currently selected nodes in Figma. When multiple files are connected, specify fileKey.",
    toolInputSchemas.get_selection.shape,
    async ({ fileKey }): Promise<ToolResult> => {
      return renderResponse(() => node.send("get_selection", undefined, fileKey));
    }
  );

  server.tool(
    "get_node",
    "Get a specific Figma node by ID. Accepts top-level IDs like '4029:12345' and instance-child IDs like 'I12740:17806;12740:17793'. Never use hyphens. When multiple files are connected, specify fileKey.",
    toolInputSchemas.get_node.shape,
    async ({ nodeId, fileKey }): Promise<ToolResult> => {
      return renderResponse(() => node.send("get_node", [nodeId], fileKey));
    }
  );

  server.tool(
    "get_styles",
    "Get all local styles in the document. When multiple files are connected, specify fileKey.",
    toolInputSchemas.get_styles.shape,
    async ({ fileKey }): Promise<ToolResult> => {
      return renderResponse(() => node.send("get_styles", undefined, fileKey));
    }
  );

  server.tool(
    "get_metadata",
    "Get metadata about the current Figma document including file name, pages, and current page info. When multiple files are connected, specify fileKey.",
    toolInputSchemas.get_metadata.shape,
    async ({ fileKey }): Promise<ToolResult> => {
      return renderResponse(() => node.send("get_metadata", undefined, fileKey));
    }
  );

  server.tool(
    "get_design_context",
    "Get the design context for the current selection or page. Returns a summarized tree structure optimized for understanding the current design context. When multiple files are connected, specify fileKey.",
    toolInputSchemas.get_design_context.shape,
    async ({ depth, fileKey }): Promise<ToolResult> => {
      const params: Record<string, unknown> = {};
      if (depth !== undefined && depth > 0) {
        params.depth = depth;
      }
      return renderResponse(() =>
        node.sendWithParams("get_design_context", undefined, params, fileKey)
      );
    }
  );

  server.tool(
    "get_variable_defs",
    "Get all local variable definitions: collections with their default mode, and every variable with its resolved type, scopes, description, and per-mode values. Variables are Figma's system for design tokens (colors, numbers, strings, booleans). When multiple files are connected, specify fileKey.",
    toolInputSchemas.get_variable_defs.shape,
    async ({ fileKey }): Promise<ToolResult> => {
      return renderResponse(() => node.send("get_variable_defs", undefined, fileKey));
    }
  );

  server.tool(
    "get_screenshot",
    "Export a screenshot of the selected nodes or specific nodes by ID. A PNG or JPG whose long edge is 1568 pixels or less and whose size is 3750000 bytes or less comes back as an image block plus a text block with its metadata (nodeId, nodeName, format, pixelWidth, pixelHeight, bytes). Any other export (SVG, PDF, a larger raster image) comes back as JSON text with base64-encoded data. For a large capture, or for evidence, use save_screenshots. When multiple files are connected, specify fileKey.",
    toolInputSchemas.get_screenshot.shape,
    async ({ nodeIds, format, scale, clip, fileKey }): Promise<ToolResult> => {
      const params: Record<string, unknown> = {};
      if (format) params.format = format;
      if (scale !== undefined && scale > 0) params.scale = scale;
      if (clip !== undefined) params.clip = clip;
      try {
        return screenshotToolResult(
          await node.sendWithParams("get_screenshot", nodeIds, params, fileKey)
        );
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "set_node_visibility",
    "Show or hide specific Figma nodes. Returns previous visibility for each node so you can restore them after. Useful for isolating a single layer before exporting: hide all siblings, export the frame, then restore visibility.",
    toolInputSchemas.set_node_visibility.shape,
    async ({ items, fileKey }): Promise<ToolResult> => {
      return renderResponse(() =>
        node.sendWithParams("set_node_visibility", undefined, { items }, fileKey)
      );
    }
  );

  server.tool(
    "set_text_content",
    "Update the contents of a single text node. The plugin loads the node's fonts before applying the new text. Accepts either text or characters. When multiple files are connected, specify fileKey.",
    setTextContentShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(toolInputSchemas.set_text_content, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, text, fileKey } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("set_text_content", [nodeId], { text }, fileKey)
      );
    }
  );

  server.tool(
    "set_text_properties",
    "Patch common text properties such as font family/style, size, alignment, auto-resize, line height, letter spacing, fill color, and bounds. When multiple files are connected, specify fileKey.",
    setTextPropertiesShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(setTextPropertiesInput, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, fileKey, ...properties } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("set_text_properties", [nodeId], properties, fileKey)
      );
    }
  );

  server.tool(
    "set_node_properties",
    "Patch common node properties such as name, position, size, visibility, opacity, and corner radius. Only supported properties for the target node type may be changed. Use set_solid_fill or set_gradient_fill to change paints. When multiple files are connected, specify fileKey.",
    setNodePropertiesInput.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(toolInputSchemas.set_node_properties, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, fileKey, ...properties } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("set_node_properties", [nodeId], properties, fileKey)
      );
    }
  );

  server.tool(
    "set_solid_fill",
    "Replace a node's fill (or stroke) with a single solid paint. Provide a hex color and optional paint opacity — fillHex/fillOpacity are accepted as aliases. Use set_gradient_fill for gradient paints.",
    setSolidFillShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(setSolidFillInput, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, fileKey, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("set_solid_fill", [nodeId], params, fileKey));
    }
  );

  server.tool(
    "set_gradient_fill",
    "Replace a node's fill (or stroke) with a gradient paint. Provide ordered stops (position 0..1, hex color, optional alpha) and an optional 2x3 gradientTransform matching Figma's gradientTransform format. Useful for setting linear/radial/angular/diamond gradients programmatically.",
    setGradientFillInput.shape,
    async ({ nodeId, fileKey, ...params }): Promise<ToolResult> => {
      return renderResponse(() =>
        node.sendWithParams("set_gradient_fill", [nodeId], params, fileKey)
      );
    }
  );

  server.tool(
    "set_effects",
    "Replace a node's effects list (drop/inner shadows, layer/background blurs). Pass an empty array to clear all effects. Each entry mirrors the shape returned by get_node's `effects` field.",
    setEffectsShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(setEffectsInput, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, fileKey, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("set_effects", [nodeId], params, fileKey));
    }
  );

  server.tool(
    "set_stroke_properties",
    "Patch stroke geometry properties: weight, align, dash pattern, cap, join. Use set_solid_fill/set_gradient_fill with target='stroke' to set the paint itself.",
    setStrokePropertiesInput.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(toolInputSchemas.set_stroke_properties, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("set_stroke_properties", [nodeId], params, fileKey)
      );
    }
  );

  server.tool(
    "set_auto_layout",
    "Configure auto-layout on a frame: direction, gap, padding, alignment, sizing modes, wrap. Set layoutMode='NONE' to disable auto-layout on the frame.",
    setAutoLayoutInput.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(toolInputSchemas.set_auto_layout, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, fileKey, ...params } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("set_auto_layout", [nodeId], params, fileKey)
      );
    }
  );

  server.tool(
    "create_page",
    "Create a new page in the Figma document, optionally naming it and switching the editor to it. Returns the new page's ID, which can be passed as parentId to create_frame / create_text / create_shape / create_image to author content on that page. When multiple files are connected, specify fileKey.",
    createPageInput.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(toolInputSchemas.create_page, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("create_page", undefined, params, fileKey));
    }
  );

  server.tool(
    "create_frame",
    "Create a new frame, optionally inside a specified parent. You can set name, size, position, and a solid fill. When multiple files are connected, specify fileKey.",
    createFrameInput.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(toolInputSchemas.create_frame, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("create_frame", undefined, params, fileKey));
    }
  );

  server.tool(
    "create_text",
    "Create a new text node, optionally inside a specified parent. You can set its content, font, size, alignment, color, position, and bounds. When multiple files are connected, specify fileKey.",
    createTextShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(createTextInput, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("create_text", undefined, params, fileKey));
    }
  );

  server.tool(
    "create_shape",
    "Create a rectangle, ellipse, or line, optionally inside a specified parent. You can set its size, position, rotation, fill, and stroke. When multiple files are connected, specify fileKey.",
    createShapeShape.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(createShapeInput, args);
      if (!parsed.success) return parsed.error;
      const { fileKey, ...params } = parsed.data;
      return renderResponse(() => node.sendWithParams("create_shape", undefined, params, fileKey));
    }
  );

  server.tool(
    "create_image",
    "Create an image-backed rectangle from a local file path, remote URL, or data URI. You can set its parent, position, size, corner radius, and fit mode. When multiple files are connected, specify fileKey.",
    createImageInput.shape,
    async ({ source, fileKey, ...params }): Promise<ToolResult> => {
      try {
        const imageBase64 = await loadImageSourceAsBase64(source, process.cwd());
        return await renderResponse(() =>
          node.sendWithParams("create_image", undefined, { ...params, imageBase64 }, fileKey)
        );
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
  );

  server.tool(
    "import_html_layers",
    "Import a DOM serialization (JSON produced by html-figma's browser htmlToFigma()) as editable Figma layers inside a new wrapper frame — frames, text, rectangles, and SVG vectors in one call. Source must be a JSON file path inside the MCP server working directory. Optionally append the wrapper into an existing frame/section via parentId. Requires the plugin to be open in the design editor. When multiple files are connected, specify fileKey.",
    importHtmlLayersInput.shape,
    async ({ source, fileKey, ...params }): Promise<ToolResult> => {
      try {
        const layers = await loadLayersJson(source, process.cwd());
        return await renderResponse(() =>
          node.sendWithParams("import_html_layers", undefined, { ...params, layers }, fileKey)
        );
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
  );

  server.tool(
    "duplicate_nodes",
    "Duplicate one or more nodes in place. Each copy goes into the parent of its source, directly above it in the stack and on top of it on the canvas, so a node inside a section or a frame is copied where it stands. When multiple files are connected, specify fileKey.",
    toolInputSchemas.duplicate_nodes.shape,
    async ({ nodeIds, fileKey }): Promise<ToolResult> => {
      return renderResponse(() =>
        node.sendWithParams("duplicate_nodes", nodeIds, undefined, fileKey)
      );
    }
  );

  server.tool(
    "reparent_nodes",
    "Move one or more nodes into a different parent container. Each node keeps its own x and y, which are read against the new parent, so it moves on the canvas when the parents sit at different places — move_to_section and move_out_of_section keep the canvas position instead. A SECTION can only be moved to a page or to another section, because Figma keeps a section outside the frame tree. Every node is checked before the first move, so a refused call moves nothing. When multiple files are connected, specify fileKey.",
    toolInputSchemas.reparent_nodes.shape,
    async ({ nodeIds, parentId, fileKey }): Promise<ToolResult> => {
      return renderResponse(() =>
        node.sendWithParams("reparent_nodes", nodeIds, { parentId }, fileKey)
      );
    }
  );

  server.tool(
    "group_nodes",
    "Wrap a list of nodes in a new group. Nodes must share a common parent (or supply parentId explicitly). Returns the new group's node ID. A SECTION cannot go in a group — call create_section with nodeIds for that.",
    groupNodesInput.shape,
    async ({ nodeIds, fileKey, ...params }): Promise<ToolResult> => {
      return renderResponse(() => node.sendWithParams("group_nodes", nodeIds, params, fileKey));
    }
  );

  server.tool(
    "ungroup_node",
    "Ungroup a group, a frame, or a section — its children move up to its parent and the wrapper is removed. Returns the IDs of the orphaned children in their new parent. The children keep their stack order and take the stack position the wrapper held. Ungrouping a section keeps every child exactly where it is on the canvas; its parent is a page or another section, because Figma keeps a section outside the frame tree.",
    ungroupNodeInput.shape,
    async ({ nodeId, fileKey }): Promise<ToolResult> => {
      return renderResponse(() =>
        node.sendWithParams("ungroup_node", [nodeId], undefined, fileKey)
      );
    }
  );

  server.tool(
    "set_selection",
    "Set the current page selection to a list of node IDs. Pass an empty array to clear the selection. Works in both design editor and Dev Mode.",
    setSelectionInput.shape,
    async ({ nodeIds, fileKey }): Promise<ToolResult> => {
      return renderResponse(() =>
        node.sendWithParams("set_selection", nodeIds, undefined, fileKey)
      );
    }
  );

  server.tool(
    "scroll_and_zoom_into_view",
    "Scroll and zoom the Figma viewport so the given nodes are framed in view. Works in both design editor and Dev Mode.",
    scrollAndZoomIntoViewInput.shape,
    async ({ nodeIds, fileKey }): Promise<ToolResult> => {
      return renderResponse(() =>
        node.sendWithParams("scroll_and_zoom_into_view", nodeIds, undefined, fileKey)
      );
    }
  );

  server.tool(
    "delete_nodes",
    "Delete one or more nodes. This is destructive and requires confirm: true. Page and document nodes cannot be deleted through this tool. When multiple files are connected, specify fileKey.",
    toolInputSchemas.delete_nodes.shape,
    async ({ nodeIds, confirm, fileKey }): Promise<ToolResult> => {
      return renderResponse(() =>
        node.sendWithParams("delete_nodes", nodeIds, { confirm }, fileKey)
      );
    }
  );

  server.tool(
    "get_motion_styles",
    "List all available animation presets in Figma (Motion API beta). When multiple files are connected, specify fileKey.",
    toolInputSchemas.get_motion_styles.shape,
    async ({ fileKey }): Promise<ToolResult> => {
      return renderResponse(() => node.send("get_motion_styles", undefined, fileKey));
    }
  );

  server.tool(
    "get_node_motion",
    "Read a node's current animationStyles, animations, manualKeyframeTracks, and timelines (Motion API beta). When multiple files are connected, specify fileKey.",
    toolInputSchemas.get_node_motion.shape,
    async ({ nodeId, fileKey }): Promise<ToolResult> => {
      return renderResponse(() => node.send("get_node_motion", [nodeId], fileKey));
    }
  );

  server.tool(
    "apply_animation_style",
    "Apply a preset animation style to a node (Motion API beta). When multiple files are connected, specify fileKey.",
    toolInputSchemas.apply_animation_style.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(toolInputSchemas.apply_animation_style, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, fileKey, ...properties } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("apply_animation_style", [nodeId], properties, fileKey)
      );
    }
  );

  server.tool(
    "remove_animation_style",
    "Remove an applied animation style from a node (Motion API beta). If no animationStyleId is provided, removes all styles. When multiple files are connected, specify fileKey.",
    toolInputSchemas.remove_animation_style.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(toolInputSchemas.remove_animation_style, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, fileKey, ...properties } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("remove_animation_style", [nodeId], properties, fileKey)
      );
    }
  );

  server.tool(
    "apply_manual_keyframe_track",
    "Applies or replaces the manual Motion keyframe track for a property, paint, or effect field on a node. When multiple files are connected, specify fileKey.",
    toolInputSchemas.apply_manual_keyframe_track.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(toolInputSchemas.apply_manual_keyframe_track, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, fileKey, ...properties } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("apply_manual_keyframe_track", [nodeId], properties, fileKey)
      );
    }
  );

  server.tool(
    "remove_manual_keyframe_track",
    "Removes the manual Motion keyframe track for a property, paint, or effect field on a node. When multiple files are connected, specify fileKey.",
    toolInputSchemas.remove_manual_keyframe_track.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(toolInputSchemas.remove_manual_keyframe_track, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, fileKey, ...properties } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("remove_manual_keyframe_track", [nodeId], properties, fileKey)
      );
    }
  );

  server.tool(
    "set_timeline_duration",
    "Sets the duration (in seconds) for a timeline. When multiple files are connected, specify fileKey.",
    toolInputSchemas.set_timeline_duration.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(toolInputSchemas.set_timeline_duration, args);
      if (!parsed.success) return parsed.error;
      const { nodeId, fileKey, ...properties } = parsed.data;
      return renderResponse(() =>
        node.sendWithParams("set_timeline_duration", [nodeId], properties, fileKey)
      );
    }
  );

  server.tool(
    "save_screenshots",
    "Export screenshots for multiple nodes and save them to disk as evidence, under the output root of this server process (FIGMA_BRIDGE_OUTPUT_ROOT, or its working directory when unset). A relative outputPath resolves against the output root; a path outside it is refused. Returns only the manifest, never image data: for each item the path, bytes, SHA-256, pixel width and height, and scale; for the call the identity of the file, the totals, and manifestPath, the manifest file that is also written beside the first capture. A capture counts as evidence only when its SHA-256 equals the one in the manifest. A file is never overwritten: an outputPath that exists refuses the call before it reads anything. An item that fails does not fail the call; a plugin session that changes during the call does, and no file of the call remains. When multiple files are connected, specify fileKey.",
    toolInputSchemas.save_screenshots.shape,
    async (args): Promise<ToolResult> => {
      try {
        const manifest = await executeSaveScreenshots(node, args);
        return { content: [{ type: "text", text: canonicalJson(manifest) }] };
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
  );

  registerExtensionTools(server, node);
}

/**
 * Loads an image source as a base64 string from a URL, data URI, or local file.
 * @param source - Image source: URL, data URI, or local file path.
 * @param workspaceRoot - Root directory for resolving relative local paths.
 * @returns Base64-encoded image bytes.
 */
const MAX_LAYERS_JSON_BYTES = 16 * 1024 * 1024;

/**
 * Reads and parses an html-figma layer-tree JSON file from inside the
 * workspace root. Mirrors the local-path rules of loadImageSourceAsBase64.
 * @param source - JSON file path (absolute or relative to the workspace root).
 * @param workspaceRoot - The MCP server working directory.
 * @returns The parsed layer tree (root LayerNode).
 */
async function loadLayersJson(
  source: string,
  workspaceRoot: string
): Promise<Record<string, unknown>> {
  const resolvedRoot = await realpath(path.resolve(workspaceRoot));
  const lexicalPath = path.resolve(resolvedRoot, source);
  // Resolve symlinks before the containment check — a workspace-local symlink
  // must not be able to point the read outside the working directory.
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(lexicalPath);
  } catch {
    throw new Error(`Layers source not found: ${source}`);
  }
  const relativePath = path.relative(resolvedRoot, resolvedPath);
  const escapesRoot = relativePath.startsWith("..") || path.isAbsolute(relativePath);
  if (escapesRoot) {
    throw new Error(
      `layers source must be inside the MCP server working directory: ${resolvedRoot}`
    );
  }
  // Check the size before reading so an oversized file is rejected without
  // allocating its contents.
  const info = await stat(resolvedPath);
  if (!info.isFile()) {
    throw new Error(`Layers source is not a regular file: ${source}`);
  }
  if (info.size > MAX_LAYERS_JSON_BYTES) {
    throw new Error(`Layers JSON exceeds ${MAX_LAYERS_JSON_BYTES} bytes`);
  }
  const bytes = await readFile(resolvedPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Layers source is not valid JSON: ${source}`);
  }
  // htmlToFigma() returns a single root LayerNode; tolerate a one-element array.
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!root || typeof root !== "object" || typeof (root as { type?: unknown }).type !== "string") {
    throw new Error(
      "Layers JSON must be an html-figma LayerNode tree (object with a `type` field)"
    );
  }
  return root as Record<string, unknown>;
}

async function loadImageSourceAsBase64(source: string, workspaceRoot: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const bytes = await fetchImageBytes(source);
    return bytes.toString("base64");
  }

  const dataUrlMatch = source.match(/^data:.*?;base64,(.+)$/);
  if (dataUrlMatch) {
    return dataUrlMatch[1];
  }

  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(resolvedRoot, source);
  const relativePath = path.relative(resolvedRoot, resolvedPath);
  const escapesRoot = relativePath.startsWith("..") || path.isAbsolute(relativePath);
  if (escapesRoot) {
    throw new Error(
      `image source must be inside the MCP server working directory: ${resolvedRoot}`
    );
  }
  const bytes = await readFile(resolvedPath);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  return bytes.toString("base64");
}

/**
 * Fetches image bytes from a remote URL with redirect and timeout limits.
 * @param source - HTTP or HTTPS image URL.
 * @returns Raw image bytes.
 */
async function fetchImageBytes(source: string): Promise<Buffer> {
  let url = new URL(source);
  let redirects = 0;

  while (true) {
    await assertSafeHttpUrl(url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Timed out fetching image after ${IMAGE_FETCH_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) {
        throw new Error(`Image redirect missing Location header: ${resp.status}`);
      }
      redirects += 1;
      if (redirects > MAX_IMAGE_REDIRECTS) {
        throw new Error(`Image fetch exceeded ${MAX_IMAGE_REDIRECTS} redirects`);
      }
      url = new URL(location, url);
      continue;
    }

    if (!resp.ok) {
      throw new Error(`Failed to fetch image: ${resp.status} ${resp.statusText}`);
    }

    const contentLength = resp.headers.get("content-length");
    if (contentLength !== null) {
      const size = Number(contentLength);
      if (!Number.isFinite(size) || size < 0) {
        throw new Error("Invalid image Content-Length header");
      }
      if (size > MAX_IMAGE_BYTES) {
        throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
      }
    }

    return readBoundedResponse(resp, MAX_IMAGE_BYTES);
  }
}

/**
 * Validates that an image URL uses a safe public HTTP(S) endpoint.
 * @param url - URL to validate.
 */
async function assertSafeHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Image URL must use http or https");
  }
  if (!url.hostname) {
    throw new Error("Image URL must include a hostname");
  }

  const hostname = normalizeHostname(url.hostname);
  const literalIp = isIP(hostname);
  if (literalIp !== 0) {
    if (isBlockedIp(hostname)) {
      throw new Error("Image URL resolves to a blocked internal address");
    }
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error("Image URL hostname did not resolve");
  }
  if (addresses.some((address) => isBlockedIp(address.address))) {
    throw new Error("Image URL resolves to a blocked internal address");
  }
}

/**
 * Checks whether an IP address is in a private, loopback, or otherwise blocked range.
 * @param address - IPv4 or IPv6 address string.
 * @returns True if the address is blocked for SSRF protection.
 */
function isBlockedIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isBlockedIp(normalized.slice("::ffff:".length));
  }

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]:/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

/**
 * Strips surrounding brackets from an IPv6 hostname so it can be parsed as an IP.
 * @param hostname - Hostname string, possibly bracketed.
 * @returns Normalized hostname without brackets.
 */
function normalizeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Reads a response body up to a maximum byte limit.
 * @param resp - Fetch response with a readable body.
 * @param maxBytes - Maximum number of bytes to accept.
 * @returns Concatenated response bytes.
 */
async function readBoundedResponse(resp: Response, maxBytes: number): Promise<Buffer> {
  if (!resp.body) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of resp.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw new Error(`Image exceeds ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}
