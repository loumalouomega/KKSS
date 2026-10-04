/** Click a quick-pick option that closes its own BrowserWindow.
 * Callers must also assert the selection's effect in the surviving app or on disk.
 */
export async function clickPickerOption(option, timeout = 30_000) {
  const picker = option.page();
  if (picker.isClosed()) throw new Error('Picker is already closed');
  // Arm this before clicking: Electron can destroy the picker before Chromium
  // acknowledges mouse-up. noWaitAfter avoids waiting on the destroyed frame,
  // but the input acknowledgement itself can still race the close event.
  const closed = picker.waitForEvent('close', { timeout });
  await Promise.all([
    closed,
    option.click({ noWaitAfter: true, timeout }).catch(error => {
      if (!picker.isClosed() || !error.message.includes('Target page, context or browser has been closed')) throw error;
    }),
  ]);
}
