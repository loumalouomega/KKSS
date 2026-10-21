/**
 * The chat sidebar's MCP manager, end to end against the real app: a user server
 * asks until its tool is marked read-only, a project server never starts until
 * the folder is trusted (and stops again when its file changes), and the form
 * adds a server. Local fixtures only — a loopback LLM and a stdio server.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { scenario, assert, until } from './context.mjs';
import { root, softwareGL } from '../e2eShared.mjs';

/** Set by `npm run docs:screenshots` to capture the documentation image from this run. */
const shot = process.env.KKSS_MCP_SHOT;

await scenario('chat-mcp-manager', async c => {
  const fixture = path.join(root, 'tools/fixtures/user-server.mjs');
  const acmeLog = path.join(c.dir, 'acme.log');
  const labLog = path.join(c.dir, 'lab.log');
  const betaLog = path.join(c.dir, 'beta.log');
  const lines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
  const project = path.join(c.dir, 'project');
  const definitions = path.join(project, '.kkss', 'assistant', 'mcp.json');
  fs.mkdirSync(path.dirname(definitions), { recursive: true });
  fs.writeFileSync(definitions, JSON.stringify({ servers: [{ id: 'lab', command: process.execPath, args: [fixture, labLog] }] }));

  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const request = JSON.parse(raw);
    const last = request.messages.at(-1);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const text = String(request.messages.filter(m => m.role === 'user').at(-1).content);
    if (last.role === 'tool') emit({ content: 'Tool decision recorded.' });
    else if (text.includes('call-lookup')) emit({ tool_calls: [{ index: 0, id: 'call-lookup', type: 'function', function: { name: 'acme__lookup', arguments: '{}' } }] }, 'tool_calls');
    else emit({ content: 'ok' });
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  c.seed({
    llmProvider: 'openai', llmModelOpenai: 'fixture', llmOpenaiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    projectRoot: project,
    assistantMcpServers: [{ id: 'acme', command: process.execPath, args: [fixture, acmeLog] }],
  });
  try {
    const app = await c.launch(undefined, shot ? { extraArgs: [...softwareGL, '--force-device-scale-factor=2'] } : {});
    const shell = await c.page(app, 'shell');
    await shell.locator('#chat-btn').click();
    const chat = await c.page(app, 'chat');
    const row = id => chat.locator('.mcp-row', { has: chat.locator('.mcp-name', { hasText: new RegExp(`^${id}$`) }) });
    const status = id => row(id).locator('.mcp-status');
    const idle = () => until(async () => !(await chat.locator('#send-btn').getAttribute('class')).includes('stop'));
    const send = async text => { await chat.locator('#input').fill(text); await chat.locator('#input').press('Enter'); };

    // The panel lists the user server and the untrusted project server.
    await chat.locator('#mcp-btn').click();
    await chat.locator('#mcp-panel').waitFor();
    await until(async () => /2 tools/.test(await status('acme').innerText().catch(() => '')), 'acme connected');
    assert.match(await status('lab').innerText(), /trust the project folder/);
    assert.equal(lines(labLog).length, 0, 'an untrusted project server is never launched');
    await chat.getByText(/Not trusted yet/).waitFor();

    if (shot) {
      // Scrolled to the user and project servers: the built-in rows above are the
      // same on every machine, and Kratos' own state depends on the local runtime.
      // The launch lines and the folder are this machine's temp paths; the committed image
      // shows neutral ones instead (text only — nothing the scenario asserts reads them).
      await chat.evaluate(() => {
        const names = ['node acme-server.js', 'node lab-server.js', '~/projects/beam-study'];
        [...document.querySelectorAll('.mcp-launch')].forEach((node, i) => { node.textContent = names[i] ?? node.textContent; });
        const body = document.getElementById('mcp-body'); body.scrollTop = body.scrollHeight;
      });
      await chat.screenshot({ path: shot });
    }

    // Trusting launches it.
    await chat.getByRole('button', { name: 'Trust this folder' }).click();
    await until(async () => /2 tools/.test(await status('lab').innerText().catch(() => '')), 'lab connected after trust');
    assert.deepEqual(lines(labLog), ['start']);

    // An edit to the file stops trusting it: the server is closed, not left running.
    fs.writeFileSync(definitions, JSON.stringify({ servers: [{ id: 'lab', command: process.execPath, args: [fixture, labLog, 'changed'] }] }));
    await chat.getByRole('button', { name: 'Reload' }).click();
    await chat.getByText(/changed since you trusted/).waitFor();
    await until(async () => /trust the project folder/.test(await status('lab').innerText()), 'lab blocked after the file changed');
    assert.deepEqual(lines(labLog), ['start'], 'the changed definition was never launched');

    // An unmarked user tool asks first.
    await chat.locator('#mcp-close').click();
    await send('call-lookup');
    await chat.getByRole('button', { name: 'Allow', exact: true }).waitFor();
    assert.deepEqual(lines(acmeLog), ['start'], 'nothing ran before approval');
    await chat.getByRole('button', { name: 'Deny', exact: true }).click();
    await chat.getByText('Tool decision recorded.', { exact: true }).waitFor(); await idle();
    assert.deepEqual(lines(acmeLog), ['start'], 'a denied call never reaches the server');

    // Marked read-only, the same call runs without a prompt.
    await chat.locator('#mcp-btn').click();
    await row('acme').getByRole('button', { name: 'Tools' }).click();
    await chat.locator('.mcp-row', { has: chat.locator('code', { hasText: /^lookup$/ }) }).locator('select').selectOption('read');
    await until(async () => (JSON.parse(fs.readFileSync(path.join(c.profile, 'state.json'), 'utf8')).assistantMcpToolMarks?.acme?.tools?.lookup) === 'read', 'mark persisted');
    await chat.getByRole('button', { name: 'Back' }).click();
    await chat.locator('#mcp-close').click();
    await send('call-lookup');
    await until(() => lines(acmeLog).includes('call:lookup'), 'marked tool ran without asking');
    assert.equal(await chat.getByRole('button', { name: 'Allow', exact: true }).count(), 0);
    await idle();

    // Disable stops it; the dot strip follows.
    await chat.locator('#mcp-btn').click();
    await row('acme').getByRole('button', { name: 'Disable' }).click();
    await until(async () => /disabled/.test(await status('acme').innerText()), 'acme disabled');

    // The form adds a server, and a refused id says why.
    await chat.getByRole('button', { name: 'Add server' }).click();
    await chat.getByLabel('Id', { exact: true }).fill('cad');
    await chat.getByLabel('Command').fill(process.execPath);
    await chat.getByRole('button', { name: 'Save' }).click();
    await chat.getByText(/reserved/).waitFor();
    await chat.getByLabel('Id', { exact: true }).fill('beta');
    await chat.getByLabel('Arguments').fill(`"${fixture}" "${betaLog}"`);
    await chat.getByRole('button', { name: 'Save' }).click();
    await until(async () => /2 tools/.test(await status('beta').innerText().catch(() => '')), 'beta connected');

    // Removal needs a second, deliberate click.
    await row('beta').getByRole('button', { name: 'Remove' }).click();
    await row('beta').getByRole('button', { name: 'Click again to remove' }).click();
    await until(async () => await row('beta').count() === 0, 'beta removed');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
