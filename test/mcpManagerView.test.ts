import { describe, expect, it } from "vitest";
import { buildInput, joinArgs, orderRows, projectActions, rowActions, splitArgs, type FormValues } from "../app/renderer/chat/mcpManagerView";
import type { ChatMcpServerRow } from "../app/main/ipc";

const form = (over: Partial<FormValues> = {}): FormValues => ({
  id: "acme", name: "", transport: "stdio", command: "node", args: "", url: "", env: [], token: "", clearToken: false, ...over,
});
const row = (over: Partial<ChatMcpServerRow> = {}): ChatMcpServerRow => ({
  id: "acme", name: "acme", source: "user", transport: "stdio", state: "ready", enabled: true, editable: true, toolCount: 2, ...over,
});

describe("argument line", () => {
  it("splits on whitespace and groups with quotes", () => {
    expect(splitArgs("a b  c")).toEqual(["a", "b", "c"]);
    expect(splitArgs('--name "two words" \'single quoted\'')).toEqual(["--name", "two words", "single quoted"]);
    expect(splitArgs('""')).toEqual([""]);
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("  ")).toEqual([]);
  });
  it("escapes only inside double quotes, so Windows paths survive", () => {
    expect(splitArgs('"say \\"hi\\" \\\\ now"')).toEqual(['say "hi" \\ now']);
    expect(splitArgs("C:\\tools\\srv.exe")).toEqual(["C:\\tools\\srv.exe"]);
    expect(splitArgs("a\"b c\"d")).toEqual(["ab cd"]);
  });
  it("tolerates an unterminated quote", () => {
    expect(splitArgs('a "b c')).toEqual(["a", "b c"]);
  });
  it("round-trips through joinArgs", () => {
    for (const args of [["a", "b c", ""], ['say "hi"'], ["C:\\a b\\c"], ["x'y"], ["--flag=1", "path with  spaces"], []]) {
      expect(splitArgs(joinArgs(args))).toEqual(args);
    }
  });
});

describe("building the save payload", () => {
  it("requires an id and the transport's own field", () => {
    expect(buildInput(form({ id: " " }))).toEqual({ ok: false, problems: ["id"] });
    expect(buildInput(form({ command: "" }))).toEqual({ ok: false, problems: ["command"] });
    expect(buildInput(form({ transport: "http", url: "" }))).toEqual({ ok: false, problems: ["url"] });
  });
  it("builds a stdio payload, treating a blank value as keep-what-is-stored", () => {
    const built = buildInput(form({ name: " Acme ", args: 'a "b c"', env: [{ name: "KEY", value: "v" }, { name: "OLD", value: "" }, { name: "KEY", value: "dup" }, { name: " ", value: "x" }] }));
    expect(built).toEqual({ ok: true, input: { id: "acme", name: "Acme", transport: "stdio", command: "node", args: ["a", "b c"], env: [{ name: "KEY", value: "v" }, { name: "OLD" }] } });
  });
  it("builds an http payload; the token is kept, replaced or cleared", () => {
    const http = { transport: "http" as const, url: " https://x.test/mcp " };
    expect(buildInput(form(http))).toEqual({ ok: true, input: { id: "acme", transport: "http", url: "https://x.test/mcp" } });
    expect(buildInput(form({ ...http, token: "t" }))).toMatchObject({ input: { token: "t" } });
    expect(buildInput(form({ ...http, token: "t", clearToken: true }))).toMatchObject({ input: { token: "" } });
  });
});

describe("what each row offers", () => {
  it("a built-in only restarts, and only once it is settled", () => {
    expect(rowActions(row({ source: "builtin", editable: false }), false)).toEqual({ restart: true, toggle: false, edit: false, remove: false, tools: true });
    expect(rowActions(row({ source: "builtin", state: "starting" }), false).restart).toBe(false);
  });
  it("a project server follows its file", () => {
    expect(rowActions(row({ source: "project" }), false)).toMatchObject({ toggle: false, edit: false, remove: false, restart: true });
  });
  it("a blocked server cannot be restarted into existence", () => {
    expect(rowActions(row({ state: "untrusted", source: "project" }), false).restart).toBe(false);
    expect(rowActions(row({ state: "disabled" }), false)).toMatchObject({ restart: false, toggle: true, tools: false });
  });
  it("a managed store offers no edits", () => {
    expect(rowActions(row(), true)).toMatchObject({ toggle: false, edit: false, remove: false });
  });
  it("project trust controls follow the state", () => {
    expect(projectActions({ state: "untrusted", root: "/p", errors: [] }, false)).toEqual({ trust: true, revoke: false, reload: true });
    expect(projectActions({ state: "trusted", root: "/p", errors: [] }, false)).toEqual({ trust: false, revoke: true, reload: true });
    expect(projectActions({ state: "changed", root: "/p", errors: [] }, false)).toEqual({ trust: true, revoke: true, reload: true });
    expect(projectActions({ state: "none", errors: [] }, false)).toEqual({ trust: false, revoke: false, reload: false });
    expect(projectActions({ state: "untrusted", root: "/p", errors: [] }, true).trust).toBe(false);
  });
  it("orders built-ins, then yours, then the project's, keeping each group's order", () => {
    const ordered = orderRows([row({ id: "p", source: "project" }), row({ id: "u1" }), row({ id: "cad", source: "builtin" }), row({ id: "u2" }), row({ id: "mesh", source: "builtin" })]);
    expect(ordered.map((r) => r.id)).toEqual(["cad", "mesh", "u1", "u2", "p"]);
  });
});
