// Types for the generated tutorial-page islands (docIslands.mjs).
export const ISLAND_NAMES: readonly string[];
export const KRATOS_PACKAGES: Record<string, string[]>;
export const KRATOS_VERSION: string;
export const UNPINNED_PACKAGES: string[];
export function islandMarkers(name: string): { begin: string; end: string };
export function limitText(check: unknown): string;
export function checkRows(checks?: Record<string, unknown>): { name: string; measured: string; limit: string }[];
export function verifiedIsland(report: Record<string, unknown>): string;
export function glanceIsland(report: Record<string, unknown>, options: { id: string; download?: string }): string;
export function replaceIsland(markdown: string, name: string, body: string): string;
export function islandsIn(markdown: string): string[];
