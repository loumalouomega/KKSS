/**
 * The Help menu's windows (License + in-app Manual) — glue pins that keep the
 * wiring from drifting the way the chat policy test pins its table: i18n keys
 * for both locales, the two menu items with their services, and the License
 * page's own contract (preload script, close button, CSP, i18n markers).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(__dirname, "..");
const en = JSON.parse(fs.readFileSync(path.join(root, "app/shared/i18n/en.json"), "utf8"));
const es = JSON.parse(fs.readFileSync(path.join(root, "app/shared/i18n/es.json"), "utf8"));
const menuSource = fs.readFileSync(path.join(root, "app/main/menu.ts"), "utf8");
const licenseHtml = fs.readFileSync(
  path.join(root, "app/renderer/license/license.html"),
  "utf8",
);

describe("the Help menu entries", () => {
  const menuKeys = ["&Help", "KKSS Manual…", "KKSS Documentation", "License…", "What's New…", "About KKSS…"];

  it("has its labels in both locales", () => {
    for (const key of menuKeys) {
      expect(en[key], `en missing "${key}"`).toBeTruthy();
      expect(es[key], `es missing "${key}"`).toBeTruthy();
    }
  });

  it("wires the two windows and the external links, separator last", () => {
    expect(menuSource).toContain('t("KKSS Manual…"), click: () => showManual()');
    expect(menuSource).toContain('label: t("License…"), click: () => showLicense()');
    expect(menuSource).toContain('t("KKSS Documentation"), click: () => void shell.openExternal(DOCS_URL)');
    expect(menuSource).toContain('t("What\'s New…"), click: () => showChangelog()');
    expect(menuSource).toContain('t("About KKSS…"), click: () => showAbout()');
    expect(menuSource.indexOf("License…")).toBeLessThan(menuSource.indexOf("What's New…"));
    expect(menuSource.indexOf("KKSS Manual…")).toBeLessThan(menuSource.indexOf("KKSS Documentation"));
  });

  it("uses the window titles the i18n keys name", () => {
    const manual = fs.readFileSync(path.join(root, "app/main/services/manual.ts"), "utf8");
    expect(manual).toContain('title: t("KKSS Manual")');
    expect(fs.readFileSync(path.join(root, "app/main/services/license.ts"), "utf8")).toContain(
      "loadURL(\"kkss://app/renderer/license/license.html\")",
    );
  });
});

describe("the license page", () => {
  it("loads the shared theme scripts from the kkss scheme", () => {
    expect(licenseHtml).toContain('<script src="./license.js"></script>');
    expect(licenseHtml).toContain('href="./license.css"');
    expect(licenseHtml).toContain('href="../theme/vscode-vars.css"');
    expect(licenseHtml).toContain("script-src kkss:");
  });

  it("carries the close button and i18n markers", () => {
    expect(licenseHtml).toContain('id="close-btn"');
    expect(licenseHtml).toContain('<title data-i18n="KKSS License">');
    expect(licenseHtml).toContain('id="license-text"');
    // version + text reach the renderer through license:init (see ipc.ts)
    expect(licenseHtml).toContain("version {0}");
    const ipc = fs.readFileSync(path.join(root, "app/main/ipc.ts"), "utf8");
    expect(ipc).toContain("interface LicenseInit");
    expect(ipc).toContain("type LicenseToHost = | { type: \"close\" };");
  });
});
