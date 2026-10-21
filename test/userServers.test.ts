import { describe, expect, it } from "vitest";
import {
  idProblem, isUserTool, launchFingerprint, makeClassifier, marksFor, parseDefinitionText, parseMarks,
  parseServerList, pruneMarks, serializeServers, urlProblem, withMark, MAX_DEFINITION_BYTES,
} from "../app/main/services/chat/userServers";
import { TOOL_ACCESS } from "../app/main/services/chat/toolPolicy";

const stdio = (over: Record<string, unknown> = {}) => ({ id: "acme", command: "node", args: ["s.js"], ...over });

describe("server ids", () => {
  it("accepts lowercase letters, digits and hyphens", () => {
    for (const id of ["acme", "a1", "my-server", "x".repeat(32)]) expect(idProblem(id)).toBeNull();
  });
  it("rejects what splitToolName could not round-trip, and malformed ids", () => {
    for (const id of ["", "Acme", "my_server", "a__b", "1abc", "-a", "x".repeat(33), "a b", 5, undefined]) expect(idProblem(id)).not.toBeNull();
  });
  it("reserves every built-in and synthetic namespace", () => {
    for (const id of ["cad", "mesh", "kratos", "pdf", "app", "mcp"]) expect(idProblem(id)).toMatch(/reserved/);
  });
});

describe("definition parsing", () => {
  it("reads a stdio and an http server", () => {
    const { servers, errors } = parseServerList({ servers: [stdio({ env: ["TOKEN"] }), { id: "web", url: "https://x.test/mcp" }] }, "user");
    expect(errors).toEqual([]);
    expect(servers.map((s) => [s.id, s.transport.type, s.enabled])).toEqual([["acme", "stdio", true], ["web", "http", true]]);
  });
  it("needs exactly one of command and url", () => {
    expect(parseServerList([{ id: "a" }], "user").errors[0]).toMatch(/either/);
    expect(parseServerList([{ id: "a", command: "x", url: "https://x.test" }], "user").servers).toEqual([]);
  });
  it("drops invalid entries but keeps the valid ones, naming the bad id", () => {
    const { servers, errors } = parseServerList([stdio(), stdio({ id: "BAD" }), stdio({ id: "cad" }), stdio({ id: "dup" }), stdio({ id: "dup" })], "user");
    expect(servers.map((s) => s.id)).toEqual(["acme", "dup"]);
    expect(errors).toHaveLength(3);
  });
  it("validates env names, argument types and counts", () => {
    expect(parseServerList([stdio({ env: ["1BAD"] })], "user").servers).toEqual([]);
    expect(parseServerList([stdio({ env: ["A", "A"] })], "user").servers).toEqual([]);
    expect(parseServerList([stdio({ args: [1] })], "user").servers).toEqual([]);
    expect(parseServerList([stdio({ args: Array(65).fill("x") })], "user").servers).toEqual([]);
    expect(parseServerList([stdio({ command: "  " })], "user").servers).toEqual([]);
  });
  it("only a project definition may name a token variable, and only for http", () => {
    expect(parseServerList([{ id: "w", url: "https://x.test", tokenEnv: "TOK" }], "project").servers).toHaveLength(1);
    expect(parseServerList([{ id: "w", url: "https://x.test", tokenEnv: "TOK" }], "user").servers).toEqual([]);
    expect(parseServerList([stdio({ tokenEnv: "TOK" })], "project").servers).toEqual([]);
  });
  it("caps the file size and reports bad JSON instead of throwing", () => {
    expect(parseDefinitionText("x".repeat(MAX_DEFINITION_BYTES + 1), "project").errors[0]).toMatch(/larger/);
    expect(parseDefinitionText("{nope", "project").errors[0]).toMatch(/not valid JSON/);
    expect(parseDefinitionText("[]", "project")).toEqual({ servers: [], errors: [] });
    expect(parseDefinitionText("{}", "project").errors[0]).toMatch(/servers/);
  });
  it("round-trips through serializeServers", () => {
    const first = parseServerList([stdio({ env: ["K"], enabled: false }), { id: "w", url: "http://127.0.0.1:9/mcp" }], "user").servers;
    expect(parseServerList(serializeServers(first), "user").servers).toEqual(first);
  });
});

describe("urls", () => {
  it("accepts http(s) only and refuses embedded credentials", () => {
    expect(urlProblem("https://x.test/mcp", false)).toBeNull();
    expect(urlProblem("ftp://x.test", false)).toMatch(/http/);
    expect(urlProblem("not a url", false)).toMatch(/valid/);
    expect(urlProblem("https://u:p@x.test", false)).toMatch(/credentials/);
  });
  it("refuses a bearer token over cleartext unless the host is this machine", () => {
    expect(urlProblem("http://x.test/mcp", true)).toMatch(/https/);
    expect(urlProblem("http://x.test/mcp", false)).toBeNull();
    for (const url of ["http://localhost:1/m", "http://127.0.0.1:1/m", "http://[::1]:1/m"]) expect(urlProblem(url, true)).toBeNull();
    expect(urlProblem("http://127.0.0.1.evil.test/m", true)).toMatch(/https/);
  });
});

describe("launch fingerprint and marks", () => {
  const def = (over: Record<string, unknown> = {}) => parseServerList([stdio(over)], "user").servers[0];
  it("changes with the command, arguments and url — not with the name or enabled flag", () => {
    const base = launchFingerprint(def());
    expect(launchFingerprint(def({ command: "deno" }))).not.toBe(base);
    expect(launchFingerprint(def({ args: ["other.js"] }))).not.toBe(base);
    expect(launchFingerprint(def({ name: "Other", enabled: false }))).toBe(base);
  });
  it("a swapped binary does not inherit a mark", () => {
    const fp = launchFingerprint(def());
    const store = withMark({}, "acme", fp, "lookup", "read");
    expect(marksFor(store, "acme", fp)).toEqual({ lookup: "read" });
    expect(marksFor(store, "acme", launchFingerprint(def({ command: "evil" })))).toEqual({});
    expect(withMark(store, "acme", "other-fp", "x", "write").acme).toEqual({ fingerprint: "other-fp", tools: { x: "write" } });
  });
  it("clearing the last mark drops the server's entry", () => {
    const store = withMark(withMark({}, "acme", "f", "a", "read"), "acme", "f", "a", null);
    expect(store).toEqual({});
  });
  it("prunes marks of removed or re-launched servers", () => {
    const store = { a: { fingerprint: "1", tools: { t: "read" as const } }, b: { fingerprint: "2", tools: { t: "read" as const } } };
    expect(pruneMarks(store, { a: "1", b: "changed" })).toEqual({ a: store.a });
  });
  it("reads stored marks defensively", () => {
    expect(parseMarks(null)).toEqual({});
    expect(parseMarks({ cad: { fingerprint: "f", tools: { x: "read" } } })).toEqual({});
    expect(parseMarks({ ok: { fingerprint: "f", tools: { a: "read", b: "maybe" } }, bad: "x", empty: { fingerprint: "f", tools: {} } }))
      .toEqual({ ok: { fingerprint: "f", tools: { a: "read" } } });
  });
});

describe("the gate's classifier", () => {
  const classify = makeClassifier((id) => (id === "acme" ? { lookup: "read", wipe: "write" } : undefined));
  it("leaves built-in names to the reviewed table, unchanged", () => {
    for (const name of Object.keys(TOOL_ACCESS)) expect(classify(name)).toBe(TOOL_ACCESS[name]);
  });
  it("uses marks for a user server and defaults everything else to unknown", () => {
    expect(classify("acme__lookup")).toBe("read");
    expect(classify("acme__wipe")).toBe("write");
    expect(classify("acme__other")).toBe("unknown");
    expect(classify("nobody__lookup")).toBe("unknown");
    expect(classify("plain")).toBe("unknown");
  });
  it("a name that merely looks like a built-in row never inherits it", () => {
    // `cad` is reserved, so a user server cannot be called that; and a
    // tool called `cad__list_layers` under another id is a different string.
    expect(classify("acme__cad__list_layers")).toBe("unknown");
  });
  it("tells user tools from built-in ones", () => {
    expect(isUserTool("acme__lookup")).toBe(true);
    for (const name of ["cad__x", "mesh__x", "kratos__x", "pdf__x", "app__x", "mcp__x", "bare"]) expect(isUserTool(name)).toBe(false);
  });
});
