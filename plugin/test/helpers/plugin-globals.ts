/**
 * The globals that `plugin/src/main/code.ts` reads when it is imported, a
 * small mutable fake of `figma`, and the imported module.
 *
 * Import this module before anything else that imports `code.ts`. It installs
 * `__html__`, `__PLUGIN_BUILD__` and the fake, imports `code.ts`, and waits
 * one time for what the top-level code of `code.ts` starts: `showUI`, the
 * `clientStorage` chain that ends with `figma.ui.show()`, and `sendStatus`.
 * Without that wait a callback of the chain can run after another test file
 * deleted `globalThis.figma`, and bun reports an unhandled error.
 *
 * A test calls `resetFakeFigma` first, then adds the API members it needs to
 * the fake, for example `getNodeByIdAsync`. The reset removes them again.
 */

export type FakeFigma = {
  editorType: "figma" | "dev" | "figjam" | "slides";
  fileKey: string;
  root: { name: string; children: unknown[] };
  currentPage: { id: string; name: string; selection: unknown[] };
  /** Each message that the main code posted to the plugin window, in order. */
  posted: unknown[];
  /** How many times `commitUndo` ran. */
  undoCommits: number;
  commitUndo: () => void;
  showUI: (html: string, options?: unknown) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  ui: {
    onmessage: unknown;
    postMessage: (message: unknown) => void;
    resize: (width: number, height: number) => void;
    show: () => void;
  };
  clientStorage: {
    getAsync: (key: string) => Promise<unknown>;
    setAsync: (key: string, value: unknown) => Promise<void>;
  };
  [member: string]: unknown;
};

const globals = globalThis as unknown as Record<string, unknown>;

let markShown: () => void = () => undefined;
const shown = new Promise<void>((resolve) => {
  markShown = resolve;
});

export const fakeFigma: FakeFigma = {
  editorType: "figma",
  // A key, so code.ts does not warn about a fallback key.
  fileKey: "test-file-key",
  root: { name: "Test file", children: [] },
  currentPage: { id: "0:1", name: "Test page", selection: [] },
  posted: [],
  undoCommits: 0,
  commitUndo: () => {
    fakeFigma.undoCommits++;
  },
  showUI: () => undefined,
  on: () => undefined,
  ui: {
    onmessage: undefined,
    postMessage: (message) => {
      fakeFigma.posted.push(message);
    },
    resize: () => undefined,
    show: () => markShown(),
  },
  clientStorage: {
    getAsync: async () => undefined,
    setAsync: async () => undefined,
  },
};

/** The members of the fake itself, as they start. A reset puts them back and removes each other member. */
const OWN_MEMBERS: Record<string, unknown> = { ...fakeFigma };

globals.__html__ = "<html><body>test</body></html>";
globals.__PLUGIN_BUILD__ = "test-build";
globals.figma = fakeFigma;

export const pluginMain = await import("../../src/main/code");

// The clientStorage chain of code.ts ends with figma.ui.show().
await shown;

/**
 * Installs the fake again, and clears what an earlier test left in it:
 * another test file can replace `globalThis.figma` with its own fake. The
 * members of the fake go back to their start (a test that changes a member
 * inside `ui` or `clientStorage` puts it back itself).
 * @returns The fake.
 */
export const resetFakeFigma = (): FakeFigma => {
  for (const member of Object.keys(fakeFigma)) {
    if (!(member in OWN_MEMBERS)) delete fakeFigma[member];
  }
  Object.assign(fakeFigma, OWN_MEMBERS);
  fakeFigma.posted.length = 0;
  fakeFigma.undoCommits = 0;
  globals.figma = fakeFigma;
  return fakeFigma;
};

/**
 * Waits until the check is true. The queue of the plugin answers in later
 * turns of the event loop.
 * @param what - What the test waits for, for the error.
 * @param check - The condition.
 */
export const waitUntil = async (what: string, check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out while waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** The answers to server requests that the main code posted, in order. */
export const answers = (): Array<{ requestId: string; data?: unknown; error?: string }> =>
  fakeFigma.posted.filter(
    (message): message is { requestId: string; data?: unknown; error?: string } =>
      typeof message === "object" && message !== null && "requestId" in message
  );
