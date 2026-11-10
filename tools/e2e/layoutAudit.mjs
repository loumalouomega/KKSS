/**
 * Layout audit for app-owned pages: at a given window width, no visible control may be clipped off the
 * page edge or lack an accessible name. Reports problems as plain strings; callers assert the list is empty. This is
 * deliberately structural — it measures the DOM, it does not judge the design — so it can run against a packaged build.
 */
import axe from 'axe-core';

/** Widths the self-test visits: the window's minimum, a laptop and a wide monitor (windows.ts minWidth is 720). */
export const AUDIT_WIDTHS = [720, 1280, 1920];

/** In-page measurement. Kept as one function so `page.evaluate` can serialise it. */
function measure() {
  const problems = [];
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
  const visible = (el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]');
  };
  // A control is clipped when it leaves the viewport horizontally and no scrollable ancestor can bring it back.
  const scrollable = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !scrollable(el)) problems.push(`clipped horizontally: ${label(el)} [${Math.round(r.left)}..${Math.round(r.right)}] of ${vw}`);
    if (r.top > vh + 1 && !scrollable(el) && document.scrollingElement && document.scrollingElement.scrollHeight <= vh) problems.push(`below the page: ${label(el)}`);
  }
  return problems;
}

/** Layout problems at the page's current size. */
export async function layoutProblems(page) {
  return page.evaluate(measure);
}

/** axe's naming rules only: controls without an accessible name (the full WCAG scan lives in accessibility.mjs). */
export async function unnamedControls(page) {
  await page.evaluate(axe.source);
  return page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'rule', values: ['button-name', 'link-name', 'label', 'select-name', 'input-button-name', 'aria-input-field-name'] } }))
    .violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)));
}

/** Resizes the first app window to `width` x `height` and waits one animation frame in `pages` for the layout to settle. */
export async function resizeWindow(app, pages, width, height = 800) {
  await app.evaluate(({ BaseWindow }, [w, h]) => { const win = BaseWindow.getAllWindows()[0]; win.setSize(w, h); }, [width, height]);
  for (const page of pages) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Audits `pages` ({name, page}) at every width; returns `width name: problem` strings. */
export async function auditPages(app, pages, widths = AUDIT_WIDTHS) {
  const out = [];
  for (const width of widths) {
    await resizeWindow(app, pages.map((p) => p.page), width);
    for (const { name, page } of pages) {
      for (const problem of [...await layoutProblems(page), ...await unnamedControls(page)]) out.push(`${width}px ${name}: ${problem}`);
    }
  }
  return out;
}
