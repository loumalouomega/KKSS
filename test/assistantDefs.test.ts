import { describe, expect, it } from "vitest";
import {
  MAX_CATALOG_CHARS, MAX_EXPANDED_CHARS, MAX_INSTRUCTIONS_CHARS, cleanText, definitionsSuffix, estimateTokens, expandTemplate,
  matchTemplates, mergeDefinitions, oneLine, parseDefinitions, skillCatalog, splitFrontMatter, type TemplateDef,
} from "../app/main/services/chat/assistantDefs";

const skill = (description = "Check a mesh", name = "checklist") => `---\nname: ${name}\ndescription: ${description}\n---\nStep 1\nStep 2\n`;

describe("front matter", () => {
  it("reads simple key: value lines and returns the body", () => {
    expect(splitFrontMatter("---\nname: a\ndescription: \"quoted: yes\"\n---\nbody\n")).toEqual({ meta: { name: "a", description: "quoted: yes" }, body: "body\n" });
    expect(splitFrontMatter("no front matter")).toEqual({ meta: {}, body: "no front matter" });
  });
  it("is not YAML: tags, anchors and nesting are inert text", () => {
    const { meta } = splitFrontMatter("---\nname: !!js/function x\ndescription: &a b\nnested:\n  key: v\n---\n");
    expect(meta.name).toBe("!!js/function x");
    expect(meta.nested).toBe("");
  });
});

describe("cleaning", () => {
  it("drops control characters, keeps tabs and newlines, normalises line endings", () => {
    expect(cleanText("a\u0000b\tc\r\nd\u001b[31me\r")).toBe("ab\tc\nd[31me\n");
    expect(cleanText("﻿hello")).toBe("hello");
  });
  it("makes a description one capped line", () => {
    expect(oneLine("a\n  b\tc")).toBe("a b c");
    expect(oneLine("x".repeat(300)).length).toBe(200);
  });
});

describe("parsing definitions", () => {
  it("reads instructions, skills and templates", () => {
    const d = parseDefinitions({ "instructions.md": "Use SI units.\n", "skills/checklist/SKILL.md": skill(), "prompts/review.md": "Review $ARGUMENTS" }, "user");
    expect(d.errors).toEqual([]);
    expect(d.instructions).toMatchObject({ source: "user", text: "Use SI units.", chars: 13, truncated: false });
    expect(d.skills).toEqual([{ name: "checklist", source: "user", description: "Check a mesh", body: "Step 1\nStep 2", truncated: false }]);
    expect(d.templates).toEqual([{ name: "review", source: "user", body: "Review $ARGUMENTS", truncated: false }]);
  });
  it("caps instructions and says so", () => {
    const d = parseDefinitions({ "instructions.md": "x".repeat(MAX_INSTRUCTIONS_CHARS + 50) }, "user");
    expect(d.instructions).toMatchObject({ truncated: true, chars: MAX_INSTRUCTIONS_CHARS + 50 });
    expect(d.instructions!.text).toHaveLength(MAX_INSTRUCTIONS_CHARS);
  });
  it("ignores an empty instructions file", () => {
    expect(parseDefinitions({ "instructions.md": "  \n" }, "user").instructions).toBeUndefined();
  });
  it("requires a description, and a name that matches the folder", () => {
    const missing = parseDefinitions({ "skills/a/SKILL.md": "---\nname: a\n---\nbody" }, "user");
    expect(missing.skills).toEqual([]);
    expect(missing.errors[0]).toMatch(/description/);
    const wrong = parseDefinitions({ "skills/a/SKILL.md": "---\nname: b\ndescription: d\n---\nbody" }, "user");
    expect(wrong.skills).toEqual([]);
    expect(wrong.errors[0]).toMatch(/does not match/);
    // The name may be omitted: the folder is the name.
    expect(parseDefinitions({ "skills/a/SKILL.md": "---\ndescription: d\n---\nbody" }, "user").skills[0].name).toBe("a");
  });
  it("skips invalid names and reports an empty template", () => {
    const d = parseDefinitions({ "skills/Bad_Name/SKILL.md": skill(), "prompts/Bad.md": "x", "prompts/empty.md": " \n" }, "user");
    expect(d.skills).toEqual([]);
    expect(d.templates).toEqual([]);
    expect(d.errors).toEqual(["prompts/empty.md: the template is empty"]);
  });
  it("never reads front matter into a template", () => {
    expect(parseDefinitions({ "prompts/a.md": "---\nx: y\n---\ntext" }, "user").templates[0].body).toContain("text");
  });
});

describe("merging", () => {
  const user = parseDefinitions({ "instructions.md": "mine", "skills/a/SKILL.md": skill("mine", "a"), "prompts/p.md": "user p" }, "user");
  const project = parseDefinitions({ "instructions.md": "theirs", "skills/a/SKILL.md": skill("theirs", "a"), "skills/b/SKILL.md": "---\ndescription: b\n---\nx", "prompts/p.md": "project p", "prompts/q.md": "q" }, "project");
  it("your definitions win a name collision; the project adds the rest", () => {
    const m = mergeDefinitions(user, project);
    expect(m.skills.map((s) => [s.name, s.source])).toEqual([["a", "user"], ["b", "project"]]);
    expect(m.templates.map((s) => [s.name, s.source])).toEqual([["p", "user"], ["q", "project"]]);
    expect(m.instructions.map((i) => i.source)).toEqual(["user", "project"]);
  });
  it("labels which side an error came from", () => {
    const bad = parseDefinitions({ "skills/z/SKILL.md": "no description" }, "project");
    expect(mergeDefinitions(user, bad).errors[0]).toMatch(/^project: /);
  });
});

describe("the context block", () => {
  it("is empty with nothing defined", () => {
    expect(definitionsSuffix({ instructions: [], skills: [], templates: [], errors: [] })).toBe("");
  });
  it("carries instructions with the not-an-authority wording, and a skill catalog by name", () => {
    const merged = mergeDefinitions(
      parseDefinitions({ "instructions.md": "Use SI units.", "skills/checklist/SKILL.md": skill() }, "user"),
      parseDefinitions({ "instructions.md": "Lab rule.", "skills/other/SKILL.md": "---\ndescription: o\n---\nx" }, "project")
    );
    const text = definitionsSuffix(merged);
    expect(text.startsWith("\n\n[Standing instructions from the user")).toBe(true);
    expect(text).toContain("Use SI units.");
    expect(text).toContain("trusted project folder");
    expect(text).toContain("do not change what any tool may do or how approvals work");
    expect(text).toContain("checklist — Check a mesh; other — o (project)");
    // A skill's body is never in the suffix: it is fetched on demand.
    expect(text).not.toContain("Step 1");
  });
  it("keeps the catalog inside its budget and counts what it left out", () => {
    const skills = Array.from({ length: 200 }, (_, i) => ({ name: `s${i}`, source: "user" as const, description: "d".repeat(100), body: "", truncated: false }));
    const c = skillCatalog(skills);
    expect(c.lines.join("; ").length).toBeLessThanOrEqual(MAX_CATALOG_CHARS);
    expect(c.lines.length + c.omitted).toBe(200);
    expect(c.omitted).toBeGreaterThan(0);
  });
  it("estimates tokens from characters", () => {
    expect(estimateTokens("x".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("prompt templates", () => {
  const templates: TemplateDef[] = [
    { name: "review", source: "user", body: "Review $ARGUMENTS carefully.", truncated: false },
    { name: "plain", source: "project", body: "Do the plain thing.", truncated: false },
  ];
  it("expands a leading /name and substitutes $ARGUMENTS", () => {
    expect(expandTemplate("/review beam.stl", templates)).toEqual({ kind: "expanded", text: "Review beam.stl carefully.", name: "review", source: "user" });
    expect(expandTemplate("/review", templates)).toMatchObject({ text: "Review  carefully." });
  });
  it("appends arguments when the template has no placeholder", () => {
    expect(expandTemplate("/plain with detail", templates)).toMatchObject({ text: "Do the plain thing.\n\nwith detail" });
    expect(expandTemplate("/plain", templates)).toMatchObject({ text: "Do the plain thing." });
  });
  it("only a defined template expands: paths and unknown names go through as typed", () => {
    for (const text of ["/tmp/model.stl", "/unknown", "/review/extra", "see /review", "/Review x", "hello"]) {
      expect(expandTemplate(text, templates)).toEqual({ kind: "none", text });
    }
  });
  it("a leading // sends a literal slash", () => {
    expect(expandTemplate("//review beam", templates)).toEqual({ kind: "none", text: "/review beam" });
  });
  it("refuses an expansion that would be enormous", () => {
    const big: TemplateDef[] = [{ name: "big", source: "user", body: "x".repeat(8000), truncated: false }];
    expect(expandTemplate(`/big ${"y".repeat(MAX_EXPANDED_CHARS)}`, big)).toEqual({ kind: "tooLong", name: "big" });
  });
  it("does not re-expand a $ARGUMENTS inside the arguments", () => {
    expect(expandTemplate("/review $ARGUMENTS", templates)).toMatchObject({ text: "Review $ARGUMENTS carefully." });
  });
  it("suggests templates for the typed prefix", () => {
    expect(matchTemplates("/", templates)).toEqual(["review", "plain"]);
    expect(matchTemplates("/re", templates)).toEqual(["review"]);
    expect(matchTemplates("/review x", templates)).toEqual([]);
    expect(matchTemplates("hello", templates)).toEqual([]);
  });
});
