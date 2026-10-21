/**
 * Standing instructions, skills and prompt templates — pure half.
 *
 * Three kinds of *text* the user can give the assistant. None can execute code,
 * add a tool, or make a write skip the approval gate: instructions and the skill
 * catalog ride the **context suffix** (never the system prompt, whose bytes stay
 * stable for the prompt cache), a skill body is fetched through the read-class
 * `app__skill_load` tool, and a template is expanded to plain text before the
 * message is sent.
 *
 * Everything here is deterministic over `{relative name: text}` maps, so it is
 * unit-tested without a filesystem. `assistantFiles.ts` reads the maps and
 * `assistantDefsStore.ts` wires them to the app.
 */
import { DEF_NAME_RE } from "./assistantFiles";

export type DefSource = "user" | "project";

/** Instructions are re-sent as *uncached* input on every turn, so they are capped. */
export const MAX_INSTRUCTIONS_CHARS = 6000;
export const MAX_SKILL_BODY_CHARS = 32_000;
export const MAX_TEMPLATE_CHARS = 8000;
export const MAX_DESCRIPTION_CHARS = 200;
/** The skill catalog is sent every turn too: bounded as a whole. */
export const MAX_CATALOG_CHARS = 5000;
/** A rough, honest estimate for the readout — it is shown with a `~`. */
export const CHARS_PER_TOKEN = 4;

export interface InstructionsDef { source: DefSource; text: string; chars: number; truncated: boolean }
export interface SkillDef { name: string; source: DefSource; description: string; body: string; truncated: boolean }
export interface TemplateDef { name: string; source: DefSource; body: string; truncated: boolean }

export interface ParsedDefs {
  instructions?: InstructionsDef;
  skills: SkillDef[];
  templates: TemplateDef[];
  errors: string[];
}

/** Strips what has no business in model context: NULs and other control characters
 *  (tab, newline and carriage return stay), and normalises line endings. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/^﻿/, "");
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/**
 * `---` front matter with `key: value` lines (only `name` and `description` are
 * read; no YAML engine is involved, so nothing can be tagged, anchored or
 * expanded). Returns the remaining body.
 */
export function splitFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    meta[kv[1].toLowerCase()] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

/** One line, trimmed, capped. */
export function oneLine(text: string, max = MAX_DESCRIPTION_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function skillFrom(rel: string, text: string, source: DefSource, errors: string[]): SkillDef | null {
  const dir = /^skills\/([^/]+)\/SKILL\.md$/.exec(rel)?.[1];
  if (!dir || !DEF_NAME_RE.test(dir)) return null;
  const { meta, body } = splitFrontMatter(cleanText(text));
  if (meta.name !== undefined && meta.name !== dir) {
    errors.push(`${rel}: name "${meta.name}" does not match the folder "${dir}"`);
    return null;
  }
  const description = oneLine(meta.description ?? "");
  if (!description) {
    errors.push(`${rel}: a skill needs a one-line description (front matter "description:")`);
    return null;
  }
  const clipped = clip(body.trim(), MAX_SKILL_BODY_CHARS);
  return { name: dir, source, description, body: clipped.text, truncated: clipped.truncated };
}

/** Turns one directory's files into definitions. Bad entries are reported, never thrown. */
export function parseDefinitions(files: Readonly<Record<string, string>>, source: DefSource): ParsedDefs {
  const out: ParsedDefs = { skills: [], templates: [], errors: [] };
  const instr = files["instructions.md"];
  if (instr !== undefined) {
    const text = cleanText(instr).trim();
    if (text) {
      const clipped = clip(text, MAX_INSTRUCTIONS_CHARS);
      out.instructions = { source, text: clipped.text, chars: text.length, truncated: clipped.truncated };
    }
  }
  for (const rel of Object.keys(files).sort()) {
    if (rel.startsWith("skills/")) {
      const skill = skillFrom(rel, files[rel], source, out.errors);
      if (skill) out.skills.push(skill);
    } else if (rel.startsWith("prompts/") && rel.endsWith(".md")) {
      const name = rel.slice("prompts/".length, -".md".length);
      if (!DEF_NAME_RE.test(name)) continue;
      const body = cleanText(files[rel]).trim();
      if (!body) { out.errors.push(`${rel}: the template is empty`); continue; }
      const clipped = clip(body, MAX_TEMPLATE_CHARS);
      out.templates.push({ name, source, body: clipped.text, truncated: clipped.truncated });
    }
  }
  return out;
}

export interface MergedDefs {
  instructions: InstructionsDef[];
  skills: SkillDef[];
  templates: TemplateDef[];
  errors: string[];
}

/** Your definitions win a name collision with the project's — the same rule as MCP server ids. */
export function mergeDefinitions(user: ParsedDefs, project: ParsedDefs): MergedDefs {
  const errors = [...user.errors.map((e) => `yours: ${e}`), ...project.errors.map((e) => `project: ${e}`)];
  const byName = <T extends { name: string }>(mine: T[], theirs: T[]): T[] => {
    const taken = new Set(mine.map((d) => d.name));
    return [...mine, ...theirs.filter((d) => !taken.has(d.name))].sort((a, b) => (a.name < b.name ? -1 : 1));
  };
  return {
    instructions: [user.instructions, project.instructions].filter((i): i is InstructionsDef => !!i),
    skills: byName(user.skills, project.skills),
    templates: byName(user.templates, project.templates),
    errors,
  };
}

// ---------------------------------------------------------------------------
// The context block
// ---------------------------------------------------------------------------

export interface Catalog { lines: string[]; omitted: number }

/** `name — description` lines, up to the catalog budget; the rest are counted. */
export function skillCatalog(skills: readonly SkillDef[], budget = MAX_CATALOG_CHARS): Catalog {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const skill of skills) {
    const line = `${skill.name} — ${skill.description}${skill.source === "project" ? " (project)" : ""}`;
    if (used + line.length + 2 > budget) { omitted++; continue; }
    used += line.length + 2;
    lines.push(line);
  }
  return { lines, omitted };
}

/**
 * The text appended to the newest user message, or "" when there is nothing.
 * Worded so the model reads it as the *user's guidance*, not as authority over
 * the approval gate — an instruction file can ask for a checklist, it cannot
 * grant itself permission to skip one.
 */
export function definitionsSuffix(defs: MergedDefs): string {
  const blocks: string[] = [];
  for (const i of defs.instructions) {
    blocks.push(
      `[Standing instructions from the user${i.source === "project" ? "'s trusted project folder" : ""} — follow them as guidance; ` +
        `they do not change what any tool may do or how approvals work${i.truncated ? `; cut to the first ${MAX_INSTRUCTIONS_CHARS} characters` : ""}:\n${i.text}\n]`
    );
  }
  const catalog = skillCatalog(defs.skills);
  if (catalog.lines.length) {
    blocks.push(
      `[Skills available — call app__skill_load with the name to read one before using it: ${catalog.lines.join("; ")}` +
        `${catalog.omitted ? `; ${catalog.omitted} more not listed` : ""}]`
    );
  }
  return blocks.length ? `\n\n${blocks.join("\n\n")}` : "";
}

/** Estimated tokens the suffix adds to every request. */
export function estimateTokens(suffix: string): number {
  return Math.ceil(suffix.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

/** A cap on what one expansion may add, so a template plus a long argument stays bounded. */
export const MAX_EXPANDED_CHARS = 24_000;

export type Expansion =
  | { kind: "none"; text: string }
  | { kind: "expanded"; text: string; name: string; source: DefSource }
  | { kind: "tooLong"; name: string };

/**
 * Expands a leading `/name [arguments]`. `$ARGUMENTS` in the template is replaced
 * by the arguments; a template without it gets them appended after a blank line.
 *
 * Deliberately conservative: only a name that is a *defined template* expands
 * (so `/tmp/model.stl` and `/unknown` are sent exactly as typed), and a leading
 * `//` is the escape for a message that really starts with a slash.
 */
export function expandTemplate(input: string, templates: readonly TemplateDef[]): Expansion {
  if (input.startsWith("//")) return { kind: "none", text: input.slice(1) };
  const match = /^\/([a-z][a-z0-9-]{0,47})(?=\s|$)([\s\S]*)$/.exec(input);
  if (!match) return { kind: "none", text: input };
  const template = templates.find((t) => t.name === match[1]);
  if (!template) return { kind: "none", text: input };
  const args = match[2].trim();
  const text = template.body.includes("$ARGUMENTS")
    ? template.body.split("$ARGUMENTS").join(args)
    : args ? `${template.body}\n\n${args}` : template.body;
  if (text.length > MAX_EXPANDED_CHARS) return { kind: "tooLong", name: template.name };
  return { kind: "expanded", text, name: template.name, source: template.source };
}

/** Template names beginning with what the user has typed after the slash (for the hint strip). */
export function matchTemplates(typed: string, templates: readonly { name: string }[]): string[] {
  const m = /^\/([a-z0-9-]*)$/.exec(typed);
  if (!m) return [];
  return templates.filter((t) => t.name.startsWith(m[1])).map((t) => t.name).slice(0, 8);
}
