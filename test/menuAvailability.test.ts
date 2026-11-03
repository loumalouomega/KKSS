import { describe, expect, it } from "vitest";
import {
  INFO_ID_PREFIX,
  clearProjectRoot,
  needsClientId,
  needsMeshDocument,
  needsRemoteHost,
  postProcessingOnly,
  unexplainedDisabledItems,
  UNAVAILABLE_SUFFIX,
} from "../app/main/services/menuAvailability";

describe("menu availability reasons", () => {
  it("is enabled exactly when there is no reason", () => {
    expect(postProcessingOnly({ mode: "cad", screen: "cad", hasMeshFile: false })).toBe("postOnly");
    expect(postProcessingOnly({ mode: "mesh", screen: "home", hasMeshFile: false })).toBeUndefined();
    expect(needsMeshDocument({ mode: "mesh", screen: "mesh", hasMeshFile: true })).toBeUndefined();
    expect(needsMeshDocument({ mode: "mesh", screen: "mesh", hasMeshFile: false })).toBe("needsMeshDocument");
    expect(needsMeshDocument({ mode: "mesh", screen: "cad", hasMeshFile: true })).toBe("needsMeshDocument");
  });
  it("has a suffix for every reason", () => {
    expect(Object.values(UNAVAILABLE_SUFFIX).every((s) => s.startsWith(" ("))).toBe(true);
  });
  it("reason helpers are undefined exactly when the item is usable", () => {
    expect(needsRemoteHost(0)).toBe("noRemoteHosts");
    expect(needsRemoteHost(2)).toBeUndefined();
    expect(needsClientId(false)).toBe("needsClientId");
    expect(needsClientId(true)).toBeUndefined();
    expect(clearProjectRoot(false, false)).toBe("noProjectRoot");
    expect(clearProjectRoot(true, true)).toBe("managed");
    expect(clearProjectRoot(true, false)).toBeUndefined();
  });
});

describe("menu model audit", () => {
  it("flags disabled items with no reason and accepts annotated or info rows", () => {
    const tree = [
      {
        label: "&File",
        submenu: [
          { label: "Open…" },
          { label: "Import Mesh… (open a mesh first)", enabled: false },
          { label: "Bad Item", enabled: false },
          { label: "No Recent Files", id: `${INFO_ID_PREFIX}no-recent`, enabled: false },
          { type: "separator" },
          {
            label: "Sub",
            submenu: { items: [{ label: "Deep", enabled: false }, { label: "VTK-wasm — unavailable in this build", enabled: false }] },
          },
        ],
      },
    ];
    expect(unexplainedDisabledItems(tree)).toEqual(["File > Bad Item", "File > Sub > Deep"]);
  });
});
