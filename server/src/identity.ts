/**
 * The identity of the instrument that serves a call: the build of the serving
 * process, the build of the leader, and the plugin build and the epoch of a
 * file. A manifest records one `FileIdentity`.
 *
 * This module imports no `schema.ts`, no `tools.ts`, and no module that does,
 * so that an extension file can import it. A caller gives the report source as
 * an argument: `Node` is one.
 */

import type { ConnectedFile, FileIdentity, IdentityReport } from "./types.js";

/** Anything that can report the identity: the `Node` of a leader or a follower. */
export interface IdentitySource {
  identityReport(): Promise<IdentityReport>;
}

function describeFiles(files: ConnectedFile[]): string {
  return files.map((f) => `"${f.fileName}" (fileKey: ${f.fileKey})`).join(", ");
}

/**
 * Picks the file a call targets.
 * - With `fileKey`, that file.
 * - With no `fileKey` and exactly one file, that file.
 * - Else it throws, with a message that names the connected files.
 * @param files - The connected files.
 * @param fileKey - The key the caller gave, if any.
 * @returns The file.
 */
export function selectFile(files: ConnectedFile[], fileKey?: string): ConnectedFile {
  if (fileKey) {
    const file = files.find((f) => f.fileKey === fileKey);
    if (!file) {
      const hint =
        files.length > 0
          ? ` Connected files: ${describeFiles(files)}`
          : " No files are currently connected.";
      throw new Error(`No plugin connected for fileKey "${fileKey}".${hint}`);
    }
    return file;
  }

  if (files.length === 0) {
    throw new Error("No plugin connected. Open a Figma file and run the bridge plugin.");
  }

  if (files.length === 1) return files[0];

  throw new Error(
    `Multiple files connected. Specify a fileKey to choose which file to query. Connected files: ${describeFiles(files)}. Use the list_files tool to see all connected files.`
  );
}

/**
 * The identity of one file in a report.
 * @param report - The report of the serving process.
 * @param fileKey - The key of the file. Optional when exactly one file is connected.
 * @returns The identity.
 * @throws If no file matches, or the key is missing and the count is not one.
 */
export function fileIdentity(report: IdentityReport, fileKey?: string): FileIdentity {
  const file = selectFile(report.files, fileKey);
  return {
    fileKey: file.fileKey,
    fileName: file.fileName,
    pluginBuild: file.pluginBuild,
    epoch: file.epoch,
    bridgeCommit: report.bridgeCommit,
    leaderCommit: report.leaderCommit,
    leaderStartedAt: report.leaderStartedAt,
  };
}

/**
 * Reads the report from the source, then the identity of one file. The same
 * call serves a leader and a follower.
 * @param source - The `Node` of the serving process.
 * @param fileKey - The key of the file. Optional when exactly one file is connected.
 * @returns The identity.
 * @throws If the leader is not reachable, or `fileIdentity` throws.
 */
export async function resolveFileIdentity(
  source: IdentitySource,
  fileKey?: string
): Promise<FileIdentity> {
  return fileIdentity(await source.identityReport(), fileKey);
}
