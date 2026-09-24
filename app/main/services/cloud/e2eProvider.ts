/** Local transport fixture. Unavailable in packaged apps and without explicit E2E opt-in. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CloudProvider } from './cloudProvider';
import type { CloudFile } from './cloudCore';
export function fixtureDirectory(env: NodeJS.ProcessEnv, packaged: boolean): string | undefined {
  const dir = env.KKSS_E2E_CLOUD_DIR;
  return !packaged && env.KKSS_E2E === '1' && dir && path.isAbsolute(dir) ? dir : undefined;
}
export function fixtureProvider(dir: string): CloudProvider {
  const file = (): CloudFile => ({ id: 'document', name: 'cloud.mdpa', parentId: 'root', rev: '1', isFolder: false });
  const account = () => ({ id: 'e2e', label: 'Local fixture' });
  return {
    id: 'dropbox', label: 'Local fixture', needsClientSecret: false,
    account, isConnected: () => true, connect: async () => account(), disconnect: async () => {},
    list: async () => ({ files: [file()] }), stat: async () => file(), findChild: async () => undefined,
    download: async (_file, dest) => { await fs.copyFile(path.join(dir, 'source.mdpa'), dest); },
    upload: async (_id, source) => {
      await fs.writeFile(path.join(dir, 'started'), 'started');
      const mode = (await fs.readFile(path.join(dir, 'mode'), 'utf8')).trim();
      if (mode === 'stall') await new Promise(() => {});
      if (mode === 'fail') throw new Error('Scripted upload failure');
      // The harness releases this barrier only after proving quit is held open.
      for (;;) {
        try { await fs.access(path.join(dir, 'release')); break; } catch { await new Promise(r => setTimeout(r, 50)); }
      }
      await fs.copyFile(source, path.join(dir, 'uploaded.mdpa'));
      return file();
    },
    create: async () => { throw new Error('Unexpected fixture sidecar upload'); },
  };
}
