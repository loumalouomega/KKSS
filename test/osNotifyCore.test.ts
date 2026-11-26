import { describe, expect, it } from "vitest";
import { jobNotice, planNotice, shouldShow } from "../app/main/services/osNotifyCore";

const before = (...s: string[]) => new Map(s.map((state, i) => [`t${i}`, state]));
const tasks = (...s: string[]) => s.map((state, i) => ({ id: `t${i}`, state }));

describe("OS notifications", () => {
  it("notifies once when a running plan settles, by worst outcome", () => {
    expect(planNotice(before("running", "waiting"), tasks("succeeded", "succeeded"))).toMatchObject({ title: "Queue finished", kind: "info" });
    expect(planNotice(before("running"), tasks("failed"))).toMatchObject({ title: "Queue failed", kind: "error" });
    expect(planNotice(before("running", "running"), tasks("uncertain", "failed"))).toMatchObject({ title: "Queue finished uncertain", kind: "warning" });
  });
  it("stays quiet while work remains, for history and for a cancelled plan", () => {
    expect(planNotice(before("running", "waiting"), tasks("succeeded", "waiting"))).toBeUndefined();
    expect(planNotice(before(), tasks("succeeded"))).toBeUndefined();
    expect(planNotice(before("succeeded"), tasks("succeeded"))).toBeUndefined();
    expect(planNotice(before("running"), tasks("cancelled"))).toBeUndefined();
  });
  it("notices only terminal job states", () => {
    expect(jobNotice({ state: "succeeded", case_dir: "/a" }, "a")?.body).toBe("a succeeded.");
    expect(jobNotice({ state: "failed", case_dir: "/a" }, "a")?.kind).toBe("error");
    expect(jobNotice({ state: "running", case_dir: "/a" }, "a")).toBeUndefined();
  });
  it("shows only when enabled, unfocused and not under e2e", () => {
    expect(shouldShow(true, false, false)).toBe(true);
    expect(shouldShow(false, false, false)).toBe(false);
    expect(shouldShow(true, true, false)).toBe(false);
    expect(shouldShow(true, false, true)).toBe(false);
  });
});
