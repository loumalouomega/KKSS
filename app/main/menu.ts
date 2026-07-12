/**
 * Native application menu. Mirrors the two extensions' contributed commands:
 *   cad:  cad-preview.open/save/saveAs/export  (Ctrl+O/S/Shift+S/E)
 *   mesh: kratos.mesh.open/save/saveAs/export, kratos.mdpa.resetCamera/
 *         toggleNodeIds/computeQuality/fieldVisualization/findEntity
 * File actions dispatch to whichever mode is active at click time.
 */
import { Menu, shell } from "electron";
import type { MainWindow } from "./windows";
import type { CadHost } from "./cadHost";
import type { MeshHost } from "./mesh/meshHost";
import type { Screen } from "./ipc";
import { showQuickPick, showInputBox } from "./services/quickPick";
import { showAbout } from "./services/about";
import { toast } from "./services/notifications";
import { openMesh, exportFormats } from "../../mesh/src/meshExport";
import { DOCS_URL } from "./urls";

export interface MenuDeps {
  main: MainWindow;
  cadHost: CadHost;
  meshHost: MeshHost;
  setScreen(screen: Screen): void;
}

export function installMenu(deps: MenuDeps): void {
  const { main, cadHost, meshHost } = deps;
  const inCad = () => main.mode() === "cad";

  /** kratos.mesh.export — quick-pick a format, then dispatch (extension.ts:109). */
  const meshExportPick = async (): Promise<void> => {
    const pick = await showQuickPick(
      exportFormats().map((f) => ({ label: f.label, description: f.ext, ext: f.ext })),
      { placeHolder: "Export mesh as…" }
    );
    if (pick) meshHost.dispatchMenu({ type: "menuExport", format: pick.ext });
  };

  /** kratos.mdpa.findEntity (extension.ts:128-145). */
  const findEntity = async (): Promise<void> => {
    const entityType = await showQuickPick(
      ["Node", "Element", "Condition", "Geometry"].map((label) => ({ label })),
      { placeHolder: "Entity type" }
    );
    if (!entityType) return;
    const raw = await showInputBox({ prompt: `Enter ${entityType.label} ID` });
    if (raw === undefined) return;
    if (!/^\d+$/.test(raw.trim())) {
      toast("warning", "Entity ID must be a positive integer.");
      return;
    }
    meshHost.postToActive({
      type: "locateEntity",
      entityType: entityType.label,
      entityId: Number(raw.trim()),
    });
  };

  const menu = Menu.buildFromTemplate([
    {
      label: "&File",
      submenu: [
        {
          label: "Open…",
          accelerator: "CmdOrCtrl+O",
          click: () => (inCad() ? void cadHost.openFileDialog() : void openMesh()),
        },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () =>
            inCad() ? void cadHost.flushSidecars() : void meshHost.dispatchMenu({ type: "menuSave" }),
        },
        {
          label: "Save As…",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () =>
            inCad() ? cadHost.export() : void meshHost.dispatchMenu({ type: "menuSaveAs" }),
        },
        {
          label: "Export…",
          accelerator: "CmdOrCtrl+E",
          click: () => (inCad() ? cadHost.export() : void meshExportPick()),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "&View",
      submenu: [
        {
          label: "Home",
          accelerator: "CmdOrCtrl+0",
          click: () => deps.setScreen("home"),
        },
        {
          label: "Pre-Processing (CAD)",
          accelerator: "CmdOrCtrl+1",
          click: () => deps.setScreen("cad"),
        },
        {
          label: "Post-Processing (Mesh)",
          accelerator: "CmdOrCtrl+2",
          click: () => deps.setScreen("mesh"),
        },
        { type: "separator" },
        { label: "Reset Camera", click: () => meshHost.postToActive({ type: "resetCamera" }) },
        { label: "Toggle Node IDs", click: () => meshHost.postToActive({ type: "toggleNodeIds" }) },
        { type: "separator" },
        { label: "Toggle Developer Tools", accelerator: "CmdOrCtrl+Shift+I", click: () => {
          const view = main.screen() === "home" ? main.home : main.views[main.mode()];
          view.webContents.toggleDevTools();
        } },
      ],
    },
    {
      label: "&Tools",
      submenu: [
        { label: "Mesh Quality", click: () => meshHost.postToActive({ type: "computeQuality" }) },
        { label: "Field Visualization", click: () => meshHost.postToActive({ type: "field" }) },
        { label: "Find Entity…", accelerator: "CmdOrCtrl+F", click: () => void findEntity() },
      ],
    },
    {
      label: "&Help",
      submenu: [
        { label: "KKSS Documentation", click: () => void shell.openExternal(DOCS_URL) },
        {
          label: "CAD-Preview (pre-processing submodule)",
          click: () => void shell.openExternal("https://github.com/loumalouomega/CAD-Preview"),
        },
        {
          label: "VSCode-MDPA-Preview (post-processing submodule)",
          click: () => void shell.openExternal("https://github.com/loumalouomega/VSCode-MDPA-Preview"),
        },
        { type: "separator" },
        { label: "About KKSS…", click: () => showAbout() },
      ],
    },
  ]);

  Menu.setApplicationMenu(menu);
}
