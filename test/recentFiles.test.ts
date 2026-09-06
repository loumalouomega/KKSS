/**
 * recentFilesCore — KKSS's app-wide recents list. The interesting behavior is
 * the de-duplication rule (path-only, with the mode refreshed) and tolerance of
 * a store that is shared with the mesh extension and editable by hand.
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  addRecentFile,
  parseRecentFiles,
  pruneRecentFiles,
  HOME_RECENT_LIMIT,
  RECENT_CAP,
  type RecentFile,
} from "../app/main/services/recentFilesCore";

const abs = (p: string) => path.resolve(p);

describe("addRecentFile", () => {
  it("puts the newest entry first", () => {
    let list: RecentFile[] = [];
    list = addRecentFile(list, "/tmp/a.stp", "cad", 1);
    list = addRecentFile(list, "/tmp/b.mdpa", "mesh", 2);
    expect(list.map((e) => e.path)).toEqual([abs("/tmp/b.mdpa"), abs("/tmp/a.stp")]);
    expect(list[0]).toMatchObject({ mode: "mesh", openedAt: 2 });
  });

  it("moves a re-opened file to the front instead of adding a row", () => {
    let list: RecentFile[] = [];
    list = addRecentFile(list, "/tmp/a.stp", "cad", 1);
    list = addRecentFile(list, "/tmp/b.mdpa", "mesh", 2);
    list = addRecentFile(list, "/tmp/a.stp", "cad", 3);
    expect(list).toHaveLength(2);
    expect(list[0].path).toBe(abs("/tmp/a.stp"));
    expect(list[0].openedAt).toBe(3);
  });

  it("refreshes the mode when a shared-format file is reopened in the other mode", () => {
    // .stl/.obj/.ply open in either mode — one row that remembers where it was
    // last opened, never two rows one of which reopens in the wrong mode.
    let list = addRecentFile([], "/tmp/part.stl", "cad", 1);
    list = addRecentFile(list, "/tmp/part.stl", "mesh", 2);
    expect(list).toHaveLength(1);
    expect(list[0].mode).toBe("mesh");
  });

  it("resolves relative paths so the same file is one entry", () => {
    let list = addRecentFile([], "./sub/../model.stp", "cad", 1);
    list = addRecentFile(list, "model.stp", "cad", 2);
    expect(list).toHaveLength(1);
    expect(path.isAbsolute(list[0].path)).toBe(true);
  });

  it("caps the list, dropping the oldest", () => {
    let list: RecentFile[] = [];
    for (let i = 0; i < RECENT_CAP + 5; i++) list = addRecentFile(list, `/tmp/f${i}.stp`, "cad", i);
    expect(list).toHaveLength(RECENT_CAP);
    expect(list[0].path).toBe(abs(`/tmp/f${RECENT_CAP + 4}.stp`));
    expect(list.some((e) => e.path === abs("/tmp/f0.stp"))).toBe(false);
  });

  it("folds case on win32 only", () => {
    // Reachable from any host because `platform` is injected.
    const win = addRecentFile(
      [{ path: "C:\\Mesh.mdpa", mode: "mesh", openedAt: 1 }],
      "C:\\Mesh.mdpa",
      "mesh",
      2,
      RECENT_CAP,
      "win32"
    );
    expect(win).toHaveLength(1);

    const posix = addRecentFile(
      [{ path: abs("/tmp/Mesh.mdpa"), mode: "mesh", openedAt: 1 }],
      "/tmp/mesh.mdpa",
      "mesh",
      2,
      RECENT_CAP,
      "linux"
    );
    expect(posix).toHaveLength(2);
  });
});

describe("parseRecentFiles", () => {
  it("reads back what addRecentFile wrote", () => {
    const list = addRecentFile([], "/tmp/a.stp", "cad", 7);
    expect(parseRecentFiles(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });

  it("survives a damaged or foreign value", () => {
    expect(parseRecentFiles(undefined)).toEqual([]);
    expect(parseRecentFiles("nonsense")).toEqual([]);
    expect(parseRecentFiles({ not: "an array" })).toEqual([]);
    expect(
      parseRecentFiles([
        null,
        "string",
        { path: "", mode: "cad", openedAt: 1 },
        { mode: "cad", openedAt: 1 },
        { path: "/tmp/x", openedAt: 1 },
        { path: "/tmp/x", mode: "editor", openedAt: 1 },
        { path: "/tmp/good.stp", mode: "cad", openedAt: 5 },
      ])
    ).toEqual([{ path: "/tmp/good.stp", mode: "cad", openedAt: 5 }]);
  });

  it("defaults a missing timestamp rather than dropping the entry", () => {
    expect(parseRecentFiles([{ path: "/tmp/a.stp", mode: "cad" }])).toEqual([
      { path: "/tmp/a.stp", mode: "cad", openedAt: 0 },
    ]);
  });
});

describe("pruneRecentFiles", () => {
  it("drops entries whose file is gone, keeping order", () => {
    const list: RecentFile[] = [
      { path: "/tmp/gone.stp", mode: "cad", openedAt: 3 },
      { path: "/tmp/here.mdpa", mode: "mesh", openedAt: 2 },
    ];
    expect(pruneRecentFiles(list, (p) => p === "/tmp/here.mdpa")).toEqual([list[1]]);
  });

  it("is a no-op when everything still exists", () => {
    const list: RecentFile[] = [{ path: "/tmp/a.stp", mode: "cad", openedAt: 1 }];
    expect(pruneRecentFiles(list, () => true)).toEqual(list);
  });
});

describe("HOME_RECENT_LIMIT", () => {
  it("is shorter than the menu's cap, so the home screen cannot overflow", () => {
    expect(HOME_RECENT_LIMIT).toBeLessThan(RECENT_CAP);
  });
});
