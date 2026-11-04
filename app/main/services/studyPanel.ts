/**
 * The study panel's main-process half (roadmap item 9): a lazy right-hand view
 * that mirrors the selected project's studies as geometry → mesh → case → run →
 * results chains and opens any link in its viewer. It is a navigation surface
 * over `.kkss/project.json` — no document of its own, no state beyond the last
 * model it was handed. Every action goes through the same `app__study_*` tools
 * Home and the assistant use, so readiness and approval rules are not repeated.
 */
import { ipcMain, type WebContents, type IpcMainEvent } from "electron";
import type { StudyPanelState, StudyToHost } from "../ipc";

const STAGES = new Set(["geometry", "mesh", "case", "results"]);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

export interface StudyPanelDeps {
  /** Hides the panel (its Close button / Esc). */
  hide: () => void;
  select: (studyId: string, runId?: string) => Promise<void>;
  open: (studyId: string, stage: "geometry" | "mesh" | "case" | "results", runId?: string) => Promise<void>;
  /** Reports a failed action to the user. */
  fail: (message: string) => void;
}

/** Validates an untrusted panel message; anything malformed is dropped, never guessed. */
export function parseStudyMessage(raw: unknown): StudyToHost | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "studyReady": case "hide": return { type: m.type };
    case "select": return id(m.studyId) && (m.runId === undefined || id(m.runId)) ? { type: "select", studyId: m.studyId, ...(m.runId ? { runId: m.runId as string } : {}) } : undefined;
    case "open": return id(m.studyId) && typeof m.stage === "string" && STAGES.has(m.stage) && (m.runId === undefined || id(m.runId))
      ? { type: "open", studyId: m.studyId, stage: m.stage as "geometry" | "mesh" | "case" | "results", ...(m.runId ? { runId: m.runId as string } : {}) }
      : undefined;
    default: return undefined;
  }
}

export class StudyPanelService {
  private target?: WebContents;
  private state: StudyPanelState = { type: "state", hasProject: false, studies: [] };
  private disposed = false;
  private onIpc = (event: IpcMainEvent, raw: unknown): void => {
    if (this.disposed || !this.target || event.sender !== this.target) return;
    const msg = parseStudyMessage(raw);
    if (!msg) return;
    if (msg.type === "studyReady") this.publish();
    else if (msg.type === "hide") this.deps.hide();
    else if (msg.type === "select") void this.run(() => this.deps.select(msg.studyId, msg.runId));
    else if (msg.type === "open") void this.run(() => this.deps.open(msg.studyId, msg.stage, msg.runId));
  };
  constructor(private readonly deps: StudyPanelDeps) { ipcMain.on("study:toHost", this.onIpc); }
  attach(target: WebContents): void { this.target = target; }
  /** Called whenever the workflow state changes, visible or not, so a reopened panel is current. */
  update(state: StudyPanelState): void { this.state = state; this.publish(); }
  publish(): void {
    if (this.disposed || !this.target || this.target.isDestroyed()) return;
    this.target.send("study:toWebview", this.state);
  }
  private async run(action: () => Promise<void>): Promise<void> {
    try { await action(); } catch (error) { this.deps.fail(error instanceof Error ? error.message : String(error)); }
  }
  dispose(): void { this.disposed = true; ipcMain.removeListener("study:toHost", this.onIpc); }
}
