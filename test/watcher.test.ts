import { describe, expect, it } from "vitest";
import { matcherFor } from "../app/main/services/watcher";

describe("matcherFor", () => {
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
