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
 * untrusted servers"*, and as of cad 1.12.0 / mesh 3.15.1 no bundled tool
 * declares any anyway. Two other shortcuts are rejected for the same reason:
 *
 * - **No name-prefix heuristic** (`list_*`/`get_*` ⇒ read). Inferring "safe"
 *   from a name the server chose is the same untrusted input, with worse
 *   evidence — and `problemtype_list` is precisely the counter-example.
 * - **No description scraping.** Several tools say "Read-only." in prose; a
 *   reworded description must not silently change a safety class.
 *
 * So: unlisted ⇒ `unknown` ⇒ ask. That is what makes the external
 * `kratos-mcp-server` (40 tools, resolved by uvx at runtime, not in this tree)
 * safe by default without pretending we know what its tools do.
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
 * - `mesh__mesh_export_table`, `mesh__mesh_field_series` — **write**. They write
 *   only *when* `outputPath` is given, but this table is keyed by name and
 *   cannot see arguments, so the conservative class wins.
 * - `mesh__problemtype_list`, `mesh__problemtype_describe` — **write**, which is
 *   the least obvious row here. Given `workspaceDirs` they load workspace
 *   problemtypes, and loading *executes* them (`node:vm` for `.js`, pyodide for
 *   `.py`). CLAUDE.md's `workspaceFolders` invariant already treats exactly
 *   that as a safety decision rather than a read.
 * - `mesh__case_stop` — **write**. Not a file write; it signals a process.
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
export type ApprovalDecision = "allow" | "allowAlways" | "deny";
export type ToolGate = "auto" | "ask";

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
  // ---- cad-preview (46) ---------------------------------------------------
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
  cad__recognize_primitives: "read",
  cad__list_workspace_models: "read",
  cad__get_state: "read",
  cad__list_parametric_scripts: "read",
  cad__screenshot_shape: "read",
  cad__hit_test: "read",
  cad__list_standard_hole_sizes: "read",
  cad__generate_mesh: "read",
  cad__download_standard_part: "write",
  cad__transform_mesh: "write",
  cad__decompose_to_primitives: "write",
  cad__fit_mesh_region: "write",
  cad__promote_mesh_to_brep: "write",
  cad__repair_mesh: "write",
  cad__export_technical_drawing: "write",
  cad__export_svg_silhouette: "write",
  cad__apply_edit_ops: "write",
  cad__run_parametric_script: "write",
  cad__remove_edit_op: "write",
  cad__save_parametric_script: "write",
  cad__run_saved_script: "write",
  cad__set_variables: "write",
  cad__set_part: "write",
  cad__set_plane: "write",
  cad__set_mesh_options: "write",
  cad__export_mesh: "write",
  cad__export_brep: "write",
  cad__save_preprocess: "write",
  cad__load_preprocess: "write",

  // ---- kratos-mdpa (21) ---------------------------------------------------
  mesh__mesh_info: "read",
  mesh__mesh_quality: "read",
  mesh__mesh_field_integrate: "read",
  mesh__mesh_size: "read",
  mesh__mesh_find_entity: "read",
  mesh__case_validate: "read",
  mesh__case_status: "read",
  mesh__mesh_transform: "write",
  mesh__mesh_convert: "write",
  mesh__mesh_extract_submodelpart: "write",
  mesh__mesh_extract_skin: "write",
  mesh__mesh_export_table: "write",
  mesh__mesh_field_series: "write",
  mesh__problemtype_list: "write",
  mesh__problemtype_describe: "write",
  mesh__case_write_state: "write",
  mesh__case_generate: "write",
  mesh__case_run: "write",
  mesh__case_stop: "write",
  mesh__problem_pack: "write",
  mesh__problem_unpack: "write",

  // ---- the aggregation layer's own synthetic tools (4) --------------------
  // Served in-process by McpManager.callMetaTool; they only ever list or read.
  mcp__list_resources: "read",
  mcp__read_resource: "read",
  mcp__list_prompts: "read",
  mcp__get_prompt: "read",

  // kratos-mcp-server is deliberately absent — see the module comment.
};

/**
 * Tools that can be asked to validate without persisting.
 *
 * Unused today: the approval prompt offers no Dry run button, because using it
 * would mean rewriting the arguments the model emitted and then handing it a
 * result for a call it never made — a semantics decision, not a UI one. Kept
 * here so that work is an isolated change rather than an archaeology exercise.
 */
export const DRY_RUN_PARAM: Readonly<Record<string, string>> = {
  cad__apply_edit_ops: "dryRun",
  cad__run_parametric_script: "dryRun",
  cad__run_saved_script: "dryRun",
};

export function classifyTool(namespaced: string): ToolClass {
  return TOOL_ACCESS[namespaced] ?? "unknown";
}

export interface GateOptions {
  mode: ApprovalMode;
  /** Tools the user chose "always allow" for, in this conversation. */
  allowed: ReadonlySet<string>;
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
 */
export function gateFor(namespaced: string, options: GateOptions): ToolGate {
  if (options.mode === "never") return "auto";
  if (options.allowed.has(namespaced)) return "auto";
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
