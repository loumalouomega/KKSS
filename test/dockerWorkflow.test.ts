import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

interface Step {
  name?: string;
  uses?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, unknown>;
}

interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

// js-yaml is already used by tools/check-package-associations.mjs.
const { load } = createRequire(import.meta.url)("js-yaml") as {
  load(source: string): Workflow;
};
const workflow = load(readFileSync(path.resolve(__dirname, "../.github/workflows/docker.yml"), "utf8"));

describe.each(["image", "kratos"])("Docker %s package freshness", (job) => {
  const builds = workflow.jobs[job].steps.filter((step) => step.uses?.startsWith("docker/build-push-action@"));

  it("refreshes runtime packages before verification without discarding app-build caches", () => {
    const checkedBuild = builds.find((step) => step.with?.load === true);
    expect(checkedBuild).toBeDefined();
    expect(checkedBuild!.with?.pull).toBe(true);
    // apt repositories are not part of a RUN's cache key. Only this stage
    // should bypass the cache; rebuilding Electron and the Go binaries is costly.
    expect(checkedBuild!.with?.["no-cache-filters"]).toBe("runtime-base");
    expect(checkedBuild!.with?.["no-cache"]).not.toBe(true);
    expect(checkedBuild!.with?.["cache-from"]).toBeDefined();
    expect(checkedBuild!.with?.["cache-to"]).toBeDefined();
  });

  it("reuses the verified layers when publishing rather than refreshing packages again", () => {
    const publishBuilds = builds.filter((step) => step.with?.load !== true);
    expect(publishBuilds).toHaveLength(1);
    for (const build of publishBuilds) {
      expect(build.with?.pull).not.toBe(true);
      expect(build.with?.["no-cache-filters"]).toBeUndefined();
      expect(build.with?.["no-cache"]).not.toBe(true);
      expect(build.with?.["cache-from"]).toBeDefined();
    }
  });
});

it("keeps fixable HIGH/CRITICAL vulnerabilities release-blocking", () => {
  const scan = workflow.jobs.image.steps.find((step) => step.uses?.startsWith("aquasecurity/trivy-action@"));
  expect(scan).toBeDefined();
  expect(scan!.with?.severity).toBe("HIGH,CRITICAL");
  expect(scan!.with?.["ignore-unfixed"]).toBe(true);
  expect(scan!.with?.["exit-code"]).toBe(1);
  expect(scan!["continue-on-error"]).not.toBe(true);
});
