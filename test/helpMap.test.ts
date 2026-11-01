import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { HELP_TARGETS, headingSlug, helpPath } from "../app/main/services/helpMap";

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
});
