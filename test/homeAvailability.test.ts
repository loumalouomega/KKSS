import { describe, expect, it } from "vitest";
import { homeAvailability, REASON_TEXT, type HomeAvailabilityState } from "../app/renderer/home/availability";

const base: HomeAvailabilityState = {
  hasProjectFolder: true,
  hasStudy: true,
  manualRuntimeAvailable: true,
  states: { geometry: "ready", mesh: "ready", case: "ready" },
  hasSelectedRun: true,
  selectedRunHasResult: true,
  runCount: 2,
  queue: { paused: true, taskStates: ["waiting"] },
};
const mk = (o: Partial<HomeAvailabilityState>): HomeAvailabilityState => ({ ...base, ...o });

describe("home availability reasons", () => {
  it("enables everything in a fully ready state except Pause on a paused queue", () => {
    const a = homeAvailability(base);
    expect(Object.entries(a).filter(([, v]) => v)).toEqual([["queue-pause", "queuePaused"]]);
  });
  it("explains every study button when no study is selected, incl. Rebuild stale", () => {
    const a = homeAvailability(mk({ hasStudy: false, states: {}, hasSelectedRun: false, selectedRunHasResult: false, runCount: 0 }));
    expect(a["study-rebuild-stale"]).toBe("noStudy");
    expect(a["study-plan-run"]).toBe("noStudy");
    expect(a["study-evaluate-quantity"]).toBe("noStudy");
    expect(a["study-goal-seek"]).toBe("noStudy");
    expect(a["study-create"]).toBeUndefined();
  });
  it("names the runtime for planning and resume, and not before the report arrives", () => {
    expect(homeAvailability(mk({ manualRuntimeAvailable: false }))["study-plan-run"]).toBe("runtimeUnavailable");
    expect(homeAvailability(mk({ manualRuntimeAvailable: false }))["queue-resume"]).toBe("runtimeUnavailable");
    expect(homeAvailability(mk({ manualRuntimeAvailable: undefined }))["study-plan-run"]).toBeUndefined();
  });
  it("needs a run for quantity evaluation and two for comparison", () => {
    expect(homeAvailability(mk({ hasSelectedRun: false, selectedRunHasResult: false }))["study-evaluate-quantity"]).toBe("noRun");
    expect(homeAvailability(mk({ hasSelectedRun: false, selectedRunHasResult: false }))["study-goal-seek"]).toBe("noRun");
    expect(homeAvailability(mk({ runCount: 1 }))["study-compare-runs"]).toBe("needsTwoRuns");
    expect(homeAvailability(mk({ selectedRunHasResult: false }))["study-open-results"]).toBe("noResults");
  });
  it("needs a project folder to create a study", () => {
    expect(homeAvailability(mk({ hasProjectFolder: false }))["study-create"]).toBe("noProjectFolder");
    expect(homeAvailability(mk({ hasProjectFolder: false }))["study-wizard"]).toBe("noProjectFolder");
    expect(homeAvailability(mk({ hasStudy: false }))["study-wizard"]).toBeUndefined();
  });
  it("reports queue reasons", () => {
    expect(homeAvailability(mk({ queue: { paused: false, taskStates: [] } }))["queue-resume"]).toBe("queueEmpty");
    expect(homeAvailability(mk({ queue: { paused: false, taskStates: ["running"] } }))["queue-resume"]).toBe("queueNotPaused");
    expect(homeAvailability(mk({ queue: { paused: false, taskStates: ["succeeded"] } }))["queue-cancel"]).toBe("nothingToCancel");
  });
  it("has text for every reason in use", () => {
    const used = new Set(Object.values(homeAvailability(mk({ hasStudy: false, manualRuntimeAvailable: false, queue: { paused: false, taskStates: [] } }))).filter(Boolean));
    for (const r of used) expect(REASON_TEXT[r!]).toBeTruthy();
  });
});
