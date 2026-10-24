import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { HookRunner } from "../app/main/services/chat/hookRunner";

/** Real children: `node -e` scripts, so exit codes, stdin, timeouts and kills are the OS's own. */
const node = (script: string, timeoutMs = 10_000) => ({ command: process.execPath, args: ["-e", script], timeoutMs });
const options = { cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "" } as Record<string, string> };

describe("HookRunner", () => {
  it("passes the payload on stdin and returns the exit code and output", async () => {
    const runner = new HookRunner();
    const result = await runner.run(
      node("let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.parse(s).event);process.stderr.write('why');process.exit(2)})"),
      JSON.stringify({ event: "PreToolUse" }), options,
    );
    expect(result).toMatchObject({ code: 2, stdout: "PreToolUse", stderr: "why", timedOut: false, aborted: false });
  });

  it("gives the hook only the environment it is handed", async () => {
    process.env.KKSS_TEST_SECRET = "leak";
    try {
      const result = await new HookRunner().run(node("process.stdout.write(String(process.env.KKSS_TEST_SECRET)+'|'+process.env.KKSS_HOOK_EVENT)"), "{}", {
        ...options, env: { ...options.env, KKSS_HOOK_EVENT: "TurnEnd" },
      });
      expect(result.stdout).toBe("undefined|TurnEnd");
    } finally {
      delete process.env.KKSS_TEST_SECRET;
    }
  });

  it("runs in the given directory", async () => {
    const result = await new HookRunner().run(node("process.stdout.write(process.cwd())"), "{}", options);
    expect(result.stdout.toLowerCase()).toBe(require("node:fs").realpathSync(os.tmpdir()).toLowerCase());
  });

  it("kills a hook that outlives its timeout", async () => {
    const result = await new HookRunner().run(node("setInterval(()=>{},1000)", 300), "{}", options);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it("kills the whole process group on abort, and does not start when already aborted", async () => {
    const controller = new AbortController();
    const pending = new HookRunner().run(node("setInterval(()=>{},1000)"), "{}", { ...options, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.aborted).toBe(true);
    const again = await new HookRunner().run(node("process.exit(0)"), "{}", { ...options, signal: controller.signal });
    expect(again).toMatchObject({ aborted: true, code: null });
  });

  it("killAll stops every live hook and reads as cancelled", async () => {
    const runner = new HookRunner();
    const a = runner.run(node("setInterval(()=>{},1000)"), "{}", options);
    const b = runner.run(node("setInterval(()=>{},1000)"), "{}", options);
    setTimeout(() => runner.killAll(), 100);
    const results = await Promise.all([a, b]);
    expect(results.every((r) => r.aborted && r.code === null)).toBe(true);
  });

  it("reports a program that cannot start instead of throwing", async () => {
    const result = await new HookRunner().run({ command: "definitely-not-a-real-program-kkss", args: [], timeoutMs: 5000 }, "{}", options);
    expect(result.code).toBeNull();
    expect(result.error).toMatch(/ENOENT/);
  });

  it("caps each output stream", async () => {
    const result = await new HookRunner().run(node("process.stdout.write('x'.repeat(100000))"), "{}", options);
    expect(result.stdout.length).toBeLessThanOrEqual(8192);
  });

  it("tolerates a hook that never reads its input", async () => {
    const big = JSON.stringify({ blob: "z".repeat(500_000) });
    const result = await new HookRunner().run(node("process.exit(0)"), big, options);
    expect(result.code).toBe(0);
  });
});
