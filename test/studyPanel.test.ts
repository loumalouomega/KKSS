import { describe, expect, it } from "vitest";
import { buildStudyPanel, runForResults } from "../app/main/services/studyPanelCore";
import { parseStudyMessage } from "../app/main/services/studyPanel";

const snapshot = {
  project: {
    activeStudyId: "s1", activeRunId: "r2",
    studies: [
      { id: "s1", name: "Cantilever", runs: [
        { id: "r1", state: "succeeded", artifacts: [{ role: "result" }] },
        { id: "r2", state: "failed", artifacts: [] }] },
      { id: "s2", name: "Variant", parentId: "s1", runs: [] },
    ],
  },
  readiness: {
    s1: { geometry: "ready", mesh: "ready", case: "stale", run: "failed", results: "missing" },
    s2: { geometry: "ready", mesh: "missing", case: "missing", run: "missing", results: "missing" },
  },
};

describe("study panel model", () => {
  it("builds the chain from the workflow snapshot", () => {
    const s = buildStudyPanel(snapshot, { studyId: "s1", next: { id: "case", action: "Set up the case" } });
    expect(s.hasProject).toBe(true);
    expect(s.next).toEqual({ studyId: "s1", step: "case", action: "Set up the case" });
    const [a, b] = s.studies;
    expect(a.active).toBe(true);
    expect(a.stages.map((x) => [x.id, x.state, x.canOpen])).toEqual([
      ["geometry", "ready", true], ["mesh", "ready", true], ["case", "stale", true], ["run", "failed", false], ["results", "missing", true],
    ]);
    expect(a.runs).toEqual([
      { id: "r1", state: "succeeded", active: false, hasResult: true },
      { id: "r2", state: "failed", active: true, hasResult: false }]);
    expect(b.parentId).toBe("s1");
    expect(b.stages.find((x) => x.id === "mesh")!.canOpen).toBe(false);
    expect(b.stages.find((x) => x.id === "case")!.canOpen).toBe(false);
    expect(b.stages.find((x) => x.id === "results")!.canOpen).toBe(false);
  });
  it("only opens results when some run has one", () => {
    const s = buildStudyPanel(snapshot, null);
    expect(s.studies[0].stages.find((x) => x.id === "results")!.canOpen).toBe(true);
    expect(s.next).toBeUndefined();
    expect(runForResults(s.studies[0])).toBe("r1");
  });
  it("prefers the selected run when it has a result", () => {
    const s = buildStudyPanel({ ...snapshot, project: { ...snapshot.project, activeRunId: "r1" } }, null);
    expect(runForResults(s.studies[0])).toBe("r1");
  });
  it("is empty without a project and tolerates malformed input", () => {
    expect(buildStudyPanel({ project: null }, null)).toEqual({ type: "state", hasProject: false, studies: [] });
    expect(buildStudyPanel(undefined, undefined).hasProject).toBe(false);
    const s = buildStudyPanel({ project: { studies: [null, { id: 3 }, { id: "ok", runs: "no" }] } }, null);
    expect(s.studies.map((x) => x.id)).toEqual(["ok"]);
    expect(s.studies[0].runs).toEqual([]);
  });
});

describe("study panel messages", () => {
  it("accepts the three valid shapes", () => {
    expect(parseStudyMessage({ type: "hide" })).toEqual({ type: "hide" });
    expect(parseStudyMessage({ type: "select", studyId: "s1", runId: "r1" })).toEqual({ type: "select", studyId: "s1", runId: "r1" });
    expect(parseStudyMessage({ type: "open", studyId: "s1", stage: "mesh" })).toEqual({ type: "open", studyId: "s1", stage: "mesh" });
  });
  it("drops anything else", () => {
    for (const bad of [null, "x", { type: "open", studyId: "s1", stage: "run" }, { type: "open", stage: "mesh" }, { type: "select" }, { type: "open", studyId: "s1", stage: "mesh", runId: 5 }, { type: "nope" }]) {
      expect(parseStudyMessage(bad)).toBeUndefined();
    }
  });
});
