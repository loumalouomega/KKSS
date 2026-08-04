/**
 * Glue guard for File ▸ Save/Load Preprocess (app/main/cadHost.ts).
 *
 * The archive format itself is the cad submodule's, with its own upstream
 * tests. What is KKSS's to get wrong is the *contract between them*: cadHost
 * reads each sidecar off disk by suffix and hands the text to
 * `buildPreprocessZip`, then writes what `readPreprocessZip` returns back to
 * the same suffixes. A rename on either side would silently produce archives
 * that restore an incomplete document, so the round trip is pinned here —
 * together with the hardening that made the bump to cad 1.2.6 worth doing.
 */
import { describe, expect, it } from "vitest";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { buildPreprocessZip, readPreprocessZip } from "../cad/src/preprocessArchive";

/** The suffixes cadHost's `handleSavePreprocess`/`loadPreprocessDialog` use. */
const SIDECAR_SUFFIXES = {
  parts: ".parts.json",
  annotations: ".annotations.json",
  edits: ".edits.json",
  meshOptions: ".mesh.json",
} as const;

const SOURCE_NAME = "bracket.stp";
const source = strToU8("ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n");

describe("preprocess archive round trip", () => {
  it("carries the source and every sidecar cadHost packs", () => {
    const input = {
      sourceName: SOURCE_NAME,
      source,
      parts: '{"version":1,"parts":[]}',
      annotations: '{"version":1,"annotations":[]}',
      edits: '{"version":1,"ops":[]}',
      meshOptions: '{"version":1,"options":{}}',
    };
    const contents = readPreprocessZip(buildPreprocessZip(input));

    expect(contents.manifest.source).toBe(SOURCE_NAME);
    expect(Buffer.from(contents.source)).toEqual(Buffer.from(source));
    expect(contents.parts).toBe(input.parts);
    expect(contents.annotations).toBe(input.annotations);
    expect(contents.edits).toBe(input.edits);
    expect(contents.meshOptions).toBe(input.meshOptions);
  });

  it("omits sidecars that do not exist on disk rather than failing", () => {
    // cadHost passes `undefined` for a sidecar it could not read — a document
    // that never had parts/annotations must still archive.
    const contents = readPreprocessZip(buildPreprocessZip({ sourceName: SOURCE_NAME, source }));
    expect(contents.parts).toBeUndefined();
    expect(contents.annotations).toBeUndefined();
    expect(contents.edits).toBeUndefined();
    expect(contents.meshOptions).toBeUndefined();
  });

  it("names sidecar entries after the source, matching cadHost's own suffixes", () => {
    // The zip entry names are `<source><suffix>`; cadHost restores by writing
    // `<destPath><suffix>`, so the two lists have to agree.
    const zip = buildPreprocessZip({
      sourceName: SOURCE_NAME,
      source,
      parts: "{}",
      annotations: "{}",
      edits: "{}",
      meshOptions: "{}",
    });
    // Re-read through fflate directly: the point is the on-disk entry names,
    // which readPreprocessZip deliberately abstracts away.
    const names = Object.keys(unzipSync(zip));
    for (const suffix of Object.values(SIDECAR_SUFFIXES)) {
      expect(names).toContain(`${SOURCE_NAME}${suffix}`);
    }
    expect(names).toContain(SOURCE_NAME);
    expect(names).toContain("manifest.json");
    // The generated .geo is deliberately not packed — it is always regenerated
    // from the restored mesh options.
    expect(names).not.toContain(`${SOURCE_NAME}.geo`);
  });
});

describe("preprocess archive hardening (cad 1.2.6)", () => {
  it("rejects a tampered entry via its manifest checksum", () => {
    const good = buildPreprocessZip({ sourceName: SOURCE_NAME, source, parts: '{"version":1}' });
    const files = unzipSync(good);
    files[`${SOURCE_NAME}.parts.json`] = strToU8('{"version":1,"tampered":true}');
    expect(() => readPreprocessZip(zipSync(files))).toThrow(/checksum/i);
  });

  it("rejects an archive whose entries decompress far beyond their stored size", () => {
    // A zip bomb: highly compressible filler well past the per-entry ratio cap.
    const bomb = zipSync(
      { "manifest.json": strToU8("{}"), big: strToU8("A".repeat(2_000_000)) },
      { level: 9 }
    );
    expect(() => readPreprocessZip(bomb)).toThrow(/zip bomb|too large|uncompressed/i);
  });

  it("rejects a file that is not a preprocess archive at all", () => {
    expect(() => readPreprocessZip(zipSync({ "notes.txt": strToU8("hello") }))).toThrow(/manifest/i);
  });
});
