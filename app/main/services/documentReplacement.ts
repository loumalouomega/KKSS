/** Serialize replacement decisions. A queued request never inherits a changed target. */
export function documentReplacementQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return (isCurrent: () => boolean, confirm: () => Promise<boolean>, commit: () => void): Promise<boolean> => {
    const next = tail.then(async () => {
      if (!isCurrent() || !await confirm() || !isCurrent()) return false;
      commit();
      return true;
    });
    tail = next.catch(() => {});
    return next;
  };
}
