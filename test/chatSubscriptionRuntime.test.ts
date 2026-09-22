import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveExecutable, subscriptionEnv } from '../app/main/services/chat/agents/runtime';
import { AgentRpc } from '../app/main/services/chat/agents/rpc';
import { parseConversation, newConversation } from '../app/main/services/chat/transcriptStoreCore';
import { seedPrompt } from '../app/main/services/chat/agents/types';

describe('subscription runtime boundaries', () => {
  it('removes API billing and gateway settings without changing the parent environment', () => {
    const parent = { HOME: '/home/test', PATH: '/bin', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'gateway', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1' };
    expect(subscriptionEnv(parent)).toEqual({ HOME: '/home/test', PATH: '/bin' });
    expect(parent.ANTHROPIC_API_KEY).toBe('secret');
  });
  it('detects absolute executable paths including spaces and refuses missing or relative paths', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kkss runtime '));
    try {
      const file = path.join(dir, 'claude'); writeFileSync(file, ''); chmodSync(file, 0o700);
      expect(resolveExecutable('claude-code', file)).toBe(file);
      expect(() => resolveExecutable('codex', path.join(dir, 'missing'))).toThrow('not found');
      expect(() => resolveExecutable('codex', 'relative')).toThrow('not found');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('round-trips session and billing metadata without losing old conversations', () => {
    const conversation = newConversation('one', 1);
    conversation.agentSession = { provider: 'codex', id: 'thread', model: '', toolSignature: '[]' };
    conversation.usageBillingMode = 'mixed'; conversation.usageIdentity = 'codex:';
    expect(parseConversation(JSON.parse(JSON.stringify(conversation)))).toMatchObject({ agentSession: conversation.agentSession, usageBillingMode: 'mixed' });
    expect(parseConversation({ ...conversation, agentSession: { provider: 'invalid' } })?.agentSession).toBeUndefined();
    expect(parseConversation(newConversation('old', 0))?.id).toBe('old');
  });
  it('seeds historical calls as data rather than issuing them', () => {
    const prompt = seedPrompt([{ kind: 'toolCall', callId: 'old', server: 'cad', tool: 'edit', argsJson: '{}' }, { kind: 'user', text: 'Continue' }]);
    expect(prompt).toContain('not tool requests'); expect(prompt).toContain('Continue');
  });
});

describe('subscription stdio protocol', () => {
  it('settles pending requests on cancellation', async () => {
    const controller = new AbortController();
    const rpc = new AgentRpc(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], controller.signal);
    const pending = rpc.request('hello', {});
    controller.abort();
    await expect(pending).rejects.toThrow('stopped');
  });
});
