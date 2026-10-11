import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFileSystemWatcher, matcherFor } from "../app/main/services/watcher";

describe("matcherFor", () => {
  it("matches recursive output trees and ordinary files (queued run discovery)", () => {
    const m = matcherFor("**/*");
    expect(m("main.vtu")).toBe(true);
    expect(m("results/frame_2.vtu")).toBe(true);
    expect(m("results/0/data/model.h5")).toBe(true);
  });

  it("matches exact filenames (mdpa reparse watcher)", () => {
    const m = matcherFor("model.mdpa");
    expect(m("model.mdpa")).toBe(true);
    expect(m("other.mdpa")).toBe(false);
  });

  it("matches brace extension globs (vtk timeline watcher)", () => {
    // Same glob shape vtkEditorProvider builds from TIMELINE_EXTENSIONS.
    const m = matcherFor("*.{vtk,vtu,vtp,vti,vts,vtr,vtm}");
    expect(m("Main_0_6.vtk")).toBe(true);
    expect(m("Main_0_7.VTU")).toBe(true);
    expect(m("Main_0_6.stl")).toBe(false);
    expect(m("noext")).toBe(false);
  });

  it("matches single-extension stars", () => {
    const m = matcherFor("*.png");
    expect(m("shot.png")).toBe(true);
    expect(m("shot.jpg")).toBe(false);
  });

  it("matches a brace list of full names (mesh 3.21.0's GiD ascii pair)", () => {
    // timelineWatchGlob's in-file branch for a case.post.msh/.post.res pair —
    // distinct from the extension-brace shape above: no leading "*.".
    const m = matcherFor("{case.post.msh,case.post.res}");
    expect(m("case.post.msh")).toBe(true);
    expect(m("case.post.res")).toBe(true);
    expect(m("case.post.bin")).toBe(false);
    // Not an extension glob — a same-named file in a subdirectory must not match.
    expect(m("other/case.post.msh")).toBe(false);
  });

  it("matches a directory-scoped glob (mesh 3.21.0's .foam content watcher)", () => {
    // contentWatchGlob("a.foam") === "constant/polyMesh/*" — the marker file
    // itself, or an unrelated sibling directory, must not match.
    const m = matcherFor("constant/polyMesh/*");
    expect(m("constant/polyMesh/points")).toBe(true);
    expect(m("constant/polyMesh/boundary")).toBe(true);
    expect(m("a.foam")).toBe(false);
    expect(m("constant/other/points")).toBe(false);
    expect(m("constant/polyMesh")).toBe(false);
  });
});

describe("createFileSystemWatcher depth", () => {
  it("sees a nested write only when the caller raises the depth", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-watch-"));
    const seen = async (depth?: number) => {
      const got: string[] = [];
      const w = createFileSystemWatcher(root, "*", depth === undefined ? {} : { depth });
      w.onDidCreate((p) => got.push(path.relative(root, p)));
      w.onDidChange((p) => got.push(path.relative(root, p)));
      await new Promise((r) => setTimeout(r, 300));
      const nested = path.join(root, "a", "b");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, `f${depth ?? "d"}.txt`), "x");
      await new Promise((r) => setTimeout(r, 400));
      w.dispose();
      return got;
    };
    try {
      expect(await seen()).toEqual([]);
      expect(await seen(3)).toContain(path.join("a", "b", "f3.txt"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
