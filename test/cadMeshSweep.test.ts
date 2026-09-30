import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MESH_OPTIONS } from "../cad/src/meshOptions";
import { runCadMeshSweep } from "../app/main/cadMeshSweep";
import type { SweepGenerateResult } from "../cad/src/meshSweep";

type Result = SweepGenerateResult & { mshText: string };
const result = (size: number): Result => ({
  nodeCount: Math.round(100 / size),
  elementCount: Math.round(200 / size),
  engineUsed: "gmsh",
  warnings: [],
  mshText: `mesh-${size}`,
});

describe("KKSS CAD refinement sweep adapter", () => {
  it("keeps upstream per-size settings and writes outputs only after active checks", async () => {
    const warnings: string[] = [];
    const generated: number[] = [];
    const writes: string[] = [];
    const outcome = await runCadMeshSweep(
      [4, 2],
      { ...DEFAULT_MESH_OPTIONS, sizeMin: 1, sizeMax: 8 },
      async (options) => {
        generated.push(options.sizeMax);
        return result(options.sizeMax);
      },
      {
        warnings,
        isCancelled: () => false,
        writeOutputs: async (size, _options, mesh) => {
          writes.push(mesh.mshText);
          return [`model-size-${size}.msh`];
        },
      }
    );

    expect(generated).toEqual([4, 2]);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.runs.map((row) => row.outputPaths)).toEqual([
      ["model-size-4.msh"],
      ["model-size-2.msh"],
    ]);
    expect(writes).toEqual(["mesh-4", "mesh-2"]);
    expect(warnings).toEqual([]);
  });

  it("reports a failed size as a row and continues the remaining sweep", async () => {
    const generated: number[] = [];
    const outcome = await runCadMeshSweep(
      [4, 2],
      DEFAULT_MESH_OPTIONS,
      async (options) => {
        generated.push(options.sizeMax);
        if (options.sizeMax === 4) throw new Error("mesher failed");
        return result(options.sizeMax);
      },
      { warnings: [], isCancelled: () => false }
    );

    expect(generated).toEqual([4, 2]);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.runs.map((row) => row.status)).toEqual(["error", "ok"]);
    expect(outcome.runs[0].error).toBe("mesher failed");
  });

  it("returns completed rows and stops before another run after cancellation", async () => {
    let active = true;
    const generated: number[] = [];
    const write = vi.fn(async () => {
      active = false;
      return ["mesh.msh"];
    });
    const outcome = await runCadMeshSweep(
      [4, 2],
      DEFAULT_MESH_OPTIONS,
      async (options) => {
        generated.push(options.sizeMax);
        return result(options.sizeMax);
      },
      { warnings: [], isCancelled: () => !active, writeOutputs: write }
    );

    expect(generated).toEqual([4]);
    expect(write).toHaveBeenCalledOnce();
    expect(outcome.cancelled).toBe(true);
    expect(outcome.runs).toHaveLength(1);
    expect(outcome.runs[0].outputPaths).toEqual(["mesh.msh"]);
  });

  it("omits a run interrupted while the generator is active", async () => {
    let active = true;
    const write = vi.fn(async () => ["mesh.msh"]);
    const outcome = await runCadMeshSweep(
      [4, 2],
      DEFAULT_MESH_OPTIONS,
      async (options) => {
        active = false;
        return result(options.sizeMax);
      },
      { warnings: [], isCancelled: () => !active, writeOutputs: write }
    );

    expect(write).not.toHaveBeenCalled();
    expect(outcome.cancelled).toBe(true);
    expect(outcome.runs).toEqual([]);
  });
});
