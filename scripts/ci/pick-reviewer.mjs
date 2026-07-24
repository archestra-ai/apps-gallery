#!/usr/bin/env node
// Print the round-robin reviewer login for a submission PR, or nothing if none.
// Usage: node scripts/ci/pick-reviewer.mjs <prNumber> [authorLoginToExclude]
//
// Rotates by the PR's ORDINAL among submission PRs (title "App session: …"), NOT prNumber % N —
// so consecutive submissions get consecutive reviewers instead of colliding whenever two PR
// numbers happen to share a residue (the "Ildar twice in a row" bug). Falls back to the PR number
// as the seed if the PR list can't be fetched (offline / no gh), preserving determinism.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chooseReviewer } from "../lib/governance.mjs";

const prNumber = Number(process.argv[2]);
const excludeLogin = process.argv[3] || undefined;
const { reviewers } = JSON.parse(readFileSync(new URL("../../.github/reviewers.json", import.meta.url), "utf8"));

/** Ordinal of this PR among all submission PRs (sorted by number). Submission PRs are titled
 *  "App session: …" by the share flow. Returns prNumber as a fallback seed on any failure. */
function rotationSeed() {
  try {
    const repo = process.env.GITHUB_REPOSITORY || "";
    const args = ["pr", "list", "--state", "all", "--limit", "300", "--json", "number,title"];
    if (repo) args.push("--repo", repo);
    const out = execFileSync("gh", args, { encoding: "utf8" });
    const nums = JSON.parse(out)
      .filter((p) => /^App session:/i.test(p.title || ""))
      .map((p) => p.number);
    if (!nums.includes(prNumber)) nums.push(prNumber); // this PR may not be indexed yet
    nums.sort((a, b) => a - b);
    const ordinal = nums.indexOf(prNumber);
    return ordinal >= 0 ? ordinal : prNumber;
  } catch {
    return prNumber;
  }
}

const reviewer = chooseReviewer(reviewers, rotationSeed(), excludeLogin);
if (reviewer) process.stdout.write(reviewer);
