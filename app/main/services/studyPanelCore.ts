/**
 * Pure model for the study panel: turns the workflow snapshot
 * into the geometry → mesh → case → run → results chain the panel draws. It
 * reads what `WorkflowService.snapshot()` already derived and computes nothing
 * of its own — readiness, run states and result artifacts come from the
 * project file, and "can open" only says whether the stage has a file to show.
 */
import type { StudyChainInfo, StudyPanelState, StudyRunInfo, StudyStageInfo } from "../ipc";

interface SnapshotRun { id?: unknown; state?: unknown; artifacts?: unknown }
interface SnapshotStudy { id?: unknown; name?: unknown; parentId?: unknown; runs?: unknown }
interface Snapshot {
  project?: { activeStudyId?: unknown; activeRunId?: unknown; studies?: unknown } | null;
  readiness?: Record<string, Record<string, string> | undefined>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const hasResult = (run: SnapshotRun): boolean =>
  Array.isArray(run.artifacts) && run.artifacts.some((a) => (a as { role?: unknown })?.role === "result");

export function buildStudyPanel(
  snapshot: unknown,
  next?: { studyId?: unknown; next?: { id?: unknown; action?: unknown } } | null,
): StudyPanelState {
  const snap = (snapshot ?? {}) as Snapshot;
  const project = snap.project;
  if (!project || !Array.isArray(project.studies)) return { type: "state", hasProject: false, studies: [] };
  const activeStudy = str(project.activeStudyId), activeRun = str(project.activeRunId);
  const studies: StudyChainInfo[] = [];
  for (const raw of project.studies as SnapshotStudy[]) {
    const id = str(raw?.id);
    if (!id) continue;
    const ready = snap.readiness?.[id] ?? {};
    const runs: StudyRunInfo[] = (Array.isArray(raw.runs) ? (raw.runs as SnapshotRun[]) : [])
      .map((r) => ({ id: str(r?.id) ?? "", state: str(r?.state) ?? "unknown", active: id === activeStudy && str(r?.id) === activeRun, hasResult: hasResult(r ?? {}) }))
      .filter((r) => r.id);
    const state = (key: string): string => ready[key] ?? "missing";
    const stages: StudyStageInfo[] = [
      { id: "geometry", state: state("geometry"), canOpen: state("geometry") !== "missing" },
      { id: "mesh", state: state("mesh"), canOpen: state("mesh") !== "missing" },
      { id: "case", state: state("case"), canOpen: state("mesh") !== "missing" && state("case") !== "missing" },
      { id: "run", state: state("run"), canOpen: false },
      { id: "results", state: state("results"), canOpen: runs.some((r) => r.hasResult) },
    ];
    studies.push({ id, name: str(raw.name) ?? id, ...(str(raw.parentId) ? { parentId: str(raw.parentId) } : {}), active: id === activeStudy, stages, runs });
  }
  const step = str(next?.next?.id), action = str(next?.next?.action), studyId = str(next?.studyId);
  return { type: "state", hasProject: true, studies, ...(step && action && studyId ? { next: { studyId, step, action } } : {}) };
}

/** The run a stage's Open should use: the selected run if it has a result, else the newest one that does. */
export function runForResults(chain: StudyChainInfo): string | undefined {
  const withResult = chain.runs.filter((r) => r.hasResult);
  return (withResult.find((r) => r.active) ?? withResult[withResult.length - 1])?.id;
}
