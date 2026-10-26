import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { EXAMPLES, isExampleId, pickEntry, planExample, safeMemberName } from "../app/main/services/examplesCore";

const root = path.join(__dirname, "..");
const en = JSON.parse(fs.readFileSync(path.join(root, "app/shared/i18n/en.json"), "utf8"));
const es = JSON.parse(fs.readFileSync(path.join(root, "app/shared/i18n/es.json"), "utf8"));

describe("Help ▸ Examples", () => {
  it("has labels in both locales", () => {
    for (const key of ["Examples", ...EXAMPLES.map((e) => e.label)]) {
      expect(en[key], key).toBeTruthy();
      expect(es[key], key).toBeTruthy();
    }
  });

  it("opens every shipped tutorial archive on its geometry", () => {
    for (const { id } of EXAMPLES) {
      const zip = fs.readFileSync(path.join(root, "doc/public/examples/tutorials", `${id}.zip`));
      const plan = planExample(id, new Uint8Array(zip));
      expect(plan.entry, id).toMatch(new RegExp(`^${id}/.+\\.(brep|stp)$`));
      expect(plan.files.every((f) => f.rel.startsWith(`${id}/`))).toBe(true);
    }
  });

  it("refuses traversal, absolute and foreign paths", () => {
    expect(safeMemberName("a", "a/x.brep")).toBe("a/x.brep");
    for (const bad of ["a/../x", "/a/x", "b/x", "a\\x", "C:/a/x", "a/./x"]) expect(safeMemberName("a", bad), bad).toBeUndefined();
    const evil = zipSync({ "structural/../evil.txt": strToU8("x") });
    expect(() => planExample("structural", evil)).toThrow(/Unsafe path/);
    expect(() => planExample("nope", evil)).toThrow(/Unknown example/);
    expect(isExampleId("fsi")).toBe(true);
  });

  it("falls back to the mesh when there is no geometry", () => {
    expect(pickEntry(["x/a.json", "x/mesh.mdpa"])).toBe("x/mesh.mdpa");
    expect(pickEntry(["x/a.json"])).toBeUndefined();
  });

  it("is wired into the Help menu and staged by esbuild", () => {
    const menu = fs.readFileSync(path.join(root, "app/main/menu.ts"), "utf8");
    expect(menu).toContain('label: t("Examples")');
    expect(menu).toContain("deps.openExample(e.id)");
    expect(fs.readFileSync(path.join(root, "esbuild.mjs"), "utf8")).toContain("exampleCopies()");
  });
});
