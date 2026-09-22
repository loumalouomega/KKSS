import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { ProviderError } from '../providers/types';
import type { SubscriptionProvider } from './types';

export const SUBSCRIPTION_SETUP = {
  codex: { label: 'ChatGPT subscription (Codex)', command: 'codex login', url: 'https://developers.openai.com/codex/cli' },
  'claude-code': { label: 'Claude subscription (Claude Code)', command: 'claude auth login', url: 'https://code.claude.com/docs/en/setup' },
};
/** Do not let an inherited API key or gateway silently change billing. */
export function subscriptionEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|OPENAI_|AZURE_OPENAI_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|CLAUDE_AGENT_SDK_|CODEX_API_KEY|CODEX_INTERNAL_|ELECTRON_RUN_AS_NODE)/.test(key)) delete env[key];
  }
  delete env.CLAUDECODE;
  return env;
}
export function resolveExecutable(provider: SubscriptionProvider, configured?: string): string {
  const name = provider === 'codex' ? 'codex' : 'claude';
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const dirs = [ ...(process.env.PATH ?? '').split(path.delimiter), path.join(homedir(), '.local', 'bin'), path.join(homedir(), '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin' ].filter(Boolean);
  const candidates = configured ? [configured] : dirs.map(dir => path.join(dir, name + suffix));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
  }
  throw new ProviderError('other', `${SUBSCRIPTION_SETUP[provider].label} executable not found. Install the official tool, then set its absolute executable path under Settings ▸ LLM Assistant.`);
}
export function runtimeCommand(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { env: subscriptionEnv(), signal, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(new ProviderError('auth', 'Could not check subscription login. Run the official tool’s login command and retry.'));
      else resolve(stdout);
    });
  });
}
export async function checkClaudeAuth(executable: string, signal?: AbortSignal): Promise<void> {
  let status: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
  try { status = JSON.parse(await runtimeCommand(executable, ['auth', 'status', '--json'], signal)); }
  catch { throw new ProviderError('auth', 'Claude subscription login unavailable. Update Claude Code and run claude auth login.'); }
  if (!status.loggedIn || status.authMethod !== 'claude.ai' || !status.subscriptionType) {
    throw new ProviderError('auth', 'Sign in to an eligible Claude subscription using claude auth login. API-key accounts are not used in subscription mode.');
  }
}

/** Capability probing is local, cached by executable modification time, and sends no prompt. */
export async function checkCodexProtocol(executable: string, signal?: AbortSignal): Promise<void> {
  const { mkdtemp, readFile, rm, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const stamp = (await stat(executable)).mtimeMs;
  if (protocolCache.get(executable) === stamp) return;
  const dir = await mkdtemp(path.join(tmpdir(), 'kkss-codex-protocol-'));
  try {
    await runtimeCommand(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', dir], signal);
    const start = JSON.parse(await readFile(path.join(dir, 'v2', 'ThreadStartParams.json'), 'utf8'));
    const turn = JSON.parse(await readFile(path.join(dir, 'v2', 'TurnStartParams.json'), 'utf8'));
    if (!start.properties?.dynamicTools || !start.properties?.environments || !turn.properties?.environments) throw new Error('unsupported protocol');
    protocolCache.set(executable, stamp);
  } catch {
    throw new ProviderError('other', 'This Codex runtime lacks the dynamic-tool and environment controls KKSS requires. Update the official Codex CLI.');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const protocolCache = new Map<string, number>();
