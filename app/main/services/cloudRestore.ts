/**
 * The policy for filling restored cloud tabs in the background — kept
 * Electron-free (every effect injected, the `unresponsiveGuard.ts` precedent) so
 * it is tested without a window or a network.
 *
 * Context: session restore stays synchronous. A saved cloud document that the
 * staging cache has since evicted gets its tab *immediately* (so tab order and
 * focus are right) and this fills it afterwards:
 *
 *   - strictly one at a time — a login node's worth of tabs must not open eight
 *     parallel downloads, and sequential order keeps the toasts readable;
 *   - a tab the user closed, or already put another document into, is never
 *     touched (the download result is checked again *after* the await);
 *   - "not signed in" is one message per provider, and the rest of that
 *     provider's tabs are skipped without a request — not N identical errors;
 *   - any other failure (or the user cancelling the download) closes that
 *     placeholder and carries on, so one bad document cannot block the rest.
 */
export interface PendingCloudTab<R extends { provider: string }> {
  tabId: string;
  path: string;
  ref: R;
}

export type DownloadResult =
  | { ok: true; path: string }
  | { ok: false; kind: "auth" | "aborted" | "other"; message: string };

/** `untouched` = the placeholder is still blank; `used` = the user opened
 *  something into it; `gone` = it was closed. */
export type TabState = "untouched" | "used" | "gone";

export type RestoreCloudEvent<R extends { provider: string }> =
  | { kind: "failed"; tab: PendingCloudTab<R>; message: string }
  | { kind: "used"; tab: PendingCloudTab<R> }
  | { kind: "auth"; provider: string; count: number };

export interface RestoreCloudDeps<R extends { provider: string }> {
  download(tab: PendingCloudTab<R>): Promise<DownloadResult>;
  tabState(tab: PendingCloudTab<R>): TabState;
  /** Opens the staged copy into the placeholder. */
  open(tab: PendingCloudTab<R>, stagedPath: string): void;
  /** Removes a placeholder that will not be filled. */
  close(tab: PendingCloudTab<R>): void;
  /** The tab no longer awaits a download (success, failure or gone). Always called. */
  settle(tab: PendingCloudTab<R>): void;
  notify(event: RestoreCloudEvent<R>): void;
  /** True once the app is quitting — stop starting new downloads. */
  stopped(): boolean;
}

export async function fillCloudTabs<R extends { provider: string }>(
  tabs: PendingCloudTab<R>[],
  deps: RestoreCloudDeps<R>
): Promise<void> {
  const authFailed = new Map<string, number>(); // provider -> tabs skipped or failed

  for (const tab of tabs) {
    if (deps.stopped()) return;
    if (deps.tabState(tab) === "gone") {
      deps.settle(tab);
      continue;
    }
    if (authFailed.has(tab.ref.provider)) {
      authFailed.set(tab.ref.provider, (authFailed.get(tab.ref.provider) ?? 0) + 1);
      deps.close(tab);
      deps.settle(tab);
      continue;
    }

    const result = await deps.download(tab);
    // The await is the gap in which the user can close the tab or open
    // something else into it — decide on the state *now*, not before.
    const state = deps.tabState(tab);
    if (result.ok) {
      if (state === "untouched") deps.open(tab, result.path);
      else if (state === "used") deps.notify({ kind: "used", tab });
      deps.settle(tab);
      continue;
    }

    if (result.kind === "auth") authFailed.set(tab.ref.provider, 1);
    else if (result.kind === "other") deps.notify({ kind: "failed", tab, message: result.message });
    if (state !== "gone") deps.close(tab);
    deps.settle(tab);
  }

  for (const [provider, count] of authFailed) deps.notify({ kind: "auth", provider, count });
}
