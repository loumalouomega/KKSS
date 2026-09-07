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
  annotations: ".annotations.json",
  view: ".view.json",
  planes: ".planes.json",
  meshOptions: ".mesh.json",
  /** Gmsh script regenerated from the mesh options on every change. */
  geoScript: ".geo",
} as const;

export const CAD_SIDECAR_SUFFIXES: readonly string[] = Object.values(CAD_SIDECAR);

/**
 * cad 1.7.0's macro library. Unlike every other sidecar this is **per folder**,
 * not per model — one library is shared by every model beside it.
 */
export const MACRO_LIBRARY_NAME = "cad-preview-macros.json";

/** mesh 3.8.0's RunManager sidecar, written as `<stem>.kratosrun.json`. */
export const MESH_RUN_SIDECAR = ".kratosrun.json";
