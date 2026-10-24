/**
 * Lifecycle hooks, end to end against the real app: the user's
 * `<userData>/assistant/hooks.json` runs real commands around the assistant's tool
 * calls and messages. A PreToolUse hook denies a read-only call (and the model is
 * told the block is final), another forces a prompt on a read tool, a
 * UserPromptSubmit hook refuses a message and hands the draft back, a PostToolUse
 * hook observes, and a project folder's hooks wait for trust. A loopback
 * OpenAI-compatible fixture records exactly what the model is sent.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { scenario, assert, until } from './context.mjs';
import { softwareGL } from '../e2eShared.mjs';

/** Set by `npm run docs:screenshots` to capture the documentation image from this run. */
const shot = process.env.KKSS_HOOKS_SHOT;
/** The transcript with a blocked call and a hook-forced prompt (set by the same pipeline). */
const promptShot = process.env.KKSS_HOOKS_PROMPT_SHOT;

await scenario('chat-hooks', async c => {
  const seen = []; // the newest user message and the tool result of each request
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const request = JSON.parse(raw);
    const lastUser = String(request.messages.filter(m => m.role === 'user').at(-1).content);
    const tool = request.messages.at(-1).role === 'tool' ? String(request.messages.at(-1).content) : null;
    seen.push({ system: String(request.messages[0].content), user: lastUser, tool });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const call = (id, name, args = {}) => emit({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
    if (tool !== null) emit({ content: 'Understood.' });
    else if (lastUser.includes('load-skill')) call('call-skill', 'app__skill_load', { name: 'checklist' });
    else if (lastUser.includes('list-studies')) call('call-studies', 'app__study_list');
    else emit({ content: 'ok' });
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  const userDir = path.join(c.profile, 'assistant');
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const audit = path.join(c.dir, 'audit.log');
  const node = (name, event, script, extra = {}) => ({ name, event, command: process.execPath, args: ['-e', script], ...extra });
  const stdin = body => `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);${body}})`;
  write(userDir, 'skills/checklist/SKILL.md', '---\ndescription: Pre-solve checklist\n---\nCheck the mesh first.');
  write(userDir, 'hooks.json', JSON.stringify({ hooks: [
    node('lab-policy', 'PreToolUse', "process.stderr.write('skills are off in this lab');process.exit(2)", { match: 'app__skill_load' }),
    node('confirm-studies', 'PreToolUse', "process.stderr.write('studies hold client data');process.exit(3)", { match: 'app__study_list' }),
    node('no-secrets', 'UserPromptSubmit', stdin("if (p.message.includes('hunter2')) { process.stderr.write('no passwords in prompts'); process.exit(2); }")),
    node('audit', 'PostToolUse', stdin(`require('fs').appendFileSync(${JSON.stringify(audit)}, p.tool + ' ' + p.result.ok + '\\n')`)),
  ] }));
  const project = path.join(c.dir, 'project');
  write(path.join(project, '.kkss', 'assistant'), 'hooks.json', JSON.stringify({ hooks: [
    node('team-gate', 'PreToolUse', 'process.exit(2)', { match: 'cad__*' }),
  ] }));
  c.seed({
    llmProvider: 'openai', llmModelOpenai: 'fixture', llmOpenaiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    projectRoot: project,
  });
  try {
    const app = await c.launch(undefined, shot || promptShot ? { extraArgs: [...softwareGL, '--force-device-scale-factor=2'] } : {});
    const shell = await c.page(app, 'shell');
    await shell.locator('#chat-btn').click();
    const chat = await c.page(app, 'chat');
    const idle = () => until(async () => !(await chat.locator('#send-btn').getAttribute('class')).includes('stop'));
    const send = async text => { await chat.locator('#input').fill(text); await chat.locator('#input').press('Enter'); await idle(); };

    // The panel lists your hooks; the project's wait for trust.
    await chat.locator('#mcp-btn').click();
    await chat.locator('.mcp-name', { hasText: /^lab-policy$/ }).waitFor();
    await chat.locator('.mcp-name', { hasText: /^audit$/ }).waitFor();
    assert.equal(await chat.locator('.mcp-name', { hasText: /^team-gate$/ }).count(), 0, 'an untrusted project contributes no hooks');
    await chat.getByText('A hook can refuse a tool call or make it ask first. It can never approve one.').waitFor();
    if (shot) {
      await chat.evaluate(() => {
        document.querySelectorAll('.mcp-launch').forEach(node => { node.textContent = node.textContent.replace(/^.*?node(\.exe)?\b/, 'node').replace(/\s-e\s.*$/, ' hooks/policy.js'); });
        const hooks = [...document.querySelectorAll('.mcp-project h3')].find(h => h.textContent === 'Lifecycle hooks');
        hooks?.scrollIntoView();
      });
      await chat.screenshot({ path: shot });
    }
    await chat.locator('#mcp-close').click();

    // PreToolUse denies a call that needed no approval; the model is told it is final.
    await send('load-skill');
    assert.equal(await chat.getByRole('button', { name: 'Allow', exact: true }).count(), 0, 'a refused call never prompts');
    await chat.getByText(/Blocked by your hook “lab-policy”: skills are off in this lab/).waitFor();
    assert.match(seen.at(-2).tool ?? seen.at(-1).tool, /Blocked by the user's hook "lab-policy": skills are off in this lab/);
    assert.match(seen.at(-1).tool, /Do not retry/);

    // A hook can send a read tool to the user — and only the user can let it run.
    await chat.locator('#input').fill('list-studies'); await chat.locator('#input').press('Enter');
    await chat.getByText('One of your hooks asked for confirmation before this call. Run it?').waitFor();
    await chat.getByText(/Your hook “confirm-studies” asked for confirmation: studies hold client data/).waitFor();
    if (promptShot) await chat.screenshot({ path: promptShot });
    await chat.getByRole('button', { name: 'Allow', exact: true }).click();
    await idle();
    assert.ok(seen.at(-1).tool !== null, 'the call ran after the user allowed it and its result reached the model');
    // PostToolUse observed the call that ran (and not the one that was blocked).
    await until(async () => fs.existsSync(audit));
    const lines = fs.readFileSync(audit, 'utf8').trim().split('\n');
    assert.deepEqual(lines.map(l => l.split(' ')[0]), ['app__study_list'], 'only the call that ran is audited');

    // UserPromptSubmit refuses the message and gives the draft back.
    const before = seen.length;
    await chat.locator('#input').fill('my password is hunter2'); await chat.locator('#input').press('Enter');
    await chat.getByText('The message was not sent: no-secrets: no passwords in prompts').waitFor();
    assert.equal(await chat.locator('#input').inputValue(), 'my password is hunter2', 'the draft comes back');
    assert.equal(seen.length, before, 'the model never saw it');
    assert.equal(await chat.locator('.msg.user', { hasText: 'hunter2' }).count(), 0, 'nothing was added to the conversation');
    await chat.locator('#input').fill('');
    await send('a harmless message');
    assert.match(seen.at(-1).user, /a harmless message/, 'the next message goes through');

    // Trusting the folder brings its hooks in; an edit takes them away again.
    await chat.locator('#mcp-btn').click();
    await chat.getByRole('button', { name: 'Trust this folder' }).click();
    await chat.locator('.mcp-name', { hasText: /^team-gate$/ }).waitFor();
    write(path.join(project, '.kkss', 'assistant'), 'hooks.json', JSON.stringify({ hooks: [node('team-gate', 'PreToolUse', 'process.exit(2)', { match: 'cad__*' }), node('extra', 'TurnEnd', 'process.exit(0)')] }));
    await chat.getByRole('button', { name: 'Reload' }).click();
    await chat.getByText(/changed since you trusted/).waitFor();
    assert.equal(await chat.locator('.mcp-name', { hasText: /^team-gate$/ }).count(), 0, 'an edit after trust drops the project hooks');
    assert.equal(await chat.locator('.mcp-name', { hasText: /^audit$/ }).count(), 1, 'your own hooks still apply');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
