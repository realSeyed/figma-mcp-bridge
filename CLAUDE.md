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

A leader process lives as long as the standard input of its MCP client.
`node server/dist/index.js --standalone` (also `FIGMA_BRIDGE_STANDALONE=1`, or
`bun run leader`) starts a leader with no MCP transport and no standard-input handler; only
SIGINT, SIGTERM or SIGHUP stop it. A standalone process never follows: if a healthy leader
holds the port, it prints the version and the `leaderStartedAt` of that leader and exits
with 1.

A follower checks its leader every 1 to 2 s (`Election`). A call that loses its leader does
not wait for that check. `Follower` classifies a failed fetch as `refused` (`ECONNREFUSED`, a
connect time-out: the leader did not get the request) or `broken` (each other network
failure: the leader can have sent the request to the plugin). An HTTP status is neither.
`Node` then runs `Election.checkNow` and waits up to 8 s, every 250 ms, until its process is
the leader or `/ping` answers. It sends a refused request or a read (`READ_ONLY_REQUESTS`)
again, one time. It never sends a broken write again: the error says that the change may or
may not be in the file, and to check it with `get_node`.

The time of a request comes from `server/src/timeouts.ts`, a table keyed by request type:
60 s for a type without a row. `FIGMA_BRIDGE_REQUEST_TIMEOUT_MS` changes that default only.
The leader sends the time as `timeoutMs` in each request. A follower waits the time plus the
grace plus 15 s, thus the leader answers first. The leader pings each plugin every 10 s and
closes a plugin that misses one ping. When no connection matches a request (a key that is
absent, or no key and no file), `Bridge` waits for a matching plugin up to
`FIGMA_BRIDGE_CONNECT_GRACE_MS` (10 s), but only inside the grace after the start of the
leader or after the last disconnect of a matching file; outside it the request fails at
once. Each such error holds `No plugin connected`. A time-out error holds `timed out` and a
disconnect error `Plugin disconnected`; for a write, both say that the change can already be
in the file.

The leader listens on `127.0.0.1` only. Each server process calls it by the literal
`http://127.0.0.1:<port>`, not `localhost`, which can resolve to `::1`. A follower sends
each `/rpc` request with `Content-Type: application/json` and `Authorization: Bearer
<token>`. The token is the install token from `server/src/rpc-token.ts`: one file for
each install, which the first process makes. Before it reads the body, the leader answers
415 for another content type, 401 for no token, and 403 for a wrong token. `/rpc` answers
405 to each method but `POST`, and no answer has an `Access-Control-Allow-*` header.
`/ping` stays open. Never log, return, or write the token.

`handleRequest` in `plugin/src/main/code.ts` receives each call and gives it to
`runRequest`. That looks the request type up in the merged extension map first. If an entry
exists, it runs the entry; `edit: true` makes it call `requireEditorMode` first, thus an edit
tool stops with an error in Dev Mode, which is read-only. If no entry exists, control goes to
the switch statement of the core tools. `runExtension` wraps each extension call and puts
the tool name in front of an error that does not carry it, thus a handler throws cause and
correction only; `handleRequest` does the same for a core tool. After each edit request
(`EDIT_REQUEST_TYPES` or `edit: true`), also a failed one, `handleRequest` calls
`figma.commitUndo()`, thus each write is one undo step.

The plugin runs one server request at a time, in arrival order
(`plugin/src/main/request-queue.ts`). A request has a deadline: its arrival plus its
`timeoutMs`, or 120 s without one. A request still queued at its deadline does not start. A
request that runs past it gets an error answer, the next request starts, and its late result
is dropped. The window numbers each socket and sends the number with each request; at a
close it posts `connection-closed`, and the queue drops the requests of that socket that did
not start. `code.ts` exports `handleRequest` and `onPluginMessage` for the tests;
`plugin/test/helpers/plugin-globals.ts` installs the globals and a fake `figma` before it
imports `code.ts`.

`FIGMA_BRIDGE_ROLE=auditor` (`server/src/role.ts`) makes a process register the 16 tools of
`AUDITOR_TOOLS` and no other: `registerTools` gets a wrapper of the server that drops each
other tool, and `index.ts` exits if a listed tool is not registered. A set value other than
exactly `auditor` stops the process at start. The follower of an auditor process adds
`X-Figma-Bridge-Role: auditor` to each `/rpc` request. For a request with that header the
leader runs `AUDITOR_TOOLS` and the internal commands `dump_nodes_chunk`, `get_screenshot`
and `dump_journal_chunk` only; it answers 403 to another tool, before it forwards anything,
and 400 to another header value. A request without the header runs as before, whatever the
role of the leader process is: the role governs the tools and the requests of its own
process, and the own MCP calls of a leader never pass `/rpc`. Thus an auditor leader still
relays the writes of the executor process. The role is a guardrail, not a sandbox: a process
that can read the install token can send a request without the mark.

The bridge reports its identity in `/ping` and `list_files`: `bridgeCommit` (the serving
process), `leaderCommit`, `leaderStartedAt`, and for each file `pluginBuild` and `epoch`.
The server build writes `server/dist/build-info.json` with the commit (`-dirty` for an
unclean tree, `unknown` without git); `server/src/build-info.ts` reads it. The plugin build
makes one identifier (`plugin/build-identity.ts`), gives it to both bundles with
`__PLUGIN_BUILD__`, and the window adds it to the WebSocket URL as `pluginBuild`. `Bridge`
adds 1 to the epoch of a file key at each connection, a replacing one included; a disconnect
and a read leave it. The epoch lives in memory. `list_files` returns an object, not an array.

Each process appends one JSON line for each event to the diagnostics log
(`server/src/diagnostics.ts`): `FIGMA_BRIDGE_LOG_FILE`, or `bridge.log` in the state folder
of the install. It calls `appendFileSync` for each line, thus no handle stays open, and
renames the file to `bridge.log.1` above 5 MB. Each line has `at`, `pid`, `role` and `event`.
A line never holds params, data, node content, or the token. Each process keeps its last 50
events in memory. `/ping` and `list_files` report `health`: the last 20 events of the
leader, `pending` (the requests at a plugin), and `warnings`; a follower adds a warning when
its build is not the build of the leader. The `files` entries do not change.

Each process writes evidence files only under its own output root
(`FIGMA_BRIDGE_OUTPUT_ROOT`, else its working directory). The leader writes no file for
another process: `/rpc` refuses `save_screenshots`, `dump_nodes` and `dump_journal` with
400, and a follower fetches each capture with `get_screenshot`, each dump chunk with
`dump_nodes_chunk`, and each journal chunk with `dump_journal_chunk`, over `/rpc` and writes
the files itself.

`save_screenshots` (`server/src/captures.ts`) runs in the serving process too, and returns a manifest in
the envelope of `evidence.ts`: the identity of the file, one entry for each item, the totals, and
`manifestPath`. A capture entry holds the path, the bytes, the SHA-256, the scale, and the pixel
size, read from the PNG or JPG header (`server/src/image-size.ts`). It returns no image data. The
call reads the identity before the first capture and after the last, fails if the epoch, the plugin
build, or the leader start changed, and removes each file of the call. The manifest file goes
beside the first item as `save_screenshots-<UTC time>.manifest.json`. A target that exists refuses
the call before the first capture. An item that fails alone does not fail the call.
`get_screenshot` takes 4 nodes at most and always sends `maxEdge` (default 1,024): the plugin then
exports PNG and JPG one node at a time, at `min(scale, maxEdge / long edge)`, and returns the scale.
`save_screenshots` sends no `maxEdge` and keeps the old export. A PNG or JPG of 1,568 pixels or less
on the long edge and 3,750,000 bytes or less is an image block and a text block with its metadata;
an SVG is its markup as text while the markup of the call is 35,000 characters or less. A PDF, a
longer SVG, or a larger raster export is a tool error that points to `save_screenshots`. A result
never holds base64 text.

The read budget is `MAX_NODE_RESULT_CHARS` (35,000) in `plugin/src/main/serializer.ts`.
`plugin/src/main/reads.ts` walks a tree one time, in the `full` or the `outline` detail, stops a
branch at `depth` and the walk at the budget, and marks a cut read `truncated` with a `note`.
`get_document`, `get_selection` (one budget for the array), `get_design_context`, and `get_node`
with `depth` or `detail` use it; `get_node` without either keeps `serializeNodeWithinBudget`, byte
for byte. `find_nodes` and `get_design_system` (`extensions/discovery.ts`) stay in the same budget.
`renderResponse` (`server/src/tool-helpers.ts`) is the backstop: above
`FIGMA_BRIDGE_MAX_RESULT_CHARS` (38,000) characters of JSON text, a read (a `tool` on
`READ_ONLY_REQUESTS`) is a tool error that says how to narrow the call, and any other result is a
success with `{ ok: true, resultOmitted: true, chars, note }`, since the write already happened.
Each read tool passes `tool`. These rules changed the output of earlier builds: no base64 text,
a 35,000-character cut of each page read (`get_node` was 50,000; the others were not cut), and
the backstop.

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

The leader keeps a write journal (`server/src/journal.ts`, BR-8). `Bridge.sendWithParams`
records, after it resolves the connection: the own calls of the leader and the `/rpc` calls
of a follower both pass there, so no write path skips it. Each request that reaches a plugin
connection and is not on `READ_ONLY_REQUESTS` adds one entry when the plugin answers or the
wait ends (a time-out, a disconnect): `seq`, `timestamp`, `fileKey`, `epoch`, `auditor`,
`tool`, `nodeIds`, `params`, `response` (`{ data }` or `{ error }`), `prevHash`, `hash`. A
request that reaches no connection adds none. `hash` is the SHA-256 of `canonicalJson` of
the entry without `hash`; the first `prevHash` is the genesis hash, 64 times `0`. The file
is JSON Lines, `FIGMA_BRIDGE_JOURNAL_FILE` or `write-journal.jsonl` in the state folder of
the install. Only the leader opens it: it loads and checks the file in the `listen`
callback, appends with `fsync`, and keeps the count, the head and the byte offset of each
line in memory. One defect is not a failure: a last line without `\n` after valid lines
(a torn append). The leader copies its bytes to `<journal>.torn-<UTC time>` (flag `wx`, mode
0o600), cuts the file back to the end of the last valid line, and appends a
`journal_recovered` entry (`fileKey` `""`, `epoch` 0, and the params
`{ tornBytes, tornSha256, savedTo }`), and logs it one time. An append tries a failed write
or `fsync` again 3 times, 50 ms apart, on `EAGAIN`, `EBUSY`, `EINTR`, and on Windows `EPERM`.
Each other failed check, and an append that still fails, makes the journal broken: the
leader logs it one time, reports it in the `journal` field of `/ping` and `list_files`,
refuses each write before the plugin sees it, and serves each read. It never truncates,
repairs, or rewrites the file, except to move a torn last line aside. Before the hash, each
string longer than 8192 UTF-16 units in `params` and in `response.data` becomes
`{ "omitted": true, "sha256", "bytes" }` of its UTF-8; the plugin and the caller get the
whole value. The journal holds the params and the responses of each write: it is private
data of the owner.

`dump_journal_chunk` is an internal command that the leader serves itself, from the journal
file: `handleRPC` answers it before the validation and the bridge, as it answers `list_files`,
and `Node.sendWithParams` gives the own call of a leader process to `Leader.journalChunk`. It
never reaches a plugin. Its params are `afterSeq`, `throughSeq` (`null` on the first request)
and `maxEntries`; the answer is `{ status, entryCount, headHash, entries }`, at most
`maxEntries` entries and about 4,000,000 bytes, one entry at least. A broken journal answers an
error with the reason. `dump_journal` (`server/src/extensions/journal.ts`) runs in the serving
process: it refuses a target that exists, reads the identity with `node.identityReport()`,
fetches the chunks up to the count of the first one, checks the chain against that head, fails
if `leaderStartedAt` changed, and writes `journal.json` and `manifest.json` through
`EvidenceSet`. The manifest holds no `fileKey`, `pluginBuild` or `epoch`. `fileKey` filters
nothing. A dump adds no entry.

## 4. File map

| File                                       | Purpose                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `plugin/manifest.json`                     | Plugin id, name, and allowed domains. Keep `documentAccess: "dynamic-page"`.                                           |
| `plugin/src/main/code.ts`                  | `RequestType`, `EDIT_REQUEST_TYPES`, `requireEditorMode`, `handleRequest`, `onPluginMessage`, core tools.              |
| `plugin/src/main/request-queue.ts`         | The request queue of the plugin: one request at a time, the deadlines, the drop of a closed socket.                    |
| `plugin/src/main/serializer.ts`            | The node output of the read tools, and the base of the dump form.                                                      |
| `plugin/src/main/dump.ts`                  | The dump form of a node: the read form, the hidden content, and the added fields.                                      |
| `plugin/src/main/reads.ts`                 | The budgeted reads: one walk with `depth` and `detail`, the cut, the note.                                             |
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
| `plugin/src/main/extensions/discovery.ts`  | `find_nodes` and `get_design_system`.                                                                                  |
| `plugin/src/main/extensions/e2e.ts`        | `e2e_fixture`, the test helper that builds the conformance fixture parts no tool writes.                               |
| `plugin/src/ui/App.tsx`                    | The plugin window. Holds the WebSocket.                                                                                |
| `server/src/index.ts`                      | Start. Reads `FIGMA_BRIDGE_PORT`. The default is 1995.                                                                 |
| `server/src/schema.ts`                     | `toolInputSchemas` and `rpcToArgs` of the core tools.                                                                  |
| `server/src/output-root.ts`                | The output root: path resolution, real-path containment, and the evidence file write.                                  |
| `server/src/evidence.ts`                   | Canonical JSON, SHA-256, `EvidenceSet` (the `.partial` write), the manifest envelope.                                  |
| `server/src/rpc-token.ts`                  | The install token: the path of its file, its creation, its checks. Node built-ins only.                                |
| `server/src/role.ts`                       | The auditor role: `AUDITOR_TOOLS`, the internal commands, the role parse, the wrapper.                                 |
| `server/src/journal.ts`                    | The write journal: `READ_ONLY_REQUESTS`, the path, the entry hash, the load check, the torn tail, the append.          |
| `server/src/timeouts.ts`                   | The time of each request type, the time of a follower, and the connect grace.                                          |
| `server/src/diagnostics.ts`                | The diagnostics log: the event lines, the rotation, and the last events for `health`.                                  |
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
| `server/src/extensions/journal.ts`         | `dump_journal`: the chunk loop, the chain check, the files, and the manifest.                                          |
| `server/src/extensions/discovery.ts`       | `find_nodes` and `get_design_system`: the schemas and the registration.                                                |
| `server/scripts/e2e-free-plan.ts`          | The end-to-end script. Drives every extension tool against a real file.                                                |
| `server/scripts/perf-free-plan.ts`         | The measurement script. Holds each tool to 30 seconds and 38,000 characters.                                           |
| `server/scripts/conformance.ts`            | The dump-conformance test: ID placeholders, the golden file text, the visible projection.                              |
| `server/scripts/golden/`                   | The golden dump of the conformance fixture. Synthetic data from the test file only.                                    |
| `server/test/`                             | `bun test` tests. Real server processes against a simulated plugin. Helpers in `helpers/`.                             |
| `plugin/test/`                             | `bun test` tests of the serializer, the dump form, the chunk walk, the queue, `handleRequest`. Synthetic nodes.        |
| `plugin/test/helpers/fake-figma.ts`        | A fake file: pages, selection, lookup, search, `exportAsync`, variables, styles. Generic, for reads and writes.        |
| `.github/workflows/ci.yml`                 | CI for each pull request and each push to `main`: check, tests, toolset tests, on Ubuntu and Windows.                  |
| `tools/audit/`                             | The audit toolset in Python 3.11, standard library only. `README.md` holds its rules.                                  |
| `tools/audit/auditlib/`                    | `dumps.py` (both formats, the visible projection), `manifest.py`, `outputs.py`, `config.py`, `paths.py`, `toolset.py`. |
| `tools/audit/*.py`                         | `census.py`, `contrast.py`, `sr_precheck.py`, `completeness.py`, `journal_check.py`, and `selfcheck.py`.               |
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
    and its test (`server/test/auditor-role.test.ts`, which writes the 16 names out) together,
    and the e2e list in group K. A new tool never reaches the auditor role by default.
18. `e2e_fixture` (`plugin/src/main/extensions/e2e.ts`, `edit: true`) is a test helper. No
    MCP tool and no role exposes it, and the README does not list it. The e2e script sends it
    with a raw `/rpc` request. Its `op` is `addPaint`, `hidePaint`, `setReactions`,
    `setRangeFill`, `getSkipInvisibleInstanceChildren`, `setSkipInvisibleInstanceChildren`, or
    `setFlowStartingPoints`. It refuses a node off the page `MCP E2E` or under a top-level node
    whose name does not start with `mcp-e2e/`, and a page other than `MCP E2E`.
19. A new write tool records itself in the write journal and needs no code for it: each
    request type that is not on `READ_ONLY_REQUESTS` in `server/src/journal.ts` is recorded.
    A new read tool joins `READ_ONLY_REQUESTS` only on purpose: change the list and its test
    (`server/test/write-journal.test.ts`, which writes the names out) together. A read that is
    not on the list is recorded as a write, which is the safe failure.
20. A new request type that needs more than 60 s adds a row to `REQUEST_TIMEOUTS_MS` in
    `server/src/timeouts.ts`. The plugin queue and the follower take their times from it.

## 7. Commands

| Command          | Purpose                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `bun install`    | Install. Run it in the root, in `server/`, and in `plugin/`.                                       |
| `bun run check`  | The server build, the plugin type check, the plugin build, the format check.                       |
| `bun run test`   | The server build, then `bun test` in `server/` and in `plugin/`. Needs no Figma.                   |
| `bun run leader` | The standalone leader. Build first. Stop it with Ctrl+C.                                           |
| `bun run e2e`    | In `server/`. The end-to-end script. Needs `FIGMA_FILE_KEY`.                                       |
| `bun run perf`   | In `server/`. The measurement script. Needs `FIGMA_FILE_KEY`. Reads `FIGMA_READ_FILE_KEY` as well. |

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

```bash
python tools/audit/journal_check.py <journal dump folder> [--after <hash>] [--expected <expected-writes.json>] --outputs C:/audit-output/journal
```

The tests need no Figma and no fixtures. The self-check reads the known answers of the
fixtures folder and exits with a code other than 0 at a mismatch or a missing input. Write
its outputs outside the fixtures folder; the toolset refuses an outputs folder in it. Run
the tests after each change in `tools/audit/`, and the self-check on the real fixtures when
the owner has them. `render_report.py` exits with 1 when its verdict is FAIL; `run_audit.py`
exits with 1 at a figure that differs from the recorded one and with 2 at a toolset commit
other than the recorded one, unless `--allow-other-commit` is given. `journal_check.py` prints
`JOURNAL_CHECK PASS entries=<n> head=<hash>` or `JOURNAL_CHECK FAIL ... failed=<count>`, and
exits with 0 when each check passes, with 1 when a check fails (an `--after` hash that is in
no entry included), and with 2 when an input is wrong, also a journal file that does not
match its manifest.

`FIGMA_BRIDGE_DUMP_CHUNK_NODES` is a setting for tests only: the most records that one
`dump_nodes_chunk` request returns, an integer of 1 or more. The default is 1,000. The test
harness removes it from each test process unless the test gives it. Do not document it in
the README.

`FIGMA_BRIDGE_JOURNAL_CHUNK_ENTRIES` is a setting for tests only, in the same way: the most
entries that one `dump_journal_chunk` request asks for, an integer of 1 or more. The default
is 500. The harness removes it too. Do not document it in the README.

`FIGMA_BRIDGE_REQUEST_TIMEOUT_MS`, `FIGMA_BRIDGE_CONNECT_GRACE_MS`, `FIGMA_BRIDGE_STANDALONE`,
`FIGMA_BRIDGE_LOG_FILE` and `FIGMA_BRIDGE_MAX_RESULT_CHARS` are settings of the owner, and the
README documents them. The harness removes each of them from a test process unless the test
gives it, sets the grace to `0`, and sets the log file to a temporary file of the harness. `serverEnv` refuses a process
without a token file, a journal file, or a log file. A test that runs a module that logs in
the test process itself sets `FIGMA_BRIDGE_LOG_FILE` first.

`bun run e2e` prints the result line of the journal group W just before the last line:
`JOURNAL PASS start=<count>:<head> end=<count>:<head> writes=<n>`, or `JOURNAL FAIL ...
failed=<count>`. `E2E_JOURNAL_EVIDENCE`, an absolute folder outside the repository, gets the
dump of W4 and `expected-writes.json`. The run ends with the result line of the conformance
group V:
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
