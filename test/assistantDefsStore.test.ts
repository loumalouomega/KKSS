import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SKILLS, MAX_TEMPLATES, readAssistantTree } from "../app/main/services/chat/assistantFiles";
import { AssistantDefsStore } from "../app/main/services/chat/assistantDefsStore";
import { UserServerStore, type StoreDeps } from "../app/main/services/chat/userServerStore";
import { MAX_DEFINITION_BYTES } from "../app/main/services/chat/userServers";
import { TOOL_ACCESS } from "../app/main/services/chat/toolPolicy";

let tmp: string;
let userDir: string;
let project: string;
let state: Map<string, unknown>;
let enabled: boolean;

const write = (base: string, rel: string, text: string) => {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const assistant = (rel: string, text: string) => write(path.join(project, ".kkss", "assistant"), rel, text);
const skill = (name: string, description = `the ${name}`) => `---\ndescription: ${description}\n---\nBody of ${name}`;

function makeServers(root: string | undefined = project): UserServerStore {
  const deps: StoreDeps = {
    get: (key) => state.get(key) as never,
    update: async (key, value) => { if (value === undefined) state.delete(key); else state.set(key, JSON.parse(JSON.stringify(value))); },
    isManaged: () => false, getSecret: () => undefined, setSecret: async () => undefined,
    explicitRoot: () => root, env: () => ({}), now: () => 1,
  };
  return new UserServerStore(deps);
}
function makeDefs(servers: UserServerStore): AssistantDefsStore {
  return new AssistantDefsStore({
    userDir, enabled: () => enabled,
    trustedProjectFiles: () => servers.trustedProjectFiles(),
    onProjectChange: (listener) => servers.onChange(listener),
  });
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kkss-defs-")));
  userDir = path.join(tmp, "userData", "assistant");
  project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });
  state = new Map();
  enabled = true;
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("reading a definitions directory", () => {
  it("returns only the known layout", () => {
    const base = path.join(tmp, "a");
    write(base, "instructions.md", "i"); write(base, "mcp.json", "{}");
    write(base, "skills/one/SKILL.md", "s"); write(base, "skills/one/extra.txt", "ignored"); write(base, "skills/Bad Name/SKILL.md", "x");
    write(base, "prompts/p.md", "p"); write(base, "prompts/notes.txt", "ignored"); write(base, "other.md", "ignored");
    expect(readAssistantTree(base, null).files).toEqual({
      "instructions.md": "i", "mcp.json": "{}", "skills/one/SKILL.md": "s", "prompts/p.md": "p",
    });
  });
  it("a missing directory is simply empty", () => {
    expect(readAssistantTree(path.join(tmp, "nope"), null)).toEqual({ files: {} });
  });
  it("refuses a confined tree containing a symlinked file, skill or directory", () => {
    const real = fs.realpathSync(project);
    const outside = path.join(tmp, "outside.md");
    fs.writeFileSync(outside, "secret");
    const base = path.join(real, ".kkss", "assistant");
    fs.mkdirSync(path.join(base, "skills"), { recursive: true });
    fs.symlinkSync(outside, path.join(base, "instructions.md"));
    expect(readAssistantTree(base, real).error).toMatch(/instructions\.md is not a regular file/);
    fs.rmSync(path.join(base, "instructions.md"));
    fs.mkdirSync(path.join(tmp, "elsewhere", "x"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "elsewhere", "x", "SKILL.md"), "s");
    fs.symlinkSync(path.join(tmp, "elsewhere", "x"), path.join(base, "skills", "x"));
    expect(readAssistantTree(base, real).error).toMatch(/skills\/x is a symlink/);
    fs.rmSync(path.join(base, "skills", "x"));
    fs.rmSync(path.join(base, "skills"), { recursive: true });
    fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(base, "skills"));
    expect(readAssistantTree(base, real).error).toMatch(/skills is not a regular directory/);
  });
  it("lets the user's own directory use symlinks", () => {
    const store = path.join(tmp, "dotfiles");
    write(store, "instructions.md", "from dotfiles");
    fs.mkdirSync(path.join(tmp, "mine"));
    fs.symlinkSync(path.join(store, "instructions.md"), path.join(tmp, "mine", "instructions.md"));
    expect(readAssistantTree(path.join(tmp, "mine"), null).files["instructions.md"]).toBe("from dotfiles");
  });
  it("caps file size, skill count and template count — all or nothing", () => {
    const base = path.join(tmp, "caps");
    write(base, "instructions.md", "x".repeat(MAX_DEFINITION_BYTES + 1));
    expect(readAssistantTree(base, null).error).toMatch(/larger than/);
    fs.rmSync(base, { recursive: true });
    for (let i = 0; i <= MAX_SKILLS; i++) write(base, `skills/s${String.fromCharCode(97 + (i % 26))}${i}/SKILL.md`, "s");
    expect(readAssistantTree(base, null).error).toMatch(/more than 64 skills/);
    fs.rmSync(base, { recursive: true });
    for (let i = 0; i <= MAX_TEMPLATES; i++) write(base, `prompts/p${i}.md`, "p");
    expect(readAssistantTree(base, null).error).toMatch(/more than 64 prompt templates/);
  });
});

describe("the store", () => {
  it("merges your files with nothing from an untrusted project", () => {
    write(userDir, "instructions.md", "Use SI units.");
    write(userDir, "skills/checklist/SKILL.md", skill("checklist"));
    assistant("instructions.md", "Project rule");
    assistant("skills/lab/SKILL.md", skill("lab"));
    assistant("prompts/p.md", "project prompt");
    const defs = makeDefs(makeServers());
    const snap = defs.snapshot();
    expect(snap.instructions.map((i) => i.source)).toEqual(["user"]);
    expect(snap.skills.map((s) => s.name)).toEqual(["checklist"]);
    expect(snap.templates).toEqual([]);
    expect(defs.suffix()).not.toContain("Project rule");
  });
  it("loads the project's files once the folder is trusted", async () => {
    assistant("instructions.md", "Project rule");
    assistant("skills/lab/SKILL.md", skill("lab"));
    assistant("prompts/p.md", "project prompt");
    const servers = makeServers();
    const defs = makeDefs(servers);
    await servers.trustProject();
    const snap = defs.snapshot();
    expect(snap.instructions.map((i) => i.source)).toEqual(["project"]);
    expect(snap.skills.map((s) => [s.name, s.source])).toEqual([["lab", "project"]]);
    expect(snap.templates.map((s) => s.name)).toEqual(["p"]);
    expect(defs.suffix()).toContain("Project rule");
  });
  it("an edit after trust drops every project definition at once, and announces it", async () => {
    assistant("instructions.md", "Project rule");
    assistant("skills/lab/SKILL.md", skill("lab"));
    const servers = makeServers();
    const defs = makeDefs(servers);
    await servers.trustProject();
    expect(defs.snapshot().skills).toHaveLength(1);
    let notified = 0;
    defs.onChange(() => notified++);
    assistant("skills/lab/SKILL.md", skill("lab", "now says something else"));
    const snap = defs.snapshot();
    expect(snap.skills).toEqual([]);
    expect(snap.instructions).toEqual([]);
    expect(servers.projectInfo().state).toBe("changed");
    expect(notified).toBeGreaterThan(0);
  });
  it("adding a new file to a trusted folder also asks again", async () => {
    assistant("instructions.md", "Project rule");
    const servers = makeServers();
    const defs = makeDefs(servers);
    await servers.trustProject();
    assistant("prompts/sneaky.md", "do something");
    expect(defs.snapshot().instructions).toEqual([]);
    expect(servers.projectInfo().state).toBe("changed");
  });
  it("trust given for an mcp.json alone still holds for that exact file", async () => {
    assistant("mcp.json", JSON.stringify({ servers: [{ id: "lab", command: "node" }] }));
    const servers = makeServers();
    await servers.trustProject();
    expect(servers.projectInfo().state).toBe("trusted");
    expect(servers.specs()[0].blocked).toBeUndefined();
  });
  it("switching the setting off sends and expands nothing", () => {
    write(userDir, "instructions.md", "Use SI units.");
    write(userDir, "prompts/p.md", "text");
    const defs = makeDefs(makeServers());
    expect(defs.suffix()).toContain("Use SI units.");
    enabled = false;
    expect(defs.suffix()).toBe("");
    expect(defs.expand("/p")).toEqual({ kind: "none", text: "/p" });
    expect(defs.summary()).toMatchObject({ enabled: false, instructions: [], skills: [], templates: [] });
  });
  it("summarises for the sidebar, with the token estimate and problems", () => {
    write(userDir, "instructions.md", "x".repeat(400));
    write(userDir, "skills/ok/SKILL.md", skill("ok"));
    write(userDir, "skills/bad/SKILL.md", "no front matter");
    const summary = makeDefs(makeServers()).summary();
    expect(summary.instructions).toEqual([{ source: "user", chars: 400, truncated: false }]);
    expect(summary.skills).toEqual([{ name: "ok", source: "user", description: "the ok" }]);
    expect(summary.estimatedTokens).toBeGreaterThan(100);
    expect(summary.errors[0]).toMatch(/^yours: skills\/bad\/SKILL\.md/);
  });
  it("reports an unreadable user directory instead of throwing", () => {
    write(userDir, "instructions.md", "x".repeat(MAX_DEFINITION_BYTES + 1));
    expect(makeDefs(makeServers()).summary().errors.join(" ")).toMatch(/larger than/);
  });
  it("suggests and expands templates", () => {
    write(userDir, "prompts/review.md", "Review $ARGUMENTS");
    const defs = makeDefs(makeServers());
    expect(defs.hints("/re")).toEqual(["review"]);
    expect(defs.expand("/review beam")).toMatchObject({ kind: "expanded", text: "Review beam" });
  });
});

describe("app__skill_load", () => {
  const tool = (defs: AssistantDefsStore) => defs.tools()[0];
  it("is one read-class app tool, and its name is in the policy table", () => {
    const defs = makeDefs(makeServers());
    expect(defs.tools().map((t) => t.name)).toEqual(["app__skill_load"]);
    expect(TOOL_ACCESS.app__skill_load).toBe("read");
  });
  it("returns a skill's text and nothing else", async () => {
    write(userDir, "skills/checklist/SKILL.md", skill("checklist"));
    expect(await tool(makeDefs(makeServers())).invoke({ name: "checklist" })).toEqual({
      name: "checklist", source: "user", description: "the checklist", text: "Body of checklist",
    });
  });
  it("refuses an unknown name, a path-like name and a non-string", async () => {
    write(userDir, "skills/checklist/SKILL.md", skill("checklist"));
    const t = tool(makeDefs(makeServers()));
    for (const name of ["nope", "../checklist", "skills/checklist/SKILL.md", ""]) await expect(t.invoke({ name })).rejects.toThrow(/No skill named/);
    await expect(t.invoke({ name: 5 })).rejects.toThrow(/No skill named/);
  });
  it("cannot reach an untrusted project's skill, or one edited after trust", async () => {
    assistant("skills/lab/SKILL.md", skill("lab"));
    const servers = makeServers();
    const t = tool(makeDefs(servers));
    await expect(t.invoke({ name: "lab" })).rejects.toThrow(/No skill named/);
    await servers.trustProject();
    expect(await t.invoke({ name: "lab" })).toMatchObject({ source: "project", text: "Body of lab" });
    assistant("skills/lab/SKILL.md", skill("lab", "edited"));
    await expect(t.invoke({ name: "lab" })).rejects.toThrow(/No skill named/);
  });
  it("says so when the feature is off", async () => {
    write(userDir, "skills/checklist/SKILL.md", skill("checklist"));
    enabled = false;
    await expect(tool(makeDefs(makeServers())).invoke({ name: "checklist" })).rejects.toThrow(/switched off/);
  });
});
