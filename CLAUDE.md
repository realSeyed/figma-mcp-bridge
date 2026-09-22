# CLAUDE.md

## 1. Goal

This fork adds component, variable, text style, and section tools to the Figma MCP bridge. All of them must work on a free (Starter) Figma account.

## 2. Scope

1. Do not add a feature that needs a paid Figma plan.
2. Do not add a tool that adds, renames, removes, or selects a variable mode.
3. Do not add the `teamlibrary` permission, an `import*ByKeyAsync` call, or a publish option.
4. Do not add a Dev Mode feature or an Enterprise feature, for example an extended collection.
5. Do not use the Figma REST API. Use the Figma Plugin API.
6. Write a variable value to the default mode of the collection only.
7. If Figma rejects an operation because of a plan limit, return an error that names the limit.

## 3. Architecture

The plugin runs in Figma. It connects to the leader server with a WebSocket on port 1995.
The server is an MCP server on stdio. The first server process is the leader. Each later
one is a follower and sends each tool call to the leader with HTTP `/rpc`. The leader
sends the call to the plugin.

`handleRequest` in `plugin/src/main/code.ts` receives each call. It looks the request type
up in the merged extension map first. If an entry exists, `handleRequest` runs the entry;
`edit: true` makes it call `requireEditorMode` first, thus an edit tool stops with an error
in Dev Mode, which is read-only. If no entry exists, control goes to the switch statement
of the core tools. `runExtension` wraps each extension call and puts the tool name in front
of an error that does not carry it, thus a handler throws cause and correction only.

## 4. File map

| File                                       | Purpose                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `plugin/manifest.json`                     | Plugin id, name, and allowed domains. Keep `documentAccess: "dynamic-page"`.           |
| `plugin/src/main/code.ts`                  | `RequestType`, `EDIT_REQUEST_TYPES`, `requireEditorMode`, `handleRequest`, core tools. |
| `plugin/src/main/serializer.ts`            | The node output of the read tools.                                                     |
| `plugin/src/main/shared.ts`                | Shared helpers: node lookup, colors, fonts, position, variable values.                 |
| `plugin/src/main/extensions/types.ts`      | The `ExtensionHandler` type.                                                           |
| `plugin/src/main/extensions/index.ts`      | Merges the area maps. Exports `ExtensionRequestType`.                                  |
| `plugin/src/main/extensions/batch.ts`      | Shared batch helpers: param reading, error wording, the two phases of a batch.         |
| `plugin/src/main/extensions/variables.ts`  | Variable and variable collection handlers.                                             |
| `plugin/src/main/extensions/typography.ts` | Text style handlers.                                                                   |
| `plugin/src/main/extensions/components.ts` | Component and component set handlers.                                                  |
| `plugin/src/main/extensions/sections.ts`   | Section handlers.                                                                      |
| `plugin/src/ui/App.tsx`                    | The plugin window. Holds the WebSocket.                                                |
| `server/src/index.ts`                      | Start. Reads `FIGMA_BRIDGE_PORT`. The default is 1995.                                 |
| `server/src/schema.ts`                     | `toolInputSchemas` and `rpcToArgs` of the core tools.                                  |
| `server/src/schema-common.ts`              | `createFigmaNodeIdSchema`, `createHexColorSchema`, `fileKeyField`.                     |
| `server/src/tools.ts`                      | `registerTools` of the core tools.                                                     |
| `server/src/tool-helpers.ts`               | `renderResponse`, `parseToolInput`, the `ToolResult` type.                             |
| `server/src/extensions/types.ts`           | The area file types.                                                                   |
| `server/src/extensions/index.ts`           | Merges `schemas`, `rpcToArgs`, and `register`.                                         |
| `server/src/extensions/variables.ts`       | Variable and variable collection tools.                                                |
| `server/src/extensions/typography.ts`      | Text style tools.                                                                      |
| `server/src/extensions/components.ts`      | Component and component set tools.                                                     |
| `server/src/extensions/sections.ts`        | Section tools.                                                                         |
| `server/scripts/e2e-free-plan.ts`          | The end-to-end script. Drives every extension tool against a real file.                |

An extension file must not import `schema.ts` or `tools.ts`; this prevents an import cycle.
It imports only `schema-common.ts`, `tool-helpers.ts`, packages, and types.

## 5. Tool recipe

1. Plugin: add one entry to the handler map of the area file. Set `edit`.
2. Server: add the Zod object to `schemas` of the area file. `server.tool` needs `.shape`.
   For a refinement keep a plain object for `.shape` and a refined schema for the parse, as
   `createTextShape` and `createTextInput` in `schema.ts` do.
3. Server: add the mapper to `rpcToArgs` of the area file.
4. Server: register it in `register`, with `parseToolInput`, `renderResponse`, and `node.sendWithParams`.
5. README: add one row to the table "Available Tools".

## 6. Conventions

1. Tool names use `snake_case`. The verb is first, as in the current tools.
2. Node IDs use `createFigmaNodeIdSchema`. A variable ID starts `VariableID:`, a collection ID `VariableCollectionId:`, a style ID `S:`.
3. Each tool accepts the optional field `fileKey`.
4. Set `edit: true` for each tool that writes to the file.
5. Use the async form of the API: `getNodeByIdAsync`, `getStyleByIdAsync`, and so on.
6. Give the variables API a `Variable` or `VariableCollection` object. The ID form throws
   under `dynamic-page`.
7. A batch tool accepts 200 items or less. Examine all items before the first write.
8. Validation failure: write nothing. Return one tool error listing each bad item as
   `items[<index>]: <cause>`, or `<param>["<key>"]: <cause>` when items arrive in an object.
9. Write failure after validation: stop. Return `results` with one entry for each item:
   `{ index, ok: true, ... }`, `{ index, ok: false, error }`, or `error: "not written"`.
10. A delete tool stops with an error if `confirm` is not `true`.
11. Load all affected fonts before a text change.
12. Each error message gives the field, the cause, and the correction. `runExtension` adds
    the tool name.

## 7. Commands

| Command         | Purpose                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `bun install`   | Install. Run it in the root, in `server/`, and in `plugin/`.                 |
| `bun run check` | The server build, the plugin type check, the plugin build, the format check. |
| `bun run e2e`   | In `server/`. The end-to-end script. Needs the plugin open in a real file.   |

Run `bun run check` before each commit. Commit only if the check passes.

## 8. Live test

1. Run `bun run check`.
2. The user runs the plugin again in Figma. The user reconnects the `figma-dev` server with `/mcp`.
3. Use the `fileKey` of the test file in each call.
4. Put each test node on the page `MCP Test`. Start each test name with `mcp-test/`.
5. Examine the results with the read tools and with `get_screenshot`.
6. Remove all test objects at the end.
7. `bun run e2e` in `server/` covers the same ground on the page `MCP E2E` without hand
   work, and removes what it made even after a failure.

## 9. Git

1. Use the `/git-authoring` skill for each commit message and for each PR text.
2. Make small commits. One commit holds one logical change.
3. Do not commit to `main`. Do not push to `main`. Only the PR merge changes `main`.
4. One phase uses one branch. At the end, open one PR into `main` of the fork and merge it
   with a merge commit.
5. Add `--repo <fork>` to each `gh` command.
6. Do not push to the upstream repository. Do not open a PR in the upstream repository.
