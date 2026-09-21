/**
 * The line-glyph set for KKSS's own chrome. Re-exported from CAD-Preview's
 * `src/uiGlyphs.ts` (vscode-free and DOM-free) rather than copied, so the app,
 * the CAD viewer and — by the same recipe — the mesh viewer stay one visual
 * family with one source of truth. The submodule is not modified; a glyph KKSS
 * needs that cad lacks goes in `KKSS_GLYPHS` below.
 *
 * Same contract as the generated `shell/shellIcons.ts` (which stays for the mode,
 * home and toolbar icons): currentColor only, sized by `.ui-glyph`.
 */
import { UI_GLYPHS as CAD_GLYPHS } from "../../cad/src/uiGlyphs";

const OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const g = (body: string): string => `${OPEN}${body}</svg>`;

/** Glyphs the app chrome needs that CAD-Preview's set does not have. Same drawing
 *  style (24-unit box, 2px round stroke), so they sit beside cad's without a seam. */
const KKSS_GLYPHS = {
  x: g('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  more: g('<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>'),
  menu: g('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>'),
  send: g('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>'),
  square: g('<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/>'),
  refresh: g('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  history: g('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
  messageSquare: g('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
  listChecks: g('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'),
  folder: g('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  terminal: g('<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>'),
} as const;

export const KKSS_UI_GLYPHS = { ...CAD_GLYPHS, ...KKSS_GLYPHS } as const;
export type KkssGlyphId = keyof typeof KKSS_UI_GLYPHS;

/** `<span class="ui-glyph">` wrapping one glyph; `size` adds the px-size modifier. */
export function glyph(id: KkssGlyphId, size?: "sm" | "lg"): string {
  return `<span class="ui-glyph${size ? ` ${size}` : ""}">${KKSS_UI_GLYPHS[id]}</span>`;
}
