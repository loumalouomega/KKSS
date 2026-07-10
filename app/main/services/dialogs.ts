/** Electron replacements for vscode.window.showOpenDialog / showSaveDialog. */
import { dialog } from "electron";

export interface FileFilter {
  name: string;
  extensions: string[];
}

export async function showOpenDialog(options: {
  title?: string;
  openLabel?: string;
  filters?: FileFilter[];
  defaultPath?: string;
}): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: options.title,
    buttonLabel: options.openLabel,
    filters: options.filters,
    defaultPath: options.defaultPath,
    properties: ["openFile"],
  });
  return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths[0];
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
