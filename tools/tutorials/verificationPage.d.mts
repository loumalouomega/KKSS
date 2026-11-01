// Types for the verification page renderer (verificationPage.mjs).
export function loadReports(dir: string): Record<string, any>[];
export function renderTable(reports: Record<string, any>[]): string;
export function renderPage(markdown: string, reports: Record<string, any>[]): string;
