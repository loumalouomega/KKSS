import { describe, expect, it } from "vitest";
import { LaunchQueue, launchFiles, localLaunchFile, unsupportedLaunchFile, unsupportedLaunchFiles } from "../app/main/launch";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("external launch validation", () => {
  it("accepts only supported absolute local files and kkss open links", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kkss-launch-"));
    const file = path.join(dir, "part.stp");
    writeFileSync(file, "solid");
    expect(localLaunchFile(file, dir)).toBe(file);
    expect(localLaunchFile(`kkss://open?file=${encodeURIComponent(file)}`, dir)).toBe(file);
    expect(localLaunchFile("kkss://app/renderer/shell/index.html", dir)).toBeUndefined();
    expect(localLaunchFile(path.join(dir, "missing.stp"), dir)).toBeUndefined();
  });

  it("retains startup opens until the main window is ready", () => {
    const queue = new LaunchQueue();
    queue.enqueue(["a", "a", "b"]);
    const opened: string[] = [];
    queue.ready(file => opened.push(file));
    expect(opened).toEqual(["a", "b"]);
    queue.enqueue(["c"]);
    expect(opened).toEqual(["a", "b", "c"]);
  });

  it("extracts file arguments without treating flags as paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kkss-argv-"));
    writeFileSync(path.join(dir, "case.mdpa"), "Begin ModelPartData");
    expect(launchFiles(["electron", "main.js", "--no-sandbox", "case.mdpa"], false, dir)).toEqual([path.join(dir, "case.mdpa")]);
  });
});

describe("unsupported external opens", () => {
  it("reports an existing file no mode can open, instead of dropping it silently", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kkss-unsupported-"));
    const text = path.join(dir, "notes.txt");
    const part = path.join(dir, "part.stp");
    writeFileSync(text, "hello");
    writeFileSync(part, "solid");
    expect(localLaunchFile(text, dir)).toBeUndefined();
    expect(unsupportedLaunchFile(text, dir)).toBe(text);
    expect(unsupportedLaunchFile(`kkss://open?file=${encodeURIComponent(text)}`, dir)).toBe(text);
    // A routable file, a missing path and a non-open kkss URL are not "unsupported".
    expect(unsupportedLaunchFile(part, dir)).toBeUndefined();
    expect(unsupportedLaunchFile(path.join(dir, "missing.txt"), dir)).toBeUndefined();
    expect(unsupportedLaunchFile("kkss://app/renderer/shell/index.html", dir)).toBeUndefined();
    expect(unsupportedLaunchFile("-flag", dir)).toBeUndefined();
  });

  it("collects unsupported argv entries without flags or duplicates", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kkss-unsupported-argv-"));
    writeFileSync(path.join(dir, "a.txt"), "x");
    writeFileSync(path.join(dir, "case.mdpa"), "Begin ModelPartData");
    expect(unsupportedLaunchFiles(["electron", "main.js", "--no-sandbox", "a.txt", "a.txt", "case.mdpa", "gone.txt"], false, dir))
      .toEqual([path.join(dir, "a.txt")]);
  });
});
