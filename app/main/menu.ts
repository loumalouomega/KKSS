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
import { showQuickPick } from "./services/quickPick";
import { showAbout } from "./services/about";
import { stateStore } from "./services/stateStore";
import { openMesh, exportFormats } from "../../mesh/src/meshExport";
import { DOCS_URL } from "./urls";

export interface MenuDeps {
  main: MainWindow;
  cadHost: CadHost;
  meshHost: MeshHost;
  setScreen(screen: Screen): void;
  toggleTerminal(): void;
}

/** Scene themes understood by the viewers (mesh provider's own value set). */
const SCENE_THEMES: Array<{ value: string; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "scientific", label: "Scientific" },
];

/** Shell choices for the embedded terminal, per platform. */
const SHELL_CHOICES: Array<{ value: string | undefined; label: string }> =
  process.platform === "win32"
    ? [
        { value: undefined, label: "PowerShell (default)" },
        { value: "cmd.exe", label: "Command Prompt" },
      ]
    : [
        { value: undefined, label: "System default ($SHELL)" },
        { value: "/bin/bash", label: "bash" },
        { value: "/bin/zsh", label: "zsh" },
      ];

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
        {
          label: "Toggle Terminal",
          accelerator: "CmdOrCtrl+`",
          click: () => deps.toggleTerminal(),
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
    // App-level preferences only — viewer actions (quality, fields, find…)
    // live in the submodules' own toolbars, so they are not duplicated here.
    {
      label: "&Settings",
      submenu: [
        {
          label: "Color Theme",
          submenu: SCENE_THEMES.map((t) => ({
            label: t.label,
            type: "radio" as const,
            checked: stateStore.get("sceneTheme", "auto") === t.value,
            // Shared with the mesh viewer's own theme toggle (same stateStore
            // key); viewers pick it up when they next load a file.
            click: () => void stateStore.update("sceneTheme", t.value),
          })),
        },
        {
          label: "Terminal Shell",
          submenu: SHELL_CHOICES.map((s) => ({
            label: s.label,
            type: "radio" as const,
            checked: stateStore.get<string>("terminalShell") === s.value,
            // Applies to the next terminal session (exit the current shell or
            // restart the app to switch).
            click: () => void stateStore.update("terminalShell", s.value),
          })),
        },
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
