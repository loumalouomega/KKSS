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
});
