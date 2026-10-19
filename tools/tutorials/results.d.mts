export const root: string;
export const publishedDir: string;
export const LAST_SHIPPED: string;
export function parseFrame(name: string): { family: string; index: number } | null;
export function groupFrames(names: string[]): Map<string, { name: string; index: number }[]>;
export function workingDirectoryFrom(output: string): string | null;
