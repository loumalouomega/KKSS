import { describe, expect, it } from "vitest";
import { appMenu, editMenu, historyRoute, historyUnavailable, windowMenu, type MenuTemplateItem } from "../app/main/services/editMenu";
import { unexplainedDisabledItems, type MenuNode } from "../app/main/services/menuAvailability";

const deps = (screen: string, calls: string[] = []) => ({ screen: () => screen, history: (k: "undo" | "redo") => void calls.push(k) });
const items = (m: MenuTemplateItem) => m.submenu ?? [];

describe("history routing", () => {
  it("gives a focused text field or the editor the native command", () => {
    expect(historyRoute({ screen: "mesh", editableFocused: true })).toBe("native");
    expect(historyRoute({ screen: "cad", editableFocused: true })).toBe("native");
    expect(historyRoute({ screen: "editor", editableFocused: false })).toBe("native");
    expect(historyRoute({ screen: "home", editableFocused: false })).toBe("native");
  });
  it("sends a Post-Processing tab to the mesh history and a CAD tab nowhere", () => {
    expect(historyRoute({ screen: "mesh", editableFocused: false })).toBe("mesh");
    expect(historyRoute({ screen: "cad", editableFocused: false })).toBe("none");
  });
  it("names a reason exactly where there is no route", () => {
    expect(historyUnavailable("cad")).toBe("noCadUndo");
    for (const s of ["mesh", "home", "editor"]) expect(historyUnavailable(s)).toBeUndefined();
  });
});

describe("Edit menu", () => {
  it("carries the clipboard roles and Undo/Redo with the standard accelerators", () => {
    const sub = items(editMenu(deps("mesh")));
    expect(sub.filter((i) => i.role).map((i) => i.role)).toEqual(["cut", "copy", "paste", "selectAll"]);
    const [undo, redo] = sub;
    expect(undo.accelerator).toBe("CmdOrCtrl+Z");
    expect(redo.accelerator).toBe("CmdOrCtrl+Shift+Z");
  });
  it("calls the history callback with the right kind", () => {
    const calls: string[] = [];
    const [undo, redo] = items(editMenu(deps("mesh", calls)));
    undo.click?.();
    redo.click?.();
    expect(calls).toEqual(["undo", "redo"]);
  });
  it("disables Undo/Redo on a CAD tab and says why", () => {
    const [undo, redo] = items(editMenu(deps("cad")));
    expect(undo.enabled).toBe(false);
    expect(redo.enabled).toBe(false);
    expect(undo.label).toMatch(/\(not available for CAD documents yet\)$/);
    expect(unexplainedDisabledItems([editMenu(deps("cad")) as MenuNode])).toEqual([]);
  });
  it("never leaves a disabled item without a reason", () => {
    for (const screen of ["home", "cad", "mesh", "editor"]) {
      expect(unexplainedDisabledItems([editMenu(deps(screen)) as MenuNode])).toEqual([]);
    }
  });
});

describe("Window and application menus", () => {
  it("has Bring All to Front only on macOS", () => {
    const roles = (p: string) => items(windowMenu(p)).map((i) => i.role);
    expect(roles("darwin")).toContain("front");
    expect(roles("linux")).not.toContain("front");
    expect(roles("win32")).toEqual(["minimize", "zoom", "close"]);
  });
  it("adds an application menu on macOS and none elsewhere", () => {
    expect(appMenu("linux", "KKSS", () => {})).toBeUndefined();
    expect(appMenu("win32", "KKSS", () => {})).toBeUndefined();
    const mac = appMenu("darwin", "KKSS", () => {});
    expect(mac?.label).toBe("KKSS");
    expect(items(mac!).map((i) => i.role).filter(Boolean)).toEqual(["services", "hide", "hideOthers", "unhide", "quit"]);
  });
  it("routes About through the callback", () => {
    let called = 0;
    items(appMenu("darwin", "KKSS", () => void called++)!)[0].click?.();
    expect(called).toBe(1);
  });
});
