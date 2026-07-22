#!/usr/bin/env node
// Print the round-robin reviewer login for a PR number, or nothing if none.
// Usage: node scripts/ci/pick-reviewer.mjs <prNumber> [authorLoginToExclude]
import { readFileSync } from "node:fs";
import { chooseReviewer } from "../lib/governance.mjs";

const prNumber = Number(process.argv[2]);
const excludeLogin = process.argv[3] || undefined;
const { reviewers } = JSON.parse(readFileSync(new URL("../../.github/reviewers.json", import.meta.url), "utf8"));
const reviewer = chooseReviewer(reviewers, prNumber, excludeLogin);
if (reviewer) process.stdout.write(reviewer);
