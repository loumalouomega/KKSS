import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { clickPickerOption } from '../tools/e2e/picker.mjs';

const targetClosed = () => new Error('locator.click: Target page, context or browser has been closed');

function fixture(click: (close: () => void) => Promise<void>) {
  let isClosed = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  const page = { isClosed: () => isClosed, waitForEvent: vi.fn(() => closed) };
  const close = () => { isClosed = true; resolveClosed(); };
  const option = { page: () => page as unknown as Page, click: vi.fn(() => click(close)) };
  return { option, page, close, rejectClosed };
}

describe('self-closing picker interaction', () => {
  it('registers the close waiter before clicking and keeps actionability checks', async () => {
    const f = fixture(async close => {
      expect(f.page.waitForEvent).toHaveBeenCalledWith('close', { timeout: 1234 });
      close();
    });
    await clickPickerOption(f.option, 1234);
    expect(f.option.click).toHaveBeenCalledWith({ noWaitAfter: true, timeout: 1234 });
  });

  it('accepts picker closure before the click acknowledgement arrives', async () => {
    const f = fixture(async close => { close(); throw targetClosed(); });
    await expect(clickPickerOption(f.option)).resolves.toBeUndefined();
  });

  it('still waits for closure when the click acknowledgement arrives first', async () => {
    const f = fixture(async () => {});
    const done = vi.fn();
    const action = clickPickerOption(f.option).then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    f.close();
    await action;
    expect(done).toHaveBeenCalledOnce();
  });

  it('does not suppress a target-closed error when the picker remains open', async () => {
    const error = targetClosed();
    const f = fixture(async () => { throw error; });
    await expect(clickPickerOption(f.option)).rejects.toBe(error);
  });

  it('does not suppress unrelated click errors even when the picker closed', async () => {
    const error = new Error('strict mode violation');
    const f = fixture(async close => { close(); throw error; });
    await expect(clickPickerOption(f.option)).rejects.toBe(error);
  });

  it.each(['Timed out waiting for close', 'Page crashed'])('propagates close waiter failure: %s', async message => {
    const f = fixture(async () => {});
    const action = clickPickerOption(f.option);
    const error = new Error(message);
    f.rejectClosed(error);
    await expect(action).rejects.toBe(error);
  });

  it('rejects a picker that was already closed without attempting the click', async () => {
    const f = fixture(async () => {});
    f.close();
    await expect(clickPickerOption(f.option)).rejects.toThrow('Picker is already closed');
    expect(f.option.click).not.toHaveBeenCalled();
  });
});
