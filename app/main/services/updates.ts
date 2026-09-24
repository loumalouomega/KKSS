import { t } from "../../shared/i18n";
/** Channel-aware, explicitly requested updates; each check owns its updater. */
import { app, net } from "electron";
import { AppImageUpdater, MacUpdater, NsisUpdater, type AppUpdater } from "electron-updater";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { AboutToWebview } from "../ipc";
import { RELEASES_URL } from "../urls";
import { stateStore } from "./stateStore";
import { evaluateReleaseTag, selectRelease, type Release, type UpdateChannel } from "./updateCheck";

type StatusSink = (status: AboutToWebview) => void;
let sink: StatusSink | null = null;
let generation = 0;
let active: { updater: AppUpdater; version: string; generation: number; downloading: boolean; downloaded: boolean; cancel: () => void } | undefined;
export function attachUpdateSink(s: StatusSink | null): void { sink = s; }
export function updateChannel(): UpdateChannel {
  return stateStore.get("updateChannel") === "prerelease" ? "prerelease" : "stable";
}
function invalidate(): number {
  generation++;
  if (active) {
    active.cancel();
    active.updater.autoInstallOnAppQuit = false;
    active.updater.removeAllListeners();
    active = undefined;
  }
  return generation;
}
export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  invalidate();
  sink?.({ type: "status", state: "checking" });
  await stateStore.update("updateChannel", channel);
  await checkForUpdate();
}
export function canAutoUpdate(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === "win32") return true;
  if (process.platform === "linux") return Boolean(process.env.APPIMAGE);
  if (process.platform === "darwin") {
    try {
      const marker = JSON.parse(readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")).kkssSignedRelease;
      return marker === true || marker === "1" || marker === "true";
    } catch { return false; }
  }
  return false;
}

export async function checkForUpdate(): Promise<void> {
  if (active?.downloading || active?.downloaded) return;
  const epoch = invalidate();
  const channel = updateChannel();
  sink?.({ type: "status", state: "checking" });
  let offered: string | undefined;
  try {
    const releases: Release[] = [];
    // Follow pagination so prerelease-heavy histories do not hide stable releases.
    for (let page = 1; ; page++) {
      const res = await net.fetch(`https://api.github.com/repos/loumalouomega/KKSS/releases?per_page=100&page=${page}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "KKSS" },
        signal: AbortSignal.timeout(10_000),
      });
      if (epoch !== generation) return;
      if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
      const rows = await res.json() as Release[];
      if (!Array.isArray(rows)) throw new Error("Invalid release response");
      releases.push(...rows);
      if (!res.headers.get("link")?.includes('rel="next"')) break;
    }
    const release = selectRelease(releases, app.getVersion(), channel);
    if (epoch !== generation) return;
    if (!release) { sink?.({ type: "status", state: "upToDate" }); return; }
    const result = evaluateReleaseTag(release.tag_name, app.getVersion());
    if (result.state !== "available") return;
    offered = result.latestVersion;
    if (!canAutoUpdate()) {
      sink?.({ type: "status", state: "available", latestVersion: offered, canAutoUpdate: false });
      return;
    }
    const updater = process.platform === "win32" ? new NsisUpdater() :
      process.platform === "darwin" ? new MacUpdater() : new AppImageUpdater();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = channel === "prerelease";
    updater.allowDowngrade = false;
    // Pin the feed to the selected immutable release, including its channel.
    updater.setFeedURL({ provider: "generic", url: `${RELEASES_URL}/download/${encodeURIComponent(release.tag_name)}/` });
    updater.on("error", () => {}); // async calls below own user-facing errors
    const selected = await updater.checkForUpdates();
    if (epoch !== generation) return;
    if (!selected || selected.updateInfo.version !== offered) throw new Error("Release metadata does not match the offered version");
    active = { updater, version: offered, generation: epoch, downloading: false, downloaded: false, cancel: () => {} };
    updater.on("download-progress", progress => {
      if (epoch === generation) sink?.({ type: "status", state: "downloading", latestVersion: offered, percent: Math.round(progress.percent) });
    });
    sink?.({ type: "status", state: "available", latestVersion: selected.updateInfo.version, canAutoUpdate: true });
  } catch (error) {
    if (epoch !== generation) return;
    sink?.(offered ? { type: "status", state: "available", latestVersion: offered, canAutoUpdate: false, message: t("Automatic update unavailable ({0})", {0: String(error)}) }
      : { type: "status", state: "error", message: t("Couldn't check for updates — are you offline?") });
  }
}

export async function downloadUpdate(): Promise<void> {
  const request = active;
  if (!request || request.downloading || request.downloaded) return;
  request.downloading = true;
  sink?.({ type: "status", state: "downloading", latestVersion: request.version, percent: 0 });
  try {
    await request.updater.downloadUpdate();
    if (request.generation !== generation) return;
    request.downloaded = true;
    sink?.({ type: "status", state: "downloaded", latestVersion: request.version });
  } catch (error) {
    if (request.generation !== generation) return;
    active = undefined;
    sink?.({ type: "status", state: "available", latestVersion: request.version, canAutoUpdate: false, message: t("Automatic update failed ({0})", {0: String(error)}) });
  } finally { request.downloading = false; }
}
export function installUpdate(): void {
  if (active?.downloaded && active.generation === generation) active.updater.quitAndInstall();
}
