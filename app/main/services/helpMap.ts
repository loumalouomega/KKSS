// F1 context help (roadmap item 12): which manual page and section explains the
// focused screen. Pure; test/helpMap.test.ts checks every target against the
// guide's own headings so a renamed section fails CI instead of 404-ing in-app.
export type HelpContext = "home" | "editor" | "cad" | "mesh" | "terminal" | "chat" | "jobs" | "settings";

export interface HelpTarget { page: string; anchor?: string }

export const HELP_TARGETS: Readonly<Record<HelpContext, HelpTarget>> = {
  home: { page: "getting-started", anchor: "the-home-screen" },
  editor: { page: "getting-started", anchor: "text-editor" },
  cad: { page: "cad-mode", anchor: "reading-the-window-at-a-glance" },
  mesh: { page: "mesh-mode", anchor: "reading-the-window-at-a-glance" },
  terminal: { page: "getting-started", anchor: "embedded-terminal" },
  chat: { page: "getting-started", anchor: "ai-assistant" },
  jobs: { page: "getting-started", anchor: "kratos-background-jobs" },
  settings: { page: "configuration" },
};

/** VitePress heading slug, close enough for ASCII headings: lowercase, punctuation dropped, spaces to hyphens. */
export function headingSlug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
}

/** Path under the docs site base, e.g. `guide/mesh-mode.html#reading-…`. */
export function helpPath(context: HelpContext): string {
  const t = HELP_TARGETS[context];
  return `guide/${t.page}.html${t.anchor ? `#${t.anchor}` : ""}`;
}
