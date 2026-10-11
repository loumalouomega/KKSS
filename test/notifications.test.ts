import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureNotifications, handleToastButton, toast } from "../app/main/services/notifications";

describe("toast actions", () => {
  const sent: any[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    configureNotifications(message => sent.push(message));
  });
  afterEach(() => vi.useRealTimers());

  it("sends a plain toast with no buttons", () => {
    toast("info", "hello");
    expect(sent).toEqual([{ type: "toast", id: expect.any(Number), kind: "info", text: "hello" }]);
  });

  it("runs the action once on click and retires the toast", () => {
    const run = vi.fn();
    toast("warning", "careful", { label: "Open", run });
    const { id, buttons } = sent[0];
    expect(buttons).toEqual(["Open"]);
    handleToastButton(id, "Open");
    handleToastButton(id, "Open");
    expect(run).toHaveBeenCalledTimes(1);
    expect(sent[1]).toEqual({ type: "toastUpdate", id, done: true });
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(2);
  });

  it("retires an ignored action toast without running the action", () => {
    const run = vi.fn();
    toast("warning", "ignored", { label: "Open", run });
    const { id } = sent[0];
    vi.advanceTimersByTime(15_001);
    expect(sent[1]).toEqual({ type: "toastUpdate", id, done: true });
    handleToastButton(id, "Open");
    expect(run).not.toHaveBeenCalled();
  });
});
