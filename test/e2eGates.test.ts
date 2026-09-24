import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../app/main/services/stateStore', () => ({ stateStore: { get: vi.fn(() => true) } }));
import { stateStore } from '../app/main/services/stateStore';
import { restoreEnabled } from '../app/main/services/session';
import { fixtureDirectory } from '../app/main/services/cloud/e2eProvider';
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(stateStore.get).mockReturnValue(true); });
it('E2E restore is explicit and cannot override user opt-outs', () => {
  vi.stubEnv('KKSS_E2E', '1'); vi.stubEnv('KKSS_E2E_RESTORE', ''); vi.stubEnv('KKSS_NO_RESTORE', '');
  expect(restoreEnabled()).toBe(false);
  vi.stubEnv('KKSS_E2E_RESTORE', '1'); expect(restoreEnabled()).toBe(true);
  vi.stubEnv('KKSS_NO_RESTORE', '1'); expect(restoreEnabled()).toBe(false);
  vi.stubEnv('KKSS_NO_RESTORE', ''); vi.mocked(stateStore.get).mockReturnValue(false); expect(restoreEnabled()).toBe(false);
});
it('cloud fixture cannot activate in packaged or ordinary launches', () => {
  const env = { KKSS_E2E: '1', KKSS_E2E_CLOUD_DIR: '/tmp/fixture' };
  expect(fixtureDirectory(env, false)).toBe('/tmp/fixture');
  expect(fixtureDirectory(env, true)).toBeUndefined();
  expect(fixtureDirectory({ ...env, KKSS_E2E: undefined }, false)).toBeUndefined();
  expect(fixtureDirectory({ ...env, KKSS_E2E_CLOUD_DIR: 'relative' }, false)).toBeUndefined();
});
