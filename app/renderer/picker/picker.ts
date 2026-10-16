import "../localization";
import { translate } from "../../shared/i18n";
/**
 * Modal picker renderer — the Electron replacement for VS Code's
 * showQuickPick (kind: "pick"; `multi` backs `canPickMany`) and showInputBox
 * (kind: "input").
 */
interface PickItem {
  label: string;
  description?: string;
}
type PickerInit =
  | { kind: "pick"; title: string; items: PickItem[]; multi?: boolean }
  | { kind: "input"; title: string; prompt?: string; value?: string; placeholder?: string };

declare global {
  interface Window {
    pickerApi: {
      post(message: unknown): void;
      onInit(handler: (init: unknown) => void): void;
    };
  }
}

const api = window.pickerApi;
const titleEl = document.getElementById("picker-title") as HTMLDivElement;
const inputEl = document.getElementById("picker-input") as HTMLInputElement;
const listEl = document.getElementById("picker-list") as HTMLDivElement;
const hintEl = document.getElementById("picker-hint") as HTMLDivElement;

let items: PickItem[] = [];
let selected = 0;
let kind: PickerInit["kind"] = "pick";
let multi = false;
const checked = new Set<number>();

function renderList(): void {
  listEl.innerHTML = "";
  listEl.setAttribute("aria-activedescendant", `picker-option-${selected}`);
  items.forEach((item, i) => {
    const row = document.createElement("div");
    row.id = `picker-option-${i}`;
    row.setAttribute("role", "option");
    const isChecked = multi && checked.has(i);
    row.setAttribute("aria-selected", String(multi ? isChecked : i === selected));
    row.className = "picker-item" + (i === selected ? " selected" : "") + (isChecked ? " checked" : "");
    if (multi) {
      const box = document.createElement("span");
      box.className = "check";
      box.setAttribute("aria-hidden", "true");
      box.textContent = isChecked ? "✓" : "";
      row.appendChild(box);
    }
    const label = document.createElement("span");
    label.textContent = item.label;
    row.appendChild(label);
    if (item.description) {
      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent = item.description;
      row.appendChild(desc);
    }
    row.addEventListener("click", () => {
      // Single-pick resolves on the first click (unchanged); a multi-pick
      // click only toggles, Enter confirms the checked set.
      if (multi) toggle(i);
      else api.post({ type: "picked", index: i });
    });
    listEl.appendChild(row);
  });
}

function toggle(index: number): void {
  if (checked.has(index)) checked.delete(index);
  else checked.add(index);
  selected = index;
  renderList();
}

api.onInit((raw) => {
  const init = raw as PickerInit;
  kind = init.kind;
  titleEl.textContent = init.title;
  if (init.kind === "pick") {
    items = init.items;
    multi = init.multi === true;
    checked.clear();
    selected = 0;
    if (multi) {
      listEl.setAttribute("aria-multiselectable", "true");
      hintEl.textContent = translate("Space to select · Enter to confirm · Esc to cancel");
    }
    renderList();
    listEl.focus();
  } else {
    inputEl.hidden = false;
    inputEl.value = init.value ?? "";
    inputEl.placeholder = init.placeholder ?? "";
    if (init.prompt) titleEl.textContent = init.prompt;
    inputEl.focus();
    inputEl.select();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    api.post({ type: "cancel" });
  } else if (e.key === "Enter") {
    if (kind === "input") {
      api.post({ type: "input", value: inputEl.value });
    } else if (multi) {
      api.post({ type: "pickedMany", indexes: [...checked].sort((a, b) => a - b) });
    } else {
      api.post({ type: "picked", index: selected });
    }
  } else if (e.key === " " && kind === "pick" && multi) {
    toggle(selected);
    e.preventDefault();
  } else if (kind === "pick" && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
    selected = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : Math.min(items.length - 1, Math.max(0, selected + (e.key === "ArrowDown" ? 1 : -1)));
    renderList();
    document.getElementById(`picker-option-${selected}`)?.scrollIntoView({ block: "nearest" });
    e.preventDefault();
  }
});

export {};
