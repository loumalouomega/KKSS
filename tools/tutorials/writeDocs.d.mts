// Types for the tutorial page renderer (writeDocs.mjs).
export const PAGES: Record<string, string>;
export function renderPage(id: string, markdown: string): string;
export function renderAll(): { id: string; target: string; after: string }[];
