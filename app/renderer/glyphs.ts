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
  // Thinking level: a brain — two mirrored hemispheres, a midline and a fold each.
  // Named `thinkBrain` so it can never shadow a glyph of cad's set.
  thinkBrain: g(
    '<path d="M12 4.5C11 3 9 2.5 7.5 3.5S5.5 6 6 7c-2 .5-3 2.5-2.5 4.5.3 1.2 1 2 2 2.5-.3 1.7.6 3.3 2.3 3.8 1.2.3 2.7.2 4.2 1.7Z"/>' +
      '<path d="M12 4.5C13 3 15 2.5 16.5 3.5S18.5 6 18 7c2 .5 3 2.5 2.5 4.5-.3 1.2-1 2-2 2.5.3 1.7-.6 3.3-2.3 3.8-1.2.3-2.7.2-4.2 1.7Z"/>' +
      '<path d="M8.5 10c1.2 0 2.2.7 2.7 1.8"/><path d="M15.5 10c-1.2 0-2.2.7-2.7 1.8"/>'
  ),
  // Provider marks for the chat sidebar. Deliberately our own simple glyphs in
  // the app's line style, not the vendors' trademarked logos: they tell the
  // providers apart at 14px and adapt to every theme through currentColor.
  providerAnthropic: g('<path d="M12 3v18"/><path d="m4.2 7.5 15.6 9"/><path d="m4.2 16.5 15.6-9"/>'),
  providerOpenai: g('<path d="M12 3 19.8 7.5v9L12 21l-7.8-4.5v-9Z"/><path d="M12 3v6.5m7.8 0L12 12m-7.8-2.5L12 12v9"/>'),
  providerOpencode: g('<path d="m9 7-5 5 5 5"/><path d="m15 7 5 5-5 5"/><path d="M13.5 5.5 10.5 18.5"/>'),
  providerCodex: g('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m8 10 3 2-3 2"/><path d="M13 15h3"/>'),
  providerClaudeCode: g('<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7Z"/><path d="M5 21h6"/>'),
} as const;

export const KKSS_UI_GLYPHS = { ...CAD_GLYPHS, ...KKSS_GLYPHS } as const;
export type KkssGlyphId = keyof typeof KKSS_UI_GLYPHS;

/** `<span class="ui-glyph">` wrapping one glyph; `size` adds the px-size modifier. */
export function glyph(id: KkssGlyphId, size?: "sm" | "lg"): string {
  return `<span class="ui-glyph${size ? ` ${size}` : ""}">${KKSS_UI_GLYPHS[id]}</span>`;
}
