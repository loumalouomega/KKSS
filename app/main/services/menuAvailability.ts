// Why a menu item is disabled (roadmap item 11). One function per condition so
// the label suffix cannot drift from the `enabled` flag. Pure; the caller
// translates the returned key.
export type UnavailableKey = "postOnly" | "needsMeshDocument";

export interface AvailabilityContext { mode: "cad" | "mesh"; screen: string; hasMeshFile: boolean }

/** Post-Processing-only actions (`enabled: !inCad()` in the menu). */
export function postProcessingOnly(ctx: AvailabilityContext): UnavailableKey | undefined {
  return ctx.mode === "cad" ? "postOnly" : undefined;
}

/** Actions that need an open mesh document on the Post-Processing screen. */
export function needsMeshDocument(ctx: AvailabilityContext): UnavailableKey | undefined {
  return ctx.screen === "mesh" && ctx.hasMeshFile ? undefined : "needsMeshDocument";
}

export const UNAVAILABLE_SUFFIX = {
  postOnly: " (Post-Processing only)",
  needsMeshDocument: " (open a mesh first)",
} as const satisfies Record<UnavailableKey, string>;
