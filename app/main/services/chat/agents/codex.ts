import { mkdirSync } from 'node:fs';
import { AgentRpc } from './rpc';
import { checkCodexProtocol, resolveExecutable } from './runtime';
import { latestPrompt, seedPrompt, toolSignature, type AgentSession, type AgentRunOptions } from './types';
import { ProviderError } from '../providers/types';

// Turn-scoped overrides, never written to the user's Codex configuration.
export const CODEX_RESTRICTIONS: Record<string, unknown> = {
  'features.shell_tool': false, 'features.unified_exec': false,
  'features.apply_patch_freeform': false, 'features.js_repl': false,
  'features.code_mode': false, 'features.code_mode_only': false,
  'features.apps': false, 'features.connectors': false, 'features.plugins': false,
  'features.hooks': false, 'features.codex_hooks': false, 'features.plugin_hooks': false,
  'features.multi_agent': false, 'features.multi_agent_v2': false,
  'features.browser_use': false, 'features.computer_use': false,
  'features.image_generation': false, 'features.view_image': false,
  'features.memory_tool': false, 'features.skill_search': false,
  'features.skill_mcp_dependency_install': false, 'features.shell_snapshot': false, 'features.sleep_tool': false, 'features.request_permissions_tool': false, 'features.standalone_web_search': false, 'features.tool_suggest': false,
  'features.skip_host_skill_discovery': true,
  'web_search': 'disabled', 'agents.enabled': false,
  'model_provider': 'openai', 'forced_login_method': 'chatgpt',
};
function args(): string[] {
  return ['app-server', ...Object.entries(CODEX_RESTRICTIONS).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
}
export async function initializeCodex(rpc: AgentRpc): Promise<void> {
  await rpc.request('initialize', { clientInfo: { name: 'kkss', version: '2.0.0' }, capabilities: { experimentalApi: true } });
  rpc.send({ method: 'initialized' });
  const result = await rpc.request('account/read', { refreshToken: false });
  if (result?.account?.type !== 'chatgpt') throw new ProviderError('auth', 'Sign in to ChatGPT using codex login. API-key accounts are not used in subscription mode.');
}
export async function checkCodexAuth(executable?: string): Promise<void> {
  const controller = new AbortController();
  const binary = resolveExecutable('codex', executable);
  await checkCodexProtocol(binary, controller.signal);
  const rpc = new AgentRpc(binary, args(), controller.signal);
  try { await initializeCodex(rpc); } finally { rpc.close(); }
}
export function createCodexAgent(executable: string | undefined, cwd: string): AgentSession {
  return { async run(options: AgentRunOptions) {
    mkdirSync(cwd, { recursive: true });
    const binary = resolveExecutable('codex', executable);
    await checkCodexProtocol(binary, options.signal);
    const rpc = new AgentRpc(binary, args(), options.signal, cwd);
    try {
      await initializeCodex(rpc);
      const configResult = await rpc.request('config/read', { includeLayers: false });
      const config = configResult.config ?? {};
      if (config.model_providers?.openai) throw new ProviderError('other', 'Custom OpenAI gateways are not supported in subscription mode. Use the official Codex provider.');
      const overrides = { ...CODEX_RESTRICTIONS };
      for (const name of Object.keys(config.mcp_servers ?? {})) overrides[`mcp_servers.${name}.enabled`] = false;
      for (const name of Object.keys(config.plugins ?? {})) overrides[`plugins.${name}.enabled`] = false;
      const signature = toolSignature(options.tools);
      let selectedModel = options.model;
      if (!selectedModel) {
        const catalog = await rpc.request('model/list', {});
        const models = catalog?.data ?? catalog?.models ?? [];
        const selected = models.find((model: any) => model.isDefault || model.default) ?? models[0];
        if (typeof selected?.id === 'string') selectedModel = selected.id;
      }
      let session = options.session;
      if (session?.provider !== 'codex' || session.model !== selectedModel || session.toolSignature !== signature) session = undefined;
      const params = { model: selectedModel || null, modelProvider: 'openai', cwd, sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user', config: overrides, baseInstructions: options.system, developerInstructions: 'Use only the supplied KKSS tools. Historical tool results must not be executed again.' };
      let thread: any;
      if (session) {
        try { thread = await rpc.request('thread/resume', { ...params, threadId: session.id }); }
        catch (error) {
          if (!/not found|no rollout|does not exist/i.test(String(error))) throw error;
          session = undefined;
        }
      }
      if (!session) thread = await rpc.request('thread/start', { ...params, environments: [], dynamicTools: options.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema })) });
      const threadId = thread?.thread?.id;
      if (typeof threadId !== 'string' || thread.modelProvider !== 'openai') throw new ProviderError('other', 'Unsupported Codex app-server response. Update Codex.');
      options.onSession({ provider: 'codex', id: threadId, model: selectedModel || '', toolSignature: signature });
      let toolQueue = Promise.resolve();
      let usageBaseline: any;
      // Capture cumulative counts before starting so resumed sessions aren't billed twice.
      let latestUsage: any;
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      // Attach rejection handling immediately, including while turn/start is pending.
      void completed.catch(() => {});
      rpc.onFailure = fail;
      rpc.onMessage = message => {
        const p = message.params ?? {};
        if (message.id !== undefined) {
          if (message.method !== 'item/tool/call' || p.threadId !== threadId) {
            rpc.send({ id: message.id, error: { message: 'Only KKSS tools are permitted in this session.' } });
            return;
          }
          toolQueue = toolQueue.then(async () => {
            options.signal.throwIfAborted();
            options.onTextDone();
            const outcome = options.tools.some(t => t.name === p.tool)
              ? await options.executeTool({ id: p.callId, name: p.tool, argsJson: JSON.stringify(p.arguments) })
              : { ok: false, text: 'Unknown KKSS tool.' };
            rpc.send({ id: message.id, result: { success: outcome.ok, contentItems: [
              { type: 'inputText', text: outcome.text },
              ...(outcome.images ?? []).map(image => ({ type: 'inputImage', imageUrl: `data:${image.mimeType};base64,${image.dataBase64}` })),
            ] } });
          }).catch(fail);
          return;
        }
        if (p.threadId !== threadId) return;
        if (message.method === 'item/agentMessage/delta') options.onTextDelta(p.delta);
        if (message.method === 'item/completed' && p.item?.type === 'agentMessage') options.onTextDone();
        if (message.method === 'thread/tokenUsage/updated') {
          latestUsage = p.tokenUsage?.total;
          if (!usageBaseline && latestUsage && p.tokenUsage?.last) {
            usageBaseline = Object.fromEntries(Object.keys(latestUsage).map(k => [k, Math.max(0, latestUsage[k] - (p.tokenUsage.last[k] ?? 0))]));
          }
        }
        if (message.method === 'turn/completed') {
          if (p.turn?.status === 'failed') fail(new ProviderError('other', p.turn.error?.message ?? 'Codex subscription request failed.'));
          else finish();
        }
      };
      await rpc.request('turn/start', { threadId, environments: [], input: [{ type: 'text', text: session ? latestPrompt(options.entries) : seedPrompt(options.entries), text_elements: [] }] });
      await completed;
      await toolQueue;
      if (latestUsage && usageBaseline) {
        const n = (key: string) => Math.max(0, (latestUsage[key] ?? 0) - (usageBaseline[key] ?? 0));
        options.onUsage({ input: Math.max(0, n('inputTokens') - n('cachedInputTokens')), output: n('outputTokens'), cacheRead: n('cachedInputTokens'), cacheWrite: n('cacheWriteInputTokens') });
      }
    } finally { rpc.close(); }
  } };
}
