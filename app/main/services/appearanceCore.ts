/**
 * Pure half of services/appearance.ts: resolves the UI-theme setting to a
 * VS Code theme kind, and builds the appearance snapshot every page receives.
 * Electron-free so the resolution matrix is unit-testable (test/appearance.test.ts).
 *
 * The kinds are VS Code's own webview body classes. That is the whole contract
 * with the submodules: cad's viewer.css re-palettes its scene under
 * `body.vscode-light` & co. (and a MutationObserver re-reads it live), and
 * mesh's design-system.css keys its elevation shadows on the same classes — so
 * applying the class is all a viewer needs, and neither is patched.
 */
import { effective, entryById, type UiThemeSetting } from "./settings/registry";

export type ThemeKind = "vscode-dark" | "vscode-light" | "vscode-high-contrast" | "vscode-high-contrast-light";

/** The OS state Electron's nativeTheme reports. */
export interface SystemTheme {
  dark: boolean;
  highContrast: boolean;
}

export function resolveThemeKind(setting: UiThemeSetting, system: SystemTheme): ThemeKind {
  switch (setting) {
    case "dark":
      return "vscode-dark";
    case "light":
      return "vscode-light";
    case "hcDark":
      return "vscode-high-contrast";
    case "hcLight":
      return "vscode-high-contrast-light";
    default:
      if (system.highContrast) return system.dark ? "vscode-high-contrast" : "vscode-high-contrast-light";
      return system.dark ? "vscode-dark" : "vscode-light";
  }
}

/** nativeTheme.themeSource for a setting, so native menus/dialogs match. */
export function themeSourceFor(setting: UiThemeSetting): "system" | "dark" | "light" {
  if (setting === "dark" || setting === "hcDark") return "dark";
  if (setting === "light" || setting === "hcLight") return "light";
  return "system";
}

export function isLightKind(kind: ThemeKind): boolean {
  return kind === "vscode-light" || kind === "vscode-high-contrast-light";
}

/** Editor background per kind — the BaseWindow's own background, shown before
 *  any view paints. Mirrors --vscode-editor-background in vscode-vars.css. */
export const WINDOW_BACKGROUND: Record<ThemeKind, string> = {
  "vscode-dark": "#1e1e1e",
  "vscode-light": "#ffffff",
  "vscode-high-contrast": "#000000",
  "vscode-high-contrast-light": "#ffffff",
};

export interface Appearance {
  kind: ThemeKind;
  /** Empty = keep vscode-vars.css's default stack. */
  fontFamily: string;
  fontSize: number;
  editor: { fontSize: number; fontFamily: string; tabSize: number; wordWrap: boolean; lineNumbers: boolean };
  terminal: {
    fontSize: number;
    fontFamily: string;
    scrollback: number;
    cursorStyle: "block" | "underline" | "bar";
    cursorBlink: boolean;
  };
}

/** stateStore keys whose change means the snapshot must be re-broadcast. */
export const APPEARANCE_IDS = [
  "appearance.uiTheme",
  "appearance.fontFamily",
  "appearance.fontSize",
  "editor.fontSize",
  "editor.fontFamily",
  "editor.tabSize",
  "editor.wordWrap",
  "editor.lineNumbers",
  "terminal.fontSize",
  "terminal.fontFamily",
  "terminal.scrollback",
  "terminal.cursorStyle",
  "terminal.cursorBlink",
] as const;

export function appearanceStoreKeys(): Set<string> {
  return new Set(APPEARANCE_IDS.map((id) => entryById(id)!.storeKey!));
}

/** Builds the snapshot from a store reader (stateStore.get in production). */
export function buildAppearance(read: (key: string) => unknown, system: SystemTheme): Appearance {
  const v = <T>(id: string): T => {
    const entry = entryById(id)!;
    return effective(entry, read(entry.storeKey!)) as T;
  };
  return {
    kind: resolveThemeKind(v<UiThemeSetting>("appearance.uiTheme"), system),
    fontFamily: v<string>("appearance.fontFamily"),
    fontSize: v<number>("appearance.fontSize"),
    editor: {
      fontSize: v<number>("editor.fontSize"),
      fontFamily: v<string>("editor.fontFamily"),
      tabSize: v<number>("editor.tabSize"),
      wordWrap: v<boolean>("editor.wordWrap"),
      lineNumbers: v<boolean>("editor.lineNumbers"),
    },
    terminal: {
      fontSize: v<number>("terminal.fontSize"),
      fontFamily: v<string>("terminal.fontFamily"),
      scrollback: v<number>("terminal.scrollback"),
      cursorStyle: v<"block" | "underline" | "bar">("terminal.cursorStyle"),
      cursorBlink: v<boolean>("terminal.cursorBlink"),
    },
  };
}
