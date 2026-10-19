import { describe, expect, it } from "vitest";
import { groupFrames, parseFrame, workingDirectoryFrom } from "../tools/tutorials/results.mjs";

describe("tutorial results helpers", () => {
  it("parses frame names and groups them by family in step order", () => {
    expect(parseFrame("FluidModelPart_0_12.vtk")).toEqual({ family: "FluidModelPart_0", index: 12 });
    expect(parseFrame("mesh.mdpa")).toBeNull();
    const groups = groupFrames(["A_0_10.vtk", "A_0_2.vtk", "B_0_1.vtu"]);
    expect(groups.get("A_0")!.map((f) => f.index)).toEqual([2, 10]);
    expect([...groups.keys()]).toEqual(["A_0", "B_0"]);
  });

  it("reads the working directory that generate.mjs announces", () => {
    expect(workingDirectoryFrom("noise\nWorking directory: /x/tutorials-abc\nfluid: generated")).toBe("/x/tutorials-abc");
    expect(workingDirectoryFrom("no announcement")).toBeNull();
  });
});
