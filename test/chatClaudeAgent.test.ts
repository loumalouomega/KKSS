import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { toolSignature, type AgentRunOptions } from '../app/main/services/chat/agents/types';
const state = vi.hoisted(() => ({ options: null as any, prompt: '', missing: false, auth: true, api: false, rateLimit: false, closed: false, nativeTool: false }));
vi.mock('../app/main/services/chat/agents/runtime', () => ({ resolveExecutable: () => '/claude', subscriptionEnv: () => ({}), checkClaudeAuth: async () => { if (!state.auth) throw new Error('Sign in'); } }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: async () => state.missing ? undefined : {},
  query: ({ prompt, options }: any) => {
    state.options = options;
    return {
      accountInfo: async () => ({ subscriptionType: 'max', apiProvider: 'firstParty', apiKeySource: state.api ? 'apiKeyHelper' : 'none' }),
      close: () => { state.closed = true; },
      async *[Symbol.asyncIterator]() {
        for await (const message of prompt) state.prompt = message.message.content;
        yield { type: 'system', subtype: 'init', session_id: 'session', apiKeySource: 'none', tools: state.nativeTool ? ['Bash'] : ['mcp__kkss__cad__read'] };
        if (state.rateLimit) { yield { type: 'assistant', error: 'rate_limit' }; return; }
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } };
        yield { type: 'assistant' };
        yield { type: 'result', is_error: false, usage: { input_tokens: 10, output_tokens: 2 } };
      },
    };
  },
}));
import { createClaudeAgent } from '../app/main/services/chat/agents/claude';
const makeOptions = (): AgentRunOptions => ({ system: 'KKSS', entries: [{ kind: 'user', text: 'Hello' }], model: '', tools: [{ name: 'cad__read', inputSchema: { type: 'object' } }], signal: new AbortController().signal, onSession: vi.fn(), onTextDelta: vi.fn(), onTextDone: vi.fn(), onUsage: vi.fn(), executeTool: vi.fn(async () => ({ ok: true, text: 'result' })) });
beforeEach(() => { Object.assign(state, { options: null, prompt: '', missing: false, auth: true, api: false, rateLimit: false, closed: false, nativeTool: false }); });
describe('Claude subscription adapter', () => {
  it('uses the private MCP bridge with native tools and external settings disabled', async () => {
    const options = makeOptions(); await createClaudeAgent(undefined, tmpdir()).run(options);
    expect(state.options.tools).toEqual([]); expect(state.options.settingSources).toEqual([]);
    expect(state.options.strictMcpConfig).toBe(true); expect(state.options.settings.disableAllHooks).toBe(true);
    expect(options.onTextDelta).toHaveBeenCalledWith('Hello');
    expect(options.onUsage).toHaveBeenCalledWith({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect(state.closed).toBe(true);
  });
  it('does not send a prompt for an API-billed account', async () => {
    state.api = true; await expect(createClaudeAgent(undefined, tmpdir()).run(makeOptions())).rejects.toThrow('subscription account');
    expect(state.prompt).toBe(''); expect(state.closed).toBe(true);
  });
  it('rejects a runtime exposing native tools', async () => {
    state.nativeTool = true; await expect(createClaudeAgent(undefined, tmpdir()).run(makeOptions())).rejects.toThrow('non-KKSS');
    expect(state.closed).toBe(true);
  });
  it('maps rate limits and closes the session', async () => {
    state.rateLimit = true; await expect(createClaudeAgent(undefined, tmpdir()).run(makeOptions())).rejects.toMatchObject({ kind: 'rateLimit' });
    expect(state.closed).toBe(true);
  });
  it('recovers a missing session without replaying calls', async () => {
    state.missing = true; const options = makeOptions(); options.session = { provider: 'claude-code', id: 'missing', model: '', toolSignature: toolSignature(options.tools) };
    await createClaudeAgent(undefined, tmpdir()).run(options);
    expect(state.options.resume).toBeUndefined(); expect(state.prompt).toContain('historical context'); expect(options.executeTool).not.toHaveBeenCalled();
  });
});
