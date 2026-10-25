import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Node } from "../node.js";
import {
  canonicalBytes,
  canonicalJson,
  EvidenceSet,
  folderTimestamp,
  sha256Hex,
  utcTimestamp,
} from "../evidence.js";
import { parseToolInput } from "../tool-helpers.js";
import type { ToolResult } from "../tool-helpers.js";
import type { IdentityReport } from "../types.js";
import type { ExtensionRpcMap, ExtensionSchemaMap } from "./types.js";

/**
 * Journal tools.
 *
 * `dump_journal` runs in the process that serves the call. It fetches the
 * entries of the write journal of the leader in chunks with the internal
 * command `dump_journal_chunk`, which the leader serves itself from the file,
 * checks the chain, and writes `journal.json` and `manifest.json` under the
 * output root of this process. The result is the manifest only.
 *
 * Import only from `schema-common.js`, `tool-helpers.js`, `evidence.js`,
 * `identity.js`, packages, and types. Importing `schema.js` or `tools.js`
 * here would close an import cycle. The journal module is not on that list,
 * so the hash and the genesis hash are calculated here again.
 */

const TOOL = "dump_journal";

/** The internal command that fetches the entries. */
const CHUNK_REQUEST = "dump_journal_chunk";

/** The `prevHash` of the first entry: `GENESIS_HASH` of `journal.ts`. */
const GENESIS_HASH = "0".repeat(64);

/** The most entries one chunk returns, unless the test setting overrides it. */
const DEFAULT_CHUNK_ENTRIES = 500;

/** A test setting: the most entries one chunk returns. */
const CHUNK_ENTRIES_VARIABLE = "FIGMA_BRIDGE_JOURNAL_CHUNK_ENTRIES";

const JOURNAL_FILE = "journal.json";
const MANIFEST_FILE = "manifest.json";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

const dumpJournalInput = z.object({
  outputPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The folder for journal.json and manifest.json, under the output root of this server process. Defaults to journal/<UTC time>. The folder must not hold either file already: evidence is never overwritten."
    ),
  fileKey: z
    .string()
    .optional()
    .describe(
      "Accepted as on each tool, but it filters nothing: the journal covers each file, and a filter would break the chain."
    ),
});

type DumpJournalInput = z.infer<typeof dumpJournalInput>;

/** Tool name to Zod object schema. Spread into `toolInputSchemas`. */
export const schemas = {
  dump_journal: dumpJournalInput,
} satisfies ExtensionSchemaMap;

/**
 * Tool name to RPC wire mapper. Spread into `rpcToArgs`. The leader refuses
 * `dump_journal` over `/rpc`, so the mapper only keeps the map complete.
 */
export const rpcToArgs = {
  dump_journal: (_nodeIds, params) => ({ ...params }),
} satisfies ExtensionRpcMap;

/** The one file of the manifest. */
export interface JournalManifestFile {
  kind: "journal";
  /** Relative to the output root, with `/`. */
  path: string;
  sha256: string;
  bytes: number;
  entryCount: number;
}

/**
 * The manifest of a dump of the journal. The journal belongs to no Figma
 * file, so it holds no `fileKey`, no `pluginBuild` and no `epoch`.
 */
export interface JournalManifest {
  tool: typeof TOOL;
  bridgeCommit: string;
  leaderCommit: string;
  leaderStartedAt: string;
  /** The real path of the output root. */
  outputRoot: string;
  /** The folder of the files, relative to the output root, with `/`. */
  outputPath: string;
  startedAt: string;
  finishedAt: string;
  entryCount: number;
  headHash: string;
  genesisHash: string;
  files: JournalManifestFile[];
}

type Json = Record<string, unknown>;

/** A failure of one call: the message names the place, the cause, and the correction. */
class DumpError extends Error {}

/**
 * The tool error of a failure.
 * @param where - The chunk or the step.
 * @param cause - What went wrong.
 * @param correction - What to do.
 * @returns The error.
 */
const dumpError = (where: string, cause: string, correction: string): DumpError =>
  new DumpError(`${TOOL} failed ${where}: ${cause.replace(/[.\s]+$/, "")}. ${correction}`);

/** The correction of a broken journal, as the leader gives it. */
const REPAIR =
  "Repair the journal first: stop each bridge process, move the journal file aside and keep it for the auditor, then start the bridge again; a new chain then starts at the genesis hash. Tell the auditor.";

/**
 * Reads the test setting of the chunk size.
 * @returns The most entries one chunk returns.
 */
const chunkEntries = (): number => {
  const raw = process.env[CHUNK_ENTRIES_VARIABLE]?.trim();
  if (!raw) return DEFAULT_CHUNK_ENTRIES;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw dumpError(
      "before the first chunk",
      `${CHUNK_ENTRIES_VARIABLE} is "${raw}", but it must be an integer of 1 or more`,
      `Unset it to use ${DEFAULT_CHUNK_ENTRIES}, then restart the server.`
    );
  }
  return Number(raw);
};

/**
 * The hash of an entry: the SHA-256 of the canonical JSON of the entry
 * without `hash`, as UTF-8.
 * @param entry - The entry.
 * @returns 64 lowercase hexadecimal characters.
 */
export const journalEntryHash = (entry: Json): string => {
  const fields: Json = { ...entry };
  delete fields.hash;
  return sha256Hex(canonicalBytes(fields));
};

/**
 * Checks the chain of the fetched entries: `seq` from 1 with no gap, each
 * `prevHash`, each `hash` calculated again, and the last `hash` equal to the
 * pinned head.
 * @param entries - The entries, in the order fetched.
 * @param headHash - The head that the first chunk pinned.
 * @returns The cause of the first failure, or null.
 */
export const chainFailure = (entries: readonly unknown[], headHash: string): string | null => {
  let previous = GENESIS_HASH;
  for (const [index, entry] of entries.entries()) {
    const seq = index + 1;
    if (!isRecord(entry)) return `entry ${seq} is not an object`;
    if (entry.seq !== seq) return `entry ${seq} has the seq ${show(entry.seq)}`;
    if (entry.prevHash !== previous) {
      return seq === 1
        ? "the prevHash of entry 1 is not the genesis hash"
        : `the prevHash of entry ${seq} is not the hash of entry ${seq - 1}`;
    }
    if (typeof entry.hash !== "string" || journalEntryHash(entry) !== entry.hash) {
      return `the hash of entry ${seq} is not the SHA-256 of the entry without hash`;
    }
    previous = entry.hash;
  }
  if (previous !== headHash) {
    return `the hash of the last entry is ${previous}, not the pinned head ${headHash}`;
  }
  return null;
};

/**
 * Reads the identity of the instrument.
 * @param node - The node of this process.
 * @param where - The step, for the message.
 * @returns The identity report.
 */
const readIdentity = async (node: Node, where: string): Promise<IdentityReport> => {
  try {
    return await node.identityReport();
  } catch (err) {
    throw dumpError(
      where,
      `the identity of the bridge could not be read: ${errorMessage(err)}`,
      "Make sure that the leader runs, then call dump_journal again."
    );
  }
};

/**
 * Fetches each entry up to the count of the first chunk.
 * @param node - The node of this process.
 * @param maxEntries - The most entries one chunk returns.
 * @returns The entries, and the count and the head that the first chunk pinned.
 */
const fetchEntries = async (
  node: Node,
  maxEntries: number
): Promise<{ entries: Json[]; entryCount: number; headHash: string }> => {
  const entries: Json[] = [];
  let pinned: { entryCount: number; headHash: string } | null = null;
  let chunk = 0;
  do {
    chunk += 1;
    const where = `at chunk ${chunk}`;
    const params = {
      afterSeq: entries.length,
      throughSeq: pinned === null ? null : pinned.entryCount,
      maxEntries,
    };
    let answer: unknown;
    try {
      const response = await node.sendWithParams(CHUNK_REQUEST, undefined, params);
      if (response.error) throw new Error(response.error);
      answer = response.data;
    } catch (err) {
      throw dumpError(
        where,
        errorMessage(err),
        "Make sure that the leader runs and its journal is not broken, then call dump_journal again."
      );
    }

    const shapeError =
      !isRecord(answer) ||
      answer.status !== "ok" ||
      !isCount(answer.entryCount) ||
      typeof answer.headHash !== "string" ||
      !HASH_PATTERN.test(answer.headHash) ||
      !Array.isArray(answer.entries);
    if (shapeError) {
      throw dumpError(
        where,
        `the leader answered ${show(answer).slice(0, 200)}`,
        "The leader may run another build: restart the bridge processes from the current build, then call dump_journal again."
      );
    }
    const chunkAnswer = answer as {
      entryCount: number;
      headHash: string;
      entries: unknown[];
    };
    if (pinned === null) {
      pinned = { entryCount: chunkAnswer.entryCount, headHash: chunkAnswer.headHash };
    }
    const remaining = pinned.entryCount - entries.length;
    if (chunkAnswer.entries.length === 0 && remaining > 0) {
      throw dumpError(
        where,
        `the chunk holds no entry, but ${remaining} remain`,
        "Call dump_journal again."
      );
    }
    if (chunkAnswer.entries.length > remaining) {
      throw dumpError(
        where,
        `the chunk holds ${chunkAnswer.entries.length} entries, but only ${remaining} remain up to the pinned count ${pinned.entryCount}`,
        "Call dump_journal again."
      );
    }
    for (const entry of chunkAnswer.entries) entries.push(entry as Json);
  } while (entries.length < pinned.entryCount);

  return { entries, entryCount: pinned.entryCount, headHash: pinned.headHash };
};

/**
 * Runs one `dump_journal` call in this process.
 *
 * The steps: refuse a target that exists; read the identity of the
 * instrument; fetch the chunks up to the count of the first one; check the
 * chain; read the identity again and fail when the leader changed; write
 * `journal.json` and the manifest. A failure at any step removes each file of
 * the call.
 * @param node - The node of this process.
 * @param input - The parsed input. `fileKey` filters nothing.
 * @returns The manifest, which `manifest.json` also holds.
 */
export async function executeDumpJournal(
  node: Node,
  input: DumpJournalInput
): Promise<JournalManifest> {
  const startedAt = new Date();
  const outputPath = input.outputPath ?? `journal/${folderTimestamp(startedAt)}`;
  const maxEntries = chunkEntries();

  let evidence: EvidenceSet;
  try {
    evidence = await EvidenceSet.open(outputPath, [JOURNAL_FILE, MANIFEST_FILE]);
  } catch (err) {
    throw dumpError("before the first chunk", errorMessage(err), "No file was written.");
  }

  const before = await readIdentity(node, "before the first chunk");
  if (before.journal === null) {
    throw dumpError(
      "before the first chunk",
      "the leader reports no write journal, so it runs an older build",
      "Stop the leader process, then restart the bridge processes from the current build. No file was written."
    );
  }
  if (before.journal.status !== "ok") {
    throw dumpError(
      "before the first chunk",
      `the write journal of the leader is broken (${before.journal.reason ?? "no reason given"})`,
      `${REPAIR} No file was written.`
    );
  }

  try {
    const { entries, entryCount, headHash } = await fetchEntries(node, maxEntries);

    const failure = chainFailure(entries, headHash);
    if (failure !== null) {
      throw dumpError(
        "at the chain check",
        `the chain of the fetched entries does not hold: ${failure}`,
        `The journal file may have changed outside the leader. ${REPAIR}`
      );
    }

    const after = await readIdentity(node, "after the last chunk");
    if (after.leaderStartedAt !== before.leaderStartedAt) {
      throw dumpError(
        "after the last chunk",
        `the leader changed during the dump (leaderStartedAt ${before.leaderStartedAt} -> ${after.leaderStartedAt}), so a new leader served a part of it`,
        "Call dump_journal again."
      );
    }

    const written = await evidence.write(
      JOURNAL_FILE,
      canonicalBytes({ genesisHash: GENESIS_HASH, entries })
    );
    await evidence.publish();
    const manifest: JournalManifest = {
      tool: TOOL,
      bridgeCommit: before.bridgeCommit,
      leaderCommit: before.leaderCommit,
      leaderStartedAt: before.leaderStartedAt,
      outputRoot: evidence.realRoot,
      outputPath: await evidence.folder(),
      startedAt: utcTimestamp(startedAt),
      finishedAt: utcTimestamp(),
      entryCount,
      headHash,
      genesisHash: GENESIS_HASH,
      files: [
        {
          kind: "journal",
          path: written.path,
          sha256: written.sha256,
          bytes: written.bytes,
          entryCount,
        },
      ],
    };
    await evidence.write(MANIFEST_FILE, canonicalBytes(manifest));
    await evidence.publish();
    return manifest;
  } catch (err) {
    const message =
      err instanceof DumpError
        ? err.message
        : `${TOOL} failed while it wrote the files: ${errorMessage(err).replace(/[.\s]+$/, "")}. Correct the cause, then call dump_journal again.`;
    const remaining = await evidence.discard();
    throw new Error(
      remaining.length === 0
        ? `${message} No file of this call remains.`
        : `${message} These files of the call could not be removed and are not evidence: ${remaining.join(", ")}`
    );
  }
}

/**
 * Registers this area's tools.
 * @param server - The MCP server instance.
 * @param node - The node coordinator for leader/follower routing.
 */
export function register(server: McpServer, node: Node): void {
  server.tool(
    TOOL,
    "Dump the whole write journal of the leader to disk as evidence for an audit, and return only the manifest: the path, the SHA-256, the bytes, the entry count, the head hash, the bridge commit, and the leader start. The journal holds one entry for each write that the leader sent to a plugin, with its response, in a hash chain. journal.json is canonical JSON (sorted keys, no whitespace) of { genesisHash, entries }, each entry with all its fields, in seq order. The files go under the output root of this server process (FIGMA_BRIDGE_OUTPUT_ROOT, or its working directory when unset), in outputPath, which defaults to journal/<UTC time>. A file is never overwritten: a target that exists refuses the call before it reads anything. The dump reads the journal and adds no entry to it. It checks the chain of the entries it fetched; a chain that does not hold, a broken journal (the error gives the reason), or a leader that changes during the call fails it, and no file of the call remains. fileKey filters nothing: the journal covers each file, and a filter would break the chain.",
    dumpJournalInput.shape,
    async (args): Promise<ToolResult> => {
      const parsed = parseToolInput(dumpJournalInput, args);
      if (!parsed.success) return parsed.error;
      try {
        const manifest = await executeDumpJournal(node, parsed.data);
        return { content: [{ type: "text", text: canonicalJson(manifest) }] };
      } catch (err) {
        return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
      }
    }
  );
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
