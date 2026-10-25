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

`FIGMA_BRIDGE_ROLE=auditor` (`server/src/role.ts`) makes a process register the 15 tools of
`AUDITOR_TOOLS` and no other: `registerTools` gets a wrapper of the server that drops each
other tool, and `index.ts` exits if a listed tool is not registered. A set value other than
exactly `auditor` stops the process at start. The follower of an auditor process adds
`X-Figma-Bridge-Role: auditor` to each `/rpc` request. For a request with that header the
leader runs `AUDITOR_TOOLS` and the internal commands `dump_nodes_chunk` and `get_screenshot`
only; it answers 403 to another tool, before it forwards anything, and 400 to another header
value. A request without the header runs as before, whatever the role of the leader process
is: the role governs the tools and the requests of its own process, and the own MCP calls of
a leader never pass `/rpc`. Thus an auditor leader still relays the writes of the executor
process. The role is a guardrail, not a sandbox: a process that can read the install token can
send a request without the mark.

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
another process: `/rpc` refuses `save_screenshots` and `dump_nodes` with 400, and a
follower fetches each capture with `get_screenshot`, and each dump chunk with
`dump_nodes_chunk`, over `/rpc` and writes the files itself.

`save_screenshots` (`server/src/captures.ts`) runs in the serving process too, and returns a manifest in
the envelope of `evidence.ts`: the identity of the file, one entry for each item, the totals, and
`manifestPath`. A capture entry holds the path, the bytes, the SHA-256, the scale, and the pixel
size, read from the PNG or JPG header (`server/src/image-size.ts`). It returns no image data. The
call reads the identity before the first capture and after the last, fails if the epoch, the plugin
build, or the leader start changed, and removes each file of the call. The manifest file goes
beside the first item as `save_screenshots-<UTC time>.manifest.json`. A target that exists refuses
the call before the first capture. An item that fails alone does not fail the call.
`get_screenshot` returns a PNG or JPG of 1,568 pixels or less on the long edge and 3,750,000 bytes
or less as an image block and a text block with its metadata; any other export is JSON text.

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

`dump_nodes` (`server/src/extensions/dumps.ts`) runs in the serving process, as
`save_screenshots` does. It reads the identity of the file with `identity.ts` and resolves
the file key, then refuses the call if a target file exists. For each root it sends
`dump_nodes_chunk` requests through `node.sendWithParams` with the resolved key, until
`nextCursor` is `null`; a follower thus sends each chunk over `/rpc` with the token.
`TreeBuilder` builds the tree from the records by `depth` and `childCount` and checks the
structure. The call writes each file as `.partial` under the output root of the serving
process, reads the identity again, fails if the epoch, the plugin build, or the leader
start changed, gives each file its final name, and writes `manifest.json`. The result is
the manifest only. A failure removes each file of the call.

## 4. File map

| File                                       | Purpose                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `plugin/manifest.json`                     | Plugin id, name, and allowed domains. Keep `documentAccess: "dynamic-page"`.                                           |
| `plugin/src/main/code.ts`                  | `RequestType`, `EDIT_REQUEST_TYPES`, `requireEditorMode`, `handleRequest`, core tools.                                 |
| `plugin/src/main/serializer.ts`            | The node output of the read tools, and the base of the dump form.                                                      |
| `plugin/src/main/dump.ts`                  | The dump form of a node: the read form, the hidden content, and the added fields.                                      |
| `plugin/src/main/shared.ts`                | Shared helpers: node lookup, colors, fonts, position, variable values.                                                 |
| `plugin/src/main/extensions/types.ts`      | The `ExtensionHandler` type.                                                                                           |
| `plugin/src/main/extensions/index.ts`      | Merges the area maps. Exports `ExtensionRequestType`.                                                                  |
| `plugin/src/main/extensions/batch.ts`      | Shared batch helpers: param reading, error wording, the two phases of a batch.                                         |
| `plugin/src/main/extensions/variables.ts`  | Variable and variable collection handlers.                                                                             |
| `plugin/src/main/extensions/typography.ts` | Text style handlers.                                                                                                   |
| `plugin/src/main/extensions/components.ts` | Component and component set handlers.                                                                                  |
| `plugin/src/main/extensions/sections.ts`   | Section handlers.                                                                                                      |
| `plugin/src/main/extensions/paints.ts`     | Paint handlers: `clear_paints`.                                                                                        |
| `plugin/src/main/extensions/dumps.ts`      | `dump_nodes_chunk`, the internal chunk command of a dump.                                                              |
| `plugin/src/main/extensions/e2e.ts`        | `e2e_fixture`, the test helper that builds the conformance fixture parts no tool writes.                               |
| `plugin/src/ui/App.tsx`                    | The plugin window. Holds the WebSocket.                                                                                |
| `server/src/index.ts`                      | Start. Reads `FIGMA_BRIDGE_PORT`. The default is 1995.                                                                 |
| `server/src/schema.ts`                     | `toolInputSchemas` and `rpcToArgs` of the core tools.                                                                  |
| `server/src/output-root.ts`                | The output root: path resolution, real-path containment, and the evidence file write.                                  |
| `server/src/evidence.ts`                   | Canonical JSON, SHA-256, `EvidenceSet` (the `.partial` write), the manifest envelope.                                  |
| `server/src/rpc-token.ts`                  | The install token: the path of its file, its creation, its checks. Node built-ins only.                                |
| `server/src/role.ts`                       | The auditor role: `AUDITOR_TOOLS`, the internal commands, the role parse, the wrapper.                                 |
| `server/src/captures.ts`                   | `save_screenshots`: the plan, the captures, the manifest. The image blocks of `get_screenshot`.                        |
| `server/src/image-size.ts`                 | The pixel size of a PNG or a JPG, read from its header. Imports nothing.                                               |
| `server/src/identity.ts`                   | File selection and the identity of one file, for the manifests. Imports types only.                                    |
| `server/src/build-info.ts`                 | `BRIDGE_COMMIT`, read from `dist/build-info.json`.                                                                     |
| `server/scripts/write-build-info.mjs`      | The build step that writes `dist/build-info.json`.                                                                     |
| `plugin/build-identity.ts`                 | The plugin build identifier. Both Vite configurations import it.                                                       |
| `server/src/schema-common.ts`              | `createFigmaNodeIdSchema`, `createHexColorSchema`, `fileKeyField`.                                                     |
| `server/src/tools.ts`                      | `registerTools` of the core tools.                                                                                     |
| `server/src/tool-helpers.ts`               | `renderResponse`, `parseToolInput`, the `ToolResult` type.                                                             |
| `server/src/extensions/types.ts`           | The area file types.                                                                                                   |
| `server/src/extensions/index.ts`           | Merges `schemas`, `rpcToArgs`, and `register`.                                                                         |
| `server/src/extensions/variables.ts`       | Variable and variable collection tools.                                                                                |
| `server/src/extensions/typography.ts`      | Text style tools.                                                                                                      |
| `server/src/extensions/components.ts`      | Component and component set tools.                                                                                     |
| `server/src/extensions/sections.ts`        | Section tools.                                                                                                         |
| `server/src/extensions/paints.ts`          | Paint tools: `clear_paints`.                                                                                           |
| `server/src/extensions/dumps.ts`           | `dump_nodes`: the chunk loop, `TreeBuilder`, the files, and the manifest.                                              |
| `server/scripts/e2e-free-plan.ts`          | The end-to-end script. Drives every extension tool against a real file.                                                |
| `server/scripts/perf-free-plan.ts`         | The measurement script. Holds each tool to 30 seconds and 50,000 characters.                                           |
| `server/scripts/conformance.ts`            | The dump-conformance test: ID placeholders, the golden file text, the visible projection.                              |
| `server/scripts/golden/`                   | The golden dump of the conformance fixture. Synthetic data from the test file only.                                    |
| `server/test/`                             | `bun test` tests. Real server processes against a simulated plugin. Helpers in `helpers/`.                             |
| `plugin/test/`                             | `bun test` tests of the serializer, the dump form, and the chunk walk. Synthetic nodes.                                |
| `tools/audit/`                             | The audit toolset in Python 3.11, standard library only. `README.md` holds its rules.                                  |
| `tools/audit/auditlib/`                    | `dumps.py` (both formats, the visible projection), `manifest.py`, `outputs.py`, `config.py`, `paths.py`, `toolset.py`. |
| `tools/audit/*.py`                         | `census.py`, `contrast.py`, `sr_precheck.py`, `completeness.py`, and `selfcheck.py`.                                   |
| `tools/audit/assert.py`                    | The checks runner: a checks file against a dump, one PASS or FAIL for each check.                                      |
| `tools/audit/diff_dumps.py`                | The dump diff: `bytes`, `nodes`, and `fields` (a baseline against `dump_nodes` output).                                |
| `tools/audit/tile.py`                      | The tiler: a PNG capture into overlapping tiles of about 1,000 pixels, never scaled.                                   |
| `tools/audit/render_report.py`             | The report renderer: the report as Markdown from script outputs, manifests, and the toolset commit.                    |
| `tools/audit/run_audit.py`                 | The offline re-run: each figure of an audit package reproduced from its dumps, at the recorded commit.                 |
| `tools/audit/tests/`                       | `unittest` tests. Synthetic data in `data/` and the golden dump; dump folders made at run time.                        |

The audit toolset holds no name, ID, or figure of a design file: the configuration, the
exemptions, the baseline dumps, and `expected.json` stay in a fixtures folder outside the
repository. Its figures use the visible projection of a dump, the projection of
`server/scripts/conformance.ts`; a change of that projection changes both.

An extension file must not import `schema.ts` or `tools.ts`; this prevents an import cycle.
It imports only `schema-common.ts`, `tool-helpers.ts`, `output-root.ts`, `identity.ts`,
`evidence.ts`, packages, and types; `output-root.ts`, `identity.ts`, and `evidence.ts`
import neither `schema.ts` nor `tools.ts`. `evidence.ts` imports only Node built-in modules,
`output-root.ts`, and `identity.ts`.

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
15. An evidence file is canonical JSON (`canonicalJson` in `server/src/evidence.ts`). It is
    written as `<name>.partial` and gets its final name only when the call succeeds
    (`EvidenceSet`). It is never overwritten: a target that exists refuses the call before
    it reads Figma. A failed call removes each file it wrote.
16. A tool that returns an image to the conversation returns an image block (`{ type: "image", data,
mimeType }`), never base64 in text. A capture that is large or that serves as evidence goes to
    disk with `save_screenshots`, and the result is a manifest.
17. A read tool joins `AUDITOR_TOOLS` in `server/src/role.ts` only on purpose: change the list
    and its test (`server/test/auditor-role.test.ts`, which writes the 15 names out) together,
    and the e2e list in group K. A new tool never reaches the auditor role by default.
18. `e2e_fixture` (`plugin/src/main/extensions/e2e.ts`, `edit: true`) is a test helper. No
    MCP tool and no role exposes it, and the README does not list it. The e2e script sends it
    with a raw `/rpc` request. Its `op` is `addPaint`, `hidePaint`, `setReactions`,
    `setRangeFill`, `getSkipInvisibleInstanceChildren`, `setSkipInvisibleInstanceChildren`, or
    `setFlowStartingPoints`. It refuses a node off the page `MCP E2E` or under a top-level node
    whose name does not start with `mcp-e2e/`, and a page other than `MCP E2E`.

## 7. Commands

| Command         | Purpose                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `bun install`   | Install. Run it in the root, in `server/`, and in `plugin/`.                                       |
| `bun run check` | The server build, the plugin type check, the plugin build, the format check.                       |
| `bun run test`  | The server build, then `bun test` in `server/` and in `plugin/`. Needs no Figma.                   |
| `bun run e2e`   | In `server/`. The end-to-end script. Needs `FIGMA_FILE_KEY`.                                       |
| `bun run perf`  | In `server/`. The measurement script. Needs `FIGMA_FILE_KEY`. Reads `FIGMA_READ_FILE_KEY` as well. |

Run `bun run check` before each commit. Commit only if the check passes.

The audit toolset has its own commands. Run them from the root, with Python 3.11 or later:

```bash
python -m unittest discover -s tools/audit/tests -t .
```

```bash
python tools/audit/selfcheck.py --fixtures C:/audit-fixtures --outputs C:/audit-output/selfcheck
```

```bash
python tools/audit/render_report.py --assert <label>.assert.json --surfaces <surfaces.json> --prescription-errors <errors.json> --defects <defects.json> --manifest <manifest> --outputs C:/audit-output/report
```

```bash
python tools/audit/run_audit.py <package> --outputs C:/audit-output/rerun
```

The tests need no Figma and no fixtures. The self-check reads the known answers of the
fixtures folder and exits with a code other than 0 at a mismatch or a missing input. Write
its outputs outside the fixtures folder; the toolset refuses an outputs folder in it. Run
the tests after each change in `tools/audit/`, and the self-check on the real fixtures when
the owner has them. `render_report.py` exits with 1 when its verdict is FAIL; `run_audit.py`
exits with 1 at a figure that differs from the recorded one and with 2 at a toolset commit
other than the recorded one, unless `--allow-other-commit` is given.

`FIGMA_BRIDGE_DUMP_CHUNK_NODES` is a setting for tests only: the most records that one
`dump_nodes_chunk` request returns, an integer of 1 or more. The default is 1,000. The test
harness removes it from each test process unless the test gives it. Do not document it in
the README.

`bun run e2e` ends with the result line of the conformance group V:
`CONFORMANCE PASS bridgeCommit=<commit> pluginBuild=<build>`, or
`CONFORMANCE FAIL bridgeCommit=<commit> pluginBuild=<build> failed=<count>`. The commit and
the build come from a manifest of the run. `E2E_UPDATE_GOLDEN=1 bun run e2e` writes
`server/scripts/golden/dump-conformance.json` in place of the compare, and then prints
`CONFORMANCE FAIL`. A change of the golden dump is a change of the serializer: commit it
alone, and the auditor reviews it.

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

Each bridge change passes the conformance test (`CONFORMANCE PASS` in `bun run e2e`) before
an audit uses it. Record the result line with each release.

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
