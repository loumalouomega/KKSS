/**
 * services/cloud/cachePathCore.ts — where a staged file lands and which of its
 * neighbours the sync engine treats as sidecars.
 *
 * The two things that break loudly if this is wrong: a mangled compound suffix
 * re-routes the document to the other mode, and an over-broad sidecar rule
 * uploads our own atomic-write temp files to the user's Drive.
 */
import { describe, expect, it } from "vitest";
import {
  cacheDirRelPath,
  cacheRelPath,
  isSidecarOf,
  isStagingArtifact,
  opaqueId,
  sanitizeFileName,
  sidecarNamesFor,
  suffixOf,
} from "../app/main/services/cloud/cachePathCore";

describe("opaqueId", () => {
  it("is deterministic per (account, item) and contains no separators", () => {
    const a = opaqueId("user@example.com", "/Apps/KKSS/bull.stp");
    expect(a).toBe(opaqueId("user@example.com", "/Apps/KKSS/bull.stp"));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    // A Dropbox path or a Drive id must not be able to escape the cache root.
    expect(a).not.toContain("/");
    expect(a).not.toContain("..");
  });

  it("separates two accounts holding the same item id", () => {
    expect(opaqueId("a", "same")).not.toBe(opaqueId("b", "same"));
  });

  it("does not collide when a delimiter appears inside an id", () => {
    // A naive concatenation — with or without a separator character — makes
    // one of these pairs equal. Length-prefixing makes neither.
    expect(opaqueId("ab", "c")).not.toBe(opaqueId("a", "bc"));
    expect(opaqueId("a b", "c")).not.toBe(opaqueId("a", "b c"));
  });
});

describe("sanitizeFileName", () => {
  it("leaves an ordinary name, and a compound extension, untouched", () => {
    expect(sanitizeFileName("bull.stp")).toBe("bull.stp");
    // The whole point: meshExtname routes on the longest suffix, so losing the
    // `.post` here would turn GiD postprocess into Gmsh.
    expect(sanitizeFileName("case.post.msh")).toBe("case.post.msh");
    expect(sanitizeFileName("pièce_2.stp")).toBe("pièce_2.stp");
  });

  it("replaces separators and control characters", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeFileName("a\u0000b\u001fc.stp")).toBe("a_b_c.stp");
    expect(sanitizeFileName("C:\\models\\a.stp")).toBe("C__models_a.stp");
  });

  it("never returns a name that would escape or vanish", () => {
    expect(sanitizeFileName("..")).toBe("file");
    expect(sanitizeFileName(".")).toBe("file");
    expect(sanitizeFileName("")).toBe("file");
    // Windows silently drops trailing dots and spaces.
    expect(sanitizeFileName("model.stp. ")).toBe("model.stp");
  });

  it("escapes Windows reserved device names", () => {
    expect(sanitizeFileName("CON.stp")).toBe("_CON.stp");
    expect(sanitizeFileName("lpt1.mdpa")).toBe("_lpt1.mdpa");
    expect(sanitizeFileName("console.stp")).toBe("console.stp");
  });

  it("truncates the stem but keeps the whole compound suffix", () => {
    const long = `${"a".repeat(300)}.post.msh`;
    const out = sanitizeFileName(long);
    expect(out.endsWith(".post.msh")).toBe(true);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(120);
  });
});

describe("suffixOf", () => {
  it("keeps the original case that meshExtname lowercases", () => {
    expect(suffixOf("BULL.STP")).toBe(".STP");
    expect(suffixOf("Case.Post.Msh")).toBe(".Post.Msh");
    expect(suffixOf("README")).toBe("");
  });
});

describe("cacheRelPath", () => {
  it("puts one document in its own directory under its provider", () => {
    const ref = { provider: "dropbox" as const, accountId: "acct", itemId: "/a/bull.stp", name: "bull.stp" };
    expect(cacheRelPath(ref)).toBe(`dropbox/${opaqueId("acct", "/a/bull.stp")}/bull.stp`);
    expect(cacheDirRelPath(ref)).toBe(`dropbox/${opaqueId("acct", "/a/bull.stp")}`);
    // The file path is always inside the directory path — that invariant is
    // what lets the sync engine treat "the rest of this directory" as sidecars.
    expect(cacheRelPath(ref).startsWith(`${cacheDirRelPath(ref)}/`)).toBe(true);
  });
});

describe("isStagingArtifact", () => {
  it("excludes our own atomic-write temps and in-flight downloads", () => {
    expect(isStagingArtifact("bull.stp.parts.json.12345.tmp")).toBe(true);
    expect(isStagingArtifact("bull.stp.download")).toBe(true);
    expect(isStagingArtifact(".DS_Store")).toBe(true);
  });

  it("does not exclude real documents or sidecars", () => {
    expect(isStagingArtifact("bull.stp")).toBe(false);
    expect(isStagingArtifact("bull.stp.parts.json")).toBe(false);
    expect(isStagingArtifact("case.post.msh")).toBe(false);
  });
});

describe("isSidecarOf", () => {
  it("accepts every cad sidecar and mesh's run sidecar", () => {
    for (const name of [
      "bull.stp.parts.json",
      "bull.stp.edits.json",
      "bull.stp.annotations.json",
      "bull.stp.view.json",
      "bull.stp.planes.json",
      "bull.stp.mesh.json",
      "bull.stp.geo",
    ]) {
      expect(isSidecarOf("bull.stp", name)).toBe(true);
    }
    // mesh's RunManager sidecar is keyed by the STEM, not the full name.
    expect(isSidecarOf("case.post.msh", "case.kratosrun.json")).toBe(true);
  });

  it("rejects the document itself, a neighbour, and the macro library", () => {
    expect(isSidecarOf("bull.stp", "bull.stp")).toBe(false);
    expect(isSidecarOf("bull.stp", "bull2.stp.parts.json")).toBe(false);
    expect(isSidecarOf("bull.stp", "other.stp")).toBe(false);
    // Per FOLDER, not per model — syncing it would let two models from one
    // remote folder overwrite each other's macros.
    expect(isSidecarOf("bull.stp", "cad-preview-macros.json")).toBe(false);
  });
});

describe("sidecarNamesFor", () => {
  it("lists what stage() must look for beside a remote model", () => {
    const names = sidecarNamesFor("bull.stp");
    expect(names).toContain("bull.stp.parts.json");
    expect(names).toContain("bull.stp.geo");
    expect(names).toContain("bull.kratosrun.json");
    expect(names).not.toContain("cad-preview-macros.json");
    // Everything it names must be recognised on the way back in.
    for (const name of names) expect(isSidecarOf("bull.stp", name)).toBe(true);
  });
});
