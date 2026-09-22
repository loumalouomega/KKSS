import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { toolSignature, type AgentRunOptions } from '../app/main/services/chat/agents/types';
const state = vi.hoisted(() => ({ account: 'chatgpt', resumeMissing: false, restricted: true, requests: [] as any[], replies: [] as any[], rpc: null as any }));
vi.mock('../app/main/services/chat/agents/runtime', () => ({ resolveExecutable: () => '/codex', checkCodexProtocol: async () => { if (!state.restricted) throw new Error('restrictions'); } }));
vi.mock('../app/main/services/chat/agents/rpc', () => ({ AgentRpc: class {
  onMessage = (_: any) => {}; onFailure = (_: Error) => {};
  constructor() { state.rpc = this; }
  send(m: any) {
    state.replies.push(m);
    if (m.id === 'tool') queueMicrotask(() => this.onMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } }));
  }
  close() {}
  async request(method: string, params: any) {
    state.requests.push({ method, params });
    if (method === 'account/read') return { account: { type: state.account } };
    if (method === 'config/read') return { config: { features: Object.fromEntries(['shell_tool','unified_exec','apply_patch_freeform','js_repl','code_mode','apps','plugins','hooks'].map(k => [k, !state.restricted])), mcp_servers: { external: {} } } };
    if (method === 'thread/resume' && state.resumeMissing) throw new Error('thread not found');
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' }, modelProvider: 'openai' };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.onMessage({ method: 'item/agentMessage/delta', params: { threadId: 'thread', delta: 'Hello' } });
        this.onMessage({ id: 'outside', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread' } });
        this.onMessage({ id: 'tool', method: 'item/tool/call', params: { threadId: 'thread', callId: 'call', tool: 'cad__read', arguments: {} } });
      });
    }
    return {};
  }
} }));
import { createCodexAgent } from '../app/main/services/chat/agents/codex';
const makeOptions = (): AgentRunOptions => ({ system: 'KKSS', entries: [{ kind: 'user', text: 'Hello' }], model: '', tools: [{ name: 'cad__read', inputSchema: { type: 'object' } }], signal: new AbortController().signal, onSession: vi.fn(), onTextDelta: vi.fn(), onTextDone: vi.fn(), onUsage: vi.fn(), executeTool: vi.fn(async () => ({ ok: false, text: 'Denied' })) });
beforeEach(() => { state.account = 'chatgpt'; state.resumeMissing = false; state.restricted = true; state.requests = []; state.replies = []; });
describe('Codex subscription adapter', () => {
  it('streams text, dispatches tools and denies non-KKSS requests', async () => {
    const options = makeOptions(); await createCodexAgent(undefined, tmpdir()).run(options);
    expect(options.onTextDelta).toHaveBeenCalledWith('Hello');
    expect(options.executeTool).toHaveBeenCalledWith({ id: 'call', name: 'cad__read', argsJson: '{}' });
    expect(state.replies.find(m => m.id === 'outside').error).toBeDefined();
    expect(state.replies.find(m => m.id === 'tool').result.success).toBe(false);
    expect(state.requests.find(m => m.method === 'thread/start').params.config['mcp_servers.external.enabled']).toBe(false);
  });
  it('rejects API-key login before sending a model turn', async () => {
    state.account = 'apiKey'; await expect(createCodexAgent(undefined, tmpdir()).run(makeOptions())).rejects.toThrow('codex login');
    expect(state.requests.some(m => m.method === 'turn/start')).toBe(false);
  });
  it('rejects runtimes that cannot enforce restrictions', async () => {
    state.restricted = false; await expect(createCodexAgent(undefined, tmpdir()).run(makeOptions())).rejects.toThrow('restrictions');
    expect(state.requests.some(m => m.method === 'turn/start')).toBe(false);
  });
  it('resumes matching sessions and seeds a missing session from history', async () => {
    const options = makeOptions(); options.session = { provider: 'codex', id: 'old', model: '', toolSignature: toolSignature(options.tools) };
    state.resumeMissing = true; await createCodexAgent(undefined, tmpdir()).run(options);
    expect(state.requests.some(m => m.method === 'thread/resume')).toBe(true);
    expect(state.requests.find(m => m.method === 'turn/start').params.input[0].text).toContain('historical context');
  });
});
