/**
 * App-wide appearance: UI theme, fonts, editor and terminal options.
 *
 * Every preload imports app/preload/appearance.ts, which fetches the snapshot
 * synchronously (`kkss:appearance`, so the first paint already has the right
 * palette) and applies it to its page; this module then re-broadcasts it to
 * every webContents on any relevant stateStore change or OS theme change.
 * Broadcasting over `webContents.getAllWebContents()` rather than the tab
 * registry is deliberate: it also reaches the About/What's New/picker/Settings
 * BrowserWindows and any tab created mid-change, with no list to keep in sync.
 */
import { BaseWindow, ipcMain, nativeTheme, webContents } from "electron";
import { stateStore } from "./stateStore";
import { entryById, effective, type UiThemeSetting } from "./settings/registry";
import {
  appearanceStoreKeys,
  buildAppearance,
  themeSourceFor,
  WINDOW_BACKGROUND,
  type Appearance,
} from "./appearanceCore";

export const APPEARANCE_CHANNEL = "kkss:appearance";

function uiThemeSetting(): UiThemeSetting {
  const entry = entryById("appearance.uiTheme")!;
  return effective(entry, stateStore.get(entry.storeKey!)) as UiThemeSetting;
}

export function currentAppearance(): Appearance {
  return buildAppearance((key) => stateStore.get(key), {
    dark: nativeTheme.shouldUseDarkColors,
    highContrast: nativeTheme.shouldUseHighContrastColors,
  });
}

function broadcast(): void {
  const snapshot = currentAppearance();
  for (const win of BaseWindow.getAllWindows()) win.setBackgroundColor(WINDOW_BACKGROUND[snapshot.kind]);
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send(APPEARANCE_CHANNEL, snapshot);
  }
}

/** Call once, before the first window is created. */
export function configureAppearance(): void {
  nativeTheme.themeSource = themeSourceFor(uiThemeSetting());
  ipcMain.on(APPEARANCE_CHANNEL, (event) => {
    event.returnValue = currentAppearance();
  });
  const keys = appearanceStoreKeys();
  stateStore.onDidChange((key) => {
    if (!keys.has(key)) return;
    if (key === entryById("appearance.uiTheme")!.storeKey) {
      // Setting themeSource fires `updated` itself when the resolved colours
      // change — but not when they don't (dark → hcDark on a dark OS), so the
      // broadcast below is unconditional and `updated` merely re-sends.
      nativeTheme.themeSource = themeSourceFor(uiThemeSetting());
    }
    broadcast();
  });
  // Follow-system: the OS switching light/dark or high contrast.
  nativeTheme.on("updated", broadcast);
}

/** The BaseWindow background for the current theme (createMainWindow). */
export function windowBackground(): string {
  return WINDOW_BACKGROUND[currentAppearance().kind];
}
