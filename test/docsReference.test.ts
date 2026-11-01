import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { CATEGORIES, buildRegistry } from "../app/main/services/settings/registry";
import { TOOL_ACCESS } from "../app/main/services/chat/toolPolicy";
import { SCOPED_TOOL_PATH_ARGS } from "../app/main/services/chat/toolPaths";
import { replaceIsland, settingsReference, toolReference, REFERENCE_ISLANDS } from "../app/main/services/docsReference";

const page = path.resolve(__dirname, "../doc/guide/configuration.md");
const bodies = {
  "settings-reference": () => settingsReference(buildRegistry("linux"), CATEGORIES),
  "tool-reference": () => toolReference(TOOL_ACCESS, SCOPED_TOOL_PATH_ARGS),
};

describe("generated configuration reference", () => {
  it("matches the registry and policy tables (UPDATE_DOCS_REFERENCE=1 rewrites the page)", () => {
    let text = fs.readFileSync(page, "utf8");
    let fresh = text;
    for (const name of REFERENCE_ISLANDS) fresh = replaceIsland(fresh, name, bodies[name]());
    if (process.env.UPDATE_DOCS_REFERENCE === "1") fs.writeFileSync(page, fresh);
    else expect(text === fresh, "doc/guide/configuration.md reference is stale: run UPDATE_DOCS_REFERENCE=1 npm test -- docsReference").toBe(true);
  });

  it("lists every registry entry and tool", () => {
    expect(settingsReference(buildRegistry("linux"), CATEGORIES)).toContain(buildRegistry("linux")[0].id);
    expect(toolReference({ a__x: "read", a__y: "write" }, { a__y: ["path"] })).toContain("| `a__y` | write | paths: `path` |");
  });
});
