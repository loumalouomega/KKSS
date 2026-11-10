import { describe, expect, it } from "vitest";
import { ALLOWED_PERMISSIONS, allowNavigation, externalOpen, permissionAllowed } from "../app/main/services/webGuardCore";

describe("navigation", () => {
  it("allows the app's own pages and files", () => {
    for (const u of ["kkss://app/renderer/home/index.html", "kkss-file://local/abc", "about:blank", "devtools://devtools/bundled/x.html"])
      expect(allowNavigation(u), u).toBe(true);
  });
  it("keeps the manual host to the manual", () => {
    expect(allowNavigation("kkss://docs/KKSS/guide/")).toBe(false);
    expect(allowNavigation("kkss://docs/KKSS/guide/", { docsView: true })).toBe(true);
  });
  it("refuses everything else", () => {
    for (const u of ["https://example.com/", "http://127.0.0.1:1/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "kkss://evil/x", "not a url", ""])
      expect(allowNavigation(u, { docsView: true }), u).toBe(false);
  });
});

describe("external open", () => {
  it("forwards web and mail links only", () => {
    for (const u of ["https://github.com/loumalouomega/KKSS", "http://example.com", "mailto:a@b.c"]) expect(externalOpen(u), u).toBe(true);
    for (const u of ["file:///etc/passwd", "javascript:1", "data:text/html,x", "kkss://app/x", "kkss-file://local/x", "ssh://host", "garbage"])
      expect(externalOpen(u), u).toBe(false);
  });
});

describe("permissions", () => {
  it("denies by default", () => {
    for (const p of ["media", "geolocation", "notifications", "clipboard-read", "hid", "serial", "usb", "midi", "openExternal", "constructor", "toString"])
      expect(permissionAllowed(p), p).toBe(false);
  });
  it("allows only the listed ones, each with a stated reason", () => {
    for (const [p, why] of Object.entries(ALLOWED_PERMISSIONS)) {
      expect(permissionAllowed(p)).toBe(true);
      expect(why.length).toBeGreaterThan(5);
    }
  });
});
