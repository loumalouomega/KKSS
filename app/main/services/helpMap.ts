// F1 context help: which manual page and section explains the
// focused screen. Pure; test/helpMap.test.ts checks every target against the
// guide's own headings so a renamed section fails CI instead of 404-ing in-app.
import type { SettingCategory } from "./settings/registry";

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

/** Settings page category -> the matching section of guide/configuration.md. */
export const SETTINGS_CATEGORY_HELP: Readonly<Record<SettingCategory, string>> = {
  "Appearance": "ui-theme",
  "General": "general",
  "CAD Viewer": "cad-viewer-defaults",
  "Mesh Viewer": "mesh-viewer",
  "Kratos": "kratos-environment",
  "Text Editor": "text-editor-and-terminal",
  "Terminal": "text-editor-and-terminal",
  "LLM Assistant": "llm-assistant",
  "MCP Server": "external-mcp-endpoint",
  "Cloud Accounts": "cloud-accounts",
  "Remote": "cloud-accounts",
  "Advanced": "advanced",
};

export function settingsHelpPath(category: SettingCategory): string {
  return `guide/configuration.html#${SETTINGS_CATEGORY_HELP[category]}`;
}

/** Mode panels that have a manual section of their own. */
export type ModePanel = "cad.overview" | "cad.save" | "cad.defaults" | "cad.sidecars"
  | "mesh.overview" | "mesh.import" | "mesh.problemtypes" | "mesh.timeline" | "mesh.selection";

export const MODE_PANEL_HELP: Readonly<Record<ModePanel, { page: "cad-mode" | "mesh-mode"; anchor: string }>> = {
  "cad.overview": { page: "cad-mode", anchor: "reading-the-window-at-a-glance" },
  "cad.save": { page: "cad-mode", anchor: "saving-edits-into-the-source-file" },
  "cad.defaults": { page: "cad-mode", anchor: "viewer-defaults" },
  "cad.sidecars": { page: "cad-mode", anchor: "sidecar-files" },
  "mesh.overview": { page: "mesh-mode", anchor: "reading-the-window-at-a-glance" },
  "mesh.import": { page: "mesh-mode", anchor: "import-meshes-and-work-with-field-units" },
  "mesh.problemtypes": { page: "mesh-mode", anchor: "problemtypes-kratos-case-setup" },
  "mesh.timeline": { page: "mesh-mode", anchor: "timeline-discovery" },
  "mesh.selection": { page: "mesh-mode", anchor: "selection-properties-and-line-probes" },
};

export function panelHelpPath(panel: ModePanel): string {
  const t = MODE_PANEL_HELP[panel];
  return `guide/${t.page}.html#${t.anchor}`;
}
