import { describe, expect, it } from "vitest";
import { EXAMPLES } from "../app/main/services/examplesCore";
import { WIZARD_EXAMPLES, WIZARD_FAMILIES, checklistRows, examplesFor, familyOf } from "../app/renderer/home/wizard";

describe("New Simulation wizard catalogue", () => {
  it("gives every shipped example a family, and the same label", () => {
    for (const e of EXAMPLES) {
      const mirror = WIZARD_EXAMPLES.find((m) => m.id === e.id);
      expect(mirror, `EXAMPLES id "${e.id}" has no wizard family`).toBeTruthy();
      expect(mirror!.label).toBe(e.label);
    }
    expect(WIZARD_EXAMPLES.map((e) => e.id).sort()).toEqual(EXAMPLES.map((e) => e.id).sort());
  });
  it("has no empty family and no unknown family reference", () => {
    for (const f of WIZARD_FAMILIES) expect(examplesFor(f.id).length, f.id).toBeGreaterThan(0);
    const ids = new Set<string>(WIZARD_FAMILIES.map((f) => f.id));
    for (const e of WIZARD_EXAMPLES) expect(ids.has(e.family)).toBe(true);
    expect(familyOf("fsi")).toBe("coupled");
    expect(familyOf("nope")).toBeUndefined();
  });
});

describe("checklistRows", () => {
  const step = (id: string, state: string, extra: object = {}) => ({ id, state, ...extra });
  it("orders steps, routes each to a screen and flags the next one", () => {
    const steps = [
      step("review", "blocked", { why: "needs mesh" }),
      step("mesh", "todo"),
      step("geometry", "done"),
      step("case", "blocked", { why: "needs mesh" }),
      step("run", "blocked", { why: "needs mesh" }),
    ];
    const rows = checklistRows({ studyId: "s", steps, next: steps[1] });
    expect(rows.map((r) => r.id)).toEqual(["geometry", "mesh", "case", "run", "review"]);
    expect(rows[0]).toMatchObject({ screen: "cad", command: "open-geometry", enabled: true, isNext: false });
    expect(rows[1]).toMatchObject({ screen: "home", command: "attach-mesh", enabled: true, isNext: true });
    expect(rows[2]).toMatchObject({ screen: "mesh", command: "open-case", enabled: false, why: "needs mesh" });
    expect(rows[3].command).toBe("plan-run");
    expect(rows[4].command).toBe("review-run");
  });
  it("relinks a missing geometry, opens a current mesh, and treats unknown states as blocked", () => {
    const rows = checklistRows({ studyId: "s", steps: [step("geometry", "todo"), step("mesh", "done"), step("case", "weird")] });
    expect(rows[0].command).toBe("relink-source");
    expect(rows[1]).toMatchObject({ screen: "mesh", command: "open-mesh" });
    expect(rows[2].enabled).toBe(false);
  });
});
