import {
  runMeshSweep,
  type SweepGenerateResult,
  type MeshSweepRun,
} from "../../cad/src/meshSweep";
import type { MeshOptions } from "../../cad/src/meshOptions";

/** KKSS cancellation boundary around CAD-Preview's shared refinement loop. */
export function runCadMeshSweep<R extends SweepGenerateResult>(
  sizes: readonly number[],
  options: MeshOptions,
  generate: (options: MeshOptions) => Promise<R>,
  hooks: {
    warnings: string[];
    assertActive(): void;
    writeOutputs?: (size: number, options: MeshOptions, result: R) => Promise<string[]>;
    onRunStart?: (index: number, size: number) => void;
  }
): Promise<MeshSweepRun[]> {
  return runMeshSweep(sizes, options, generate, {
    warnings: hooks.warnings,
    onRunStart(index, size) {
      hooks.assertActive();
      hooks.onRunStart?.(index, size);
    },
    writeOutputs: hooks.writeOutputs
      ? async (size, runOptions, result) => {
          hooks.assertActive();
          return hooks.writeOutputs!(size, runOptions, result);
        }
      : undefined,
  });
}
