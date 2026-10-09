/**
 * services/layerSync.ts — bidirectional layer-structure sync between pre
 * (CAD `<model>.layers.json`) and post (mesh `<stem>.kratosview.json`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Layer } from "../cad/src/protocol";
import type { UserLayer } from "../mesh/src/parser/userLayers";
import {
  cadColorToRgb,
  cadToViewLayers,
  rgbToCadColor,
  sanitizeMeshName,
  syncFilePair,
  viewToCadLayers,
} from "../app/main/services/layerSync";

const cadLayer = (over: Partial<Layer> = {}): Layer => ({
  id: "layer-1",
  name: "Walls",
  color: "#ff0000",
  visible: true,
  locked: false,
  volumes: ["solid-1"],
  surfaces: ["face-2"],
  lines: [],
  points: [],
  ...over,
});

const viewLayer = (over: Partial<UserLayer> = {}): UserLayer => ({
  id: "walls",
  name: "Walls",
  color: [1, 0, 0],
  visible: true,
  locked: false,
  blocks: [],
  parts: [],
  ids: { Elements: [], Conditions: [], Geometries: [] },
  ...over,
});

describe("color conversion", () => {
  it("round-trips hex through RGB", () => {
    const rgb = cadColorToRgb("#ff8800");
    expect(rgb).toBeDefined();
    expect(rgbToCadColor(rgb!)).toBe("#ff8800");
  });
  it("rejects malformed hex", () => {
    expect(cadColorToRgb("red")).toBeUndefined();
    expect(cadColorToRgb("#fff")).toBeUndefined();
  });
});

describe("sanitizeMeshName", () => {
  it("replaces slashes and trims", () => {
    expect(sanitizeMeshName("a/b")).toBe("a-b");
    expect(sanitizeMeshName("  ")).toBe("Layer");
  });
});

describe("cadToViewLayers", () => {
  it("translates structure with empty membership", () => {
    const { layers, report } = cadToViewLayers([cadLayer()], []);
    expect(layers).toHaveLength(1);
    expect(layers[0].name).toBe("Walls");
    expect(layers[0].color).toEqual([1, 0, 0]);
    expect(layers[0].ids).toEqual({ Elements: [], Conditions: [], Geometries: [] });
    expect(report.created).toEqual(["Walls"]);
    expect(report.warnings.join(" ")).toMatch(/not translated/i);
  });
  it("updates presentation fields of a matched layer without touching membership", () => {
    const existing = [viewLayer({ ids: { Elements: [5], Conditions: [], Geometries: [] } })];
    const { layers, report } = cadToViewLayers(
      [cadLayer({ id: "walls", name: "Walls", color: "#00ff00", visible: false, locked: true })],
      existing
    );
    expect(layers).toHaveLength(1);
    expect(layers[0].visible).toBe(false);
    expect(layers[0].locked).toBe(true);
    expect(layers[0].ids.Elements).toEqual([5]);
    expect(report.updated).toEqual(["Walls"]);
  });
  it("skips the implicit default when there are no stored layers", () => {
    const { layers, report } = cadToViewLayers([], []);
    expect(layers).toEqual([]);
    expect(report.created).toEqual([]);
  });
});

describe("viewToCadLayers", () => {
  it("allocates never-reused layer-N ids and carries presentation fields", () => {
    const { layers, nextId, report } = viewToCadLayers([viewLayer()], [], 0);
    expect(report.created).toEqual(["Walls"]);
    expect(layers).toHaveLength(2); // implicit default + synced layer
    const synced = layers.find((l) => l.name === "Walls")!;
    expect(synced.id).toMatch(/^layer-\d+$/);
    expect(synced.color).toBe("#ff0000");
    expect(synced.volumes).toEqual([]);
    expect(nextId).toBeGreaterThan(0);
  });
  it("keeps CAD membership on update", () => {
    const existing = [cadLayer({ id: "layer-1", name: "Walls", volumes: ["solid-9"] })];
    const { layers, report } = viewToCadLayers([viewLayer({ id: "layer-1", locked: true })], existing, 2);
    expect(report.updated).toEqual(["Walls"]);
    expect(layers.find((l) => l.id === "layer-1")!.volumes).toEqual(["solid-9"]);
    expect(layers.find((l) => l.id === "layer-1")!.locked).toBe(true);
  });
});

describe("syncFilePair", () => {
  it("syncs pre → post on export and converges on repeat", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-layers-"));
    const cadPath = path.join(dir, "bracket.step");
    const meshPath = path.join(dir, "bracket.mdpa");
    fs.writeFileSync(`${cadPath}.layers.json`, JSON.stringify({
      version: 1, source: "bracket.step", nextId: 2,
      layers: [{ id: "layer-1", name: "Walls", color: "#ff0000", visible: false, locked: false, volumes: ["solid-1"], surfaces: [], lines: [], points: [] }],
    }));
    const first = syncFilePair(cadPath, meshPath);
    expect(first).toMatch(/pre → post/);
    const viewSidecar = path.join(dir, "bracket.kratosview.json");
    expect(fs.existsSync(viewSidecar)).toBe(true);
    // Converged: a repeat finds nothing to do.
    expect(syncFilePair(cadPath, meshPath)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("syncs post → pre when the view sidecar is newer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-layers-"));
    const cadPath = path.join(dir, "part.step");
    const meshPath = path.join(dir, "part.mdpa");
    fs.writeFileSync(`${cadPath}.layers.json`, JSON.stringify({ version: 1, source: "part.step", layers: [] }));
    fs.writeFileSync(path.join(dir, "part.kratosview.json"), JSON.stringify({
      version: 1,
      layers: [{ id: "roof", name: "Roof", color: [0, 0, 1], visible: true, locked: false, blocks: [], parts: [], ids: { Elements: [], Conditions: [], Geometries: [] } }],
    }));
    // Make the CAD sidecar older so post wins.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${cadPath}.layers.json`, old, old);
    const summary = syncFilePair(cadPath, meshPath);
    expect(summary).toMatch(/post → pre/);
    expect(syncFilePair(cadPath, meshPath)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("does nothing when neither side has layers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-layers-"));
    expect(syncFilePair(path.join(dir, "a.step"), path.join(dir, "a.mdpa"))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
