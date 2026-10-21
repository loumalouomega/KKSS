/**
 * Reads an `assistant/` definition directory — the user's `<userData>/assistant`
 * or a project's `.kkss/assistant` — into a flat `{relative name: text}` map.
 *
 * Layout (the same in both places):
 *   mcp.json                 MCP servers (userServers.ts)
 *   instructions.md          standing instructions
 *   skills/<name>/SKILL.md   skills
 *   prompts/<name>.md        prompt templates
 *
 * The map is what the folder-trust hash covers (`hashDefinitions`), so a file
 * that can influence the assistant must be listed here or it is invisible to
 * trust. Electron-free (node:fs only) so it is unit-tested against a temp dir.
 *
 * A project folder is untrusted input: every file must be an ordinary file
 * physically inside the root (`confine`), directories must not be symlinks, and
 * counts and sizes are capped. Anything unsafe makes the **whole read fail** —
 * the caller reports it and loads nothing — rather than loading around it. The
 * user's own directory passes `confine: null` and may use symlinks (a dotfiles
 * repo), but still only reads regular files.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_DEFINITION_BYTES } from "./userServers";

export const MAX_SKILLS = 64;
export const MAX_TEMPLATES = 64;
/** A skill or template name: what `/name` and `app__skill_load` accept. */
export const DEF_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;

export interface TreeRead {
  files: Record<string, string>;
  /** Set when anything unsafe was found: `files` is then empty. */
  error?: string;
}

function inside(real: string, root: string): boolean {
  return real === root || real.startsWith(root + path.sep);
}

class Unsafe extends Error {}

function readFile(file: string, label: string, confine: string | null): string | undefined {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch { return undefined; } // absent is fine
  if (confine !== null) {
    // A symlink could point a "project file" at anything on disk.
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Unsafe(`${label} is not a regular file`);
    const real = fs.realpathSync(file);
    if (!inside(real, confine)) throw new Unsafe(`${label} resolves outside the project folder`);
    if (stat.size > MAX_DEFINITION_BYTES) throw new Unsafe(`${label} is larger than ${MAX_DEFINITION_BYTES / 1024} KB`);
    return fs.readFileSync(real, "utf8");
  }
  const real = fs.statSync(file); // follows links: the user's own directory
  if (!real.isFile()) throw new Unsafe(`${label} is not a regular file`);
  if (real.size > MAX_DEFINITION_BYTES) throw new Unsafe(`${label} is larger than ${MAX_DEFINITION_BYTES / 1024} KB`);
  return fs.readFileSync(file, "utf8");
}

function listDir(dir: string, label: string, confine: string | null): fs.Dirent[] {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(dir); } catch { return []; }
  if (confine !== null) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Unsafe(`${label} is not a regular directory`);
    if (!inside(fs.realpathSync(dir), confine)) throw new Unsafe(`${label} resolves outside the project folder`);
  } else if (!fs.statSync(dir).isDirectory()) {
    throw new Unsafe(`${label} is not a directory`);
  }
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function readAssistantTree(base: string, confine: string | null): TreeRead {
  const files: Record<string, string> = {};
  try {
    // The directory itself must pass the same test as what is in it.
    listDir(base, ".kkss/assistant", confine);
    for (const name of ["mcp.json", "instructions.md"]) {
      const text = readFile(path.join(base, name), name, confine);
      if (text !== undefined) files[name] = text;
    }
    let skills = 0;
    for (const entry of listDir(path.join(base, "skills"), "skills", confine)) {
      if (!DEF_NAME_RE.test(entry.name)) continue;
      const rel = `skills/${entry.name}/SKILL.md`;
      // A symlinked skill directory is the thing `confine` exists to refuse.
      if (confine !== null && entry.isSymbolicLink()) throw new Unsafe(`skills/${entry.name} is a symlink`);
      if (confine === null ? !fs.statSync(path.join(base, "skills", entry.name)).isDirectory() : !entry.isDirectory()) continue;
      const text = readFile(path.join(base, "skills", entry.name, "SKILL.md"), rel, confine);
      if (text === undefined) continue;
      if (++skills > MAX_SKILLS) throw new Unsafe(`more than ${MAX_SKILLS} skills`);
      files[rel] = text;
    }
    let prompts = 0;
    for (const entry of listDir(path.join(base, "prompts"), "prompts", confine)) {
      if (!entry.name.endsWith(".md") || !DEF_NAME_RE.test(entry.name.slice(0, -3))) continue;
      const rel = `prompts/${entry.name}`;
      if (confine !== null && entry.isSymbolicLink()) throw new Unsafe(`${rel} is a symlink`);
      const text = readFile(path.join(base, "prompts", entry.name), rel, confine);
      if (text === undefined) continue;
      if (++prompts > MAX_TEMPLATES) throw new Unsafe(`more than ${MAX_TEMPLATES} prompt templates`);
      files[rel] = text;
    }
  } catch (error) {
    if (error instanceof Unsafe) return { files: {}, error: error.message };
    throw error;
  }
  return { files };
}
