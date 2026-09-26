export interface FormatCounts {
  read: number;
  write: number;
  readExtensions: string[];
  writeExtensions: string[];
}
export function parseFormatCounts(source: string): FormatCounts;
export function readRoutingRegistry(root?: string): { counts: FormatCounts; suffixes: Set<string> };
export function checkFormatDocumentation(source: string, counts: FormatCounts, file: string): void;
