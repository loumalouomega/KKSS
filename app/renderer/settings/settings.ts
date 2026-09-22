/**
 * Settings page renderer. Schema-driven: main sends the registry
 * (services/settings/registry.ts) once, then a `rows` snapshot on every
 * change; this file only renders controls and posts edits back. It never
 * touches the stateStore and never receives a stored secret.
 */
import type { SettingsRowState, SettingsToWebview } from "../../main/ipc";
import type { SettingCategory, SettingEntry } from "../../main/services/settings/registry";
import { glyph } from "../glyphs";

declare global {
  interface Window {
    settingsApi: {
      post(message: unknown): void;
      onMessage(handler: (message: unknown) => void): void;
    };
  }
}

const api = window.settingsApi;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const nav = byId<HTMLElement>("nav");
const rowsEl = byId<HTMLElement>("rows");
const search = byId<HTMLInputElement>("search");
const countEl = byId<HTMLSpanElement>("count");
const emptyEl = byId<HTMLParagraphElement>("empty");
byId<HTMLSpanElement>("search-icon").innerHTML = glyph("search", "sm");

const APPLIES: Record<string, string> = {
  live: "Applies immediately",
  nextOpen: "Applies to documents opened from now on",
  nextRun: "Applies on the next run or load",
  nextShell: "Applies to the next terminal session",
  nextStart: "Applies on the next start",
};

interface Row {
  entry: SettingEntry;
  el: HTMLElement;
  /** Pushes a fresh state into the control (skipped while it has focus). */
  update(state: SettingsRowState): void;
}

let entries: SettingEntry[] = [];
const rows = new Map<string, Row>();
const sections = new Map<SettingCategory, HTMLElement>();
const navButtons = new Map<SettingCategory, HTMLButtonElement>();
let latest: Record<string, SettingsRowState> = {};

const post = (message: unknown) => api.post(message);
const set = (id: string, value: unknown) => post({ type: "set", id, value });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className = "btn btn-secondary btn-sm"): HTMLButtonElement {
  const b = el("button", className);
  b.type = "button";
  b.innerHTML = label;
  return b;
}

const focusedWithin = (node: HTMLElement) => node.contains(document.activeElement);

// ---- Controls, one per setting type ------------------------------------------

type Control = { node: HTMLElement; update(state: SettingsRowState): void };

function booleanControl(entry: SettingEntry): Control {
  const label = el("label", "check");
  const input = el("input");
  input.type = "checkbox";
  input.addEventListener("change", () => set(entry.id, input.checked));
  label.append(input, el("span", undefined, "Enabled"));
  return {
    node: label,
    update: (s) => {
      input.checked = s.value === true;
      input.disabled = s.managed;
    },
  };
}

function enumControl(entry: SettingEntry): Control {
  const select = el("select", "field");
  (entry.enum ?? []).forEach((value, i) => {
    const option = el("option", undefined, entry.enumLabels?.[i] ?? String(value));
    option.value = String(value);
    select.append(option);
  });
  // Numeric enums (interface scale) travel as strings; main's normalize() maps them back.
  select.addEventListener("change", () => set(entry.id, select.value));
  return {
    node: select,
    update: (s) => {
      select.value = String(s.value ?? "");
      select.disabled = s.managed;
    },
  };
}

function textControl(entry: SettingEntry, type: "text" | "number"): Control {
  const input = el("input", "field text");
  input.type = type;
  input.spellcheck = false;
  if (entry.placeholder) input.placeholder = entry.placeholder;
  if (entry.min !== undefined) input.min = String(entry.min);
  if (entry.max !== undefined) input.max = String(entry.max);
  const commit = () => set(entry.id, type === "number" ? (input.value === "" ? undefined : Number(input.value)) : input.value);
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
  return {
    node: input,
    update: (s) => {
      input.disabled = s.managed;
      if (focusedWithin(input)) return;
      input.value = s.value === undefined ? "" : String(s.value);
    },
  };
}

function pathControl(entry: SettingEntry): Control {
  const wrap = el("div", "inline");
  const text = textControl(entry, "text");
  const browse = button(`${glyph("folder", "sm")}<span>Browse…</span>`);
  browse.addEventListener("click", () => post({ type: "browse", id: entry.id }));
  wrap.append(text.node, browse);
  return {
    node: wrap,
    update: (s) => {
      text.update(s);
      browse.disabled = s.managed;
    },
  };
}

function colorControl(entry: SettingEntry): Control {
  const wrap = el("div", "inline");
  const input = el("input", "color");
  input.type = "color";
  const code = el("span", "ui-num");
  input.addEventListener("input", () => (code.textContent = input.value));
  input.addEventListener("change", () => set(entry.id, input.value));
  wrap.append(input, code);
  return {
    node: wrap,
    update: (s) => {
      input.disabled = s.managed;
      input.value = String(s.value ?? "#000000");
      code.textContent = input.value;
    },
  };
}

/** A string list (problemtype folders): one input per item, add/remove. */
function listControl(entry: SettingEntry): Control {
  const wrap = el("div", "list");
  let managed = false;
  const collect = () =>
    [...wrap.querySelectorAll<HTMLInputElement>("input")].map((i) => i.value.trim()).filter(Boolean);
  const render = (items: string[]) => {
    wrap.replaceChildren();
    for (const item of items) {
      const line = el("div", "inline");
      const input = el("input", "field text");
      input.value = item;
      input.disabled = managed;
      input.addEventListener("change", () => set(entry.id, collect()));
      const remove = button(glyph("trash", "sm"), "icon-btn");
      remove.title = "Remove";
      remove.disabled = managed;
      remove.addEventListener("click", () => {
        line.remove();
        set(entry.id, collect());
      });
      line.append(input, remove);
      wrap.append(line);
    }
    const add = button(`${glyph("plus", "sm")}<span>Add item</span>`);
    add.disabled = managed;
    add.addEventListener("click", () => {
      render([...collect(), ""]);
      const inputs = wrap.querySelectorAll<HTMLInputElement>("input");
      inputs[inputs.length - 1]?.focus();
    });
    wrap.append(add);
  };
  return {
    node: wrap,
    update: (s) => {
      managed = s.managed;
      if (!focusedWithin(wrap)) render(Array.isArray(s.value) ? s.value : []);
    },
  };
}

/** A string map (extra environment): key/value rows, add/remove. */
function mapControl(entry: SettingEntry): Control {
  const wrap = el("div", "list");
  let managed = false;
  const collect = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of wrap.querySelectorAll<HTMLElement>(".pair")) {
      const [k, v] = line.querySelectorAll<HTMLInputElement>("input");
      if (k.value.trim()) out[k.value.trim()] = v.value;
    }
    return out;
  };
  const render = (pairs: Array<[string, string]>) => {
    wrap.replaceChildren();
    for (const [key, value] of pairs) {
      const line = el("div", "inline pair");
      const k = el("input", "field text key");
      k.placeholder = "NAME";
      k.value = key;
      const v = el("input", "field text");
      v.placeholder = "value";
      v.value = value;
      for (const input of [k, v]) {
        input.spellcheck = false;
        input.disabled = managed;
        input.addEventListener("change", () => set(entry.id, collect()));
      }
      const remove = button(glyph("trash", "sm"), "icon-btn");
      remove.title = "Remove";
      remove.disabled = managed;
      remove.addEventListener("click", () => {
        line.remove();
        set(entry.id, collect());
      });
      line.append(k, v, remove);
      wrap.append(line);
    }
    const add = button(`${glyph("plus", "sm")}<span>Add variable</span>`);
    add.disabled = managed;
    add.addEventListener("click", () => {
      render([...Object.entries(collect()), ["", ""]]);
      const keys = wrap.querySelectorAll<HTMLInputElement>("input.key");
      keys[keys.length - 1]?.focus();
    });
    wrap.append(add);
  };
  return {
    node: wrap,
    update: (s) => {
      managed = s.managed;
      if (!focusedWithin(wrap)) {
        const value = s.value && typeof s.value === "object" && !Array.isArray(s.value) ? s.value : {};
        render(Object.entries(value as Record<string, string>));
      }
    },
  };
}

/** A secret: write-only. Main reports only whether one is stored. */
function secretControl(entry: SettingEntry): Control {
  const wrap = el("div", "inline");
  const input = el("input", "field text");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = entry.placeholder ?? "";
  const save = button("Save", "btn btn-primary btn-sm");
  const clear = button("Clear");
  const state = el("span", "secret-state");
  const commit = () => {
    if (!input.value.trim()) return;
    set(entry.id, input.value);
    input.value = "";
  };
  save.addEventListener("click", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
  clear.addEventListener("click", () => post({ type: "reset", id: entry.id }));
  wrap.append(input, save, clear, state);
  return {
    node: wrap,
    update: (s) => {
      for (const c of [input, save, clear]) c.disabled = s.managed;
      clear.disabled = s.managed || !s.isSet;
      state.textContent = s.isSet ? "Stored" : "Not set";
    },
  };
}

function actionControl(entry: SettingEntry): Control {
  const wrap = el("div", "inline");
  const buttons = (entry.actions ?? []).map((a) => {
    const b = button(a.label, a.primary ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm");
    b.addEventListener("click", () => post({ type: "action", id: entry.id, action: a.id }));
    wrap.append(b);
    return [a.id, b] as const;
  });
  return {
    node: wrap,
    update: (s) => {
      for (const [id, b] of buttons) b.disabled = s.managed || !!s.disabledActions?.includes(id);
    },
  };
}

function controlFor(entry: SettingEntry): Control {
  switch (entry.type) {
    case "boolean":
      return booleanControl(entry);
    case "enum":
      return enumControl(entry);
    case "number":
      return textControl(entry, "number");
    case "color":
      return colorControl(entry);
    case "path":
      return pathControl(entry);
    case "stringList":
      return listControl(entry);
    case "stringMap":
      return mapControl(entry);
    case "secret":
      return secretControl(entry);
    case "action":
      return actionControl(entry);
    default:
      return textControl(entry, "text");
  }
}

// ---- Rows and layout -----------------------------------------------------------

function buildRow(entry: SettingEntry): Row {
  const row = el("section", "row");
  row.dataset.id = entry.id;
  const head = el("div", "row-head");
  const label = el("span", "row-label", entry.label);
  const id = el("span", "row-id ui-num", entry.id);
  const managedBadge = el("span", "ui-badge", "Set by the environment");
  managedBadge.hidden = true;
  const reset = button(glyph("rotateCcw", "sm"), "icon-btn reset");
  reset.title = "Reset to default";
  reset.setAttribute("aria-label", `Reset ${entry.label} to default`);
  reset.addEventListener("click", () => post({ type: "reset", id: entry.id }));
  head.append(label, id, managedBadge, reset);

  const desc = el("p", "row-desc", entry.description);
  const control = controlFor(entry);
  const status = el("p", "row-status");
  const warning = el("p", "row-warning");
  const error = el("p", "row-error");
  error.setAttribute("role", "alert");
  const hint = el("p", "row-hint", entry.applies ? APPLIES[entry.applies] : "");
  row.append(head, desc, control.node, status, warning, error, hint);

  return {
    entry,
    el: row,
    update: (s) => {
      control.update(s);
      managedBadge.hidden = !s.managed;
      // A reset makes no sense for an action row, a managed value or the default.
      reset.hidden = entry.type === "action" || entry.type === "secret" || s.managed || !s.modified;
      status.textContent = s.status ?? "";
      status.hidden = !s.status;
      warning.textContent = s.warning ?? "";
      warning.hidden = !s.warning;
      error.hidden = true;
      hint.hidden = !entry.applies || entry.type === "action";
    },
  };
}

function render(categories: readonly SettingCategory[]): void {
  nav.replaceChildren();
  rowsEl.replaceChildren();
  rows.clear();
  sections.clear();
  navButtons.clear();
  for (const category of categories) {
    const inCategory = entries.filter((e) => e.category === category);
    if (inCategory.length === 0) continue;
    const section = el("div", "category");
    section.append(el("h2", "eyebrow", category));
    for (const entry of inCategory) {
      const row = buildRow(entry);
      rows.set(entry.id, row);
      section.append(row.el);
      const state = latest[entry.id];
      if (state) row.update(state);
    }
    rowsEl.append(section);
    sections.set(category, section);

    const b = button(category, "nav-item");
    b.addEventListener("click", () => {
      section.scrollIntoView({ block: "start" });
      setActiveNav(category);
    });
    nav.append(b);
    navButtons.set(category, b);
  }
  applyFilter();
}

function setActiveNav(category: SettingCategory | undefined): void {
  for (const [c, b] of navButtons) b.setAttribute("aria-current", String(c === category));
}

/** Search: every term must match the label, id, description or category. */
function applyFilter(): void {
  const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const row of rows.values()) {
    const haystack = `${row.entry.label} ${row.entry.id} ${row.entry.description} ${row.entry.category}`.toLowerCase();
    const match = terms.every((t) => haystack.includes(t));
    row.el.hidden = !match;
    if (match) shown++;
  }
  for (const [category, section] of sections) {
    const visible = [...section.querySelectorAll<HTMLElement>(".row")].some((r) => !r.hidden);
    section.hidden = !visible;
    navButtons.get(category)!.hidden = !visible;
  }
  countEl.textContent = terms.length ? `${shown} found` : "";
  emptyEl.hidden = shown > 0;
}

// Highlight the category whose section is at the top of the scroll area.
rowsEl.addEventListener("scroll", () => {
  const top = rowsEl.getBoundingClientRect().top;
  let current: SettingCategory | undefined;
  for (const [category, section] of sections) {
    if (section.hidden) continue;
    if (section.getBoundingClientRect().top - top <= 24) current = category;
  }
  setActiveNav(current ?? [...sections.keys()].find((c) => !sections.get(c)!.hidden));
});

search.addEventListener("input", applyFilter);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    search.focus();
    search.select();
  } else if (e.key === "Escape" && document.activeElement === search && search.value) {
    search.value = "";
    applyFilter();
  }
});

api.onMessage((raw) => {
  const msg = raw as SettingsToWebview;
  switch (msg.type) {
    case "schema":
      entries = msg.entries;
      render(msg.categories);
      setActiveNav(msg.categories[0]);
      break;
    case "rows":
      latest = msg.rows;
      for (const [id, state] of Object.entries(msg.rows)) rows.get(id)?.update(state);
      break;
    case "error": {
      const error = rows.get(msg.id)?.el.querySelector<HTMLElement>(".row-error");
      if (error) {
        error.textContent = msg.message;
        error.hidden = false;
      }
      break;
    }
  }
});

search.focus();
api.post({ type: "settingsReady" });
