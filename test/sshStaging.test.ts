import { describe, expect, it } from "vitest";
import { cacheRelPath } from "../app/main/services/cloud/cachePathCore";
import { parseManifest } from "../app/main/services/cloud/manifestCore";
import { parseRecentFiles, pruneRecentFiles } from "../app/main/services/recentFilesCore";
import { STAGED_PROVIDER_IDS } from "../app/main/services/cloud/cloudCore";

const ref = { provider: "ssh" as const, accountId: "me@box", itemId: "me@box:/data/case.post.msh", name: "case.post.msh" };

describe("ssh documents in the shared staging layer", () => {
  it("stage under ssh/<opaque id>/ with the compound suffix intact, one directory per host+path", () => {
    const rel = cacheRelPath(ref);
    expect(rel).toMatch(/^ssh\/[0-9a-f]{16}\/case\.post\.msh$/);
    expect(cacheRelPath({ ...ref, accountId: "other" })).not.toBe(rel);
  });

  it("are accepted by the manifest, which still rejects unknown providers", () => {
    const entry = { provider: "ssh", accountId: "box", itemId: "box:/a.mdpa", name: "a.mdpa", bytes: 1, syncedAt: 1, lastOpenedAt: 1 };
    expect(parseManifest({ k: entry }).k).toMatchObject({ provider: "ssh", accountId: "box" });
    expect(Object.keys(parseManifest({ k: { ...entry, provider: "ftp" } }))).toEqual([]);
    expect(STAGED_PROVIDER_IDS).toContain("ssh");
  });

  it("recents keep an ssh row whose staged copy was evicted", () => {
    const list = parseRecentFiles([{ path: "/gone/a.mdpa", mode: "mesh", openedAt: 1, cloud: { provider: "ssh", accountId: "box", itemId: "box:/a.mdpa", name: "a.mdpa" } }]);
    expect(list[0].cloud?.provider).toBe("ssh");
    expect(pruneRecentFiles(list, () => false)).toHaveLength(1);
  });
});
