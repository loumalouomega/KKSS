import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { isInsideRoot, isPathAllowed } from "../app/main/pathGuard";

const root = path.resolve("/data/models");

describe("isInsideRoot", () => {
  it("accepts the root itself and children", () => {
    expect(isInsideRoot(root, root)).toBe(true);
    expect(isInsideRoot(root, path.join(root, "bull.stp"))).toBe(true);
    expect(isInsideRoot(root, path.join(root, "sub", "cube.stl"))).toBe(true);
  });

  it("rejects siblings and prefix look-alikes", () => {
    expect(isInsideRoot(root, path.resolve("/data/models-secret/x"))).toBe(false);
    expect(isInsideRoot(root, path.resolve("/data"))).toBe(false);
    expect(isInsideRoot(root, path.resolve("/etc/passwd"))).toBe(false);
  });
});

describe("isPathAllowed", () => {
  it("checks every registered root", () => {
    const roots = [root, path.resolve("/tmp/out")];
    expect(isPathAllowed(roots, path.join(root, "a.vtk"))).toBe(true);
    expect(isPathAllowed(roots, path.resolve("/tmp/out/renderer/x.js"))).toBe(true);
    expect(isPathAllowed(roots, path.resolve("/tmp/other"))).toBe(false);
    expect(isPathAllowed([], path.join(root, "a.vtk"))).toBe(false);
  });
});
