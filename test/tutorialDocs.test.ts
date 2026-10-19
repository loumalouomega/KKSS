import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// Pure modules from the tutorial tooling: no Electron, no Kratos, no network.
import { CATALOG, catalogFiles } from "../tools/tutorials/shots.mjs";
import { renderAll, renderPage, PAGES } from "../tools/tutorials/writeDocs.mjs";
import { islandsIn } from "../tools/tutorials/docIslands.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shotsDir = path.join(root, "doc/public/screenshots");
const guideDir = path.join(root, "doc/guide");
const publishedDir = path.join(root, "doc/public/examples/tutorials");
const guidePages = fs.readdirSync(guideDir).filter((f) => f.endsWith(".md"));
const tutorialPages = Object.values(PAGES);

/** Width and height from a PNG's IHDR chunk, or undefined when the file is not a PNG. */
function pngDimensions(file: string): { width: number; height: number } | undefined {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(1, 4).toString("latin1") !== "PNG") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Markdown image references: `![alt](/screenshots/name.png)`, optionally with a title. */
function imageRefs(markdown: string) {
  return [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => ({ alt: m[1], src: m[2] }));
}

/** Internal page links in a guide page: `](tutorial-x)`, `](/guide/x)`, `](x.md#y)`. */
function internalLinks(markdown: string) {
  return [...markdown.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)].map((m) => m[1]);
}

describe("screenshot catalog", () => {
  it("names every entry once", () => {
    const files = catalogFiles();
    expect(new Set(files).size).toBe(files.length);
  });

  it("points every entry at a tutorial that exists", () => {
    const cases = fs.readdirSync(publishedDir).filter((name) => fs.statSync(path.join(publishedDir, name)).isDirectory());
    for (const shot of CATALOG) {
      expect(cases, `${shot.file} names an unknown case`).toContain(shot.case);
    }
  });

  it("has a file on disk for every entry", () => {
    const missing = catalogFiles().filter((file) => !fs.existsSync(path.join(shotsDir, file)));
    expect(missing, "catalog entries without a file: run the tutorial capture").toEqual([]);
  });

  it("lists every tutorial screenshot on disk", () => {
    const listed = new Set(catalogFiles());
    const orphans = fs.readdirSync(shotsDir)
      .filter((file) => file.startsWith("tutorial-") && !file.startsWith("tutorial-ai-"))
      .filter((file) => !listed.has(file));
    expect(orphans, "tutorial images the catalog does not declare").toEqual([]);
  });

  it("keeps every PNG a real canvas size and above the blank-frame floor", () => {
    for (const shot of CATALOG.filter((s) => s.producer !== "legacy" && s.file.endsWith(".png"))) {
      const file = path.join(shotsDir, shot.file);
      if (!fs.existsSync(file)) continue;
      const dims = pngDimensions(file);
      expect(dims, `${shot.file} is not a PNG`).toBeDefined();
      expect(dims!.width, `${shot.file} width`).toBeGreaterThanOrEqual(300);
      expect(dims!.width, `${shot.file} width`).toBeLessThanOrEqual(6000);
      // Whether a canvas drew is decided at capture time from the pixels (see capture.mjs);
      // a byte count cannot tell a flat frame from a smooth field, so this only rules out a broken file.
      expect(fs.statSync(file).size, `${shot.file} is not a usable image`).toBeGreaterThan(3_000);
    }
  });

  it("keeps every animation under the size budget", () => {
    for (const shot of CATALOG.filter((s) => s.file.endsWith(".gif"))) {
      const file = path.join(shotsDir, shot.file);
      if (!fs.existsSync(file)) continue;
      expect(fs.statSync(file).size, `${shot.file}`).toBeLessThanOrEqual(1_500_000);
    }
  });
});

describe("tutorial pages", () => {
  it("has a page for every tutorial", () => {
    for (const file of tutorialPages) {
      expect(fs.existsSync(path.join(guideDir, file)), `${file} is missing`).toBe(true);
    }
  });

  it("renders every island current", () => {
    const stale = renderAll().map((page) => path.relative(root, page.target));
    expect(stale, "stale islands: run node tools/tutorials/writeDocs.mjs").toEqual([]);
  });

  it("holds each island exactly once and only where the renderer writes it", () => {
    for (const file of tutorialPages) {
      const markdown = fs.readFileSync(path.join(guideDir, file), "utf8");
      expect(islandsIn(markdown), `${file}`).toEqual(["glance", "verified"]);
      expect(() => renderPage(
        Object.keys(PAGES).find((id) => PAGES[id] === file)!,
        markdown,
      ), `${file}`).not.toThrow();
    }
  });

  it("gives every image on a tutorial page alt text and a file that exists", () => {
    for (const file of tutorialPages) {
      const markdown = fs.readFileSync(path.join(guideDir, file), "utf8");
      expect(markdown.includes("<img"), `${file} uses a raw <img>; use markdown image syntax`).toBe(false);
      for (const ref of imageRefs(markdown)) {
        expect(ref.alt.trim(), `${file}: ${ref.src} has no alt text`).not.toBe("");
        if (ref.src.startsWith("/screenshots/")) {
          expect(fs.existsSync(path.join(shotsDir, ref.src.slice("/screenshots/".length))), `${file}: ${ref.src}`).toBe(true);
        }
      }
    }
  });

  it("follows the skeleton on the four newest tutorials", () => {
    const skeleton = [
      "At a glance", "What you will learn", "The physical model", "Create the geometry", "Name the Parts",
      "Mesh", "Configure the problemtype", "Generate and inspect the case files", "Run",
      "Inspect the results", "Verify", "Troubleshooting", "Variations to try", "Reproduce and download",
    ];
    for (const id of ["rans", "eigen", "two-fluids", "wind-tunnel"]) {
      const markdown = fs.readFileSync(path.join(guideDir, PAGES[id]), "utf8");
      const headings = [...markdown.matchAll(/^## (.+?)(?: \{#[^}]+\})?$/gm)].map((m) => m[1].trim());
      let cursor = 0;
      for (const heading of skeleton) {
        const at = headings.indexOf(heading, cursor);
        expect(at, `${id}: "${heading}" is missing or out of order`).toBeGreaterThanOrEqual(cursor);
        cursor = at + 1;
      }
    }
  });

  it("resolves every internal link on a tutorial page", () => {
    const targets = new Set(guidePages.map((f) => f.replace(/\.md$/, "")));
    for (const file of tutorialPages) {
      const markdown = fs.readFileSync(path.join(guideDir, file), "utf8");
      for (const link of internalLinks(markdown)) {
        const target = link.split("#")[0];
        if (!target) continue;
        if (target.startsWith("/examples/") || target.startsWith("/screenshots/")) {
          const publicPath = path.join(root, "doc/public", target.split("?")[0]);
          expect(fs.existsSync(publicPath), `${file}: ${link}`).toBe(true);
          continue;
        }
        const name = target.replace(/^\/guide\//, "").replace(/\.md$/, "");
        expect(targets.has(name), `${file}: ${link} does not name a guide page`).toBe(true);
      }
    }
  });

  it("names no absolute home path in the guide", () => {
    for (const file of guidePages) {
      const markdown = fs.readFileSync(path.join(guideDir, file), "utf8");
      // An absolute path starts a token ("/home/name"); "renderer/home/" is a repository path.
      expect(/(^|[\s(`'"=])\/home\/[A-Za-z]/m.test(markdown), `${file} carries an absolute home path`).toBe(false);
    }
  });
});

describe("site navigation", () => {
  it("maps every guide link in the config to a page", () => {
    const config = fs.readFileSync(path.join(root, "doc/.vitepress/config.ts"), "utf8");
    const targets = [...config.matchAll(/link:\s*'\/guide\/([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const name of targets) {
      expect(fs.existsSync(path.join(guideDir, `${name}.md`)), `config.ts links /guide/${name}`).toBe(true);
    }
  });
});
