/** Region order is shared by the window controller and its tests. */
export function nextRegion<T>(regions: readonly T[], current: T | undefined, backwards: boolean): T | undefined {
  if (!regions.length) return undefined;
  const index = current === undefined ? -1 : regions.indexOf(current);
  if (index < 0) return regions[backwards ? regions.length - 1 : 0];
  return regions[(index + (backwards ? -1 : 1) + regions.length) % regions.length];
}
