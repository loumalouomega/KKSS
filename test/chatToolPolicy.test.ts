/**
 * services/chat/toolPolicy.ts — which MCP tools the assistant may run without
 * asking.
 *
 * Two things are being defended here. The obvious one is that a write tool is
 * never auto-approved. The subtler one is that the table stays *deliberate*: it
 * is the only thing standing between the model and a tool that overwrites the
 * file it is given, so a row appearing or disappearing must be a reviewed edit
 * rather than a side effect of a submodule bump — hence the frozen snapshot at
 * the bottom.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyTool,
  DEFAULT_APPROVAL_MODE,
  DRY_RUN_PARAM,
  dryRunArgs,
  gateFor,
  isApprovalMode,
  TOOL_ACCESS,
  KRATOS_TOOLS_REVIEWED_VERSION,
  PDF_TOOLS_REVIEWED_VERSION,
  type ApprovalMode,
  unclassifiedTools,
} from "../app/main/services/chat/toolPolicy";
import {
  DEFAULT_META_ACCESS,
  isMetaAccess,
  metaAccessMigration,
  metaToolAllowed,
  normalizeAllowedWrites,
  readMetaAccess,
} from "../app/main/services/metaServer/accessPolicy";
import { KRATOS_MCP_VERSION } from "../app/main/services/chat/kratosMcpVersion";
import { PDF_MCP_VERSION } from "../app/main/services/chat/pdfMcpVersion";

const none = new Set<string>();
const root = path.resolve(__dirname, "..");
const gate = (name: string, mode: ApprovalMode, allowed = none) => gateFor(name, { mode, allowed });

describe("classifyTool", () => {
  it("reads the class off the table for a known tool", () => {
    expect(classifyTool("cad__inspect")).toBe("read");
    expect(classifyTool("mesh__mesh_info")).toBe("read");
    expect(classifyTool("mcp__list_resources")).toBe("read");
    expect(classifyTool("cad__apply_edit_ops")).toBe("write");
    expect(classifyTool("mesh__mesh_transform")).toBe("write");
  });

  it("pins the judgment calls, so changing one is deliberate", () => {
    // Reads like a pure fit, but `store:"plane"` writes the planes sidecar and
    // store:"cylinder"/"sphere" appends an op to the edits sidecar.
    expect(classifyTool("cad__fit_mesh_region")).toBe("write");
    // Optional outputPath writes a B-rep; saveScript.libraryPath writes the
    // script library.
    expect(classifyTool("cad__decompose_to_primitives")).toBe("write");
    // Write only *when* outputPath is given — a name-keyed table cannot see
    // arguments, so the conservative class wins.
    expect(classifyTool("mesh__mesh_export_table")).toBe("write");
    expect(classifyTool("mesh__mesh_field_series")).toBe("write");
    expect(classifyTool("mesh__plot_dataset")).toBe("write");
    for (const name of ["plot_table_read", "plot_runs", "plot_run_bind", "plot_time_cursor", "plot_run_target"]) {
      expect(classifyTool(`mesh__${name}`)).toBe("read");
    }
    expect(classifyTool("mesh__mesh_select")).toBe("write");
    expect(classifyTool("mesh__mesh_probe")).toBe("write");
    expect(gate("mesh__mesh_probe", "askOnWrite")).toBe("ask");
    expect(gate("mesh__mesh_select", "askOnWrite")).toBe("ask");
    expect(gate("mesh__mesh_select", "askAlways")).toBe("ask");
    expect(gate("mesh__mesh_select", "never")).toBe("auto");
    // Read-shaped, but loading a workspace problemtype EXECUTES it (node:vm /
    // pyodide) — the same reasoning as CLAUDE.md's workspaceFolders invariant.
    expect(classifyTool("mesh__problemtype_list")).toBe("write");
    expect(classifyTool("mesh__problemtype_describe")).toBe("write");
    // Signals a process rather than writing a file, but still state change
    // outside this one.
    expect(classifyTool("mesh__case_stop")).toBe("write");
    // The only tool that reaches the network — but it writes nothing, and
    // download_standard_part is where bytes actually land.
    expect(classifyTool("cad__search_standard_parts")).toBe("read");
    expect(classifyTool("cad__download_standard_part")).toBe("write");
    // Slow is not destructive: statistics only, options not persisted.
    expect(classifyTool("cad__generate_mesh")).toBe("read");
    // New CAD diagnostics are read-only except the deviation map's optional
    // output PLY; mesh analysis/report-only tools remain read-only where they
    // do not write a caller-selected output file.
    expect(classifyTool("cad__check_brep_health")).toBe("read");
    expect(classifyTool("cad__analyze_passages")).toBe("read");
    expect(classifyTool("cad__estimate_mesh_budget")).toBe("read");
    expect(classifyTool("cad__check_handoff_manifest")).toBe("read");
    expect(classifyTool("cad__measure_mesh_deviation")).toBe("write");
    // cad 3.11.0 MMG remesh always writes a new .med + Parts sidecar.
    expect(classifyTool("cad__remesh_mesh")).toBe("write");
    // cad 3.12.0 OpenSCAD Customizer: listing parameters reads only,
    // converting with overrides writes a new .csg.
    expect(classifyTool("cad__list_scad_parameters")).toBe("read");
    expect(classifyTool("cad__convert_scad")).toBe("write");
    expect(classifyTool("mesh__mesh_curvature")).toBe("read");
    expect(classifyTool("mesh__mesh_flow_balance")).toBe("write");
    expect(classifyTool("mesh__mesh_resample")).toBe("write");
    expect(classifyTool("mesh__material_preset_list")).toBe("read");
    expect(classifyTool("mesh__material_preset_import")).toBe("write");
    // mesh 5.5.0 convergence history and saved monitors: both can write a
    // .csv via outputPath (monitors also writes the sidecar on set/remove),
    // so both are write by the conservative outputPath rule.
    expect(classifyTool("mesh__case_convergence")).toBe("write");
    expect(classifyTool("mesh__case_monitors")).toBe("write");
  });

  it("treats anything the table does not name as unknown", () => {
    // A tool a newer kratos-mcp-server adds beyond the reviewed pin.
    expect(classifyTool("kratos__not_in_the_pinned_server")).toBe("unknown");
    // A tool a future submodule bump adds.
    expect(classifyTool("cad__does_not_exist_yet")).toBe("unknown");
    // Malformed names must not throw or accidentally match.
    expect(classifyTool("")).toBe("unknown");
    expect(classifyTool("no_namespace")).toBe("unknown");
    expect(classifyTool("__")).toBe("unknown");
  });

  it("does not infer a class from the tool's name", () => {
    // The rejected heuristic, pinned: `problemtype_list` looks like a listing
    // and is not one. If someone ever adds prefix matching, this fails.
    expect(classifyTool("mesh__problemtype_list")).toBe("write");
    expect(classifyTool("kratos__list_projects")).toBe("unknown");
    expect(classifyTool("kratos__list_templates")).toBe("read");
  });
});

describe("gateFor", () => {
  it.each(["study_start", "study_cancel", "study_resume", "job_rerun", "job_resume", "configure_checkpoints", "results_time_history", "results_compare", "study_results"])("classifies Kratos write tool %s and gates it", (name) => {
    const tool = `kratos__${name}`;
    expect(classifyTool(tool)).toBe("write");
    expect(gate(tool, "askOnWrite")).toBe("ask");
    expect(gate(tool, "askAlways")).toBe("ask");
  });
  it.each(["job_status", "job_list", "job_logs", "job_checkpoints", "study_status", "study_list", "validate_case", "results_summary"])("runs Kratos read tool %s without asking", (name) => {
    const tool = `kratos__${name}`;
    expect(classifyTool(tool)).toBe("read");
    expect(gate(tool, "askOnWrite")).toBe("auto");
    expect(gate(tool, "askAlways")).toBe("ask");
  });
  it("auto-approves reads and asks for writes in the default mode", () => {
    expect(DEFAULT_APPROVAL_MODE).toBe("askOnWrite");
    expect(gate("cad__inspect", "askOnWrite")).toBe("auto");
    expect(gate("cad__apply_edit_ops", "askOnWrite")).toBe("ask");
  });

  it("asks about an unknown tool — the whole point of the default", () => {
    expect(gate("kratos__not_in_the_pinned_server", "askOnWrite")).toBe("ask");
    expect(gate("kratos__not_in_the_pinned_server", "askAlways")).toBe("ask");
    expect(gate("kratos__run_simulation", "askOnWrite")).toBe("ask");
  });

  it("asks about everything in askAlways, reads included", () => {
    expect(gate("cad__inspect", "askAlways")).toBe("ask");
    expect(gate("mcp__list_prompts", "askAlways")).toBe("ask");
  });

  it("runs everything in never, unknown tools included", () => {
    // An explicit, dialog-confirmed opt-out. Half-honouring it would be worse
    // than not offering it at all.
    expect(gate("cad__apply_edit_ops", "never")).toBe("auto");
    expect(gate("kratos__not_in_the_pinned_server", "never")).toBe("auto");
  });

  it("lets an always-allow grant cover a write and an unknown tool", () => {
    const allowed = new Set(["cad__apply_edit_ops", "kratos__not_in_the_pinned_server"]);
    expect(gate("cad__apply_edit_ops", "askOnWrite", allowed)).toBe("auto");
    expect(gate("kratos__not_in_the_pinned_server", "askOnWrite", allowed)).toBe("auto");
    // ...but only the tools actually granted.
    expect(gate("cad__export_mesh", "askOnWrite", allowed)).toBe("ask");
  });

  it("lets an always-allow grant beat askAlways", () => {
    // A user who said "always allow this one, in this conversation" meant it;
    // re-asking anyway is how people learn to stop reading the prompt.
    const allowed = new Set(["cad__inspect"]);
    expect(gate("cad__inspect", "askAlways", allowed)).toBe("auto");
    expect(gate("cad__measure", "askAlways", allowed)).toBe("ask");
  });
});

describe("isApprovalMode", () => {
  it("accepts the three modes and rejects anything else", () => {
    for (const mode of ["askOnWrite", "askAlways", "never"]) {
      expect(isApprovalMode(mode)).toBe(true);
    }
    // A hand-edited state.json must degrade to the default, not to "never".
    expect(isApprovalMode("off")).toBe(false);
    expect(isApprovalMode(undefined)).toBe(false);
    expect(isApprovalMode(true)).toBe(false);
  });
});

describe("unclassifiedTools", () => {
  it("names exactly the tools the table has no row for", () => {
    expect(
      unclassifiedTools([
        { name: "cad__inspect" },
        { name: "kratos__newer_server_tool" },
        { name: "mesh__mesh_transform" },
        { name: "kratos__job_list" },
        { name: "kratos__another_new_tool" },
      ])
    ).toEqual(["kratos__newer_server_tool", "kratos__another_new_tool"]);
  });

  it("is empty when every advertised tool is classified", () => {
    expect(unclassifiedTools([{ name: "cad__inspect" }, { name: "mcp__get_prompt" }])).toEqual([]);
    expect(unclassifiedTools([])).toEqual([]);
  });
});

describe("the table itself", () => {
  it("covers bundled-server, aggregation, and app-owned tools explicitly", () => {
    // 74 cad + 46 mesh tools + 4 in-process mcp__ tools + 31 app__ workflow tools
    // + 110 kratos-mcp-server tools + 12 pdf-insight-mcp tools (each reviewed at its pinned version).
    // A submodule or app-owned tool addition
    // leaves it unclassified — safe, but it must be a *noticed* omission, so
    // this count is asserted rather than inferred.
    expect(Object.keys(TOOL_ACCESS)).toHaveLength(277);
    const cad = Object.keys(TOOL_ACCESS).filter((n) => n.startsWith("cad__"));
    const mesh = Object.keys(TOOL_ACCESS).filter((n) => n.startsWith("mesh__"));
    const meta = Object.keys(TOOL_ACCESS).filter((n) => n.startsWith("mcp__"));
    const app = Object.keys(TOOL_ACCESS).filter((n) => n.startsWith("app__"));
    expect(cad).toHaveLength(74);
    expect(mesh).toHaveLength(46);
    expect(meta).toHaveLength(4);
    expect(app).toHaveLength(31);
    const kratos = Object.keys(TOOL_ACCESS).filter((n) => n.startsWith("kratos__"));
    expect(kratos).toHaveLength(110);
    const pdf = Object.keys(TOOL_ACCESS).filter((n) => n.startsWith("pdf__"));
    expect(pdf).toHaveLength(12);
    expect(cad.length + mesh.length + meta.length + app.length + kratos.length + pdf.length).toBe(Object.keys(TOOL_ACCESS).length);
  });

  it("matches every currently registered CAD and mesh MCP tool by exact name", () => {
    const registrations = (file: string, prefix: string) => {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      return [...source.matchAll(/(?:server\.)?registerTool\s*\(\s*["']([^"']+)["']/g)]
        .map((match) => `${prefix}__${match[1]}`)
        .sort();
    };
    const actual = [
      ...registrations("cad/src/mcpServer.ts", "cad"),
      ...registrations("mesh/src/mcp/register.ts", "mesh"),
    ].sort();
    const classified = Object.keys(TOOL_ACCESS)
      .filter((name) => name.startsWith("cad__") || name.startsWith("mesh__"))
      .sort();
    expect(classified).toEqual(actual);
  });

  it("ties the PDF rows to the pinned server release, and every one is read-only", () => {
    expect(PDF_TOOLS_REVIEWED_VERSION).toBe(PDF_MCP_VERSION);
    const rows = Object.entries(TOOL_ACCESS).filter(([name]) => name.startsWith("pdf__"));
    expect(rows.every(([, access]) => access === "read")).toBe(true);
  });

  it("ties the Kratos rows to the pinned server release", () => {
    // Bumping KRATOS_MCP_VERSION must be a reviewed edit: re-read the new
    // release's tool list, update the rows below, then move the marker.
    expect(KRATOS_TOOLS_REVIEWED_VERSION).toBe(KRATOS_MCP_VERSION);
    const kratos = (access: string) =>
      Object.entries(TOOL_ACCESS)
        .filter(([name, a]) => name.startsWith("kratos__") && a === access)
        .map(([name]) => name.slice("kratos__".length))
        .sort();
    expect(kratos("read")).toEqual([
      "explain_project_parameters",
      "job_checkpoints",
      "job_list",
      "job_logs",
      "job_status",
      "kratos_check_installation",
      "kratos_get_process_defaults",
      "kratos_get_solver_defaults",
      "kratos_get_variable_info",
      "kratos_list_applications",
      "kratos_list_conditions",
      "kratos_list_constitutive_laws",
      "kratos_list_elements",
      "kratos_list_processes",
      "kratos_list_solvers",
      "kratos_list_variables",
      "list_linear_solver_presets",
      "list_material_presets",
      "list_templates",
      "materials_check",
      "materials_get",
      "mdpa_get_data_blocks",
      "mdpa_get_entities",
      "mdpa_get_nodes",
      "mdpa_inspect",
      "mdpa_quality",
      "mdpa_select_nodes",
      "mdpa_validate",
      "project_get_setting",
      "project_list_processes",
      "results_convergence",
      "results_list",
      "results_probe",
      "results_summary",
      "session_field_summary",
      "session_get_parameters",
      "session_inspect_element",
      "session_inspect_node",
      "session_list",
      "session_model_info",
      "session_status",
      "study_list",
      "study_status",
      "validate_case",
      "validate_project_parameters",
    ]);
    expect(kratos("write")).toEqual([
      "add_boundary_condition",
      "add_output_process",
      "add_remeshing_process",
      "configure_checkpoints",
      "create_cosim_project",
      "create_fsi_project",
      "create_materials",
      "create_multistage_project",
      "create_project",
      "create_project_parameters",
      "export_case_to_flowgraph",
      "import_flowgraph_to_case",
      "job_cancel",
      "job_rerun",
      "job_resume",
      "kratos_install",
      "materials_remove_property",
      "materials_set_property",
      "mdpa_add_entities",
      "mdpa_add_nodes",
      "mdpa_convert_cells",
      "mdpa_create_geometry_mesh",
      "mdpa_create_structured_mesh",
      "mdpa_create_sub_model_part",
      "mdpa_delete_entities",
      "mdpa_delete_nodes",
      "mdpa_delete_table",
      "mdpa_edit_sub_model_part",
      "mdpa_extract",
      "mdpa_extract_boundary",
      "mdpa_extrude",
      "mdpa_merge",
      "mdpa_move_nodes",
      "mdpa_renumber",
      "mdpa_set_elemental_data",
      "mdpa_set_entity_properties",
      "mdpa_set_nodal_data",
      "mdpa_set_properties",
      "mdpa_set_sub_model_part_data",
      "mdpa_set_table",
      "mdpa_transform",
      "mesh_export",
      "mesh_generate_gmsh",
      "mesh_import",
      "mesh_remesh",
      "project_add_process",
      "project_delete_setting",
      "project_remove_process",
      "project_set_setting",
      "project_update_process",
      "project_update_solver",
      "results_animate",
      "results_compare",
      "results_render",
      "results_time_history",
      "run_simulation",
      "session_advance",
      "session_close",
      "session_exec_python",
      "session_set_nodal_values",
      "session_start",
      "study_cancel",
      "study_results",
      "study_resume",
      "study_start",
    ]);
  });

  it("names every write tool explicitly, so the list is reviewable", () => {
    const writes = Object.entries(TOOL_ACCESS)
      .filter(([name, access]) => access === "write" && !name.startsWith("kratos__"))
      .map(([name]) => name)
      .sort();
    expect(writes).toEqual([
      "app__queue_cancel",
      "app__queue_enqueue",
      "app__queue_pause",
      "app__queue_reorder",
      "app__queue_resume",
      "app__queue_resume_row",
      "app__run_quantity_evaluate",
      "app__run_refinement_set",
      "app__run_review_export",
      "app__study_attach_mesh",
      "app__study_copy_source_into_project",
      "app__study_create",
      "app__study_duplicate",
      "app__study_import_handoff",
      "app__study_import_run",
      "app__study_open",
      "app__study_relink_source",
      "app__study_select",
      "app__study_set_settings",
      "app__variants_compare_export",
      "app__variants_create",
      "cad__apply_edit_ops",
      "cad__apply_mesh_preset",
      "cad__assign_layer",
      "cad__batch_export",
      "cad__compare_mesh_refinement",
      "cad__convert_scad",
      "cad__decompose_to_primitives",
      "cad__download_standard_part",
      "cad__export_brep",
      "cad__export_drawing_sheet",
      "cad__export_mesh",
      "cad__export_svg_silhouette",
      "cad__export_technical_drawing",
      "cad__export_tessellated_stl",
      "cad__fit_mesh_region",
      "cad__generate_prep_report",
      "cad__import_svg",
      "cad__job_cancel",
      "cad__load_preprocess",
      "cad__measure_mesh_deviation",
      "cad__pin_annotation",
      "cad__promote_mesh_to_brep",
      "cad__remesh_mesh",
      "cad__remove_edit_op",
      "cad__repair_mesh",
      "cad__run_parametric_script",
      "cad__run_saved_script",
      "cad__save_mesh_preset",
      "cad__save_model",
      "cad__save_parametric_script",
      "cad__save_preprocess",
      "cad__save_sheet_template",
      "cad__set_layer",
      "cad__set_mesh_options",
      "cad__set_part",
      "cad__set_plane",
      "cad__set_variables",
      "cad__transform_mesh",
      "mesh__case_convergence",
      "mesh__case_generate",
      "mesh__case_material_assign",
      "mesh__case_monitors",
      "mesh__case_run",
      "mesh__case_stop",
      "mesh__case_write_state",
      "mesh__material_preset_import",
      "mesh__mesh_batch_transform",
      "mesh__mesh_compare",
      "mesh__mesh_convert",
      "mesh__mesh_derive",
      "mesh__mesh_export_table",
      "mesh__mesh_extract_skin",
      "mesh__mesh_extract_submodelpart",
      "mesh__mesh_field_series",
      "mesh__mesh_flow_balance",
      "mesh__mesh_pack_series",
      "mesh__mesh_periodic",
      "mesh__mesh_probe",
      "mesh__mesh_resample",
      "mesh__mesh_select",
      "mesh__mesh_split",
      "mesh__mesh_transform",
      "mesh__plot_dataset",
      "mesh__problem_pack",
      "mesh__problem_unpack",
      "mesh__problemtype_describe",
      "mesh__problemtype_list",
    ]);
  });

  it("only names dry-run parameters for tools that actually declare one", () => {
    // Drives the prompt's Validate button, so a row here must be a real tool
    // that really takes the parameter — a wrong one offers a button that fails.
    for (const name of Object.keys(DRY_RUN_PARAM)) {
      expect(classifyTool(name)).not.toBe("unknown");
    }
    expect(Object.keys(DRY_RUN_PARAM).sort()).toEqual([
      "cad__apply_edit_ops",
      "cad__import_svg",
      "cad__run_parametric_script",
      "cad__run_saved_script",
    ]);
  });
});

describe("dryRunArgs", () => {
  const CALL = "cad__apply_edit_ops";

  it("asks for validation while leaving the model's other arguments intact", () => {
    for (const name of Object.keys(DRY_RUN_PARAM)) {
      const rewritten = dryRunArgs(name, '{"path":"/a.stp","ops":[1]}');
      expect(rewritten && JSON.parse(rewritten)).toEqual({ path: "/a.stp", ops: [1], dryRun: true });
    }
  });

  it("does not mutate the arguments the user was shown", () => {
    const argsJson = '{"path":"/a.stp"}';
    dryRunArgs(CALL, argsJson);
    expect(argsJson).toBe('{"path":"/a.stp"}');
  });

  it("declines a tool that has no dry-run parameter", () => {
    expect(dryRunArgs("mesh__mesh_transform", '{"path":"/a.mdpa"}')).toBeNull();
    expect(dryRunArgs("kratos__run_simulation", "{}")).toBeNull();
  });

  it("declines arguments that are not a JSON object", () => {
    // A property set on an array or a number would be silently lost, and the
    // button would report on a call the server never saw the way we meant it.
    expect(dryRunArgs(CALL, "not json")).toBeNull();
    expect(dryRunArgs(CALL, "[]")).toBeNull();
    expect(dryRunArgs(CALL, "3")).toBeNull();
    expect(dryRunArgs(CALL, "null")).toBeNull();
  });

  it("declines a call the model already marked as a dry run", () => {
    expect(dryRunArgs(CALL, '{"path":"/a.stp","dryRun":true}')).toBeNull();
  });

  it("overrides an explicit false — asking to validate outranks the default", () => {
    const rewritten = dryRunArgs(CALL, '{"path":"/a.stp","dryRun":false}');
    expect(rewritten && JSON.parse(rewritten)).toEqual({ path: "/a.stp", dryRun: true });
  });

  it("treats empty arguments as an empty object", () => {
    expect(dryRunArgs(CALL, "")).toBe('{"dryRun":true}');
  });
});

describe("meta server access policy", () => {
  const none = new Set<string>();
  it("defaults to read-only and degrades corrupt values to the default", () => {
    expect(DEFAULT_META_ACCESS).toBe("readOnly");
    expect(readMetaAccess(undefined)).toBe("readOnly");
    expect(readMetaAccess("everything")).toBe("readOnly");
    expect(readMetaAccess("all")).toBe("all");
    expect(isMetaAccess("readListed")).toBe(true);
    expect(isMetaAccess(true)).toBe(false);
  });

  it("readOnly allows read tools and nothing else", () => {
    const policy = { access: "readOnly" as const, allowedWrites: new Set(["cad__apply_edit_ops"]) };
    expect(metaToolAllowed("cad__inspect", policy)).toBe(true);
    expect(metaToolAllowed("kratos__job_status", policy)).toBe(true);
    expect(metaToolAllowed("cad__apply_edit_ops", policy)).toBe(false); // list ignored
    expect(metaToolAllowed("kratos__run_simulation", policy)).toBe(false);
    expect(metaToolAllowed("kratos__not_in_the_pinned_server", policy)).toBe(false);
  });

  it("readListed adds exactly the named tools", () => {
    const policy = { access: "readListed" as const, allowedWrites: new Set(["kratos__run_simulation"]) };
    expect(metaToolAllowed("kratos__run_simulation", policy)).toBe(true);
    expect(metaToolAllowed("kratos__job_cancel", policy)).toBe(false);
    expect(metaToolAllowed("cad__inspect", policy)).toBe(true);
  });

  it("all allows everything, unclassified tools included", () => {
    expect(metaToolAllowed("kratos__not_in_the_pinned_server", { access: "all", allowedWrites: none })).toBe(true);
    expect(metaToolAllowed("mesh__mesh_transform", { access: "all", allowedWrites: none })).toBe(true);
  });

  it("normalizes the stored allow-list", () => {
    expect([...normalizeAllowedWrites([" cad__a ", 3, "", "mesh__b"])]).toEqual(["cad__a", "mesh__b"]);
    expect(normalizeAllowedWrites("cad__a").size).toBe(0);
  });

  it("migrates only an already-configured, undecided install to all", () => {
    expect(metaAccessMigration(undefined, true, false)).toBe("all");
    expect(metaAccessMigration(undefined, false, false)).toBeUndefined(); // fresh install: safe default
    expect(metaAccessMigration("readOnly", true, false)).toBeUndefined(); // explicit choice wins
    // The default value is stored as an absent key, so only the flag prevents a
    // user who picked read-only from being promoted to "all" on the next launch.
    expect(metaAccessMigration(undefined, true, true)).toBeUndefined();
  });
});
