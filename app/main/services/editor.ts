/**
 * Text-editor backend: owns the current file path + dirty state and does all
 * fs work (the CodeMirror renderer never touches the filesystem). Bridged to
 * app/renderer/editor/ over editor:toHost / editor:toWebview.
 *
 * Dirty-buffer guards: the editor view is only ever hidden (never reloaded),
 * so switching screens is non-destructive and needs no prompt. Prompts fire
 * on the two destructive paths — closing the window and opening another file
 * over unsaved changes.
 */
import { BaseWindow, dialog, ipcMain, WebContents } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EditorLanguage, EditorToHost, EditorToWebview } from "../ipc";

const FILE_FILTERS = [
  { name: "Text files", extensions: ["json", "py", "mdpa", "txt", "md", "dat", "csv", "yml", "yaml"] },
  { name: "All files", extensions: ["*"] },
];

function languageFor(fsPath: string): EditorLanguage {
  switch (path.extname(fsPath).toLowerCase()) {
    case ".json":
      return "json";
    case ".py":
      return "python";
    default:
      return "plain";
  }
}

export interface EditorDeps {
  webContents(): WebContents;
  getWindow(): BaseWindow;
  /** Show the editor screen (called after a successful open). */
  showEditor(): void;
  /** Update the shell title line for the editor view. */
  onTitle(fileName: string | null, dirty: boolean): void;
}

export class EditorService {
  private currentPath: string | null = null;
  private dirty = false;
  /** Last doc message — replayed on editorReady (page may load after open). */
  private lastDoc: EditorToWebview | null = null;
  /** A window close is waiting on the in-flight save. */
  private pendingClose = false;

  constructor(private readonly deps: EditorDeps) {
    ipcMain.on("editor:toHost", (event, raw) => {
      if (event.sender !== deps.webContents()) return;
      const msg = raw as EditorToHost;
      switch (msg.type) {
        case "editorReady":
          if (this.lastDoc) this.send(this.lastDoc);
          break;
        case "openFile":
          void this.open();
          break;
        case "saveContent":
          void this.save(msg.content, msg.saveAs);
          break;
        case "dirty":
          this.dirty = msg.dirty;
          this.title();
          break;
      }
    });
  }

  isDirty(): boolean {
    return this.dirty;
  }

  private send(message: EditorToWebview): void {
    const wc = this.deps.webContents();
    if (!wc.isDestroyed()) wc.send("editor:toWebview", message);
  }

  private title(): void {
    this.deps.onTitle(this.currentPath ? path.basename(this.currentPath) : null, this.dirty);
  }

  /** Pick a file and load it into the editor (guards unsaved changes). */
  async open(): Promise<void> {
    if (this.dirty) {
      const { response } = await dialog.showMessageBox(this.deps.getWindow(), {
        type: "warning",
        message: `Discard unsaved changes to ${this.currentPath ? path.basename(this.currentPath) : "the current file"}?`,
        buttons: ["Discard changes", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return;
    }
    const result = await dialog.showOpenDialog(this.deps.getWindow(), {
      title: "Open in Text Editor",
      filters: FILE_FILTERS,
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return;
    const fsPath = path.resolve(result.filePaths[0]);
    const content = await fs.promises.readFile(fsPath, "utf8");
    this.currentPath = fsPath;
    this.dirty = false;
    this.lastDoc = { type: "doc", path: fsPath, content, language: languageFor(fsPath) };
    this.send(this.lastDoc);
    this.deps.showEditor();
    this.title();
  }

  /** Asks the renderer for its buffer; save() runs when it answers. */
  requestSave(saveAs: boolean): void {
    this.send({ type: "requestSave", saveAs });
  }

  private async save(content: string, saveAs: boolean): Promise<void> {
    let target = this.currentPath;
    if (saveAs || !target) {
      const result = await dialog.showSaveDialog(this.deps.getWindow(), {
        title: "Save As",
        defaultPath: target ?? undefined,
        filters: FILE_FILTERS,
      });
      if (result.canceled || !result.filePath) {
        this.pendingClose = false; // user backed out of a save-then-close
        return;
      }
      target = path.resolve(result.filePath);
    }
    await fs.promises.writeFile(target, content, "utf8");
    this.currentPath = target;
    this.dirty = false;
    this.send({ type: "saved", path: target });
    this.title();
    if (this.pendingClose) {
      this.pendingClose = false;
      this.deps.getWindow().destroy();
    }
  }

  /** Window-close guard: Save / Don't Save / Cancel. Call on 'close'. */
  async confirmClose(): Promise<void> {
    const win = this.deps.getWindow();
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      message: `Save changes to ${this.currentPath ? path.basename(this.currentPath) : "the edited file"}?`,
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) {
      this.pendingClose = true;
      this.requestSave(false);
    } else if (response === 1) {
      win.destroy();
    }
  }
}
