/**
 * Update availability + delivery for the About dialog.
 *
 * Availability is checked against the GitHub REST API (releases/latest) with
 * a semver compare, so it works everywhere — dev runs included. Delivery uses
 * electron-updater's GitHub provider, which only works on install types that
 * ship an update feed and can self-replace: the NSIS install on Windows and
 * the AppImage on Linux (deb installs and the unsigned macOS builds fall back
 * to the releases page). electron-updater reads resources/app-update.yml,
 * emitted by electron-builder because electron-builder.yml has a `publish`
 * block, and expects the latest*.yml feed files attached to each GitHub
 * Release (uploaded by .github/workflows/release.yml).
 */
import { app, net } from "electron";
import { autoUpdater } from "electron-updater";
import type { AboutToWebview } from "../ipc";
import { LATEST_RELEASE_API_URL } from "../urls";
import { evaluateReleaseTag } from "./updateCheck";

type StatusSink = (status: AboutToWebview) => void;

let sink: StatusSink | null = null;
let latestVersion: string | undefined;
let updaterWired = false;

/** Points update statuses at the currently open About dialog (null on close). */
export function attachUpdateSink(s: StatusSink | null): void {
  sink = s;
}

/** In-app download+install is only possible where the app can self-replace. */
export function canAutoUpdate(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === "win32") return true;
  if (process.platform === "linux") return Boolean(process.env.APPIMAGE);
  return false; // macOS: unsigned builds fail Squirrel.Mac signature validation
}

export async function checkForUpdate(): Promise<void> {
  sink?.({ type: "status", state: "checking" });
  let tag: string;
  try {
    const res = await net.fetch(LATEST_RELEASE_API_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "KKSS" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
    tag = ((await res.json()) as { tag_name?: string }).tag_name ?? "";
  } catch {
    sink?.({ type: "status", state: "error", message: "Couldn't check for updates — are you offline?" });
    return;
  }
  const result = evaluateReleaseTag(tag, app.getVersion());
  if (result.state === "invalid") {
    sink?.({ type: "status", state: "error", message: `Unrecognized release tag "${tag}"` });
    return;
  }
  if (result.state === "upToDate") {
    sink?.({ type: "status", state: "upToDate" });
    return;
  }
  latestVersion = result.latestVersion;
  sink?.({ type: "status", state: "available", latestVersion, canAutoUpdate: canAutoUpdate() });
}

/** Any updater failure degrades to the releases-page button, never a crash. */
function wireUpdaterEvents(): void {
  if (updaterWired) return;
  updaterWired = true;
  autoUpdater.autoDownload = false;
  autoUpdater.on("download-progress", (progress) => {
    sink?.({ type: "status", state: "downloading", latestVersion, percent: Math.round(progress.percent) });
  });
  autoUpdater.on("update-downloaded", () => {
    sink?.({ type: "status", state: "downloaded", latestVersion });
  });
  autoUpdater.on("error", (err) => {
    sink?.({
      type: "status",
      state: "available",
      latestVersion,
      canAutoUpdate: false,
      message: `Automatic update failed (${err.message})`,
    });
  });
}

export async function downloadUpdate(): Promise<void> {
  if (!canAutoUpdate()) {
    sink?.({ type: "status", state: "available", latestVersion, canAutoUpdate: false });
    return;
  }
  wireUpdaterEvents();
  sink?.({ type: "status", state: "downloading", latestVersion, percent: 0 });
  try {
    await autoUpdater.checkForUpdates(); // loads the feed's UpdateInfo first
    await autoUpdater.downloadUpdate();
  } catch {
    // The "error" event above already reported it to the dialog.
  }
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall();
}
