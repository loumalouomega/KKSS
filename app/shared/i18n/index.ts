import english from './en.json';
import spanish from './es.json';
export type Locale = 'en' | 'es';
export type Message = keyof typeof english;
let locale: Locale = 'en';
export function resolveLocale(value: unknown): Locale { return value === 'es' ? 'es' : 'en'; }
export function setLocale(value: unknown): void { locale = resolveLocale(value); }
export function currentLocale(): Locale { return locale; }
export function translate(message: string, values: Readonly<Record<string, unknown>> = {}, language: Locale = locale): string {
  const fallback = (english as Record<string, string>)[message] ?? message;
  const template = language === 'es' ? (spanish as Record<string, string>)[message] || fallback : fallback;
  return template.replace(/\{(\d+)\}/g, (placeholder, key: string) => key in values ? String(values[key]) : placeholder);
}
export function t(message: Message, values?: Readonly<Record<string, unknown>>): string { return translate(message, values); }
