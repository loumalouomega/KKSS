/**
 * The shim's workspace.getConfiguration, served from the settings registry:
 * a mapped key reads the stateStore, anything else returns the caller's
 * default — exactly what the unmodified mesh providers were written against.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, dialog: {}, shell: {} }));
vi.mock("../app/main/services/dialogs", () => ({}));
vi.mock("../app/main/services/quickPick", () => ({}));
vi.mock("../app/main/services/notifications", () => ({}));
vi.mock("../app/main/services/watcher", () => ({}));

const store: Record<string, unknown> = {};
const listeners = new Set<(key: string, value: unknown) => void>();
vi.mock("../app/main/services/stateStore", () => ({
  stateStore: {
    get: <T,>(key: string, d?: T) => (key in store ? (store[key] as T) : d),
    update: async (key: string, value: unknown) => {
      if (value === undefined) delete store[key];
      else store[key] = value;
      for (const l of listeners) l(key, value);
    },
    onDidChange: (l: (key: string, value: unknown) => void) => {
      listeners.add(l);
      return { dispose: () => listeners.delete(l) };
    },
  },
}));

const { workspace } = await import("../app/main/vscodeShim");

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("workspace.getConfiguration", () => {
  it("returns the caller's default when nothing is stored", () => {
    const kratos = workspace.getConfiguration("kratos");
    expect(kratos.get("pythonPath", "")).toBe("");
    expect(kratos.get("problemtypes.extraPaths", [".kratos/problemtypes"])).toEqual([".kratos/problemtypes"]);
    expect(kratos.get("run.stopOnWindowClose", true)).toBe(true);
  });

  it("serves stored registry values, including dotted sections", () => {
    store["kratos.pythonPath"] = "/opt/py/bin/python";
    store["kratos.extraEnv"] = { OMP_NUM_THREADS: "4" };
    store["kratos.flowgraph.splitOrientation"] = "vertical";
    store["kratos.run.stopOnWindowClose"] = false;
    expect(workspace.getConfiguration("kratos").get("pythonPath", "")).toBe("/opt/py/bin/python");
    expect(workspace.getConfiguration("kratos").get("extraEnv", {})).toEqual({ OMP_NUM_THREADS: "4" });
    expect(workspace.getConfiguration("kratos.flowgraph").get("splitOrientation", "horizontal")).toBe("vertical");
    expect(workspace.getConfiguration("kratos").get("run.stopOnWindowClose", true)).toBe(false);
  });

  it("parses the summary threshold the old menu stored as a string, keeping 0", () => {
    store.meshSummaryThresholdMb = "80";
    expect(workspace.getConfiguration("kratos").get("preview.summaryThresholdMb", 250)).toBe(80);
    store.meshSummaryThresholdMb = 0;
    expect(workspace.getConfiguration("kratos").get("preview.summaryThresholdMb", 250)).toBe(0);
  });

  it("falls back on an invalid stored value", () => {
    store["kratos.flowgraph.splitOrientation"] = "diagonal";
    expect(workspace.getConfiguration("kratos.flowgraph").get("splitOrientation", "horizontal")).toBe("horizontal");
  });

  it("leaves unmapped keys at their default", () => {
    expect(workspace.getConfiguration("files").get("autoSave", "off")).toBe("off");
    expect(workspace.getConfiguration("kratos").get("run.launchMode", "output")).toBe("output");
  });

  it("writes through update() and notifies onDidChangeConfiguration", async () => {
    const seen: boolean[] = [];
    const sub = workspace.onDidChangeConfiguration((e) => seen.push(e.affectsConfiguration("kratos")));
    await workspace.getConfiguration("kratos").update("installPath", "/opt/kratos");
    expect(store["kratos.installPath"]).toBe("/opt/kratos");
    expect(seen).toEqual([true]);
    await expect(workspace.getConfiguration("kratos").update("nope", 1)).rejects.toThrow();
    sub.dispose();
  });
});
