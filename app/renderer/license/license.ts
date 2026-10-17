import "../localization";
import { t } from "../../shared/i18n";
/** License dialog renderer — one init message (version + license text). */
import type { LicenseInit } from "../../main/ipc";

declare global {
  interface Window {
    licenseApi: {
      post(message: unknown): void;
      onInit(handler: (init: unknown) => void): void;
    };
  }
}

const api = window.licenseApi;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const subtitle = byId<HTMLElement>("subtitle");
const textEl = byId<HTMLElement>("license-text");

subtitle.textContent = t("Full license text, as shipped with this build (version {0}).", {
  0: "…",
});
api.onInit((raw) => {
  const init = raw as LicenseInit;
  subtitle.textContent = t(
    "Full license text, as shipped with this build (version {0}).",
    { 0: init.version },
  );
  textEl.textContent = init.text;
});

byId("close-btn").addEventListener("click", () => api.post({ type: "close" }));
