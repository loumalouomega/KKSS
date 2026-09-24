import { t } from "../shared/i18n";
import { setUpdateChannel, updateChannel } from "./services/updates";
/**
 * Native application menu. Mirrors the two extensions' contributed commands:
 *   cad:  cad-preview.open/save/saveAs/export  (Ctrl+O/S/Shift+S/E)
 *   mesh: kratos.mesh.open/save/saveAs/export, kratos.mdpa.resetCamera/
 *         toggleNodeIds/computeQuality/fieldVisualization/findEntity
 * File actions dispatch to whichever mode is active at click time.
 */
import { app, dialog, Menu, shell } from "electron";
import type { MainWindow } from "./windows";
import type { CadHost } from "./cadHost";
import { effective, entryById } from "./services/settings/registry";
import type { MeshHost } from "./mesh/meshHost";
import type { Mode, Screen } from "./ipc";
import { showQuickPick, showInputBox } from "./services/quickPick";
import { showAbout } from "./services/about";
import { showChangelog } from "./services/whatsNew";
import { stateStore } from "./services/stateStore";
import type { CloudStatus } from "./services/cloud/cloudService";
import { PROVIDER_LABELS, type ProviderId } from "./services/cloud/cloudCore";
import { hasSecret, setSecret } from "./services/chat/secrets";
import { checkCodexAuth } from "./services/chat/agents/codex";
import { checkClaudeAuth, resolveExecutable, SUBSCRIPTION_SETUP } from "./services/chat/agents/runtime";
import { LLM_KEYS } from "./services/chat/chatService";
import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "./services/chat/toolPolicy";
import { DEFAULT_ANTHROPIC_MODEL } from "./services/chat/providers/anthropic";
import { DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL } from "./services/chat/providers/openaiCompat";
import { DEFAULT_META_SERVER_PORT, META_SERVER_KEYS } from "./services/metaServer/metaServer";
import type { EditorService } from "./services/editor";
import { openMesh, exportFormats } from "../../mesh/src/meshExport";
// The mesh submodule's recents core is vscode-free, so its label/folder
// formatting is reused verbatim for KKSS's own app-wide list.
import { recentLabel } from "../../mesh/src/recentMeshesCore";
import { describeWithin, rootLabel } from "./services/projectRootCore";
import type { RecentFile } from "./services/recentFilesCore";
import { RESTORE_SESSION_KEY } from "./services/session";
import { DOCS_URL } from "./urls";

export interface MenuDeps {
  main: MainWindow;
  /** The CadHost/MeshHost backing whichever tab is currently focused — the
   *  menu always acts on "whatever's focused right now", never a fixed
   *  singleton (KKSS supports several concurrently open tabs per mode). */
  activeCadHost(): CadHost | undefined;
  activeMeshHost(): MeshHost | undefined;
  editor: EditorService;
  setScreen(screen: Screen): void;
  /** File ▸ New CAD/Mesh Tab — creates and focuses an empty tab. */
  newTab(mode: Mode): void;
  /** File ▸ Close Tab. Async since mesh 3.18.0: a dirty mesh tab prompts
   *  Save / Don't Save / Cancel first (index.ts's confirmDiscardMeshTab). */
  closeTab(mode: Mode, tabId: string): Promise<void>;
  toggleTerminal(): void;
  toggleChat(): void;
  toggleJobs(): void;
  /** Interface-scale controls (see index.ts) — step through the shell's zoom presets. */
  zoom: {
    stepIn(): void;
    stepOut(): void;
    reset(): void;
  };
  /**
   * KKSS's app-wide recents (services/recentFiles.ts) — both modes, recorded at
   * openFile(). Supersedes mesh's own RecentMeshStore here: that one records
   * only what the mesh providers resolve, so it never saw a CAD document (it
   * still runs, since both providers require it, but drives no UI). Each entry
   * carries the mode it was opened in, so it reopens where it belongs.
   * `list()` prunes vanished files on read, so the submenu never offers a path
   * that no longer exists.
   */
  /**
   * The project root — a default for the terminal's cwd, file dialogs and the
   * assistant's context, never a restriction. `current()` is the *explicit*
   * root only, so the menu label reflects what the user actually chose.
   */
  projectRoot: {
    /** The explicit root, if it still exists — drives the labels. */
    current(): string | undefined;
    /** Whether one is stored at all (a stale root stays clearable). */
    isSet(): boolean;
    choose(): void;
    clear(): void;
  };
  recentFiles: {
    list(): RecentFile[];
    open(fsPath: string, mode: Mode): void;
    clear(): void;
  };
  /** Cloud storage accounts and the staging cache (see services/cloud). */
  cloud: {
    statuses(): CloudStatus[];
    isConnected(): boolean;
    /** The exact loopback redirect URI the provider's console needs. */
    redirectHint(id: ProviderId): string;
    setClientId(id: ProviderId, value: string | undefined): void;
    setClientSecret(id: ProviderId, value: string): void;
    connect(id: ProviderId): void;
    disconnect(id: ProviderId): void;
    openFromCloud(): void;
    /** File ▸ Save also pushes any staged document that changed. */
    saveNow(): void;
    cacheLimitMb(): number;
    setCacheLimitMb(value: number | undefined): void;
    clearCache(): void;
  };
  /** Settings ▸ Open Settings… (Ctrl+,) — the full Settings page. */
  openSettings(): void;
  /** HTTP meta MCP server controls (see index.ts). */
  metaServer: {
    enabled(): boolean;
    setEnabled(enabled: boolean): void;
    copyConfig(): void;
    regenerateToken(): void;
  };
}

/**
 * A registry enum as a radio submenu — the quick toggles kept in the native
 * menu read the same entry the Settings page renders, so the two cannot drift
 * (and the menu is rebuilt on every stateStore change, see index.ts).
 */
function enumRadio(id: string): Electron.MenuItemConstructorOptions {
  const entry = entryById(id)!;
  const key = entry.storeKey!;
  const managed = stateStore.isManaged(key);
  const current = effective(entry, stateStore.get(key));
  return {
    label: entry.label + (managed ? t(" (set by the environment)") : ""),
    enabled: !managed,
    submenu: (entry.enum ?? []).map((value, i) => ({
      label: entry.enumLabels?.[i] ?? String(value),
      type: "radio" as const,
      checked: current === value,
      click: () => void stateStore.update(key, value === entry.default ? undefined : value),
    })),
  };
}

/** Secret entry: never prefills the stored value; empty input clears it. */
async function promptSecret(key: string, title: string, placeHolder: string): Promise<void> {
  if (stateStore.isManaged(key)) return;
  const value = await showInputBox({
    title,
    prompt: hasSecret(key) ? t("Currently configured — enter a new key to replace it, or leave empty to clear.") : undefined,
    placeHolder,
  });
  if (value === undefined) return; // cancelled
  await setSecret(key, value.trim());
}

/**
 * "Never ask" is the only setting that turns the gate off outright, so it is
 * confirmed once — the same warning the MCP server's copy-config dialog uses,
 * for the same tools. Shared with the Settings page (settingsWindow.ts).
 */
export async function confirmApprovalOff(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: [t("Cancel"), t("Turn Approval Off")],
    defaultId: 0,
    cancelId: 0,
    message: t("Run every tool without asking?"),
    detail:
      t("The assistant will run every tool it chooses, with no prompt. These tools read and write files on disk and can run simulations, and some overwrite the file they are given when no output path is set. Only turn this off for a session you are watching."),
  });
  return response === 1;
}

/** The other two modes are set without ceremony. */
async function setApprovalMode(mode: ApprovalMode, deps: MenuDeps): Promise<void> {
  if (mode === "never" && !(await confirmApprovalOff())) {
    // The radio already moved on click; rebuilding puts it back.
    installMenu(deps);
    return;
  }
  await stateStore.update(LLM_KEYS.toolApproval, mode);
}

/** Plain setting entry, prefilled with the current (or default) value. */
async function promptValue(key: string, title: string, defaultValue: string): Promise<void> {
  if (stateStore.isManaged(key)) return;
  const value = await showInputBox({
    title,
    value: stateStore.get<string>(key) || defaultValue,
  });
  if (value === undefined) return; // cancelled
  await stateStore.update(key, value.trim() || undefined);
}

/** One block per provider, plus the shared cache controls. */
function cloudAccountsSubmenu(deps: MenuDeps): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  for (const status of deps.cloud.statuses()) {
    items.push({
      label: status.label,
      submenu: [
        {
          // A disabled row is the whole status display: connected as whom, or
          // exactly which step is still missing.
          label: status.connected
            ? t("Connected as {0}", {0: status.account?.label ?? "?"})
            : status.hasClientId
              ? t("Not connected")
              : t("Client ID not set"),
          enabled: false,
        },
        { type: "separator" },
        {
          label: t("Client ID…") + (stateStore.isManaged(`cloud.${status.id}.clientId`) ? t(" (set by the environment)") : ""),
          enabled: !stateStore.isManaged(`cloud.${status.id}.clientId`),
          click: () => void promptCloudClientId(deps, status),
        },
        {
          enabled: !stateStore.isManaged(`cloud.${status.id}.clientSecret`),
          label: (status.needsClientSecret ? t("Client Secret…") : t("Client Secret… (optional)")) +
            (stateStore.isManaged(`cloud.${status.id}.clientSecret`) ? t(" (set by the environment)") : ""),
          click: () => void promptCloudSecret(deps, status),
        },
        { type: "separator" },
        {
          label: status.connected ? t("Reconnect…") : t("Connect…"),
          enabled: status.hasClientId,
          click: () => deps.cloud.connect(status.id),
        },
        {
          label: t("Disconnect…"),
          enabled: status.connected,
          click: () => deps.cloud.disconnect(status.id),
        },
      ],
    });
  }
  items.push(
    { type: "separator" },
    {
      label: t("Cache Size Limit… ({0} MB)", {0: deps.cloud.cacheLimitMb()}),
      click: () => void promptCacheLimit(deps),
    },
    { label: t("Clear Cloud Cache…"), click: () => deps.cloud.clearCache() }
  );
  return items;
}

async function promptCloudClientId(deps: MenuDeps, status: CloudStatus): Promise<void> {
  const value = await showInputBox({
    title: t("{0} Client ID", {0: status.label}),
    // The redirect URI is the single most common setup mistake, so it is stated
    // here rather than left to the docs.
    prompt: t("Create a desktop/installed-app OAuth client in your {0} console with redirect URI {1}, then paste its client ID. Leave empty to clear.", {0: status.label, 1: deps.cloud.redirectHint(status.id)}),
  });
  if (value === undefined) return; // cancelled
  deps.cloud.setClientId(status.id, value.trim() || undefined);
}

async function promptCloudSecret(deps: MenuDeps, status: CloudStatus): Promise<void> {
  const value = await showInputBox({
    title: t("{0} Client Secret", {0: status.label}),
    prompt: status.needsClientSecret
      ? t("Required for this provider's desktop clients. Stored encrypted. Leave empty to clear.")
      : t("Not needed for this provider (PKCE public client). Leave empty to clear."),
  });
  if (value === undefined) return; // cancelled
  deps.cloud.setClientSecret(status.id, value.trim());
}

async function promptCacheLimit(deps: MenuDeps): Promise<void> {
  const value = await showInputBox({
    title: t("Cloud Cache Size Limit (MB)"),
    value: String(deps.cloud.cacheLimitMb()),
  });
  if (value === undefined) return; // cancelled
  const parsed = Number(value.trim());
  deps.cloud.setCacheLimitMb(Number.isFinite(parsed) && parsed > 0 ? parsed : undefined);
}

export function installMenu(deps: MenuDeps): void {
  const { main, activeCadHost, activeMeshHost, editor } = deps;
  const inCad = () => main.mode() === "cad";
  const inEditor = () => main.screen() === "editor";
  /** The WebContentsView for whichever tab is focused in the active mode
   *  screen (devtools toggle only — everything else goes through the hosts). */
  const activeModeView = () => {
    const mode = main.mode();
    const id = main.activeTabId(mode);
    return id ? main.tabs(mode).find((t) => t.id === id)?.view : undefined;
  };

  /** kratos.mesh.export — quick-pick a format, then dispatch (extension.ts:109). */
  const meshExportPick = async (): Promise<void> => {
    const pick = await showQuickPick(
      exportFormats().map((f) => ({ label: f.label, description: f.ext, ext: f.ext })),
      { placeHolder: t("Export mesh as…") }
    );
    if (pick) activeMeshHost()?.dispatchMenu({ type: "menuExport", format: pick.ext });
  };

  /**
   * File ▸ Open Recent — KKSS's app-wide list, covering both modes, with each
   * entry reopening in the mode it was recorded under. `list()` prunes vanished
   * files as it reads, so an entry here always still exists; an empty list
   * shows one disabled row rather than an empty (and on some platforms
   * unopenable) submenu. Electron menus are static once built, so index.ts
   * re-installs the menu on the store's onDidChange — this whole template is
   * rebuilt each time.
   */
  const recentFilesSubmenu = (): Electron.MenuItemConstructorOptions[] => {
    const entries = deps.recentFiles.list();
    if (entries.length === 0) return [{ label: t("No Recent Files"), enabled: false }];
    return [
      ...entries.map((entry) => ({
        label: recentLabel(entry.path),
        // A native menu has no second column, so the folder rides in the
        // tooltip (the same shape mesh's own activity-bar view shows).
        // A cloud row's local path is a cache directory nobody would recognise,
        // so it names its provider and remote folder instead.
        toolTip: entry.cloud
          ? `${PROVIDER_LABELS[entry.cloud.provider as ProviderId] ?? entry.cloud.provider} · ${entry.cloud.folder ?? entry.cloud.name}`
          : describeWithin(deps.projectRoot.current(), entry.path, app.getPath("home")),
        click: () => deps.recentFiles.open(entry.path, entry.mode),
      })),
      { type: "separator" as const },
      { label: t("Clear Recent"), click: () => deps.recentFiles.clear() },
    ];
  };

  const menu = Menu.buildFromTemplate([
    {
      label: t("&File"),
      submenu: [
        {
          // Scope, not a document — so it leads the File menu, above the
          // document group, and the label names the current root.
          label: deps.projectRoot.current()
            ? t("Project Root: {0}…", {0: rootLabel(deps.projectRoot.current()!)})
            : t("Open Folder…"),
          toolTip: deps.projectRoot.current(),
          click: () => deps.projectRoot.choose(),
        },
        {
          label: t("Clear Project Root") + (stateStore.isManaged("projectRoot") ? t(" (set by the environment)") : ""),
          // Stays available for a stored-but-missing root (deleted or unmounted),
          // which `current()` hides but the user still needs to be able to drop.
          enabled: deps.projectRoot.isSet() && !stateStore.isManaged("projectRoot"),
          click: () => deps.projectRoot.clear(),
        },
        { type: "separator" },
        {
          label: t("Open…"),
          accelerator: "CmdOrCtrl+O",
          click: () => (inCad() ? void activeCadHost()?.openFileDialog() : void openMesh()),
        },
        {
          label: t("Open Recent"),
          submenu: recentFilesSubmenu(),
        },
        {
          // Degrades honestly rather than opening an empty picker: the label
          // itself says why it is unavailable.
          label: deps.cloud.isConnected()
            ? t("Open from Cloud…")
            : t("Open from Cloud… (no account connected)"),
          enabled: deps.cloud.isConnected(),
          click: () => deps.cloud.openFromCloud(),
        },
        {
          label: t("Open in Text Editor…"),
          click: () => void editor.open(),
        },
        {
          label: t("Save"),
          accelerator: "CmdOrCtrl+S",
          click: () => {
            if (inEditor()) {
              editor.requestSave(false);
            } else if (inCad()) {
              void activeCadHost()?.flushSidecars();
            } else {
              void activeMeshHost()?.dispatchMenu({ type: "menuSave" });
            }
            // A staged document's save has to reach the provider too. Harmless
            // when nothing is cloud-backed: the sync engine tracks no
            // directories and this resolves immediately.
            deps.cloud.saveNow();
          },
        },
        {
          label: t("Save As…"),
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => {
            if (inEditor()) return editor.requestSave(true);
            inCad() ? activeCadHost()?.export() : void activeMeshHost()?.dispatchMenu({ type: "menuSaveAs" });
          },
        },
        {
          label: t("Export…"),
          accelerator: "CmdOrCtrl+E",
          click: () => (inCad() ? activeCadHost()?.export() : void meshExportPick()),
        },
        { type: "separator" },
        {
          // cad 1.10.0's cad-preview.new. Deliberately session-free upstream
          // ("must work with no CAD tab focused"), and it CREATES a document —
          // so it routes through onOpenRequest like the Open dialog rather than
          // needing a tab of its own first.
          label: t("New Blank Model…"),
          click: () => activeCadHost()?.newBlankModel(),
        },
        { type: "separator" },
        {
          label: t("New CAD Tab"),
          click: () => deps.newTab("cad"),
        },
        {
          label: t("New Mesh Tab"),
          click: () => deps.newTab("mesh"),
        },
        {
          label: t("Close Tab"),
          accelerator: "CmdOrCtrl+W",
          click: () => {
            const mode = main.mode();
            const id = main.activeTabId(mode);
            if (id) void deps.closeTab(mode, id);
          },
        },
        { type: "separator" },
        // The mesh viewer's own File menu lives in its in-flow menubar, which
        // KKSS hides (app/renderer/theme/mesh-overrides.css) in favour of this
        // one — so its entries have to live here, on the same accelerators the
        // extension contributes.
        {
          // mesh 3.2.0's kratos.mesh.reload. Re-reads the file and REBASES the
          // edit history onto it (applied ops are replayed, not dropped), so
          // this is also how you pick up an external change on purpose.
          label: t("Reload from Disk"),
          accelerator: "CmdOrCtrl+Alt+R",
          enabled: !inCad(),
          click: () => void activeMeshHost()?.dispatchReload(),
        },
        {
          // mesh 3.7.0's kratos.mesh.exportTable — Advanced ▸ Data table…
          // owns the in-viewport route; this is the palette-command parity.
          label: t("Export Data Table…"),
          enabled: !inCad(),
          click: () => void activeMeshHost()?.dispatchMenu({ type: "menuExportTable" }),
        },
        {
          // mesh 3.8.0's kratos.case.stop — the run manager's stop ladder
          // (SIGINT → SIGTERM → SIGKILL). Runs outlive the tab that started
          // them, so this is reachable whatever the focused tab shows.
          label: t("Stop Kratos Run"),
          enabled: !inCad(),
          click: () => void activeMeshHost()?.dispatchCase("stop"),
        },
        {
          // mesh 3.21.0's kratos.mesh.packSeries — combines a solve's per-step
          // files into one XDMF time series. Upstream this is reachable only
          // from the Command Palette and the Kratos Runs tree, neither of
          // which KKSS runs, so this menu item is the sole entry point.
          label: t("Pack Time Series Into One File…"),
          enabled: !inCad(),
          click: () => void activeMeshHost()?.packSeries(),
        },
        { type: "separator" },
        {
          // mesh 3.18.0's kratos.mesh.undo/redo (Ctrl+Z / Ctrl+Shift+Z
          // upstream). NOT bound to those keys here: KKSS has no VS Code
          // keybinding service to gate them on "a mesh preview is focused" the
          // way upstream's `when` clause does, and an Electron menu
          // accelerator is captured globally, ahead of the focused webview —
          // binding Ctrl+Z here would silently break the text editor's own
          // undo. Ctrl+Alt+Z matches this file's existing convention for
          // mesh-parity commands with no natural KKSS-level shortcut (Reload
          // from Disk, Save/Load Problem, Screenshot). The sidebar's own
          // Undo/Redo buttons remain the mouse route.
          label: t("Undo Mesh Operation"),
          accelerator: "CmdOrCtrl+Alt+Z",
          enabled: !inCad(),
          click: () => void activeMeshHost()?.dispatchHistory("undo"),
        },
        {
          label: t("Redo Mesh Operation"),
          accelerator: "CmdOrCtrl+Alt+Shift+Z",
          enabled: !inCad(),
          click: () => void activeMeshHost()?.dispatchHistory("redo"),
        },
        { type: "separator" },
        {
          label: t("Save Problem…"),
          accelerator: "CmdOrCtrl+Alt+S",
          click: () => void activeMeshHost()?.dispatchMenu({ type: "menuSaveProblem" }),
        },
        {
          label: t("Load Problem…"),
          accelerator: "CmdOrCtrl+Alt+O",
          click: () => void activeMeshHost()?.dispatchMenu({ type: "menuLoadProblem" }),
        },
        { type: "separator" },
        // The CAD counterpart: a .zip of the source + its sidecars. Load needs
        // no open document, so it is never mode-gated — both act on whichever
        // CAD tab is currently focused (any tab will do for Load, since it
        // hands off to the router rather than touching the tab's own document).
        { label: t("Save Preprocess…"), click: () => activeCadHost()?.savePreprocess() },
        { label: t("Load Preprocess…"), click: () => activeCadHost()?.loadPreprocess() },
        { type: "separator" },
        {
          // cad-preview.screenshot / kratos.mdpa.screenshot — both viewers gained
          // one in this submodule bump; dispatch to whichever mode is active.
          label: t("Screenshot…"),
          accelerator: "CmdOrCtrl+Alt+P",
          click: () =>
            inCad() ? activeCadHost()?.screenshot() : activeMeshHost()?.postToActive({ type: "takeScreenshot" }),
        },
        { type: "separator" },
        { role: "quit", label: t("Quit") },
      ],
    },
    {
      label: t("&View"),
      submenu: [
        {
          label: t("Home"),
          accelerator: "CmdOrCtrl+0",
          click: () => deps.setScreen("home"),
        },
        {
          label: t("Pre-Processing (CAD)"),
          accelerator: "CmdOrCtrl+1",
          click: () => deps.setScreen("cad"),
        },
        {
          label: t("Post-Processing (Mesh)"),
          accelerator: "CmdOrCtrl+2",
          click: () => deps.setScreen("mesh"),
        },
        { type: "separator" },
        {
          // Interface scale: applies to every view + the chrome, persisted.
          // Ctrl+0 is "Home", so Reset uses Ctrl+Shift+0.
          label: t("Zoom In") + (stateStore.isManaged("uiZoom") ? t(" (set by the environment)") : ""),
          enabled: !stateStore.isManaged("uiZoom"),
          accelerator: "CmdOrCtrl+Plus",
          click: () => deps.zoom.stepIn(),
        },
        // Hidden twin so the unshifted "Ctrl+=" also zooms in (Plus needs Shift).
        {
          label: t("Zoom In") + (stateStore.isManaged("uiZoom") ? t(" (set by the environment)") : ""),
          enabled: !stateStore.isManaged("uiZoom"),
          accelerator: "CmdOrCtrl+=",
          visible: false,
          click: () => deps.zoom.stepIn(),
        },
        {
          label: t("Zoom Out") + (stateStore.isManaged("uiZoom") ? t(" (set by the environment)") : ""),
          enabled: !stateStore.isManaged("uiZoom"),
          accelerator: "CmdOrCtrl+-",
          click: () => deps.zoom.stepOut(),
        },
        {
          label: t("Reset Zoom") + (stateStore.isManaged("uiZoom") ? t(" (set by the environment)") : ""),
          enabled: !stateStore.isManaged("uiZoom"),
          accelerator: "CmdOrCtrl+Shift+0",
          click: () => deps.zoom.reset(),
        },
        { type: "separator" },
        {
          label: t("Toggle Terminal"),
          accelerator: "CmdOrCtrl+`",
          click: () => deps.toggleTerminal(),
        },
        {
          label: t("Toggle AI Chat"),
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => deps.toggleChat(),
        },
        { type: "separator" },
        { label: t("Toggle Jobs"), click: () => deps.toggleJobs() },
        { label: t("Reset Camera"), click: () => activeMeshHost()?.postToActive({ type: "resetCamera" }) },
        { label: t("Toggle Node IDs"), click: () => activeMeshHost()?.postToActive({ type: "toggleNodeIds" }) },
        { type: "separator" },
        { label: t("Toggle Developer Tools"), accelerator: "CmdOrCtrl+Shift+I", click: () => {
          const screen = main.screen();
          const view =
            screen === "home" ? main.home : screen === "editor" ? main.editor : activeModeView();
          view?.webContents.toggleDevTools();
        } },
      ],
    },
    // App-level preferences only — viewer actions (quality, fields, find…)
    // live in the submodules' own toolbars, so they are not duplicated here.
    {
      label: t("&Settings"),
      submenu: [
        {
          label: t("Open Settings…"),
          accelerator: "CmdOrCtrl+,",
          click: () => deps.openSettings(),
        },
        { type: "separator" },
        enumRadio("appearance.uiTheme"),
        // Shared with the mesh viewer's own theme toggle (same stateStore key);
        // viewers pick it up when they next load a file.
        enumRadio("appearance.sceneTheme"),
        { type: "separator" },
        {
          // Reopens the last run's documents, screen and panels at launch.
          // Also skipped by KKSS_E2E (the harness launches the real app) and by
          // KKSS_NO_RESTORE=1 — see services/session.ts.
          label: t("Restore Last Session") + (stateStore.isManaged(RESTORE_SESSION_KEY) ? t(" (set by the environment)") : ""),
          enabled: !stateStore.isManaged(RESTORE_SESSION_KEY),
          type: "checkbox" as const,
          checked: stateStore.get<boolean>(RESTORE_SESSION_KEY, true) !== false,
          click: (item) => void stateStore.update(RESTORE_SESSION_KEY, item.checked),
        },
        {
          label: t("Include prerelease updates") + (stateStore.isManaged("updateChannel") ? t(" (set by the environment)") : ""),
          enabled: !stateStore.isManaged("updateChannel"),
          type: "checkbox",
          checked: updateChannel() === "prerelease",
          click: item => void setUpdateChannel(item.checked ? "prerelease" : "stable"),
        },
        // Applies to the next terminal session (exit the current shell or
        // restart the app to switch).
        enumRadio("terminal.shell"),
        {
          // All values are read per chat request — changes apply immediately,
          // no restart. API keys are stored safeStorage-encrypted (secrets.ts).
          label: t("LLM Assistant"),
          submenu: [
            {
              label: t("Provider") + (stateStore.isManaged("llmProvider") ? t(" (set by the environment)") : ""),
              enabled: !stateStore.isManaged("llmProvider"),
              submenu: [
                { value: "anthropic", label: t("Anthropic (Claude)") },
                { value: "openai", label: t("OpenAI-compatible") },
                { value: "codex", label: t("ChatGPT subscription (Codex)") },
                { value: "claude-code", label: t("Claude subscription (Claude Code)") },
              ].map((p) => ({
                label: p.label,
                type: "radio" as const,
                checked: stateStore.get(LLM_KEYS.provider, "anthropic") === p.value,
                click: () => void stateStore.update(LLM_KEYS.provider, p.value),
              })),
            },
            {
              // Read per tool call, so a change applies to the very next one.
              // Read-only tools never prompt; a tool KKSS has no policy for
              // (every kratos__* one today) always does.
              label: t("Tool Approval"),
              submenu: (
                [
                  { value: "askOnWrite", label: t("Ask before tools that change files (recommended)") },
                  { value: "askAlways", label: t("Ask before every tool") },
                  { value: "never", label: t("Never ask") },
                ] as Array<{ value: ApprovalMode; label: string }>
              ).map((m) => ({
                label: m.label,
                type: "radio" as const,
                checked: stateStore.get(LLM_KEYS.toolApproval, DEFAULT_APPROVAL_MODE) === m.value,
                click: () => void setApprovalMode(m.value, deps),
              })),
            },
            { type: "separator" },
            ...(["codex", "claude-code"] as const).map(provider => {
              const setup = SUBSCRIPTION_SETUP[provider];
              const modelKey = provider === "codex" ? LLM_KEYS.codexModel : LLM_KEYS.claudeCodeModel;
              const executableKey = provider === "codex" ? LLM_KEYS.codexExecutable : LLM_KEYS.claudeCodeExecutable;
              return { label: setup.label, submenu: [
                { label: t("Check installation and sign-in…"), click: async () => {
                  let detail = t("Installed and signed in with a subscription. Provider model availability and usage limits apply.");
                  try {
                    const executable = resolveExecutable(provider, stateStore.get<string>(executableKey, ""));
                    if (provider === "codex") await checkCodexAuth(executable); else await checkClaudeAuth(executable);
                  } catch (error) { detail = error instanceof Error ? error.message : t("Runtime check failed."); }
                  await dialog.showMessageBox({ type: "info", title: setup.label, message: detail, detail: t("Sign in in a terminal using: {0}\nKKSS uses the official tool’s account. It never falls back to an API key.", {0: setup.command}) });
                } },
                { label: t("Installation and sign-in instructions…"), click: () => { void shell.openExternal(setup.url); } },
                { label: t("Model…"), enabled: !stateStore.isManaged(modelKey), click: () => void promptValue(modelKey, t("{0} model (empty uses runtime default)", {0: setup.label}), "") },
                { label: t("Executable path…"), enabled: !stateStore.isManaged(executableKey), click: () => void promptValue(executableKey, t("Absolute executable path (empty uses automatic detection)"), "") },
              ] };
            }),
            { type: "separator" as const },
            {
              label: t("Anthropic API Key…") + (stateStore.isManaged("llmKeyAnthropic") ? t(" (set by the environment)") : ""),
              enabled: !stateStore.isManaged("llmKeyAnthropic"),
              click: () => void promptSecret(LLM_KEYS.anthropicKey, t("Anthropic API Key"), "sk-ant-…"),
            },
            {
              label: t("Anthropic Model…") + (stateStore.isManaged("llmModelAnthropic") ? t(" (set by the environment)") : ""),
              enabled: !stateStore.isManaged("llmModelAnthropic"),
              click: () => void promptValue(LLM_KEYS.anthropicModel, t("Anthropic Model"), DEFAULT_ANTHROPIC_MODEL),
            },
            { type: "separator" },
            {
              label: t("OpenAI-compatible API Key…") + (stateStore.isManaged("llmKeyOpenai") ? t(" (set by the environment)") : ""),
              enabled: !stateStore.isManaged("llmKeyOpenai"),
              click: () => void promptSecret(LLM_KEYS.openaiKey, t("OpenAI-compatible API Key"), t("sk-… (leave empty for keyless backends like Ollama)")),
            },
            {
              label: t("OpenAI-compatible Base URL…") + (stateStore.isManaged("llmOpenaiBaseUrl") ? t(" (set by the environment)") : ""),
              enabled: !stateStore.isManaged("llmOpenaiBaseUrl"),
              click: () => void promptValue(LLM_KEYS.openaiBaseUrl, t("OpenAI-compatible Base URL"), DEFAULT_OPENAI_BASE_URL),
            },
            {
              label: t("OpenAI-compatible Model…") + (stateStore.isManaged("llmModelOpenai") ? t(" (set by the environment)") : ""),
              enabled: !stateStore.isManaged("llmModelOpenai"),
              click: () => void promptValue(LLM_KEYS.openaiModel, t("OpenAI-compatible Model"), DEFAULT_OPENAI_MODEL),
            },
          ],
        },
        {
          // Exposes the same cad+mesh+kratos toolset over a localhost HTTP MCP
          // endpoint so an external LLM client can drive KKSS. Off by default;
          // localhost-bound + bearer-token protected (these tools touch disk).
          label: t("MCP Server"),
          submenu: [
            {
              label: t("Enable (external LLM access)") + (stateStore.isManaged("metaServerEnabled") ? t(" (set by the environment)") : ""),
              enabled: !stateStore.isManaged("metaServerEnabled"),
              type: "checkbox" as const,
              checked: deps.metaServer.enabled(),
              click: (item) => deps.metaServer.setEnabled(item.checked),
            },
            { type: "separator" },
            {
              label: t("Port…") + (stateStore.isManaged("metaServerPort") ? t(" (set by the environment)") : ""),
              enabled: !stateStore.isManaged("metaServerPort"),
              // Applies on next enable (toggle off/on to rebind).
              click: () => void promptValue(META_SERVER_KEYS.port, t("MCP Server Port"), String(DEFAULT_META_SERVER_PORT)),
            },
            {
              label: t("Copy Address & Token…"),
              click: () => deps.metaServer.copyConfig(),
            },
            {
              label: t("Regenerate Token…") + (stateStore.isManaged("metaServerToken") ? t(" (set by the environment)") : ""),
              enabled: !stateStore.isManaged("metaServerToken"),
              click: () => deps.metaServer.regenerateToken(),
            },
          ],
        },
        {
          // Bring-your-own OAuth client: no KKSS-owned credentials are baked
          // in, so every provider starts at "set a client ID" rather than at a
          // confusing failure inside the consent flow.
          label: t("Cloud Accounts"),
          submenu: cloudAccountsSubmenu(deps),
        },
      ],
    },
    {
      label: t("&Help"),
      submenu: [
        { label: t("KKSS Documentation"), click: () => void shell.openExternal(DOCS_URL) },
        {
          label: t("CAD-Preview (pre-processing submodule)"),
          click: () => void shell.openExternal("https://github.com/loumalouomega/CAD-Preview"),
        },
        {
          label: t("VSCode-MDPA-Preview (post-processing submodule)"),
          click: () => void shell.openExternal("https://github.com/loumalouomega/VSCode-MDPA-Preview"),
        },
        { type: "separator" },
        { label: t("What's New…"), click: () => showChangelog() },
        { label: t("About KKSS…"), click: () => showAbout() },
      ],
    },
  ]);

  Menu.setApplicationMenu(menu);
}
