/**
 * Launch requests that name a tutorial example instead of a file:
 * `kkss --example <id> [--into <folder>]` and `kkss://open?example=<id>`.
 * Electron-free so `test/` imports it directly; the id is only parsed here, it
 * is resolved against the catalogue (`services/examplesCore.ts`) when handled.
 */

export interface ExampleRequest {
  id: string;
  /** Absolute destination folder; absent means the app picks (link: asks, command line: a fresh folder). */
  into?: string;
  /** A link always asks for the folder; a command-line launch without `into` uses a fresh one. */
  source: "link" | "cli";
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `kkss://open?example=<id>`; a link never names a folder, so `into` is always absent. */
export function exampleFromUrl(value: string): ExampleRequest | undefined {
  try {
    if (!/^kkss:/i.test(value) || /%(?![0-9a-f]{2})/i.test(value)) return undefined;
    const url = new URL(value);
    if (url.protocol !== "kkss:" || url.hostname !== "open" || url.port || url.username || url.password ||
        (url.pathname !== "" && url.pathname !== "/") || url.hash ||
        [...url.searchParams.keys()].some(key => key !== "example") || url.searchParams.getAll("example").length !== 1) return undefined;
    const id = url.searchParams.get("example")!;
    return ID.test(id) ? { id, source: "link" } : undefined;
  } catch { return undefined; }
}

/** The values consumed by `--example` and `--into`, so the file parser does not read them as paths. */
export function exampleArgIndexes(args: readonly string[]): Set<number> {
  const taken = new Set<number>();
  args.forEach((arg, i) => {
    const name = arg.split("=", 1)[0];
    if ((name === "--example" || name === "--into") && !arg.includes("=") && i + 1 < args.length) taken.add(i + 1);
  });
  return taken;
}

/** Every example request in a command line (`--example` may repeat; one `--into` applies to every `--example`; a link never takes it). An id that is not well formed is kept as given so the answer can name it. */
export function launchExamples(argv: readonly string[], packaged: boolean, cwd: string, resolve: (cwd: string, p: string) => string): ExampleRequest[] {
  const args = argv.slice(packaged ? 1 : 2);
  const value = (i: number): string | undefined => {
    const arg = args[i];
    const eq = arg.indexOf("=");
    return eq > 0 ? arg.slice(eq + 1) : args[i + 1];
  };
  const requests: ExampleRequest[] = [];
  const cli: ExampleRequest[] = [];
  let into: string | undefined;
  args.forEach((arg, i) => {
    const name = arg.split("=", 1)[0];
    if (name === "--into") { const v = value(i); if (v && !v.startsWith("-") && !v.includes("\0")) into = resolve(cwd, v); }
    else if (name === "--example") { const v = value(i); cli.push({ id: v ?? "", source: "cli" }); requests.push(cli[cli.length - 1]); }
    else { const url = exampleFromUrl(arg); if (url) requests.push(url); }
  });
  // `--into` belongs to the command line only: a link always asks for the folder.
  if (into) for (const r of cli) r.into = into;
  return requests;
}

/** Same shape as `LaunchQueue`: requests arriving before the window is ready are held, in order. */
export class ExampleQueue {
  private pending: ExampleRequest[] = [];
  private handler?: (request: ExampleRequest) => void;
  get size(): number { return this.pending.length; }
  enqueue(requests: readonly ExampleRequest[]): void {
    for (const r of requests) { if (this.handler) this.handler(r); else this.pending.push(r); }
  }
  ready(handler: (request: ExampleRequest) => void): void {
    this.handler = handler;
    const held = this.pending; this.pending = [];
    held.forEach(handler);
  }
}
