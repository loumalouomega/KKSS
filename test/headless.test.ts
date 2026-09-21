import { describe, it, expect } from 'vitest';
import { prepareHeadlessShutdown } from '../app/main/services/headless';
import { parseManualCallback } from '../app/main/services/cloud/oauthCore';
describe('headless shutdown', () => {
  it('attempts all saves before draining even after a save failure', async () => {
    const order: string[] = [];
    const errors = await prepareHeadlessShutdown([async () => { order.push('mesh'); throw new Error('disk full'); }, async () => { order.push('editor'); }], async () => { order.push('uploads'); });
    expect(order).toEqual(['mesh', 'editor', 'uploads']); expect(errors).toHaveLength(1);
  });
});
describe('manual OAuth callback', () => {
  const redirect = 'http://127.0.0.1:54321/callback';
  it('accepts the allocated redirect and matching state', () => expect(parseManualCallback(redirect + '?state=abc&code=xyz', redirect, 'abc')).toBe('xyz'));
  it.each(['http://evil.example/callback?state=abc&code=xyz', redirect + '?state=other&code=xyz', redirect + '/other?state=abc&code=xyz', redirect + '?state=abc&state=abc&code=xyz', redirect + '?state=abc&code=xyz#fragment'])('rejects callback %s', url => expect(() => parseManualCallback(url, redirect, 'abc')).toThrow());
});
