import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { validatePlotRecipe } from "../mesh/src/parser/plot/recipe";
import { parsePlotTable } from "../mesh/src/parser/plot/importTable";

const directory = path.resolve(__dirname, "../doc/public/examples/tutorials");
const cases = ["structural", "fluid", "thermal", "potential-flow", "shallow-water"];
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("published FEM plot recipes", () => {
  for (const name of cases) it(`${name} is relocatable, fully covered and hash-bound to the published output`, () => {
    const dir = path.join(directory, name), plots = path.join(dir, "plots");
    const checks = json(path.join(plots, "verification.json"));
    const verification = json(path.join(dir, "verification.json"));
    for (const [file, revision] of Object.entries(checks.inputs)) expect(hash(path.join(dir, file))).toBe(revision);
    for (const [file, revision] of Object.entries(verification.files)) if (file.startsWith("plots/")) expect(hash(path.join(dir, file))).toBe(revision);
    for (const recipeName of Object.keys(checks.recipes)) {
      const recipe = validatePlotRecipe(json(path.join(plots, recipeName + ".json")));
      for (const source of recipe.sources) {
        expect(source.type).not.toBe("inline");
        expect(source.run).toBeUndefined();
        if (source.type !== "inline") {
          expect(path.isAbsolute(source.path)).toBe(false);
          expect(fs.existsSync(path.resolve(plots, source.path))).toBe(true);
        }
      }
      const metadata = json(path.join(plots, recipeName + ".csv.kratosplot.json"));
      expect(metadata.recipe).toEqual(recipe);
      expect(metadata.partial).toBe(false);
      const data = parsePlotTable(fs.readFileSync(path.join(plots, recipeName + ".csv"), "utf8"));
      expect(data.rows.filter(row => row[1] === "derived")).toHaveLength(metadata.fullCount);
      expect(data.rows.filter(row => row[1] === "original")).toHaveLength(metadata.fullCount);
      expect(metadata.series.every((s: { statistics: { missing: number } }) => s.statistics.missing === 0)).toBe(true);
    }
  });

  it("discloses the cylinder's fixed-step/end-time discrepancy and actual pressure evolution", () => {
    const verification = json(path.join(directory, "fluid/plots/verification.json"));
    expect(verification.timeMapping.configuredEndTime).toBe(5);
    expect(verification.timeMapping.times).toHaveLength(51);
    expect(verification.timeMapping.times[0]).toBe(0.1);
    expect(verification.timeMapping.times.at(-1)).toBe(5.1);
    expect(verification.coordinates.front.id).toBe(21);
    expect(verification.coordinates.back.id).toBe(5);
    const [front, back] = verification.recipes["pressure-history"];
    expect(front.first.y).toBe(2697.7852);
    expect(front.last.y).toBe(9.2801962);
    expect(back.last.y).toBe(-4.189086);
    // Independently read the ASCII FIELD array rather than trusting the manifest.
    for (const [file, expected] of [["FluidModelPart_0_1.vtk", front.first.y], ["FluidModelPart_0_51.vtk", front.last.y]] as const) {
      const tokens = fs.readFileSync(path.join(directory, "fluid/vtk_output", file), "utf8").trim().split(/\s+/);
      const at = tokens.indexOf("PRESSURE");
      expect(Number(tokens[at + 1])).toBe(1);
      expect(Number(tokens[at + 4 + 20])).toBe(expected); // native VTK node 21 = tuple 20.
    }
  });
  it("selects a displaced cantilever node rather than a zero-displacement support", () => {
    const verification = json(path.join(directory, "structural/plots/verification.json"));
    const tip = verification.recipes["displacement-history"][0];
    expect(tip.last.y).toBeCloseTo(0.00058914793, 12);
    expect(verification.coordinates.tip.id).toBe(5);
  });
});
