/**
 * Kraty, end to end against the real app: off by default, then on through the
 * Settings key, and its face follows the sidebar's own state — waiting, writing,
 * needs-you (a hook-forced prompt), finished and error — against a loopback
 * OpenAI-compatible fixture. The face is presentation only, so the model's
 * request must be identical with it on.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { scenario, assert, until } from './context.mjs';
import { softwareGL } from '../e2eShared.mjs';

/** Set by `npm run docs:screenshots`: the full sidebar with Kraty asking for approval. */
const shot = process.env.KKSS_KRATY_SHOT;
/** Optional directory: one close-up of Kraty per state, for previews. */
const statesDir = process.env.KKSS_KRATY_STATES_DIR;

await scenario('chat-kraty', async c => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const request = JSON.parse(raw);
    const lastUser = String(request.messages.filter(m => m.role === 'user').at(-1).content);
    const afterTool = request.messages.at(-1).role === 'tool';
    if (lastUser.includes('fail') && !lastUser.includes('another') && !afterTool) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture failure"}}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (lastUser.includes('approve') && !afterTool) {
      emit({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'app__study_list', arguments: '{}' } }] }, 'tool_calls');
    } else {
      if (lastUser.includes('slow')) await sleep(2500);
      emit({ content: 'Here is a ' });
      if (lastUser.includes('slow')) await sleep(2500);
      emit({ content: 'short answer.' });
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  const userDir = path.join(c.profile, 'assistant');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'hooks.json'), JSON.stringify({ hooks: [
    { name: 'confirm-studies', event: 'PreToolUse', command: process.execPath, args: ['-e', "process.stderr.write('studies hold client data');process.exit(3)"], match: 'app__study_list' },
  ] }));
  c.seed({ llmKraty: true, llmProvider: 'openai', llmModelOpenai: 'fixture', llmOpenaiBaseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  try {
    const app = await c.launch(undefined, shot || statesDir ? { extraArgs: [...softwareGL, '--force-device-scale-factor=2'] } : {});
    const shell = await c.page(app, 'shell');
    await shell.locator('#chat-btn').click();
    const chat = await c.page(app, 'chat');
    const idle = () => until(async () => !(await chat.locator('#send-btn').getAttribute('class')).includes('stop'));
    const state = () => chat.locator('#kraty').getAttribute('data-state');
    const reaches = async (want) => { await until(async () => (await state()) === want); };
    const closeup = async name => { if (statesDir) { fs.mkdirSync(statesDir, { recursive: true }); await chat.locator('#kraty').screenshot({ path: path.join(statesDir, `kraty-${name}.png`) }); } };
    const send = async text => { await chat.locator('#input').fill(text); await chat.locator('#input').press('Enter'); };

    await chat.locator('#composer-options').waitFor();
    await reaches('idle');
    await closeup('idle');

    // A slow turn: waiting for the first token, then writing.
    await send('slow please');
    await reaches('waiting'); await closeup('waiting');
    await reaches('writing'); await closeup('writing');
    await idle();
    await reaches('finished'); await closeup('finished');
    await reaches('idle'); // settles back on its own

    // A hook-forced prompt: the turn is blocked on the user.
    await send('approve');
    await chat.getByRole('button', { name: 'Allow', exact: true }).waitFor();
    await reaches('needsYou'); await closeup('needs-you');
    if (shot) await chat.screenshot({ path: shot });
    await chat.getByRole('button', { name: 'Allow', exact: true }).click();
    await idle();

    // A failed request ends in the error face until the next message.
    await send('fail');
    await idle();
    await reaches('error'); await closeup('error');
    await send('another');
    await until(async () => (await state()) !== 'error'); // the next message clears the error face
    await idle();
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
