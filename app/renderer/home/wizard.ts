// New Simulation wizard (roadmap item 9) — the pure half. Pure: no DOM, no
// electron, no import from app/main (the renderer must not pull main code in),
// so the example catalogue is MIRRORED here and test/wizard.test.ts fails when
// it drifts from `EXAMPLES` in app/main/services/examplesCore.ts.
// Every string is an English source key; home.ts passes it through translate().

export type WizardFamilyId = "structural" | "fluid" | "thermal" | "potential-flow" | "shallow-water" | "coupled" | "wind-tunnel";

export interface WizardExample { id: string; family: WizardFamilyId; label: string }
export interface WizardFamily { id: WizardFamilyId; label: string }

export const WIZARD_FAMILIES: readonly WizardFamily[] = [
  { id: "structural", label: "Structural" },
  { id: "fluid", label: "Fluid flow" },
  { id: "thermal", label: "Thermal" },
  { id: "potential-flow", label: "Potential flow" },
  { id: "shallow-water", label: "Shallow water" },
  { id: "coupled", label: "Coupled (FSI / CoSimulation)" },
  { id: "wind-tunnel", label: "Wind tunnel" },
];

/** Mirror of `EXAMPLES` (id + label) plus the physics family each belongs to. */
export const WIZARD_EXAMPLES: readonly WizardExample[] = [
  { id: "structural", family: "structural", label: "Structural cantilever" },
  { id: "eigen", family: "structural", label: "Structural eigenmodes" },
  { id: "fluid", family: "fluid", label: "Laminar flow around an obstacle" },
  { id: "rans", family: "fluid", label: "Turbulent flow (RANS)" },
  { id: "two-fluids", family: "fluid", label: "Two-fluid dam break" },
  { id: "thermal", family: "thermal", label: "Stationary heat conduction" },
  { id: "potential-flow", family: "potential-flow", label: "Uniform potential flow" },
  { id: "shallow-water", family: "shallow-water", label: "Still-water basin" },
  { id: "fsi", family: "coupled", label: "Fluid-structure interaction (Mok)" },
  { id: "cosim", family: "coupled", label: "Partitioned coupling (CoSimulation)" },
  { id: "wind-tunnel", family: "wind-tunnel", label: "Virtual wind tunnel" },
];

export function examplesFor(family: string): WizardExample[] {
  return WIZARD_EXAMPLES.filter((e) => e.family === family);
}
export function familyOf(exampleId: string): WizardFamilyId | undefined {
  return WIZARD_EXAMPLES.find((e) => e.id === exampleId)?.family;
}

// ---- checklist display ------------------------------------------------------

export type StepId = "geometry" | "mesh" | "case" | "run" | "review";
export type StepState = "done" | "todo" | "redo" | "blocked";
export interface NextStepStep { id: string; state: string; action?: string; tool?: string; why?: string }
/** The `app__study_next_step` result (extra fields ignored). */
export interface NextStepPayload { studyId: string; name?: string; steps: NextStepStep[]; next?: NextStepStep }

/** What a row's button does; home.ts maps each to an existing Home/menu action. */
export type StepCommand = "open-geometry" | "relink-source" | "open-mesh" | "attach-mesh" | "open-case" | "plan-run" | "review-run";
export type StepScreen = "cad" | "mesh" | "home";

export interface ChecklistRow {
  id: StepId;
  /** English key for the step name. */
  label: string;
  state: StepState;
  /** English key for the state. */
  stateLabel: string;
  /** Where the step's work happens. */
  screen: StepScreen;
  command: StepCommand;
  /** English key for the button. */
  button: string;
  /** False for a blocked step: shown, with `why`, but not actionable. */
  enabled: boolean;
  /** Why the step is blocked (the service's own text, e.g. "needs geometry"). */
  why?: string;
  /** Service text for the step (what to do). */
  action?: string;
  isNext: boolean;
}

const ORDER: readonly StepId[] = ["geometry", "mesh", "case", "run", "review"];
const LABEL: Record<StepId, string> = { geometry: "Geometry", mesh: "Mesh", case: "Case setup", run: "Run", review: "Review" };
const STATE_LABEL: Record<StepState, string> = { done: "done", todo: "to do", redo: "redo", blocked: "blocked" };

function routeFor(id: StepId, state: StepState): { screen: StepScreen; command: StepCommand; button: string } {
  switch (id) {
    case "geometry":
      // Nothing attached yet: the only thing to do is point at a file.
      return state === "todo"
        ? { screen: "home", command: "relink-source", button: "Relink geometry" }
        : { screen: "cad", command: "open-geometry", button: "Open geometry" };
    case "mesh":
      // The mesh is exported from CAD, then attached; once current it is opened.
      return state === "done"
        ? { screen: "mesh", command: "open-mesh", button: "Open mesh" }
        : { screen: "home", command: "attach-mesh", button: "Attach mesh" };
    case "case":
      return { screen: "mesh", command: "open-case", button: "Open case" };
    case "run":
      return { screen: "home", command: "plan-run", button: "Plan run" };
    case "review":
      return { screen: "home", command: "review-run", button: "Review run" };
  }
}

function asState(s: string): StepState {
  return s === "done" || s === "todo" || s === "redo" || s === "blocked" ? s : "blocked";
}

/** Ordered display rows for a `study_next_step` result; unknown steps are dropped. */
export function checklistRows(payload: NextStepPayload): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  for (const id of ORDER) {
    const step = payload.steps.find((s) => s.id === id);
    if (!step) continue;
    const state = asState(step.state);
    rows.push({
      id,
      label: LABEL[id],
      state,
      stateLabel: STATE_LABEL[state],
      ...routeFor(id, state),
      enabled: state !== "blocked",
      ...(state === "blocked" && step.why ? { why: step.why } : {}),
      ...(step.action ? { action: step.action } : {}),
      isNext: payload.next?.id === id,
    });
  }
  return rows;
}
