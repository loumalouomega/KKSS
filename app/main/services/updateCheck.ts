/** Pure release selection shared by manual and automatic delivery. */
import * as semver from "semver";
export type UpdateChannel = "stable" | "prerelease";
export type UpdateCheckResult =
  | { state: "upToDate" }
  | { state: "available"; latestVersion: string }
  | { state: "invalid" };
export interface Release { tag_name: string; prerelease?: boolean; draft?: boolean }

export function evaluateReleaseTag(tag: string, currentVersion: string): UpdateCheckResult {
  const latest = semver.valid(tag);
  const current = semver.valid(currentVersion);
  if (!latest || !current) return { state: "invalid" };
  return semver.gt(latest, current) ? { state: "available", latestVersion: latest } : { state: "upToDate" };
}

export function selectRelease(releases: Release[], current: string, channel: UpdateChannel): Release | undefined {
  return releases.filter(release => !release.draft && semver.valid(release.tag_name) &&
    (channel === "prerelease" || (!release.prerelease && !semver.prerelease(release.tag_name))) &&
    evaluateReleaseTag(release.tag_name, current).state === "available")
    .sort((a, b) => semver.rcompare(a.tag_name, b.tag_name))[0];
}

export function releaseChannel(tag: string): string {
  return String(semver.prerelease(tag)?.[0] ?? "latest");
}
