/**
 * projectRootCore — reading a stored root back, and describing a file's folder
 * relative to it (what makes the recents surfaces read as "this project").
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  abbreviateHome,
  describeWithin,
  parseProjectRoot,
  rootLabel,
} from "../app/main/services/projectRootCore";

const abs = (p: string) => path.resolve(p);

describe("parseProjectRoot", () => {
  it("resolves a stored path", () => {
    expect(parseProjectRoot("/tmp/cases")).toBe(abs("/tmp/cases"));
    expect(parseProjectRoot("./cases/../cases")).toBe(abs("cases"));
  });

  it("reads anything malformed as no root", () => {
    // The store is shared with the mesh extension's keys and hand-editable.
    for (const raw of [undefined, null, "", 42, {}, [], true]) {
      expect(parseProjectRoot(raw)).toBeUndefined();
    }
  });
});

describe("rootLabel", () => {
  it("is the folder's own name", () => {
    expect(rootLabel("/home/me/cases/beam")).toBe("beam");
  });

  it("falls back to the whole path when there is no basename", () => {
    // A filesystem or drive root has no basename; "" would render as an empty chip.
    expect(rootLabel("/")).toBe("/");
  });
});

describe("abbreviateHome", () => {
  it("abbreviates $HOME", () => {
    expect(abbreviateHome("/home/me/cases", "/home/me")).toBe("~/cases");
    expect(abbreviateHome("/home/me", "/home/me")).toBe("~");
  });

  it("accepts either separator at the boundary", () => {
    // A POSIX-style home over Remote-SSH/WSL must not be rejected on win32.
    expect(abbreviateHome("C:\\Users\\me\\cases", "C:\\Users\\me")).toBe("~\\cases");
  });

  it("leaves paths outside home alone, and needs no home at all", () => {
    expect(abbreviateHome("/opt/data", "/home/me")).toBe("/opt/data");
    expect(abbreviateHome("/opt/data")).toBe("/opt/data");
  });

  it("does not abbreviate a merely similar prefix", () => {
    expect(abbreviateHome("/home/mentor/x", "/home/me")).toBe("/home/mentor/x");
  });
});

describe("describeWithin", () => {
  const root = abs("/projects/beam");
  const home = abs("/home/me");

  it("describes a file inside the root relative to it", () => {
    expect(describeWithin(root, path.join(root, "meshes", "coarse.mdpa"))).toBe("meshes");
  });

  it("names the root when the file sits directly in it", () => {
    // path.relative would be "", which renders as an empty column.
    expect(describeWithin(root, path.join(root, "case.mdpa"))).toBe("beam");
  });

  it("falls back to the ~-abbreviated folder outside the root", () => {
    expect(describeWithin(root, path.join(home, "other", "x.stp"), home)).toBe("~/other");
  });

  it("behaves exactly as before when no root is set", () => {
    // This is the no-explicit-root path: unchanged from the previous release.
    const file = path.join(home, "cases", "x.stp");
    expect(describeWithin(undefined, file, home)).toBe("~/cases");
  });

  it("is not fooled by a sibling directory sharing the root's prefix", () => {
    const sibling = abs("/projects/beam-old/case.mdpa");
    expect(describeWithin(root, sibling, home)).toBe(abs("/projects/beam-old"));
  });

  it("handles a nested folder several levels down", () => {
    expect(describeWithin(root, path.join(root, "a", "b", "c", "x.vtk"))).toBe(path.join("a", "b", "c"));
  });
});
