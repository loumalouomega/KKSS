import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { CATEGORIES } from "../app/main/services/settings/registry";
import { HELP_TARGETS, MODE_PANEL_HELP, SETTINGS_CATEGORY_HELP, headingSlug, helpPath, panelHelpPath, settingsHelpPath } from "../app/main/services/helpMap";

const guide = path.resolve(__dirname, "../doc/guide");

describe("help map", () => {
  it("points every context at an existing page and heading", () => {
    for (const [ctx, t] of Object.entries(HELP_TARGETS)) {
      const file = path.join(guide, `${t.page}.md`);
      expect(fs.existsSync(file), `${ctx}: ${t.page}.md missing`).toBe(true);
      if (!t.anchor) continue;
      const slugs = fs.readFileSync(file, "utf8").split("\n").filter((l) => /^#{2,4} /.test(l)).map((l) => headingSlug(l.replace(/^#+ /, "")));
      expect(slugs, `${ctx}: no heading for #${t.anchor}`).toContain(t.anchor);
    }
  });
  it("builds a site-relative path", () => {
    expect(helpPath("settings")).toBe("guide/configuration.html");
    expect(helpPath("mesh")).toContain("guide/mesh-mode.html#");
  });

  const slugsOf = (page: string) => fs.readFileSync(path.join(guide, `${page}.md`), "utf8").split("\n").filter((l) => /^#{2,4} /.test(l)).map((l) => headingSlug(l.replace(/^#+ /, "")));

  it("maps every settings category to a configuration heading", () => {
    const slugs = slugsOf("configuration");
    for (const c of CATEGORIES) {
      expect(SETTINGS_CATEGORY_HELP[c], `${c}: no mapping`).toBeTruthy();
      expect(slugs, `${c}: no heading for #${SETTINGS_CATEGORY_HELP[c]}`).toContain(SETTINGS_CATEGORY_HELP[c]);
    }
    expect(Object.keys(SETTINGS_CATEGORY_HELP).sort()).toEqual([...CATEGORIES].sort());
    expect(settingsHelpPath("Kratos")).toBe("guide/configuration.html#kratos-environment");
  });

  it("maps every mode panel to an existing heading", () => {
    for (const [panel, t] of Object.entries(MODE_PANEL_HELP)) {
      expect(slugsOf(t.page), `${panel}: no heading for #${t.anchor}`).toContain(t.anchor);
      expect(panelHelpPath(panel as keyof typeof MODE_PANEL_HELP)).toBe(`guide/${t.page}.html#${t.anchor}`);
    }
  });
});
