/**
 * What to do about a renderer that stays unresponsive — kept Electron-free (the
 * `cadSaveInPlace.ts` precedent: every effect is injected) so the policy is
 * tested without a window.
 *
 * Electron's `unresponsive` fires on any long synchronous task, which is exactly
 * what both viewers do while parsing a large mesh. So it must never reload by
 * itself (the crash-recovery invariant in `index.ts`). This guard only *asks*,
 * and only after the view has stayed unresponsive for a generous time:
 *
 *   - `responsive` (or the view going away) before the delay cancels everything
 *     and dismisses a prompt that is already showing — a view that recovered by
 *     itself needs no decision;
 *   - **Wait** re-arms with a doubled delay (capped), so someone loading a huge
 *     file is asked once in a while, not nagged;
 *   - **Reload** is the only path to `reload`, i.e. never without a click.
 *
 * Generic over what identifies a view so it need not know about `ViewRef`.
 */
export type UnresponsiveAnswer = "wait" | "reload" | "gone";

export interface UnresponsiveDeps<T> {
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Shows the choice. Must settle when `signal` aborts (the view recovered). */
  prompt(payload: T, info: { attempt: number; signal: AbortSignal }): Promise<UnresponsiveAnswer>;
  /** The user chose Reload. */
  reload(payload: T): void;
}

/** How long a view may stay unresponsive before the first prompt. Generous on
 *  purpose: a multi-hundred-MB mesh can legitimately block for this long. */
export const FIRST_PROMPT_MS = 30_000;
/** Each Wait doubles the next delay, up to here. */
export const MAX_PROMPT_DELAY_MS = 10 * 60_000;

export const promptDelay = (attempt: number): number => Math.min(FIRST_PROMPT_MS * 2 ** attempt, MAX_PROMPT_DELAY_MS);

interface Episode<T> {
  payload: T;
  attempt: number;
  timer?: unknown;
  controller?: AbortController;
}

export class UnresponsiveGuard<T> {
  private readonly episodes = new Map<string, Episode<T>>();
  private disposed = false;

  constructor(private readonly deps: UnresponsiveDeps<T>) {}

  /** The view stopped responding. Repeated reports for one episode are ignored. */
  unresponsive(key: string, payload: T): void {
    if (this.disposed || this.episodes.has(key)) return;
    const episode: Episode<T> = { payload, attempt: 0 };
    this.episodes.set(key, episode);
    this.arm(key, episode);
  }

  /** The view responded again, was reloaded, or was closed. */
  responsive(key: string): void {
    const episode = this.episodes.get(key);
    if (!episode) return;
    this.episodes.delete(key);
    if (episode.timer !== undefined) this.deps.clearTimer(episode.timer);
    episode.controller?.abort();
  }

  /** Quit: cancel every timer and dismiss any open prompt. */
  dispose(): void {
    this.disposed = true;
    for (const key of [...this.episodes.keys()]) this.responsive(key);
  }

  /** Views with an open episode (tests). */
  get pending(): number {
    return this.episodes.size;
  }

  private arm(key: string, episode: Episode<T>): void {
    episode.timer = this.deps.setTimer(() => void this.ask(key, episode), promptDelay(episode.attempt));
  }

  private async ask(key: string, episode: Episode<T>): Promise<void> {
    if (this.episodes.get(key) !== episode) return;
    episode.timer = undefined;
    const controller = new AbortController();
    episode.controller = controller;
    let answer: UnresponsiveAnswer;
    try {
      answer = await this.deps.prompt(episode.payload, { attempt: episode.attempt, signal: controller.signal });
    } catch {
      answer = "wait"; // a failed dialog is not a decision to reload
    }
    // Recovered, closed or quit while the prompt was up: nothing left to decide.
    if (this.episodes.get(key) !== episode || controller.signal.aborted) return;
    episode.controller = undefined;
    if (answer === "reload") {
      this.episodes.delete(key);
      this.deps.reload(episode.payload);
    } else if (answer === "gone") {
      this.episodes.delete(key);
    } else {
      episode.attempt += 1;
      this.arm(key, episode);
    }
  }
}
