import { describe, expect, it } from "vitest";
import { buildChecklist } from "../app/main/services/workflows/checklist";

const r = (o: Record<string, string>) => ({ geometry: "ready", mesh: "ready", case: "ready", run: "missing", results: "missing", ...o });

describe("study checklist", () => {
  it("starts at the first missing stage and blocks the rest", () => {
    const c = buildChecklist(r({ geometry: "missing", mesh: "missing", case: "missing" }));
    expect(c.next?.id).toBe("geometry");
    expect(c.steps.map((s) => s.state)).toEqual(["todo", "blocked", "blocked", "blocked", "blocked"]);
  });
  it("marks a stale mesh as redo and the case after it blocked", () => {
    const c = buildChecklist(r({ mesh: "stale", case: "stale" }));
    expect(c.next).toMatchObject({ id: "mesh", state: "redo", tool: "app__study_attach_mesh" });
    expect(c.steps[2].state).toBe("blocked");
  });
  it("points at the run when setup is ready, and an uncertain run is redo with an inspect hint", () => {
    expect(buildChecklist(r({})).next?.id).toBe("run");
    const u = buildChecklist(r({ run: "uncertain" }));
    expect(u.next).toMatchObject({ id: "run", state: "redo" });
    expect(u.next?.action).toMatch(/uncertain/);
  });
  it("ends at review once a run succeeded with results", () => {
    const c = buildChecklist(r({ run: "succeeded", results: "ready" }));
    expect(c.next?.id).toBe("review");
  });
});
