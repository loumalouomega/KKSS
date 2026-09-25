import "../localization";
/**
 * Modal picker renderer — the Electron replacement for VS Code's
 * showQuickPick (kind: "pick") and showInputBox (kind: "input").
 */
interface PickItem {
  label: string;
  description?: string;
}
type PickerInit =
  | { kind: "pick"; title: string; items: PickItem[] }
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

let items: PickItem[] = [];
let selected = 0;
let kind: PickerInit["kind"] = "pick";

function renderList(): void {
  listEl.innerHTML = "";
  listEl.setAttribute("aria-activedescendant", `picker-option-${selected}`);
  items.forEach((item, i) => {
    const row = document.createElement("div");
    row.id = `picker-option-${i}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === selected));
    row.className = "picker-item" + (i === selected ? " selected" : "");
    const label = document.createElement("span");
    label.textContent = item.label;
    row.appendChild(label);
    if (item.description) {
      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent = item.description;
      row.appendChild(desc);
    }
    row.addEventListener("click", () => api.post({ type: "picked", index: i }));
    listEl.appendChild(row);
  });
}

api.onInit((raw) => {
  const init = raw as PickerInit;
  kind = init.kind;
  titleEl.textContent = init.title;
  if (init.kind === "pick") {
    items = init.items;
    selected = 0;
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
    } else {
      api.post({ type: "picked", index: selected });
    }
  } else if (kind === "pick" && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
    selected = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : Math.min(items.length - 1, Math.max(0, selected + (e.key === "ArrowDown" ? 1 : -1)));
    renderList();
    document.getElementById(`picker-option-${selected}`)?.scrollIntoView({ block: "nearest" });
    e.preventDefault();
  }
});

export {};
