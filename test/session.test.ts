/**
 * sessionCore — what "where I left off" is, and how it degrades. The cases that
 * matter are the ones where the world moved on between quit and launch: files
 * deleted, a stored value from another version, a hand-edited state.json.
 */
import { describe, expect, it } from "vitest";
import {
  captureSession,
  isEmptySession,
  parseSession,
  planRestore,
  isEmptyPlan,
  pruneSession,
  sessionFileCount,
  SESSION_TAB_CAP,
  SESSION_VERSION,
  type SessionCloudRef,
  type SessionState,
} from "../app/main/services/sessionCore";

const snapshot = (files: (string | undefined)[], activeFile?: string) => ({ files, activeFile });
const base = { terminal: false, chat: false } as const;

describe("captureSession", () => {
  it("keeps tab order and the focused document per mode", () => {
    const state = captureSession({
      cad: snapshot(["/a.stp", "/b.stp"], "/b.stp"),
      mesh: snapshot(["/m.mdpa"], "/m.mdpa"),
      screen: "cad",
      ...base,
    });
    expect(state.cad).toEqual({ files: ["/a.stp", "/b.stp"], activeFile: "/b.stp" });
    expect(state.mesh.activeFile).toBe("/m.mdpa");
    expect(state.screen).toBe("cad");
    expect(state.version).toBe(SESSION_VERSION);
  });

  it("drops blank tabs, so empty tabs do not accumulate across launches", () => {
    const state = captureSession({
      cad: snapshot([undefined, "/a.stp", undefined], "/a.stp"),
      mesh: snapshot([undefined], undefined),
      screen: "cad",
      ...base,
    });
    expect(state.cad.files).toEqual(["/a.stp"]);
    expect(state.mesh.files).toEqual([]);
    expect(state.mesh.activeFile).toBeNull();
  });

  it("nulls activeFile when the focused tab was blank", () => {
    const state = captureSession({
      cad: snapshot(["/a.stp", undefined], undefined),
      mesh: snapshot([], undefined),
      screen: "cad",
      ...base,
    });
    expect(state.cad.activeFile).toBeNull();
  });

  it("degrades the editor screen to home at capture time", () => {
    // The editor's buffer is EditorService-owned and unpersisted, so restoring
    // that screen would land on an empty editor.
    const state = captureSession({
      cad: snapshot(["/a.stp"], "/a.stp"),
      mesh: snapshot([], undefined),
      screen: "editor",
      ...base,
    });
    expect(state.screen).toBe("home");
  });

  it("caps how many documents a launch will reopen", () => {
    const many = Array.from({ length: SESSION_TAB_CAP + 4 }, (_, i) => `/f${i}.stp`);
    const state = captureSession({
      cad: snapshot(many, many[0]),
      mesh: snapshot([], undefined),
      screen: "cad",
      ...base,
    });
    expect(state.cad.files).toHaveLength(SESSION_TAB_CAP);
  });

  it("records panel visibility", () => {
    const state = captureSession({
      cad: snapshot([], undefined),
      mesh: snapshot([], undefined),
      screen: "home",
      terminal: true,
      chat: true,
    });
    expect(state).toMatchObject({ terminal: true, chat: true });
  });
});

describe("parseSession", () => {
  it("round-trips a captured session through JSON", () => {
    const state = captureSession({
      cad: snapshot(["/a.stp"], "/a.stp"),
      mesh: snapshot(["/m.mdpa"], "/m.mdpa"),
      screen: "mesh",
      terminal: true,
      chat: false,
    });
    expect(parseSession(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("ignores a value from a different (or missing) version", () => {
    const state = captureSession({
      cad: snapshot(["/a.stp"], "/a.stp"),
      mesh: snapshot([], undefined),
      screen: "cad",
      ...base,
    });
    expect(parseSession({ ...state, version: SESSION_VERSION + 1 })).toBeUndefined();
    expect(parseSession({ ...state, version: undefined })).toBeUndefined();
  });

  it("ignores garbage rather than throwing the launch away", () => {
    expect(parseSession(undefined)).toBeUndefined();
    expect(parseSession("nonsense")).toBeUndefined();
    expect(parseSession([])).toBeUndefined();
  });

  it("repairs a partially damaged value", () => {
    const parsed = parseSession({
      version: SESSION_VERSION,
      cad: { files: ["/a.stp", 42, "", null], activeFile: "/gone.stp" },
      mesh: "not an object",
      screen: "editor",
      terminal: "yes",
    });
    expect(parsed).toEqual({
      version: SESSION_VERSION,
      cad: { files: ["/a.stp"], activeFile: null },
      mesh: { files: [], activeFile: null },
      screen: "home",
      terminal: false,
      chat: false,
    });
  });
});

describe("pruneSession", () => {
  const state = (): SessionState =>
    captureSession({
      cad: snapshot(["/gone.stp", "/here.stp"], "/gone.stp"),
      mesh: snapshot(["/m.mdpa"], "/m.mdpa"),
      screen: "cad",
      ...base,
    });
  const exists = (p: string) => p !== "/gone.stp";

  it("drops vanished files and nulls a focus that pointed at one", () => {
    const pruned = pruneSession(state(), exists);
    expect(pruned.cad.files).toEqual(["/here.stp"]);
    expect(pruned.cad.activeFile).toBeNull();
    expect(pruned.mesh.files).toEqual(["/m.mdpa"]);
  });

  it("falls back to home when the stored screen's mode lost every document", () => {
    const empty = captureSession({
      cad: snapshot(["/gone.stp"], "/gone.stp"),
      mesh: snapshot([], undefined),
      screen: "cad",
      ...base,
    });
    expect(pruneSession(empty, exists).screen).toBe("home");
  });

  it("keeps the screen when that mode still has something to show", () => {
    expect(pruneSession(state(), exists).screen).toBe("cad");
  });

  it("counts what was lost, so a short restore can be explained", () => {
    const before = state();
    expect(sessionFileCount(before) - sessionFileCount(pruneSession(before, exists))).toBe(1);
  });
});

describe("isEmptySession", () => {
  it("is true only when neither mode has a document", () => {
    const none = captureSession({
      cad: snapshot([undefined], undefined),
      mesh: snapshot([], undefined),
      screen: "home",
      terminal: true,
      chat: true,
    });
    expect(isEmptySession(none)).toBe(true);
    expect(
      isEmptySession(
        captureSession({ cad: snapshot(["/a.stp"], "/a.stp"), mesh: snapshot([], undefined), screen: "cad", ...base })
      )
    ).toBe(false);
  });
});

describe("cloud refs in the session", () => {
  const ref = (itemId: string): SessionCloudRef => ({ provider: "dropbox", accountId: "acc", itemId, name: `${itemId}.mdpa`, parentId: "root" });
  const cache = "/cache/dropbox";

  it("captures refs only for open documents, and only when there are any", () => {
    const state = captureSession({
      cad: snapshot([]),
      mesh: { files: [`${cache}/a/a.mdpa`, "/plain.mdpa"], activeFile: undefined, cloud: { [`${cache}/a/a.mdpa`]: ref("a"), "/not-open.mdpa": ref("z") } },
      screen: "mesh",
      ...base,
    });
    expect(state.mesh.cloud).toEqual({ [`${cache}/a/a.mdpa`]: ref("a") });
    expect(state.cad).toEqual({ files: [], activeFile: null }); // no `cloud` key at all
    expect("cloud" in state.cad).toBe(false);
  });

  it("round-trips through parseSession", () => {
    const state = captureSession({ cad: snapshot([]), mesh: { files: [`${cache}/a/a.mdpa`], activeFile: `${cache}/a/a.mdpa`, cloud: { [`${cache}/a/a.mdpa`]: ref("a") } }, screen: "mesh", ...base });
    expect(parseSession(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("parses an older session that has no cloud field, unchanged", () => {
    const old = { version: SESSION_VERSION, cad: { files: ["/a.stp"], activeFile: "/a.stp" }, mesh: { files: [], activeFile: null }, screen: "cad", terminal: false, chat: false };
    expect(parseSession(old)?.cad).toEqual({ files: ["/a.stp"], activeFile: "/a.stp" });
  });

  it("drops malformed, unknown-provider and orphaned refs", () => {
    const parsed = parseSession({
      version: SESSION_VERSION,
      cad: {
        files: ["/a", "/b", "/c"],
        activeFile: null,
        cloud: {
          "/a": { provider: "dropbox", accountId: "x", itemId: "i", name: "a" },
          "/b": { provider: "ftp", accountId: "x", itemId: "i", name: "b" }, // not a provider we know
          "/c": { provider: "dropbox", accountId: "x", name: "c" }, // no itemId
          "/gone": { provider: "dropbox", accountId: "x", itemId: "i", name: "g" }, // not an open file
        },
      },
      mesh: { files: [], activeFile: null },
      screen: "cad",
      terminal: false,
      chat: false,
    });
    expect(Object.keys(parsed!.cad.cloud ?? {})).toEqual(["/a"]);
  });

  it("ignores a cloud field that is not an object", () => {
    for (const cloud of ["x", 3, null, [], true]) {
      const parsed = parseSession({ version: SESSION_VERSION, cad: { files: ["/a"], activeFile: null, cloud }, mesh: {}, screen: "home", terminal: false, chat: false });
      expect(parsed?.cad.cloud).toBeUndefined();
    }
  });
});

describe("planRestore", () => {
  const ref = (itemId: string): SessionCloudRef => ({ provider: "gdrive", accountId: "acc", itemId, name: `${itemId}.vtk` });
  const state = (over: Partial<SessionState["mesh"]>, screen: SessionState["screen"] = "mesh"): SessionState => ({
    version: SESSION_VERSION,
    cad: { files: [], activeFile: null },
    mesh: { files: [], activeFile: null, ...over },
    screen,
    ...base,
  });

  it("keeps present files, pends evicted cloud ones in their saved slot, drops the rest", () => {
    const plan = planRestore(
      state({ files: ["/here.vtk", "/cache/a.vtk", "/lost.vtk", "/cache/b.vtk"], activeFile: "/cache/b.vtk", cloud: { "/cache/a.vtk": ref("a"), "/cache/b.vtk": ref("b") } }),
      (p) => p === "/here.vtk"
    );
    expect(plan.mesh.slots).toEqual([{ path: "/here.vtk" }, { path: "/cache/a.vtk", ref: ref("a") }, { path: "/cache/b.vtk", ref: ref("b") }]);
    expect(plan.mesh.activeFile).toBe("/cache/b.vtk"); // a pending slot can be the focused one
    expect(plan.missing).toBe(1); // only /lost.vtk — pending cloud slots are expected to come back
  });

  it("a cloud file that is still cached is an ordinary slot, not a pending one", () => {
    const plan = planRestore(state({ files: ["/cache/a.vtk"], cloud: { "/cache/a.vtk": ref("a") } }), () => true);
    expect(plan.mesh.slots).toEqual([{ path: "/cache/a.vtk" }]);
  });

  it("stays on the mode screen when only pending slots remain", () => {
    const plan = planRestore(state({ files: ["/cache/a.vtk"], cloud: { "/cache/a.vtk": ref("a") } }), () => false);
    expect(plan.screen).toBe("mesh");
    expect(isEmptyPlan(plan)).toBe(false);
  });

  it("falls back to home when nothing in the screen's mode survives, as pruneSession does", () => {
    const plan = planRestore(state({ files: ["/lost.vtk"] }), () => false);
    expect(plan.screen).toBe("home");
    expect(plan.missing).toBe(1);
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it("drops the focused path when it is dropped", () => {
    const plan = planRestore(state({ files: ["/keep.vtk", "/lost.vtk"], activeFile: "/lost.vtk" }), (p) => p === "/keep.vtk");
    expect(plan.mesh.activeFile).toBeNull();
  });

  it("agrees with pruneSession on a session with no cloud refs", () => {
    const s = state({ files: ["/a", "/b"], activeFile: "/b" });
    const exists = (p: string) => p === "/b";
    expect(planRestore(s, exists).mesh.slots.map((x) => x.path)).toEqual(pruneSession(s, exists).mesh.files);
  });
});
