/**
 * vscode `globalState` replacement: a JSON file in Electron's userData dir.
 * Used for the mesh extension's persisted keys (sceneTheme, overwrite-warned).
 */
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

let file: string | undefined;
let data: Record<string, unknown> | undefined;

function load(): Record<string, unknown> {
  if (data) return data;
  file = path.join(app.getPath("userData"), "state.json");
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return data;
}

export const stateStore = {
  get<T>(key: string, defaultValue?: T): T | undefined {
    const value = load()[key];
    return value === undefined ? defaultValue : (value as T);
  },
  async update(key: string, value: unknown): Promise<void> {
    const store = load();
    if (value === undefined) delete store[key];
    else store[key] = value;
    await fs.promises.mkdir(path.dirname(file!), { recursive: true });
    await fs.promises.writeFile(file!, JSON.stringify(store, null, 2), "utf8");
  },
};
