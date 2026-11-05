import { describe, expect, it } from "vitest";
import { formatElapsed, memoryPressure, memoryText, nearBottom, percent } from "../app/renderer/terminal/outputFormat";

describe("output panel formatting", () => {
  it("formats elapsed time", () => {
    expect(formatElapsed(1700)).toBe("1.7 s");
    expect(formatElapsed(125_000)).toBe("2 min 5 s");
    expect(formatElapsed(3_900_000)).toBe("1 h 5 min");
    expect(formatElapsed(-5)).toBe("0.0 s");
  });

  it("rounds a fraction to a percent and leaves indeterminate work alone", () => {
    expect(percent({ fraction: 0.456 })).toBe(46);
    expect(percent({ fraction: null })).toBeNull();
  });

  it("writes the memory footer and its pressure", () => {
    const m = { appBytes: 0.68 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 };
    expect(memoryText(m, { app: "App", system: "System" })).toBe("App 0.68 GB | System 8.00 / 16.00 GB");
    expect(memoryPressure(m)).toBe(0.5);
    expect(memoryPressure({ appBytes: 0, usedBytes: 0, totalBytes: 0 })).toBe(0);
  });

  it("detects a list pinned to its end", () => {
    expect(nearBottom({ scrollTop: 76, clientHeight: 100, scrollHeight: 200 })).toBe(true);
    expect(nearBottom({ scrollTop: 0, clientHeight: 100, scrollHeight: 200 })).toBe(false);
  });
});
