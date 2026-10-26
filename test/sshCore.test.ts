import { describe, expect, it } from "vitest";
import {
  decodeId,
  encodeId,
  fileFromStat,
  isValidHost,
  joinRemote,
  listCommand,
  parseList,
  parseStat,
  remoteUvxCommand,
  shQuote,
  sshArgs,
  statCommand,
  uploadCommand,
} from "../app/main/services/cloud/providerCore/sshCore";

describe("ssh host and quoting rules", () => {
  it("accepts aliases and user@host, rejects option-like and shell-shaped hosts", () => {
    for (const ok of ["buildbox", "me@cluster.example.org", "node_01", "10.0.0.5"]) expect(isValidHost(ok)).toBe(true);
    for (const bad of ["", "-oProxyCommand=evil", "a b", "host;rm", "host$(x)", "a:b", "x".repeat(300)]) {
      expect(isValidHost(bad)).toBe(false);
    }
  });

  it("single-quotes a path so it stays one shell word", () => {
    expect(shQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    expect(shQuote("$(rm -rf ~)")).toBe(`'$(rm -rf ~)'`);
  });

  it("never lets a host become an ssh option", () => {
    expect(() => sshArgs("-oProxyCommand=x", "ls")).toThrow();
    const args = sshArgs("buildbox", "ls");
    expect(args).toContain("BatchMode=yes");
    expect(args.slice(-2)).toEqual(["buildbox", "ls"]);
  });
});

describe("item ids", () => {
  it("round-trips host and path, including an empty (login directory) path", () => {
    expect(decodeId(encodeId("me@box", "/data/a:b.mdpa"))).toEqual({ host: "me@box", path: "/data/a:b.mdpa" });
    expect(decodeId(encodeId("box", ""))).toEqual({ host: "box", path: "" });
  });

  it("refuses an id whose host is not valid", () => {
    expect(() => decodeId("-oX=y:/etc")).toThrow();
    expect(() => decodeId("nohost")).toThrow();
  });

  it("joins without doubling slashes", () => {
    expect(joinRemote("/a", "b")).toBe("/a/b");
    expect(joinRemote("/", "b")).toBe("/b");
  });
});

describe("remote command text", () => {
  it("quotes every path and goes to the login directory when none is given", () => {
    expect(listCommand("")).toBe("cd && pwd -P && LC_ALL=C ls -1Ap");
    expect(listCommand("/x y")).toContain("cd -- '/x y'");
    expect(statCommand("/x'y")).toContain(`'/x'\\''y'`);
    expect(uploadCommand("/d/model.mdpa")).toContain("mv -f");
    expect(uploadCommand("/d/model.mdpa")).toContain("cp -p");
  });

  it("builds a uvx launch with a usable PATH and quoted arguments", () => {
    const cmd = remoteUvxCommand(["--with", "mcp<2", "kratos-mcp-server@0.9.0"]);
    expect(cmd).toContain(".local/bin");
    expect(cmd).toContain(`'mcp<2'`);
    expect(cmd).toContain("exec uvx");
  });
});

describe("output parsers", () => {
  it("parses GNU and BSD stat output into a mtime:size revision", () => {
    expect(parseStat("regular file|1234|1700000000\n")).toEqual({ isFolder: false, size: 1234, mtime: 1700000000 });
    expect(parseStat("Directory|96|1700000001")).toMatchObject({ isFolder: true });
    expect(parseStat("garbage")).toBeUndefined();
    const file = fileFromStat("box", "/d/m.mdpa", { isFolder: false, size: 7, mtime: 5 });
    expect(file).toMatchObject({ id: "box:/d/m.mdpa", name: "m.mdpa", rev: "5:7", parentId: "box:/d", size: 7 });
  });

  it("parses a listing: resolved directory first, folders before files", () => {
    const { dir, files } = parseList("box", "/home/me\nzeta.mdpa\nsub/\nalpha.vtk\n");
    expect(dir).toBe("/home/me");
    expect(files.map((f) => [f.name, f.isFolder, f.id])).toEqual([
      ["sub", true, "box:/home/me/sub"],
      ["alpha.vtk", false, "box:/home/me/alpha.vtk"],
      ["zeta.mdpa", false, "box:/home/me/zeta.mdpa"],
    ]);
  });

  it("rejects a listing that does not start with an absolute directory", () => {
    expect(() => parseList("box", "bash: cd: nope\n")).toThrow();
  });
});

describe("statCommand locale", () => {
  it("forces the C locale so a localised %F still reads as a directory", () => {
    expect(statCommand("/x")).toContain("LC_ALL=C stat -L -c");
  });
});
