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
import {
  classifyTool,
  DEFAULT_APPROVAL_MODE,
  DRY_RUN_PARAM,
  dryRunArgs,
  gateFor,
  isApprovalMode,
  TOOL_ACCESS,
  type ApprovalMode,
  unclassifiedTools,
} from "../app/main/services/chat/toolPolicy";

const none = new Set<string>();
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
  });

  it("treats anything the table does not name as unknown", () => {
    // Every kratos tool, always: that server is resolved by uvx at runtime and
    // is not in this tree, so we cannot honestly classify any of its 40 tools.
    expect(classifyTool("kratos__run_simulation")).toBe("unknown");
    expect(classifyTool("kratos__create_project")).toBe("unknown");
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
  });
});

describe("gateFor", () => {
  it("auto-approves reads and asks for writes in the default mode", () => {
    expect(DEFAULT_APPROVAL_MODE).toBe("askOnWrite");
    expect(gate("cad__inspect", "askOnWrite")).toBe("auto");
    expect(gate("cad__apply_edit_ops", "askOnWrite")).toBe("ask");
  });

  it("asks about an unknown tool — the whole point of the default", () => {
    expect(gate("kratos__run_simulation", "askOnWrite")).toBe("ask");
    expect(gate("kratos__run_simulation", "askAlways")).toBe("ask");
  });

  it("asks about everything in askAlways, reads included", () => {
    expect(gate("cad__inspect", "askAlways")).toBe("ask");
    expect(gate("mcp__list_prompts", "askAlways")).toBe("ask");
  });

  it("runs everything in never, unknown tools included", () => {
    // An explicit, dialog-confirmed opt-out. Half-honouring it would be worse
    // than not offering it at all.
    expect(gate("cad__apply_edit_ops", "never")).toBe("auto");
    expect(gate("kratos__run_simulation", "never")).toBe("auto");
  });

  it("lets an always-allow grant cover a write and an unknown tool", () => {
    const allowed = new Set(["cad__apply_edit_ops", "kratos__run_simulation"]);
    expect(gate("cad__apply_edit_ops", "askOnWrite", allowed)).toBe("auto");
    expect(gate("kratos__run_simulation", "askOnWrite", allowed)).toBe("auto");
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
        { name: "kratos__run_simulation" },
        { name: "mesh__mesh_transform" },
        { name: "kratos__create_project" },
      ])
    ).toEqual(["kratos__run_simulation", "kratos__create_project"]);
  });

  it("is empty when every advertised tool is classified", () => {
    expect(unclassifiedTools([{ name: "cad__inspect" }, { name: "mcp__get_prompt" }])).toEqual([]);
    expect(unclassifiedTools([])).toEqual([]);
  });
});

describe("the table itself", () => {
  it("covers every tool the two bundled servers register, and nothing else", () => {
    // 46 cad + 22 mesh (verified against `grep -c 'registerTool('` in both
    // submodules) + 4 in-process mcp__ meta tools. A bump that adds a tool
    // leaves it unclassified — safe, but it must be a *noticed* omission, so
    // this count is asserted rather than inferred.
    expect(Object.keys(TOOL_ACCESS)).toHaveLength(72);
    const cad = Object.keys(TOOL_ACCESS).filter((n) => n.startsWith("cad__"));
    const mesh = Object.keys(TOOL_ACCESS).filter((n) => n.startsWith("mesh__"));
    const meta = Object.keys(TOOL_ACCESS).filter((n) => n.startsWith("mcp__"));
    expect(cad).toHaveLength(46);
    expect(mesh).toHaveLength(22);
    expect(meta).toHaveLength(4);
    // No fourth namespace: kratos is deliberately unclassified.
    expect(cad.length + mesh.length + meta.length).toBe(Object.keys(TOOL_ACCESS).length);
  });

  it("names every write tool explicitly, so the list is reviewable", () => {
    const writes = Object.entries(TOOL_ACCESS)
      .filter(([, access]) => access === "write")
      .map(([name]) => name)
      .sort();
    expect(writes).toEqual([
      "cad__apply_edit_ops",
      "cad__decompose_to_primitives",
      "cad__download_standard_part",
      "cad__export_brep",
      "cad__export_mesh",
      "cad__export_svg_silhouette",
      "cad__export_technical_drawing",
      "cad__fit_mesh_region",
      "cad__load_preprocess",
      "cad__promote_mesh_to_brep",
      "cad__remove_edit_op",
      "cad__repair_mesh",
      "cad__run_parametric_script",
      "cad__run_saved_script",
      "cad__save_parametric_script",
      "cad__save_preprocess",
      "cad__set_mesh_options",
      "cad__set_part",
      "cad__set_plane",
      "cad__set_variables",
      "cad__transform_mesh",
      "mesh__case_generate",
      "mesh__case_run",
      "mesh__case_stop",
      "mesh__case_write_state",
      "mesh__mesh_convert",
      "mesh__mesh_export_table",
      "mesh__mesh_extract_skin",
      "mesh__mesh_extract_submodelpart",
      "mesh__mesh_field_series",
      "mesh__mesh_pack_series",
      "mesh__mesh_transform",
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
