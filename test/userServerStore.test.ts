import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserServerStore, MCP_SERVERS_KEY, MCP_TRUST_KEY, type StoreDeps } from "../app/main/services/chat/userServerStore";
import { hashDefinitions, parseTrustStore, trustState, withTrust, withoutTrust } from "../app/main/services/chat/folderTrustCore";

let tmp: string;
let root: string | undefined;
let state: Map<string, unknown>;
let secrets: Map<string, string>;
let managed: Set<string>;
let env: NodeJS.ProcessEnv;

function makeStore(): UserServerStore {
  const deps: StoreDeps = {
    get: (key) => state.get(key) as never,
    update: async (key, value) => { if (value === undefined) state.delete(key); else state.set(key, JSON.parse(JSON.stringify(value))); },
    isManaged: (key) => managed.has(key),
    getSecret: (key) => secrets.get(key),
    setSecret: async (key, value) => { if (value) secrets.set(key, value); else secrets.delete(key); },
    explicitRoot: () => root,
    env: () => env,
    now: () => 1700000000000,
  };
  return new UserServerStore(deps);
}

function writeProject(content: unknown, name = "mcp.json") {
  const dir = path.join(tmp, ".kkss", "assistant");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kkss-mcp-")));
  root = tmp;
  state = new Map(); secrets = new Map(); managed = new Set(); env = { PROJECT_TOKEN: "tok-from-host", HOST_VAR: "hv" };
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const PROJECT = { servers: [{ id: "lab", command: "node", args: ["srv.js"], env: ["HOST_VAR"] }] };

describe("folder trust record (pure)", () => {
  it("hashes the present files, order-independently and without ambiguity", () => {
    expect(hashDefinitions({})).toBeNull();
    expect(hashDefinitions({ a: "x", b: "y" })).toBe(hashDefinitions({ b: "y", a: "x" }));
    expect(hashDefinitions({ a: "bc" })).not.toBe(hashDefinitions({ ab: "c" }));
    expect(hashDefinitions({ a: "x" })).not.toBe(hashDefinitions({ a: "y" }));
  });
  it("decides none / untrusted / trusted / changed", () => {
    const h1 = hashDefinitions({ "mcp.json": "1" })!;
    const h2 = hashDefinitions({ "mcp.json": "2" })!;
    let store = {};
    expect(trustState(store, "/r", null)).toBe("none");
    expect(trustState(store, "/r", h1)).toBe("untrusted");
    store = withTrust(store, "/r", h1, 1);
    expect(trustState(store, "/r", h1)).toBe("trusted");
    expect(trustState(store, "/r", h2)).toBe("changed");
    expect(trustState(store, "/other", h1)).toBe("untrusted");
    expect(trustState(withoutTrust(store, "/r"), "/r", h1)).toBe("untrusted");
  });
  it("ignores a malformed stored record", () => {
    expect(parseTrustStore({ "/r": { hash: "nothex", at: 1 }, "/s": 3 })).toEqual({});
  });
});

describe("project definitions and trust", () => {
  it("has no project state without an explicit root or a file", () => {
    root = undefined;
    expect(makeStore().projectInfo().state).toBe("none");
    root = tmp;
    expect(makeStore().projectInfo().state).toBe("none");
  });
  it("never launches an untrusted project server, and says so", () => {
    writeProject(PROJECT);
    const store = makeStore();
    expect(store.projectInfo()).toMatchObject({ state: "untrusted", root: tmp });
    const spec = store.specs().find((s) => s.key === "lab")!;
    expect(spec).toMatchObject({ source: "project", blocked: "untrusted" });
    expect(store.rows([]).find((r) => r.id === "lab")).toMatchObject({ source: "project", state: "starting", editable: false });
  });
  it("trusting records the hash on disk now, and unblocks the server", async () => {
    writeProject(PROJECT);
    const store = makeStore();
    expect(await store.trustProject()).toEqual({ ok: true });
    expect(store.projectInfo().state).toBe("trusted");
    const spec = store.specs().find((s) => s.key === "lab")!;
    expect(spec.blocked).toBeUndefined();
    expect(spec.preflight?.()).toBeNull();
    // The environment comes from the host, by name — the file carries no value.
    expect(spec.resolveEnv?.()).toEqual({ HOST_VAR: "hv" });
    expect(spec.env).toEqual({});
  });
  it("an edit after trust blocks the next spawn even though the server was loaded as trusted", async () => {
    writeProject(PROJECT);
    const store = makeStore();
    await store.trustProject();
    const spec = store.specs().find((s) => s.key === "lab")!;
    let notified = 0;
    store.onChange(() => notified++);
    writeProject({ servers: [{ id: "lab", command: "rm", args: ["-rf", "/"] }] });
    expect(spec.preflight?.()).toBe("untrusted");
    expect(store.projectInfo().state).toBe("changed");
    expect(notified).toBeGreaterThan(0);
    expect(store.specs().find((s) => s.key === "lab")!.blocked).toBe("untrusted");
  });
  it("revoking returns to untrusted", async () => {
    writeProject(PROJECT);
    const store = makeStore();
    await store.trustProject();
    await store.revokeProject();
    expect(store.projectInfo().state).toBe("untrusted");
    expect(state.has(MCP_TRUST_KEY)).toBe(false);
  });
  it("trust is per explicit root", async () => {
    writeProject(PROJECT);
    const store = makeStore();
    await store.trustProject();
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kkss-mcp-other-")));
    try {
      fs.mkdirSync(path.join(other, ".kkss", "assistant"), { recursive: true });
      fs.copyFileSync(path.join(tmp, ".kkss", "assistant", "mcp.json"), path.join(other, ".kkss", "assistant", "mcp.json"));
      root = other;
      expect(makeStore().projectInfo().state).toBe("untrusted");
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });
  it("refuses a definition file that is a symlink or lives outside the folder", async () => {
    const outside = path.join(os.tmpdir(), `kkss-outside-${process.pid}.json`);
    fs.writeFileSync(outside, JSON.stringify(PROJECT));
    try {
      fs.mkdirSync(path.join(tmp, ".kkss", "assistant"), { recursive: true });
      fs.symlinkSync(outside, path.join(tmp, ".kkss", "assistant", "mcp.json"));
      const store = makeStore();
      expect(store.projectInfo().state).toBe("invalid");
      expect(store.specs()).toEqual([]);
      expect(await store.trustProject()).toMatchObject({ ok: false, code: "invalid" });
    } finally { fs.rmSync(outside, { force: true }); }
  });
  it("reports parse problems so a typo is not a silent no-op", () => {
    writeProject({ servers: [{ id: "BAD", command: "x" }, ...PROJECT.servers] });
    const info = makeStore().projectInfo();
    expect(info.errors.join(" ")).toMatch(/BAD|id/);
  });
  it("a user server wins an id collision with a project server", async () => {
    writeProject(PROJECT);
    const store = makeStore();
    await store.save({ id: "lab", transport: "stdio", command: "mine" });
    const specs = store.specs().filter((s) => s.key === "lab");
    expect(specs).toHaveLength(1);
    expect(specs[0].source).toBe("user");
  });
  it("project http servers read their token from the named host variable", async () => {
    writeProject({ servers: [{ id: "web", url: "https://lab.test/mcp", tokenEnv: "PROJECT_TOKEN" }] });
    const store = makeStore();
    await store.trustProject();
    expect(store.specs().find((s) => s.key === "web")!.http!.token!()).toBe("tok-from-host");
  });
});

describe("user servers", () => {
  it("saves a stdio server, keeping env values in the secret store only", async () => {
    const store = makeStore();
    const result = await store.save({ id: "acme", name: "Acme", transport: "stdio", command: "node", args: ["s.js"], env: [{ name: "API_KEY", value: "s3cret" }] });
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify([...state.entries()])).not.toContain("s3cret");
    expect(secrets.get("assistantMcp.acme.env.API_KEY")).toBe("s3cret");
    const spec = store.specs()[0];
    expect(spec).toMatchObject({ key: "acme", name: "Acme", source: "user", command: "node", args: ["s.js"], env: {} });
    expect(spec.resolveEnv?.()).toEqual({ API_KEY: "s3cret" });
    const row = store.rows([])[0];
    expect(row).toMatchObject({ id: "acme", envNames: ["API_KEY"], editable: true });
    expect(JSON.stringify(row)).not.toContain("s3cret");
  });
  it("keeps an unchanged secret when the value is omitted, and deletes secrets of dropped names", async () => {
    const store = makeStore();
    await store.save({ id: "acme", transport: "stdio", command: "node", env: [{ name: "A", value: "1" }, { name: "B", value: "2" }] });
    await store.save({ id: "acme", transport: "stdio", command: "node", env: [{ name: "A" }] });
    expect(secrets.get("assistantMcp.acme.env.A")).toBe("1");
    expect(secrets.has("assistantMcp.acme.env.B")).toBe(false);
  });
  it("refuses reserved and malformed ids, bad urls and a cleartext token", async () => {
    const store = makeStore();
    expect(await store.save({ id: "cad", transport: "stdio", command: "x" })).toMatchObject({ ok: false, code: "reserved" });
    expect(await store.save({ id: "a__b", transport: "stdio", command: "x" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await store.save({ id: "w", transport: "http", url: "ftp://x" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await store.save({ id: "w", transport: "http", url: "http://remote.test/mcp", token: "t" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await store.save({ id: "w", transport: "http", url: "http://127.0.0.1:9/mcp", token: "t" })).toEqual({ ok: true });
    expect(secrets.get("assistantMcp.w.token")).toBe("t");
    expect(store.rows([])[0]).toMatchObject({ tokenSet: true });
    expect(store.userServers()).toHaveLength(1);
  });
  it("a stored token blocks switching the url to cleartext", async () => {
    const store = makeStore();
    await store.save({ id: "w", transport: "http", url: "https://remote.test/mcp", token: "t" });
    expect(await store.save({ id: "w", transport: "http", url: "http://remote.test/mcp" })).toMatchObject({ ok: false, code: "invalid" });
  });
  it("enable/disable and remove, which also clears the secrets", async () => {
    const store = makeStore();
    await store.save({ id: "acme", transport: "stdio", command: "node", env: [{ name: "K", value: "v" }] });
    await store.setEnabled("acme", false);
    expect(store.specs()[0].blocked).toBe("disabled");
    expect(store.rows([])[0]).toMatchObject({ enabled: false, state: "disabled" });
    await store.remove("acme");
    expect(store.specs()).toEqual([]);
    expect(secrets.size).toBe(0);
    expect(state.has(MCP_SERVERS_KEY)).toBe(false);
    expect(await store.remove("acme")).toMatchObject({ ok: false, code: "unknown" });
  });
  it("a secret change bumps the revision so the manager reconnects", async () => {
    const store = makeStore();
    await store.save({ id: "acme", transport: "stdio", command: "node", env: [{ name: "K", value: "1" }] });
    const before = store.specs()[0].revision;
    await store.save({ id: "acme", transport: "stdio", command: "node", env: [{ name: "K", value: "2" }] });
    expect(store.specs()[0].revision).not.toBe(before);
  });
  it("refuses every edit when the store is managed", async () => {
    managed.add(MCP_SERVERS_KEY);
    const store = makeStore();
    expect(store.managed()).toBe(true);
    expect(await store.save({ id: "acme", transport: "stdio", command: "x" })).toMatchObject({ ok: false, code: "managed" });
    expect(await store.trustProject()).toMatchObject({ ok: false, code: "managed" });
    expect(await store.setMark("acme", "t", "read")).toMatchObject({ ok: false, code: "managed" });
  });
});

describe("tool marks", () => {
  it("default to unknown, are set by the user, and are bound to the launch fingerprint", async () => {
    const store = makeStore();
    await store.save({ id: "acme", transport: "stdio", command: "node", args: ["a.js"] });
    const classify = store.classifier();
    expect(classify("acme__lookup")).toBe("unknown");
    expect(await store.setMark("acme", "lookup", "read")).toEqual({ ok: true });
    expect(classify("acme__lookup")).toBe("read");
    expect(store.markOf("acme", "lookup")).toBe("read");
    // Editing what gets launched discards the mark.
    await store.save({ id: "acme", transport: "stdio", command: "node", args: ["swapped.js"] });
    expect(classify("acme__lookup")).toBe("unknown");
  });
  it("can be cleared back to unknown, and refuse unknown servers", async () => {
    const store = makeStore();
    await store.save({ id: "acme", transport: "stdio", command: "node" });
    await store.setMark("acme", "t", "write");
    await store.setMark("acme", "t", "unknown");
    expect(store.markOf("acme", "t")).toBe("unknown");
    expect(await store.setMark("ghost", "t", "read")).toMatchObject({ ok: false, code: "unknown" });
    expect(await store.setMark("cad", "t", "read")).toMatchObject({ ok: false, code: "unknown" });
  });
  it("a project file cannot carry marks, and removing the server drops its marks", async () => {
    writeProject({ servers: [{ id: "lab", command: "node", marks: { t: "read" } }] });
    const store = makeStore();
    await store.trustProject();
    expect(store.classifier()("lab__t")).toBe("unknown");
    await store.save({ id: "acme", transport: "stdio", command: "node" });
    await store.setMark("acme", "t", "read");
    await store.remove("acme");
    expect(store.classifier()("acme__t")).toBe("unknown");
  });
  it("leaves built-in names to the reviewed table", () => {
    const classify = makeStore().classifier();
    expect(classify("cad__list_layers")).toBe("read");
    expect(classify("cad__set_layer")).toBe("write");
  });
});
