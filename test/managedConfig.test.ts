import { describe, it, expect } from 'vitest';
import { parseManagedConfig } from '../app/main/services/managedConfig';
describe('operator settings', () => {
  it('keeps secrets separate from persisted values and selects the provider model', () => {
    const c = parseManagedConfig({ KKSS_LLM_PROVIDER: 'openai', KKSS_LLM_MODEL: 'lab-model', KKSS_LLM_API_KEY_FILE: '/secret', KKSS_RESTORE_SESSION: '0' }, () => 'private-key\n');
    expect(c.secrets.get('llmKeyOpenai')).toBe('private-key');
    expect(c.values.has('llmKeyOpenai')).toBe(false);
    expect(c.values.get('llmModelOpenai')).toBe('lab-model');
    expect(c.values.get('restoreSession')).toBe(false);
  });
  it.each([{ KKSS_LLM_PROVIDER: 'unknown' }, { KKSS_LLM_MODEL: 'ambiguous' }, { KKSS_PROJECT_ROOT: '../relative' }, { KKSS_META_PORT: '0' }, { KKSS_RESTORE_SESSION: 'true' }, { KKSS_ZOOM: 'NaN' }])('rejects invalid startup configuration %j', env => {
    expect(() => parseManagedConfig(env)).toThrow('Invalid operator setting');
  });
  it('redacts file errors', () => {
    expect(() => parseManagedConfig({ KKSS_META_TOKEN_FILE: '/secret' }, () => { throw new Error('secret data'); })).toThrow('Invalid operator setting KKSS_META_TOKEN_FILE');
  });
});
