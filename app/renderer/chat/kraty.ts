/**
 * Kraty's DOM half: draws the face once, then only flips data-attributes that
 * chat.css keys on (the page's CSP allows no `style=`). Presentation only —
 * see kratyCore.ts. Off unless Settings ▸ LLM Assistant ▸ Kraty is on.
 */
import { t } from "../../shared/i18n";
import { BUBBLE_KEYS, EXPRESSIONS, INITIAL_SIGNALS, reduceSignals, stateOf } from "./kratyCore";
import type { KratyEvent, KratySignals, KratyState } from "./kratyCore";

const SVG = `
<svg viewBox="0 0 64 64" width="44" height="44" aria-hidden="true" focusable="false">
  <g class="k-body">
    <g class="k-mesh">
      <polygon class="k-facet k-f0" points="32.0,8.0 54.5,21.0 32.0,21.0" />
      <polygon class="k-facet k-f1" points="54.5,21.0 43.3,27.5 32.0,21.0" />
      <polygon class="k-facet k-f2" points="32.0,34.0 32.0,21.0 43.3,27.5" />
      <polygon class="k-facet k-f3" points="54.5,21.0 54.5,47.0 43.3,27.5" />
      <polygon class="k-facet k-f0" points="54.5,47.0 43.3,40.5 43.3,27.5" />
      <polygon class="k-facet k-f1" points="32.0,34.0 43.3,27.5 43.3,40.5" />
      <polygon class="k-facet k-f2" points="54.5,47.0 32.0,60.0 43.3,40.5" />
      <polygon class="k-facet k-f3" points="32.0,60.0 32.0,47.0 43.3,40.5" />
      <polygon class="k-facet k-f0" points="32.0,34.0 43.3,40.5 32.0,47.0" />
      <polygon class="k-facet k-f1" points="32.0,60.0 9.5,47.0 32.0,47.0" />
      <polygon class="k-facet k-f2" points="9.5,47.0 20.7,40.5 32.0,47.0" />
      <polygon class="k-facet k-f3" points="32.0,34.0 32.0,47.0 20.7,40.5" />
      <polygon class="k-facet k-f0" points="9.5,47.0 9.5,21.0 20.7,40.5" />
      <polygon class="k-facet k-f1" points="9.5,21.0 20.7,27.5 20.7,40.5" />
      <polygon class="k-facet k-f2" points="32.0,34.0 20.7,40.5 20.7,27.5" />
      <polygon class="k-facet k-f3" points="9.5,21.0 32.0,8.0 20.7,27.5" />
      <polygon class="k-facet k-f0" points="32.0,8.0 32.0,21.0 20.7,27.5" />
      <polygon class="k-facet k-f1" points="32.0,34.0 20.7,27.5 32.0,21.0" />
      <circle class="k-node" cx="54.5" cy="21.0" r="1.6" /><circle class="k-node" cx="54.5" cy="47.0" r="1.6" /><circle class="k-node" cx="32.0" cy="60.0" r="1.6" /><circle class="k-node" cx="9.5" cy="47.0" r="1.6" /><circle class="k-node" cx="9.5" cy="21.0" r="1.6" /><circle class="k-tip" cx="32.0" cy="8.0" r="2.4" />
    </g>
    <g class="k-brows">
      <g class="k-brow-flat"><line class="k-stroke" x1="16" y1="26" x2="26" y2="26" /><line class="k-stroke" x1="38" y1="26" x2="48" y2="26" /></g>
      <g class="k-brow-raised"><line class="k-stroke" x1="16" y1="23" x2="26" y2="23" /><line class="k-stroke" x1="38" y1="23" x2="48" y2="23" /></g>
      <g class="k-brow-furrowed"><line class="k-stroke" x1="16" y1="24" x2="26" y2="28" /><line class="k-stroke" x1="38" y1="28" x2="48" y2="24" /></g>
      <g class="k-brow-worried"><line class="k-stroke" x1="16" y1="28" x2="26" y2="24" /><line class="k-stroke" x1="38" y1="24" x2="48" y2="28" /></g>
    </g>
    <g class="k-eyes">
      <g class="k-eye-open k-blink"><circle class="k-white" cx="21" cy="34" r="6" /><circle class="k-white" cx="43" cy="34" r="6" /><g class="k-pupils"><circle class="k-pupil" cx="21" cy="34" r="2.6" /><circle class="k-pupil" cx="43" cy="34" r="2.6" /></g></g>
      <g class="k-eye-wide"><circle class="k-white" cx="21" cy="34" r="7.5" /><circle class="k-white" cx="43" cy="34" r="7.5" /><circle class="k-pupil" cx="21" cy="34" r="3" /><circle class="k-pupil" cx="43" cy="34" r="3" /></g>
      <g class="k-eye-closed"><line class="k-stroke" x1="15" y1="35" x2="27" y2="35" /><line class="k-stroke" x1="37" y1="35" x2="49" y2="35" /></g>
      <g class="k-eye-happy"><path class="k-stroke k-nofill" d="M15 37 Q21 29 27 37" /><path class="k-stroke k-nofill" d="M37 37 Q43 29 49 37" /></g>
      <g class="k-eye-worried"><circle class="k-white" cx="21" cy="35" r="6" /><circle class="k-white" cx="43" cy="35" r="6" /><circle class="k-pupil" cx="21" cy="37" r="2.6" /><circle class="k-pupil" cx="43" cy="37" r="2.6" /></g>
    </g>
    <g class="k-mouth">
      <path class="k-stroke k-nofill k-mouth-smile" d="M24 45 Q32 52 40 45" />
      <line class="k-stroke k-mouth-flat" x1="26" y1="47" x2="38" y2="47" />
      <circle class="k-pupil k-mouth-small" cx="32" cy="47" r="2.4" />
      <ellipse class="k-pupil k-mouth-open" cx="32" cy="47" rx="5" ry="4.5" />
      <ellipse class="k-pupil k-mouth-talk" cx="32" cy="47" rx="5" ry="3" />
      <path class="k-stroke k-nofill k-mouth-frown" d="M24 50 Q32 43 40 50" />
    </g>
  </g>
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
