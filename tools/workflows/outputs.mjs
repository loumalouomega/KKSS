// Live output/receipt/quantity acceptance. Needs the tutorial Python plus HDF5Application/h5py.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { servers, python, root } from '../tutorials/mcp.mjs';
import { cases } from '../tutorials/cases.mjs';
// Kratos 10.4.2-10.4.4's single_mesh_xdmf_output_process has two defects that this configuration avoids
// (see doc/guide/development.md): its XDMF step opens the mesh file for real in exclusive mode (OpenHDF5File
// ignores mock_hdf5_file_io) and h5py then cannot open a file Kratos still holds, and TimeLabel() rewrites
// "e-" to "e*", so any file name whose stem ends in "e" ("Structure-0.1250.h5") loses its time label.
// read_write + a stem ending in another letter + HDF5 file locking off yields a correct temporal index.
const xdmfFileSettings = { file_name: '<model_part_name>_results-<time>', file_access_mode: 'read_write' };
process.env.HDF5_USE_FILE_LOCKING ??= 'FALSE';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkss-tier2-outputs-'));
const mcp = await servers();
const failures = [];
try {
  for (const format of ['vtk', 'gid', 'xdmf']) {
    const sourceCase = format === 'xdmf' ? 'structural' : 'thermal';
    const problemtype = sourceCase === 'structural' ? 'structural' : 'convectionDiffusion';
    const cwd = path.join(dir, format); await fs.cp(path.join(root, `doc/public/examples/tutorials/${sourceCase}`), cwd, { recursive: true });
    const meshPath = path.join(cwd, 'mesh.mdpa');
    const casePath = path.join(cwd, 'mesh.kratoscase.json');
    const state = JSON.parse(await fs.readFile(casePath, 'utf8'));
    // cases.mjs is the source of truth for materials: the published fixtures predate mesh 5.3.0's
    // refusal of non-positive densities (the structural archive still says DENSITY 0).
    state.materials = cases.find(c => c.id === sourceCase).materials;
    const model = format === 'xdmf' ? 'Structure' : 'ThermalModelPart';
    const field = format === 'xdmf' ? 'DISPLACEMENT' : 'TEMPERATURE';
    const component = format === 'xdmf' ? 'magnitude' : 'scalar';
    const unit = format === 'xdmf' ? 'm' : 'K';
    if (format === 'vtk') state.outputProcesses = { vtk_output: [{ python_module: 'vtk_output_process', kratos_module: 'KratosMultiphysics', process_name: 'VtkOutputProcess', Parameters: { model_part_name: model, output_path: 'custom_results', file_format: 'ascii', nodal_solution_step_data_variables: ['TEMPERATURE'] } }] };
    if (format === 'gid') state.outputProcesses = { gid_output: [{ python_module: 'gid_output_process', kratos_module: 'KratosMultiphysics', process_name: 'GiDOutputProcess', Parameters: { model_part_name: model, output_name: 'results/thermal', postprocess_parameters: { result_file_configuration: { gidpost_flags: { GiDPostMode: 'GiD_PostAscii' }, nodal_results: ['TEMPERATURE'] } } } }] };
    if (format === 'xdmf') state.outputProcesses = { hdf5_output: [{ python_module: 'single_mesh_xdmf_output_process', kratos_module: 'KratosMultiphysics.HDF5Application', Parameters: { model_part_name: model, file_settings: xdmfFileSettings, nodal_solution_step_data_settings: { list_of_variables: ['DISPLACEMENT'] } } }] };
    await fs.writeFile(casePath, JSON.stringify(state));
    const runDirectory = path.join(cwd, 'run');
    await fs.mkdir(path.join(runDirectory, 'results'), { recursive: true });
    await fs.rm(runDirectory, { recursive: true }); // case_run owns creation of a fresh directory
    const result = await mcp.call('mesh__case_run', { meshPath, casePath, python, problemtype, threads: 2, requestId: format, ownerId: 'tier2', runDirectory, waitSeconds: 60 });
    const status = await mcp.call('mesh__case_status', { requestId: format, ownerId: 'tier2', runDirectory });
    if (status.executionReceipt?.state !== 'succeeded') {
      const detail = { result, status, liveAcceptance: 'failed', reason: status.executionReceipt?.message ?? status.message ?? 'Solver process did not succeed.' };
      await fs.writeFile(path.join(cwd, 'acceptance.json'), JSON.stringify(detail, null, 2));
      console.error(`${format}: failed: ${detail.reason}`);
      if (format === 'xdmf') { failures.push(detail); continue; }
      throw new Error(`${format}: ${JSON.stringify(status)}`);
    }
    if (status.executionReceipt.resources?.effectiveThreads !== 2) throw new Error('Missing thread acknowledgement');
    const results = status.executionReceipt.artifacts.filter(a => a.role === 'result');
    if (!results.length) throw new Error(`${format}: missing results ${JSON.stringify(status)}`);
    // Discovery is judged before any read: the entrypoint and every companion the run produced.
    const discovery = { entrypoint: results[0].path, companions: status.output?.companions ?? [] };
    if (format === 'xdmf' && (!/\.xdmf$/.test(discovery.entrypoint) || discovery.companions.length < 2)) throw new Error(`xdmf: discovery incomplete ${JSON.stringify(discovery)}`);
    let statistics, quantity;
    try {
      statistics = await mcp.call('mesh__mesh_info', { path: results[0].path });
      if (![statistics.nodeCount, statistics.elementCount, statistics.conditionCount].every(Number.isSafeInteger)) throw new Error(`${format}: incomplete mesh statistics ${JSON.stringify(statistics)}`);
      quantity = await mcp.call('mesh__case_evaluate_quantity', { path: results[0].path, field, kind: 'Nodal', component, reduction: 'max', unit, region: 'global', runId: format });
      if (!Number.isFinite(quantity.quantity.value)) throw new Error(`${format}: incorrect quantity ${JSON.stringify(quantity)}`);
      if (format !== 'xdmf' && Math.abs(quantity.quantity.value - 400) > 0.001) throw new Error(`${format}: incorrect quantity ${JSON.stringify(quantity)}`);
    } catch (error) {
      if (format !== 'xdmf') throw error;
      // The solver and discovery passed; the read-back is the open part of roadmap item 3 (meshio++'s XDMF reader).
      const detail = { result, status, discovery, liveAcceptance: 'failed', stage: 'read-back', reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ') };
      await fs.writeFile(path.join(cwd, 'acceptance.json'), JSON.stringify(detail, null, 2));
      console.error(`xdmf: solver and discovery passed (${discovery.companions.length} companions); read-back failed: ${detail.reason}`);
      failures.push(detail); continue;
    }
    console.log(`${format}: succeeded, ${results.length} result(s), quantity ${quantity.quantity.value} ${unit}, threads ${status.executionReceipt.resources.effectiveThreads}`);
    await fs.writeFile(path.join(cwd, 'acceptance.json'), JSON.stringify({ result, status, discovery, statistics, quantity }, null, 2));
  }
} finally { await mcp.close(); }
console.log(`Artifacts: ${dir}`);
if (failures.length) process.exitCode = 1;
