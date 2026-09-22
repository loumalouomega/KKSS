/** Startup-only operator settings. Never merge this overlay into JsonStore. */
import { readFileSync } from "node:fs";
import * as path from "node:path";

export interface ManagedConfig { values: Map<string, unknown>; secrets: Map<string, string> }
export function parseManagedConfig(env: NodeJS.ProcessEnv, read = (file: string) => readFileSync(file, "utf8")): ManagedConfig {
  const values = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const fail = (name: string): never => { throw new Error(`Invalid operator setting ${name}`); };
  const text = (name: string, key: string) => {
    if (env[name] !== undefined && env[name]!.trim()) values.set(key, env[name]!.trim());
  };
  const choice = (name: string, key: string, options: string[]) => {
    text(name, key); if (values.has(key) && !options.includes(values.get(key) as string)) fail(name);
  };
  const bool = (name: string, key: string) => {
    if (env[name] !== undefined && env[name]!.trim()) {
      const raw = env[name]!.trim();
      if (!['0', '1'].includes(raw)) fail(name);
      values.set(key, raw === '1');
    }
  };
  const number = (name: string, key: string, min: number, max: number, integer = false) => {
    if (env[name] === undefined || !env[name]!.trim()) return;
    const n = Number(env[name]);
    if (!env[name]?.trim() || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) fail(name);
    values.set(key, n);
  };
  const secret = (name: string, key: string) => {
    if (env[name] === undefined || !env[name]!.trim()) return;
    let value: string;
    try { value = read(env[name]!).trimEnd(); } catch { return fail(name); }
    if (!value) fail(name);
    secrets.set(key, value);
  };
  choice('KKSS_LLM_PROVIDER', 'llmProvider', ['anthropic', 'openai', 'codex', 'claude-code']);
  // A model/key without a provider is ambiguous when the stored provider changes.
  if ((env.KKSS_LLM_MODEL || env.KKSS_LLM_API_KEY_FILE) && !env.KKSS_LLM_PROVIDER) fail('KKSS_LLM_PROVIDER');
  const subscription = env.KKSS_LLM_PROVIDER === 'codex' || env.KKSS_LLM_PROVIDER === 'claude-code';
  if (subscription && (env.KKSS_LLM_API_KEY_FILE || env.KKSS_LLM_BASE_URL)) fail('KKSS_LLM_PROVIDER');
  const provider = env.KKSS_LLM_PROVIDER === 'codex' ? 'Codex' : env.KKSS_LLM_PROVIDER === 'claude-code' ? 'ClaudeCode' : env.KKSS_LLM_PROVIDER === 'openai' ? 'Openai' : 'Anthropic';
  text('KKSS_CODEX_EXECUTABLE', 'llmCodexExecutable');
  text('KKSS_CLAUDE_CODE_EXECUTABLE', 'llmClaudeCodeExecutable');
  for (const name of ['KKSS_CODEX_EXECUTABLE', 'KKSS_CLAUDE_CODE_EXECUTABLE']) {
    if (env[name]?.trim() && !path.isAbsolute(env[name]!.trim())) fail(name);
  }
  text('KKSS_LLM_MODEL', `llmModel${provider}`);
  secret('KKSS_LLM_API_KEY_FILE', `llmKey${provider}`);
  text('KKSS_LLM_BASE_URL', 'llmOpenaiBaseUrl');
  if (env.KKSS_LLM_BASE_URL) {
    try { if (!['http:', 'https:'].includes(new URL(env.KKSS_LLM_BASE_URL).protocol)) fail('KKSS_LLM_BASE_URL'); }
    catch { fail('KKSS_LLM_BASE_URL'); }
  }
  text('KKSS_PROJECT_ROOT', 'projectRoot');
  if (env.KKSS_PROJECT_ROOT && !path.isAbsolute(env.KKSS_PROJECT_ROOT)) fail('KKSS_PROJECT_ROOT');
  bool('KKSS_RESTORE_SESSION', 'restoreSession');
  choice('KKSS_THEME', 'sceneTheme', ['auto', 'light', 'dark', 'scientific']);
  choice('KKSS_UI_THEME', 'uiTheme', ['system', 'dark', 'light', 'hcDark', 'hcLight']);
  number('KKSS_ZOOM', 'uiZoom', 0.5, 3);
  bool('KKSS_META_ENABLED', 'metaServerEnabled');
  number('KKSS_META_PORT', 'metaServerPort', 1, 65535, true);
  secret('KKSS_META_TOKEN_FILE', 'metaServerToken');
  for (const [name, id] of [['GOOGLE', 'gdrive'], ['DROPBOX', 'dropbox'], ['ONEDRIVE', 'onedrive']]) {
    text(`KKSS_CLOUD_${name}_CLIENT_ID`, `cloud.${id}.clientId`);
    secret(`KKSS_CLOUD_${name}_CLIENT_SECRET_FILE`, `cloud.${id}.clientSecret`);
  }
  return { values, secrets };
}
let config: ManagedConfig | undefined;
export const managedConfig = () => config ??= parseManagedConfig(process.env);
