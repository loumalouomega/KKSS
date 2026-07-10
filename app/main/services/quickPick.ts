/**
 * Modal picker window — the Electron replacement for vscode.window.
 * showQuickPick and showInputBox, backed by app/renderer/picker/.
 */
import { BrowserWindow, ipcMain } from "electron";
import * as path from "path";

export interface QuickPickItem {
  label: string;
  description?: string;
}

type PickerInit =
  | { kind: "pick"; title: string; items: QuickPickItem[] }
  | { kind: "input"; title: string; prompt?: string; value?: string; placeholder?: string };

type PickerReply =
  | { type: "picked"; index: number }
  | { type: "input"; value: string }
  | { type: "cancel" };

function openPicker(init: PickerInit, outDir: string): Promise<PickerReply | undefined> {
  return new Promise((resolve) => {
    const height = init.kind === "input" ? 150 : Math.min(420, 110 + init.items.length * 30);
    const win = new BrowserWindow({
      width: 460,
      height,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(outDir, "preload", "pickerPreload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    let settled = false;
    const finish = (reply: PickerReply | undefined) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("picker:toHost", onMessage);
      if (!win.isDestroyed()) win.close();
      resolve(reply);
    };

    const onMessage = (event: Electron.IpcMainEvent, reply: PickerReply) => {
      if (event.sender !== win.webContents) return;
      finish(reply);
    };
    ipcMain.on("picker:toHost", onMessage);
    win.on("closed", () => finish(undefined));

    win.webContents.once("did-finish-load", () => {
      win.webContents.send("picker:init", init);
    });
    void win.loadURL("kkss://app/renderer/picker/picker.html");
  });
}

let pickerOutDir = "";
export function configurePicker(outDir: string): void {
  pickerOutDir = outDir;
}

export async function showQuickPick<T extends QuickPickItem>(
  items: T[],
  options: { placeHolder?: string; title?: string }
): Promise<T | undefined> {
  const reply = await openPicker(
    { kind: "pick", title: options.title ?? options.placeHolder ?? "Select", items },
    pickerOutDir
  );
  if (reply && reply.type === "picked" && items[reply.index]) return items[reply.index];
  return undefined;
}

export async function showInputBox(options: {
  title?: string;
  prompt?: string;
  value?: string;
  placeHolder?: string;
}): Promise<string | undefined> {
  const reply = await openPicker(
    {
      kind: "input",
      title: options.title ?? "Input",
      prompt: options.prompt,
      value: options.value,
      placeholder: options.placeHolder,
    },
    pickerOutDir
  );
  return reply && reply.type === "input" ? reply.value : undefined;
}
