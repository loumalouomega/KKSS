import { describe, expect, it } from "vitest";
import {
  EntryLog,
  FINISHED_RETAINED,
  ProgressRegistry,
  entriesToText,
  formatGb,
  sampleMemory,
} from "../app/main/services/outputCore";

const fixed = () => new Date("2026-11-05T10:00:00.000Z");

describe("EntryLog", () => {
  it("numbers entries, scrubs secrets and caps the ring", () => {
    const log = new EntryLog(3, fixed);
    log.add("info", "app", "Opened model.step");
    log.add("warn", "cad", "token=abcd1234efgh");
    log.add("error", "mesh", "boom");
    log.add("info", "app", "fourth");
    const all = log.snapshot();
    expect(all.map((e) => e.id)).toEqual([2, 3, 4]);
    expect(all[0].text).toContain("<SECRET>");
    expect(all[0].at).toBe("2026-11-05T10:00:00.000Z");
  });

  it("notifies subscribers, survives a throwing one, and stops after unsubscribe", () => {
    const log = new EntryLog(10, fixed);
    const seen: string[] = [];
    log.subscribe(() => { throw new Error("bad listener"); });
    const off = log.subscribe((e) => seen.push(e.text));
    log.add("info", "app", "one");
    off();
    log.add("info", "app", "two");
    expect(seen).toEqual(["one"]);
    expect(log.size).toBe(2);
  });

  it("clears without resetting ids, so a renderer never sees an id twice", () => {
    const log = new EntryLog(10, fixed);
    log.add("info", "app", "a");
    log.clear();
    log.add("info", "app", "b");
    expect(log.snapshot().map((e) => e.id)).toEqual([2]);
  });

  it("formats plain text for Copy", () => {
    const log = new EntryLog(10, fixed);
    log.add("info", "app", "hello");
    log.add("error", "mesh", "failed");
    expect(entriesToText(log.snapshot())).toBe(
      "[2026-11-05T10:00:00.000Z] app: hello\n[2026-11-05T10:00:00.000Z] ERROR mesh: failed"
    );
  });
});

describe("ProgressRegistry", () => {
  it("tracks begin, update and finish", () => {
    let clock = 100;
    const reg = new ProgressRegistry(() => clock);
    const id = reg.begin({ source: "cad", label: "Meshing" });
    expect(reg.activeCount).toBe(1);
    expect(reg.snapshot()[0]).toMatchObject({ state: "running", fraction: null, cancellable: false });
    reg.update(id, { fraction: 0.4, label: "Meshing 40%" });
    expect(reg.snapshot()[0]).toMatchObject({ fraction: 0.4, label: "Meshing 40%" });
    clock = 250;
    reg.finish(id, "done");
    expect(reg.snapshot()[0]).toMatchObject({ state: "done", fraction: 1, endedAt: 250 });
    expect(reg.activeCount).toBe(0);
  });

  it("clamps fractions and treats non-finite values as indeterminate", () => {
    const reg = new ProgressRegistry();
    const id = reg.begin({ source: "x", label: "y", fraction: 7 });
    expect(reg.snapshot()[0].fraction).toBe(1);
    reg.update(id, { fraction: Number.NaN });
    expect(reg.snapshot()[0].fraction).toBeNull();
  });

  it("a second begin with the same running key updates instead of duplicating", () => {
    const reg = new ProgressRegistry();
    const a = reg.begin({ source: "queue", label: "solve", key: "t1" });
    const b = reg.begin({ source: "queue", label: "solve (2/3)", key: "t1" });
    expect(b).toBe(a);
    expect(reg.snapshot()).toHaveLength(1);
    reg.finishKey("t1", "failed", "exit 1");
    expect(reg.snapshot()[0]).toMatchObject({ state: "failed", detail: "exit 1" });
    // A finished key starts a fresh item next time.
    expect(reg.begin({ source: "queue", label: "solve", key: "t1" })).not.toBe(a);
  });

  it("cancel calls the handler once and leaves the state to the work", () => {
    const reg = new ProgressRegistry();
    let calls = 0;
    const id = reg.begin({ source: "mesh", label: "MMG", cancel: () => { calls++; } });
    expect(reg.cancel(id)).toBe(true);
    expect(calls).toBe(1);
    expect(reg.snapshot()[0]).toMatchObject({ state: "running", cancelling: true });
    reg.finish(id, "cancelled");
    expect(reg.cancel(id)).toBe(false);
    expect(reg.snapshot()[0].cancelling).toBeUndefined();
  });

  it("a cancel handler that throws marks the item failed instead of escaping", () => {
    const reg = new ProgressRegistry();
    const id = reg.begin({ source: "x", label: "y", cancel: () => { throw new Error("nope"); } });
    expect(() => reg.cancel(id)).not.toThrow();
    expect(reg.snapshot()[0]).toMatchObject({ state: "failed", detail: "nope" });
  });

  it("an item without a cancel handler cannot be cancelled", () => {
    const reg = new ProgressRegistry();
    const id = reg.begin({ source: "x", label: "y" });
    expect(reg.cancel(id)).toBe(false);
  });

  it("keeps running items forever but only the newest finished ones", () => {
    const reg = new ProgressRegistry();
    const running = reg.begin({ source: "x", label: "long" });
    for (let i = 0; i < FINISHED_RETAINED + 5; i++) reg.finish(reg.begin({ source: "x", label: `job ${i}` }));
    const items = reg.snapshot();
    expect(items.filter((i) => i.state === "done")).toHaveLength(FINISHED_RETAINED);
    expect(items.some((i) => i.id === running && i.state === "running")).toBe(true);
    reg.clearFinished();
    expect(reg.snapshot()).toHaveLength(1);
  });

  it("notifies on change only, and survives a throwing listener", () => {
    const reg = new ProgressRegistry();
    let n = 0;
    reg.subscribe(() => { throw new Error("bad"); });
    reg.subscribe(() => { n++; });
    const id = reg.begin({ source: "x", label: "y" });
    reg.update(id, { label: "y" });
    expect(n).toBe(1);
    reg.update(id, { fraction: 0.5 });
    expect(n).toBe(2);
  });
});

describe("memory sampling", () => {
  it("sums the working sets (KiB) of every process", () => {
    const m = sampleMemory([{ memory: { workingSetSize: 1024 } }, { memory: { workingSetSize: 2048 } }, {}], 16 * 1024 ** 3, 4 * 1024 ** 3);
    expect(m).toEqual({ appBytes: 3 * 1024 * 1024, usedBytes: 12 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 });
  });

  it("clamps nonsense free memory and formats gigabytes", () => {
    expect(sampleMemory([], 8, 100).usedBytes).toBe(0);
    expect(sampleMemory([], Number.NaN, 5)).toEqual({ appBytes: 0, usedBytes: 0, totalBytes: 0 });
    expect(formatGb(0.68 * 1024 ** 3)).toBe("0.68 GB");
  });
});
