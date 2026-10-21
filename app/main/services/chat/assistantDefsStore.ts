/**
 * Glue for standing instructions, skills and prompt templates: reads the user's
 * `<userData>/assistant` directory and, **only while the project folder is
 * trusted**, the project's `.kkss/assistant`, merges them (yours win a name
 * collision) and answers the four questions the rest of the app has:
 *
 * - what goes on the context suffix (`suffix`),
 * - what the sidebar shows (`summary`),
 * - what `app__skill_load` returns (`tools`),
 * - what `/name` expands to (`expand`).
 *
 * Reads are fresh on purpose — the files are a handful of small ones, and a
 * project file edited after trust must stop applying at once. `ChatService`
 * takes one `snapshot()` per user turn so the text is stable within a turn.
 * Electron-free (everything environmental is in `deps`) and unit-tested.
 */
import * as fs from "node:fs";
import type { AppTool } from "./appTools";
import type { ChatAssistantDefs } from "../../ipc";
import { readAssistantTree } from "./assistantFiles";
import {
  definitionsSuffix, estimateTokens, expandTemplate, matchTemplates, mergeDefinitions, parseDefinitions, skillCatalog,
  type Expansion, type MergedDefs,
} from "./assistantDefs";

export interface AssistantDefsDeps {
  /** `<userData>/assistant`. */
  userDir: string;
  /** Settings ▸ LLM Assistant ▸ standing definitions on/off. */
  enabled(): boolean;
  /** The project's definition files; empty unless the folder is trusted *right now*. */
  trustedProjectFiles(): Record<string, string>;
  /** Subscribe to project trust / root changes. */
  onProjectChange(listener: () => void): void;
}

const EMPTY: MergedDefs = { instructions: [], skills: [], templates: [], errors: [] };

export class AssistantDefsStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: AssistantDefsDeps) {
    deps.onProjectChange(() => this.emit());
  }

  onChange(listener: () => void): void { this.listeners.add(listener); }
  /** Something that can change what the sidebar shows (a setting, trust, a root). */
  emit(): void { for (const l of [...this.listeners]) l(); }

  enabled(): boolean { return this.deps.enabled(); }

  /** One consistent read of everything. Empty when the setting is off. */
  snapshot(): MergedDefs {
    if (!this.deps.enabled()) return EMPTY;
    const user = readAssistantTree(this.deps.userDir, null);
    const mine = parseDefinitions(user.files, "user");
    if (user.error) mine.errors.push(user.error);
    const project = parseDefinitions(this.deps.trustedProjectFiles(), "project");
    return mergeDefinitions(mine, project);
  }

  suffix(snapshot: MergedDefs = this.snapshot()): string {
    return definitionsSuffix(snapshot);
  }

  summary(snapshot: MergedDefs = this.snapshot()): ChatAssistantDefs {
    const catalog = skillCatalog(snapshot.skills);
    return {
      enabled: this.deps.enabled(),
      instructions: snapshot.instructions.map((i) => ({ source: i.source, chars: i.chars, truncated: i.truncated })),
      skills: snapshot.skills.map((s) => ({ name: s.name, source: s.source, description: s.description })),
      templates: snapshot.templates.map((t) => ({ name: t.name, source: t.source, preview: t.body.slice(0, 120) })),
      estimatedTokens: estimateTokens(definitionsSuffix(snapshot)),
      catalogOmitted: catalog.omitted,
      errors: snapshot.errors,
    };
  }

  expand(text: string): Expansion {
    return expandTemplate(text, this.snapshot().templates);
  }

  /** Template names for the composer's hint strip, matched against what is typed. */
  hints(typed: string): string[] {
    return matchTemplates(typed, this.snapshot().templates);
  }

  /** Creates the user's definitions directory (so "Open folder" has something to open). */
  ensureUserDir(): string {
    fs.mkdirSync(this.deps.userDir, { recursive: true });
    return this.deps.userDir;
  }

  /**
   * `app__skill_load` — read-class. Returns the skill's text only: it cannot run
   * anything, and anything in it that asks for a tool still goes through the gate.
   * A project skill is read from a fresh, trust-verified snapshot, so loading
   * cannot reach a file that was edited after the folder was trusted.
   */
  tools(): AppTool[] {
    return [{
      name: "app__skill_load",
      description:
        "Read one of the user's skills (a named set of instructions listed in the context as \"Skills available\") and follow it. " +
        "Returns its description and full text. Read-only: loading a skill never runs anything.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", minLength: 1, description: "The skill name exactly as listed." } },
        required: ["name"],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!this.deps.enabled()) throw new Error("Standing instructions and skills are switched off in Settings ▸ LLM Assistant.");
        const skill = this.snapshot().skills.find((s) => s.name === name);
        if (!skill) throw new Error(`No skill named "${name}". Use a name from the "Skills available" list in the context.`);
        return { name: skill.name, source: skill.source, description: skill.description, text: skill.body, ...(skill.truncated ? { truncated: true } : {}) };
      },
    }];
  }
}
