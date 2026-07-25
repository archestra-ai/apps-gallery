# Repo protection & governance setup (maintainer, one-time)

These settings enforce the governance the CI can't set itself. Apply with a
repo-admin token against `archestra-ai/apps-gallery` (substitute for `OWNER/REPO`
in the command below).

## 1. Let fork-PR checks run without a maintainer click

UI: **Settings → Actions → General → Fork pull request workflows from outside
collaborators →** select **"Do not require approval."**

```bash
gh api -X PUT "repos/OWNER/REPO/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=none
```

Submissions arrive as fork PRs and are reviewed and merged by an agent from chat.
"Require approval for all outside collaborators" made that impossible: both
`pull_request` workflows — the required `validate` check and the org's required
Zizmor scan — parked at `action_required` until a human clicked *Approve and run*
in the GitHub UI, so the required contexts never reported and the merge stayed
blocked no matter what the reviewer did.

What makes this safe to switch off is **not** the click; it is that no job
executes fork content:

- `validate.yml` runs the base commit's validator against the PR's tree as data,
  from two separate checkouts. See the header there — the single-checkout form it
  used to have was running the submitter's own copy of the validator, so the
  required check could be forged by the PR it was judging. That is fixed, and it
  is the reason this policy can be relaxed.
- The `pull_request_target` jobs (governance, pr-preview, hackathon-review) run in
  base context, check out the base ref, and read PR data only via the API.

What the policy does still permit, and what is accepted: a fork PR can add its own
workflow file, which will then run automatically. On a public repo that job gets no
secrets and a read-only `GITHUB_TOKEN`, and every runner here is GitHub-hosted
(`runs-on: ubuntu-latest`, zero self-hosted runners registered), so the blast radius
is ephemeral compute. Before adding a self-hosted runner to this repo — or putting it
in an org runner group visible to it — revisit this setting first.

## 2. Protect `main`

Requires a PR with a code-owner review, the `validate` check green, and blocks
force-push/deletion. `gallery-index` is intentionally left unprotected (the
publish workflow force-pushes the generated `index.json` there).

`strict: false` is deliberate — "require branches to be up to date" would mean every
merge invalidates every other open submission, and each one then needs a branch
update before it can merge. Submissions are independent additive folders
(`apps/<login>_<app>/`), so a stale branch cannot conflict semantically with one
that merged first; `build-index` re-validates every folder on `main` at publish
time regardless. Requiring it bought nothing and cost a round trip per submission —
and on a fork PR without `maintainer_can_modify`, one nobody but the submitter can
make.

`validate` is the ONLY required context, and that is on purpose:

| check | why it is not required |
| --- | --- |
| `Submission governance` | assigns a round-robin reviewer; enforces nothing |
| `PR preview` | writes a cosmetic block into the PR body; `paths: apps/**` means it never reports on non-submission PRs, so requiring it would hang them forever |
| `Hackathon review intake` | outbound notification to the review board |
| `license/cla` | third-party advisory status |
| `Zizmor` | required already, by an **org** ruleset — adding the context here would double-gate it and break on an org-side job rename |

```bash
cat > /tmp/protection.json <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["validate"] },
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
