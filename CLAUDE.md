# CLAUDE.md

## 1. Goal

This fork adds component, variable, text style, and section tools to the Figma MCP bridge. All of them must work on a free (Starter) Figma account.

The fork also adds audit tools: dumps and captures that the bridge writes to disk, with a
manifest as the tool result, and an auditor role that only reads.

## 2. Scope

1. Do not add a feature that needs a paid Figma plan.
2. Do not add a tool that adds, renames, removes, or selects a variable mode.
3. Do not add the `teamlibrary` permission, an `import*ByKeyAsync` call, or a publish option.
4. Do not add a Dev Mode feature or an Enterprise feature, for example an extended collection.
5. Do not use the Figma REST API. Use the Figma Plugin API.
6. Write a variable value to the default mode of the collection only.
7. If Figma rejects an operation because of a plan limit, return an error that names the limit.
8. Put no design-file data in the repository: no dump, no capture, no node ID, no name, and
   no figure from a design file. Commit synthetic test data only.
9. A live test uses only the test file that `FIGMA_FILE_KEY` names.

## 3. Architecture

The plugin runs in Figma. It connects to the leader server with a WebSocket on port 1995.
The server is an MCP server on stdio. The first server process is the leader. Each later
one is a follower and sends each tool call to the leader with HTTP `/rpc`. The leader
sends the call to the plugin.

The leader listens on `127.0.0.1` only. Each server process calls it by the literal
`http://127.0.0.1:<port>`, not `localhost`, which can resolve to `::1`. A follower sends
each `/rpc` request with `Content-Type: application/json` and `Authorization: Bearer
<token>`. The token is the install token from `server/src/rpc-token.ts`: one file for
each install, which the first process makes. Before it reads the body, the leader answers
415 for another content type, 401 for no token, and 403 for a wrong token. `/rpc` answers
405 to each method but `POST`, and no answer has an `Access-Control-Allow-*` header.
`/ping` stays open. Never log, return, or write the token.

`handleRequest` in `plugin/src/main/code.ts` receives each call. It looks the request type
up in the merged extension map first. If an entry exists, `handleRequest` runs the entry;
`edit: true` makes it call `requireEditorMode` first, thus an edit tool stops with an error
in Dev Mode, which is read-only. If no entry exists, control goes to the switch statement
of the core tools. `runExtension` wraps each extension call and puts the tool name in front
of an error that does not carry it, thus a handler throws cause and correction only.

The bridge reports its identity in `/ping` and `list_files`: `bridgeCommit` (the serving
process), `leaderCommit`, `leaderStartedAt`, and for each file `pluginBuild` and `epoch`.
The server build writes `server/dist/build-info.json` with the commit (`-dirty` for an
unclean tree, `unknown` without git); `server/src/build-info.ts` reads it. The plugin build
makes one identifier (`plugin/build-identity.ts`), gives it to both bundles with
`__PLUGIN_BUILD__`, and the window adds it to the WebSocket URL as `pluginBuild`. `Bridge`
adds 1 to the epoch of a file key at each connection, a replacing one included; a disconnect
and a read leave it. The epoch lives in memory. `list_files` returns an object, not an array.

Each process writes evidence files only under its own output root
(`FIGMA_BRIDGE_OUTPUT_ROOT`, else its working directory). The leader writes no file for
another process: `/rpc` refuses `save_screenshots`, and a follower fetches each capture
with `get_screenshot` over `/rpc` and writes it itself.

`dump_nodes_chunk` (`plugin/src/main/extensions/dumps.ts`, `edit: false`) is an internal
plugin command: the server sends it, and no MCP tool has its name. Its params are `rootId`,
`cursor` (an array of child indexes from the root, or `null` at the start), `maxNodes` (an
integer of 1 or more), and `includeHidden`. The root is a page, which the command loads
first, or a node on a page; the document node is refused. The walk is pre-order: a node,
then its children in order. A chunk starts at the cursor and stops after `maxNodes`
records, after 15 seconds, or at the end of the subtree; it returns one record at least.
The answer is `{ rootId, records, nextCursor }`. A record is `{ depth, childCount, node }`:
`depth` is 0 for the root, and `node` is the dump form (`plugin/src/main/dump.ts`) without
`children`. `childCount` and the cursor count the same children: each child with
`includeHidden`, the visible ones without it. `nextCursor` is the child-index path of the
next node, or `null` when the walk is complete. A cursor index that does not exist stops
the chunk with an error: the tree changed during the dump. A record holds no counter, no
time, and no chunk number, thus the joined records do not depend on the chunk boundaries.
Each chunk saves `figma.skipInvisibleInstanceChildren`, sets it to `false`, walks, and sets
the saved value back in `finally`. The dump has no character budget. Its options
(`includeHidden`, `paintBindings`) reach the serializer, and their defaults keep the output
of the read tools byte for byte. `plugin/test/serializer.test.ts` fixes that output; do not
change one of its expected values to make a serializer change pass.

## 4. File map

| File                                       | Purpose                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `plugin/manifest.json`                     | Plugin id, name, and allowed domains. Keep `documentAccess: "dynamic-page"`.               |
| `plugin/src/main/code.ts`                  | `RequestType`, `EDIT_REQUEST_TYPES`, `requireEditorMode`, `handleRequest`, core tools.     |
| `plugin/src/main/serializer.ts`            | The node output of the read tools, and the base of the dump form.                          |
| `plugin/src/main/dump.ts`                  | The dump form of a node: the read form, the hidden content, and the added fields.          |
| `plugin/src/main/shared.ts`                | Shared helpers: node lookup, colors, fonts, position, variable values.                     |
| `plugin/src/main/extensions/types.ts`      | The `ExtensionHandler` type.                                                               |
| `plugin/src/main/extensions/index.ts`      | Merges the area maps. Exports `ExtensionRequestType`.                                      |
| `plugin/src/main/extensions/batch.ts`      | Shared batch helpers: param reading, error wording, the two phases of a batch.             |
| `plugin/src/main/extensions/variables.ts`  | Variable and variable collection handlers.                                                 |
| `plugin/src/main/extensions/typography.ts` | Text style handlers.                                                                       |
| `plugin/src/main/extensions/components.ts` | Component and component set handlers.                                                      |
| `plugin/src/main/extensions/sections.ts`   | Section handlers.                                                                          |
| `plugin/src/main/extensions/dumps.ts`      | `dump_nodes_chunk`, the internal chunk command of a dump.                                  |
| `plugin/src/ui/App.tsx`                    | The plugin window. Holds the WebSocket.                                                    |
| `server/src/index.ts`                      | Start. Reads `FIGMA_BRIDGE_PORT`. The default is 1995.                                     |
| `server/src/schema.ts`                     | `toolInputSchemas` and `rpcToArgs` of the core tools.                                      |
| `server/src/output-root.ts`                | The output root: path resolution, real-path containment, and the evidence file write.      |
| `server/src/rpc-token.ts`                  | The install token: the path of its file, its creation, its checks. Node built-ins only.    |
| `server/src/identity.ts`                   | File selection and the identity of one file, for the manifests. Imports types only.        |
| `server/src/build-info.ts`                 | `BRIDGE_COMMIT`, read from `dist/build-info.json`.                                         |
| `server/scripts/write-build-info.mjs`      | The build step that writes `dist/build-info.json`.                                         |
| `plugin/build-identity.ts`                 | The plugin build identifier. Both Vite configurations import it.                           |
| `server/src/schema-common.ts`              | `createFigmaNodeIdSchema`, `createHexColorSchema`, `fileKeyField`.                         |
| `server/src/tools.ts`                      | `registerTools` of the core tools.                                                         |
| `server/src/tool-helpers.ts`               | `renderResponse`, `parseToolInput`, the `ToolResult` type.                                 |
| `server/src/extensions/types.ts`           | The area file types.                                                                       |
| `server/src/extensions/index.ts`           | Merges `schemas`, `rpcToArgs`, and `register`.                                             |
| `server/src/extensions/variables.ts`       | Variable and variable collection tools.                                                    |
| `server/src/extensions/typography.ts`      | Text style tools.                                                                          |
| `server/src/extensions/components.ts`      | Component and component set tools.                                                         |
| `server/src/extensions/sections.ts`        | Section tools.                                                                             |
| `server/scripts/e2e-free-plan.ts`          | The end-to-end script. Drives every extension tool against a real file.                    |
| `server/scripts/perf-free-plan.ts`         | The measurement script. Holds each tool to 30 seconds and 50,000 characters.               |
| `server/test/`                             | `bun test` tests. Real server processes against a simulated plugin. Helpers in `helpers/`. |
| `plugin/test/`                             | `bun test` tests of the serializer, the dump form, and the chunk walk. Synthetic nodes.    |

An extension file must not import `schema.ts` or `tools.ts`; this prevents an import cycle.
It imports only `schema-common.ts`, `tool-helpers.ts`, `output-root.ts`, `identity.ts`, packages,
and types; `output-root.ts` and `identity.ts` import neither `schema.ts` nor `tools.ts`.

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
12. A tool that moves a node to another parent keeps it where it is on the canvas. Read
    the `absoluteTransform` of the node before the move. After the move, set its
    `relativeTransform` from that value, less the absolute position of the new parent.
    Pages and sections do not rotate. `reparent_nodes` is the exception: it calls
    `appendChild` only.
13. Each error message gives the field, the cause, and the correction. `runExtension` adds
    the tool name.
14. A tool that writes a file uses `server/src/output-root.ts`. It never resolves a path
    against `process.cwd()` itself.

## 7. Commands

| Command         | Purpose                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `bun install`   | Install. Run it in the root, in `server/`, and in `plugin/`.                                       |
| `bun run check` | The server build, the plugin type check, the plugin build, the format check.                       |
| `bun run test`  | The server build, then `bun test` in `server/` and in `plugin/`. Needs no Figma.                   |
| `bun run e2e`   | In `server/`. The end-to-end script. Needs `FIGMA_FILE_KEY`.                                       |
| `bun run perf`  | In `server/`. The measurement script. Needs `FIGMA_FILE_KEY`. Reads `FIGMA_READ_FILE_KEY` as well. |

Run `bun run check` before each commit. Commit only if the check passes.

## 8. Live test

A live test runs through the scripts of this repository, not through the MCP tools of an
agent session: the server of a session can run an old build.

1. Run `bun run check`. `server/dist/` and `plugin/dist/` are not in git, so build again
   after each branch switch.
2. List the bridge processes (`node` with `dist/index.js` on its command line). Stop the
   stale ones only with the approval of the owner, and only when no audit or execution runs.
3. Start a fresh leader from this checkout: `tail -f /dev/null | node server/dist/index.js`.
   The pipe keeps its standard input open. Make sure that it is the only bridge process.
4. The owner runs the plugin again in the test file and opens the page the script needs
   (`MCP E2E` for `bun run e2e`, `MCP Test` for `bun run perf`). Wait for
   `Plugin connected: <name> (<key>)` in the leader output.
5. Make sure that each connected file is the test file. The key of `test` is stable when the
   private plugin API works (`enablePrivatePluginApi` in the manifest, see the README); if
   `/ping` shows a key that starts with `unsaved-`, it can change at each plugin run, so read
   it again.
6. Run the script in `server/` with the key: `FIGMA_FILE_KEY='<key>' bun run e2e`. Each
   test object starts with `mcp-e2e/` or `mcp-test/`, and the script removes it, also after
   a failure.
7. Stop the leader at the end.

A request to `/rpc` by hand needs the headers `Content-Type: application/json` and
`Authorization: Bearer <token>`. Read the token from the file inside the command, as the
README shows, and use `127.0.0.1`. Never print the token.

## 9. Git

1. Use the `/git-authoring` skill for each commit message and for each PR text.
2. Make small commits. One commit holds one logical change.
3. Do not commit to `main`. Do not push to `main`. Only the PR merge changes `main`.
4. One phase uses one branch. At the end, open one PR into `main` of the fork and merge it
   with a merge commit.
5. Add `--repo <fork>` to each `gh` command.
6. Do not push to the upstream repository. Do not open a PR in the upstream repository.
