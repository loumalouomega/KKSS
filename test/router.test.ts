import { describe, expect, it } from "vitest";
import { modeForFile, modeForViewType } from "../app/main/router";

describe("modeForFile", () => {
  it("routes CAD-only formats to cad regardless of active mode", () => {
    for (const f of ["a.step", "a.stp", "a.iges", "a.igs", "a.brep", "a.gltf", "a.glb"]) {
      expect(modeForFile(f, "cad")).toBe("cad");
      expect(modeForFile(f, "mesh")).toBe("cad");
    }
  });

  it("routes mesh-only formats to mesh regardless of active mode", () => {
    for (const f of ["a.mdpa", "a.vtk", "a.vtu", "a.vtp", "a.vtm", "a.vti", "a.vts", "a.vtr"]) {
      expect(modeForFile(f, "cad")).toBe("mesh");
      expect(modeForFile(f, "mesh")).toBe("mesh");
    }
  });

  it("routes the extended meshio++ formats to mesh regardless of active mode", () => {
    // Gmsh, Abaqus, Nastran, I-deas UNV, Netgen, SU2, Medit, EnSight Gold,
    // Triangle — read via @meshioplusplus/wasm; cad's router claims none of
    // these extensions.
    for (const f of ["a.msh", "a.inp", "a.bdf", "a.unv", "a.vol", "a.su2", "a.mesh", "a.case", "a.geo", "a.poly"]) {
      expect(modeForFile(f, "cad")).toBe("mesh");
      expect(modeForFile(f, "mesh")).toBe("mesh");
    }
  });

  it("lets the active mode win for overlapping formats", () => {
    for (const f of ["a.stl", "a.obj", "a.ply"]) {
      expect(modeForFile(f, "cad")).toBe("cad");
      expect(modeForFile(f, "mesh")).toBe("mesh");
    }
  });

  it("returns undefined for unsupported files", () => {
    expect(modeForFile("a.txt", "cad")).toBeUndefined();
    expect(modeForFile("a", "mesh")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(modeForFile("A.STEP", "mesh")).toBe("cad");
    expect(modeForFile("A.MDPA", "cad")).toBe("mesh");
  });
});

describe("modeForViewType", () => {
  it("maps the extensions' view types", () => {
    expect(modeForViewType("kratos.mdpaPreview")).toBe("mesh");
    expect(modeForViewType("kratos.vtkPreview")).toBe("mesh");
    expect(modeForViewType("cad-preview.mesh")).toBe("cad");
    expect(modeForViewType("other.editor")).toBeUndefined();
  });
});
