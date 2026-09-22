import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { getSessionInfo, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { checkClaudeAuth, resolveExecutable, subscriptionEnv } from './runtime';
import { latestPrompt, seedPrompt, toolSignature, type AgentSession, type AgentRunOptions } from './types';
import { ProviderError } from '../providers/types';

export function createClaudeAgent(executable: string | undefined, cwd: string): AgentSession {
  return { async run(options: AgentRunOptions) {
    const binary = resolveExecutable('claude-code', executable);
    await checkClaudeAuth(binary, options.signal);
    mkdirSync(cwd, { recursive: true });
    const signature = toolSignature(options.tools);
    let session = options.session;
    if (session?.provider !== 'claude-code' || session.model !== options.model || session.toolSignature !== signature) session = undefined;
    if (session && !await getSessionInfo(session.id, { dir: cwd })) session = undefined;
    let toolQueue = Promise.resolve();
    const server = new McpServer({ name: 'kkss', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: options.tools }));
    server.server.setRequestHandler(CallToolRequestSchema, async request => {
      // Serial dispatch preserves the sidebar's single pending approval contract.
      let result: any;
      const work = toolQueue.then(async () => {
        options.signal.throwIfAborted();
        options.onTextDone();
        const outcome = options.tools.some(t => t.name === request.params.name)
          ? await options.executeTool({ id: randomUUID(), name: request.params.name, argsJson: JSON.stringify(request.params.arguments ?? {}) })
          : { ok: false, text: 'Unknown KKSS tool.' };
        result = { isError: !outcome.ok, content: [ { type: 'text', text: outcome.text },
          ...(outcome.images ?? []).map(image => ({ type: 'image', mimeType: image.mimeType, data: image.dataBase64 })),
        ] };
      });
      toolQueue = work.catch(() => {});
      await work;
      return result;
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) controller.abort();
    let stream: ReturnType<typeof query> | undefined;
    try {
      let releaseInput!: () => void;
      const ready = new Promise<void>(resolve => { releaseInput = resolve; });
      // Streaming input allows the SDK to serve the private in-process MCP bridge.
      async function* input(): AsyncGenerator<SDKUserMessage> {
        await ready;
        if (controller.signal.aborted) return;
        yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: session ? latestPrompt(options.entries) : seedPrompt(options.entries) } };
      }
      stream = query({ prompt: input(), options: {
        pathToClaudeCodeExecutable: binary, cwd, env: subscriptionEnv(), abortController: controller,
        model: options.model || undefined, resume: session?.id, systemPrompt: options.system,
        tools: [], settingSources: [], strictMcpConfig: true, plugins: [],
        settings: { disableAllHooks: true, disableClaudeAiConnectors: true, forceLoginMethod: 'claudeai', enableAllProjectMcpServers: false },
        mcpServers: { kkss: { type: 'sdk', name: 'kkss', instance: server } },
        canUseTool: async (name, input) => options.tools.some(t => name === `mcp__kkss__${t.name}`)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Only KKSS tools are permitted.' },
        includePartialMessages: true, maxTurns: 25,
      } });
      try {
        const account = await stream.accountInfo();
        if (!account.subscriptionType || account.apiProvider !== 'firstParty' || (account.apiKeySource && account.apiKeySource !== 'none')) {
          throw new ProviderError('auth', 'Claude Code must use a Claude subscription account, without an API key or gateway.');
        }
      } catch (error) { controller.abort(); throw error; } finally { releaseInput(); }
      for await (const message of stream) {
        options.signal.throwIfAborted();
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.apiKeySource !== 'none' || message.tools.some(name => !options.tools.some(t => name === `mcp__kkss__${t.name}`))) {
            throw new ProviderError('other', 'This Claude Code configuration exposes non-KKSS tools or API billing. Update the tool and check its managed settings.');
          }
          options.onSession({ provider: 'claude-code', id: message.session_id, model: options.model, toolSignature: signature });
        }
        if (message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') options.onTextDelta(message.event.delta.text);
        if (message.type === 'assistant') {
          options.onTextDone();
          if (message.error) throw new ProviderError(message.error === 'rate_limit' ? 'rateLimit' : message.error === 'authentication_failed' ? 'auth' : 'other', `Claude subscription request failed (${message.error}).`);
        }
        if (message.type === 'result') {
          if (message.is_error) throw new ProviderError('other', 'Claude subscription session failed. Check login, model availability and usage limits in Claude Code.');
          const u = message.usage;
          options.onUsage({ input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 });
        }
      }
      await toolQueue;
    } finally {
      options.signal.removeEventListener('abort', abort);
      controller.abort(); stream?.close(); await server.close();
    }
  } };
}
