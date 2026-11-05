import { beforeEach, describe, expect, it } from "vitest";
import { outputTools } from "../app/main/services/chat/outputTools";
import { logMessage, logOutput, messageLog, outputLog, progress } from "../app/main/services/outputBus";

const tool = () => outputTools()[0];
const call = async (args: Record<string, unknown>) => (await tool().invoke(args)) as any;

describe("app__messages_tail", () => {
  beforeEach(() => {
    messageLog.clear();
    outputLog.clear();
    progress.clearFinished();
  });

  it("returns the newest messages, optionally one level", async () => {
    logMessage("info", "app", "Opened a.step");
    logMessage("error", "mesh", "boom");
    logMessage("info", "app", "Opened b.step");
    expect((await call({ limit: 2 })).entries.map((e: any) => e.text)).toEqual(["boom", "Opened b.step"]);
    expect((await call({ level: "error" })).entries).toHaveLength(1);
  });

  it("reads the log and the progress tabs", async () => {
    logOutput("info", "solver", "step 1");
    expect((await call({ tab: "log" })).entries[0]).toMatchObject({ source: "solver", text: "step 1" });
    const id = progress.begin({ source: "cad", label: "Meshing", fraction: 0.5 });
    const r = await call({ tab: "progress" });
    expect(r.running).toBeGreaterThanOrEqual(1);
    expect(r.items[r.items.length - 1]).toMatchObject({ label: "Meshing", state: "running", percent: 50 });
    progress.finish(id);
  });

  it("clamps a silly limit and ignores unknown values", async () => {
    for (let i = 0; i < 3; i++) logMessage("info", "app", `m${i}`);
    expect((await call({ limit: 99999 })).entries).toHaveLength(3);
    expect((await call({ tab: "bogus", level: "bogus", limit: "x" })).tab).toBe("messages");
  });
});
