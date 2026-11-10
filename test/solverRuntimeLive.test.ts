/**
 * Live acceptance for the app-managed solver runtime. Opt-in:
 * it downloads Kratos from PyPI. `KKSS_LIVE_SOLVER=1 npx vitest run test/solverRuntimeLive.test.ts`
 * (set `KKSS_LIVE_UV` to a uv executable, else `uv` on PATH). The install goes into a
 * temporary directory, never the user's profile.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SolverRuntimeInstaller } from "../app/main/services/workflows/solverRuntime";

describe.skipIf(!process.env.KKSS_LIVE_SOLVER)("live solver runtime install", () => {
  it("builds a verified venv from the pinned requirements and reuses it", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-live-solver-"));
    try {
      const installer = new SolverRuntimeInstaller(userData, path.join(__dirname, "..", "docker", "kratos"));
      const uv = process.env.KKSS_LIVE_UV || "uv";
      const first = await installer.install(uv, AbortSignal.timeout(50 * 60_000));
      expect(first.reused).toBe(false);
      expect(fs.existsSync(first.python)).toBe(true);
      const again = await installer.install(uv, AbortSignal.timeout(60_000));
      expect(again).toMatchObject({ reused: true, python: first.python });
    } finally { fs.rmSync(userData, { recursive: true, force: true }); }
  }, 55 * 60_000);
});
