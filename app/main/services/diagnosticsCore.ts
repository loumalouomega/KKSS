// Help ▸ Export Diagnostics… — the pure half (roadmap item 23). Builds the
// file list, redacts paths and secrets, and writes a store-only zip. Nothing
// here transmits anything; the manifest lists every file the bundle holds.
import type { SettingEntry } from "./settings/registry";

export interface Redaction { home?: string; tmp?: string; user?: string }

/** Replace home/temp paths (both slash styles) with placeholders. */
export function redactPaths(text: string, r: Redaction): string {
  let out = text;
  const sub = (value: string | undefined, token: string) => {
    if (!value || value.length < 3) return;
    for (const form of new Set([value, value.replace(/\\/g, "/"), value.replace(/\//g, "\\")])) {
      out = out.split(form).join(token);
    }
  };
  sub(r.home, "<HOME>");
  sub(r.tmp, "<TMP>");
  return out;
}

/** Settings as `{id: value}`; a secret is reduced to `{isSet}` and never read. */
export function redactSettings(
  entries: readonly SettingEntry[],
  value: (e: SettingEntry) => unknown,
  isSecretSet: (e: SettingEntry) => boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of entries) {
    if (e.type === "action") continue;
    out[e.id] = e.type === "secret" ? { isSet: isSecretSet(e) } : value(e);
  }
  return out;
}

export interface DiagnosticFile { name: string; data: Uint8Array }

const enc = new TextEncoder();
export const textFile = (name: string, text: string): DiagnosticFile => ({ name, data: enc.encode(text) });

/** Bundle manifest first: every other file, its size, and the statement that nothing is sent. */
export function buildBundle(files: DiagnosticFile[], generated: string): DiagnosticFile[] {
  const manifest = {
    generated,
    transmitted: false,
    note: "Written locally at your request. Review before sharing; home and temporary paths are replaced by placeholders.",
    files: files.map((f) => ({ name: f.name, bytes: f.data.length })),
  };
  return [textFile("manifest.json", JSON.stringify(manifest, null, 2)), ...files];
}

let table: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal store-only (uncompressed) zip; names must be ASCII-safe relative paths. */
export function zipStore(files: DiagnosticFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    if (f.name.startsWith("/") || f.name.split("/").includes("..")) throw new Error(`Unsafe name: ${f.name}`);
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true); local.setUint32(18, f.data.length, true); local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    const head = new Uint8Array(local.buffer);
    parts.push(head, name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += head.length + name.length + f.data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
