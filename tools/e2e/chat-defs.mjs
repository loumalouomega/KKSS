/**
 * Standing instructions, skills and prompt templates, end to end against the real
 * app: the user's `<userData>/assistant` files reach the model as context, a
 * `/name` template is expanded before it is stored, `app__skill_load` runs
 * without a prompt, and a project folder's definitions wait for trust. A loopback
 * OpenAI-compatible fixture records exactly what the model is sent.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { scenario, assert, until } from './context.mjs';
import { softwareGL } from '../e2eShared.mjs';

/** Set by `npm run docs:screenshots` to capture the documentation image from this run. */
const shot = process.env.KKSS_DEFS_SHOT;

await scenario('chat-defs', async c => {
  const seen = []; // the newest user message and the tool results of each request
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const request = JSON.parse(raw);
    const lastUser = String(request.messages.filter(m => m.role === 'user').at(-1).content);
    const tool = request.messages.at(-1).role === 'tool' ? String(request.messages.at(-1).content) : null;
    seen.push({ system: String(request.messages[0].content), user: lastUser, tool });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (tool !== null) emit({ content: 'Skill loaded.' });
    else if (lastUser.includes('load-skill')) emit({ tool_calls: [{ index: 0, id: 'call-skill', type: 'function', function: { name: 'app__skill_load', arguments: JSON.stringify({ name: 'checklist' }) } }] }, 'tool_calls');
    else emit({ content: 'ok' });
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  const userDir = path.join(c.profile, 'assistant');
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  write(userDir, 'instructions.md', 'Always use SI units.');
  write(userDir, 'skills/checklist/SKILL.md', '---\ndescription: Pre-solve checklist\n---\nCheck the mesh first.');
  write(userDir, 'prompts/review.md', 'Review $ARGUMENTS for problems.');
  const project = path.join(c.dir, 'project');
  write(path.join(project, '.kkss', 'assistant'), 'instructions.md', 'Project-only rule.');
  c.seed({
    // Documentation captures show the optional Kraty face; acceptance runs leave it off.
    ...(shot ? { llmKraty: true } : {}),
    llmProvider: 'openai', llmModelOpenai: 'fixture', llmOpenaiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    projectRoot: project,
  });
  try {
    const app = await c.launch(undefined, shot ? { extraArgs: [...softwareGL, '--force-device-scale-factor=2'] } : {});
    const shell = await c.page(app, 'shell');
    await shell.locator('#chat-btn').click();
    const chat = await c.page(app, 'chat');
    const idle = () => until(async () => !(await chat.locator('#send-btn').getAttribute('class')).includes('stop'));
    const send = async text => { await chat.locator('#input').fill(text); await chat.locator('#input').press('Enter'); await idle(); };

    // The panel lists what was found; the project's file waits for trust.
    await chat.locator('#mcp-btn').click();
    await chat.getByText('Pre-solve checklist').waitFor();
    await chat.locator('.mcp-name', { hasText: /^\/review$/ }).waitFor();
    await chat.getByText(/Instructions \(yours\): 20 characters/).waitFor();
    await chat.getByText(/tokens are added to every message/).waitFor();
    await chat.getByText(/Not trusted yet/).waitFor();
    if (shot) {
      // The project path is this machine's temp directory; the image shows a neutral one.
      await chat.evaluate(() => {
        document.querySelectorAll('.mcp-launch').forEach(node => { node.textContent = '~/projects/beam-study'; });
        const body = document.getElementById('mcp-body'); body.scrollTop = body.scrollHeight;
      });
      await chat.screenshot({ path: shot });
    }
    await chat.locator('#mcp-close').click();

    // Instructions and the catalog arrive as context — not in the system prompt, not the skill body.
    await send('hello');
    const first = seen.at(-1);
    assert.match(first.user, /Always use SI units\./);
    assert.match(first.user, /checklist — Pre-solve checklist/);
    assert.doesNotMatch(first.user, /Check the mesh first/);
    assert.doesNotMatch(first.user, /Project-only rule/, 'an untrusted folder contributes nothing');
    assert.doesNotMatch(first.system, /Always use SI units/);
    assert.match(first.system, /app__skill_load/);

    // The composer suggests templates, and the expanded text is what is stored and shown.
    await chat.locator('#input').fill('/re');
    const hint = chat.locator('#template-hints button', { hasText: '/review' });
    await hint.waitFor();
    await hint.click();
    assert.equal(await chat.locator('#input').inputValue(), '/review ');
    await chat.locator('#input').fill('/review beam.stl'); await chat.locator('#input').press('Enter'); await idle();
    assert.match(seen.at(-1).user, /^Review beam\.stl for problems\./);
    await chat.locator('.msg.user', { hasText: 'Review beam.stl for problems.' }).waitFor();
    assert.equal(await chat.locator('.msg.user', { hasText: '/review' }).count(), 0, 'the bubble shows the expanded text');
    await send('/tmp/model.stl');
    assert.match(seen.at(-1).user, /^\/tmp\/model\.stl/, 'a path is sent as typed');

    // app__skill_load is read-class: it runs without a prompt and returns the body.
    await send('load-skill');
    assert.equal(await chat.getByRole('button', { name: 'Allow', exact: true }).count(), 0, 'a skill load never prompts');
    await chat.getByText('Skill loaded.', { exact: true }).waitFor();
    assert.match(seen.at(-1).tool, /Check the mesh first\./);

    // Trusting the folder brings its instructions in; an edit takes them away again.
    await chat.locator('#mcp-btn').click();
    await chat.getByRole('button', { name: 'Trust this folder' }).click();
    await chat.getByText(/Instructions \(project\)/).waitFor();
    await chat.locator('#mcp-close').click();
    await send('after trust');
    assert.match(seen.at(-1).user, /Project-only rule\./);
    write(path.join(project, '.kkss', 'assistant'), 'instructions.md', 'Edited after trust.');
    await send('after edit');
    assert.doesNotMatch(seen.at(-1).user, /Project-only rule|Edited after trust/);
    assert.match(seen.at(-1).user, /Always use SI units\./, 'your own instructions still apply');

    // The panel offers the definitions folder.
    await chat.locator('#mcp-btn').click();
    await chat.getByRole('button', { name: 'Open folder…' }).waitFor();
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
