import fs from 'node:fs';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { scenario, assert, menu, until, quitApp } from './context.mjs';
import { kratosFixture } from './fixtures.mjs';
await scenario('chat-mcp', async c => {
  const fixture = kratosFixture(c.dir);
  let streamClosed = false;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const request = JSON.parse(raw);
    const lastUser = request.messages.filter(m => m.role === 'user').at(-1).content;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const done = () => { res.write('data: [DONE]\n\n'); res.end(); };
    if (String(lastUser).includes('cancel-stream')) {
      emit({ content: 'Cancellable stream started' }); res.on('close', () => { streamClosed = true; }); return;
    }
    if (request.messages.at(-1).role === 'tool') { emit({ content: 'Tool decision recorded.' }); done(); return; }
    if (/approve-tool|deny-tool/.test(String(lastUser))) {
      emit({ tool_calls: [{ index: 0, id: `call-${String(lastUser).includes('deny-tool') ? 'deny' : 'approve'}`, type: 'function', function: { name: 'kratos__job_cancel', arguments: JSON.stringify({ job_id: 'e2e-job' }) } }] }, 'tool_calls'); done(); return;
    }
    emit({ content: 'Hello ' }); setImmediate(() => { emit({ content: 'from the local fixture.' }); done(); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  // Reserve a candidate port before launch; endpoint bind failures remain test failures.
  const portProbe = http.createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
  const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
  c.seed({ llmProvider: 'openai', llmModelOpenai: 'fixture', llmOpenaiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, llmToolApproval: 'always', metaServerPort: port, metaServerToken: { plain: 'e2e-local-token' } });
  let client;
  try {
    let app = await c.launch(undefined, { env: fixture.env }); let shell = await c.page(app, 'shell');
    await shell.locator('#chat-btn').click(); let chat = await c.page(app, 'chat');
    const send = async text => { await chat.locator('#input').fill(text); await chat.locator('#input').press('Enter'); };
    const idle = async () => until(async () => !(await chat.locator('#send-btn').getAttribute('class')).includes('stop'));
    await send('hello'); await chat.getByText('Hello from the local fixture.', { exact: true }).waitFor(); await idle();
    await send('deny-tool'); await chat.getByRole('button', { name: 'Deny', exact: true }).waitFor();
    assert.equal(JSON.parse(fs.readFileSync(fixture.file)).jobs[0].state, 'running');
    await chat.getByRole('button', { name: 'Deny', exact: true }).click();
    await chat.getByText('Tool decision recorded.', { exact: true }).waitFor(); await idle();
    assert.equal(JSON.parse(fs.readFileSync(fixture.file)).jobs[0].state, 'running');
    await send('approve-tool'); await chat.getByRole('button', { name: 'Allow', exact: true }).waitFor();
    assert.equal(JSON.parse(fs.readFileSync(fixture.file)).jobs[0].state, 'running');
    await chat.getByRole('button', { name: 'Allow', exact: true }).click();
    await until(() => JSON.parse(fs.readFileSync(fixture.file)).jobs[0].state === 'cancelled', 'approved tool executed');
    await until(async () => await chat.getByText('Tool decision recorded.', { exact: true }).count() === 2); await idle();
    await send('cancel-stream'); await chat.getByText('Cancellable stream started', { exact: true }).waitFor();
    await chat.locator('#send-btn').click(); await until(() => streamClosed, 'provider request aborted'); await idle();
    await menu(app, 'Enable (external LLM access)');
    const url = `http://127.0.0.1:${port}/mcp`;
    await until(async () => { try { return (await fetch(url)).status === 401; } catch { return false; } }, 'MCP listener');
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    client = new Client({ name: 'e2e', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer e2e-local-token' } } }));
    assert.ok((await client.listTools()).tools.some(t => t.name === 'kratos__job_list'));
    const result = await client.callTool({ name: 'kratos__job_list', arguments: {} }); assert.match(JSON.stringify(result), /cancelled/);
    await client.close(); client = undefined; await menu(app, 'Enable (external LLM access)');
    await until(async () => { try { await fetch(url); return false; } catch { return true; } }, 'MCP listener closed');
    await quitApp(app);
    app = await c.launch(undefined, { env: fixture.env }); shell = await c.page(app, 'shell'); await shell.locator('#chat-btn').click(); chat = await c.page(app, 'chat');
    await chat.getByText('Hello from the local fixture.', { exact: true }).waitFor();
    assert.equal(await chat.getByRole('button', { name: 'Allow', exact: true }).count(), 0, 'restoration must not rerun approvals');
  } finally { await client?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
