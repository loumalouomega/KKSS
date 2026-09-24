import { ipcRenderer } from 'electron';
// Chromium remembers the focused DOM node across webContents.focus(). Only
// choose an entry point after navigation or when that node has been removed.
ipcRenderer.on('kkss:focus', () => {
  const enter = () => {
    if (document.activeElement && document.activeElement !== document.body && (document.activeElement as HTMLElement).getClientRects().length) return;
    const target = [...document.querySelectorAll<HTMLElement>('button, input, textarea, select, [contenteditable="true"], [tabindex="0"], a[href]')]
      .find(el => !el.matches(':disabled') && !el.closest('[hidden], [inert]') && el.getClientRects().length);
    if (target) target.focus();
    else { document.body.tabIndex = -1; document.body.focus(); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enter, { once: true });
  else enter();
});
