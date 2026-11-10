// Pure policy for the app-wide renderer guard (webGuard.ts is the Electron glue).
// Nothing here touches Electron, so every decision is unit-tested.

/** Schemes an app page may legitimately navigate to or load into itself. */
const INTERNAL_HOSTS: Record<string, readonly string[] | true> = {
  "kkss:": ["app", "docs"],
  "kkss-file:": true,
  "devtools:": true,
  "about:": true,
};

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * May this web contents navigate itself to `url`? Only the app's own schemes
 * qualify. `kkss://docs` is the manual's alone — no other page may jump there
 * (and the manual's own navigation handler stays stricter still).
 */
export function allowNavigation(url: string, opts: { docsView?: boolean } = {}): boolean {
  const u = parse(url);
  if (!u) return false;
  const rule = INTERNAL_HOSTS[u.protocol];
  if (!rule) return false;
  if (rule === true) return true;
  if (u.protocol === "kkss:" && u.hostname === "docs") return !!opts.docsView;
  return rule.includes(u.hostname);
}

const EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:"]);

/**
 * Should `window.open` / a target=_blank link hand this URL to the OS browser?
 * Only web and mail links; `file:`, `javascript:`, `data:` and the app's own
 * schemes are never forwarded (a page that wants one of those is not a link).
 */
export function externalOpen(url: string): boolean {
  const u = parse(url);
  return !!u && EXTERNAL_SCHEMES.has(u.protocol);
}

/**
 * Permissions a page may hold without asking: everything is denied unless
 * listed. Each entry says why; adding one is a reviewed decision (the WebHID
 * 3D-mouse item is the planned exception, scoped to one vendor id).
 */
export const ALLOWED_PERMISSIONS: Readonly<Record<string, string>> = {
  "clipboard-sanitized-write": "copy buttons in the viewers and chat",
  fullscreen: "View ▸ Full Screen and viewer full-screen buttons",
  pointerLock: "orbit controls that capture the pointer while dragging",
};

export function permissionAllowed(permission: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_PERMISSIONS, permission);
}
