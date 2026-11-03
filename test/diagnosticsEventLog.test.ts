import { describe, expect, it } from "vitest";
import { EventLog, MAX_EVENTS, MAX_LINE_CHARS, MAX_LOG_LINES, Ring, scrubSecrets } from "../app/main/services/eventLogCore";
import { buildBundle, redactPaths, textFile } from "../app/main/services/diagnosticsCore";

const fixed = () => new Date("2026-01-02T03:04:05.000Z");

describe("event log", () => {
  it("ring drops the oldest entries", () => {
    const r = new Ring<number>(3);
    for (let i = 0; i < 10; i++) r.push(i);
    expect(r.snapshot()).toEqual([7, 8, 9]);
  });

  it("caps events and log lines", () => {
    const log = new EventLog(fixed);
    for (let i = 0; i < MAX_EVENTS + 20; i++) log.event("crash", `tab:cad:${i}`, "oom");
    for (let i = 0; i < MAX_LOG_LINES + 50; i++) log.log("warn", [`line ${i}`]);
    expect(log.events()).toHaveLength(MAX_EVENTS);
    expect(log.events()[0].view).toBe("tab:cad:20");
    expect(log.tail()).toHaveLength(MAX_LOG_LINES);
    expect(log.tail()[MAX_LOG_LINES - 1]).toContain("line 249");
  });

  it("caps each line and splits multi-line messages", () => {
    const log = new EventLog(fixed);
    log.log("error", ["x".repeat(MAX_LINE_CHARS * 4)]);
    log.log("error", ["a\nb\n\nc"]);
    const t = log.tail();
    expect(t[0].length).toBeLessThan(MAX_LINE_CHARS + 100);
    expect(t[0]).toContain("[+");
    expect(t.slice(1).map((l) => l.slice(-1))).toEqual(["a", "b", "c"]);
  });

  it("never throws on hostile arguments", () => {
    const log = new EventLog(fixed);
    const cyc: any = {}; cyc.self = cyc;
    const bad = { toString() { throw new Error("no"); } };
    expect(() => log.log("warn", [cyc, bad, undefined, 1n, Symbol("s")])).not.toThrow();
    expect(log.tail().length).toBe(1);
  });

  it("scrubs credentials before they are retained", () => {
    expect(scrubSecrets("Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(scrubSecrets("key sk-ant-1234567890abcdef")).toBe("key <SECRET>");
    expect(scrubSecrets('{"apiKey":"hunter2xyz"}')).not.toContain("hunter2xyz");
    const log = new EventLog(fixed);
    log.log("error", ["token=abcd1234efgh"]);
    expect(log.tail().join("\n")).not.toContain("abcd1234efgh");
  });

  it("exports with home and temp paths redacted and listed in the manifest", () => {
    const log = new EventLog(fixed);
    log.log("error", ["failed /home/ana/models/a.stl in /tmp/run1"]);
    log.event("unresponsive", "tab:mesh:2");
    const r = { home: "/home/ana", tmp: "/tmp" };
    const tail = redactPaths(log.tail().join("\n") + "\n", r);
    expect(tail).toContain("<HOME>/models/a.stl in <TMP>/run1");
    expect(tail).not.toContain("ana");
    const bundle = buildBundle([textFile("events.json", JSON.stringify(log.events())), textFile("main-log-tail.txt", tail)], "t");
    const names = JSON.parse(new TextDecoder().decode(bundle[0].data)).files.map((f: any) => f.name);
    expect(names).toEqual(["events.json", "main-log-tail.txt"]);
  });
});
