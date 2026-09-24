import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { nextRegion } from '../app/shared/focus';
import { currentLocale, resolveLocale, setLocale, t, translate } from '../app/shared/i18n';
import english from '../app/shared/i18n/en.json';
import spanish from '../app/shared/i18n/es.json';
import { buildRegistry, normalize } from '../app/main/services/settings/registry';
import { median, regressions, sample, exitCodeForRegressions } from '../tools/perf/core.mjs';
afterEach(() => setLocale('en'));
describe('localization contract', () => {
  it('uses English by default and falls back safely without reinterpreting arguments', () => {
    expect(resolveLocale('fr')).toBe('en');
    setLocale('es'); expect(currentLocale()).toBe('es'); expect(t('Settings')).toBe('Ajustes');
    expect(t('Could not open {0}: {1}', {0: 'Save', 1: '{0}'})).toBe('No se pudo abrir Save: {0}');
    expect(translate('New upstream message')).toBe('New upstream message');
  });
  it('keeps every interpolation in Spanish and covers static markup', () => {
    expect(Object.keys(spanish).sort()).toEqual(Object.keys(english).sort());
    for (const [key, value] of Object.entries(spanish)) {
      expect(value.trim(), key).not.toBe('');
      const parameters = (text: string) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort();
      expect(parameters(value), key).toEqual(parameters(key));
    }
    for (const directory of fs.readdirSync('app/renderer', {withFileTypes: true}).filter(d => d.isDirectory())) {
      for (const file of fs.readdirSync(path.join('app/renderer', directory.name)).filter(f => f.endsWith('.html'))) {
        const html = fs.readFileSync(path.join('app/renderer', directory.name, file), 'utf8');
        for (const match of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) {
          const key = match[1].replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&gt;', '>').replaceAll('&lt;', '<');
          expect(spanish, `${file}: ${key}`).toHaveProperty(key);
        }
      }
    }
  });
  it('translates settings metadata without changing IDs, categories, values or defaults', () => {
    const english = buildRegistry(); setLocale('es'); const translated = buildRegistry();
    const contract = (rows: ReturnType<typeof buildRegistry>) => rows.map(({id, category, storeKey, default: value, enum: choices}) => ({id, category, storeKey, value, choices}));
    expect(contract(translated)).toEqual(contract(english));
    expect(translated.find(e => e.id === 'general.language')?.label).toBe('Idioma');
    const entry = english.find(e => e.id === 'general.language')!;
    expect(entry.applies).toBe('nextStart'); expect(entry.default).toBe('en');
    expect(normalize(entry, 'es')).toBe('es'); expect(normalize(entry, 'invalid')).toBeUndefined();
  });
});
it('cycles only the supplied visible regions in both directions', () => {
  const regions = ['shell', 'editor', 'terminal', 'jobs'];
  expect(nextRegion(regions, 'jobs', false)).toBe('shell');
  expect(nextRegion(regions, 'shell', true)).toBe('jobs');
  expect(nextRegion(regions, 'chat', false)).toBe('shell');
  expect(nextRegion(['home'], 'home', true)).toBe('home');
  expect(nextRegion([], undefined, false)).toBeUndefined();
});
describe('performance measurements', () => {
  it('compares medians with a generous boundary', () => {
    expect(median([5, 1, 3, 100, 2])).toBe(3);
    expect(regressions({launch: 300}, {launch: 100})).toEqual([]);
    expect(regressions({launch: 301}, {launch: 100})).toEqual(['launch']);
    expect(exitCodeForRegressions(['launch'], false)).toBe(0);
    expect(exitCodeForRegressions([], true)).toBe(0);
    expect(exitCodeForRegressions(['launch'], true)).toBe(1);
    expect(() => median([NaN])).toThrow(); expect(() => regressions({launch: 1}, {})).toThrow();
  });
  it('requires a single matching document and completion type', () => {
    const events = [{event: 'open', file: '/a', type: 'geometry', ms: 20}, {event: 'open', file: '/b', type: 'model', ms: 30}];
    expect(sample(events, 'model', '/b', 0)).toBe(30);
    expect(() => sample(events, 'model', '/a', 0)).toThrow();
    expect(() => sample([...events, events[1]], 'model', '/b', 0)).toThrow();
    expect(sample([{event: 'interactive', end: 120}], 'launch', undefined, 100)).toBe(20);
  });
});
