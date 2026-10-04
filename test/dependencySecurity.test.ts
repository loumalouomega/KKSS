import { readFileSync } from "node:fs";
import { satisfies } from "semver";
import { describe, expect, it } from "vitest";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
  packages: Record<string, { version?: string }>;
};

describe("dependency security version floors", () => {
  it.each([
    // Keep the majors required by the different minimatch consumers.
    ["brace-expansion", "^1.1.21 || ^2.1.7 || ^3.0.9 || ^5.0.12"],
    ["fast-uri", ">=3.1.8"],
    // Outside the published affected range; upstream has not confirmed a fix.
    ["http-cache-semantics", ">=4.3.0"],
  ])("keeps every locked copy of %s outside the published affected ranges", (name, range) => {
    const entries = Object.entries(lock.packages).filter(([path]) => path.endsWith(`/node_modules/${name}`)
      || path === `node_modules/${name}`);
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, entry] of entries) {
      expect(satisfies(entry.version ?? "", range), `${path}: ${entry.version}`).toBe(true);
    }
  });
});
