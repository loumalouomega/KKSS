/**
 * Pure release-tag evaluation for the update check — kept free of electron
 * imports so test/updateCheck.test.ts can exercise it directly.
 */
import * as semver from "semver";

export type UpdateCheckResult =
  | { state: "upToDate" }
  | { state: "available"; latestVersion: string }
  | { state: "invalid" };

export function evaluateReleaseTag(tag: string, currentVersion: string): UpdateCheckResult {
  const latest = semver.coerce(tag);
  const current = semver.coerce(currentVersion);
  if (!latest || !current) return { state: "invalid" };
  if (semver.lte(latest.version, current.version)) return { state: "upToDate" };
  return { state: "available", latestVersion: latest.version };
}
