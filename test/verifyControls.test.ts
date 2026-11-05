import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const python = ["python3", "python"].find((c) => spawnSync(c, ["--version"]).status === 0);

// The tutorial verifier's own contract, with no Kratos: every limit carries a stated reason, and each single-physics check
// is shown to FAIL on deliberately wrong data (a negative control), exactly the named check and no other.
describe.skipIf(!python)("tutorial verifier", () => {
  it("states a reason for every limit and detects every negative control", () => {
    const run = spawnSync(python!, [path.join("tools", "tutorials", "verify_selftest.py")], { encoding: "utf8" });
    expect(run.stderr + run.stdout).toContain("verify self-test passed");
    expect(run.status).toBe(0);
    for (const c of ["structural", "thermal", "potential-flow", "shallow-water", "fluid"]) expect(run.stdout).toContain(`ok ${c}:`);
  });
});
