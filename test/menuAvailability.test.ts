import { describe, expect, it } from "vitest";
import { needsMeshDocument, postProcessingOnly, UNAVAILABLE_SUFFIX } from "../app/main/services/menuAvailability";

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
});
