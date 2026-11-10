// The native Edit, Window and (macOS) application menus — pure template
// builders, so the structure can be asserted without Electron.
//
// Before these existed the menu had File/View/Settings/Help and one role
// (`quit`): on macOS the standard Cut/Copy/Paste/Select All/Undo shortcuts reach
// a text field only through a menu role, so they did nothing in the chat
// composer, Settings, the Home forms or the editor, and the packaged app had no
// Window or application menu at all. Undo is the one entry that is not a plain
// role: a viewer canvas ignores the native command, so it is routed by focus
// (`historyRoute`) between the native handler and the mesh operation history.
import { t, translate } from "../../shared/i18n";
import type { UnavailableKey } from "./menuAvailability";
import { UNAVAILABLE_SUFFIX } from "./menuAvailability";

/** Structural subset of Electron.MenuItemConstructorOptions this file emits. */
export interface MenuTemplateItem {
  label?: string;
  role?: string;
  type?: "separator";
  accelerator?: string;
  enabled?: boolean;
  visible?: boolean;
  click?: () => void;
  submenu?: MenuTemplateItem[];
}

export type HistoryRoute = "native" | "mesh" | "none";

/**
 * Where an Edit ▸ Undo/Redo goes.
 *  - a focused text field (or the text editor screen) always gets the native
 *    command, so typing history behaves as in any other application;
 *  - otherwise a Post-Processing tab drives the mesh operation history;
 *  - a Pre-Processing tab has no undo message to send yet (the viewer reports
 *    it only through its own Edits panel), so there is nothing to route to.
 */
export function historyRoute(ctx: { screen: string; editableFocused: boolean }): HistoryRoute {
  if (ctx.editableFocused || ctx.screen === "editor") return "native";
  if (ctx.screen === "mesh") return "mesh";
  if (ctx.screen === "cad") return "none";
  return "native";
}

/** The reason Edit ▸ Undo/Redo is unavailable, if any. A CAD tab has no route,
 *  so the items say so instead of silently doing nothing. */
export function historyUnavailable(screen: string): UnavailableKey | undefined {
  return screen === "cad" ? "noCadUndo" : undefined;
}

const withReason = (label: string, reason: UnavailableKey | undefined): string =>
  reason ? label + translate(UNAVAILABLE_SUFFIX[reason]) : label;

export interface EditMenuDeps {
  screen(): string;
  /** Runs the routed undo/redo; the caller resolves focus (it needs Electron). */
  history(kind: "undo" | "redo"): void;
}

export function editMenu(deps: EditMenuDeps): MenuTemplateItem {
  const reason = historyUnavailable(deps.screen());
  return {
    label: t("&Edit"),
    submenu: [
      {
        label: withReason(t("Undo"), reason),
        accelerator: "CmdOrCtrl+Z",
        enabled: !reason,
        click: () => deps.history("undo"),
      },
      {
        label: withReason(t("Redo"), reason),
        accelerator: "CmdOrCtrl+Shift+Z",
        enabled: !reason,
        click: () => deps.history("redo"),
      },
      { type: "separator" },
      { role: "cut", label: t("Cut") },
      { role: "copy", label: t("Copy") },
      { role: "paste", label: t("Paste") },
      { role: "selectAll", label: t("Select All") },
    ],
  };
}

export function windowMenu(platform: string): MenuTemplateItem {
  return {
    label: t("&Window"),
    submenu: [
      { role: "minimize", label: t("Minimize") },
      { role: "zoom", label: t("Zoom") },
      { role: "close", label: t("Close Window") },
      ...(platform === "darwin" ? [{ type: "separator" as const }, { role: "front", label: t("Bring All to Front") }] : []),
    ],
  };
}

/** macOS only: the first menu is the application's own. Elsewhere there is none. */
export function appMenu(platform: string, appName: string, onAbout: () => void): MenuTemplateItem | undefined {
  if (platform !== "darwin") return undefined;
  return {
    label: appName,
    submenu: [
      { label: t("About KKSS…"), click: onAbout },
      { type: "separator" },
      { role: "services", label: t("Services") },
      { type: "separator" },
      { role: "hide", label: t("Hide {0}", { 0: appName }) },
      { role: "hideOthers", label: t("Hide Others") },
      { role: "unhide", label: t("Show All") },
      { type: "separator" },
      { role: "quit", label: t("Quit") },
    ],
  };
}
