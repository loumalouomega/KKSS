import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callInsideProject, isInside, SCOPED_TOOL_PATH_ARGS, scopedCallPaths } from "../app/main/services/chat/toolPaths";
import { classifyTool, gateFor, TOOL_ACCESS } from "../app/main/services/chat/toolPolicy";

const args = (value: unknown) => JSON.stringify(value);
// Pure string comparisons: no filesystem in play, so every path "does not exist".
const noFs = { realpath: (_p: string): string => { throw new Error("ENOENT"); } };

describe("scopedCallPaths", () => {
  it("collects declared absolute paths, including array elements and dotted names", () => {
    expect(scopedCallPaths("mesh__mesh_transform", args({ path: "/p/a.mdpa", outputPath: "/p/b.mdpa", recipeName: "r" }))).toEqual(["/p/a.mdpa", "/p/b.mdpa"]);
    expect(scopedCallPaths("mesh__mesh_batch_transform", args({ paths: ["/p/a.vtk", "/p/b.vtk"], outputDir: "/p/out" }))).toEqual(["/p/a.vtk", "/p/b.vtk", "/p/out"]);
    expect(scopedCallPaths("cad__decompose_to_primitives", args({ path: "/p/m.step", saveScript: { libraryPath: "/p/lib.json", description: "x" } }))).toEqual(["/p/m.step", "/p/lib.json"]);
  });

  it("ignores enum-ish and free-text values whose names merely resemble paths", () => {
    expect(scopedCallPaths("mesh__mesh_convert", args({ path: "/p/a.mdpa", outputFormat: "vtk", inputFormat: "mdpa" }))).toEqual(["/p/a.mdpa"]);
    expect(scopedCallPaths("cad__save_mesh_preset", args({ libraryPath: "/p/presets.json", description: "fine mesh", name: "fine" }))).toEqual(["/p/presets.json"]);
  });

  it("fails closed", () => {
    // No row: a tool a bump added, or one that executes things.
    expect(scopedCallPaths("cad__brand_new_tool", args({ path: "/p/a" }))).toBeNull();
    expect(scopedCallPaths("mesh__case_run", args({ meshPath: "/p/a.mdpa" }))).toBeNull();
    expect(scopedCallPaths("kratos__run_simulation", args({ case_dir: "/p/case" }))).toBeNull();
    // Relative path: the server resolves it against its own cwd, not the root.
    expect(scopedCallPaths("mesh__mesh_transform", args({ path: "a.mdpa" }))).toBeNull();
    expect(scopedCallPaths("mesh__mesh_transform", args({ path: "~/a.mdpa" }))).toBeNull();
    // Only implicit targets.
    expect(scopedCallPaths("mesh__mesh_transform", args({ recipeName: "r" }))).toBeNull();
    // A path-looking argument the table does not know about.
    expect(scopedCallPaths("mesh__mesh_transform", args({ path: "/p/a.mdpa", extraDir: "/etc" }))).toBeNull();
    // workspaceDirs makes a case tool execute workspace problemtypes.
    expect(scopedCallPaths("mesh__case_generate", args({ meshPath: "/p/a.mdpa", casePath: "/p/c", workspaceDirs: ["/p"] }))).toBeNull();
    // Malformed arguments.
    expect(scopedCallPaths("mesh__mesh_transform", "{")).toBeNull();
    expect(scopedCallPaths("mesh__mesh_transform", "[]")).toBeNull();
    expect(scopedCallPaths("mesh__mesh_transform", args({ path: "" }))).toBeNull();
  });
});

describe("isInside", () => {
  it("accepts the root itself and descendants, rejects siblings and escapes", () => {
    expect(isInside("/p", "/p", noFs)).toBe(true);
    expect(isInside("/p/a/b.mdpa", "/p", noFs)).toBe(true);
    expect(isInside("/p2/a", "/p", noFs)).toBe(false);
    expect(isInside("/p/../etc/passwd", "/p", noFs)).toBe(false);
    expect(isInside("/p/..hidden/a", "/p", noFs)).toBe(true); // a folder named "..hidden" is inside
    expect(isInside("/other", "/p", noFs)).toBe(false);
  });

  it("folds case only where the filesystem usually does", () => {
    expect(isInside("/P/a", "/p", { ...noFs, platform: "darwin" })).toBe(true);
    expect(isInside("/P/a", "/p", { ...noFs, platform: "linux" })).toBe(false);
  });

  it("follows a symlink out of the root", () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kkss-link-")));
    try {
      const root = path.join(base, "project");
      const outside = path.join(base, "outside");
      fs.mkdirSync(root);
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(root, "escape"));
      expect(isInside(path.join(root, "escape", "new.mdpa"), root)).toBe(false);
      expect(isInside(path.join(root, "real", "new.mdpa"), root)).toBe(true); // not yet created
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("callInsideProject", () => {
  it("needs an explicit absolute root and every path inside it", () => {
    const call = (a: object, root: string | undefined) => callInsideProject("mesh__mesh_transform", args(a), root, noFs);
    expect(call({ path: "/p/a.mdpa", outputPath: "/p/b.mdpa" }, "/p")).toBe(true);
    expect(call({ path: "/p/a.mdpa", outputPath: "/tmp/b.mdpa" }, "/p")).toBe(false); // one escape fails the call
    expect(call({ path: "/p/a.mdpa" }, undefined)).toBe(false);
    expect(call({ path: "/p/a.mdpa" }, "p")).toBe(false);
  });
});

describe("scope table", () => {
  it("only lists classified write tools", () => {
    for (const name of Object.keys(SCOPED_TOOL_PATH_ARGS)) {
      expect(classifyTool(name), name).toBe("write");
    }
  });

  it("leaves every executing or nested-path write tool unscoped, deliberately", () => {
    const unscoped = Object.entries(TOOL_ACCESS)
      .filter(([name, access]) => access === "write" && !name.startsWith("app__") && !(name in SCOPED_TOOL_PATH_ARGS))
      .map(([name]) => name)
      .filter((name) => !name.startsWith("kratos__"))
      .sort();
    // Reviewed: running scripts/solvers, loading workspace problemtypes, plot
    // recipes with nested sources, multi-target batches and receipt cancel.
    expect(unscoped).toEqual([
      "cad__batch_export",
      "cad__job_cancel",
      "cad__run_parametric_script",
      "cad__run_saved_script",
      "mesh__case_run",
      "mesh__case_stop",
      "mesh__plot_dataset",
      "mesh__problemtype_describe",
      "mesh__problemtype_list",
    ]);
    const kratosUnscoped = Object.entries(TOOL_ACCESS)
      .filter(([name, access]) => access === "write" && name.startsWith("kratos__") && !(name in SCOPED_TOOL_PATH_ARGS))
      .map(([name]) => name.slice("kratos__".length))
      .sort();
    expect(kratosUnscoped).toEqual([
      "job_cancel", "job_rerun", "job_resume", "kratos_install", "results_compare", "results_time_history",
      "run_simulation", "study_cancel", "study_resume", "study_start",
    ]);
  });
});

describe("gateFor with a project-folder grant", () => {
  const base = { mode: "askOnWrite" as const, allowed: new Set<string>() };
  const grant = (inside: boolean) => ({ granted: new Set(["mesh__mesh_transform"]), inside: () => inside });
  it("auto-runs a granted write only while its paths are inside", () => {
    expect(gateFor("mesh__mesh_transform", { ...base, scoped: grant(true) })).toBe("auto");
    expect(gateFor("mesh__mesh_transform", { ...base, scoped: grant(false) })).toBe("ask");
    expect(gateFor("mesh__mesh_convert", { ...base, scoped: grant(true) })).toBe("ask"); // per tool
  });
  it("beats askAlways like an always-allow grant, but never beats a missing grant", () => {
    expect(gateFor("mesh__mesh_transform", { ...base, mode: "askAlways", scoped: grant(true) })).toBe("auto");
    expect(gateFor("mesh__mesh_transform", { ...base, mode: "askAlways", scoped: { granted: new Set(), inside: () => true } })).toBe("ask");
  });
  it("never applies to a read or unknown tool, and does not even ask the inside() check", () => {
    let asked = 0;
    const scoped = { granted: new Set(["mesh__not_a_tool", "cad__inspect"]), inside: () => (asked++, true) };
    expect(gateFor("mesh__not_a_tool", { ...base, scoped })).toBe("ask");
    expect(asked).toBe(0);
  });
});
