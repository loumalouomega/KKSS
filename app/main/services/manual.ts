/**
 * The full-window in-app manual — Help ▸ KKSS Manual… opens the documentation
 * site served from `out/docs` (services/docsServe.ts, the pure half; the
 * `kkss://docs/*` branch in protocol.ts serves the built pages) in its own
 * window. Singleton like every other Help window: a second menu click only
 * focuses the existing one.
 *
 * The manual is the app's own content, but it still behaves like a hosted
 * site in one way: navigations away from `kkss://docs` (the VitePress spa
 * uses pushState for internal pages, so any full navigation is the rewritten
 * example-download links and outside URLs) open in the OS browser instead of
 * replacing the manual window's content.
 */
import { BrowserWindow, nativeTheme, shell } from "electron";
import { t } from "../../shared/i18n";
import { SITE_BASE } from "./docsServe";

let manualWin: BrowserWindow | null = null;

/**
 * The protocol branch serves every manual URL from one host label. The URL
 * keeps the site's own base path (`/KKSS/…`) — VitePress's client router
 * resolves against `location.pathname` and 404s when the base is missing, so
 * the base stays in the URL and the protocol handler strips it when mapping
 * to disk (see protocol.ts).
 */
export const MANUAL_ROOT_URL = `kkss://docs${SITE_BASE}/index.html`;

export function showManual(): void {
  if (manualWin && !manualWin.isDestroyed()) {
    manualWin.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    resizable: true,
    title: t("KKSS Manual"),
    // Avoid a white flash on dark themes before the site's own CSS lands.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  manualWin = win;

  // Keep the title the page would otherwise overwrite mid-navigation.
  win.on("page-title-updated", (event) => event.preventDefault());

  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("kkss://docs")) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  win.on("closed", () => {
    manualWin = null;
  });
  void win.loadURL(MANUAL_ROOT_URL);
}
