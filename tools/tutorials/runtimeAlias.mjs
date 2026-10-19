// The stock Kratos 10.4.3 wrapper for the serial two-fluid solver asks for
// KratosMultiphysics.FluidDynamicsApplication.navier_stokes_two_fluid_solver,
// but the package ships navier_stokes_two_fluids_solver.py. This writes the
// one-file alias beside the package (idempotent), so the stock solver can
// start. The published case README tells users to create the same file.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { python } from './mcp.mjs';

const exec = promisify(execFile);
const MARKER = 'KKSS_DIR=';

/** The directory of KratosMultiphysics.FluidDynamicsApplication for an interpreter. */
export async function fluidDynamicsDirectory(pythonPath = python) {
  const code = `import KratosMultiphysics.FluidDynamicsApplication as f, os; print("${MARKER}" + os.path.dirname(f.__file__))`;
  const { stdout } = await exec(pythonPath, ['-c', code], { maxBuffer: 1024 * 1024 });
  // The Kratos import prints its own banner; only the marker line is ours.
  const line = stdout.split('\n').find((l) => l.startsWith(MARKER));
  if (!line) throw Error('Could not locate KratosMultiphysics.FluidDynamicsApplication in the tutorial runtime');
  return line.slice(MARKER.length).trim();
}

/** Writes <name>.py beside the package, re-exporting <target>. Returns the alias path. */
export async function ensureSolverAlias({ name, target }, pythonPath = python) {
  const dir = await fluidDynamicsDirectory(pythonPath);
  if (!fs.existsSync(path.join(dir, `${target}.py`))) {
    throw Error(`${target}.py is missing from ${dir}; the alias ${name}.py would re-export nothing`);
  }
  const file = path.join(dir, `${name}.py`);
  const body = `from KratosMultiphysics.FluidDynamicsApplication.${target} import *\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return file;
  fs.writeFileSync(file, body);
  return file;
}
