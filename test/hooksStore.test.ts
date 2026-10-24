/**
 * HookEngine against real files, real folder trust and real child processes:
 * the decisions in hooks.test.ts are pure; this pins that they are applied to
 * the right hooks, in the right order, from the right (trusted) places.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookEngine } from "../app/main/services/chat/hooksStore";
import { UserServerStore, type StoreDeps } from "../app/main/services/chat/userServerStore";
import { MAX_DEFINITION_BYTES } from "../app/main/services/chat/userServers";
import type { HookContext, HookEvent } from "../app/main/services/chat/hooks";

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
/** A hook that runs `script` under node. */
const node = (name: string, event: HookEvent, script: string, extra: Record<string, unknown> = {}) =>
  ({ name, event, command: process.execPath, args: ["-e", script], ...extra });
const hooksFile = (...hooks: unknown[]) => JSON.stringify({ hooks });
const userHooks = (...hooks: unknown[]) => write(userDir, "hooks.json", hooksFile(...hooks));
const projectHooks = (...hooks: unknown[]) => write(path.join(project, ".kkss", "assistant"), "hooks.json", hooksFile(...hooks));
const ctx = (extra: Partial<HookContext> = {}): HookContext => ({ source: "chat", conversationId: "c1", tool: "kratos__run_simulation", args: {}, ...extra });
/** Appends a line to `marks.txt` so a test can see which hooks actually ran. */
const mark = (what: string) => `require('fs').appendFileSync(${JSON.stringify(path.join(tmp, "marks.txt"))},${JSON.stringify(what + "\n")})`;
const marks = () => (fs.existsSync(path.join(tmp, "marks.txt")) ? fs.readFileSync(path.join(tmp, "marks.txt"), "utf8").trim().split("\n") : []);

function makeServers(): UserServerStore {
  const deps: StoreDeps = {
    get: (key) => state.get(key) as never,
    update: async (key, value) => { if (value === undefined) state.delete(key); else state.set(key, JSON.parse(JSON.stringify(value))); },
    isManaged: () => false, getSecret: () => undefined, setSecret: async () => undefined,
    explicitRoot: () => project, env: () => ({}), now: () => 1,
  };
  return new UserServerStore(deps);
}
function makeEngine(servers = makeServers(), log: string[] = []): HookEngine {
  return new HookEngine({
    userDir,
    enabled: () => enabled,
    trustedProjectFiles: () => servers.trustedProjectFiles(),
    onProjectChange: (listener) => servers.onChange(listener),
    projectRoot: () => project,
    baseEnv: () => ({ PATH: process.env.PATH ?? "" }),
    log: (message) => log.push(message),
  });
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kkss-hooks-")));
  userDir = path.join(tmp, "userData", "assistant");
  project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });
  state = new Map();
  enabled = true;
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("running hooks", () => {
  it("exit 2 denies with stderr as the reason, and 0 is no opinion", async () => {
    userHooks(node("gate", "PreToolUse", "process.stderr.write('outside the study folder');process.exit(2)"));
    expect(await makeEngine().run("PreToolUse", ctx())).toMatchObject({ verdict: "deny", hook: "gate", reason: "outside the study folder" });
    userHooks(node("gate", "PreToolUse", "process.exit(0)"));
    expect(await makeEngine().run("PreToolUse", ctx())).toEqual({ verdict: "none", notes: [] });
  });

  it("exit 3 asks", async () => {
    userHooks(node("gate", "PreToolUse", "process.stderr.write('look at the args');process.exit(3)"));
    expect(await makeEngine().run("PreToolUse", ctx())).toMatchObject({ verdict: "ask", hook: "gate", reason: "look at the args" });
  });

  it("a crashing, timing-out or missing PreToolUse hook denies; an observer that does is only logged", async () => {
    userHooks({ name: "missing", event: "PreToolUse", command: "kkss-no-such-program" });
    expect(await makeEngine().run("PreToolUse", ctx())).toMatchObject({ verdict: "deny", hook: "missing", reason: expect.stringContaining("could not start") });
    userHooks(node("slow", "PreToolUse", "setInterval(()=>{},1000)", { timeoutMs: 300 }));
    expect(await makeEngine().run("PreToolUse", ctx())).toMatchObject({ verdict: "deny", hook: "slow", reason: "the hook timed out" });
    userHooks(node("exit-1", "PreToolUse", "process.exit(1)"));
    expect((await makeEngine().run("PreToolUse", ctx())).verdict).toBe("deny");

    const log: string[] = [];
    userHooks(node("audit", "PostToolUse", "process.exit(1)"), node("end", "TurnEnd", "process.exit(7)"));
    const engine = makeEngine(makeServers(), log);
    expect((await engine.run("PostToolUse", ctx())).verdict).toBe("none");
    expect((await engine.run("TurnEnd", ctx())).verdict).toBe("none");
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/audit.*PostToolUse.*exited with code 1/);
  });

  it("stops at the first deny, so later hooks never see a refused call", async () => {
    userHooks(
      node("first", "PreToolUse", `${mark("first")};process.stderr.write('no');process.exit(2)`),
      node("second", "PreToolUse", `${mark("second")};process.exit(0)`),
    );
    expect(await makeEngine().run("PreToolUse", ctx())).toMatchObject({ verdict: "deny", hook: "first" });
    expect(marks()).toEqual(["first"]);
  });

  it("filters by event and by the tool glob", async () => {
    userHooks(
      node("kratos-only", "PreToolUse", `${mark("kratos")};process.exit(0)`, { match: "kratos__*" }),
      node("post", "PostToolUse", `${mark("post")};process.exit(0)`),
    );
    const engine = makeEngine();
    await engine.run("PreToolUse", ctx({ tool: "cad__inspect" }));
    expect(marks()).toEqual([]);
    await engine.run("PreToolUse", ctx({ tool: "kratos__run_simulation" }));
    expect(marks()).toEqual(["kratos"]);
    expect(engine.has("PreToolUse", "kratos__x")).toBe(true);
    expect(engine.has("PreToolUse", "cad__x")).toBe(false);
    expect(engine.has("TurnEnd")).toBe(false);
  });

  it("hands the hook the payload on stdin and a minimal environment", async () => {
    const out = path.join(tmp, "seen.json");
    process.env.KKSS_TEST_SECRET = "leak";
    try {
      userHooks(node("probe", "PreToolUse",
        `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({payload:JSON.parse(s),secret:process.env.KKSS_TEST_SECRET||null,event:process.env.KKSS_HOOK_EVENT,root:process.env.KKSS_PROJECT_ROOT,cwd:process.cwd()}))})`));
      await makeEngine().run("PreToolUse", ctx({ args: { wait: 5 }, callId: "k1" }));
    } finally {
      delete process.env.KKSS_TEST_SECRET;
    }
    const seen = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(seen.payload).toMatchObject({ event: "PreToolUse", source: "chat", tool: "kratos__run_simulation", args: { wait: 5 }, callId: "k1", conversationId: "c1" });
    expect(seen.secret).toBeNull();
    expect(seen.event).toBe("PreToolUse");
    expect(seen.root).toBe(project);
    expect(fs.realpathSync(seen.cwd)).toBe(project);
  });

  it("rejects with the caller's abort rather than judging a half-run hook", async () => {
    userHooks(node("slow", "PreToolUse", "setInterval(()=>{},1000)"));
    const controller = new AbortController();
    const pending = makeEngine().run("PreToolUse", ctx(), controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow();
    await expect(makeEngine().run("PreToolUse", ctx(), controller.signal)).rejects.toThrow();
  });

  it("killAll stops a running hook, which then reads as a failure (fail closed)", async () => {
    userHooks(node("slow", "PreToolUse", "setInterval(()=>{},1000)"));
    const engine = makeEngine();
    const pending = engine.run("PreToolUse", ctx());
    setTimeout(() => engine.killAll(), 100);
    expect(await pending).toMatchObject({ verdict: "deny", hook: "slow", reason: "the hook was cancelled" });
  });

  it("opt-in PostToolUse output comes back as a note", async () => {
    userHooks(node("audit", "PostToolUse", "process.stdout.write('audit row 7')", { modelOutput: true }));
    expect((await makeEngine().run("PostToolUse", ctx({ result: { ok: true, text: "x" } }))).notes).toEqual([{ hook: "audit", text: "audit row 7" }]);
  });
});

describe("where hooks come from", () => {
  it("runs nothing when the setting is off, and lists nothing", async () => {
    userHooks(node("gate", "PreToolUse", "process.exit(2)"));
    enabled = false;
    const engine = makeEngine();
    expect(await engine.run("PreToolUse", ctx())).toEqual({ verdict: "none", notes: [] });
    expect(engine.summary()).toEqual({ enabled: false, hooks: [], errors: [] });
    expect(engine.has("PreToolUse")).toBe(false);
  });

  it("an untrusted project's hooks do not run; trusting them starts them", async () => {
    projectHooks(node("team-gate", "PreToolUse", "process.stderr.write('team rule');process.exit(2)"));
    const servers = makeServers();
    const engine = makeEngine(servers);
    expect((await engine.run("PreToolUse", ctx())).verdict).toBe("none");
    expect(engine.summary().hooks).toEqual([]);
    await servers.trustProject();
    expect(await engine.run("PreToolUse", ctx())).toMatchObject({ verdict: "deny", hook: "team-gate", reason: "team rule" });
    expect(engine.summary().hooks).toMatchObject([{ name: "team-gate", source: "project" }]);
  });

  it("an edit after trust stops a project hook at once, and is announced", async () => {
    projectHooks(node("team-gate", "PreToolUse", "process.exit(2)"));
    const servers = makeServers();
    const engine = makeEngine(servers);
    await servers.trustProject();
    expect((await engine.run("PreToolUse", ctx())).verdict).toBe("deny");
    let changes = 0;
    engine.onChange(() => changes++);
    projectHooks(node("team-gate", "PreToolUse", "process.exit(2)"), node("extra", "TurnEnd", "process.exit(0)"));
    expect((await engine.run("PreToolUse", ctx())).verdict).toBe("none");
    expect(changes).toBeGreaterThan(0);
  });

  it("hooks.json is part of what folder trust hashes", async () => {
    write(path.join(project, ".kkss", "assistant"), "instructions.md", "Be brief.");
    const servers = makeServers();
    await servers.trustProject();
    expect(servers.loadProject().state).toBe("trusted");
    projectHooks(node("new", "TurnEnd", "process.exit(0)"));
    expect(servers.loadProject().state).toBe("changed");
  });

  it("runs your hooks before the project's", async () => {
    userHooks(node("mine", "TurnEnd", `${mark("mine")}`));
    projectHooks(node("theirs", "TurnEnd", `${mark("theirs")}`));
    const servers = makeServers();
    await servers.trustProject();
    await makeEngine(servers).run("TurnEnd", ctx());
    expect(marks()).toEqual(["mine", "theirs"]);
  });

  it("reports a bad file but keeps the good hooks", () => {
    userHooks(node("good", "TurnEnd", "process.exit(0)"), { name: "Bad Name", event: "TurnEnd", command: "x" });
    const summary = makeEngine().summary();
    expect(summary.hooks.map((h) => h.name)).toEqual(["good"]);
    expect(summary.errors).toHaveLength(1);
  });

  it("refuses PreToolUse rather than quietly running without hooks the folder could not be read for", async () => {
    userHooks(node("gate", "PreToolUse", "process.exit(0)"));
    write(userDir, "instructions.md", "x".repeat(MAX_DEFINITION_BYTES + 1));
    const engine = makeEngine();
    expect(engine.has("PreToolUse")).toBe(true);
    expect(await engine.run("PreToolUse", ctx())).toMatchObject({ verdict: "deny", hook: "hooks.json", reason: expect.stringContaining("cannot be loaded") });
    // ...but only when there is a hooks.json to lose: an oversized instructions.md alone blocks nothing.
    fs.rmSync(path.join(userDir, "hooks.json"));
    expect((await makeEngine().run("PreToolUse", ctx())).verdict).toBe("none");
  });
});
