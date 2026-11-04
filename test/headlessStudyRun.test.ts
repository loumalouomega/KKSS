import { describe, expect, it } from "vitest";
import { EXIT, parseHeadlessCli, runStudy, type CliOptions, type HeadlessWorkflow } from "../app/main/headless/studyRunCore";
import { planRevision } from "../app/main/services/workflows/queue";

const ok = (argv: string[]) => { const r = parseHeadlessCli(argv); if (!r || !r.ok) throw new Error(JSON.stringify(r)); return r.options; };

describe("headless CLI parsing", () => {
  it("is not a headless command without --headless", () => {
    expect(parseHeadlessCli(["electron", "out/main.js", "model.stp"])).toBeUndefined();
  });
  it("parses the study run command and its options", () => {
    const o = ok(["kkss", "--headless", "study", "run", "/p", "--study", "s1", "--plan=abc", "--timeout", "90", "--no-review", "--require-converged", "--python", "/py"]);
    expect(o).toMatchObject({ project: "/p", study: "s1", plan: "abc", timeoutSeconds: 90, review: false, requireConverged: true, python: "/py" });
  });
  it("defaults to reviewing and a long timeout", () => {
    expect(ok(["--headless", "study", "run", "/p"])).toMatchObject({ review: true, requireConverged: false, timeoutSeconds: 86400 });
  });
  it("rejects bad usage with a reason", () => {
    for (const argv of [["--headless"], ["--headless", "study", "plan", "/p"], ["--headless", "study", "run"], ["--headless", "study", "run", "/a", "/b"],
      ["--headless", "study", "run", "/p", "--bogus"], ["--headless", "study", "run", "/p", "--timeout"], ["--headless", "study", "run", "/p", "--timeout", "0"], ["--headless", "study", "run", "/p", "--plan", "--study"]]) {
      const r = parseHeadlessCli(argv);
      expect(r && !r.ok).toBe(true);
    }
  });
});

// ---- a fake workflow over a mutable project -----------------------------------------------------------------

type T = { id: string; studyId: string; runId: string; kind: string; state: string; dependencies: string[]; args: Record<string, unknown>; inputRevision: string; requiredArtifacts: string[]; error?: string; receipt?: { message?: string; artifacts: unknown[] } };
const task = (id: string, state: string, over: Partial<T> = {}): T => ({ id, studyId: "s1", runId: "r1", kind: "solve", state, dependencies: [], args: {}, inputRevision: "x", requiredArtifacts: [], ...over });

function fake(tasks: T[], behavior: { onResume?: (tasks: T[]) => void; review?: unknown; refuse?: string; ticks?: ((tasks: T[]) => void)[] } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const ticks = [...(behavior.ticks ?? [])];
  const state = { runState: "running" };
  const wf: HeadlessWorkflow = {
    async snapshot() {
      const next = ticks.shift(); if (next) next(tasks);
      return { project: { queue: { paused: false, tasks }, studies: [{ id: "s1", runs: [{ id: "r1", state: state.runState }] }] } };
    },
    async call(tool, args) {
      calls.push([tool, args]);
      if (tool === "queue_resume") { if (behavior.refuse) throw new Error(behavior.refuse); behavior.onResume?.(tasks); return {}; }
      if (tool === "run_review") return behavior.review ?? { evidence: { findings: [], convergence: { state: "unavailable" } } };
      return {};
    },
  };
  return { wf, calls, state };
}
const options = (over: Partial<CliOptions> = {}): CliOptions => ({ project: "/p", timeoutSeconds: 60, review: true, requireConverged: false, ...over });
let now = 0;
const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };

describe("runStudy", () => {
  it("resumes the exact persisted revision and reports success", async () => {
    const tasks = [task("t1", "waiting")];
    const { wf, calls, state } = fake(tasks, { onResume: (ts) => { ts[0].state = "succeeded"; state.runState = "succeeded"; } });
    const rev = planRevision(tasks as never);
    const r = await runStudy(wf, options(), clock);
    expect(calls[0]).toEqual(["queue_resume", { planRevision: rev }]);
    expect(r).toMatchObject({ outcome: "succeeded", exitCode: EXIT.ok, started: true, planRevision: rev });
    expect(r.runs[0]).toMatchObject({ runId: "r1", state: "succeeded", review: "built", convergence: "unavailable" });
    expect(r.message).toMatch(/does not by itself establish numerical convergence/);
  });
  it("never starts anything for a mismatched --plan", async () => {
    const { wf, calls } = fake([task("t1", "waiting")]);
    const r = await runStudy(wf, options({ plan: "not-it" }), clock);
    expect(r).toMatchObject({ outcome: "refused", exitCode: EXIT.refused, started: false });
    expect(calls).toEqual([]);
  });
  it("never creates a plan: no persisted tasks is a refusal", async () => {
    const { wf, calls } = fake([]);
    const r = await runStudy(wf, options(), clock);
    expect(r).toMatchObject({ outcome: "refused", exitCode: EXIT.refused });
    expect(calls).toEqual([]);
  });
  it("reports a refused resume without polling", async () => {
    const { wf } = fake([task("t1", "waiting")], { refuse: "Solver runtime settings changed after preview; approve a new plan." });
    const r = await runStudy(wf, options(), clock);
    expect(r).toMatchObject({ outcome: "refused", exitCode: EXIT.refused });
    expect(r.message).toMatch(/Solver runtime settings changed/);
  });
  it("exits 1 when a task fails and 2 when one ends uncertain", async () => {
    const failed = fake([task("t1", "waiting")], { onResume: (ts) => { ts[0].state = "failed"; ts[0].receipt = { message: "solver crashed", artifacts: [] }; } });
    expect(await runStudy(failed.wf, options(), clock)).toMatchObject({ outcome: "failed", exitCode: EXIT.failed });
    const uncertain = fake([task("t1", "waiting"), task("t2", "waiting", { id: "t2", runId: "r2" })], { onResume: (ts) => { ts[0].state = "uncertain"; ts[1].state = "failed"; } });
    expect(await runStudy(uncertain.wf, options(), clock)).toMatchObject({ outcome: "uncertain", exitCode: EXIT.uncertain });
  });
  it("treats a task held after resume as refused by validation", async () => {
    const { wf } = fake([task("t1", "held", { error: "Geometry source is missing; relink it before dispatch." })], { onResume: (ts) => { ts[0].state = "held"; } });
    const r = await runStudy(wf, options(), clock);
    expect(r).toMatchObject({ outcome: "failed", exitCode: EXIT.failed });
    expect(r.tasks[0].message).toMatch(/Geometry source is missing/);
  });
  it("waits through running tasks until they settle", async () => {
    const tasks = [task("t1", "waiting")];
    const { wf } = fake(tasks, { onResume: (ts) => { ts[0].state = "running"; }, ticks: [() => {}, (ts) => { ts[0].state = "running"; }, (ts) => { ts[0].state = "succeeded"; }] });
    const r = await runStudy(wf, options(), clock);
    expect(r.outcome).toBe("succeeded");
  });
  it("pauses the queue and cancels running work on timeout", async () => {
    const tasks = [task("t1", "waiting")];
    const { wf, calls } = fake(tasks, { onResume: (ts) => { ts[0].state = "running"; } });
    now = 0;
    const r = await runStudy(wf, options({ timeoutSeconds: 5 }), clock, 1000);
    expect(r).toMatchObject({ outcome: "timeout", exitCode: EXIT.timeout });
    expect(calls.map((c) => c[0])).toEqual(expect.arrayContaining(["queue_pause", "queue_cancel"]));
    expect(calls.find((c) => c[0] === "queue_cancel")![1]).toEqual({ taskId: "t1" });
  });
  it("limits the run to --study and rejects an unknown one", async () => {
    const tasks = [task("t1", "waiting"), task("t2", "waiting", { studyId: "s2", runId: "r9" })];
    const a = fake(tasks, { onResume: (ts) => { ts[0].state = "succeeded"; } });
    expect(await runStudy(a.wf, options({ study: "s1" }), clock)).toMatchObject({ outcome: "succeeded" });
    const b = fake([task("t1", "waiting")]);
    expect(await runStudy(b.wf, options({ study: "nope" }), clock)).toMatchObject({ outcome: "error", exitCode: EXIT.usage });
  });
  it("--require-converged turns an unestablished convergence into exit 6", async () => {
    const mk = () => { const f = fake([task("t1", "waiting")], { onResume: (ts) => { ts[0].state = "succeeded"; f.state.runState = "succeeded"; } }); return f; };
    expect(await runStudy(mk().wf, options({ requireConverged: true }), clock)).toMatchObject({ outcome: "not-converged", exitCode: EXIT.notConverged });
    const ok = fake([task("t1", "waiting")], { onResume: (ts) => { ts[0].state = "succeeded"; ok.state.runState = "succeeded"; }, review: { evidence: { findings: [{ severity: "warning", message: "w" }], convergence: { state: "converged" } } } });
    const r = await runStudy(ok.wf, options({ requireConverged: true }), clock);
    expect(r).toMatchObject({ outcome: "succeeded", exitCode: EXIT.ok });
    expect(r.runs[0].findings).toEqual([{ severity: "warning", message: "w" }]);
  });
  it("skips reviews with --no-review and tolerates a failing one", async () => {
    const a = fake([task("t1", "waiting")], { onResume: (ts) => { ts[0].state = "succeeded"; a.state.runState = "succeeded"; } });
    const r = await runStudy(a.wf, options({ review: false }), clock);
    expect(a.calls.some((c) => c[0] === "run_review")).toBe(false);
    expect(r.runs[0].review).toBeUndefined();
    const b = fake([task("t1", "waiting")], { onResume: (ts) => { ts[0].state = "succeeded"; b.state.runState = "succeeded"; } });
    const inner = b.wf.call;
    b.wf.call = async (tool, args) => { if (tool === "run_review") throw new Error("review blew up"); return inner(tool, args); };
    const rb = await runStudy(b.wf, options(), clock);
    expect(rb.outcome).toBe("succeeded");
    expect(rb.runs[0]).toMatchObject({ review: "unavailable", reviewError: "review blew up" });
  });
  it("reports a project folder without a KKSS project", async () => {
    const wf: HeadlessWorkflow = { snapshot: async () => ({ project: null }), call: async () => ({}) };
    expect(await runStudy(wf, options(), clock)).toMatchObject({ outcome: "error", exitCode: EXIT.usage });
  });
});
