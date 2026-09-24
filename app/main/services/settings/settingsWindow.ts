import { t } from "../../../shared/i18n";
/**
 * Settings ▸ Open Settings… (Ctrl+,) — a VS Code-style settings page in its
 * own singleton window, backed by app/renderer/settings/.
 *
 * The page is schema-driven: it renders whatever the registry holds, and every
 * write comes back here to be validated (`toStored`) before it reaches the
 * stateStore. Most entries are plain store writes; the few with side effects
 * (zoom, the update channel, the MCP server, cloud accounts, the approval gate,
 * secrets) route through the same functions the native menu calls, so the page
 * never re-implements an action. Rows are re-sent on every stateStore change,
 * which is also what keeps the page and the menu in step.
 *
 * Secrets: the renderer submits a new value (a password field) but only ever
 * receives `isSet` — no stored secret is sent to it.
 */
import { BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";
import type { SettingsRowState, SettingsToHost, SettingsToWebview } from "../../ipc";
import { stateStore } from "../stateStore";
import { hasSecret, setSecret } from "../chat/secrets";
import { showOpenDialog } from "../dialogs";
import { setUpdateChannel } from "../updates";
import { confirmApprovalOff } from "../../menu";
import { CATEGORIES, effective, entryById, normalize, registry, toStored, type SettingEntry } from "./registry";
import { kratosInstallProblem } from "./kratosEnv";
import type { CloudStatus } from "../cloud/cloudService";
import type { ProviderId } from "../cloud/cloudCore";

export interface SettingsDeps {
  setZoom(factor: number): void;
  projectRoot: { explicit(): string | undefined; choose(): void; clear(): void };
  metaServer: { setEnabled(enabled: boolean): void; copyConfig(): void; regenerateToken(): void };
  cloud: {
    statuses(): CloudStatus[];
    setClientId(id: ProviderId, value: string | undefined): void;
    setClientSecret(id: ProviderId, value: string): void;
    connect(id: ProviderId): void;
    disconnect(id: ProviderId): void;
    setCacheLimitMb(value: number | undefined): void;
    clearCache(): void;
  };
  restartKratos(): void;
  checkSimulationEnvironment?(): void;
}

let outDir = "";
let deps: SettingsDeps | undefined;
let win: BrowserWindow | null = null;

function send(message: SettingsToWebview): void {
  if (win && !win.isDestroyed()) win.webContents.send("settings:toWebview", message);
}

function cloudId(entry: SettingEntry): ProviderId | undefined {
  const m = /^cloud\.(gdrive|dropbox|onedrive)\./.exec(entry.id);
  return m ? (m[1] as ProviderId) : undefined;
}

function rowState(entry: SettingEntry, cloud: CloudStatus[]): SettingsRowState {
  const managed = entry.storeKey ? stateStore.isManaged(entry.storeKey) : false;
  if (entry.type === "secret") {
    const isSet = hasSecret(entry.storeKey!);
    return { managed, modified: isSet, isSet };
  }
  if (entry.type === "action") {
    const row: SettingsRowState = { managed, modified: false };
    if (entry.id === "general.projectRoot") {
      const root = deps?.projectRoot.explicit();
      row.status = root ?? t("Not set — the focused document's folder is used.");
      row.modified = !!root;
      if (!root) row.disabledActions = ["clear"];
    }
    const id = cloudId(entry);
    if (id) {
      const s = cloud.find((c) => c.id === id);
      row.status = s?.connected
        ? t("Connected as {0}", {0: s.account?.label ?? "?"})
        : s?.hasClientId
          ? t("Not connected")
          : t("Set a client ID first");
      row.disabledActions = [...(s?.hasClientId ? [] : ["connect"]), ...(s?.connected ? [] : ["disconnect"])];
    }
    return row;
  }
  const stored = stateStore.get(entry.storeKey!);
  // "Modified" = something other than the default would be persisted.
  const persisted = normalize(entry, stored) === undefined ? undefined : toStored(entry, stored);
  const row: SettingsRowState = {
    managed,
    value: effective(entry, stored),
    modified: !!persisted?.ok && persisted.value !== undefined,
  };
  if (entry.id === "kratos.installPath") row.warning = kratosInstallProblem();
  return row;
}

function sendRows(): void {
  if (!win || win.isDestroyed()) return;
  const cloud = deps?.cloud.statuses() ?? [];
  const rows: Record<string, SettingsRowState> = {};
  for (const entry of registry()) rows[entry.id] = rowState(entry, cloud);
  send({ type: "rows", rows });
}

/** Writes one validated value, through the side-effecting setter where one exists. */
async function applyValue(entry: SettingEntry, raw: unknown): Promise<void> {
  if (!deps || !entry.storeKey || stateStore.isManaged(entry.storeKey)) return;
  if (entry.type === "secret") {
    const value = typeof raw === "string" ? raw.trim() : "";
    const id = cloudId(entry);
    if (id) deps.cloud.setClientSecret(id, value);
    else await setSecret(entry.storeKey, value);
    return;
  }
  const stored = toStored(entry, raw);
  if (!stored.ok) {
    sendRows(); // put the control back — first, since a row update clears its error
    send({ type: "error", id: entry.id, message: t("That value is not valid for this setting.") });
    return;
  }
  const value = stored.value;
  switch (entry.id) {
    case "appearance.zoom":
      deps.setZoom(Number(value ?? entry.default));
      return;
    case "general.updateChannel":
      await setUpdateChannel(value === "prerelease" ? "prerelease" : "stable");
      return;
    case "llm.toolApproval":
      if (value === "never" && !(await confirmApprovalOff())) {
        sendRows();
        return;
      }
      break;
    case "mcpServer.enabled":
      deps.metaServer.setEnabled(value === true);
      return;
    case "cloud.cacheLimitMb":
      deps.cloud.setCacheLimitMb(value as number | undefined);
      return;
  }
  const id = cloudId(entry);
  if (id && entry.id.endsWith(".clientId")) {
    deps.cloud.setClientId(id, value as string | undefined);
    return;
  }
  await stateStore.update(entry.storeKey, value);
}

function runAction(entry: SettingEntry, action: string): void {
  if (!deps) return;
  const id = cloudId(entry);
  switch (`${id ? "cloud.*.account" : entry.id}:${action}`) {
    case "general.projectRoot:choose":
      return deps.projectRoot.choose();
    case "general.projectRoot:clear":
      return deps.projectRoot.clear();
    case "kratos.tools:restart":
      return deps.restartKratos();
    case "kratos.environment:check":
      return deps.checkSimulationEnvironment?.();
    case "mcpServer.token:copy":
      return deps.metaServer.copyConfig();
    case "mcpServer.token:regenerate":
      return deps.metaServer.regenerateToken();
    case "cloud.*.account:connect":
      return deps.cloud.connect(id!);
    case "cloud.*.account:disconnect":
      return deps.cloud.disconnect(id!);
    case "cloud.cache:clear":
      return deps.cloud.clearCache();
  }
}

async function browse(entry: SettingEntry): Promise<void> {
  if (entry.type !== "path" || !win) return;
  const current = effective(entry, stateStore.get(entry.storeKey!));
  const picked = await showOpenDialog({
    title: entry.label,
    canSelectFolders: entry.pathKind === "folder",
    defaultPath: typeof current === "string" && path.isAbsolute(current) ? current : undefined,
  });
  if (picked?.[0]) await applyValue(entry, picked[0]);
}

export function configureSettings(dir: string, d: SettingsDeps): void {
  outDir = dir;
  deps = d;
  ipcMain.on("settings:toHost", (event, raw) => {
    if (!win || event.sender !== win.webContents) return;
    const msg = raw as SettingsToHost;
    if (msg.type === "settingsReady") {
      send({ type: "schema", categories: CATEGORIES, entries: registry() });
      sendRows();
      return;
    }
    const entry = entryById(msg.id);
    if (!entry) return;
    switch (msg.type) {
      case "set":
        void applyValue(entry, msg.value);
        break;
      case "reset":
        void applyValue(entry, entry.type === "secret" ? "" : entry.default);
        break;
      case "browse":
        void browse(entry);
        break;
      case "action":
        runAction(entry, msg.action);
        break;
    }
  });
  stateStore.onDidChange(() => sendRows());
}

/** Re-sends the rows — for state that lives outside the stateStore's events
 *  (cloud connection, the project root's existence). */
export function refreshSettingsRows(): void {
  sendRows();
}

export function showSettings(): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 620,
    minHeight: 420,
    title: t("Settings"),
    autoHideMenuBar: true,
    icon: path.join(outDir, "icon.png"),
    webPreferences: {
      preload: path.join(outDir, "preload", "settingsPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.on("closed", () => {
    win = null;
  });
  void win.loadURL("kkss://app/renderer/settings/index.html");
}
