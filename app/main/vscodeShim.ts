/**
 * Minimal `vscode` module shim, substituted for the real API at bundle time
 * (esbuild alias, main bundle only). It implements exactly the API surface the
 * mesh submodule's host-side code touches at runtime when driven by KKSS:
 *
 *   mesh/src/meshExport.ts       — window.show{Open,Save}Dialog, window.showQuickPick
 *                                  (exportSkin, reached from Advanced ▸ Export skin…
 *                                  with no pre-chosen format), show*Message,
 *                                  Uri.file, commands.executeCommand("vscode.openWith")
 *   mesh/src/opHistory.ts        — same dialog/message surface
 *   mesh/src/*EditorProvider     — workspace.createFileSystemWatcher(RelativePattern),
 *                                  window.withProgress, Uri.joinPath, globalState
 *                                  (via the fake ExtensionContext in meshHost.ts),
 *                                  workspace.getConfiguration("kratos.flowgraph")
 *   mesh/src/flowgraphController — workspace.getConfiguration, Uri.parse (non-file
 *                                  URIs), env.asExternalUri (identity — no
 *                                  Remote-SSH/tunnel in KKSS)
 *   mesh/src/ptController.ts     — workspace.openTextDocument + window.showTextDocument
 *                                  (routed to the app's own text-editor screen),
 *                                  workspace.workspaceFolders,
 *                                  commands.executeCommand("kratos.vtk.openLatestResults")
 *   mesh/src/runManager.ts       — EventEmitter, Disposable, window.createOutputChannel,
 *                                  context.workspaceState (see mesh/meshHost.ts),
 *                                  commands.executeCommand("setContext")
 *
 * mesh/src/runTreeView.ts is deliberately NOT served: it is reachable only from
 * the submodule's own activate(), which KKSS never calls (meshHost.ts constructs
 * the providers directly), so createTreeView/TreeItem/ThemeIcon/MarkdownString
 * stay out of the bundle. KKSS surfaces runs through its native menu instead.
 *
 * Anything else throws loudly so a submodule update that starts using a new
 * API fails visibly instead of silently misbehaving.
 */
import { app, dialog, shell } from "electron";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { showOpenDialog as electronOpen, showSaveDialog as electronSave, FileFilter } from "./services/dialogs";
import { showQuickPick as electronQuickPick, QuickPickItem } from "./services/quickPick";
import { toast, progressToast } from "./services/notifications";
import { createFileSystemWatcher } from "./services/watcher";

// ---- Hooks the app injects (avoids import cycles) ---------------------------

export interface VscodeShimHooks {
  /** Implements the "vscode.openWith" command (routes into cad/mesh views). */
  openWith(fsPath: string, viewType: string): void;
  /** Implements the openTextDocument/showTextDocument "reveal a file" flow. */
  openTextDocument(fsPath: string): void;
  /**
   * Implements "kratos.vtk.openLatestResults" — since mesh 3.8.0 this command
   * is the *only* path behind PtController.openResults(), so it cannot throw.
   */
  openLatestResults(caseDir: string, options?: { excludeNewest?: boolean }): void;
}

let hooks: VscodeShimHooks = {
  openWith: () => {
    throw new Error("vscodeShim: hooks not configured");
  },
  openTextDocument: () => {
    throw new Error("vscodeShim: hooks not configured");
  },
  openLatestResults: () => {
    throw new Error("vscodeShim: hooks not configured");
  },
};

export function __configureVscodeShim(h: VscodeShimHooks): void {
  hooks = h;
}

// ---- Uri ---------------------------------------------------------------------

export class Uri {
  private constructor(
    private readonly raw: string,
    private readonly isFileUri: boolean
  ) {}

  get fsPath(): string {
    if (!this.isFileUri) throw new Error("vscodeShim: fsPath is only valid for file:// URIs");
    return this.raw;
  }

  /** Posix-style path, mirroring vscode.Uri.path usage in the providers. */
  get path(): string {
    return this.fsPath.split(nodePath.sep).join("/");
  }

  /** e.g. "http" for a parsed non-file URI, "file" for a file URI. */
  get scheme(): string {
    if (this.isFileUri) return "file";
    return /^([a-z][a-z0-9+.-]*):/i.exec(this.raw)?.[1] ?? "";
  }

  /** e.g. "127.0.0.1:5173" for a parsed non-file URI. */
  get authority(): string {
    if (this.isFileUri) return "";
    return /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(this.raw)?.[1] ?? "";
  }

  static file(p: string): Uri {
    return new Uri(p, true);
  }

  /** Non-file URIs only (e.g. the localhost URL flowgraphController forks). */
  static parse(value: string): Uri {
    return new Uri(value, false);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(nodePath.join(base.fsPath, ...segments), true);
  }

  toString(): string {
    return this.isFileUri ? `file://${this.path}` : this.raw;
  }
}

export class TextDocument {
  constructor(public readonly uri: Uri) {}
}

// ---- EventEmitter / Disposable ------------------------------------------------

export interface Disposable {
  dispose(): void;
}

export const Disposable = {
  from(...items: Disposable[]): Disposable {
    return {
      dispose() {
        for (const item of items) item.dispose();
      },
    };
  },
};

/**
 * vscode.EventEmitter. mesh 3.8.0's RunManager exposes its registry changes
 * this way (`onDidChange`), and PtController subscribes to drive its status
 * line, so the listener list has to be real — not a no-op.
 */
export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    // Copied first: a listener may dispose itself (or a sibling) while firing.
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
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

/**
 * KKSS has one panel per mode (see CLAUDE.md's "one document per mode"
 * invariant), so there is no split-editor equivalent — values exist only so
 * `vscode.ViewColumn.Beside` (ptController.ts's openResults) doesn't throw;
 * commands.executeCommand("vscode.openWith") ignores the column argument.
 */
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
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
    canSelectFiles?: boolean;
    canSelectFolders?: boolean;
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
      // mesh 3.4.0's Merge mesh takes N files; 3.8.0's PNG frame-sequence
      // export picks a folder.
      canSelectMany: options.canSelectMany,
      canSelectFolders: options.canSelectFolders,
    });
    return picked ? picked.map((p) => Uri.file(p)) : undefined;
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

  /**
   * The modal picker window (services/quickPick.ts) the app already uses for
   * cad's export targets and the mesh Export menu. vscode resolves to the
   * picked item itself, so callers read back their own extra properties
   * (meshExport's exportSkin uses `description` to carry the extension).
   */
  showQuickPick: async <T extends QuickPickItem>(
    items: T[],
    options?: { title?: string; placeHolder?: string }
  ): Promise<T | undefined> =>
    electronQuickPick(items, { title: options?.title, placeHolder: options?.placeHolder }),

  showInformationMessage: (message: string, ...rest: unknown[]) => showMessage("info", message, rest),
  showWarningMessage: (message: string, ...rest: unknown[]) => showMessage("warning", message, rest),
  showErrorMessage: (message: string, ...rest: unknown[]) => showMessage("error", message, rest),

  /** Reveals a generated file — routed to the app's own text-editor screen. */
  showTextDocument: async (doc: TextDocument, _options?: unknown): Promise<void> => {
    hooks.openTextDocument(doc.uri.fsPath);
  },

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

  /**
   * Where a spawned solver's stdout goes (mesh 3.8.0's RunManager, which is on
   * the default `kratos.run.launchMode: "output"` path). KKSS has no Output
   * panel, so the channel keeps a capped buffer and mirrors to the host
   * console; `show()` writes the buffer to a file and opens it in the app's own
   * text editor, which is the closest equivalent the app has.
   */
  createOutputChannel: (name: string) => new OutputChannel(name),

  /**
   * Only reachable via `kratos.run.launchMode: "terminal"`, and
   * `workspace.getConfiguration` always resolves to the schema default
   * ("output"), so this is dead code in KKSS today. It throws rather than
   * no-oping so that changing the default surfaces here instead of silently
   * starting a solver nothing is watching.
   */
  createTerminal: (_options: unknown): never => {
    throw new Error(
      'vscodeShim: window.createTerminal is not supported — KKSS runs solvers via kratos.run.launchMode "output"'
    );
  },
};

/** Backing type for `window.createOutputChannel`. */
class OutputChannel {
  private static readonly MAX_LINES = 5000;
  private readonly lines: string[] = [];

  constructor(readonly name: string) {}

  append(value: string): void {
    this.push(value, false);
  }

  appendLine(value: string): void {
    this.push(value, true);
  }

  private push(value: string, newline: boolean): void {
    console.log(`[${this.name}] ${value}`);
    if (!newline && this.lines.length > 0) this.lines[this.lines.length - 1] += value;
    else this.lines.push(value);
    if (this.lines.length > OutputChannel.MAX_LINES) {
      this.lines.splice(0, this.lines.length - OutputChannel.MAX_LINES);
    }
  }

  clear(): void {
    this.lines.length = 0;
  }

  show(_preserveFocus?: boolean): void {
    const file = nodePath.join(
      app.getPath("logs"),
      `${this.name.replace(/[^A-Za-z0-9._-]+/g, "_")}.log`
    );
    try {
      fs.mkdirSync(nodePath.dirname(file), { recursive: true });
      fs.writeFileSync(file, this.lines.join("\n"), "utf8");
      hooks.openTextDocument(file);
    } catch (err) {
      toast("error", `Could not open ${this.name} output: ${String(err)}`);
    }
  }

  hide(): void {}

  dispose(): void {
    this.lines.length = 0;
  }
}

// ---- workspace -----------------------------------------------------------------

export const workspace = {
  createFileSystemWatcher: (pattern: RelativePattern) => {
    const watcher = createFileSystemWatcher(pattern.base, pattern.pattern);
    return {
      onDidChange: (cb: (uri: Uri) => void) => watcher.onDidChange((p) => cb(Uri.file(p))),
      onDidCreate: (cb: (uri: Uri) => void) => watcher.onDidCreate((p) => cb(Uri.file(p))),
      onDidDelete: (cb: (uri: Uri) => void) => watcher.onDidDelete((p) => cb(Uri.file(p))),
      dispose: () => watcher.dispose(),
    };
  },

  /**
   * KKSS opens files, not folders — ptController reads this only to resolve
   * `kratos.problemtypes.extraPaths` relative to a workspace, and treats
   * undefined as "none". mesh's own `?? []` handles it.
   */
  workspaceFolders: undefined as undefined | { uri: Uri }[],

  /**
   * mesh 3.2.0's mdpa provider re-parses when the file is saved in a text
   * editor. KKSS's editor writes through the filesystem, so the chokidar
   * watcher above already fires onDidChange for exactly that case — this stays
   * a no-op rather than double-triggering a re-parse for every save.
   */
  onDidSaveTextDocument: (_cb: (doc: TextDocument) => void): Disposable => ({ dispose() {} }),

  /**
   * KKSS has no settings.json equivalent for extension contribution points,
   * so this always resolves to the caller-supplied default — i.e. the same
   * schema default declared in the submodule's package.json.
   */
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  }),

  openTextDocument: async (pathOrUri: string | Uri): Promise<TextDocument> => {
    return new TextDocument(typeof pathOrUri === "string" ? Uri.file(pathOrUri) : pathOrUri);
  },
};

// ---- env ---------------------------------------------------------------------

export const env = {
  /** Identity — KKSS has no Remote-SSH/Codespaces tunnel to resolve through. */
  asExternalUri: async (uri: Uri): Promise<Uri> => uri,
};

// ---- commands -------------------------------------------------------------------

export const commands = {
  executeCommand: async (command: string, ...args: unknown[]): Promise<void> => {
    switch (command) {
      case "vscode.openWith": {
        const uri = args[0] as Uri;
        hooks.openWith(uri.fsPath, String(args[1] ?? ""));
        return;
      }
      // RunManager.changed() fires this on every registry mutation to gate the
      // "Kratos Runs" view's `when` clause. KKSS has no such view, so the
      // context key has nothing to drive — but it must not throw on a hot path.
      case "setContext":
        return;
      case "revealInExplorer": {
        const uri = args[0] as Uri;
        shell.showItemInFolder(uri.fsPath);
        return;
      }
      // Since mesh 3.8.0 this is the only path behind PtController.openResults().
      case "kratos.vtk.openLatestResults": {
        const caseDir = String(args[0] ?? "");
        const options = args[1] as { excludeNewest?: boolean } | undefined;
        hooks.openLatestResults(caseDir, options);
        return;
      }
      default:
        throw new Error(`vscodeShim: unsupported command "${command}"`);
    }
  },
};
