/** What's New dialog renderer — renders the CHANGELOG.md entries pushed at init. */
import type { WhatsNewInit } from "../../main/ipc";

declare global {
  interface Window {
    whatsNewApi: {
      post(message: unknown): void;
      onInit(handler: (init: unknown) => void): void;
    };
  }
}

const api = window.whatsNewApi;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const versionEl = byId<HTMLElement>("version");
const entriesEl = byId<HTMLDivElement>("entries");

api.onInit((raw) => {
  const init = raw as WhatsNewInit;
  versionEl.textContent = `v${init.version}`;
  entriesEl.innerHTML = "";
  for (const entry of init.entries) {
    const section = document.createElement("section");

    const heading = document.createElement("h2");
    heading.textContent = `v${entry.version} `;
    const date = document.createElement("span");
    date.className = "date";
    date.textContent = entry.date;
    heading.appendChild(date);
    section.appendChild(heading);

    const list = document.createElement("ul");
    for (const bullet of entry.bullets) {
      const item = document.createElement("li");
      item.textContent = bullet;
      list.appendChild(item);
    }
    section.appendChild(list);

    entriesEl.appendChild(section);
  }
});

byId<HTMLButtonElement>("close-btn").addEventListener("click", () => api.post({ type: "close" }));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.post({ type: "close" });
});

export {};
