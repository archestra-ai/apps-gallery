# Repo protection & governance setup (maintainer, one-time)

These settings enforce the governance the CI can't set itself. Apply with a
repo-admin token against `archestra-ai/apps-gallery` (substitute for `OWNER/REPO`
in the command below).

## 1. Require maintainer approval before fork-PR checks run

UI: **Settings → Actions → General → Fork pull request workflows from outside
collaborators →** select **"Require approval for all outside collaborators."**

This holds the `pull_request`-triggered `validate` run (the only job that touches
fork content) until a maintainer approves it, satisfying "owner approval before PR
checks run." The `pull_request_target` jobs (governance, claude-review) run in base
context, execute no fork code, and are safe to run immediately.

## 2. Protect `main`

Requires a PR with a code-owner review, the `validate` check green, and blocks
force-push/deletion. `gallery-index` is intentionally left unprotected (the
publish workflow force-pushes the generated `index.json` there).

```bash
cat > /tmp/protection.json <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["validate"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
JSON

gh api -X PUT "repos/OWNER/REPO/branches/main/protection" \
  -H "Accept: application/vnd.github+json" --input /tmp/protection.json
```

`require_code_owner_reviews: true` + the root `CODEOWNERS` (`* @archestra-ai/engineering`)
means every PR — including every submission under `apps/` — needs a review from the
engineering team to merge, so no one outside the team can merge.

## 3. Reviewer pool

`.github/reviewers.json` is the round-robin pool for auto-assignment. Keep it in
step with `CODEOWNERS`.
