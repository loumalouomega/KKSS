/**
 * Minimal `vscode` module shim, substituted for the real API at bundle time
 * (esbuild alias, main bundle only). It implements exactly the API surface the
 * mesh submodule's host-side code touches at runtime when driven by KKSS:
 *
 *   mesh/src/meshExport.ts   — window.show{Open,Save}Dialog, show*Message,
 *                              Uri.file, commands.executeCommand("vscode.openWith")
 *   mesh/src/opHistory.ts    — same dialog/message surface
 *   mesh/src/*EditorProvider — workspace.createFileSystemWatcher(RelativePattern),
 *                              window.withProgress, Uri.joinPath, globalState
 *                              (via the fake ExtensionContext in meshHost.ts)
 *
 * Anything else throws loudly so a submodule update that starts using a new
 * API fails visibly instead of silently misbehaving.
 */
import { dialog } from "electron";
import * as nodePath from "node:path";
import { showOpenDialog as electronOpen, showSaveDialog as electronSave, FileFilter } from "./services/dialogs";
import { toast, progressToast } from "./services/notifications";
import { createFileSystemWatcher } from "./services/watcher";

// ---- Hooks the app injects (avoids import cycles) ---------------------------

export interface VscodeShimHooks {
  /** Implements the "vscode.openWith" command (routes into cad/mesh views). */
  openWith(fsPath: string, viewType: string): void;
}

let hooks: VscodeShimHooks = {
  openWith: () => {
    throw new Error("vscodeShim: hooks not configured");
  },
};

export function __configureVscodeShim(h: VscodeShimHooks): void {
  hooks = h;
}

// ---- Uri ---------------------------------------------------------------------

export class Uri {
  private constructor(public readonly fsPath: string) {}

  /** Posix-style path, mirroring vscode.Uri.path usage in the providers. */
  get path(): string {
    return this.fsPath.split(nodePath.sep).join("/");
  }

  static file(p: string): Uri {
    return new Uri(p);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(nodePath.join(base.fsPath, ...segments));
  }

  toString(): string {
    return `file://${this.path}`;
  }
}

export class RelativePattern {
  constructor(
    public readonly base: string,
    public readonly pattern: string
  ) {}
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

// ---- window ------------------------------------------------------------------

function convertFilters(filters: Record<string, string[]> | undefined): FileFilter[] | undefined {
  if (!filters) return undefined;
  return Object.entries(filters).map(([name, extensions]) => ({ name, extensions }));
}

/**
 * show*Message: with action items → a real (blocking) native message box so
 * the caller gets an answer (e.g. meshExport's one-time overwrite warning);
 * without items → a shell toast.
 */
async function showMessage(
  kind: "info" | "warning" | "error",
  message: string,
  rest: unknown[]
): Promise<string | undefined> {
  const items = rest.filter((r): r is string => typeof r === "string");
  if (items.length === 0) {
    toast(kind, message);
    return undefined;
  }
  const type = kind === "info" ? "info" : kind === "warning" ? "warning" : "error";
  const result = await dialog.showMessageBox({
    type,
    message,
    buttons: [...items, "Cancel"],
    cancelId: items.length,
    defaultId: 0,
  });
  return result.response < items.length ? items[result.response] : undefined;
}

interface ProgressOptions {
  location?: unknown;
  title?: string;
  cancellable?: boolean;
}
interface CancellationTokenLike {
  isCancellationRequested: boolean;
  onCancellationRequested(cb: () => void): { dispose(): void };
}

export const window = {
  showOpenDialog: async (options: {
    canSelectMany?: boolean;
    filters?: Record<string, string[]>;
    title?: string;
    openLabel?: string;
    defaultUri?: Uri;
  }): Promise<Uri[] | undefined> => {
    const picked = await electronOpen({
      title: options.title,
      openLabel: options.openLabel,
      filters: convertFilters(options.filters),
      defaultPath: options.defaultUri?.fsPath,
    });
    return picked ? [Uri.file(picked)] : undefined;
  },

  showSaveDialog: async (options: {
    defaultUri?: Uri;
    filters?: Record<string, string[]>;
    title?: string;
  }): Promise<Uri | undefined> => {
    const picked = await electronSave({
      title: options.title,
      defaultPath: options.defaultUri?.fsPath,
      filters: convertFilters(options.filters),
    });
    return picked ? Uri.file(picked) : undefined;
  },

  showInformationMessage: (message: string, ...rest: unknown[]) => showMessage("info", message, rest),
  showWarningMessage: (message: string, ...rest: unknown[]) => showMessage("warning", message, rest),
  showErrorMessage: (message: string, ...rest: unknown[]) => showMessage("error", message, rest),

  withProgress: async <R>(
    options: ProgressOptions,
    task: (progress: { report(value: { message?: string }): void }, token: CancellationTokenLike) => Promise<R>
  ): Promise<R> => {
    const prog = progressToast(options.title ?? "Working…", !!options.cancellable);
    const cancelCbs: Array<() => void> = [];
    const token: CancellationTokenLike = {
      isCancellationRequested: false,
      onCancellationRequested(cb: () => void) {
        cancelCbs.push(cb);
        return { dispose() {} };
      },
    };
    prog.onCancel(() => {
      token.isCancellationRequested = true;
      for (const cb of cancelCbs) cb();
    });
    try {
      return await task({ report: (v) => prog.report(v.message ?? "") }, token);
    } finally {
      prog.done();
    }
  },
};

// ---- workspace -----------------------------------------------------------------

export const workspace = {
  createFileSystemWatcher: (pattern: RelativePattern) => {
    const watcher = createFileSystemWatcher(pattern.base, pattern.pattern);
    return {
      onDidChange: (cb: (uri: Uri) => void) => watcher.onDidChange((p) => cb(Uri.file(p))),
      onDidCreate: (cb: (uri: Uri) => void) => watcher.onDidCreate((p) => cb(Uri.file(p))),
      onDidDelete: (_cb: (uri: Uri) => void) => ({ dispose() {} }),
      dispose: () => watcher.dispose(),
    };
  },
};

// ---- commands -------------------------------------------------------------------

export const commands = {
  executeCommand: async (command: string, ...args: unknown[]): Promise<void> => {
    if (command === "vscode.openWith") {
      const uri = args[0] as Uri;
      hooks.openWith(uri.fsPath, String(args[1] ?? ""));
      return;
    }
    throw new Error(`vscodeShim: unsupported command "${command}"`);
  },
};
