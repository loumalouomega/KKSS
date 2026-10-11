/**
 * services/cloud/companions.ts — downloading a document's companion files and
 * resolving remote folders for their upload, against an in-memory fake remote.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadCompanions, RemoteFolders } from "../app/main/services/cloud/companions";
import { StagingCache } from "../app/main/services/cloud/stagingCache";
import { CloudError, type CloudFile } from "../app/main/services/cloud/cloudCore";
import type { CloudProvider } from "../app/main/services/cloud/cloudProvider";

/** `tree` maps a folder id to its children; file bodies are keyed by id. */
class FakeRemote {
  tree = new Map<string, CloudFile[]>();
  bodies = new Map<string, string>();
  failDownload = new Set<string>();
  ensured: string[] = [];

  folder(id: string, name: string): CloudFile {
    return { id, name, isFolder: true };
  }
  file(id: string, name: string, body = "data"): CloudFile {
    this.bodies.set(id, body);
    return { id, name, isFolder: false, rev: `rev-${id}`, size: body.length };
  }

  asProvider(): CloudProvider {
    const self = this;
    return {
      async findChild(parent: string, name: string) {
        return (self.tree.get(parent) ?? []).find((c) => c.name === name);
      },
      async list(folderId: string | undefined) {
        return { files: self.tree.get(folderId ?? "") ?? [] };
      },
      async download(file: CloudFile, dest: string) {
        if (self.failDownload.has(file.id)) throw new CloudError("network", "down");
        fs.writeFileSync(dest, self.bodies.get(file.id) ?? "");
      },
      async ensureFolder(parent: string, name: string) {
        self.ensured.push(`${parent}>${name}`);
        return { id: `${parent}/${name}`, name, isFolder: true };
      },
    } as unknown as CloudProvider;
  }
}

let dir: string;
let remote: FakeRemote;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-comp-"));
  remote = new FakeRemote();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("downloadCompanions", () => {
  it("mirrors the polyMesh tree and records a baseline per file", async () => {
    remote.tree.set("root", [remote.folder("c", "constant"), remote.file("m", "case.foam", "")]);
    remote.tree.set("c", [remote.folder("pm", "polyMesh")]);
    remote.tree.set("pm", [remote.file("p", "points", "PPP"), remote.file("f", "faces", "FF")]);
    const got = await downloadCompanions(remote.asProvider(), "root", "case.foam", dir);
    expect(fs.readFileSync(path.join(dir, "constant/polyMesh/points"), "utf8")).toBe("PPP");
    expect(Object.keys(got.baselines).sort()).toEqual([
      "constant/polyMesh/faces",
      "constant/polyMesh/points",
    ]);
    expect(got.baselines["constant/polyMesh/points"].rev).toBe("rev-p");
    expect(got.bytes).toBe(5);
  });

  it("is fine with a case that has no mesh yet", async () => {
    remote.tree.set("root", [remote.file("m", "case.foam", "")]);
    expect(await downloadCompanions(remote.asProvider(), "root", "case.foam", dir)).toEqual({
      baselines: {},
      bytes: 0,
    });
  });

  it("fetches XDMF's sibling .h5 when present, and nothing otherwise", async () => {
    remote.tree.set("root", [remote.file("h", "run.h5", "HDF"), remote.file("o", "other.h5")]);
    const got = await downloadCompanions(remote.asProvider(), "root", "run.xdmf", dir);
    expect(Object.keys(got.baselines)).toEqual(["run.h5"]);
    expect(fs.existsSync(path.join(dir, "other.h5"))).toBe(false);
  });

  it("fails the stage when any companion cannot be downloaded", async () => {
    remote.tree.set("root", [remote.folder("c", "constant")]);
    remote.tree.set("c", [remote.folder("pm", "polyMesh")]);
    remote.tree.set("pm", [remote.file("p", "points"), remote.file("f", "faces")]);
    remote.failDownload.add("f");
    await expect(downloadCompanions(remote.asProvider(), "root", "case.foam", dir)).rejects.toMatchObject({
      kind: "network",
    });
  });

  it("refuses a name it could not store faithfully", async () => {
    remote.tree.set("root", [remote.folder("c", "constant")]);
    remote.tree.set("c", [remote.folder("pm", "polyMesh")]);
    remote.tree.set("pm", [remote.file("p", "po:ints")]);
    await expect(downloadCompanions(remote.asProvider(), "root", "case.foam", dir)).rejects.toMatchObject({
      kind: "other",
    });
  });

  it("stops at the file cap instead of filling the cache", async () => {
    remote.tree.set("root", [remote.folder("c", "constant")]);
    remote.tree.set("c", [remote.folder("pm", "polyMesh")]);
    remote.tree.set(
      "pm",
      Array.from({ length: 201 }, (_, i) => remote.file(`id${i}`, `f${i}`, "x"))
    );
    await expect(downloadCompanions(remote.asProvider(), "root", "case.foam", dir)).rejects.toThrow(
      /more than 200/
    );
  });

  it("does not descend past the allowed depth", async () => {
    remote.tree.set("root", [remote.folder("c", "constant")]);
    remote.tree.set("c", [remote.folder("pm", "polyMesh")]);
    remote.tree.set("pm", [remote.folder("s", "sets"), remote.file("p", "points")]);
    remote.tree.set("s", [remote.folder("d", "deep"), remote.file("i", "inlet")]);
    remote.tree.set("d", [remote.file("z", "too-far")]);
    const got = await downloadCompanions(remote.asProvider(), "root", "case.foam", dir);
    expect(Object.keys(got.baselines).sort()).toEqual([
      "constant/polyMesh/points",
      "constant/polyMesh/sets/inlet",
    ]);
  });
});

describe("RemoteFolders", () => {
  it("asks the provider once per directory, parents first", async () => {
    const folders = new RemoteFolders(remote.asProvider(), "root");
    const [a, b] = await Promise.all([
      folders.resolve("constant/polyMesh"),
      folders.resolve("constant/polyMesh"),
    ]);
    expect(a).toBe("root/constant/polyMesh");
    expect(b).toBe(a);
    expect(await folders.resolve("")).toBe("root");
    expect(remote.ensured).toEqual(["root>constant", "root/constant>polyMesh"]);
  });

  it("does not cache a failed attempt", async () => {
    const provider = remote.asProvider();
    let fail = true;
    const original = provider.ensureFolder.bind(provider);
    provider.ensureFolder = async (p, n) => {
      if (fail) throw new CloudError("network", "down");
      return original(p, n);
    };
    const folders = new RemoteFolders(provider, "root");
    await expect(folders.resolve("constant")).rejects.toMatchObject({ kind: "network" });
    fail = false;
    expect(await folders.resolve("constant")).toBe("root/constant");
  });
});

describe("StagingCache.stage with companions", () => {
  const ref = { provider: "dropbox" as const, accountId: "a", itemId: "/kkss/case.foam", name: "case.foam", parentId: "/kkss" };

  const providerFor = (r: FakeRemote): CloudProvider => {
    const base = r.asProvider();
    return {
      ...base,
      stat: async () => ({ id: ref.itemId, name: "case.foam", isFolder: false, rev: "d1", size: 0, parentId: "/kkss" }),
      download: async (file: CloudFile, dest: string) => base.download(file, dest),
    } as unknown as CloudProvider;
  };

  it("downloads the tree beside the marker and records baselines and size", async () => {
    remote.tree.set("/kkss", [remote.folder("c", "constant")]);
    remote.tree.set("c", [remote.folder("pm", "polyMesh")]);
    remote.tree.set("pm", [remote.file("p", "points", "PPPP")]);
    const cache = new StagingCache(path.join(dir, "cache"));
    const doc = await cache.stage(providerFor(remote), ref);
    expect(fs.readFileSync(path.join(doc.dir, "constant/polyMesh/points"), "utf8")).toBe("PPPP");
    const entry = cache.entry(doc.key)!;
    expect(entry.companions).toEqual({ "constant/polyMesh/points": { rev: "rev-p", precondition: undefined } });
    expect(entry.bytes).toBe(4);
    cache.flushSync();
  });

  it("fails the open rather than staging a half-downloaded mesh", async () => {
    remote.tree.set("/kkss", [remote.folder("c", "constant")]);
    remote.tree.set("c", [remote.folder("pm", "polyMesh")]);
    remote.tree.set("pm", [remote.file("p", "points")]);
    remote.failDownload.add("p");
    const cache = new StagingCache(path.join(dir, "cache"));
    await expect(cache.stage(providerFor(remote), ref)).rejects.toMatchObject({ kind: "network" });
    expect(cache.entry(cache.documentFor(ref).key)).toBeUndefined();
  });
});
