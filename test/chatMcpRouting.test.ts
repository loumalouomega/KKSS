import { describe, expect, it } from "vitest";
import { buildServerSpecs, flattenContent, namespaceTool, splitToolName } from "../app/main/services/chat/mcpManager";

const KEYS = ["cad", "mesh", "kratos"];

describe("tool namespacing", () => {
  it("round-trips a namespaced tool name", () => {
    const namespaced = namespaceTool("cad", "load_model");
    expect(namespaced).toBe("cad__load_model");
    expect(splitToolName(namespaced, KEYS)).toEqual({ server: "cad", tool: "load_model" });
  });

  it("keeps double underscores inside the tool name intact", () => {
    expect(splitToolName("mesh__problem__pack", KEYS)).toEqual({ server: "mesh", tool: "problem__pack" });
  });

  it("rejects unknown servers and malformed names", () => {
    expect(splitToolName("gid__load", KEYS)).toBeNull();
    expect(splitToolName("load_model", KEYS)).toBeNull();
    expect(splitToolName("cad__", KEYS)).toBeNull();
  });
});

describe("flattenContent", () => {
  it("joins text blocks and labels non-text blocks", () => {
    const text = flattenContent([
      { type: "text", text: "line one" },
      { type: "image", data: "…" },
      { type: "text", text: "line two" },
    ]);
    expect(text).toBe("line one\n[image content]\nline two");
  });

  it("tolerates non-array content", () => {
    expect(flattenContent(undefined)).toBe("");
  });
});

describe("buildServerSpecs", () => {
  const specs = buildServerSpecs("/app/out");

  it("defines the three servers with the expected commands", () => {
    expect(specs.map((s) => s.key)).toEqual(["cad", "mesh", "kratos"]);
    const [cad, mesh, kratos] = specs;
    expect(cad.command).toBe(process.execPath);
    expect(cad.args[0].replace(/\\/g, "/")).toBe("/app/out/cad-runtime/dist/mcp-server.js");
    expect(mesh.args[0].replace(/\\/g, "/")).toBe("/app/out/mcpServer.js");
    expect(kratos.command).toBe("uvx");
    expect(kratos.args).toEqual(["kratos-mcp-server"]);
  });

  it("runs the node bundles under Electron's own binary and keeps PATH", () => {
    for (const spec of specs.slice(0, 2)) {
      expect(spec.env.ELECTRON_RUN_AS_NODE).toBe("1");
    }
    // StdioClientTransport strips env by default — the specs must carry the
    // full parent environment or uvx (PATH) breaks silently.
    if (process.env.PATH) {
      for (const spec of specs) expect(spec.env.PATH).toBe(process.env.PATH);
    }
    // kratos inherits the parent env untouched (uvx spawns Python, not Node).
    expect(specs[2].env.ELECTRON_RUN_AS_NODE).toBe(process.env.ELECTRON_RUN_AS_NODE);
  });
});
