/**
 * The project root: one answer to "where am I working", shared by the terminal's
 * cwd, every file dialog's starting folder, the assistant's context, and the
 * `vscode` shim's `workspaceFolders`.
 *
 * Two levels, deliberately distinguished:
 *
 * - **explicit** — chosen via File ▸ Open Folder… and persisted. This is the
 *   only one ever *shown* (toolbar chip, home screen) or handed to
 *   `workspaceFolders`. An inferred root would change every time the user
 *   switched tabs, which would make the indicator flicker, make the submodule's
 *   problemtype discovery flap, and — since the docs screenshots run the real
 *   app — bake a developer's absolute path into a committed PNG.
 * - **effective** — explicit, else the focused document's directory. This is
 *   what consumers actually use, so with no explicit root every one of them
 *   behaves exactly as it did before this concept existed.
 *
 * It is a default, never a fence: nothing here refuses a path outside the root.
 */
import * as fs from "node:fs";
import { stateStore } from "./stateStore";
import { parseProjectRoot, PROJECT_ROOT_KEY } from "./projectRootCore";

/** Supplies the focused document's directory (index.ts owns the tab registry).
 *  Mirrors configureNotifications' injection, keeping this module free of any
 *  dependency on the window/host maps. */
let activeFileDir: () => string | undefined = () => undefined;

export function configureProjectRoot(provider: () => string | undefined): void {
  activeFileDir = provider;
}

const listeners: (() => void)[] = [];

function write(root: string | undefined): void {
  void stateStore.update(PROJECT_ROOT_KEY, root);
  for (const listener of listeners) listener();
}

export const projectRoot = {
  /**
   * What the user chose, if it is still a directory. The only value that is
   * ever displayed or handed to the shim.
   *
   * A root that has been deleted or unmounted degrades to "none" for this read
   * but is deliberately **not erased** — a network share that is temporarily
   * away must not silently forget the setting.
   */
  explicit(): string | undefined {
    const stored = parseProjectRoot(stateStore.get(PROJECT_ROOT_KEY));
    if (!stored) return undefined;
    try {
      return fs.statSync(stored).isDirectory() ? stored : undefined;
    } catch {
      return undefined;
    }
  },

  /** Whether a root is stored at all, valid or not — so "Clear" stays available
   *  for a stale value the user can no longer see. */
  isSet(): boolean {
    return parseProjectRoot(stateStore.get(PROJECT_ROOT_KEY)) !== undefined;
  },

  /** What consumers use: the explicit root, else the focused document's folder. */
  effective(): string | undefined {
    return this.explicit() ?? activeFileDir();
  },

  set(dir: string): void {
    write(parseProjectRoot(dir));
  },

  clear(): void {
    write(undefined);
  },

  /** Fires after the explicit root changes — the menu template, the toolbar
   *  chip and the home screen all have to be rebuilt/re-pushed. */
  onDidChange(listener: () => void): void {
    listeners.push(listener);
  },
};
