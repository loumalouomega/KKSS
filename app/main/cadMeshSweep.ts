import {
  runMeshSweep,
  type SweepGenerateResult,
  type MeshSweepOutcome,
} from "../../cad/src/meshSweep";
import type { MeshOptions } from "../../cad/src/meshOptions";

/** KKSS cancellation boundary around CAD-Preview's shared refinement loop. */
export function runCadMeshSweep<R extends SweepGenerateResult>(
  sizes: readonly number[],
  options: MeshOptions,
  generate: (options: MeshOptions) => Promise<R>,
  hooks: {
    warnings: string[];
    isCancelled(): boolean;
    writeOutputs?: (size: number, options: MeshOptions, result: R) => Promise<string[]>;
    onRunStart?: (index: number, size: number) => void;
  }
): Promise<MeshSweepOutcome> {
  const isCancelled = hooks.isCancelled;
  return runMeshSweep<R>(sizes, options, async (runOptions) => {
    // A cancellation may land after the sweep loop's entry check but while
    // Gmsh is queued/running. Preserve the submodule's new contract: that run
    // contributes no row, and the completed rows return as a partial result.
    if (isCancelled()) throw new Error("CAD mesh sweep cancelled.");
    const result = await generate(runOptions);
    if (isCancelled()) throw new Error("CAD mesh sweep cancelled.");
    return result;
  }, {
    warnings: hooks.warnings,
    onRunStart(index, size) {
      hooks.onRunStart?.(index, size);
    },
    isCancelled,
    writeOutputs: hooks.writeOutputs
      ? async (size, runOptions, result) => {
          if (isCancelled()) throw new Error("CAD mesh sweep cancelled.");
          return hooks.writeOutputs!(size, runOptions, result);
        }
      : undefined,
  });
}
