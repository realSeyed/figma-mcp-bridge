# Figma MCP Bridge

[![Pairing with Hopp](https://gethopp.app/git/hopp-shield.svg?ref=hopp-repo)](https://gethopp.app)

- [Fork scope: free Figma plan](#fork-scope-free-figma-plan)
- [Demo](#demo)
- [Quick Start](#quick-start)
- [Available Tools](#available-tools)
- [Local development](#local-development)
- [Structure](#structure)
- [How it works](#how-it-works)

<br/>

<img src="https://raw.githubusercontent.com/gethopp/figma-mcp-bridge/main/logo.png" alt="Figma MCP Bridge" align="center" />

<br/>

While other amazing Figma MCP servers like [Figma-Context-MCP](https://github.com/GLips/Figma-Context-MCP/) exist, one issues is the [API limiting](https://github.com/GLips/Figma-Context-MCP/issues/258) for free users.

The limit for free accounts is 6 requests per month, yes **per month**.

Figma MCP Bridge is a solution to this problem. It is a plugin + MCP server that streams live Figma document data to AI tools without hitting Figma API rate limits, so its Figma MCP for the rest of us ✊

It supports **multiple Figma files connected simultaneously**; open the plugin in each file and your AI agent can query any of them by `fileKey`. Single-file setups work exactly as before with no changes required.

It also includes a small, opt-in set of **write tools** for safe agent-driven edits — see [Editing Notes](#editing-notes) below.

## Fork scope: free Figma plan

This fork adds component, variable, and text style tools on top of the stock bridge. Every one of them works on a free (Starter) Figma account: they use the Figma Plugin API rather than the REST API, and nothing here asks for a paid seat.

The plugin is named **Figma MCP Bridge (Fork)** and the bridge listens on **port 1995**, so it runs beside a stock bridge on 1994 without a port clash. Override it with `FIGMA_BRIDGE_PORT`.

### Supported

| Area            | Tools                                                                                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Variables**   | `create_variable_collection`, `update_variable_collection`, `delete_variable_collection`, `create_variables`, `update_variables`, `delete_variables`, `bind_variables`                                                                                                                       |
| **Text styles** | `list_fonts`, `create_text_style`, `update_text_style`, `delete_text_style`, `apply_text_style`                                                                                                                                                                                              |
| **Components**  | `list_components`, `get_component`, `get_instance`, `create_component`, `combine_as_variants`, `create_instance`, `swap_instance`, `detach_instance`, `add_component_property`, `edit_component_property`, `delete_component_property`, `bind_component_property`, `set_instance_properties` |

The read tools grew with them: `get_variable_defs` reports each collection's `defaultModeId` and each variable's `description` and `scopes`, `get_styles` reports a text style's `description`, `paragraphSpacing`, `paragraphIndent`, `textCase`, `leadingTrim`, and `boundVariables`, and a node reports its `boundVariables`, `textStyleId`, and `componentProperties`.

### Not supported

Everything below needs a paid Figma plan, or a Figma surface these tools deliberately do not model:

- **Variable modes.** A free plan gives a collection one mode. There is no tool to add, rename, remove, or select one, and every variable value is written to the collection's default mode.
- **Team libraries.** The plugin requests no `teamlibrary` permission, calls no `import*ByKeyAsync`, and exposes no publish option. Components, styles, and variables stay local to the file.
- **Dev Mode and Enterprise features**, such as extended collections. Dev Mode is read-only here: an edit tool called from it stops with an error naming the editor it needs.
- **`SLOT` component properties.** A slot carries a frame contract these tools do not model, and Figma refuses to set one on an instance. Use an `INSTANCE_SWAP` property instead.
- **`EASING` and `TIMING` variables.** The variable tools cover `COLOR`, `FLOAT`, `STRING`, and `BOOLEAN`.
- **The Figma REST API.** Everything runs through the Plugin API over the bridge, which is what keeps the free plan's six-requests-a-month API limit out of the picture.

When Figma refuses a write because of a plan limit, the tool says so and names the limit rather than passing the raw rejection through.

## Demo

[Watch a demo of building a UI in Cursor with Figma MCP Bridge](https://youtu.be/ouygIhFBx0g)

[![Watch the video](https://img.youtube.com/vi/ouygIhFBx0g/maxresdefault.jpg)](https://youtu.be/ouygIhFBx0g)

## Quick Start

This fork is not published to npm, so you build it from this checkout. `npx @gethopp/figma-mcp-bridge` installs the **stock** bridge instead — it listens on 1994 and has none of the component, variable, or text style tools above.

[Bun](https://bun.sh) is the package manager and script runner throughout. Install it first if you don't have it.

### 1. Build the server and the plugin

```bash
git clone git@github.com:realSeyed/figma-mcp-bridge.git
cd figma-mcp-bridge && bun install
cd server && bun install && bun run build && cd ..
cd plugin && bun install && bun run build && cd ..
```

### 2. Add the MCP server to your favourite AI tool

Point your AI tool (Cursor, Windsurf, Claude Code, Claude Desktop) at the server you just built, using an absolute path:

```json
{
  "figma-bridge": {
    "command": "node",
    "args": ["/path/to/figma-mcp-bridge/server/dist/index.js"]
  }
}
```

In Claude Code that is:

```bash
claude mcp add figma-dev -- node /path/to/figma-mcp-bridge/server/dist/index.js
```

### 3. Add the Figma plugin

In Figma go to `Plugins > Development > Import plugin from manifest` and select `plugin/manifest.json` from this checkout. The plugin appears as **Figma MCP Bridge (Fork)**.

### 4. Start using it 🎉

Open a Figma file, run the plugin, and start prompting your AI tool. The MCP server will automatically connect to the plugin.

To work across multiple files, just open the plugin in each Figma file. The bridge keeps all connections active and your AI agent can target any of them by `fileKey`.

If you want to know more about how it works, read the [How it works](#how-it-works) section.

## Available Tools

| Tool                           | Description                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `list_files`                   | List all connected Figma files (supports multi-file workflows)                                                    |
| `get_document`                 | Get the current Figma page document tree                                                                          |
| `get_selection`                | Get the currently selected nodes in Figma                                                                         |
| `get_node`                     | Get a specific Figma node by ID (colon format, e.g. `4029:12345`)                                                 |
| `get_styles`                   | Get all local paint, text, effect, and grid styles                                                                |
| `get_metadata`                 | Get file name, pages, and current page info                                                                       |
| `get_design_context`           | Get a depth-limited tree optimized for understanding design context                                               |
| `get_variable_defs`            | Get all variable collections with their default mode, and every variable with its scopes, description, and values |
| `get_screenshot`               | Export nodes as PNG/SVG/JPG/PDF (base64-encoded)                                                                  |
| `save_screenshots`             | Export and save screenshots directly to the local filesystem                                                      |
| `get_motion_styles`            | List all available animation presets (beta)                                                                       |
| `get_node_motion`              | Read a node's current animation styles and properties (beta)                                                      |
| `apply_animation_style`        | Apply a preset animation style to a node (beta)                                                                   |
| `remove_animation_style`       | Remove an applied animation style from a node (beta)                                                              |
| `apply_manual_keyframe_track`  | Apply a manual keyframe track to a node property (beta)                                                           |
| `remove_manual_keyframe_track` | Remove a manual keyframe track from a node property (beta)                                                        |
| `set_timeline_duration`        | Set the duration of a timeline in seconds (beta)                                                                  |
| `set_node_visibility`          | Show or hide specific nodes                                                                                       |
| `set_text_content`             | Replace the contents of a text node                                                                               |
| `set_text_properties`          | Patch font, size, alignment, auto-resize, color, and bounds on a text node                                        |
| `set_node_properties`          | Patch common node properties: name, position, size, visibility, opacity, corner radius                            |
| `set_solid_fill`               | Replace a node's fill or stroke with a single solid paint                                                         |
| `set_gradient_fill`            | Replace a node's fill or stroke with a linear/radial/angular/diamond gradient                                     |
| `set_effects`                  | Replace a node's effects list (drop/inner shadows, layer/background blurs)                                        |
| `set_stroke_properties`        | Patch stroke weight, align, dash pattern, cap, and join                                                           |
| `set_auto_layout`              | Configure auto-layout direction, padding, gap, alignment, sizing, and wrap                                        |
| `create_page`                  | Create a new page in the document, optionally switching to it                                                     |
| `create_frame`                 | Create a new frame, optionally under a parent                                                                     |
| `create_text`                  | Create a new text node                                                                                            |
| `create_shape`                 | Create a rectangle, ellipse, or line                                                                              |
| `create_image`                 | Create an image-backed rectangle from a local path, URL, or data URI                                              |
| `import_html_layers`           | Bulk-import an html-figma layer tree (JSON) as frames, text, rectangles, and vectors                              |
| `duplicate_nodes`              | Duplicate nodes in place                                                                                          |
| `reparent_nodes`               | Move nodes into another parent                                                                                    |
| `group_nodes`                  | Wrap a list of nodes (sharing a parent) in a new group                                                            |
| `ungroup_node`                 | Ungroup a group or frame — children move up to its parent                                                         |
| `set_selection`                | Set the page selection to a list of node IDs (works in Dev Mode)                                                  |
| `scroll_and_zoom_into_view`    | Frame the viewport around the given nodes (works in Dev Mode)                                                     |
| `delete_nodes`                 | Delete nodes with explicit confirmation                                                                           |
| `create_variable_collection`   | Create a variable collection for design tokens (one mode on a free plan)                                          |
| `update_variable_collection`   | Rename a variable collection                                                                                      |
| `delete_variable_collection`   | Delete a variable collection and every variable in it, with explicit confirmation                                 |
| `create_variables`             | Create up to 200 variables in one collection with values, aliases, scopes                                         |
| `update_variables`             | Change the name, value, scopes, or description of up to 200 variables                                             |
| `delete_variables`             | Delete up to 200 variables and report what aliased each one, with explicit confirmation                           |
| `bind_variables`               | Bind variables to node fields such as `fills`, `itemSpacing`, or `characters`, or remove a binding                |
| `list_fonts`                   | List the fonts Figma can use, grouped by family                                                                   |
| `create_text_style`            | Create a local text style, optionally with variables driving its fields                                           |
| `update_text_style`            | Change the name, font, metrics, or bound variables of a text style                                                |
| `delete_text_style`            | Delete a text style with explicit confirmation                                                                    |
| `apply_text_style`             | Apply a text style to up to 200 text nodes, or to one range of characters                                         |
| `list_components`              | List the local components and component sets of the current page or of the whole file                             |
| `get_component`                | Read one component or component set: its properties, its variants, and its default variant                        |
| `get_instance`                 | Read one instance: its main component, its property values, and its overrides                                     |
| `create_component`             | Create a local component, by converting a node or from a width and a height                                       |
| `combine_as_variants`          | Combine 2 to 50 components into one component set, laid out in a row or a column                                  |
| `create_instance`              | Create an instance of a component, or of one variant of a component set                                           |
| `swap_instance`                | Point an instance at another component or variant, in place                                                       |
| `detach_instance`              | Turn up to 200 instances into plain frames                                                                        |
| `add_component_property`       | Add a BOOLEAN, TEXT, INSTANCE_SWAP, or VARIANT property to a component or a component set                         |
| `edit_component_property`      | Rename a component property, or change its default value or its preferred values                                  |
| `delete_component_property`    | Delete a component property with explicit confirmation                                                            |
| `bind_component_property`      | Point a layer's `characters`, `visible`, or `mainComponent` at a component property, or remove the link           |
| `set_instance_properties`      | Set the property values of one instance, including which variant of a set it is                                   |

All tools accept an optional `fileKey` parameter when multiple Figma files are connected. Use `list_files` to discover connected files and their keys.

### Editing Notes

- Edit tools work only when the plugin is opened in Figma's design editor (Dev Mode is read-only — they will return a clear error there).
- The current user must have permission to edit the target file.
- Every tool that deletes something is gated behind `confirm: true`, and refuses the call without it: `delete_nodes`, `delete_variable_collection`, `delete_variables`, `delete_text_style`, and `delete_component_property`.
- Text edits automatically load the fonts currently used by the target text node before applying the new content.
- New text nodes default to `Inter Regular` unless a font is provided.
- `create_image` reads local paths relative to the MCP server working directory unless you pass an absolute path.
- `import_html_layers` takes a JSON file produced by [html-figma](https://github.com/sergcen/html-to-figma)'s browser `htmlToFigma()`. The path resolves relative to the MCP server working directory and must stay inside it, even when absolute. Everything lands inside one wrapper frame, and the response reports `layerCount` against `expectedLayerCount` so partial imports are visible.
- `create_page` returns the new page's ID — pass it as `parentId` to `create_frame` / `create_text` / `create_shape` / `create_image` to author content on that page without switching the editor.
- The variable tools work on a free (Starter) Figma plan, and they write the default mode of a collection only — the one mode a free plan gives it. Adding a mode, publishing a library, and extended collections need a paid plan and are not exposed.
- `list_components`, `get_component`, and `get_instance` read local components only. A component set reports its variants, and a variant reports the set it belongs to: `componentPropertyDefinitions` lives on the set, not on the variant. `get_node` reports an instance's `componentProperties` as the full property name, suffix and all, to its value — that is the name `get_component` lists and the name the API takes.
- `create_variables`, `update_variables`, `delete_variables`, and `bind_variables` check every item before the first write: a batch with a bad item writes nothing and reports every item to correct. A write that fails afterwards stops the batch; `create_variables` removes the variables that call had created, and the others report `not written` for the items they did not reach.
- A variable value can alias another variable by `aliasId` or by `aliasName`. In `create_variables` an `aliasName` resolves against the batch first, then the target collection, then the other local collections, so an item can alias a later item of the same call. In `update_variables` it resolves against the file as it stands, not against the renames of the same call.
- `delete_variable_collection` is gated behind `confirm: true`, like `delete_nodes`, and removes every variable in the collection. `delete_variables` is gated the same way and reports `aliasedBy` for each removed variable: the local variables that aliased it and now resolve to nothing.
- `bind_variables` binds a COLOR variable into one `SOLID` paint of `fills` or `strokes` — pick it with `paintIndex` — BOOLEAN to `visible`, STRING to `characters`, `fontFamily`, and `fontStyle`, and FLOAT to every other field. Pass `variableId: null` to remove a binding and leave the field at its last value. Variable scopes are not consulted: they steer Figma's variable picker and do not restrict the Plugin API.
- A FLOAT bound to `opacity` is read as a percentage, the unit Figma's own opacity field uses, not as the 0 to 1 the `opacity` node property takes. A variable holding `50` gives a half-transparent node; one holding `0.5` gives a node that is all but invisible.
- The read tools report a node's bindings as `boundVariables`, mapping each bound field to the variable ID bound to it. The key is absent when the node binds nothing.
- The font of a text style must be one Figma has. `create_text_style` and `update_text_style` check the family and the style against `list_fonts` and load the font before writing, so an unavailable font stops the call before it changes anything and comes back with the closest family names. A file that uses a font the account cannot load can still be renamed or redescribed, but not restyled.
- `create_text_style` and `update_text_style` take `boundVariables`, a style field mapped to a variable ID: a STRING variable for `fontFamily` and `fontStyle`, a FLOAT variable for `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, `paragraphSpacing`, and `paragraphIndent`. A binding wins over a literal value given for the same field in the same call, and `null` removes a binding and leaves the field at its last value.
- `apply_text_style` replaces every text property of the nodes it lands on. Pass `range` to style a stretch of characters instead — one node per call — which leaves `get_node` reporting `textStyleId: "mixed"`. Pass `styleId: null` to remove the link and leave each node looking as it did. `delete_text_style` behaves the same way for the nodes that used the style.
- The component tools work on a free (Starter) Figma plan, and they make local components only. Publishing a component to a team library and using one from another file need a paid plan and are not exposed.
- `create_component` takes either `fromNodeId`, which converts a node in place and keeps its children, size, position, and paint, or `width` and `height`, which makes an empty component — so `fillHex` belongs to the second form only. A node that is already a component, a component set, or an instance is refused, as is a node inside one.
- A variant carries its properties in its name: `Size=Small`, or several pairs as in `Size=Small, State=Hover`. `combine_as_variants` checks every name before the first write — all the components name the same properties, and no two repeat the same combination of values — so a call with a bad name writes nothing and reports every name to correct.
- `figma.combineAsVariants` stacks every variant on one spot, so `combine_as_variants` lays the set out afterwards: `layout` picks a row or a column, `gap` sets the space between the variants, and the set is resized to fit them plus `padding`.
- `create_instance` and `swap_instance` pick a variant with `variantProperties`, a property name mapped to its value. Every value is text in Figma, so write `24` as `"24"`. A value that matches no variant comes back with the valid values of each property; a set of values that still matches several variants comes back naming the properties that need one too, so an instance never lands on an arbitrary variant. Leave `variantProperties` out and the set's default variant is used.
- `detach_instance` refuses an instance inside another instance: Figma detaches every instance above a nested one as well, so the call would reach further than it names. Detach the outer instance instead.
- The property tools name a property either way: the display name Figma shows (`Label`) or the full name carrying the suffix Figma appends (`Label#12:0`). An exact full name wins, which also matches Figma's own rule that a `VARIANT` property takes precedence on a name collision; a display name that somehow matches two properties is refused with both full names rather than guessed at.
- Take the name `add_component_property` and `edit_component_property` return, not the one you asked for. Figma keeps the display names of one component apart and renames a colliding one behind the call — asking for a second `Text` stores `Text2#16:13` — so the returned name is what the file carries and what the other tools take. The suffix does not change on a rename.
- The property types these tools cover are `BOOLEAN`, `TEXT`, `INSTANCE_SWAP`, and `VARIANT`. `SLOT` properties are not supported: a slot carries a frame contract these tools do not model, and Figma refuses to set one on an instance. Use an `INSTANCE_SWAP` property to let an instance choose the component it shows.
- A property lives on the component set rather than on one of its variants, so a variant ID is refused with the ID of its set — a property added to the set reaches every variant. A `VARIANT` property is an axis of a set: it is refused on a single component, takes no default value because the set's first variant is the default, and `delete_component_property` cannot remove it. Rename the variants so they no longer name it instead.
- `bind_component_property` matches the field to the property type: `characters` reads a `TEXT` property and belongs to a text layer, `visible` reads a `BOOLEAN` property, and `mainComponent` reads an `INSTANCE_SWAP` property and belongs to an instance layer. The layer must sit inside the component, or inside one variant of the set, that owns the property; a layer inside an instance is refused, because the link lives on the main component. The other links on the layer are kept, and `propertyName: null` removes one and leaves the layer as it looks.
- `set_instance_properties` checks every value against the property it names before the first write and hands them to Figma in one call, so a call with a bad value leaves the instance as it was. A `VARIANT` value the set does not have comes back with the values it does have, and the fonts of the text layers a `TEXT` property drives are loaded before the change.

### What You Can Build

With the current write surface, an agent can build a basic slide deck in a new empty Figma file: create slide frames, style titles and body copy, lay out rectangles/ellipses/lines for cards and dividers, duplicate slide templates, reparent content into the right frame, and adjust common geometry/visual properties — including solid/gradient paints, shadows and blurs, stroke geometry, and auto-layout configuration.

This fork goes further: an agent can author a small design system in the same file. Define the tokens as variables, bind them to the layers that should follow them, name the type ramp as text styles and apply it, then build the buttons and cards as components, combine them into variant sets, add the properties that drive them, and place instances configured per slide.

Still out of scope: per-segment text styling beyond `apply_text_style`'s `range`, vector boolean operations, and everything in [Not supported](#not-supported) above.

## Local development

[Quick Start](#quick-start) already covers the clone, the installs, and the two builds — that is the development setup. Two more things are worth knowing.

The root `bun install` runs Husky's `prepare` script, which installs the pre-commit hook that formats staged files with Prettier. Run it once in the repository root, not only in `server/` and `plugin/`.

### Verifying a change

```bash
bun run check
```

From the root, this builds the server, type-checks and builds the plugin, and verifies formatting across the repo. Run it before every commit. After changing plugin code, re-run the plugin in Figma to pick up the new `dist/code.js`; after changing server code, reconnect the MCP server in your AI tool.

### Code style

The repo is formatted with [Prettier](https://prettier.io) (config in `.prettierrc`). A Husky pre-commit hook runs `lint-staged`, which formats only your staged files, so commits stay formatted automatically. You can also run it manually:

```bash
bun run format        # format the whole repo
bun run format:check  # verify formatting without writing (useful in CI)
```

### End-to-end test

`server/scripts/e2e-free-plan.ts` drives every variable, text style, and component tool against a real Figma file on a free (Starter) plan, asserting on the parsed results rather than on the absence of an error. It starts its own `node dist/index.js`, which joins the running bridge as a follower, so it covers the follower-to-leader `/rpc` path as well as the tools.

Before running it, build the server, open the plugin in the file you want to test against, and make `MCP E2E` the active page in Figma — the script creates that page on the first run, and `list_components` reads whichever page is open.

```bash
cd server && bun run e2e
```

It picks the file up from `list_files` when exactly one is connected; set `FIGMA_FILE_KEY` to choose between several. Everything it makes is named `mcp-e2e/…` and is removed again in a `finally` block, after a failure as well. Screenshots of the test frame land in `server/scripts/e2e-output/` (git-ignored), and a failed step exits with code 1.

## Structure

```
Figma-MCP-Bridge/
├── plugin/   # Figma plugin (TypeScript/React)
└── server/   # MCP server (TypeScript/Node.js)
    └── src/
        ├── index.ts      # Entry point
        ├── bridge.ts     # WebSocket bridge to Figma plugin
        ├── leader.ts     # Leader: HTTP server + bridge
        ├── follower.ts   # Follower: proxies to leader via HTTP
        ├── node.ts       # Dynamic leader/follower role switching
        ├── election.ts   # Leader election & health monitoring
        ├── tools.ts      # MCP tool definitions
        └── types.ts      # Shared types
```

## How it works

There are two main components to the Figma MCP Bridge:

### 1. The Figma Plugin

The Figma plugin is the user interface for the Figma MCP Bridge. You run this inside the Figma file you want to use the MCP server for, and its responsible for getting you all the information you need.

### 2. The MCP Server

The MCP server is the core of the Figma MCP Bridge. It maintains a registry of WebSocket connections keyed by `fileKey`, so multiple Figma files can be connected simultaneously. The server is responsible for:

- Handling WebSocket connections from one or more Figma plugin instances
- Routing tool calls to the correct file based on `fileKey`
- Forwarding responses back to the AI client
- Handling leader election (as we can have only one WS connection to an MCP server at a time)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FIGMA (Browser)                                │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         Figma Plugin                                  │  │
│  │                    (TypeScript/React)                                 │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ WebSocket
                                      │ (ws://localhost:1995/ws)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PRIMARY MCP SERVER                                 │
│                         (Leader on :1995)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Bridge                                    Endpoints:               │    │
│  │  • Manages WebSocket conn                  • /ws    (plugin)        │    │
│  │  • Forwards requests to plugin             • /ping  (health)        │    │
│  │  • Routes responses back                   • /rpc   (followers)     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                           ▲                              ▲
                           │ HTTP /rpc                    │ HTTP /rpc
                           │ POST requests                │ POST requests
                           │                              │
         ┌─────────────────┴───────────┐    ┌─────────────┴───────────────┐
         │    FOLLOWER MCP SERVER 1    │    │    FOLLOWER MCP SERVER 2    │
         │                             │    │                             │
         │  • Pings leader /ping       │    │  • Pings leader /ping       │
         │  • Forwards tool calls      │    │  • Forwards tool calls      │
         │    via HTTP /rpc            │    │    via HTTP /rpc            │
         │  • If leader dies →         │    │  • If leader dies →         │
         │    attempts takeover        │    │    attempts takeover        │
         └─────────────────────────────┘    └─────────────────────────────┘
                    ▲                                      ▲
                    │                                      │
                    │ MCP Protocol                         │ MCP Protocol
                    │ (stdio)                              │ (stdio)
                    ▼                                      ▼
         ┌─────────────────────────────┐    ┌─────────────────────────────┐
         │      AI Tool / IDE 1        │    │      AI Tool / IDE 2        │
         │      (e.g., Cursor)         │    │      (e.g., Cursor)         │
         └─────────────────────────────┘    └─────────────────────────────┘
```
