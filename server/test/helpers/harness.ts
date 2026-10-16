/**
 * A test harness that runs real server processes against a simulated plugin.
 * It needs no Figma, and it never uses port 1995.
 *
 * Make one `Harness` for each test and call `cleanup()` after it, also after a
 * failure. Each resource the harness makes registers its own teardown, and
 * `cleanup()` runs them in reverse order: followers stop before the plugin,
 * and the plugin before the leader, so no follower takes over the port.
 *
 * Start order: the leader process first, then the simulated plugin, then the
 * followers.
 *
 * Each server process of one harness shares one install token file in a
 * temporary folder, so no test reads the real token file.
 */

import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerOptions, type ServerProcess } from "./server-process.js";
import { connectPlugin, type PluginOptions, type SimulatedPlugin } from "./plugin.js";

/** The port of the production bridge. The harness never uses it. */
const PRODUCTION_PORT = 1995;

export class Harness {
  private teardowns: Array<() => Promise<void>> = [];
  private tokenPath: string | undefined;

  /** Runs each teardown in reverse order. Collects errors and throws the first one. */
  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    while (this.teardowns.length > 0) {
      const teardown = this.teardowns.pop()!;
      try {
        await teardown();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) throw errors[0];
  }

  /** Registers a teardown that `cleanup()` runs. */
  defer(teardown: () => Promise<void>): void {
    this.teardowns.push(teardown);
  }

  /**
   * A free TCP port: listen on port 0, read the port, close.
   * @returns The port.
   */
  async freePort(): Promise<number> {
    for (;;) {
      const port = await new Promise<number>((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const address = probe.address();
          const found = typeof address === "object" && address !== null ? address.port : 0;
          probe.close(() => resolve(found));
        });
      });
      if (port !== 0 && port !== PRODUCTION_PORT) return port;
    }
  }

  /**
   * A new folder under the temporary folder of the system. Removed at cleanup.
   * @param label - A short name that shows in the folder name.
   * @returns The absolute path.
   */
  async tempDir(label = "dir"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `figma-bridge-test-${label}-`));
    this.defer(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  /**
   * A folder link: a junction on Windows, which needs no administrator right,
   * and a "dir" symbolic link elsewhere. Removed at cleanup, before its target.
   * @param target - The folder the link points to.
   * @param linkPath - Where the link goes.
   */
  async folderLink(target: string, linkPath: string): Promise<void> {
    await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    // Remove the link itself, not what it points to.
    this.defer(() => rm(linkPath, { force: true }));
  }

  /**
   * The token file of this harness, in a temporary folder. The first server
   * process makes the file.
   * @returns The absolute path.
   */
  async tokenFile(): Promise<string> {
    if (this.tokenPath === undefined) {
      this.tokenPath = join(await this.tempDir("token"), "rpc-token");
    }
    return this.tokenPath;
  }

  /**
   * The install token of this harness. A server process must have made the file.
   * @returns The token.
   */
  async token(): Promise<string> {
    return (await readFile(await this.tokenFile(), "utf8")).trim();
  }

  /**
   * Starts `node dist/index.js` and waits until it has a role. The process
   * gets the token file of this harness unless `options.env` names another.
   * @param options - Port, working directory, and environment changes.
   * @returns The running process.
   */
  async server(options: ServerOptions): Promise<ServerProcess> {
    const server = await startServer({
      ...options,
      env: { FIGMA_BRIDGE_TOKEN_FILE: await this.tokenFile(), ...options.env },
    });
    this.defer(() => server.close());
    return server;
  }

  /**
   * Connects a simulated plugin to the leader on `port`.
   * @param options - Port, file, and the request handlers.
   * @returns The connected plugin.
   */
  async plugin(options: PluginOptions): Promise<SimulatedPlugin> {
    const plugin = await connectPlugin(options);
    this.defer(() => plugin.close());
    return plugin;
  }
}
