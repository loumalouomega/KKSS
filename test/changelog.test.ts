import { describe, expect, it } from "vitest";
import { parseChangelog } from "../app/main/services/changelog";

const SAMPLE = `# Changelog

Some intro text that isn't a release heading.

## [1.0.6] - 2026-07-18

- feat: bump the mesh submodule to meshio++ 6.6.1, adding read support for
  EnSight Gold and Triangle meshes
- docs: format counts updated across README.md

## [1.0.5] - 2026-07-18

- ci: publish the streamed-desktop Docker image to Docker Hub

## [1.0.1] - 2026-07-17

- Version bump only; no functional changes since 1.0.0.

[1.0.6]: https://github.com/loumalouomega/KKSS/compare/v1.0.5...v1.0.6
`;

describe("parseChangelog", () => {
  it("parses each release heading into an entry with its bullets", () => {
    expect(parseChangelog(SAMPLE)).toEqual([
      {
        version: "1.0.6",
        date: "2026-07-18",
        bullets: [
          "feat: bump the mesh submodule to meshio++ 6.6.1, adding read support for EnSight Gold and Triangle meshes",
          "docs: format counts updated across README.md",
        ],
      },
      { version: "1.0.5", date: "2026-07-18", bullets: ["ci: publish the streamed-desktop Docker image to Docker Hub"] },
      { version: "1.0.1", date: "2026-07-17", bullets: ["Version bump only; no functional changes since 1.0.0."] },
    ]);
  });

  it("ignores text before the first heading and trailing compare-link references", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => !e.bullets.some((b) => b.startsWith("http")))).toBe(true);
  });

  it("returns an empty list for content with no release headings", () => {
    expect(parseChangelog("# Changelog\n\nNothing here yet.\n")).toEqual([]);
  });

  it("joins a bullet's hanging-indent continuation lines into one string", () => {
    const wrapped = parseChangelog(SAMPLE)[0].bullets[0];
    expect(wrapped).toBe(
      "feat: bump the mesh submodule to meshio++ 6.6.1, adding read support for EnSight Gold and Triangle meshes"
    );
    expect(wrapped.includes("\n")).toBe(false);
  });
});
