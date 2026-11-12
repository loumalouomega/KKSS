import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";
// @ts-expect-error plain .mjs helper
import { repairUnbalancedCss } from "../tools/lib/cssRepair.mjs";

const warnings = async (css: string) => (await esbuild.transform(css, { loader: "css", logLevel: "silent" })).warnings.length;

describe("repairUnbalancedCss", () => {
  it("returns balanced input byte-identical", () => {
    const css = "a { b: c; }\n/* { */\n.x { y: \"{\"; }\n";
    const r = repairUnbalancedCss(css);
    expect(r.css).toBe(css);
    expect(r.repaired).toEqual([]);
  });

  it("closes a rule whose brace is missing (the mesh 5.39.0 .pt-flash shape)", async () => {
    const css = ".pt-flash {\n  outline: 1px solid red;\n  outline-offset: 1px;\n\n/* next */\n.eval {\n  max-height: 1px;\n}\n\n#ribbon {\n  flex: 1;\n}\n";
    expect(await warnings(css)).toBeGreaterThan(0);
    const r = repairUnbalancedCss(css);
    expect(r.repaired).toEqual([{ line: 1, selector: ".pt-flash" }]);
    expect(await warnings(r.css)).toBe(0);
    expect(r.css).toContain("outline-offset: 1px;\n}");
  });

  it("repairs the real mesh stylesheet so #ribbon is not nested", async () => {
    const file = path.join(__dirname, "..", "mesh", "media", "style.css");
    if (!fs.existsSync(file)) return;
    const r = repairUnbalancedCss(fs.readFileSync(file, "utf8"));
    expect(await warnings(r.css)).toBe(0);
  });
});
