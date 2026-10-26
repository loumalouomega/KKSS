/**
 * Pure helpers for the ssh file provider: host validation, POSIX quoting, the
 * `host:/path` item ids and the parsers for `ls`/`stat` output. No `electron`,
 * no `child_process`, so `test/` imports it directly.
 *
 * Everything the remote shell sees goes through `shQuote` — a path is data,
 * never part of the command text.
 */
import type { CloudFile } from "../cloudCore";

/** An ssh alias or `user@host`. A leading `-` would be read as an option. */
const HOST = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/;

export function isValidHost(host: string): boolean {
  return host.length <= 253 && HOST.test(host);
}

/** Single-quotes `value` for a POSIX shell. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Item ids are `host:/abs/path`; an empty path means the login directory. */
export function encodeId(host: string, remotePath: string): string {
  return `${host}:${remotePath}`;
}

export function decodeId(id: string): { host: string; path: string } {
  const at = id.indexOf(":");
  if (at <= 0) throw new Error(`Not a remote item id: ${id}`);
  const host = id.slice(0, at);
  if (!isValidHost(host)) throw new Error(`Invalid remote host: ${host}`);
  return { host, path: id.slice(at + 1) };
}

export function joinRemote(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** Arguments for the local `ssh` binary. BatchMode: never prompt on a pipe. */
export function sshArgs(host: string, remoteCommand: string): string[] {
  if (!isValidHost(host)) throw new Error(`Invalid remote host: ${host}`);
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, remoteCommand];
}

/** Shell prefix that resolves a possibly-empty path: empty → login directory. */
function cdTo(dir: string): string {
  return dir ? `cd -- ${shQuote(dir)}` : "cd";
}

export function listCommand(dir: string): string {
  return `${cdTo(dir)} && pwd -P && LC_ALL=C ls -1Ap`;
}

export function statCommand(remotePath: string): string {
  const p = shQuote(remotePath);
  // GNU first, BSD/macOS as the fallback; both print `<kind>|<size>|<mtime>`.
  // LC_ALL=C: %F is a localised word ("directorio" on es_ES), and parseStat looks for "directory".
  return `LC_ALL=C stat -L -c '%F|%s|%Y' -- ${p} 2>/dev/null || LC_ALL=C stat -L -f '%HT|%z|%m' ${p}`;
}

export function downloadCommand(remotePath: string): string {
  return `cat -- ${shQuote(remotePath)}`;
}

/**
 * Writes stdin to a sibling temp file and renames it over the target, so a
 * dropped connection never leaves a half-written document. `cp -p` first
 * keeps the existing file's mode.
 */
export function uploadCommand(remotePath: string): string {
  return (
    `p=${shQuote(remotePath)}; t="$p.kkss-tmp.$$"; ` +
    `cp -p -- "$p" "$t" 2>/dev/null; ` +
    `cat > "$t" && mv -f -- "$t" "$p" || { rm -f -- "$t"; exit 1; }`
  );
}

export function mkdirCommand(remotePath: string): string {
  return `mkdir -p -- ${shQuote(remotePath)}`;
}

export interface StatInfo {
  isFolder: boolean;
  size: number;
  mtime: number;
}

export function parseStat(output: string): StatInfo | undefined {
  const line = output.trim().split("\n").pop() ?? "";
  const [kind, size, mtime] = line.split("|");
  const s = Number(size);
  const m = Number(mtime);
  if (!kind || !Number.isFinite(s) || !Number.isFinite(m)) return undefined;
  return { isFolder: /directory/i.test(kind), size: s, mtime: m };
}

/** The change token the sync engine compares. No wire precondition exists. */
export function revOf(info: StatInfo): string {
  return `${info.mtime}:${info.size}`;
}

export function fileFromStat(host: string, remotePath: string, info: StatInfo): CloudFile {
  const slash = remotePath.lastIndexOf("/");
  const name = remotePath.slice(slash + 1);
  const parent = slash > 0 ? remotePath.slice(0, slash) : "/";
  return {
    id: encodeId(host, remotePath),
    name,
    isFolder: info.isFolder,
    size: info.isFolder ? undefined : info.size,
    rev: info.isFolder ? undefined : revOf(info),
    modifiedAt: info.mtime * 1000,
    parentId: encodeId(host, parent),
  };
}

/** `pwd -P` line, then `ls -1Ap` rows (a trailing `/` marks a directory). */
export function parseList(host: string, output: string): { dir: string; files: CloudFile[] } {
  const lines = output.split("\n");
  const dir = (lines.shift() ?? "").trim();
  if (!dir.startsWith("/")) throw new Error("Unexpected listing from remote host.");
  const files: CloudFile[] = [];
  for (const raw of lines) {
    if (!raw) continue;
    const isFolder = raw.endsWith("/");
    const name = isFolder ? raw.slice(0, -1) : raw;
    if (!name) continue;
    files.push({
      id: encodeId(host, joinRemote(dir, name)),
      name,
      isFolder,
      parentId: encodeId(host, dir),
    });
  }
  files.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name));
  return { dir, files };
}

/**
 * The remote command that starts a uv-launched MCP server. A non-interactive
 * ssh session has a minimal PATH, so the usual uv install directories are
 * prepended; the spec is shell-quoted as one string, never interpolated.
 */
export function remoteUvxCommand(args: readonly string[]): string {
  const quoted = args.map(shQuote).join(" ");
  return `PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH" exec uvx ${quoted}`;
}

/** Ids that reach a remote shell script or JSON literal unquoted-safe. */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isSafeToken(value: string): boolean {
  return SAFE_TOKEN.test(value);
}

/**
 * The detached runner script a guided-workflow solve uploads beside its inputs.
 * It owns the remote receipt: `running` with its pid before the solver starts,
 * then a terminal state when the process exits. A `cancel` marker turns that
 * exit into `cancelled`. Process exit 0 is reported as `succeeded` with an
 * explicit note — convergence is never inferred from it.
 */
export function remoteRunScript(opts: {
  dir: string;
  requestId: string;
  ownerId: string;
  argv: readonly string[];
  env?: Readonly<Record<string, string>>;
}): string {
  if (!isSafeToken(opts.requestId) || !isSafeToken(opts.ownerId)) throw new Error("Unsafe request or owner id.");
  const envs = Object.entries(opts.env ?? {}).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid environment variable name: ${k}`);
    return `${k}=${shQuote(v)}`;
  });
  const head = `{"version":1,"requestId":"${opts.requestId}","ownerId":"${opts.ownerId}"`;
  return [
    "#!/bin/sh",
    // Survive the group TERM that cancels the solver, so the receipt gets written.
    "trap : TERM",
    // Absolute before the `cd` below: the run directory is relative to the login dir.
    `d=$(cd ${shQuote(opts.dir)} 2>/dev/null && pwd) || exit 1`,
    `w() { printf '%s\\n' "$1" > "$d/receipt.json.tmp" && mv -f "$d/receipt.json.tmp" "$d/receipt.json"; }`,
    `w '${head},"state":"running","pid":'$$'}'`,
    `cd "$d/input" || { w '${head},"state":"failed","message":"Input directory is missing."}'; exit 1; }`,
    `env ${envs.join(" ")} ${opts.argv.map(shQuote).join(" ")} > "$d/stdout.log" 2>&1`,
    "rc=$?",
    `if [ -e "$d/cancel" ]; then w '${head},"state":"cancelled","exitCode":'$rc'}'`,
    `elif [ $rc -eq 0 ]; then w '${head},"state":"succeeded","exitCode":0,"message":"Process exited 0; solver convergence is not established by exit status."}'`,
    `else w '${head},"state":"failed","exitCode":'$rc'}'; fi`,
    "",
  ].join("\n");
}

export const launchCommand = (dir: string): string =>
  `d=${shQuote(dir)}; rm -f -- "$d/cancel"; setsid nohup sh "$d/run.sh" >/dev/null 2>&1 </dev/null &`;
export const readReceiptCommand = (dir: string): string => `cat -- ${shQuote(`${dir}/receipt.json`)}`;
export const aliveCommand = (pid: number): string => {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid pid.");
  return `kill -0 ${pid}`;
};
/** Marks the run cancelled, then signals the runner's whole process group. */
export const cancelCommand = (dir: string, pid: number): string => {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid pid.");
  return `: > ${shQuote(`${dir}/cancel`)}; kill -TERM -${pid} 2>/dev/null || kill -TERM ${pid}`;
};

/**
 * Lists the files a remote solve produced: everything under `<dir>/input` newer
 * than the uploaded runner script, plus the captured log, as `<sha256>  <path>`
 * rows relative to `<dir>`. Uploaded inputs predate the script, so they are
 * not listed. GNU `sha256sum`, then BSD/macOS `shasum`.
 */
export const listOutputsCommand = (dir: string): string =>
  `cd -- ${shQuote(dir)} && { find input -type f -newer run.sh; [ -f stdout.log ] && echo stdout.log; } | ` +
  `while IFS= read -r f; do (sha256sum -- "$f" 2>/dev/null || shasum -a 256 -- "$f"); done`;

export interface OutputRow { sha256: string; path: string }
/** Rows with a traversal, absolute or control-character path are dropped. */
export function parseOutputs(output: string): OutputRow[] {
  const rows: OutputRow[] = [];
  for (const line of output.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) continue;
    const p = m[2];
    if (p.startsWith("/") || p.split("/").includes("..") || /[\u0000-\u001f]/.test(p)) continue;
    rows.push({ sha256: m[1], path: p });
  }
  return rows;
}
export const cpuCountCommand = (): string => "nproc 2>/dev/null || getconf _NPROCESSORS_ONLN";
export const kratosProbeCommand = (): string => "python3 -c 'import KratosMultiphysics'";
