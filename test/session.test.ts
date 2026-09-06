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
  pruneSession,
  sessionFileCount,
  SESSION_TAB_CAP,
  SESSION_VERSION,
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
