/**
 * Which MCP tools the assistant may run without asking.
 *
 * Pure — no `electron`, no `node:*` — so `test/` imports it directly (the same
 * rule as transcript.ts and transcriptStoreCore.ts). The approval *mode* is
 * passed in rather than read from stateStore, which would drag Electron in.
 *
 * **The classification is KKSS's, not the servers'.** MCP's `Tool.annotations`
 * (`readOnlyHint`, `destructiveHint`, …) look like exactly what this needs, and
 * are deliberately not used: the SDK's own type declarations say *"Clients
 * should never make tool use decisions based on ToolAnnotations received from
 * untrusted servers"*, and as of cad 1.13.0 / mesh 3.21.0 no bundled tool
 * declares any anyway. Two other shortcuts are rejected for the same reason:
 *
 * - **No name-prefix heuristic** (`list_*`/`get_*` ⇒ read). Inferring "safe"
 *   from a name the server chose is the same untrusted input, with worse
 *   evidence — and `problemtype_list` is precisely the counter-example.
 * - **No description scraping.** Several tools say "Read-only." in prose; a
 *   reworded description must not silently change a safety class.
 *
 * So: unlisted ⇒ `unknown` ⇒ ask. The external `kratos-mcp-server` is resolved
 * by uvx at runtime and is not in this tree, so its rows are pinned to
 * `KRATOS_MCP_VERSION` (reviewed from the published package's tool functions);
 * a newer or different server's extra tools stay `unknown` and ask.
 *
 * ## Judgment calls
 *
 * These are the rows a reviewer will question, so the reasoning lives here:
 *
 * - `cad__search_standard_parts` — **read**, and the only tool that reaches the
 *   network. It writes nothing; `download_standard_part` is where bytes land,
 *   and that is write.
 * - `cad__generate_mesh` — **read**. It returns statistics only and its
 *   `options` are documented "for this call only (not persisted)". Slow is not
 *   the same as destructive; `CALL_TIMEOUT_MS` is what bounds cost.
 * - `cad__fit_mesh_region` — **write**, despite reading like a pure fit: an
 *   opt-in `store:"plane"` writes `<model>.planes.json`, and
 *   `store:"cylinder"/"sphere"` appends an op to `<model>.edits.json`.
 * - `cad__decompose_to_primitives` — **write** for the same reason: an optional
 *   `outputPath` writes a B-rep and `saveScript.libraryPath` writes the script
 *   library.
 * - `mesh__mesh_export_table`, `mesh__mesh_field_series`, `mesh__mesh_select`,
 *   `mesh__mesh_probe` — **write**. They write only *when* `outputPath` is given, but this table is keyed by name and
 *   cannot see arguments, so the conservative class wins.
 * - `mesh__problemtype_list`, `mesh__problemtype_describe` — **write**, which is
 *   the least obvious row here. Given `workspaceDirs` they load workspace
 *   problemtypes, and loading *executes* them (`node:vm` for `.js`, pyodide for
 *   `.py`). CLAUDE.md's `workspaceFolders` invariant already treats exactly
 *   that as a safety decision rather than a read.
 * - `mesh__case_stop` — **write**. Not a file write; it signals a process.
 * - `mesh__mesh_pack_series` (mesh 3.21.0) — **write**, and not a conservative
 *   guess like `mesh_export_table`/`mesh_field_series` above: `outputPath` is
 *   required, so it unconditionally writes the packed XDMF plus its sibling
 *   `.h5` companions.
 * - `mesh__mesh_resample`, `mesh__mesh_periodic`, `mesh__mesh_flow_balance`,
 *   and `mesh__mesh_compare` — **write** because each accepts an output path;
 *   this table cannot distinguish report-only calls from file writes.
 *   `mesh__mesh_derive`, `mesh__mesh_split`, `mesh__mesh_batch_transform`,
 *   `mesh__case_material_assign` and `mesh__material_preset_import` always
 *   create or update files. Their read-only siblings remain `read`.
 * - `cad__measure_mesh_deviation` — **write** because its optional deviation
 *   mesh path writes a PLY; `cad__generate_prep_report` and `cad__batch_export`
 *   always create output files. Diagnostic and inventory tools stay `read`.
 * - `cad__check_printability` (cad 3.18.0) — **read**: a facts-only report
 *   (overhang statistics, sampled wall thickness) over the welded triangles,
 *   plus overlay buffers handed to the webview. It writes nothing.
 * - `mesh__plot_run_resolve` (mesh 5.12.0) — **read**: resolves run/image
 *   references against what is on disk; a pure lookup.
 * - `mesh__case_export_results` (mesh 5.12.0) — **write**: converts a run's
 *   result frames into other meshio++ formats under `folder` (default
 *   `converted`).
 * - `mesh__wind_tunnel_plan` (mesh 5.15.0) — **read**: measures a body surface
 *   and returns the tunnel extents, boundary-layer numbers, sizes and an
 *   estimate without meshing anything (its own description says "Read-only").
 * - `mesh__wind_tunnel_generate` (mesh 5.15.0) — **write**: builds the graded
 *   tunnel mesh, the placed body, the recipe, the case state and — with
 *   `generateCase` — the solver files, all under `outputFolder`.
 * - `mesh__case_compare` (mesh 5.16.0) — **read**: compares two saved
 *   isolated run directories (or their `.kkss-execution.json`) by receipt +
 *   preparation manifest. `left`/`right` only, never writes.
 *
 * - `kratos__results_time_history`, `kratos__results_compare`,
 *   `kratos__study_results` — **write**: each takes an optional `csv_file`.
 *   `kratos__results_render` / `results_animate` always write a PNG / GIF.
 * - `kratos__kratos_get_process_defaults` and the `kratos__kratos_list_*` tools — **read**: they
 *   parse the Kratos source tree or registry and execute nothing.
 *
 * The tool this whole feature exists for is `mesh__mesh_transform`, whose own
 * description carries "WARNING: when `outputPath` is omitted the input file is
 * overwritten".
 */

/** What a tool does to state outside the process. */
export type ToolAccess = "read" | "write";
/** `unknown` = this table has no row for it, which always means "ask". */
export type ToolClass = ToolAccess | "unknown";
export type ApprovalMode = "askOnWrite" | "askAlways" | "never";
/** `allowScoped` = allow, and keep allowing this tool while its paths stay
 *  inside the explicit project folder (see toolPaths.ts). */
export type ApprovalDecision = "allow" | "allowAlways" | "allowScoped" | "deny";
export type ToolGate = "auto" | "ask";

/**
 * The `KRATOS_MCP_VERSION` whose tool list the `kratos__*` rows above were
 * reviewed against. `test/chatToolPolicy.test.ts` fails when the pin moves
 * without this (and the rows) being re-reviewed.
 */
export const KRATOS_TOOLS_REVIEWED_VERSION = "0.9.0";

/** Same contract for the `pdf__*` rows and `PDF_MCP_VERSION`. */
export const PDF_TOOLS_REVIEWED_VERSION = "0.2.1";

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "askOnWrite";

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "askOnWrite" || value === "askAlways" || value === "never";
}

/**
 * Full **namespaced** tool name → access class.
 *
 * Namespaced, because that is the form both `chatTools()` and `callTool()`
 * speak; re-deriving the server/tool split here would be a second
 * implementation of `splitToolName` to keep in sync.
 *
 * Anything absent is `unknown` — see the module comment. `test/chatToolPolicy.
 * test.ts` pins the exact key set, so adding or removing a row is a deliberate,
 * reviewed edit rather than a silent change in what runs unasked.
 */
export const TOOL_ACCESS: Readonly<Record<string, ToolAccess>> = {
  // App-owned guided simulation workflow. Preview/report operations are reads;
  // selecting, navigating, creating, and duplicating alter user-visible state.
  app__check_simulation_environment: "read",
  app__study_list: "read",
  app__study_open: "write",
  app__study_attach_mesh: "write",
  app__study_copy_source_into_project: "write",
  app__study_import_run: "write",
  app__study_relink_source: "write",
  app__study_import_handoff: "write",
  app__variants_create: "write",
  app__variants_compare_export: "write",
  app__run_review: "read",
  // mesh 5.17.0's run comparison on study runs: the shared compareRuns core
  // rendered as Markdown — facts only, never a judgement. Read: both run
  // directories are only read.
  app__run_compare: "read",
  app__run_review_export: "write",
  app__run_quantity_evaluate: "write",
  app__run_refinement_set: "write",
  app__study_create: "write",
  app__study_select: "write",
  app__study_set_settings: "write",
  app__study_duplicate: "write",
  app__variants_preview: "read",
  app__variants_compare: "read",
  app__queue_plan_preview: "read",
  app__queue_variants_preview: "read",
  app__queue_parameter_sweep_preview: "read",
  app__queue_retry_variant_preview: "read",
  app__queue_inspect: "read",
  app__queue_enqueue: "write",
  app__queue_reorder: "write",
  app__queue_pause: "write",
  app__queue_resume: "write",
  app__queue_resume_row: "write",
  app__queue_cancel: "write",
  // ---- cad-preview (81) ---------------------------------------------------
  cad__describe_capabilities: "read",
  cad__load_model: "read",
  cad__get_mass_properties: "read",
  cad__generate_bom: "read",
  cad__inspect: "read",
  cad__measure: "read",
  cad__measure_exact: "read",
  cad__check_tolerance: "read",
  cad__check_interference: "read",
  cad__check_interference_all: "read",
  cad__resolve_selector: "read",
  cad__synthesize_selector: "read",
  cad__render_snapshot: "read",
  cad__render_ops_prefix: "read",
  cad__search_standard_parts: "read",
  cad__compare_models: "read",
  cad__check_mesh_health: "read",
  cad__check_brep_health: "read",
  // cad 3.17.0: two meshio++ facts-only tools — check_mesh_quality generates
  // the FE mesh in memory and grades it against the caller's thresholds,
  // segment_mesh_surface reads triangle soups. Neither writes (the deviation
  // map's optional PLY is what makes its sibling `write`).
  cad__check_mesh_quality: "read",
  cad__segment_mesh_surface: "read",
  // cad 3.18.0's printability facts: overhang statistics and sampled wall
  // thickness over the welded triangles, plus overlay buffers for the panel.
  // It writes nothing — the same read-shaped class as its siblings above.
  cad__check_printability: "read",
  // cad 3.19.0's mesh → analytic CAD: fit_mesh_to_cad writes a brand-new
  // AP214 STEP (and optionally the solid's .cad.json B-rep side channel) —
  // never the source mesh, but a file lands on disk. iga_refine likewise
  // always writes a new .cad.json; iga_sample and iga_evaluate are facts and
  // evaluations only.
  cad__fit_mesh_to_cad: "write",
  cad__iga_sample: "read",
  cad__iga_refine: "write",
  cad__iga_evaluate: "read",
  cad__recognize_primitives: "read",
  cad__list_workspace_models: "read",
  cad__get_state: "read",
  cad__list_parametric_scripts: "read",
  cad__screenshot_shape: "read",
  cad__hit_test: "read",
  cad__list_standard_hole_sizes: "read",
  cad__list_mesh_presets: "read",
  cad__list_sheet_templates: "read",
  cad__list_layers: "read",
  cad__list_scad_parameters: "read",
  cad__generate_mesh: "read",
  cad__measure_mesh_deviation: "write",
  cad__analyze_passages: "read",
  cad__estimate_mesh_budget: "read",
  cad__check_handoff_manifest: "read",
  cad__job_status: "read",
  cad__generate_hole_table: "read",
  cad__inspect_meshio_fields: "read",
  cad__download_standard_part: "write",
  cad__batch_export: "write",
  cad__save_sheet_template: "write",
  cad__generate_prep_report: "write",
  cad__export_tessellated_stl: "write",
  cad__transform_mesh: "write",
  cad__decompose_to_primitives: "write",
  cad__fit_mesh_region: "write",
  cad__promote_mesh_to_brep: "write",
  cad__repair_mesh: "write",
  cad__export_technical_drawing: "write",
  cad__export_svg_silhouette: "write",
  cad__export_drawing_sheet: "write",
  cad__import_svg: "write",
  cad__pin_annotation: "write",
  cad__save_model: "write",
  cad__apply_edit_ops: "write",
  cad__run_parametric_script: "write",
  cad__remove_edit_op: "write",
  cad__save_parametric_script: "write",
  cad__run_saved_script: "write",
  cad__set_variables: "write",
  cad__set_part: "write",
  cad__set_plane: "write",
  cad__set_layer: "write",
  cad__assign_layer: "write",
  cad__set_mesh_options: "write",
  cad__export_mesh: "write",
  cad__remesh_mesh: "write",
  cad__convert_scad: "write",
  cad__job_cancel: "write",
  cad__export_brep: "write",
  cad__save_preprocess: "write",
  // cad 2.7.0: presets write the folder's library file (save) or the model's
  // mesh options + .geo (apply); the refinement sweep can write per-run mesh
  // files and, with applyIndex, persist one run's options.
  cad__save_mesh_preset: "write",
  cad__apply_mesh_preset: "write",
  cad__compare_mesh_refinement: "write",
  cad__load_preprocess: "write",

  // ---- kratos-mdpa (55) ---------------------------------------------------
  mesh__mesh_resample: "write",
  mesh__mesh_periodic: "write",
  mesh__mesh_info: "read",
  mesh__mesh_capabilities: "read",
  mesh__plot_table_read: "read",
  mesh__plot_dataset: "write", // Optional CSV/provenance export.
  // mesh 5.10.0: a named preset (sectionComparison/volumeTotal/
  // tensorComponents/heatFluxBalance/tableRelationship). Read-shaped until
  // it is given evaluate/threshold/differences, and outputPath writes a CSV —
  // the same call shape as plot_dataset above, so the same conservative class.
  // No row in toolPaths.ts: `params` is opaque (tableRelationship carries a
  // table path in it), so a project-folder grant could not account for every
  // path. Unlisted ⇒ it asks, exactly like plot_dataset.
  mesh__plot_preset: "write",
  mesh__plot_runs: "read",
  mesh__plot_run_bind: "read",
  mesh__plot_time_cursor: "read",
  mesh__plot_run_target: "read",
  // mesh 5.12.0's plot_run_resolve: run/image references resolved against what
  // is on disk — a pure lookup beside the bind/time-cursor rows.
  mesh__plot_run_resolve: "read",
  mesh__mesh_quality: "read",
  mesh__mesh_field_integrate: "read",
  mesh__mesh_flow_balance: "write",
  mesh__mesh_curvature: "read",
  mesh__mesh_compare: "write",
  mesh__mesh_derive: "write",
  mesh__mesh_size: "read",
  mesh__mesh_split: "write",
  mesh__mesh_batch_transform: "write",
  mesh__mesh_find_entity: "read",
  mesh__case_validate: "read",
  mesh__case_status: "read",
  // mesh 5.5.0 convergence history is read-only except its optional .csv
  // export — like mesh_select/mesh_probe, the conservative class wins.
  mesh__case_convergence: "write",
  // mesh 5.5.0 saved monitors: list/evaluate read, but set/remove write the
  // sidecar and evaluate can write a .csv — same conservative rule.
  mesh__case_monitors: "write",
  // mesh 5.11.0 optimization progress is read-only except its optional .csv
  // export — the same conservative outputPath rule as case_convergence above.
  mesh__case_optimization: "write",
  // mesh 5.11.0 ROM results: bounded lists only, no output path — pure read.
  mesh__case_rom: "read",
  // mesh 5.12.0's result conversion: frames into other meshio++ formats under
  // `folder` (default "converted", relative to the case folder) — the same
  // tools the File menu's Convert Results item calls.
  mesh__case_export_results: "write",
  // mesh 5.14.0's Export Optimized Geometry as CAD: the final design-field
  // frame through mesh's own .step pipeline (auto-fit + .cad.json companion)
  // beside the exported STEP — write-shaped like every mesh__* file target.
  mesh__case_optimization_cad: "write",
  mesh__case_compare: "read",
  mesh__case_evaluate_quantity: "read",
  mesh__case_estimate_timestep: "read",
  mesh__mesh_select: "write",
  mesh__mesh_probe: "write",
  mesh__mesh_transform: "write",
  mesh__mesh_convert: "write",
  mesh__mesh_extract_submodelpart: "write",
  mesh__mesh_extract_skin: "write",
  mesh__mesh_export_table: "write",
  mesh__mesh_field_series: "write",
  mesh__mesh_pack_series: "write",
  mesh__problemtype_list: "write",
  mesh__problemtype_describe: "write",
  mesh__case_write_state: "write",
  mesh__case_material_assign: "write",
  mesh__case_generate: "write",
  mesh__case_run: "write",
  mesh__case_stop: "write",
  mesh__problem_pack: "write",
  mesh__problem_unpack: "write",
  mesh__material_preset_list: "read",
  mesh__material_preset_import: "write",
  // mesh 5.15.0's virtual wind tunnel: the plan is pure measurement, the
  // generate writes the mesh, the placed body, the recipe and the case files.
  mesh__wind_tunnel_plan: "read",
  mesh__wind_tunnel_generate: "write",

  // ---- the aggregation layer's own synthetic tools (4) --------------------
  // Served in-process by McpManager.callMetaTool; they only ever list or read.
  mcp__list_resources: "read",
  mcp__read_resource: "read",
  mcp__list_prompts: "read",
  mcp__get_prompt: "read",


  // ---- pdf-insight-mcp (12), reviewed at PDF_TOOLS_REVIEWED_VERSION --------
  // All read-only: every tool takes a `file_path` and returns text/JSON; none
  // writes (the image tools return base64 in the result, not files).
  pdf__get_pdf_info: "read",
  pdf__read_pdf_as_text: "read",
  pdf__read_pdf_as_images: "read",
  pdf__get_pdf_outline: "read",
  pdf__search_pdf_text: "read",
  pdf__extract_pdf_tables: "read",
  pdf__extract_pdf_images: "read",
  pdf__get_pdf_page_info: "read",
  pdf__extract_pdf_links: "read",
  pdf__get_pdf_annotations: "read",
  pdf__get_pdf_text_stats: "read",
  pdf__compare_pdf_pages: "read",

  // ---- kratos-mcp-server (110), reviewed at KRATOS_TOOLS_REVIEWED_VERSION ---
  // Read: inspection, listing, validation and job/study/session status only.
  kratos__kratos_check_installation: "read",
  kratos__kratos_list_applications: "read",
  kratos__kratos_list_elements: "read",
  kratos__kratos_list_conditions: "read",
  kratos__kratos_list_constitutive_laws: "read",
  kratos__kratos_list_variables: "read",
  kratos__kratos_list_solvers: "read",
  kratos__kratos_list_processes: "read",
  kratos__kratos_get_process_defaults: "read",
  kratos__kratos_get_solver_defaults: "read",
  kratos__kratos_get_variable_info: "read",
  kratos__explain_project_parameters: "read",
  kratos__mdpa_inspect: "read",
  kratos__mdpa_validate: "read",
  kratos__mdpa_get_nodes: "read",
  kratos__mdpa_get_entities: "read",
  kratos__mdpa_get_data_blocks: "read",
  kratos__mdpa_select_nodes: "read",
  kratos__mdpa_quality: "read",
  kratos__materials_check: "read",
  kratos__materials_get: "read",
  kratos__project_get_setting: "read",
  kratos__project_list_processes: "read",
  kratos__results_list: "read",
  kratos__results_summary: "read",
  kratos__results_probe: "read",
  kratos__results_convergence: "read",
  kratos__list_templates: "read",
  kratos__list_material_presets: "read",
  kratos__list_linear_solver_presets: "read",
  kratos__validate_project_parameters: "read",
  kratos__validate_case: "read",
  kratos__job_status: "read",
  kratos__job_list: "read",
  kratos__job_logs: "read",
  kratos__job_checkpoints: "read",
  kratos__study_status: "read",
  kratos__study_list: "read",
  kratos__session_list: "read",
  kratos__session_status: "read",
  kratos__session_field_summary: "read",
  kratos__session_get_parameters: "read",
  kratos__session_inspect_element: "read",
  kratos__session_inspect_node: "read",
  kratos__session_model_info: "read",
  // Write: scaffolding, solver/job/session control, pip install, and every tool that
  // writes an output file (rendering and animation always; the time-history,
  // compare and study-result tools when `csv_file` is given — the table cannot
  // see arguments, so the conservative class wins). The mdpa_* editors and the
  // materials/project setters write in place or to `output`, so they are write
  // even when the write is optional.
  kratos__kratos_install: "write",
  kratos__run_simulation: "write",
  kratos__job_cancel: "write",
  kratos__job_rerun: "write",
  kratos__job_resume: "write",
  kratos__configure_checkpoints: "write",
  kratos__study_start: "write",
  kratos__study_cancel: "write",
  kratos__study_resume: "write",
  kratos__create_project: "write",
  kratos__create_multistage_project: "write",
  kratos__create_cosim_project: "write",
  kratos__create_fsi_project: "write",
  kratos__create_project_parameters: "write",
  kratos__create_materials: "write",
  kratos__materials_set_property: "write",
  kratos__materials_remove_property: "write",
  kratos__add_boundary_condition: "write",
  kratos__add_output_process: "write",
  kratos__add_remeshing_process: "write",
  kratos__project_add_process: "write",
  kratos__project_set_setting: "write",
  kratos__project_delete_setting: "write",
  kratos__project_remove_process: "write",
  kratos__project_update_process: "write",
  kratos__project_update_solver: "write",
  kratos__mdpa_create_structured_mesh: "write",
  kratos__mdpa_create_geometry_mesh: "write",
  kratos__mdpa_add_nodes: "write",
  kratos__mdpa_move_nodes: "write",
  kratos__mdpa_delete_nodes: "write",
  kratos__mdpa_add_entities: "write",
  kratos__mdpa_delete_entities: "write",
  kratos__mdpa_set_entity_properties: "write",
  kratos__mdpa_create_sub_model_part: "write",
  kratos__mdpa_edit_sub_model_part: "write",
  kratos__mdpa_set_sub_model_part_data: "write",
  kratos__mdpa_transform: "write",
  kratos__mdpa_merge: "write",
  kratos__mdpa_renumber: "write",
  kratos__mdpa_extract: "write",
  kratos__mdpa_extrude: "write",
  kratos__mdpa_convert_cells: "write",
  kratos__mdpa_extract_boundary: "write",
  kratos__mdpa_set_properties: "write",
  kratos__mdpa_set_nodal_data: "write",
  kratos__mdpa_set_elemental_data: "write",
  kratos__mdpa_set_table: "write",
  kratos__mdpa_delete_table: "write",
  kratos__mesh_import: "write",
  kratos__mesh_export: "write",
  kratos__mesh_generate_gmsh: "write",
  kratos__mesh_remesh: "write",
  kratos__session_start: "write",
  kratos__session_advance: "write",
  kratos__session_close: "write",
  kratos__session_exec_python: "write",
  kratos__session_set_nodal_values: "write",
  kratos__export_case_to_flowgraph: "write",
  kratos__import_flowgraph_to_case: "write",
  kratos__results_render: "write",
  kratos__results_animate: "write",
  kratos__results_time_history: "write",
  kratos__results_compare: "write",
  kratos__study_results: "write",
};

/**
 * Tools that can be asked to validate without persisting.
 *
 * Drives the approval prompt's **Validate (dry run)** button. The semantics
 * question this table used to record — "what does the model believe happened,
 * once we hand it a result for a call it never made?" — was answered by not
 * creating the situation: a dry run does not settle the approval and its report
 * never enters the transcript, so it is a check for the human and the model
 * sees nothing. See `dryRunArgs` and ChatService's `dryRunTool` handler.
 *
 * What it actually checks is narrower than "preview": cad gates the OCCT replay
 * on `!dryRun` too, so the report says which ops parse and are legal, never what
 * the geometry would become. The button and its result block say so.
 */
export const DRY_RUN_PARAM: Readonly<Record<string, string>> = {
  cad__apply_edit_ops: "dryRun",
  cad__run_parametric_script: "dryRun",
  cad__run_saved_script: "dryRun",
  cad__import_svg: "dryRun",
};

/**
 * The model's own arguments, rewritten to ask for a validation-only run — or
 * `null` when this call cannot be dry-run at all, which is also what decides
 * whether the button is offered.
 *
 * Returns `null` for: a tool with no row, unparseable JSON, a payload that is
 * not a plain object (`"[]"`, `"3"`, `"null"` would otherwise take a property),
 * and a call the model already marked `dryRun: true` — where the button would
 * be a no-op. An explicit `dryRun: false` is *overridden*, since the user asking
 * to validate outranks the model's default.
 *
 * Never mutates its input: the user approves the arguments they were shown, and
 * the chip renders that exact string.
 */
export function dryRunArgs(namespaced: string, argsJson: string): string | null {
  const param = DRY_RUN_PARAM[namespaced];
  if (!param) return null;
  let parsed: unknown;
  try {
    parsed = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const args = parsed as Record<string, unknown>;
  if (args[param] === true) return null;
  return JSON.stringify({ ...args, [param]: true });
}

export function classifyTool(namespaced: string): ToolClass {
  return TOOL_ACCESS[namespaced] ?? "unknown";
}

export interface GateOptions {
  mode: ApprovalMode;
  /** Tools the user chose "always allow" for, in this conversation. */
  allowed: ReadonlySet<string>;
  /**
   * "Always allow in the project folder" grants for this conversation, plus the
   * check that *this* call's paths lie inside the explicit project root. The
   * check is injected so this module stays free of `node:*`; it is only asked
   * when the tool is a granted `write` tool.
   */
  scoped?: { granted: ReadonlySet<string>; inside(): boolean };
}

/**
 * Whether this call runs straight away or has to be approved.
 *
 * Precedence, in order — the first two are deliberate:
 * 1. `never` wins over everything, including `unknown`. It is an explicit,
 *    dialog-confirmed opt-out; half-honouring it would be worse than not
 *    offering it.
 * 2. An "always allow" grant beats `askAlways`. A user who said *always allow
 *    this one, in this conversation* meant it, and re-asking would train them
 *    to stop reading the prompt.
 * 3. A project-folder grant behaves the same way, but only for a `write` tool
 *    and only while every path in the call is inside the project root; any
 *    other call falls through to the normal rules and asks.
 */
export function gateFor(namespaced: string, options: GateOptions): ToolGate {
  if (options.mode === "never") return "auto";
  if (options.allowed.has(namespaced)) return "auto";
  if (
    options.scoped &&
    options.scoped.granted.has(namespaced) &&
    classifyTool(namespaced) === "write" &&
    options.scoped.inside()
  ) {
    return "auto";
  }
  if (options.mode === "askAlways") return "ask";
  return classifyTool(namespaced) === "read" ? "auto" : "ask";
}

/**
 * Advertised tools this table has no row for — the seam a submodule or
 * `KRATOS_MCP_VERSION` bump is noticed through.
 *
 * An unclassified tool is safe (it asks), but a tree of them quietly degrades
 * into "ask about everything", which is how an approval gate stops being read.
 * `ChatService` logs this once per turn so a maintainer sees exactly which
 * names a bump introduced.
 */
export function unclassifiedTools(tools: readonly { name: string }[]): string[] {
  return tools.filter((tool) => classifyTool(tool.name) === "unknown").map((tool) => tool.name);
}
