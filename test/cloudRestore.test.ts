/**
 * cloudRestore.ts — the background fill of restored cloud tabs.
 *
 * What matters is what it does when the world is awkward: the user closes or
 * reuses a placeholder while it downloads, the provider is signed out, one
 * document fails. None of those may block, duplicate or corrupt the others.
 */
import { describe, expect, it } from "vitest";
import {
  fillCloudTabs,
  type DownloadResult,
  type PendingCloudTab,
  type RestoreCloudEvent,
  type TabState,
} from "../app/main/services/cloudRestore";

type Ref = { provider: string };
const tab = (id: string, provider = "dropbox"): PendingCloudTab<Ref> => ({ tabId: id, path: `/cache/${id}.mdpa`, ref: { provider } });

function harness(downloads: Record<string, DownloadResult | (() => Promise<DownloadResult>)>, states: Record<string, TabState> = {}, stopped = () => false) {
  const log: string[] = [];
  const events: RestoreCloudEvent<Ref>[] = [];
  const state = { ...states };
  const run = (tabs: PendingCloudTab<Ref>[]) =>
    fillCloudTabs(tabs, {
      download: async (t) => {
        log.push(`download:${t.tabId}`);
        const d = downloads[t.tabId];
        return typeof d === "function" ? d() : (d ?? { ok: false, kind: "other", message: "no fixture" });
      },
      tabState: (t) => state[t.tabId] ?? "untouched",
      open: (t, p) => log.push(`open:${t.tabId}:${p}`),
      close: (t) => log.push(`close:${t.tabId}`),
      settle: (t) => log.push(`settle:${t.tabId}`),
      notify: (e) => events.push(e),
      stopped,
    });
  return { run, log, events, state };
}

const ok = (path: string): DownloadResult => ({ ok: true, path });

describe("fillCloudTabs", () => {
  it("downloads one at a time, in saved order, and opens each into its own tab", async () => {
    const h = harness({ a: ok("/s/a"), b: ok("/s/b"), c: ok("/s/c") });
    await h.run([tab("a"), tab("b"), tab("c")]);
    expect(h.log).toEqual([
      "download:a", "open:a:/s/a", "settle:a",
      "download:b", "open:b:/s/b", "settle:b",
      "download:c", "open:c:/s/c", "settle:c",
    ]);
    expect(h.events).toEqual([]);
  });

  it("skips a tab the user already closed, without a download", async () => {
    const h = harness({ a: ok("/s/a"), b: ok("/s/b") }, { a: "gone" });
    await h.run([tab("a"), tab("b")]);
    expect(h.log).toEqual(["settle:a", "download:b", "open:b:/s/b", "settle:b"]);
  });

  it("re-checks the tab AFTER the download: closed meanwhile → nothing opened, nothing closed twice", async () => {
    const h = harness({ a: async () => { h.state.a = "gone"; return ok("/s/a"); } });
    await h.run([tab("a")]);
    expect(h.log).toEqual(["download:a", "settle:a"]);
    expect(h.events).toEqual([]);
  });

  it("never overwrites a tab the user put another document into; says so instead", async () => {
    const h = harness({ a: async () => { h.state.a = "used"; return ok("/s/a"); } });
    await h.run([tab("a")]);
    expect(h.log).toEqual(["download:a", "settle:a"]); // no open, no close
    expect(h.events).toEqual([{ kind: "used", tab: tab("a") }]);
  });

  it("not signed in: one message per provider, the rest of that provider is skipped without a request", async () => {
    const h = harness({ a: { ok: false, kind: "auth", message: "Not connected" }, b: ok("/s/b"), c: ok("/s/c") });
    await h.run([tab("a", "gdrive"), tab("b", "dropbox"), tab("c", "gdrive")]);
    expect(h.log).toEqual([
      "download:a", "close:a", "settle:a",
      "download:b", "open:b:/s/b", "settle:b",
      "close:c", "settle:c", // no `download:c`
    ]);
    expect(h.events).toEqual([{ kind: "auth", provider: "gdrive", count: 2 }]);
  });

  it("another failure closes just that placeholder, reports it, and carries on", async () => {
    const h = harness({ a: { ok: false, kind: "other", message: "404" }, b: ok("/s/b") });
    await h.run([tab("a"), tab("b")]);
    expect(h.log).toEqual(["download:a", "close:a", "settle:a", "download:b", "open:b:/s/b", "settle:b"]);
    expect(h.events).toEqual([{ kind: "failed", tab: tab("a"), message: "404" }]);
  });

  it("a cancelled download closes the placeholder quietly", async () => {
    const h = harness({ a: { ok: false, kind: "aborted", message: "aborted" } });
    await h.run([tab("a")]);
    expect(h.log).toEqual(["download:a", "close:a", "settle:a"]);
    expect(h.events).toEqual([]);
  });

  it("does not close a placeholder that vanished while its download failed", async () => {
    const h = harness({ a: async () => { h.state.a = "gone"; return { ok: false, kind: "other", message: "x" } as DownloadResult; } });
    await h.run([tab("a")]);
    expect(h.log).toEqual(["download:a", "settle:a"]);
  });

  it("stops starting downloads once the app is quitting, leaving pending tabs for the session", async () => {
    let quitting = false;
    const h = harness({ a: async () => { quitting = true; return ok("/s/a"); }, b: ok("/s/b") }, {}, () => quitting);
    await h.run([tab("a"), tab("b")]);
    expect(h.log).not.toContain("download:b");
    expect(h.log).not.toContain("settle:b"); // still pending → still in the saved session
  });
});
