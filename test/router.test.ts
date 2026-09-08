import { describe, expect, it } from "vitest";
import { modeForFile, modeForViewType } from "../app/main/router";
import { routeFile } from "../cad/src/fileRouter";

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

  it("keeps the meshio-strategy formats in mesh mode even though cad claims them too", () => {
    // CAD-Preview 1.2 imports these through meshio++ as a geometry-only
    // boundary surface, so routeFile() now resolves them — but they are
    // post-processing formats here, and mesh mode reads them natively (fields,
    // blocks, SubModelParts). Without the strategy check they would fall into
    // the "active mode wins" branch and .mdpa would open in CAD mode.
    for (const f of ["a.mdpa", "a.vtk", "a.vtu", "a.med", "a.cgns", "a.exo", "a.e", "a.xdmf"]) {
      expect(routeFile(f)?.strategy).toBe("meshio"); // cad really does claim it
      expect(modeForFile(f, "cad")).toBe("mesh");
      expect(modeForFile(f, "mesh")).toBe("mesh");
    }
  });

  it("routes the extended meshio++ formats to mesh regardless of active mode", () => {
    // Gmsh, Abaqus, Nastran, I-deas UNV, Netgen, SU2, Medit, EnSight Gold,
    // Triangle, Exodus II, CGNS, MOAB, HMF, Salome MED — read via
    // @meshioplusplus/wasm; cad's router claims none of these extensions.
    for (const f of [
      "a.msh", "a.inp", "a.bdf", "a.unv", "a.vol", "a.su2", "a.mesh", "a.case", "a.geo", "a.poly",
      "a.e", "a.exo", "a.ex2", "a.cgns", "a.h5m", "a.hmf", "a.med",
    ]) {
      expect(modeForFile(f, "cad")).toBe("mesh");
      expect(modeForFile(f, "mesh")).toBe("mesh");
    }
  });

  it("keeps mesh mode for the extensions cad 1.5.1 newly claimed", () => {
    // These used to be mesh-only (cad's router did not resolve them at all),
    // so they took the `meshOk`-only branch. cad 1.5.1 added them as meshio++
    // imports, which moves them into the cad-and-mesh branch — the strategy
    // check is now the only thing keeping them in mesh mode.
    for (const f of ["a.msh", "a.inp", "a.unv", "a.su2", "a.mesh"]) {
      expect(routeFile(f)?.strategy).toBe("meshio"); // cad really does claim it
      expect(modeForFile(f, "cad")).toBe("mesh");
      expect(modeForFile(f, "mesh")).toBe("mesh");
    }
  });

  it("routes the one format only cad can read to cad mode", () => {
    // cad 1.5.x reads .msh2, and mesh never registered it at all, so cad mode
    // is the only one that can open it and wins outright rather than by
    // active-mode preference.
    for (const f of ["a.msh2"]) {
      expect(routeFile(f)?.strategy).toBe("meshio");
      expect(modeForFile(f, "cad")).toBe("cad");
      expect(modeForFile(f, "mesh")).toBe("cad");
    }
  });

  it("routes .foam to mesh mode now that mesh 3.17.0 can read a case", () => {
    // Used to be cad-only, for the same reason .msh2 still is: a `.foam`
    // marker's real mesh lives in a sibling `constant/polyMesh/` TREE, and
    // mesh's staging used to only ever hand the reader a single file. mesh
    // 3.17.0 taught its staging to hold that tree (openfoamCase.ts), so .foam
    // moved from the cad-only branch into the cad-and-mesh one — mesh mode
    // wins there because it reads OpenFOAM natively (named boundary
    // SubModelParts recovered from constant/polyMesh/boundary), same as every
    // other meshio-strategy format above.
    expect(routeFile("a.foam")?.strategy).toBe("meshio");
    expect(modeForFile("a.foam", "cad")).toBe("mesh");
    expect(modeForFile("a.foam", "mesh")).toBe("mesh");
  });

  it("routes the OpenSCAD formats to cad mode, on the occt strategy", () => {
    // cad 1.12.0. `.csg` is OpenSCAD's fully evaluated form, built kernel-side
    // into an opaque base shape; `.scad` is converted to it on open by a
    // user-installed openscad binary. The strategy matters as much as the mode:
    // "meshio" would send them to post mode, which cannot read either.
    for (const f of ["a.csg", "a.scad", "A.CSG", "A.SCAD"]) {
      expect(routeFile(f)?.strategy).toBe("occt");
      expect(modeForFile(f, "cad")).toBe("cad");
      expect(modeForFile(f, "mesh")).toBe("cad");
    }
    expect(routeFile("a.csg")?.format).toBe("csg");
    expect(routeFile("a.scad")?.format).toBe("scad");
  });

  it("resolves compound extensions by longest suffix, not by the last dot", () => {
    // GiD postprocess (mesh 3.6.0 / cad 1.5.1). `path.extname` sees ".msh" for
    // all three of these, which maps to Gmsh — a different reader entirely. The
    // router asks meshExtname instead, so `case.post.msh` is recognised as its
    // own format rather than as a Gmsh file that happens to end in .msh.
    expect(routeFile("case.post.msh")?.format).toBe("gid");
    expect(routeFile("case.msh")?.format).toBe("gmsh");
    for (const f of ["case.post.msh", "case.post.res", "case.post.bin", "case.post.h5"]) {
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
