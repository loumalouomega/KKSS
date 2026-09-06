/**
 * Native application menu. Mirrors the two extensions' contributed commands:
 *   cad:  cad-preview.open/save/saveAs/export  (Ctrl+O/S/Shift+S/E)
 *   mesh: kratos.mesh.open/save/saveAs/export, kratos.mdpa.resetCamera/
 *         toggleNodeIds/computeQuality/fieldVisualization/findEntity
 * File actions dispatch to whichever mode is active at click time.
 */
import { app, Menu, shell } from "electron";
import type { MainWindow } from "./windows";
import { CAD_DEFAULT_KEYS, type CadHost } from "./cadHost";
import {
  DEFAULT_VIEWER_DEFAULTS,
  type MeshSizePreset,
  type UpAxis,
} from "../../cad/src/viewerDefaults";
import {
  DEFAULT_TESSELLATION_QUALITY,
  type TessellationQuality,
} from "../../cad/src/tessellationQuality";
import type { MeshHost } from "./mesh/meshHost";
import type { Mode, Screen } from "./ipc";
import { showQuickPick, showInputBox } from "./services/quickPick";
import { showAbout } from "./services/about";
import { showChangelog } from "./services/whatsNew";
import { stateStore } from "./services/stateStore";
import type { CloudStatus } from "./services/cloud/cloudService";
import { PROVIDER_LABELS, type ProviderId } from "./services/cloud/cloudCore";
import { hasSecret, setSecret } from "./services/chat/secrets";
import { LLM_KEYS } from "./services/chat/chatService";
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
  /** File ▸ Close Tab. */
  closeTab(mode: Mode, tabId: string): void;
  toggleTerminal(): void;
  toggleChat(): void;
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
  /** HTTP meta MCP server controls (see index.ts). */
  metaServer: {
    enabled(): boolean;
    setEnabled(enabled: boolean): void;
    copyConfig(): void;
    regenerateToken(): void;
  };
}

/** Scene themes understood by the viewers (mesh provider's own value set). */
const SCENE_THEMES: Array<{ value: string; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "scientific", label: "Scientific" },
];

/** CAD viewer default up-axis / mesh-size preset (cad's ViewerDefaults). */
const CAD_UP_AXES: Array<{ value: UpAxis; label: string }> = [
  { value: "y", label: "Y up" },
  { value: "z", label: "Z up" },
];
const CAD_MESH_SIZE_PRESETS: Array<{ value: MeshSizePreset; label: string }> = [
  { value: "coarse", label: "Coarse" },
  { value: "medium", label: "Medium" },
  { value: "fine", label: "Fine" },
];
/** B-rep tessellation quality (cad 1.2.6) — trades detail against load time. */
const CAD_TESSELLATION_QUALITIES: Array<{ value: TessellationQuality; label: string }> = [
  { value: "draft", label: "Draft (fastest)" },
  { value: "standard", label: "Standard" },
  { value: "fine", label: "Fine (most detail)" },
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

/** Secret entry: never prefills the stored value; empty input clears it. */
async function promptSecret(key: string, title: string, placeHolder: string): Promise<void> {
  const value = await showInputBox({
    title,
    prompt: hasSecret(key) ? "Currently configured — enter a new key to replace it, or leave empty to clear." : undefined,
    placeHolder,
  });
  if (value === undefined) return; // cancelled
  await setSecret(key, value.trim());
}

/** Plain setting entry, prefilled with the current (or default) value. */
async function promptValue(key: string, title: string, defaultValue: string): Promise<void> {
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
            ? `Connected as ${status.account?.label ?? "?"}`
            : status.hasClientId
              ? "Not connected"
              : "Client ID not set",
          enabled: false,
        },
        { type: "separator" },
        {
          label: "Client ID…",
          click: () => void promptCloudClientId(deps, status),
        },
        {
          label: status.needsClientSecret ? "Client Secret…" : "Client Secret… (optional)",
          click: () => void promptCloudSecret(deps, status),
        },
        { type: "separator" },
        {
          label: status.connected ? "Reconnect…" : "Connect…",
          enabled: status.hasClientId,
          click: () => deps.cloud.connect(status.id),
        },
        {
          label: "Disconnect…",
          enabled: status.connected,
          click: () => deps.cloud.disconnect(status.id),
        },
      ],
    });
  }
  items.push(
    { type: "separator" },
    {
      label: `Cache Size Limit… (${deps.cloud.cacheLimitMb()} MB)`,
      click: () => void promptCacheLimit(deps),
    },
    { label: "Clear Cloud Cache…", click: () => deps.cloud.clearCache() }
  );
  return items;
}

async function promptCloudClientId(deps: MenuDeps, status: CloudStatus): Promise<void> {
  const value = await showInputBox({
    title: `${status.label} Client ID`,
    // The redirect URI is the single most common setup mistake, so it is stated
    // here rather than left to the docs.
    prompt: `Create a desktop/installed-app OAuth client in your ${status.label} console with redirect URI ${deps.cloud.redirectHint(status.id)}, then paste its client ID. Leave empty to clear.`,
  });
  if (value === undefined) return; // cancelled
  deps.cloud.setClientId(status.id, value.trim() || undefined);
}

async function promptCloudSecret(deps: MenuDeps, status: CloudStatus): Promise<void> {
  const value = await showInputBox({
    title: `${status.label} Client Secret`,
    prompt: status.needsClientSecret
      ? "Required for this provider's desktop clients. Stored encrypted. Leave empty to clear."
      : "Not needed for this provider (PKCE public client). Leave empty to clear.",
  });
  if (value === undefined) return; // cancelled
  deps.cloud.setClientSecret(status.id, value.trim());
}

async function promptCacheLimit(deps: MenuDeps): Promise<void> {
  const value = await showInputBox({
    title: "Cloud Cache Size Limit (MB)",
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
      { placeHolder: "Export mesh as…" }
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
    if (entries.length === 0) return [{ label: "No Recent Files", enabled: false }];
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
      { label: "Clear Recent", click: () => deps.recentFiles.clear() },
    ];
  };

  const menu = Menu.buildFromTemplate([
    {
      label: "&File",
      submenu: [
        {
          // Scope, not a document — so it leads the File menu, above the
          // document group, and the label names the current root.
          label: deps.projectRoot.current()
            ? `Project Root: ${rootLabel(deps.projectRoot.current()!)}…`
            : "Open Folder…",
          toolTip: deps.projectRoot.current(),
          click: () => deps.projectRoot.choose(),
        },
        {
          label: "Clear Project Root",
          // Stays available for a stored-but-missing root (deleted or unmounted),
          // which `current()` hides but the user still needs to be able to drop.
          enabled: deps.projectRoot.isSet(),
          click: () => deps.projectRoot.clear(),
        },
        { type: "separator" },
        {
          label: "Open…",
          accelerator: "CmdOrCtrl+O",
          click: () => (inCad() ? void activeCadHost()?.openFileDialog() : void openMesh()),
        },
        {
          label: "Open Recent",
          submenu: recentFilesSubmenu(),
        },
        {
          // Degrades honestly rather than opening an empty picker: the label
          // itself says why it is unavailable.
          label: deps.cloud.isConnected()
            ? "Open from Cloud…"
            : "Open from Cloud… (no account connected)",
          enabled: deps.cloud.isConnected(),
          click: () => deps.cloud.openFromCloud(),
        },
        {
          label: "Open in Text Editor…",
          click: () => void editor.open(),
        },
        {
          label: "Save",
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
          label: "Save As…",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => {
            if (inEditor()) return editor.requestSave(true);
            inCad() ? activeCadHost()?.export() : void activeMeshHost()?.dispatchMenu({ type: "menuSaveAs" });
          },
        },
        {
          label: "Export…",
          accelerator: "CmdOrCtrl+E",
          click: () => (inCad() ? activeCadHost()?.export() : void meshExportPick()),
        },
        { type: "separator" },
        {
          // cad 1.10.0's cad-preview.new. Deliberately session-free upstream
          // ("must work with no CAD tab focused"), and it CREATES a document —
          // so it routes through onOpenRequest like the Open dialog rather than
          // needing a tab of its own first.
          label: "New Blank Model…",
          click: () => activeCadHost()?.newBlankModel(),
        },
        { type: "separator" },
        {
          label: "New CAD Tab",
          click: () => deps.newTab("cad"),
        },
        {
          label: "New Mesh Tab",
          click: () => deps.newTab("mesh"),
        },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => {
            const mode = main.mode();
            const id = main.activeTabId(mode);
            if (id) deps.closeTab(mode, id);
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
          label: "Reload from Disk",
          accelerator: "CmdOrCtrl+Alt+R",
          enabled: !inCad(),
          click: () => void activeMeshHost()?.dispatchReload(),
        },
        {
          // mesh 3.7.0's kratos.mesh.exportTable — Advanced ▸ Data table…
          // owns the in-viewport route; this is the palette-command parity.
          label: "Export Data Table…",
          enabled: !inCad(),
          click: () => void activeMeshHost()?.dispatchMenu({ type: "menuExportTable" }),
        },
        {
          // mesh 3.8.0's kratos.case.stop — the run manager's stop ladder
          // (SIGINT → SIGTERM → SIGKILL). Runs outlive the tab that started
          // them, so this is reachable whatever the focused tab shows.
          label: "Stop Kratos Run",
          enabled: !inCad(),
          click: () => void activeMeshHost()?.dispatchCase("stop"),
        },
        { type: "separator" },
        {
          label: "Save Problem…",
          accelerator: "CmdOrCtrl+Alt+S",
          click: () => void activeMeshHost()?.dispatchMenu({ type: "menuSaveProblem" }),
        },
        {
          label: "Load Problem…",
          accelerator: "CmdOrCtrl+Alt+O",
          click: () => void activeMeshHost()?.dispatchMenu({ type: "menuLoadProblem" }),
        },
        { type: "separator" },
        // The CAD counterpart: a .zip of the source + its sidecars. Load needs
        // no open document, so it is never mode-gated — both act on whichever
        // CAD tab is currently focused (any tab will do for Load, since it
        // hands off to the router rather than touching the tab's own document).
        { label: "Save Preprocess…", click: () => activeCadHost()?.savePreprocess() },
        { label: "Load Preprocess…", click: () => activeCadHost()?.loadPreprocess() },
        { type: "separator" },
        {
          // cad-preview.screenshot / kratos.mdpa.screenshot — both viewers gained
          // one in this submodule bump; dispatch to whichever mode is active.
          label: "Screenshot…",
          accelerator: "CmdOrCtrl+Alt+P",
          click: () =>
            inCad() ? activeCadHost()?.screenshot() : activeMeshHost()?.postToActive({ type: "takeScreenshot" }),
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
          // Interface scale: applies to every view + the chrome, persisted.
          // Ctrl+0 is "Home", so Reset uses Ctrl+Shift+0.
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          click: () => deps.zoom.stepIn(),
        },
        // Hidden twin so the unshifted "Ctrl+=" also zooms in (Plus needs Shift).
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          visible: false,
          click: () => deps.zoom.stepIn(),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: () => deps.zoom.stepOut(),
        },
        {
          label: "Reset Zoom",
          accelerator: "CmdOrCtrl+Shift+0",
          click: () => deps.zoom.reset(),
        },
        { type: "separator" },
        {
          label: "Toggle Terminal",
          accelerator: "CmdOrCtrl+`",
          click: () => deps.toggleTerminal(),
        },
        {
          label: "Toggle AI Chat",
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => deps.toggleChat(),
        },
        { type: "separator" },
        { label: "Reset Camera", click: () => activeMeshHost()?.postToActive({ type: "resetCamera" }) },
        { label: "Toggle Node IDs", click: () => activeMeshHost()?.postToActive({ type: "toggleNodeIds" }) },
        { type: "separator" },
        { label: "Toggle Developer Tools", accelerator: "CmdOrCtrl+Shift+I", click: () => {
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
          // The `cadPreview.*` settings the CAD viewer reads as its
          // cross-document defaults (CadHost.sendViewerDefaults). They only seed
          // a newly opened document — a per-document sidecar value or a runtime
          // toggle still wins. Background is intentionally absent: it needs a
          // colour picker, and the view-controls Appearance group already
          // offers one per session.
          label: "CAD Viewer Defaults",
          submenu: [
            {
              label: "Up Axis",
              submenu: CAD_UP_AXES.map((a) => ({
                label: a.label,
                type: "radio" as const,
                checked:
                  stateStore.get(CAD_DEFAULT_KEYS.upAxis, DEFAULT_VIEWER_DEFAULTS.upAxis) === a.value,
                click: () => void stateStore.update(CAD_DEFAULT_KEYS.upAxis, a.value),
              })),
            },
            {
              label: "Default Mesh Size",
              submenu: CAD_MESH_SIZE_PRESETS.map((p) => ({
                label: p.label,
                type: "radio" as const,
                checked:
                  stateStore.get(CAD_DEFAULT_KEYS.meshSizePreset, DEFAULT_VIEWER_DEFAULTS.meshSizePreset) ===
                  p.value,
                click: () => void stateStore.update(CAD_DEFAULT_KEYS.meshSizePreset, p.value),
              })),
            },
            {
              // Tessellation is re-read per B-rep load, so this applies on the
              // next edit or reopen — no restart.
              label: "Tessellation Quality",
              submenu: CAD_TESSELLATION_QUALITIES.map((q) => ({
                label: q.label,
                type: "radio" as const,
                checked:
                  stateStore.get(CAD_DEFAULT_KEYS.tessellationQuality, DEFAULT_TESSELLATION_QUALITY) ===
                  q.value,
                click: () => void stateStore.update(CAD_DEFAULT_KEYS.tessellationQuality, q.value),
              })),
            },
            {
              // cad 1.12.0's cadPreview.openscadBinary. Only consulted when a
              // .scad is opened; unset resolves `openscad` on PATH.
              label: "OpenSCAD Binary…",
              click: () =>
                void promptValue(
                  CAD_DEFAULT_KEYS.openscadBinary,
                  "OpenSCAD binary used to convert .scad sources to .csg on open (bare name = resolved on PATH)",
                  "openscad"
                ),
            },
            {
              label: "Show Grid && Axes on Open",
              type: "checkbox" as const,
              checked: stateStore.get(
                CAD_DEFAULT_KEYS.showGridAndAxes,
                DEFAULT_VIEWER_DEFAULTS.showGridAndAxes
              ),
              click: (item) => void stateStore.update(CAD_DEFAULT_KEYS.showGridAndAxes, item.checked),
            },
          ],
        },
        {
          // Reopens the last run's documents, screen and panels at launch.
          // Also skipped by KKSS_E2E (the harness launches the real app) and by
          // KKSS_NO_RESTORE=1 — see services/session.ts.
          label: "Restore Last Session",
          type: "checkbox" as const,
          checked: stateStore.get<boolean>(RESTORE_SESSION_KEY, true) !== false,
          click: (item) => void stateStore.update(RESTORE_SESSION_KEY, item.checked),
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
        {
          // All values are read per chat request — changes apply immediately,
          // no restart. API keys are stored safeStorage-encrypted (secrets.ts).
          label: "LLM Assistant",
          submenu: [
            {
              label: "Provider",
              submenu: [
                { value: "anthropic", label: "Anthropic (Claude)" },
                { value: "openai", label: "OpenAI-compatible" },
              ].map((p) => ({
                label: p.label,
                type: "radio" as const,
                checked: stateStore.get(LLM_KEYS.provider, "anthropic") === p.value,
                click: () => void stateStore.update(LLM_KEYS.provider, p.value),
              })),
            },
            { type: "separator" },
            {
              label: "Anthropic API Key…",
              click: () => void promptSecret(LLM_KEYS.anthropicKey, "Anthropic API Key", "sk-ant-…"),
            },
            {
              label: "Anthropic Model…",
              click: () => void promptValue(LLM_KEYS.anthropicModel, "Anthropic Model", DEFAULT_ANTHROPIC_MODEL),
            },
            { type: "separator" },
            {
              label: "OpenAI-compatible API Key…",
              click: () => void promptSecret(LLM_KEYS.openaiKey, "OpenAI-compatible API Key", "sk-… (leave empty for keyless backends like Ollama)"),
            },
            {
              label: "OpenAI-compatible Base URL…",
              click: () => void promptValue(LLM_KEYS.openaiBaseUrl, "OpenAI-compatible Base URL", DEFAULT_OPENAI_BASE_URL),
            },
            {
              label: "OpenAI-compatible Model…",
              click: () => void promptValue(LLM_KEYS.openaiModel, "OpenAI-compatible Model", DEFAULT_OPENAI_MODEL),
            },
          ],
        },
        {
          // Exposes the same cad+mesh+kratos toolset over a localhost HTTP MCP
          // endpoint so an external LLM client can drive KKSS. Off by default;
          // localhost-bound + bearer-token protected (these tools touch disk).
          label: "MCP Server",
          submenu: [
            {
              label: "Enable (external LLM access)",
              type: "checkbox" as const,
              checked: deps.metaServer.enabled(),
              click: (item) => deps.metaServer.setEnabled(item.checked),
            },
            { type: "separator" },
            {
              label: "Port…",
              // Applies on next enable (toggle off/on to rebind).
              click: () => void promptValue(META_SERVER_KEYS.port, "MCP Server Port", String(DEFAULT_META_SERVER_PORT)),
            },
            {
              label: "Copy Address & Token…",
              click: () => deps.metaServer.copyConfig(),
            },
            {
              label: "Regenerate Token…",
              click: () => deps.metaServer.regenerateToken(),
            },
          ],
        },
        {
          // Bring-your-own OAuth client: no KKSS-owned credentials are baked
          // in, so every provider starts at "set a client ID" rather than at a
          // confusing failure inside the consent flow.
          label: "Cloud Accounts",
          submenu: cloudAccountsSubmenu(deps),
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
        { label: "What's New…", click: () => showChangelog() },
        { label: "About KKSS…", click: () => showAbout() },
      ],
    },
  ]);

  Menu.setApplicationMenu(menu);
}
