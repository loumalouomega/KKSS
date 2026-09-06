/**
 * Electron replacements for vscode.window.showOpenDialog / showSaveDialog.
 *
 * This is the single choke point for both engines' dialogs: cadHost calls these
 * directly, and every mesh dialog reaches them too, because esbuild aliases
 * `vscode` to vscodeShim.ts, whose showOpenDialog/showSaveDialog funnel
 * `defaultUri` through here. So the project-root default below covers the
 * submodules without touching them. (`services/editor.ts` is the one exception
 * — it calls Electron's dialog directly and applies the same default itself.)
 */
import { dialog } from "electron";
import { projectRoot } from "./projectRoot";

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  openLabel?: string;
  filters?: FileFilter[];
  defaultPath?: string;
  /** vscode.OpenDialogOptions.canSelectMany — mesh's multi-file Merge mesh. */
  canSelectMany?: boolean;
  /** vscode.OpenDialogOptions.canSelectFolders — mesh's PNG frame-sequence export. */
  canSelectFolders?: boolean;
}

/**
 * Returns every picked path. `canSelectFolders` swaps the file picker for a
 * directory picker (vscode allows both at once, but Electron's `openFile` +
 * `openDirectory` combination is unsupported on Windows, and no caller needs
 * it), and without `canSelectMany` the result is at most one entry.
 */
export async function showOpenDialog(options: OpenDialogOptions): Promise<string[] | undefined> {
  const properties: Array<"openFile" | "openDirectory" | "multiSelections"> = [
    options.canSelectFolders ? "openDirectory" : "openFile",
  ];
  if (options.canSelectMany) properties.push("multiSelections");
  const result = await dialog.showOpenDialog({
    title: options.title,
    buttonLabel: options.openLabel,
    filters: options.filters,
    // A caller that knows better always wins — mesh's save/export dialogs pass a
    // document-relative path, and those must not be re-rooted. The project root
    // only fills the gap where a dialog would otherwise open wherever the OS
    // last left it.
    defaultPath: options.defaultPath ?? projectRoot.effective(),
    properties,
  });
  return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths;
}

export async function showSaveDialog(options: {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}): Promise<string | undefined> {
  const result = await dialog.showSaveDialog({
    title: options.title,
    defaultPath: options.defaultPath ?? projectRoot.effective(),
    filters: options.filters,
  });
  return result.canceled || !result.filePath ? undefined : result.filePath;
}
