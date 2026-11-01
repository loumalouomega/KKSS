import { describe, expect, it } from "vitest";
import { buildBundle, crc32, redactPaths, redactSettings, textFile, zipStore } from "../app/main/services/diagnosticsCore";

describe("diagnostics bundle", () => {
  it("replaces home and temp paths in both slash styles", () => {
    expect(redactPaths("/home/ana/x C:\\Users\\ana\\y /tmp/k", { home: "/home/ana", tmp: "/tmp" })).toBe("<HOME>/x C:\\Users\\ana\\y <TMP>/k");
    expect(redactPaths("C:\\Users\\ana\\y", { home: "C:\\Users\\ana" })).toBe("<HOME>\\y");
  });
  it("never reads a secret", () => {
    const entries = [{ id: "a", type: "secret" }, { id: "b", type: "string" }, { id: "c", type: "action" }] as any;
    const out = redactSettings(entries, () => "v", () => true);
    expect(out).toEqual({ a: { isSet: true }, b: "v" });
  });
  it("lists every file in the manifest and writes a valid zip", () => {
    const bundle = buildBundle([textFile("a.txt", "hello")], "2026-01-01");
    expect(JSON.parse(new TextDecoder().decode(bundle[0].data)).files).toEqual([{ name: "a.txt", bytes: 5 }]);
    const zip = zipStore(bundle);
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new DataView(zip.buffer).getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("refuses traversal names", () => {
    expect(() => zipStore([textFile("../x", "")])).toThrow();
  });
});
