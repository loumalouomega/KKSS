import { expect, it, vi } from 'vitest';
import { documentReplacementQueue } from '../app/main/services/documentReplacement';

it('commits only after successful consent and keeps cancellation unchanged', async () => {
  const replace = documentReplacementQueue(), commit = vi.fn();
  expect(await replace(() => true, async () => false, commit)).toBe(false);
  expect(commit).not.toHaveBeenCalled();
  expect(await replace(() => true, async () => true, commit)).toBe(true);
  expect(commit).toHaveBeenCalledOnce();
});
it('rechecks a target after save and abandons closed or replaced documents', async () => {
  const replace = documentReplacementQueue(), commit = vi.fn(); let current = true;
  expect(await replace(() => current, async () => { current = false; return true; }, commit)).toBe(false);
  expect(commit).not.toHaveBeenCalled();
});
it('serializes dialogs and does not apply a queued open to a newer document', async () => {
  const replace = documentReplacementQueue(); let document = 'original';
  let approve!: (yes: boolean) => void;
  const dialog = new Promise<boolean>(resolve => { approve = resolve; });
  const secondConfirm = vi.fn(async () => true);
  const first = replace(() => document === 'original', () => dialog, () => { document = 'first'; });
  const second = replace(() => document === 'original', secondConfirm, () => { document = 'second'; });
  await Promise.resolve(); expect(secondConfirm).not.toHaveBeenCalled(); approve(true);
  expect(await first).toBe(true); expect(await second).toBe(false);
  expect(document).toBe('first'); expect(secondConfirm).not.toHaveBeenCalled();
});
it('a failed save never commits and does not poison subsequent opens', async () => {
  const replace = documentReplacementQueue(), commit = vi.fn();
  await expect(replace(() => true, async () => { throw new Error('disk full'); }, commit)).rejects.toThrow('disk full');
  expect(commit).not.toHaveBeenCalled();
  expect(await replace(() => true, async () => true, commit)).toBe(true);
});
