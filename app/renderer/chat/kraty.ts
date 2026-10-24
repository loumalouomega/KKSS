/**
 * Kraty's DOM half: draws the face once, then only flips data-attributes that
 * chat.css keys on (the page's CSP allows no `style=`). Presentation only —
 * see kratyCore.ts. Off unless Settings ▸ LLM Assistant ▸ Kraty is on.
 */
import { t } from "../../shared/i18n";
import { BUBBLE_KEYS, EXPRESSIONS, INITIAL_SIGNALS, reduceSignals, stateOf } from "./kratyCore";
import type { KratyEvent, KratySignals, KratyState } from "./kratyCore";

const SVG = `
<svg viewBox="0 0 64 64" width="46" height="46" aria-hidden="true" focusable="false">
  <g transform="rotate(5 30 32)"><g class="k-body">
    <g class="k-block">
      <polygon class="k-face k-side" points="10,8 10,30 4,35 4,13" />
      <polygon class="k-face k-side" points="10,30 32,30 26,35 4,35" />
      <polygon class="k-face k-side" points="32,30 32,52 26,57 26,35" />
      <polygon class="k-face k-side" points="32,52 54,52 48,57 26,57" />
      <polygon class="k-face" points="10,8 32,8 32,30 10,30" />
      <polygon class="k-face" points="32,8 54,8 54,30 32,30" />
      <polygon class="k-face" points="32,30 54,30 54,52 32,52" />
      <line class="k-fan" x1="32" y1="30" x2="54" y2="52" /><line class="k-fan" x1="32" y1="30" x2="43" y2="52" />
    </g>
    <g class="k-brows">
      <g class="k-brow-flat"><line class="k-stroke" x1="15" y1="12.5" x2="27" y2="12.5" /><line class="k-stroke" x1="37" y1="12.5" x2="49" y2="12.5" /></g>
      <g class="k-brow-raised"><line class="k-stroke" x1="15" y1="11" x2="27" y2="11" /><line class="k-stroke" x1="37" y1="11" x2="49" y2="11" /></g>
      <g class="k-brow-furrowed"><line class="k-stroke" x1="15" y1="11.5" x2="27" y2="14.5" /><line class="k-stroke" x1="37" y1="14.5" x2="49" y2="11.5" /></g>
      <g class="k-brow-worried"><line class="k-stroke" x1="15" y1="14.5" x2="27" y2="11.5" /><line class="k-stroke" x1="37" y1="11.5" x2="49" y2="14.5" /></g>
    </g>
    <g class="k-eyes">
      <g class="k-eye-open k-blink"><circle class="k-white" cx="21" cy="21" r="6" /><circle class="k-white" cx="43" cy="21" r="6" /><g class="k-pupils"><circle class="k-pupil" cx="21" cy="21" r="2.6" /><circle class="k-pupil" cx="43" cy="21" r="2.6" /></g></g>
      <g class="k-eye-wide"><circle class="k-white" cx="21" cy="21" r="7.4" /><circle class="k-white" cx="43" cy="21" r="7.4" /><circle class="k-pupil" cx="21" cy="21" r="3" /><circle class="k-pupil" cx="43" cy="21" r="3" /></g>
      <g class="k-eye-closed"><line class="k-stroke" x1="15" y1="22" x2="27" y2="22" /><line class="k-stroke" x1="37" y1="22" x2="49" y2="22" /></g>
      <g class="k-eye-happy"><path class="k-stroke k-nofill" d="M15 24 Q21 15 27 24" /><path class="k-stroke k-nofill" d="M37 24 Q43 15 49 24" /></g>
      <g class="k-eye-worried"><circle class="k-white" cx="21" cy="22" r="6" /><circle class="k-white" cx="43" cy="22" r="6" /><circle class="k-pupil" cx="21" cy="24" r="2.6" /><circle class="k-pupil" cx="43" cy="24" r="2.6" /></g>
    </g>
    <g class="k-mouth">
      <path class="k-stroke k-nofill k-mouth-smile" d="M36 38 Q43 46 50 38" />
      <line class="k-stroke k-mouth-flat" x1="37" y1="42" x2="49" y2="42" />
      <circle class="k-pupil k-mouth-small" cx="43" cy="42" r="2.6" />
      <ellipse class="k-pupil k-mouth-open" cx="43" cy="42" rx="5.5" ry="5" />
      <ellipse class="k-pupil k-mouth-talk" cx="43" cy="42" rx="5.5" ry="3.2" />
      <path class="k-stroke k-nofill k-mouth-frown" d="M36 46 Q43 38 50 46" />
    </g>
  </g></g>
</svg>`;

/** How long "Done" lingers before Kraty settles back to idle. */
const FINISHED_MS = 4000;
const LOOK_MIN_MS = 4000;
const LOOK_SPAN_MS = 6000;

export class Kraty {
  private signals: KratySignals = INITIAL_SIGNALS;
  private enabled = false;
  private shown: KratyState | null = null;
  private finishedTimer: number | undefined;
  private lookTimer: number | undefined;
  private readonly face: HTMLElement;
  private readonly bubble: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    this.root.setAttribute("aria-hidden", "true");
    this.face = document.createElement("div");
    this.face.className = "kraty-face";
    this.face.innerHTML = SVG;
    this.bubble = document.createElement("div");
    this.bubble.className = "kraty-bubble";
    this.root.append(this.face, this.bubble);
    // The loop stops while the sidebar is hidden.
    document.addEventListener("visibilitychange", () => this.schedule());
    this.apply();
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.root.hidden = !on;
    this.shown = null;
    this.apply();
  }

  feed(event: KratyEvent): void {
    this.signals = reduceSignals(this.signals, event);
    this.apply();
  }

  private apply(): void {
    const state = stateOf(this.signals);
    if (state !== "finished") window.clearTimeout(this.finishedTimer);
    if (this.enabled && state !== this.shown) {
      this.shown = state;
      const x = EXPRESSIONS[state];
      const d = this.root.dataset;
      d.state = state;
      d.eyes = x.eyes;
      d.brows = x.brows;
      d.mouth = x.mouth;
      const key = BUBBLE_KEYS[state];
      this.bubble.textContent = key ? t(key) : "";
      this.bubble.hidden = !key;
      if (state === "finished") {
        this.finishedTimer = window.setTimeout(() => {
          this.signals = { ...this.signals, finished: false };
          this.apply();
        }, FINISHED_MS);
      }
    }
    this.schedule();
  }

  /** Occasional look-around; paused when disabled or the page is hidden. */
  private schedule(): void {
    window.clearTimeout(this.lookTimer);
    const live = this.enabled && !document.hidden;
    this.root.classList.toggle("paused", !live);
    if (!live) return;
    this.lookTimer = window.setTimeout(() => {
      const dir = ["left", "right", "center"][Math.floor(Math.random() * 3)];
      this.root.dataset.look = dir;
      this.schedule();
    }, LOOK_MIN_MS + Math.random() * LOOK_SPAN_MS);
  }
}
