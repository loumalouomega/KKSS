import { describe, expect, it } from "vitest";
import { evaluateReleaseTag } from "../app/main/services/updateCheck";

describe("evaluateReleaseTag", () => {
  it("reports a newer release as available, normalized from the tag", () => {
    expect(evaluateReleaseTag("v0.3.0", "0.2.0")).toEqual({ state: "available", latestVersion: "0.3.0" });
    expect(evaluateReleaseTag("v1.0.0", "0.9.9")).toEqual({ state: "available", latestVersion: "1.0.0" });
  });

  it("reports the same or an older release as up to date", () => {
    expect(evaluateReleaseTag("v0.2.0", "0.2.0")).toEqual({ state: "upToDate" });
    expect(evaluateReleaseTag("v0.1.9", "0.2.0")).toEqual({ state: "upToDate" });
  });

  it("coerces loose tags the way GitHub releases are commonly named", () => {
    expect(evaluateReleaseTag("0.3.0", "0.2.0")).toEqual({ state: "available", latestVersion: "0.3.0" });
    // Prerelease suffixes coerce to their base version.
    expect(evaluateReleaseTag("v0.2.0-rc1", "0.2.0")).toEqual({ state: "upToDate" });
  });

  it("flags unparseable tags instead of guessing", () => {
    expect(evaluateReleaseTag("", "0.2.0")).toEqual({ state: "invalid" });
    expect(evaluateReleaseTag("latest", "0.2.0")).toEqual({ state: "invalid" });
  });
});
