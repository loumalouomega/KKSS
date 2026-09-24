import { setLocale, translate } from '../shared/i18n';
declare global { interface Window { kkssLocale?: 'en' | 'es' } }
setLocale(window.kkssLocale);
function localize(): void {
  document.documentElement.lang = window.kkssLocale ?? 'en';
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) { if (element.textContent?.trim() === element.dataset.i18n) element.textContent = translate(element.dataset.i18n!); }
  for (const attribute of ['title', 'placeholder', 'aria-label', 'alt']) {
    for (const element of document.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`)) element.setAttribute(attribute, translate(element.getAttribute(`data-i18n-${attribute}`)!));
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', localize, { once: true }); else localize();
