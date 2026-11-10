// Why a menu item is disabled. One function per condition so
// the label suffix cannot drift from the `enabled` flag. Pure; the caller
// translates the returned key.
export type UnavailableKey =
  | "postOnly"
  | "needsMeshDocument"
  | "managed"
  | "noRemoteHosts"
  | "needsClientId"
  | "notConnected"
  | "noProjectRoot"
  | "noCadUndo";

export interface AvailabilityContext { mode: "cad" | "mesh"; screen: string; hasMeshFile: boolean }

/** Post-Processing-only actions (`enabled: !inCad()` in the menu). */
export function postProcessingOnly(ctx: AvailabilityContext): UnavailableKey | undefined {
  return ctx.mode === "cad" ? "postOnly" : undefined;
}

/** Actions that need an open mesh document on the Post-Processing screen. */
export function needsMeshDocument(ctx: AvailabilityContext): UnavailableKey | undefined {
  return ctx.screen === "mesh" && ctx.hasMeshFile ? undefined : "needsMeshDocument";
}

/** A setting pinned by the environment / secret file (stateStore.isManaged). */
export function managedSetting(isManaged: boolean): UnavailableKey | undefined {
  return isManaged ? "managed" : undefined;
}

/** Remote Shell needs at least one configured SSH host. */
export function needsRemoteHost(hostCount: number): UnavailableKey | undefined {
  return hostCount > 0 ? undefined : "noRemoteHosts";
}

/** Cloud Connect/Reconnect needs the provider's client ID first. */
export function needsClientId(hasClientId: boolean): UnavailableKey | undefined {
  return hasClientId ? undefined : "needsClientId";
}

/** Cloud Disconnect only makes sense for a connected account. */
export function needsConnection(connected: boolean): UnavailableKey | undefined {
  return connected ? undefined : "notConnected";
}

/** Clear Project Root: managed wins (the root cannot change), else needs a stored root. */
export function clearProjectRoot(isSet: boolean, isManaged: boolean): UnavailableKey | undefined {
  return managedSetting(isManaged) ?? (isSet ? undefined : "noProjectRoot");
}

export const UNAVAILABLE_SUFFIX = {
  postOnly: " (Post-Processing only)",
  needsMeshDocument: " (open a mesh first)",
  managed: " (set by the environment)",
  noRemoteHosts: " (no SSH hosts configured)",
  needsClientId: " (set the Client ID first)",
  notConnected: " (not connected)",
  noProjectRoot: " (no project folder set)",
  noCadUndo: " (not available for CAD documents yet)",
} as const satisfies Record<UnavailableKey, string>;

/** Labels that already explain themselves without going through a reason key. */
const SELF_EXPLAINING = [/\([^)]+\)\s*$/, /\s—\s.+$/];

/** Minimal structural view of an Electron menu item (template or live MenuItem). */
export interface MenuNode {
  label?: string;
  enabled?: boolean;
  id?: string;
  type?: string;
  role?: string;
  submenu?: MenuNode[] | { items: MenuNode[] };
}

/** Status rows that are disabled on purpose carry an `info:` id. */
export const INFO_ID_PREFIX = "info:";

/**
 * Static acceptance check: every disabled item that is not a separator or an
 * `info:` status row must end in a reason annotation. Returns the offending menu
 * paths. Works on `Menu.buildFromTemplate` input and on
 * `Menu.getApplicationMenu()` alike.
 */
export function unexplainedDisabledItems(items: MenuNode[], trail: string[] = []): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.type === "separator") continue;
    const label = (item.label ?? "").replace(/&/g, "");
    const here = [...trail, label || item.role || "?"];
    if (item.enabled === false && !item.id?.startsWith(INFO_ID_PREFIX)) {
      if (!SELF_EXPLAINING.some((re) => re.test(label))) out.push(here.join(" > "));
    }
    const sub = Array.isArray(item.submenu) ? item.submenu : item.submenu?.items;
    if (sub) out.push(...unexplainedDisabledItems(sub, here));
  }
  return out;
}
