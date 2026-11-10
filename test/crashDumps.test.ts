import { describe, expect, it } from "vitest";
import { describeDump, isDumpName, selectDumps, type DumpInfo } from "../app/main/services/crashDumpsCore";

const d = (name: string, mtimeMs: number, size = 1000): DumpInfo => ({ name, mtimeMs, size });

describe("crash dump selection", () => {
  it("counts only .dmp files, never paths", () => {
    expect(isDumpName("a.dmp")).toBe(true);
    expect(isDumpName("A.DMP")).toBe(true);
    for (const n of ["a.txt", "settings.dat", "../a.dmp", "x/a.dmp", "a.dmp.tmp"]) expect(isDumpName(n), n).toBe(false);
  });
  it("keeps the newest few first", () => {
    const list = Array.from({ length: 8 }, (_, i) => d(`d${i}.dmp`, i));
    const { included, skipped } = selectDumps(list, { maxCount: 3 });
    expect(included.map((x) => x.name)).toEqual(["d7.dmp", "d6.dmp", "d5.dmp"]);
    expect(skipped).toHaveLength(5);
  });
  it("skips a dump that would exceed the byte cap but still fits a smaller older one", () => {
    const { included, skipped } = selectDumps([d("new.dmp", 3, 600), d("big.dmp", 2, 600), d("old.dmp", 1, 300)], { maxBytes: 1000 });
    expect(included.map((x) => x.name)).toEqual(["new.dmp", "old.dmp"]);
    expect(skipped.map((x) => x.name)).toEqual(["big.dmp"]);
  });
  it("ignores non-dump entries and handles an empty list", () => {
    expect(selectDumps([])).toEqual({ included: [], skipped: [] });
    expect(selectDumps([d("meta.json", 1)]).included).toEqual([]);
  });
  it("describes a dump without a path", () => {
    expect(describeDump(d("a.dmp", Date.UTC(2026, 10, 10), 42))).toEqual({ name: "a.dmp", date: "2026-11-10T00:00:00.000Z", bytes: 42 });
  });
});
