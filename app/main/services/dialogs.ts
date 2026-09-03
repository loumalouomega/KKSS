/** Electron replacements for vscode.window.showOpenDialog / showSaveDialog. */
import { dialog } from "electron";

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
    defaultPath: options.defaultPath,
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
    defaultPath: options.defaultPath,
    filters: options.filters,
  });
  return result.canceled || !result.filePath ? undefined : result.filePath;
}
