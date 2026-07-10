/**
 * Custom URL schemes.
 *
 *  kkss://app/<path>          — app assets, served only from out/ (this
 *                               bundle's directory). Used for the shell,
 *                               picker, and the two webview pages.
 *  kkss-file://local/<enc>    — user files, served only from registered
 *                               allowed roots (the open document's directory).
 *                               Electron's replacement for VS Code's
 *                               asWebviewUri/localResourceRoots pair; cad's
 *                               "loadUrl" strategy fetches these.
 */
import { protocol, net } from "electron";
import * as path from "path";
import { pathToFileURL } from "url";
import { isInsideRoot, isPathAllowed } from "./pathGuard";

const allowedRoots = new Set<string>();

/** Must run before app.whenReady(). */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "kkss", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: "kkss-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/** Allow serving files under `dir` via kkss-file:// (mirrors localResourceRoots). */
export function allowRoot(dir: string): void {
  allowedRoots.add(path.resolve(dir));
}

export function toKkssUrl(fsPath: string): string {
  return `kkss-file://local/${encodeURIComponent(path.resolve(fsPath))}`;
}

function isAllowed(fsPath: string): boolean {
  return isPathAllowed(allowedRoots, fsPath);
}

/** Must run after app.whenReady(). `outDir` is the bundle dir (out/). */
export function installProtocolHandlers(outDir: string): void {
  const appRoot = path.resolve(outDir);

  protocol.handle("kkss", (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname);
    const fsPath = path.normalize(path.join(appRoot, rel));
    if (!isInsideRoot(appRoot, fsPath)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(fsPath).toString());
  });

  protocol.handle("kkss-file", (request) => {
    const url = new URL(request.url);
    const fsPath = path.resolve(decodeURIComponent(url.pathname.replace(/^\//, "")));
    if (!isAllowed(fsPath)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(fsPath).toString());
  });
}
