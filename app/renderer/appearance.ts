/**
 * The page-side view of app/preload/appearance.ts's bridge — declared once
 * here so every renderer that reads it (terminal, editor, the view shim)
 * agrees on its type.
 */
import type { Appearance } from "../main/services/appearanceCore";

export type { Appearance };

declare global {
  interface Window {
    kkssAppearance?: {
      current(): Appearance | undefined;
      onChange(handler: (a: Appearance) => void): void;
    };
  }
}
