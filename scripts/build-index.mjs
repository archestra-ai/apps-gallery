#!/usr/bin/env node
// Build index.json — the lightweight, website-facing manifest of every valid
// submission under apps/. Heavy replay data stays in each recording.json; the
// website fetches this one small file (runtime ISR) and lazy-loads recordings.
//
// Runs on push to main; the result is published to the `gallery-index` branch
// (not protected main). Invalid folders are skipped with a warning so one bad
// merge never breaks the whole manifest.
//
// Usage: node scripts/build-index.mjs [--out index.json]

import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { validateSubmission } from "./lib/submission.mjs";

const APPS_DIR = "apps";
let out = "index.json";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i];
}

if (!existsSync(APPS_DIR)) {
  console.error(`No ${APPS_DIR}/ directory; writing empty index.`);
  writeFileSync(out, JSON.stringify({ formatVersion: 1, apps: [] }, null, 2) + "\n");
  process.exit(0);
}

const dirs = readdirSync(APPS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const apps = [];
for (const dirName of dirs) {
  const res = validateSubmission({ appsDir: APPS_DIR, dirName });
  if (res.ok) {
    apps.push(res.entry);
  } else {
    console.warn(`⚠️  Skipping invalid submission ${dirName}:`);
    for (const e of res.errors) console.warn(`    ${e}`);
  }
}

// Newest first (by build date), then stable by slug. No Date.now() — fully
// deterministic so re-running never produces a spurious diff.
apps.sort((a, b) => (a.buildDate < b.buildDate ? 1 : a.buildDate > b.buildDate ? -1 : a.slug < b.slug ? -1 : 1));

writeFileSync(out, JSON.stringify({ formatVersion: 1, apps }, null, 2) + "\n");
console.log(`Wrote ${out} with ${apps.length} app(s).`);
