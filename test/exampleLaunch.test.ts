import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { ExampleQueue, exampleArgIndexes, exampleFromUrl, launchExamples } from "../app/main/exampleLaunch";
import { launchFiles } from "../app/main/launch";

const argv = (...a: string[]) => ["electron", "main.js", ...a];

describe("example launch requests", () => {
  it("reads kkss://open?example=<id> and nothing looser", () => {
    expect(exampleFromUrl("kkss://open?example=structural")).toEqual({ id: "structural", source: "link" });
    for (const bad of ["kkss://open?example=a&example=b", "kkss://open?example=../x", "kkss://open?example=a&file=/x", "kkss://open/x?example=a", "kkss://open?example=a#h", "kkss://other?example=a", "http://open?example=a", "kkss://open?example=%zz"]) {
      expect(exampleFromUrl(bad), bad).toBeUndefined();
    }
  });
  it("reads --example with an optional --into, and keeps links folder-less", () => {
    const r = launchExamples(argv("--example", "fluid", "--into", "out", "kkss://open?example=thermal"), false, "/w", path.resolve);
    expect(r).toEqual([{ id: "fluid", into: path.resolve("/w", "out"), source: "cli" }, { id: "thermal", source: "link" }]);
    expect(launchExamples(argv("--example=eigen"), false, "/w", path.resolve)).toEqual([{ id: "eigen", source: "cli" }]);
    expect(launchExamples(argv("--example"), false, "/w", path.resolve)).toEqual([{ id: "", source: "cli" }]);
  });
  it("keeps the option values out of the file list", () => {
    expect([...exampleArgIndexes(["--example", "x", "--into", "y", "--other"])]).toEqual([1, 3]);
    expect(launchFiles(argv("--example", "package.json", "--into", "package.json"), false, process.cwd())).toEqual([]);
  });
  it("holds requests until ready, in order", () => {
    const q = new ExampleQueue();
    q.enqueue([{ id: "a", source: "cli" }, { id: "b", source: "cli" }]);
    const seen: string[] = [];
    q.ready(r => seen.push(r.id));
    q.enqueue([{ id: "c", source: "link" }]);
    expect(seen).toEqual(["a", "b", "c"]);
  });
});
