import { describe, expect, it } from "vitest";
import {
  buildServerSpecs,
  extractImages,
  flattenContent,
  KRATOS_MCP_VERSION,
  namespaceTool,
  splitToolName,
} from "../app/main/services/chat/mcpManager";

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

describe("extractImages", () => {
  const png = (data = "aXNv") => ({ type: "image", mimeType: "image/png", data });

  it("keeps the raster formats a data: URL can display", () => {
    const images = extractImages([
      { type: "image", mimeType: "image/png", data: "AA==" },
      { type: "image", mimeType: "image/jpeg", data: "AQ==" },
      { type: "image", mimeType: "image/webp", data: "Ag==" },
      { type: "image", mimeType: "image/gif", data: "Aw==" },
    ]);
    expect(images.map((i) => i.mimeType)).toEqual(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  });

  it("drops SVG and unknown types", () => {
    // SVG is markup, and it would be handed a data: URL in the sidebar.
    expect(extractImages([{ type: "image", mimeType: "image/svg+xml", data: "AA==" }])).toEqual([]);
    expect(extractImages([{ type: "image", mimeType: "application/pdf", data: "AA==" }])).toEqual([]);
  });

  it("drops a payload that is not plain base64", () => {
    expect(extractImages([{ type: "image", mimeType: "image/png", data: "not*base64" }])).toEqual([]);
    expect(extractImages([{ type: "image", mimeType: "image/png", data: "" }])).toEqual([]);
    expect(extractImages([{ type: "image", mimeType: "image/png", data: 42 }])).toEqual([]);
  });

  it("caps the number of images at one comparison's worth", () => {
    expect(extractImages(Array.from({ length: 20 }, () => png()))).toHaveLength(8);
  });

  it("drops an image over the per-image cap but keeps its neighbours", () => {
    const huge = { type: "image", mimeType: "image/png", data: "A".repeat(600 * 1024) };
    const images = extractImages([png("AA=="), huge, png("Ag==")]);
    expect(images.map((i) => i.dataBase64)).toEqual(["AA==", "Ag=="]);
  });

  it("stops at the per-result budget", () => {
    // Five 500 KB images exceed the 2 MB total; only the first four fit.
    const big = () => ({ type: "image", mimeType: "image/png", data: "A".repeat(500 * 1024) });
    expect(extractImages(Array.from({ length: 5 }, big))).toHaveLength(4);
  });

  it("ignores text blocks and tolerates malformed content", () => {
    expect(extractImages([{ type: "text", text: "hi" }, null, "nope", png()])).toHaveLength(1);
    expect(extractImages(undefined)).toEqual([]);
  });

  it("leaves the model's view of the same result unchanged", () => {
    // The two must not drift: the model reads the placeholder, the user sees
    // the picture, and both come from one content array.
    const content = [{ type: "text", text: "line one" }, png(), { type: "text", text: "line two" }];
    expect(flattenContent(content)).toBe("line one\n[image content]\nline two");
    expect(extractImages(content)).toHaveLength(1);
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
    expect(kratos.args).toEqual(["--with", "mcp<2", `kratos-mcp-server@${KRATOS_MCP_VERSION}`]);
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
