// Live output/receipt/quantity acceptance. Needs the tutorial Python plus HDF5Application/h5py.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { servers, python, root } from '../tutorials/mcp.mjs';
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
    const model = format === 'xdmf' ? 'Structure' : 'ThermalModelPart';
    const field = format === 'xdmf' ? 'DISPLACEMENT' : 'TEMPERATURE';
    const component = format === 'xdmf' ? 'magnitude' : 'scalar';
    const unit = format === 'xdmf' ? 'm' : 'K';
    if (format === 'vtk') state.outputProcesses = { vtk_output: [{ python_module: 'vtk_output_process', kratos_module: 'KratosMultiphysics', process_name: 'VtkOutputProcess', Parameters: { model_part_name: model, output_path: 'custom_results', file_format: 'ascii', nodal_solution_step_data_variables: ['TEMPERATURE'] } }] };
    if (format === 'gid') state.outputProcesses = { gid_output: [{ python_module: 'gid_output_process', kratos_module: 'KratosMultiphysics', process_name: 'GiDOutputProcess', Parameters: { model_part_name: model, output_name: 'results/thermal', postprocess_parameters: { result_file_configuration: { gidpost_flags: { GiDPostMode: 'GiD_PostAscii' }, nodal_results: ['TEMPERATURE'] } } } }] };
    if (format === 'xdmf') state.outputProcesses = { hdf5_output: [{ python_module: 'single_mesh_xdmf_output_process', kratos_module: 'KratosMultiphysics.HDF5Application', Parameters: { model_part_name: model, nodal_solution_step_data_settings: { list_of_variables: ['DISPLACEMENT'] } } }] };
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
    const statistics = await mcp.call('mesh__mesh_info', { path: results[0].path });
    if (![statistics.nodeCount, statistics.elementCount, statistics.conditionCount].every(Number.isSafeInteger)) throw new Error(`${format}: incomplete mesh statistics ${JSON.stringify(statistics)}`);
    const quantity = await mcp.call('mesh__case_evaluate_quantity', { path: results[0].path, field, kind: 'Nodal', component, reduction: 'max', unit, region: 'global', runId: format });
    if (!Number.isFinite(quantity.quantity.value)) throw new Error(`${format}: incorrect quantity ${JSON.stringify(quantity)}`);
    if (format !== 'xdmf' && Math.abs(quantity.quantity.value - 400) > 0.001) throw new Error(`${format}: incorrect quantity ${JSON.stringify(quantity)}`);
    console.log(`${format}: succeeded, ${results.length} result(s), quantity ${quantity.quantity.value} ${unit}, threads ${status.executionReceipt.resources.effectiveThreads}`);
    await fs.writeFile(path.join(cwd, 'acceptance.json'), JSON.stringify({ result, status, statistics, quantity }, null, 2));
  }
} finally { await mcp.close(); }
console.log(`Artifacts: ${dir}`);
if (failures.length) process.exitCode = 1;
