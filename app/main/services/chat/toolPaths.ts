/**
 * Which filesystem paths a tool call touches — the input to "Always allow
 * writes inside the project folder".
 *
 * No `electron`; `node:fs`/`node:path` only, so `test/` imports it directly.
 *
 * ## Fail closed
 *
 * `scopedCallPaths` returns `null` — meaning "cannot be scoped, ask as usual" —
 * for anything it cannot account for. A tool qualifies only if it has a row in
 * `SCOPED_TOOL_PATH_ARGS`, and a call qualifies only if every path-looking
 * string anywhere in its arguments is either declared (and absolute) or absent.
 * A tool added by a submodule or `KRATOS_MCP_VERSION` bump has no row and so
 * keeps asking; a new path-like argument on a listed tool is caught by the name
 * heuristic rather than silently ignored. The heuristic only ever *tightens*.
 *
 * ## What is deliberately not listed
 *
 * - **Tools that execute things**, not just write files: `mesh__case_run`,
 *   `mesh__case_stop`, `mesh__problemtype_*` (load workspace problemtypes),
 *   `cad__run_parametric_script`, `cad__run_saved_script`,
 *   `cad__batch_export`, and the Kratos solver/job/study/install tools. A
 *   project-folder grant is about *where* files land, not about running code
 *   that happens to live there.
 * - **Tools whose arguments embed paths in nested documents**
 *   (`mesh__plot_dataset`'s recipe, `kratos__results_time_history`'s `series`):
 *   the heuristic refuses them, so they keep asking.
 * - **Relative paths.** An MCP server resolves them against its own working
 *   directory, not the project root, so they cannot be checked here.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Namespaced tool → dotted argument names that carry paths. Arrays of strings
 * are expanded (every element is checked). At least one declared argument must
 * be present for a call to qualify, so a call whose only target is implicit
 * (an "active document") asks instead.
 */
export const SCOPED_TOOL_PATH_ARGS: Readonly<Record<string, readonly string[]>> = {
  // ---- cad-preview -----------------------------------------------------
  cad__apply_edit_ops: ["path"],
  cad__apply_mesh_preset: ["path", "libraryPath"],
  cad__assign_layer: ["path"],
  cad__compare_mesh_refinement: ["path", "outputDir"],
  cad__convert_scad: ["path", "outputPath", "libraryPaths"],
  cad__decompose_to_primitives: ["path", "outputPath", "saveScript.libraryPath"],
  cad__download_standard_part: ["outputPath"],
  cad__export_brep: ["path", "outputPath"],
  cad__export_drawing_sheet: ["path", "outputPath", "libraryPath"],
  cad__export_mesh: ["path", "outputPath", "handoffPath", "receiptPath"],
  cad__export_svg_silhouette: ["path", "outputPath"],
  cad__export_technical_drawing: ["path", "outputPath"],
  cad__export_tessellated_stl: ["path", "outputPath", "libraryPath"],
  cad__fit_mesh_region: ["path"],
  cad__generate_prep_report: ["path", "outputDir", "manifestPath"],
  cad__import_svg: ["path", "svgPath"],
  cad__load_preprocess: ["zipPath", "outputPath"],
  cad__measure_mesh_deviation: ["path", "deviationMeshPath"],
  cad__pin_annotation: ["path"],
  cad__promote_mesh_to_brep: ["path", "outputPath"],
  cad__remesh_mesh: ["path", "outputPath"],
  cad__remove_edit_op: ["path"],
  cad__repair_mesh: ["path", "outputPath"],
  cad__save_mesh_preset: ["libraryPath"],
  cad__save_model: ["path"],
  cad__save_parametric_script: ["libraryPath"],
  cad__save_preprocess: ["path", "outputPath"],
  cad__save_sheet_template: ["libraryPath"],
  cad__set_layer: ["path"],
  cad__set_mesh_options: ["path"],
  cad__set_part: ["path"],
  cad__set_plane: ["path"],
  cad__set_variables: ["path"],
  cad__transform_mesh: ["path", "outputPath"],
  // ---- kratos-mdpa ------------------------------------------------------
  mesh__case_generate: ["meshPath", "casePath"],
  mesh__case_convergence: ["meshPath", "outputPath"],
  // mesh 5.12.0's result conversion: `folder` is the destination (absolute or
  // relative to the case folder); `formats` are extensions, not paths.
  mesh__case_export_results: ["meshPath", "folder"],
  mesh__case_monitors: ["meshPath", "outputPath", "resultPath", "run.recordPath"],
  mesh__case_optimization: ["meshPath", "outputPath"],
  mesh__case_material_assign: ["meshPath", "smpPath", "casePath"],
  mesh__case_write_state: ["meshPath"],
  mesh__material_preset_import: ["path"],
  mesh__mesh_batch_transform: ["paths", "recipePath", "outputDir"],
  mesh__mesh_compare: ["pathA", "pathB", "outputPath"],
  mesh__mesh_convert: ["path", "outputPath"],
  mesh__mesh_derive: ["path", "outputPath"],
  mesh__mesh_export_table: ["path", "outputPath"],
  mesh__mesh_extract_skin: ["path", "outputPath"],
  mesh__mesh_extract_submodelpart: ["path", "outputPath"],
  mesh__mesh_field_series: ["path", "outputPath"],
  mesh__mesh_flow_balance: ["path", "outputPath"],
  mesh__mesh_pack_series: ["path", "outputPath"],
  mesh__mesh_periodic: ["path", "outputPath"],
  mesh__mesh_probe: ["path", "outputPath"],
  mesh__mesh_resample: ["path", "outputPath"],
  mesh__mesh_select: ["path", "outputPath"],
  mesh__mesh_split: ["path", "outputDir"],
  mesh__mesh_transform: ["path", "recipePath", "outputPath"],
  mesh__problem_pack: ["meshPath", "outputPath", "recipePath"],
  mesh__problem_unpack: ["archivePath", "destDir"],
  // ---- kratos-mcp-server (reviewed at KRATOS_TOOLS_REVIEWED_VERSION) ----
  // Nested-document tools (project_add/update_process, project_set_setting,
  // project_update_solver, create_cosim/fsi_project) and the executing session
  // tools deliberately have no row: the heuristic refuses their nested paths,
  // so they keep asking. See the module docstring.
  kratos__add_boundary_condition: ["parameters_file"],
  kratos__add_output_process: ["parameters_file", "output_path", "output_file"],
  kratos__add_remeshing_process: ["parameters_file"],
  kratos__configure_checkpoints: ["case_dir", "parameters_file"],
  kratos__create_materials: ["output_file"],
  kratos__create_multistage_project: ["directory"],
  kratos__create_project: ["directory"],
  kratos__create_project_parameters: ["output_file"],
  kratos__export_case_to_flowgraph: ["parameters_file", "output_file"],
  kratos__import_flowgraph_to_case: ["graph_file", "output_file"],
  kratos__materials_remove_property: ["materials_file"],
  kratos__materials_set_property: ["materials_file"],
  kratos__mdpa_add_entities: ["path", "output"],
  kratos__mdpa_add_nodes: ["path", "output"],
  kratos__mdpa_convert_cells: ["path", "output"],
  kratos__mdpa_create_geometry_mesh: ["path"],
  kratos__mdpa_create_structured_mesh: ["path"],
  kratos__mdpa_create_sub_model_part: ["path", "output"],
  kratos__mdpa_delete_entities: ["path", "output"],
  kratos__mdpa_delete_nodes: ["path", "output"],
  kratos__mdpa_delete_table: ["path", "output"],
  kratos__mdpa_edit_sub_model_part: ["path", "output"],
  kratos__mdpa_extract: ["path", "output"],
  kratos__mdpa_extract_boundary: ["path", "output"],
  kratos__mdpa_extrude: ["path", "output"],
  kratos__mdpa_merge: ["path", "other", "output"],
  kratos__mdpa_move_nodes: ["path", "output"],
  kratos__mdpa_renumber: ["path", "output"],
  kratos__mdpa_set_elemental_data: ["path", "output"],
  kratos__mdpa_set_entity_properties: ["path", "output"],
  kratos__mdpa_set_nodal_data: ["path", "output"],
  kratos__mdpa_set_properties: ["path", "output"],
  kratos__mdpa_set_sub_model_part_data: ["path", "output"],
  kratos__mdpa_set_table: ["path", "output"],
  kratos__mdpa_transform: ["path", "output"],
  kratos__mesh_export: ["path", "output"],
  kratos__mesh_generate_gmsh: ["output", "cad_file"],
  kratos__mesh_import: ["source", "output"],
  kratos__mesh_remesh: ["input_mdpa", "output_mdpa"],
  kratos__project_delete_setting: ["parameters_file"],
  kratos__project_remove_process: ["parameters_file"],
  kratos__results_animate: ["files", "gif_path"],
  kratos__results_render: ["file", "image_path"],
  kratos__study_results: ["csv_file"],
};

/** An argument key that looks like it carries a path. Used only to refuse.
 *  Names ending in format/ext/type/… are enum-ish values (`outputFormat`). */
const PATHY_KEY = /(path|file|dir|directory|folder|zip|archive|root|recipe|dest|library)s?[a-z0-9]?$/i;
const VALUE_KEY = /(format|ext|type|name|id|mode|kind)$/i;

export type ScopeCheck =
  | { kind: "paths"; paths: string[] }
  | { kind: "unscoped" };

function collect(
  node: unknown,
  keyPath: string,
  declared: ReadonlySet<string>,
  found: string[]
): boolean {
  if (typeof node === "string") {
    const leaf = keyPath.slice(keyPath.lastIndexOf(".") + 1);
    if (declared.has(keyPath)) {
      if (!node.trim()) return false;
      found.push(node);
      return true;
    }
    return VALUE_KEY.test(leaf) || !PATHY_KEY.test(leaf);
  }
  if (Array.isArray(node)) return node.every((item) => collect(item, keyPath, declared, found));
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).every(([key, value]) =>
      collect(value, keyPath ? `${keyPath}.${key}` : key, declared, found)
    );
  }
  return true;
}

/**
 * The absolute paths a call touches, or `null` when it cannot be scoped.
 * `null` is the safe answer — it just means the user is asked, as today.
 */
export function scopedCallPaths(namespaced: string, argsJson: string): string[] | null {
  const spec = SCOPED_TOOL_PATH_ARGS[namespaced];
  if (!spec) return null;
  let parsed: unknown;
  try {
    parsed = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const found: string[] = [];
  if (!collect(parsed, "", new Set(spec), found)) return null;
  if (found.length === 0) return null; // only implicit targets: ask
  if (!found.every((p) => path.isAbsolute(p))) return null;
  return found;
}

export interface ScopeEnv {
  platform?: NodeJS.Platform;
  /** realpath, injected for tests. Must throw if the path does not exist. */
  realpath?(p: string): string;
}

/** Resolves symlinks in the nearest existing ancestor, then re-appends the rest. */
function realish(p: string, env: Required<ScopeEnv>): string {
  const resolved = path.resolve(p);
  let current = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(env.realpath(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Whether `target` is the root itself or lies beneath it, after symlinks. */
export function isInside(target: string, root: string, env: ScopeEnv = {}): boolean {
  const full: Required<ScopeEnv> = {
    platform: env.platform ?? process.platform,
    realpath: env.realpath ?? ((p) => fs.realpathSync(p)),
  };
  const fold = (p: string) => (full.platform === "win32" || full.platform === "darwin" ? p.toLowerCase() : p);
  const rel = path.relative(fold(realish(root, full)), fold(realish(target, full)));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The single question the gate asks: do all of this call's paths lie inside the
 * explicit project root? `false` for no root, an unscopable call, or any escape.
 */
export function callInsideProject(
  namespaced: string,
  argsJson: string,
  root: string | undefined,
  env: ScopeEnv = {}
): boolean {
  if (!root || !path.isAbsolute(root)) return false;
  const paths = scopedCallPaths(namespaced, argsJson);
  return !!paths && paths.every((p) => isInside(p, root, env));
}
