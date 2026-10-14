/**
 * The sidecar file names KKSS writes beside a user's document — the single
 * owner of this list.
 *
 * cadHost.ts is a 1:1 port of `cad/src/provider.ts`'s six `*Store.ts` files, so
 * the suffixes are a contract with the submodule (and with its MCP server's
 * `mcpSidecars.ts`, which writes the same names): a rename on either side
 * silently produces documents that reopen with an empty edit history. They are
 * also a contract with the cloud staging layer, which has to recognise a
 * sidecar as belonging to a staged model in order to sync it back — hence one
 * module both import rather than two lists that can drift.
 *
 * Pure and Electron-free.
 */

/** Per-model sidecars, each written as `${modelPath}${suffix}`. */
export const CAD_SIDECAR = {
  parts: ".parts.json",
  edits: ".edits.json",
  layers: ".layers.json",
  annotations: ".annotations.json",
  view: ".view.json",
  planes: ".planes.json",
  meshOptions: ".mesh.json",
  /** Gmsh script regenerated from the mesh options on every change. */
  geoScript: ".geo",
  /**
   * cad 3.16.0's OpenSCAD Customizer overrides (scadOverridesStore.ts): the
   * `-D` defines the panel's Apply persists, replayed on every `.scad`
   * conversion. Per-model, and carried inside the preprocess archive beside
   * the other six, so it syncs with its document like any other sidecar.
   */
  scadOverrides: ".scad-params.json",
} as const;

export const CAD_SIDECAR_SUFFIXES: readonly string[] = Object.values(CAD_SIDECAR);

/**
 * cad 1.7.0's macro library. Unlike every other sidecar this is **per folder**,
 * not per model — one library is shared by every model beside it.
 */
export const MACRO_LIBRARY_NAME = "cad-preview-macros.json";

/**
 * cad 2.7.0's meshing-preset library. Per **folder** like the macro library —
 * one file shared by every model beside it — and for the same reason it is
 * never cloud-synced (see `cachePathCore.ts`).
 */
export const MESH_PRESET_LIBRARY_NAME = "cad-preview-mesh-presets.json";

/** mesh 3.8.0's RunManager sidecar, written as `<stem>.kratosrun.json`. */
export const MESH_RUN_SIDECAR = ".kratosrun.json";

/**
 * mesh 5.3.0's user view layers (former roadmap item 4): view-only groups in
 * `<stem>.kratosview.json` (see mesh/src/problemtype/caseFile.ts viewFilePath).
 * View-only — never solver data, never dirty — but staged/synced like the run
 * sidecar so cloud round-trips don't silently drop them.
 */
export const MESH_VIEW_SIDECAR = ".kratosview.json";

/**
 * mesh 5.5.0's saved post-run monitors in `<stem>.kratosmonitors.json` (see
 * mesh/src/problemtype/caseFile.ts monitorsFilePath). Named quantities over
 * the case's saved frames — user data like the view layers, so staged/synced
 * the same way. The cooperative-stop sentinel (`<stem>.kratosstop`) is
 * deliberately NOT here: it is transient (written, then removed after the
 * stop) and must never be uploaded.
 */
export const MESH_MONITORS_SIDECAR = ".kratosmonitors.json";
