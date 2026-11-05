import "../localization";
import { t } from "../../shared/i18n";
/**
 * Bottom Output panel: a Terminal tab (any number of xterm.js sessions wired to
 * the main-process pty service) beside Messages, Progress and Log tabs and a
 * memory footer. The tabs are plain DOM inside this one view, so a hidden
 * terminal keeps running and keeps its scrollback.
 */
import type { OutToWebview, TermToWebview, OutputTab } from "../../main/ipc";
import type { Appearance } from "../appearance";
import { glyph, type KkssGlyphId } from "../glyphs";
import { Terminals } from "./terminals";
import { Output } from "./output";

declare global {
  interface Window {
    termApi: {
      post(message: unknown): void;
      onMessage(handler: (message: unknown) => void): void;
    };
    outApi: {
      post(message: unknown): void;
      onMessage(handler: (message: unknown) => void): void;
    };
  }
}

const term = window.termApi;
const out = window.outApi;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** xterm theme from the same --vscode-* variables the rest of the app uses —
 *  re-read on every appearance change, since the UI theme swaps them. */
function themeFromCss(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--vscode-editor-background", "#1e1e1e"),
    foreground: v("--vscode-editor-foreground", "#cccccc"),
    cursor: v("--vscode-editor-foreground", "#cccccc"),
    selectionBackground: v("--vscode-list-inactiveSelectionBackground", "#37373d"),
  };
}

const DEFAULT_FONT = "Consolas, 'Courier New', monospace";

/** Settings ▸ Terminal (font, scrollback, cursor), applied live. */
function terminalOptions() {
  const a: Appearance | undefined = window.kkssAppearance?.current();
  const o = a?.terminal;
  return {
    fontSize: o?.fontSize ?? 13,
    fontFamily: o?.fontFamily || DEFAULT_FONT,
    scrollback: o?.scrollback ?? 5000,
    cursorStyle: o?.cursorStyle ?? "block",
    cursorBlink: o?.cursorBlink ?? true,
    theme: themeFromCss(),
  };
}

// ---- tabs -------------------------------------------------------------------

const TABS: Array<{ id: OutputTab; label: string; glyph: KkssGlyphId }> = [
  { id: "terminal", label: t("Terminal"), glyph: "terminal" },
  { id: "messages", label: t("Messages"), glyph: "messageSquare" },
  { id: "progress", label: t("Progress"), glyph: "activity" },
  { id: "log", label: t("Log"), glyph: "history" },
];

const tabsEl = $("tabs");
const badges = new Map<OutputTab, HTMLElement>();
for (const tab of TABS) {
  const button = document.createElement("button");
  button.type = "button";
  button.id = `tab-${tab.id}`;
  button.dataset.tab = tab.id;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-controls", `pane-${tab.id}`);
  button.innerHTML = `${glyph(tab.glyph, "sm")}<span>${tab.label}</span>`;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.hidden = true;
  button.appendChild(badge);
  badges.set(tab.id, badge);
  button.addEventListener("click", () => showTab(tab.id));
  tabsEl.appendChild(button);
}

let current: OutputTab = "terminal";

function showTab(tab: OutputTab): void {
  current = tab;
  for (const button of tabsEl.querySelectorAll<HTMLButtonElement>("button")) {
    const on = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
  }
  for (const pane of document.querySelectorAll<HTMLElement>(".pane")) pane.hidden = pane.id !== `pane-${tab}`;
  for (const group of document.querySelectorAll<HTMLElement>(".actions")) group.hidden = group.dataset.for !== tab;
  output.setVisibleTab(tab);
  if (tab === "terminal") {
    terminals.fitActive();
    terminals.focusActive();
  }
}

tabsEl.addEventListener("keydown", (event) => {
  const at = TABS.findIndex((x) => x.id === current);
  let next = at;
  if (event.key === "ArrowRight") next = (at + 1) % TABS.length;
  else if (event.key === "ArrowLeft") next = (at - 1 + TABS.length) % TABS.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = TABS.length - 1;
  else return;
  event.preventDefault();
  showTab(TABS[next].id);
  $(`tab-${TABS[next].id}`).focus();
});

function setBadge(tab: OutputTab, count: number, error = false): void {
  const badge = badges.get(tab)!;
  badge.hidden = count === 0;
  badge.textContent = String(count);
  badge.classList.toggle("error", error);
}

// ---- terminals --------------------------------------------------------------

const terminals = new Terminals({
  stack: $("terminal"),
  list: $("term-list"),
  post: (m) => term.post(m),
  options: terminalOptions,
  onCount: (count) => {
    $("term-empty").hidden = count > 0;
    ($("term-kill") as HTMLButtonElement).disabled = count === 0;
  },
});

// ---- messages / progress / log ----------------------------------------------

const output = new Output({
  post: (m) => out.post(m),
  messages: $("messages"),
  log: $("log"),
  progress: $("progress"),
  memory: $("memory"),
  onBadges: (running, errors) => {
    setBadge("progress", running);
    setBadge("messages", errors, true);
  },
  onTab: (tab) => showTab(tab),
});

$("messages").dataset.empty = t("No messages yet.");
$("progress").dataset.empty = t("Nothing is running.");
$("log").dataset.empty = t("The log is empty.");

// ---- chrome -----------------------------------------------------------------

const button = (id: string, glyphId: KkssGlyphId, label: string, run: () => void) => {
  const el = $(id);
  el.innerHTML = glyph(glyphId, "sm");
  el.title = label;
  el.setAttribute("aria-label", label);
  el.addEventListener("click", run);
};
button("term-new", "plus", t("New terminal"), () => terminals.newTerminal());
button("term-kill", "trash", t("Kill the selected terminal"), () => terminals.closeActive());
button("messages-copy", "copy", t("Copy messages"), () => output.copy("messages"));
button("messages-clear", "x", t("Clear messages"), () => output.clear("messages"));
button("log-copy", "copy", t("Copy log"), () => output.copy("log"));
button("log-clear", "x", t("Clear log"), () => output.clear("log"));
$("progress-clear").textContent = t("Clear finished");
$("progress-clear").addEventListener("click", () => output.clear("progress"));
$("term-empty-new").textContent = t("New terminal");
$("term-empty-new").addEventListener("click", () => terminals.newTerminal());
$("hide-btn").innerHTML = `${glyph("x", "sm")}<span>${t("Hide")}</span>`;
$("hide-btn").addEventListener("click", () => term.post({ type: "hide" }));

const filter = $("level-filter") as HTMLSelectElement;
for (const [value, label] of [["all", t("All")], ["info", t("Info")], ["warn", t("Warnings")], ["error", t("Errors")]] as const) {
  filter.add(new Option(label, value));
}
filter.addEventListener("change", () => output.setLevelFilter(filter.value as "all" | "info" | "warn" | "error"));
filter.setAttribute("aria-label", t("Show"));

window.kkssAppearance?.onChange(() => terminals.applyOptions());
window.addEventListener("focus", () => { if (current === "terminal") terminals.focusActive(); });

term.onMessage((raw) => terminals.handle(raw as TermToWebview));
out.onMessage((raw) => output.handle(raw as OutToWebview));

showTab("terminal");
const size = terminals.probe();
term.post({ type: "termReady", cols: size.cols, rows: size.rows });
out.post({ type: "outReady" });
