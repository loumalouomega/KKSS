import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { launchApp, appWindow, closeApp, quitApp, until, sleep, softwareGL, root } from '../e2eShared.mjs';
import { cases } from './cases.mjs';
import { python } from './mcp.mjs';

const geometryPrompt = 'Inspect the absolute cantilever STEP path and report its dimensions and entity ids. Do not edit it.';
const previewPrompt = 'Preview scaling solid-0 by [6, 1, 1] about the origin on the absolute cantilever STEP path.';
const applyPrompt = 'Apply the validated sixfold X scale to the absolute cantilever STEP path.';
const partsPrompt = 'Create Solid on solid-0, Support on face-3, and Load on face-1 for the absolute cantilever STEP path.';
const snapshotPrompt = 'Render four labelled views of the absolute cantilever model now.';
const exportPrompt = 'Export the absolute cantilever model as a first-order tetrahedral MDPA mesh at 0.8 mm, in metres, to the absolute mesh path.';
const describePrompt = 'Use mesh__problemtype_describe to inspect the structural built-in defaults for this case.';
const statePrompt = 'Write the verified structural cantilever case values to the absolute mesh path.';
const generatePrompt = 'Generate the Kratos case files for the absolute structural mesh.';
const runPrompt = 'Start the structural Kratos case in the background with Python 3.12, two OpenMP threads, and waitSeconds zero.';
const statusPrompt = 'Check the mesh Kratos run status.';
const evaluatePrompt = 'Evaluate minimum Z displacement at the final result time in millimetres.';

function recordTool(name, args) { return { id: `tutorial-${name}-${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }; }

function providerResult(req, stage, actions = []) {
  const isToolReply = req.messages.at(-1)?.role === 'tool';
  if (isToolReply) {
    let content = stage.reply;
    if (stage.key === 'status') {
      const resultText = String(req.messages.at(-1)?.content ?? '');
      const status = /"status"\s*:\s*"([^"]+)"/.exec(resultText)?.[1] ?? 'unknown';
      content = `The mesh case run receipt currently reports status "${status}".`;
    }
    if (stage.key === 'evaluate') {
      const report = JSON.parse(execFileSync(python, [path.join(root, 'tools/tutorials/verify.py'), 'structural', stage.workDir], { encoding: 'utf8' }));
      const value = -report.checks.max_abs_z_displacement_mm;
      content = `The final Z displacement is ${value.toFixed(9)} mm. The beam reference is ${-report.checks.beam_reference_mm.toFixed(9)} mm (relative error ${(report.checks.beam_displacement_relative_error.measured * 100).toFixed(2)}%). The solver also wrote VON_MISES_STRESS; its maximum is ${report.checks.max_von_mises_Pa.toFixed(1)} Pa.`;
      stage.report = report;
    }
    return { choices: [{ index: 0, delta: { content }, finish_reason: null }] };
  }
  return { choices: [{ index: 0, delta: { tool_calls: actions.map((call, index) => ({ index, ...call })) }, finish_reason: 'tool_calls' }] };
}

async function scriptedCapture(out) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-ai-tutorial-'));
  const profile = path.join(temp, 'profile');
  const workDir = path.join(temp, 'work');
  fs.mkdirSync(workDir);
  fs.mkdirSync(profile);
  const geometry = path.join(workDir, 'cantilever.stp');
  const meshPath = path.join(workDir, 'mesh.mdpa');
  fs.copyFileSync(path.join(root, 'cad/examples/STP/block.stp'), geometry);
  const cantilever = cases.find(c => c.id === 'structural');
  const stateTemplate = JSON.parse(fs.readFileSync(path.join(root, 'doc/public/examples/tutorials/structural/mesh.kratoscase.json'), 'utf8'));
  const interactionLog = [];
  const providerCalls = [];
  const callFor = (name, args) => recordTool(name, args);
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    const lastUser = String(request.messages.filter(m => m.role === 'user').at(-1)?.content ?? '');
    const key = lastUser.startsWith('Inspect the absolute cantilever') ? 'inspect'
      : lastUser.startsWith('Preview scaling') ? 'preview'
      : lastUser.startsWith('Apply the validated') ? 'apply'
      : lastUser.startsWith('Create Solid') ? 'parts'
      : lastUser.startsWith('Render four labelled') ? 'snapshot'
      : lastUser.startsWith('Export the absolute cantilever') ? 'export'
      : lastUser.startsWith('Use mesh__problemtype_describe') ? 'describe'
      : lastUser.startsWith('Write the verified') ? 'state'
      : lastUser.startsWith('Generate the Kratos') ? 'generate'
      : lastUser.startsWith('Start the structural') ? 'run'
      : lastUser.startsWith('Check the mesh Kratos') ? 'status'
      : lastUser.startsWith('Evaluate minimum Z') ? 'evaluate'
      : undefined;
    if (!key) { res.writeHead(400); res.end('Unknown scripted prompt'); return; }
    const stage = { key, workDir, reply: '' };
    const planned = {
      inspect: [callFor('cad__load_model', { path: geometry })],
      preview: [callFor('cad__apply_edit_ops', { path: geometry, ops: cantilever.ops })],
      apply: [callFor('cad__apply_edit_ops', { path: geometry, ops: cantilever.ops })],
      parts: [
        callFor('cad__set_part', { path: geometry, ...cantilever.parts[0] }),
        callFor('cad__set_part', { path: geometry, ...cantilever.parts[1] }),
        callFor('cad__set_part', { path: geometry, ...cantilever.parts[2] }),
      ],
      snapshot: [callFor('cad__render_snapshot', { path: geometry, composite: true })],
      export: [callFor('cad__export_mesh', { path: geometry, outputPath: meshPath, format: 'mdpaElements', unit: 'm', options: cantilever.options })],
      describe: [callFor('mesh__problemtype_describe', { problemtype: 'structural' })],
      state: [callFor('mesh__case_write_state', { meshPath, state: stateTemplate })],
      generate: [callFor('mesh__case_generate', { meshPath, problemtype: 'structural' })],
      run: [callFor('mesh__case_run', { meshPath, python, extraEnv: { OMP_NUM_THREADS: '2' }, waitSeconds: 0 })],
      status: [callFor('mesh__case_status', { meshPath })],
      evaluate: () => {
        const run = JSON.parse(fs.readFileSync(path.join(workDir, 'mesh.kratosrun.json'), 'utf8'));
        const resultFiles = fs.readdirSync(path.join(workDir, 'vtk_output')).filter(name => name.endsWith('.vtk'));
        assert.ok(resultFiles.length, 'the AI run must create a VTK result');
        resultFiles.sort((a, b) => Number(a.match(/_(\d+(?:\.\d+)?)\.vtk$/)?.[1] ?? 0) - Number(b.match(/_(\d+(?:\.\d+)?)\.vtk$/)?.[1] ?? 0));
        return [callFor('mesh__case_evaluate_quantity', {
          path: path.join(workDir, 'vtk_output', resultFiles.at(-1)), runId: run.runId,
          field: 'DISPLACEMENT', kind: 'Nodal', component: 'z', reduction: 'min', time: 1, unit: 'mm',
        })];
      },
    }[key];
    const actions = typeof planned === 'function' ? planned() : planned;
    stage.reply = key === 'inspect' ? 'The imported block measures 3 × 4 × 5 mm and contains solid-0 with six faces.'
      : key === 'preview' ? 'The preview is valid and wrote nothing. You denied the pending change, so the geometry and sidecars remain unchanged.'
      : key === 'apply' ? 'The approved X scale is saved in the CAD edit sidecar; the original STEP remains intact.'
      : key === 'parts' ? 'Solid, Support and Load are assigned to the requested body and faces.'
      : key === 'snapshot' ? 'The four-view snapshot is attached to the tool result.'
      : key === 'export' ? 'The mesh was exported in metres with its named regions preserved.'
      : key === 'describe' ? 'The built-in structural defaults and their editable CaseState are available.'
      : key === 'state' ? 'The structural case state was written beside the mesh.'
      : key === 'generate' ? 'ProjectParameters.json, the materials file and MainKratos.py were generated.'
      : key === 'run' ? 'The solver was dispatched in the background. I will check its run record next.'
      : key === 'status' ? 'The run record has been checked. The solver result is ready for a field evaluation.'
      : 'The requested field quantity is evaluated from the solver result.';
    stage.meshPath = meshPath;
    providerCalls.push({ key, request, stage, actions });
    if (request.messages.at(-1)?.role !== 'tool') {
      interactionLog.push({ key, prompt: lastUser, tools: actions.map(a => ({ name: a.function.name, arguments: JSON.parse(a.function.arguments) })) });
    }
    const result = providerResult(request, stage, actions);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(result)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ uiTheme: 'dark', llmProvider: 'openai', llmModelOpenai: 'tutorial-script', llmOpenaiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, llmToolApproval: 'always', 'kratos.pythonPath': python, 'kratos.extraEnv': { OMP_NUM_THREADS: '2' } }));
  let app;
  try {
    app = (await launchApp(geometry, { userDataDir: profile, extraArgs: [...softwareGL, '--force-device-scale-factor=2'], env: { OMP_NUM_THREADS: '2' } })).app;
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1600, 1200));
    const deadline = Date.now() + 120_000;
    const shell = await appWindow(app, '/renderer/shell/', deadline);
    await shell.locator('#chat-btn').click();
    let chat = await appWindow(app, '/renderer/chat/', deadline);
    await chat.locator('#input').waitFor();
    const send = async prompt => {
      await chat.locator('#input').fill(prompt);
      await chat.locator('#input').press('Enter');
    };
    const idle = async () => until(async () => !(await chat.locator('#send-btn').getAttribute('class')).includes('stop'), 'assistant response completion', 120_000);
    const actOnApprovals = async (decision, count = 1) => {
      for (let i = 0; i < count; i++) {
        const button = chat.getByRole('button', { name: decision, exact: true });
        await button.waitFor({ timeout: 90_000 });
        await button.click();
      }
    };
    const prompt = async (text, decision, count = 1) => {
      const before = interactionLog.length;
      await send(text);
      if (decision) await actOnApprovals(decision, count);
      await idle();
      await until(() => interactionLog.length > before, 'local scripted provider request');
    };

    const statBefore = fs.statSync(geometry);
    const hashBefore = execFileSync('sha256sum', [geometry], { encoding: 'utf8' }).split(' ')[0];
    await prompt(geometryPrompt.replace('/absolute cantilever STEP path', geometry));
    const previewCount = interactionLog.length;
    await send(previewPrompt.replaceAll('absolute cantilever STEP path', geometry));
    const validate = chat.getByRole('button', { name: 'Validate (dry run)', exact: true });
    await validate.waitFor({ timeout: 45_000 });
    await validate.click();
    await chat.locator('.dry-run-report').waitFor({ timeout: 45_000 });
    assert.equal(fs.existsSync(`${geometry}.edits.json`), false, 'dry run must not write the CAD sidecar');
    assert.equal(execFileSync('sha256sum', [geometry], { encoding: 'utf8' }).split(' ')[0], hashBefore);
    await actOnApprovals('Deny');
    await idle();
    await until(() => interactionLog.length > previewCount, 'local provider records dry-run denial');
    assert.equal(fs.existsSync(`${geometry}.edits.json`), false, 'denial must leave the CAD sidecar absent');
    await prompt(applyPrompt.replace('absolute cantilever STEP path', geometry), 'Allow');
    assert.equal(fs.statSync(geometry).mtimeMs, statBefore.mtimeMs, 'the approved operation is stored as a sidecar and does not rewrite the STEP');
    await prompt(partsPrompt.replaceAll('absolute cantilever STEP path', geometry), 'Allow', 3);
    await prompt(snapshotPrompt, undefined);
    await until(async () => await chat.locator('#messages img').count() > 0, 'snapshot images render in chat', 90_000);
    await chat.locator('#messages img').last().screenshot({ path: path.join(out, 'tutorial-ai-snapshot.png') });
    await prompt(`${exportPrompt} Input: ${geometry}; output: ${meshPath}`, 'Allow');
    assert.ok(fs.existsSync(meshPath), 'CAD MCP export must create the MDPA mesh');
    await prompt(describePrompt, 'Allow');
    await prompt(`${statePrompt} Mesh: ${meshPath}`, 'Allow');
    await prompt(`${generatePrompt} Path: ${meshPath}`, 'Allow');
    await prompt(runPrompt, 'Allow');
    await sleep(700);
    const statusText = statusPrompt;
    let statusPolls = 0;
    do {
      await prompt(statusText);
      statusPolls++;
      const run = JSON.parse(fs.readFileSync(path.join(workDir, 'mesh.kratosrun.json'), 'utf8'));
      if (run.status === 'finished') break;
      if (run.status === 'failed') throw Error(`AI Kratos run failed: ${JSON.stringify(run)}`);
      if (statusPolls > 120) throw Error(`AI Kratos run did not finish: ${JSON.stringify(run)}`);
      await sleep(250);
    } while (true);
    await prompt(evaluatePrompt);
    const report = JSON.parse(execFileSync(python, [path.join(root, 'tools/tutorials/verify.py'), 'structural', workDir], { encoding: 'utf8' }));
    assert.ok(report.checks.beam_displacement_relative_error.measured < 0.25);
    assert.equal(report.nodes, 1048);
    assert.ok(interactionLog.length >= 12);
    await chat.screenshot({ path: path.join(out, 'tutorial-ai-chat.png') });

    await chat.locator('#new-btn').click();
    await idle();
    await quitApp(app);
    app = (await launchApp(undefined, { userDataDir: profile, extraArgs: [...softwareGL, '--force-device-scale-factor=2'], env: { OMP_NUM_THREADS: '2' }, restore: true })).app;
    const restoredShell = await appWindow(app, '/renderer/shell/', Date.now() + 60_000);
    await restoredShell.locator('#chat-btn').click();
    chat = await appWindow(app, '/renderer/chat/', Date.now() + 60_000);
    await chat.locator('#history-btn').click();
    const saved = chat.locator('#history .convo-open').filter({ hasText: 'Inspect the absolute cantilever' }).first();
    await saved.waitFor({ timeout: 30_000 });
    await saved.click();
    await chat.getByText(/The final Z displacement is -0\.000589/, { exact: false }).waitFor({ timeout: 30_000 });
    assert.equal(await chat.getByRole('button', { name: 'Allow', exact: true }).count(), 0, 'restoring the transcript must not execute pending tools again');
    await chat.screenshot({ path: path.join(out, 'tutorial-ai-chat.png') });

    const transcript = [
      '# Scripted AI cantilever capture', '',
      'Local OpenAI-compatible fixture; no external provider or API key. Each tool call below ran in KKSS against the temporary absolute paths used for this acceptance run. The saved conversation was selected from chat history after restarting the app; restoring it did not rerun a tool.', '',
      `- Mesh: ${report.nodes} nodes, ${report.elements} elements`,
      `- Final minimum Z displacement: ${(-report.checks.max_abs_z_displacement_mm).toFixed(9)} mm`,
      `- Beam reference: ${(-report.checks.beam_reference_mm).toFixed(9)} mm`,
      `- Relative displacement error: ${(report.checks.beam_displacement_relative_error.measured * 100).toFixed(2)}% (limit 25%)`,
      `- Maximum von Mises stress: ${report.checks.max_von_mises_Pa.toFixed(1)} Pa`, '',
      '## Conversation', '',
      '> **User:** Inspect the block STEP file, preview scaling its X dimension by six, then let me decide.',
      '> **Assistant:** The model is 3 × 4 × 5 mm. The preview validated without writing. You denied the change, so its source and sidecars stayed unchanged.',
      '> **User:** Apply the X scale, name the body Solid and the end faces Support and Load, then show a snapshot.',
      '> **Assistant:** The 18 × 4 × 5 mm cantilever and three named parts are ready. The CAD tool returned labelled snapshot views.',
      '> **User:** Export a first-order 0.8 mm tetrahedral mesh to metres, inspect the structural defaults and prepare the case.',
      '> **Assistant:** The named-region MDPA mesh is exported. The structural defaults were read, then the case state and generated Kratos files were saved beside it.',
      '> **User:** Start the solve in the background, check its status, and evaluate final minimum Z displacement.',
      `> **Assistant:** The solver finished. Minimum Z displacement is ${(-report.checks.max_abs_z_displacement_mm).toFixed(9)} mm, compared with ${(-report.checks.beam_reference_mm).toFixed(9)} mm from the beam reference (${(report.checks.beam_displacement_relative_error.measured * 100).toFixed(2)}% error). VON_MISES_STRESS was written.`, '',
      'The geometry and result checks match the values published in the manual structural tutorial.', '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'doc/guide/tutorial-ai-transcript.md'), transcript);
    console.log(`PASS AI tutorial: ${report.nodes} nodes; ${report.checks.beam_displacement_relative_error.measured.toFixed(4)} relative displacement error; snapshot and conversation persistence passed`);
    return { report, interactionLog };
  } finally {
    if (app) await closeApp(app);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await scriptedCapture(path.join(root, 'doc/public/screenshots'));
}
export { scriptedCapture };
