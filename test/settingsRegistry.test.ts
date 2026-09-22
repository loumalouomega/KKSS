/**
 * The settings registry against both submodules' `contributes.configuration`:
 * every contributed property must either be served by a registry entry (same
 * type, same enum, same default) or be listed in NOT_APPLICABLE with a reason.
 * A submodule bump that adds a setting fails here until KKSS decides what to
 * do with it — otherwise the new key would silently stay at its default.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildRegistry,
  CATEGORIES,
  effective,
  entryForVscode,
  NOT_APPLICABLE,
  normalize,
  toStored,
  ZOOM_CHOICES,
  type SettingEntry,
} from "../app/main/services/settings/registry";
import { DEFAULT_CACHE_LIMIT_MB, CLOUD_KEYS } from "../app/main/services/cloud/cloudCore";

const root = path.resolve(__dirname, "..");

interface Contributed {
  type: string | string[];
  enum?: unknown[];
  default?: unknown;
}

function contributed(pkg: string): Record<string, Contributed> {
  const json = JSON.parse(fs.readFileSync(path.join(root, pkg, "package.json"), "utf8"));
  const config = json.contributes?.configuration;
  const blocks = Array.isArray(config) ? config : [config];
  return Object.assign({}, ...blocks.map((b: { properties?: object }) => b?.properties ?? {}));
}

const properties = { ...contributed("cad"), ...contributed("mesh") };
const registry = buildRegistry("linux");
const mapped = registry.filter((e) => e.vscode);
const idOf = (e: SettingEntry) => `${e.vscode!.section}.${e.vscode!.key}`;

describe("settings registry vs. contributes.configuration", () => {
  it("classifies every contributed property exactly once", () => {
    const unclassified = Object.keys(properties).filter(
      (key) => !mapped.some((e) => idOf(e) === key) && !(key in NOT_APPLICABLE)
    );
    expect(unclassified).toEqual([]);
    const both = Object.keys(NOT_APPLICABLE).filter((key) => mapped.some((e) => idOf(e) === key));
    expect(both).toEqual([]);
  });

  it("maps and excludes only properties that exist", () => {
    const stale = [...mapped.map(idOf), ...Object.keys(NOT_APPLICABLE)].filter((key) => !(key in properties));
    expect(stale).toEqual([]);
  });

  it.each(mapped.map((e) => [idOf(e), e] as const))("%s matches its schema", (key, entry) => {
    const prop = properties[key];
    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    const expected: Record<string, SettingEntry["type"][]> = {
      boolean: ["boolean"],
      number: ["number"],
      string: prop.enum ? ["enum"] : ["string", "path", "color"],
      array: ["stringList"],
      object: ["stringMap"],
    };
    expect(expected[type]).toContain(entry.type);
    if (prop.enum) expect([...(entry.enum ?? [])]).toEqual(prop.enum);
    expect(entry.default).toEqual(prop.default);
  });
});

describe("registry shape", () => {
  it("has unique ids and store keys, and only known categories", () => {
    const ids = registry.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = registry.map((e) => e.storeKey).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of registry) expect(CATEGORIES).toContain(e.category);
  });

  it("gives every non-action entry a store key and every enum matching labels", () => {
    for (const e of registry) {
      if (e.type !== "action") expect(e.storeKey, e.id).toBeTruthy();
      if (e.type === "action") expect(e.actions?.length, e.id).toBeGreaterThan(0);
      if (e.type === "enum") expect(e.enumLabels?.length, e.id).toBe(e.enum?.length);
      if (e.default !== undefined) expect(normalize(e, e.default), e.id).toEqual(e.default);
    }
  });

  it("never claims a key the mesh extension writes to its (unprefixed) globalState", () => {
    const meshKeys = ["recentMeshes", "meshExportOverwriteWarned", "lastShownVersion"];
    for (const e of registry) expect(meshKeys).not.toContain(e.storeKey);
  });

  it("keeps the interface-scale choices in step with windows.ts", () => {
    const src = fs.readFileSync(path.join(root, "app/main/windows.ts"), "utf8");
    const presets = /ZOOM_PRESETS = \[([^\]]+)\]/.exec(src)![1].split(",").map(Number);
    expect([...ZOOM_CHOICES]).toEqual(presets);
  });

  it("keeps cloud defaults in step with cloudCore", () => {
    const cache = registry.find((e) => e.id === "cloud.cacheLimitMb")!;
    expect(cache.default).toBe(DEFAULT_CACHE_LIMIT_MB);
    expect(cache.storeKey).toBe(CLOUD_KEYS.cacheLimitMb);
  });

  it("offers per-platform shells", () => {
    const win = buildRegistry("win32").find((e) => e.id === "terminal.shell")!;
    expect(win.enum).toContain("cmd.exe");
    expect(registry.find((e) => e.id === "terminal.shell")!.enum).toContain("/bin/bash");
  });
});

describe("value handling", () => {
  const threshold = entryForVscode("kratos", "preview.summaryThresholdMb")!;

  it("reads numbers the old menu stored as strings", () => {
    expect(normalize(threshold, "120")).toBe(120);
    expect(normalize(threshold, "0")).toBe(0);
    expect(normalize(threshold, "-1")).toBeUndefined();
    expect(normalize(threshold, "abc")).toBeUndefined();
  });

  it("stores nothing for the default or an empty string", () => {
    expect(toStored(threshold, 250)).toEqual({ ok: true, value: undefined });
    expect(toStored(threshold, 100)).toEqual({ ok: true, value: 100 });
    const python = entryForVscode("kratos", "pythonPath")!;
    expect(toStored(python, "   ")).toEqual({ ok: true, value: undefined });
    expect(toStored(python, " /usr/bin/python3 ")).toEqual({ ok: true, value: "/usr/bin/python3" });
    const scad = entryForVscode("cadPreview", "openscadBinary")!;
    expect(toStored(scad, "openscad")).toEqual({ ok: true, value: undefined });
  });

  it("rejects values of the wrong type", () => {
    const upAxis = entryForVscode("cadPreview", "upAxis")!;
    expect(toStored(upAxis, "x")).toEqual({ ok: false });
    const bg = entryForVscode("cadPreview", "background")!;
    expect(toStored(bg, "red")).toEqual({ ok: false });
    expect(toStored(bg, "#AABBCC")).toEqual({ ok: true, value: "#aabbcc" });
    const env = entryForVscode("kratos", "extraEnv")!;
    expect(toStored(env, { A: 1 })).toEqual({ ok: false });
    expect(toStored(env, { A: "1" })).toEqual({ ok: true, value: { A: "1" } });
    expect(toStored(env, {})).toEqual({ ok: true, value: undefined });
  });

  it("maps numeric enums submitted as strings", () => {
    const zoom = registry.find((e) => e.id === "appearance.zoom")!;
    expect(toStored(zoom, "1.25")).toEqual({ ok: true, value: 1.25 });
    expect(effective(zoom, 7)).toBe(1);
  });

  it("resolves dotted sections", () => {
    expect(entryForVscode("kratos.flowgraph", "splitOrientation")?.id).toBe("kratos.flowgraph.splitOrientation");
    expect(entryForVscode("kratos", "flowgraph.splitOrientation")?.id).toBe("kratos.flowgraph.splitOrientation");
    expect(entryForVscode("kratos", "nope")).toBeUndefined();
  });
});
