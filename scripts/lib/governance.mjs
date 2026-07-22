// Pure governance helpers, unit-tested and called from workflows. No I/O.

/**
 * Deterministic round-robin reviewer pick from the CODEOWNERS list, skipping
 * `excludeLogin` (the PR's own author, so a maintainer's PR doesn't assign
 * itself) by advancing to the next name in rotation rather than dropping the
 * assignment entirely. Same PR number always maps to the same owner.
 * Returns null only when the pool is empty or every entry is the excluded
 * login.
 */
export function chooseReviewer(owners, prNumber, excludeLogin) {
  const list = owners.filter((o) => typeof o === "string" && o.trim().length > 0);
  if (list.length === 0) return null;
  const n = Number(prNumber);
  const start = Number.isFinite(n) ? ((n % list.length) + list.length) % list.length : 0;

  for (let offset = 0; offset < list.length; offset++) {
    const candidate = list[(start + offset) % list.length];
    if (candidate !== excludeLogin) return candidate;
  }
  return null;
}
