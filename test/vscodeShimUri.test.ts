import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp", getVersion: () => "0" }, shell: {}, dialog: {}, clipboard: {}, ipcMain: { on() {}, handle() {} } }));

import { Uri } from "../app/main/vscodeShim";

describe("vscodeShim Uri.parse", () => {
  it("round-trips a file Uri through toString (mesh's restoreOpsFromBackup does this)", () => {
    const backup = "/tmp/recovery/1-2/mesh-x.ops.json";
    const parsed = Uri.parse(Uri.file(backup).toString());
    expect(parsed.fsPath).toBe(backup);
    expect(parsed.scheme).toBe("file");
  });

  it("still treats other URIs as opaque, and fsPath on them throws", () => {
    const http = Uri.parse("http://127.0.0.1:5173/x");
    expect(http.scheme).toBe("http");
    expect(http.authority).toBe("127.0.0.1:5173");
    expect(() => http.fsPath).toThrow();
  });
});
