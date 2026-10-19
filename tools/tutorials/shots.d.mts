// Types for the screenshot catalog (shots.mjs), so the TypeScript tests can import it.
export type Producer = 'manual' | 'gallery' | 'plot' | 'animation' | 'legacy';

export interface Shot {
  file: string;
  case: string;
  producer: Producer;
  field?: string;
  recipe?: string;
  participant?: string;
  frame?: 'last' | 'middle' | number;
  range?: [number, number];
  view?: string;
  modes?: string[];
  clip?: { axis: string; pos: number };
  bar?: boolean;
  [key: string]: unknown;
}

export const CATALOG: Shot[];
export function forCase(caseId: string): Shot[];
export function catalogFiles(): string[];
