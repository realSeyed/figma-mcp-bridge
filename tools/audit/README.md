# Audit toolset

The scripts in this folder read the evidence that the bridge writes to disk — the dumps of `dump_nodes`, and the baseline reads that came before them — and calculate each figure of a design audit. The auditor process runs them on the files. It does not count nodes or compute a ratio by reading node data in its conversation.

| Script            | Role                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `census.py`       | The binding census and the layout audit of a root; the list of instanced component sets. |
| `contrast.py`     | The WCAG 2.2 contrast of each text; the contrast table of the colour foundations.        |
| `sr_precheck.py`  | The surface pre-check: rows that say where to look closer in the captures.               |
| `completeness.py` | The variant count of a set against `list_components`; page and nested completeness.      |
| `assert.py`       | The checks runner: evaluates the checks file of a milestone against a dump.              |
| `diff_dumps.py`   | Compares two dumps byte for byte, by node, or field by field (baseline against a dump).  |
| `tile.py`         | Cuts a PNG capture into overlapping tiles of about 1,000 pixels, never scaled.           |
| `selfcheck.py`    | Runs each known answer of a fixtures folder, and the fingerprint of the baseline.        |

## Rules

- **The pin.** Run the toolset only from a checkout of a tagged commit of this repository, in the workspace of the auditor process. Never run a script from a package under audit, or from a copy on another computer. Record the tag and the commit with the audit.
- **The self-check first.** Run `selfcheck.py` before each audit, and after each change of a script. An audit starts only when the self-check passes.
- **No design-file data in the repository.** The repository holds code and synthetic test data only. The baseline dumps, the exemptions, the configuration, and `expected.json` hold node IDs, names, and figures of the design file, so they stay in a fixtures folder outside the repository. Each script takes their paths as arguments.
- **Outputs apart from evidence.** A script reads dumps and captures, and writes only under the folder that `--outputs` names. It never writes into an evidence folder or into the fixtures folder. A script calculates each figure; nothing is copied from a conversation.
- **Python.** Python 3.11 or later, the standard library only. `requirements.txt` lists no package; a third-party package, if one is ever needed, goes there with an exact version.

## Inputs

### The two dump formats

Each script that reads a dump takes either format and gives the same node model: a dict with the field names of the dump form (`plugin/src/main/dump.ts`), which extends the `get_node` form.

| Format       | What it is                                                                                                                                                                            | How a script finds it                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline`   | One JSON file with a `get_node` result, saved before `dump_nodes` existed. It holds no hidden content. A cut read marks a node with `childCount`.                                     | A file with no `manifest.json` beside it.                                                                                                                             |
| `dump_nodes` | A folder with `manifest.json` and one canonical file for each root, `12:34` as `12_34.json` (see "Dumps" in the main README). It holds the hidden content and the fields a dump adds. | The folder, or a file that the `manifest.json` beside it lists. A folder of more than one root needs `--root`; `completeness.py` and `instanced-sets` read each root. |

- **The manifest check.** A script reads a `dump_nodes` file only through its manifest: it reads the bytes one time, compares the size and the SHA-256 with the manifest, and parses those bytes. A mismatch stops the script with exit code 2. `auditlib/manifest.py` also resolves the manifest of `save_screenshots`, whose paths are relative to the output root.
- **A dump file without its manifest.** A file with no manifest beside it is read as a baseline, and is refused when it holds content that only `dump_nodes` writes: a hidden node below the root, a hidden paint or effect, an added field, or the binding of a paint. Read the dump through its folder. For a baseline file in an older read form that keeps hidden nodes, give `--format baseline`.
- **`includeHidden: false`.** Such a dump is not audit evidence. The scripts compute the visible figures, and report the hidden content as not dumped.

### The other inputs

| Input             | Option                | Format                                                                                                                                   |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Variables         | `--vars`              | A `get_variable_defs` payload, `{ "collections": [...] }`, or a dump folder with `variables.json` (checked by its manifest).             |
| Exemptions        | `--exemptions`        | `{ "unbound_paint": { "<node ID>": "<reason>" }, "theme_binding_subtree": { "<node ID>": "<reason>" } }`                                 |
| Configuration     | `--config`            | The names of the design file that the scripts need; see below.                                                                           |
| Components        | `--components`        | A saved `list_components` result (`items` with `id` and `variantCount`), or a `get_component` result (`variantCount`).                   |
| Page child counts | `--page-child-counts` | `[ { "id": "<page ID>", "child_count": <n> } ]`, or an object of page ID to count.                                                       |
| Instance cache    | `--cache`             | `get_instance` results by instance ID, for a baseline dump: `{ "<id>": { "mainComponent": { "parentSetId", "parentSetName" } } }`.       |
| Token pairings    | positional            | A CSV with the columns `pairing`, `category`, `threshold` (empty for exempt), `token1`, `token2` (a variable name, or its last segment). |

The scripts hold no name of the design file. The configuration file gives them:

```json
{
  "spacing_collection": "<the collection of the spacing scale>",
  "theme_collections": ["<a collection whose bindings census.py counts>"],
  "context_base": "<a variable name or ID, or #rrggbb>",
  "disabled_variant": { "property": "<a variant property>", "value": "<its disabled value>" }
}
```

`census.py` needs `spacing_collection` and `theme_collections`; `contrast.py` needs `context_base`. Without `disabled_variant`, no text is exempt. An unknown key stops the script, so a typo does not pass silently.

## Outputs

`--outputs` names the outputs folder; the script makes it when it is missing. A folder is protected when it holds `manifest.json` or a `*.manifest.json` file (an evidence folder), or `expected.json` (a fixtures folder), or when `--fixtures` names it. The outputs folder may not be a protected folder or lie in one, and no output name may leave the outputs folder. The paths are compared as real paths. A script replaces its own earlier outputs in the outputs folder; evidence is never written.

## Visible figures and hidden content

Each figure of the earlier scripts is calculated over the visible content: the baseline as it is, or the visible projection of a `dump_nodes` dump — the same projection as the conformance test (`server/scripts/conformance.ts`). Thus a figure of a dump compares with the same figure of a baseline read, and on a baseline file each figure is the figure of the earlier scripts.

The hidden content of a `dump_nodes` dump is reported apart, with a clear label: `hidden_content` in each JSON output, findings rows whose category starts with `hidden_`, and `<label>.hidden.csv` files. It is never added to a visible figure. A baseline dump has `hidden_content: null`.

Two deliberate exceptions:

- **Completeness counts each child.** Figma counts a hidden variant in `variantCount` and a hidden child in the child count of a page, so `completeness.py` counts the hidden children of a dump too, and gives how many of them are hidden in `hidden`. A visible count would fail a complete set.
- **The bound test of a hidden paint.** The census takes a visible paint as bound when the node-level `boundVariables` list of its field has an entry at its index, as the earlier script did. That list leaves out the unbound paints, so the rule can count the wrong paint of a node with an unbound paint before a bound one; the count is right, the colour can be the other paint's. A hidden paint has no baseline to compare with, so the census uses the binding that the dump gives each paint.

## The scripts

Each script exits with 0 when it ran, 1 when one of its checks failed (`completeness.py`, `assert.py`) or when the two sides differ (`diff_dumps.py`), and 2 when an input is missing, refused, or does not match its manifest.

### census.py

```bash
python tools/audit/census.py audit <dump> [--root <id>] --vars <variables> --exemptions <exemptions.json> --config <config.json> --label <name> --outputs <folder>
python tools/audit/census.py instanced-sets --dumps <dump> [<dump> ...] [--cache <cache.json>] [--components <list_components.json>] --outputs <folder>
```

`audit` writes `<label>.census.json` and `<label>.findings.csv`. It reports the unbound SOLID paints by colour with the exemptions of the list; the radius-bearing nodes and how many bind a radius, read from the corner fields `topLeftRadius` to `bottomRightRadius`, because Figma spreads a `cornerRadius` binding across the four corners; the raw non-zero gaps and paddings and which of them are off the spacing scale (a zero gap or padding is not counted); the bindings to the theme collections outside the exempt subtrees; and the nested shortfalls of a cut read.

`instanced-sets` writes `instanced_sets.csv`: each component set that is instanced on the roots it reads, with the count and the roots. A `dump_nodes` dump names the set of each instance (`componentSetId`); a baseline dump needs the instance cache. The instances in hidden content go to `instanced_sets.hidden.csv`.

### contrast.py

```bash
python tools/audit/contrast.py audit <dump> [--root <id>] --vars <variables> --config <config.json> [--context-base <name|id|#rrggbb>] [--label <name>] --outputs <folder>
python tools/audit/contrast.py table <pairings.csv> --vars <variables> [--out-name contrast_table.txt] --outputs <folder>
```

`audit` scores each visible text against its effective background. It composites the stacked SOLID fills of the text and its ancestors over an opaque base: the dump itself when the stack is opaque (`base: dump`), else the context base of the configuration (`base: context`). It marks a pair "not computed" only when a non-solid fill shows through and no opaque base exists (`non_solid_shows_through`), when the text has no fill (`no_text_fill`), or when its fills differ by range (`mixed_text_fill`). Normal text needs 4.5:1; large text (24 px, or 18.66 px and bold) needs 3:1, and so does text made only of star glyphs, which is scored as a graphical object. A mixed size or weight counts as normal text. Text in the disabled variant of the configuration is exempt. It writes `<label>.pairs.csv`, `<label>.not_computed.csv`, `<label>.summary.json`, and for a `dump_nodes` dump `<label>.hidden.csv` with the hidden texts, which are not scored.

`table` writes the contrast table of the colour foundations from the token pairings.

### sr_precheck.py

```bash
python tools/audit/sr_precheck.py <dump> [--root <id>] [--mode default|all] [--label <name>] --outputs <folder>
```

`--mode default` gives each node that overflows a parent that clips its content. `--mode all` gives each node that escapes its parent, clipping or not, the siblings at identical coordinates, and the top-level children of a page that overlap. It writes `<label>.csv`, and for a `dump_nodes` dump `<label>.hidden.csv` with the rows that appear only when the hidden content is included. A row says where to look closer. The pre-check never replaces the reading of the captures: a row is not a defect, and no row is not a pass.

### completeness.py

```bash
python tools/audit/completeness.py <dump> [<dump> ...] --components <list_components.json> [--page-child-counts <counts.json>] --outputs <folder>
```

For each component set root, it compares the variants in the dump with the `variantCount` of the listing, and fails when they differ. A set that the listing does not name gets `UNCHECKED`, and the script exits with 1: the variant count is not proven. For each page root with page child counts, it compares the children. It also reports each nested shortfall of a cut read. It writes `completeness.json`; `expected_source` says where each expected value came from.

### assert.py

```bash
python tools/audit/assert.py <checks.json> <dump> [--root <id>] [--vars <variables>] [--config <config.json>] [--label <name>] --outputs <folder>
```

The checks file is a JSON array; each row is one check. The synthetic example below has one check of each kind:

```json
[
  {
    "id": "C-1",
    "node": "12:34",
    "field": "styles.fills[0].color",
    "op": "eq",
    "expected": "#ffffff"
  },
  { "id": "C-2", "node": "12:35", "measure": "variantCount", "op": "ge", "expected": 4 },
  {
    "id": "C-3",
    "node": "12:36",
    "measure": "contrastRatio",
    "op": "approx",
    "expected": 4.5,
    "tolerance": 0.05
  },
  { "id": "C-4", "node": "12:37", "field": "boundVariables.fills", "op": "exists" }
]
```

| Key         | Meaning                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | The ID of the check. Unique in the file.                                                                                              |
| `node`      | The node ID. The node may sit in any root of a dump folder; `--root` limits the dump to one root.                                     |
| `field`     | A path into the node: dotted keys and list indexes, `styles.fills[0].color`. Write `["key"]` for a key that holds a dot or a bracket. |
| `measure`   | A derived figure (below). A row has `field` or `measure`, not both.                                                                   |
| `op`        | The operator (below).                                                                                                                 |
| `expected`  | The value to compare with. `exists` and `absent` take none.                                                                           |
| `tolerance` | A number of 0 or more. `approx` needs it, and no other operator takes it.                                                             |
| `comment`   | Free text; it goes to the output.                                                                                                     |

The operators: `eq` and `ne` (the parsed values; `true` is not `1`, and `1` is `1.0`), `lt`, `le`, `gt`, `ge` (numbers), `approx` (the difference is at most `tolerance`), `in` (the value is one of a list), `contains` (a substring of a text, a member of a list, or a key of an object), `exists`, `absent`, and `matches` (a regular expression, searched with Python `re.search`).

A value that is not there, or is `null`, is absent. A check on an absent value fails for each operator except `absent`; `ne` does not pass on a missing field, so a value that was not observed never turns into a pass. A value of the wrong type fails the numeric and text operators.

The checks read the full tree of the dump, hidden content included, so a check can address a hidden node. The measures:

| Measure                  | Value                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `childCount`             | The children of the node, hidden ones included.                                                                                                |
| `visibleChildCount`      | The children that are not hidden (`styles.visible` is not `false`).                                                                            |
| `variantCount`           | The `COMPONENT` children of a `COMPONENT_SET`, hidden variants included, as Figma counts them. Another node type is an input error.            |
| `boundVariable(<field>)` | The variable ID in `boundVariables` at the path: `boundVariable(paddingTop)`, `boundVariable(fills[0])`; a list for `boundVariable(fills)`.    |
| `contrastRatio`          | The WCAG ratio of a visible text node, from `contrast.py` (a number with two decimals). Needs `--vars` and `--config`. A hidden text has none. |

`assert.py` writes `<label>.assert.json` (the checks file with its SHA-256, the dump sources, the totals, and one result for each check) and `<label>.assert.txt` (the table and the result line). A row has `id`, `node`, `field` or `measure`, `op`, `expected`, `observed`, and `PASS` or `FAIL`. The label is the name of the checks file. Exit codes: 0 when each check passes, 1 when a check fails, 2 when an input is wrong: an unknown node, an unknown operator or measure, a bad path or regular expression, a bad row, a dump that does not match its manifest. All rows are checked before the first runs; an input error lists each bad row (`checks[<index>]: <cause>`) and writes no result. A real checks file belongs in the fixtures folder, not in the repository.

### diff_dumps.py

```bash
python tools/audit/diff_dumps.py --mode bytes  <dump folder A> <dump folder B> --outputs <folder>
python tools/audit/diff_dumps.py --mode nodes  <dump A> <dump B> [--root <id>] [--root-b <id>] [--only <node IDs file>] --outputs <folder>
python tools/audit/diff_dumps.py --mode fields <baseline file> <dump B> [--root-b <id>] [--only <node IDs file>] --outputs <folder>
```

- **`bytes`** compares two `dump_nodes` folders (or their `manifest.json` files) file by file by SHA-256: `equal`, `different`, `only_in_a`, or `only_in_b`. Each manifest and each file it lists is checked first; a file that changed after the bridge wrote it stops the run with exit code 2. Files are matched by file name. The manifests themselves are not compared, because they hold times.
- **`nodes`** compares two dumps of the same format by node ID. It lists the nodes added, the nodes removed, and the nodes changed with the paths of the changed fields (`styles.fills[1].color`). `parentId` stands for a move, and `childOrder` for a different order of the children that both sides hold. A folder of more than one root is one set of nodes, unless `--root` names one root. The two sides need the same `includeHidden` option, because every hidden node would show as added or removed. `--only` takes a change set: a JSON array of node IDs, or a text file with one ID on each line (`#` starts a comment). The diff then covers those nodes only, and `outside_change_set` counts the other differences. An ID that neither side holds is an input error.
- **`fields`** compares a package written before T-1 (side A, the baseline format) with `dump_nodes` output (side B, the same root as A unless `--root-b` says otherwise), field by field. It compares the parsed values, so key order and whitespace play no part. Both sides are reduced to the visible projection first, so the content that the old format cannot carry is ignored: a hidden node with its subtree, a hidden paint or effect, the fields `mainComponentId`, `componentSetId`, `detachedInfo`, `reactions`, `flowStartingPoints`, and `styledTextSegments`, and the `boundVariables` of a paint. The list is in the `ignored` key of the output.

It writes `<label>.diff.json` and `<label>.diff.txt` (default label `diff_<mode>`). Exit codes: 0 when the sides are equal, 1 when they differ, 2 when an input is wrong or does not match its manifest.

### tile.py

```bash
python tools/audit/tile.py <capture.png> [--manifest <save_screenshots manifest>] [--tile-size 1000] [--overlap 100] [--label <name>] --outputs <folder>
```

An image read is scaled down above 1,568 pixels on the long edge, which loses small text. `tile.py` cuts the capture into tiles of at most `--tile-size` pixels, in rows from the top left. A tile starts `tile size - overlap` pixels after the one before it, and the last tile on an axis ends at the image edge, so a tile at an edge can be smaller. An image smaller than one tile gives one tile. No tile is scaled; its pixels are those of the capture.

With `--manifest`, the capture is read through the capture manifest: its size and SHA-256 are checked, and its `pixelWidth` and `pixelHeight` must match the PNG header. The reader and writer handle 8-bit RGB and RGBA PNG without interlace, with `zlib` from the standard library. Any other PNG (indexed, greyscale, 16-bit, interlaced) and any JPEG is refused with an error that names the reason; capture with the format PNG. The other chunks of the PNG (colour profile, text) are not copied to the tiles.

It writes `<label>.r<row>c<column>.png` for each tile and `<label>.tiles.json`: the source (path, SHA-256, size, pixel size, colour type), the options, and for each tile its file, `x`, `y`, `width`, `height`, `bytes`, and `sha256`. The tile manifest is not named `manifest.json`, because a folder with that name counts as an evidence folder. Exit codes: 0 when the tiles are written, 2 when an input is wrong.

## The self-check

```bash
python tools/audit/selfcheck.py --fixtures <fixtures folder> --outputs <outputs folder>
```

It reads `<fixtures folder>/expected.json`, and the expected values only from there. It compares the fingerprint of each listed file — the baseline `get_variable_defs` dump at least — and runs each known answer. It prints one line for each check, then a result line, and writes the same lines to `selfcheck.txt` and the results to `selfcheck.json` in the outputs folder:

```text
PASS fingerprint baseline variables observed="<sha256>" expected="<prefix>"
PASS census page A radius.bearing observed=12 expected=12
FAIL contrast pages active_dump.failing observed=3 expected=2
SELFCHECK FAIL checks=3 failed=1
```

It exits with 0 when each check passes, 1 at a mismatch, and 2 when an input or a figure is missing or `expected.json` is not usable. Do not change an expected value to make a check pass: find the cause in the scripts.

### The format of expected.json

A synthetic example; each path is relative to the fixtures folder:

```json
{
  "config": "audit_config.json",
  "fingerprints": [
    { "name": "baseline variables", "path": "variables.raw.json", "sha256": "3f2a9c1e5b7d" }
  ],
  "known_answers": [
    {
      "name": "census page A",
      "script": "census",
      "inputs": {
        "dump": "page_a.raw.json",
        "variables": "variables.raw.json",
        "exemptions": "census_exemptions.json"
      },
      "figures": { "radius.bearing": 12, "unbound_paints.total": 4 }
    },
    {
      "name": "contrast pages",
      "script": "contrast",
      "inputs": {
        "dumps": ["page_a.raw.json", { "path": "dumps/run1", "root": "1:2" }],
        "variables": "variables.raw.json"
      },
      "figure": "active_context.failing_ids",
      "expected": ["1:7", "1:9"],
      "match": "unordered"
    }
  ]
}
```

| Key             | Meaning                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`        | The configuration: a path, or the object itself.                                                                                                                                                                |
| `fingerprints`  | Required. `name`, `path`, and `sha256`: the full value or a prefix of 8 hexadecimal characters or more. `form` is `bytes` (the default, the SHA-256 of the file) or `canonical` (of its canonical JSON).        |
| `known_answers` | Required, a list. Each has `name`, `script`, `inputs`, and either `figure` with `expected` or `figures`, an object of figure to expected value. Each figure gives one line. The earlier object form is refused. |
| `match`         | How each figure of a known answer compares: `exact` (the default), `unordered` (a list in any order), `subset` (each key of an expected object), or `prefix` (a string).                                        |

A dump input is a path, or `{ "path", "root", "format" }`; `root` and `format` may also sit beside `dump`. A figure is a dotted path into the figures of the script; a key that holds a dot, such as an off-scale value `12.5`, still matches.

| Script         | Inputs                                                           | Figures                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `census`       | `dump`, `variables`, `exemptions`                                | `unbound_paints.count` and `.colours` (without the exempt paints), `.exempt`, `.total` and `.colours_all` (with them); `radius.bearing`, `.bound`, `.raw`; `spacing.raw_nonzero`, `.on_scale`, `.off_scale`, `.off_scale_values`; `theme_or_raw_binding_entries_outside_exemptions`; `nested_shortfalls`; `hidden_content`. |
| `contrast`     | `dumps` (a list) or `dump`, `variables`, `context_base`, `scope` | `active_dump.computed`, `.passing`, `.failing`; `active_context.` the same and `.failing_ids` (in walk order); `exempt`; `not_computed`; `hidden`; `labels` (the pairs and the hidden texts); `pairs.<node ID>.text`, `.bg`, `.ratio`, `.base`, `.threshold`, `.status`; `scope`; `hidden_content`.                         |
| `sr_precheck`  | `dump`, `mode`                                                   | `rows`; `hidden_rows`.                                                                                                                                                                                                                                                                                                      |
| `completeness` | `dump`, `components`, `page_child_counts`                        | `set_completeness` and `page_completeness`: `.result`, `.carried`, `.expected`, `.expected_source`, `.hidden`; `nested_shortfalls`.                                                                                                                                                                                         |

`scope` is a text: the `scope` figure then covers the texts that are direct children of a child of a root whose name holds the text. It gives `dump` and `context`, each with `count` and the `text`, `bg`, and `ratio` of its first pair, and `exempt`.

The earlier scripts kept their known answers in another shape. When you write them in this format: an unbound-paint count with the exempt paints included is `unbound_paints.total`, and its colours are `unbound_paints.colours_all`; a sorted list of failing IDs needs `"match": "unordered"`; a check of only some entries of an object needs `"match": "subset"`.

## Tests

```bash
python -m unittest discover -s tools/audit/tests -t .
```

Run it from the repository root. The tests need no Figma and no fixtures folder. Their data is synthetic: the golden dump of the conformance fixture, and small dumps written by hand in both formats in `tests/data/`. Each test writes its `dump_nodes` folders and its PNG files at run time, as the bridge does, and works out its expected figures by hand.
