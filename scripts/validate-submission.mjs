#!/usr/bin/env node
// Validate app-gallery submissions as DATA. Never imports or runs submission
// code. Intended to run from the trusted base ref on a read-only `pull_request`.
//
// Usage:
//   node scripts/validate-submission.mjs --changed <file> [--author <login>]
//   node scripts/validate-submission.mjs --all
//   node scripts/validate-submission.mjs <dirName> [<dirName> ...]
//
// --apps-dir <dir>: where to READ submission folders from, default `apps`.
//   Exists so CI can run this script from the trusted base checkout while
//   pointing it at the pull request's tree — the code that runs and the data it
//   reads then come from different places, and a PR cannot supply the validator
//   that judges it. Data only: nothing under this directory is ever imported or
//   executed, it is read as bytes and parsed as JSON.
//
// --changed <file>: a file of newline-separated changed paths (from `git diff
//   --name-only base...head`). A genuine submission PR (the automated
//   share-to-gallery flow, or a hand-made one following the same rule) never
//   touches anything but its own apps/<dir>/recording.json and, optionally, a
//   thumbnail image — so that's the shape this validator enforces. A PR that
//   touches anything else (repo maintenance, workflow/docs changes, the
//   initial template setup) isn't submission-shaped; this script has nothing
//   to check for it and exits 0, deferring to the repo's normal required
//   CODEOWNER review instead of misapplying a rule that assumes a pure
//   submission.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { validateSubmission, submissionDirsFromPaths } from "./lib/submission.mjs";

const DEFAULT_APPS_DIR = "apps";

function parseArgs(argv) {
  const opts = { dirs: [], changedFile: null, author: null, all: false, appsDir: DEFAULT_APPS_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--changed") opts.changedFile = argv[++i];
    else if (a === "--author") opts.author = argv[++i];
    else if (a === "--apps-dir") opts.appsDir = argv[++i];
    else if (a === "--all") opts.all = true;
    else opts.dirs.push(a);
  }
  return opts;
}

function fail(lines) {
  for (const l of lines) console.error(l);
  console.error("\n❌ Submission validation failed.");
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
const APPS_DIR = opts.appsDir;
let dirs = [];

if (opts.changedFile) {
  const paths = readFileSync(opts.changedFile, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const { dirs: touched, malformed, unrelated, protectedHits } = submissionDirsFromPaths(paths);
  if (malformed.length > 0) {
    fail([
      "A submission PR may only add files under apps/<login>_<app>/ (recording.json and optionally a thumbnail image — png, jpg, or webp).",
      "Disallowed paths under apps/:",
      ...malformed.map((p) => `  - ${p}`),
    ]);
  }
  if (touched.length === 0 && unrelated.length > 0) {
    console.log(
      "This PR isn't shaped like a submission (nothing under apps/ was touched) " +
        "— nothing for this check to validate; relying on required CODEOWNER " +
        "review instead.",
    );
    process.exit(0);
  }
  if (touched.length === 0) {
    console.log("No submission files changed — nothing to validate.");
    process.exit(0);
  }
  // A submission PR that also rewrites the gallery's own machinery. Refused
  // outright: the whole point of this check is to be a signal an automated
  // approver can trust, and it cannot vouch for a bundle while the same PR is
  // editing the validator, the schema, the workflow or the lockfile around it.
  if (protectedHits.length > 0) {
    fail([
      "A submission PR may not change the gallery's own machinery. Move these to a separate PR:",
      ...protectedHits.map((p) => `  - ${p}`),
      "",
      "(A submission adds only apps/<login>_<app>/recording.json and an optional thumbnail.)",
    ]);
  }
  if (unrelated.length > 0) {
    console.log(
      "Note: this PR also touches files unrelated to the submission — only " +
        `the apps/${touched[0]}/ contents are validated here:`,
    );
    for (const p of unrelated) console.log(`  - ${p}`);
  }
  if (touched.length > 1) {
    fail([`A PR must touch exactly one submission folder; found ${touched.length}: ${touched.join(", ")}.`]);
  }
  dirs = touched;
} else if (opts.all) {
  if (!existsSync(APPS_DIR)) fail([`No ${APPS_DIR}/ directory.`]);
  dirs = readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
} else {
  dirs = opts.dirs;
}

if (dirs.length === 0) fail(["Nothing to validate (pass --changed, --all, or dir names)."]);

let anyError = false;
for (const dirName of dirs) {
  const res = validateSubmission({ appsDir: APPS_DIR, dirName, expectedLogin: opts.author });
  for (const w of res.warnings) console.warn(`⚠️  ${w}`);
  if (res.ok) {
    console.log(`✅ ${dirName}: valid — "${res.entry.appName}" (${res.entry.category}), ${res.entry.durationSeconds}s`);
  } else {
    anyError = true;
    for (const e of res.errors) console.error(`❌ ${e}`);
  }
}

if (anyError) fail([]);
console.log("\n✅ All submissions valid.");
