// Generated reference tables for doc/guide/configuration.md. Pure: takes the
// registry rows and the policy tables as arguments so a test can render the
// same islands the page holds and fail when they drift (roadmap item 16).
import type { SettingEntry } from "./settings/registry";

export const REFERENCE_ISLANDS = ["settings-reference", "tool-reference"] as const;
export type ReferenceIsland = (typeof REFERENCE_ISLANDS)[number];

export const referenceMarkers = (name: ReferenceIsland) => ({
  begin: `<!-- reference:${name}:begin -->`,
  end: `<!-- reference:${name}:end -->`,
});

const cell = (text: unknown) => String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
const code = (text: unknown) => "`" + String(text).replace(/`/g, "'") + "`";

function defaultText(entry: SettingEntry): string {
  const d = entry.default;
  if (d === undefined) return "—";
  if (Array.isArray(d)) return d.length ? code(JSON.stringify(d)) : "empty";
  if (typeof d === "object") return Object.keys(d).length ? code(JSON.stringify(d)) : "empty";
  return d === "" ? "empty" : code(d);
}

/** One table per category, in registry order. Secrets show no value, only that they are stored. */
export function settingsReference(entries: readonly SettingEntry[], categories: readonly string[]): string {
  const out: string[] = [];
  for (const category of categories) {
    const rows = entries.filter((e) => e.category === category);
    if (!rows.length) continue;
    out.push(`#### ${category}`, "", "| Setting | Id | Type | Default | Applies | Store key |", "| --- | --- | --- | --- | --- | --- |");
    for (const e of rows) {
      const type = e.enum ? `one of ${e.enum.map((v) => code(v)).join(", ")}` : e.type;
      out.push(`| ${cell(e.label)} | ${code(e.id)} | ${cell(type)} | ${e.type === "secret" ? "—" : defaultText(e)} | ${e.applies ?? "—"} | ${e.storeKey ? code(e.storeKey) : "—"} |`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/** Tool name → class, grouped by the namespace before `__`; `scoped` marks project-folder grants. */
export function toolReference(access: Readonly<Record<string, string>>, scoped: Readonly<Record<string, readonly string[]>>): string {
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(access).sort()) {
    const ns = name.split("__")[0];
    (groups.get(ns) ?? groups.set(ns, []).get(ns)!).push(name);
  }
  const out: string[] = ["| Server | Tools | Read | Write | Path-scoped |", "| --- | --- | --- | --- | --- |"];
  for (const [ns, names] of groups) {
    out.push(`| ${code(ns)} | ${names.length} | ${names.filter((n) => access[n] === "read").length} | ${names.filter((n) => access[n] === "write").length} | ${names.filter((n) => scoped[n]).length} |`);
  }
  out.push("");
  for (const [ns, names] of groups) {
    out.push(`<details><summary><code>${ns}</code> (${names.length})</summary>`, "", "| Tool | Class | Project-folder grant |", "| --- | --- | --- |");
    for (const n of names) out.push(`| ${code(n)} | ${access[n]} | ${scoped[n] ? "paths: " + scoped[n].map((p) => code(p)).join(", ") : "—"} |`);
    out.push("", "</details>", "");
  }
  return out.join("\n").trimEnd();
}

/** Replace the text between an island's markers; throws when the markers are missing. */
export function replaceIsland(page: string, name: ReferenceIsland, body: string): string {
  const { begin, end } = referenceMarkers(name);
  const a = page.indexOf(begin), b = page.indexOf(end);
  if (a < 0 || b < a) throw new Error(`Island ${name} markers missing`);
  return `${page.slice(0, a + begin.length)}\n\n${body}\n\n${page.slice(b)}`;
}
