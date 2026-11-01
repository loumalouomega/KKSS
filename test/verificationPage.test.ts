import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadReports, renderPage, renderTable } from "../tools/tutorials/verificationPage.mjs";

const root = path.resolve(__dirname, "..");
const page = path.join(root, "doc/guide/verification.md");
const reports = loadReports(path.join(root, "doc/public/examples/tutorials"));

describe("verification page", () => {
  it("matches the published records (UPDATE_VERIFICATION_PAGE=1 rewrites it)", () => {
    const text = fs.readFileSync(page, "utf8");
    const fresh = renderPage(text, reports);
    if (process.env.UPDATE_VERIFICATION_PAGE === "1") fs.writeFileSync(page, fresh);
    else expect(text === fresh, "doc/guide/verification.md is stale").toBe(true);
  });
  it("lists every case that asserts a limit", () => {
    const table = renderTable(reports);
    expect(reports.length).toBeGreaterThan(5);
    expect(table).toContain("structural");
    expect(table).toContain("≤ 0.25");
  });
});
