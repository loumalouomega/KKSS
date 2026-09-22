/** UI-theme resolution and the appearance snapshot (services/appearanceCore.ts). */
import { describe, expect, it } from "vitest";
import {
  appearanceStoreKeys,
  buildAppearance,
  resolveThemeKind,
  themeSourceFor,
  WINDOW_BACKGROUND,
} from "../app/main/services/appearanceCore";
import { UI_THEMES } from "../app/main/services/settings/registry";

describe("resolveThemeKind", () => {
  const systems = [
    { dark: true, highContrast: false },
    { dark: false, highContrast: false },
    { dark: true, highContrast: true },
    { dark: false, highContrast: true },
  ];

  it("follows the OS for 'system'", () => {
    expect(systems.map((s) => resolveThemeKind("system", s))).toEqual([
      "vscode-dark",
      "vscode-light",
      "vscode-high-contrast",
      "vscode-high-contrast-light",
    ]);
  });

  it("ignores the OS for an explicit choice", () => {
    for (const s of systems) {
      expect(resolveThemeKind("dark", s)).toBe("vscode-dark");
      expect(resolveThemeKind("light", s)).toBe("vscode-light");
      expect(resolveThemeKind("hcDark", s)).toBe("vscode-high-contrast");
      expect(resolveThemeKind("hcLight", s)).toBe("vscode-high-contrast-light");
    }
  });

  it("maps every setting to a nativeTheme source", () => {
    expect(UI_THEMES.map(themeSourceFor)).toEqual(["system", "dark", "light", "dark", "light"]);
  });
});

describe("buildAppearance", () => {
  const dark = { dark: true, highContrast: false };

  it("uses the registry defaults on an empty store", () => {
    const a = buildAppearance(() => undefined, dark);
    expect(a).toEqual({
      kind: "vscode-dark",
      fontFamily: "",
      fontSize: 13,
      editor: { fontSize: 13, fontFamily: "", tabSize: 4, wordWrap: false, lineNumbers: true },
      terminal: { fontSize: 13, fontFamily: "", scrollback: 5000, cursorStyle: "block", cursorBlink: true },
    });
    expect(WINDOW_BACKGROUND[a.kind]).toBe("#1e1e1e");
  });

  it("reads stored values and falls back per field on invalid ones", () => {
    const store: Record<string, unknown> = {
      uiTheme: "light",
      "editor.fontSize": 18,
      "editor.wordWrap": true,
      "terminal.cursorStyle": "bar",
      "terminal.scrollback": -5, // invalid → default
    };
    const a = buildAppearance((k) => store[k], dark);
    expect(a.kind).toBe("vscode-light");
    expect(a.editor.fontSize).toBe(18);
    expect(a.editor.wordWrap).toBe(true);
    expect(a.terminal.cursorStyle).toBe("bar");
    expect(a.terminal.scrollback).toBe(5000);
  });

  it("re-broadcasts on exactly its own keys", () => {
    const keys = appearanceStoreKeys();
    expect(keys.has("uiTheme")).toBe(true);
    expect(keys.has("terminal.fontSize")).toBe(true);
    expect(keys.has("sceneTheme")).toBe(false);
  });
});
