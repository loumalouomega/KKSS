/** Home screen: config-driven main menu shown on launch (see homeConfig.ts). */
import { HOME_BUTTONS } from "./homeConfig";

declare global {
  interface Window {
    homeApi: {
      post(message: unknown): void;
      onMessage(handler: (message: unknown) => void): void;
    };
  }
}

const api = window.homeApi;
const menu = document.getElementById("menu") as HTMLDivElement;

for (const { action, label, description } of HOME_BUTTONS) {
  const button = document.createElement("button");
  button.className = "menu-btn";
  button.title = description;

  const title = document.createElement("span");
  title.className = "menu-btn-label";
  title.textContent = label;
  const detail = document.createElement("span");
  detail.className = "menu-btn-description";
  detail.textContent = description;
  button.append(title, detail);

  button.addEventListener("click", () => api.post({ type: "action", action }));
  menu.appendChild(button);
}

api.post({ type: "homeReady" });
