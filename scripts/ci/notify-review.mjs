#!/usr/bin/env node
// Push a submission onto the Hackathon review board's ingest webhook. Pure data in,
// one HTTP POST out — it only reads a recording.json the workflow already downloaded;
// it never runs anything from the PR. Same safety posture as scripts/ci/pr-preview.mjs.
//
// Usage: node scripts/ci/notify-review.mjs <recording.json> [thumbnailUrl]
// Env:
//   PR                      — PR number
//   BASE_REPO               — owner/repo the PR targets (the board's key + PR link)
//   HEAD_SHA                — PR head sha (recorded for reference)
//   HACKATHON_INGEST_URL    — board base URL ("/ingest" appended if absent)
//   HACKATHON_INGEST_SECRET — shared secret sent as the X-Ingest-Secret header
import { readFileSync } from "node:fs";
import { deriveIndexEntry } from "../lib/submission.mjs";

const recordingPath = process.argv[2];
const thumbnailUrl = process.argv[3] || "";
if (!recordingPath) {
  console.error("usage: notify-review.mjs <recording.json> [thumbnailUrl]");
  process.exit(1);
}

const base = (process.env.HACKATHON_INGEST_URL || "").trim();
const secret = (process.env.HACKATHON_INGEST_SECRET || "").trim();
if (!base || !secret) {
  console.log("HACKATHON_INGEST_URL / _SECRET not set — skipping board ingest.");
  process.exit(0);
}

// apps/<dir>/recording.json -> <dir>
const dirName = recordingPath.replace(/\/recording\.json$/, "").split("/").pop();
const bundle = JSON.parse(readFileSync(recordingPath, "utf8"));

// Reuse the gallery's own card derivation so the board shows exactly what the
// gallery index will (name/category/description/prompt/duration/author).
const entry = deriveIndexEntry({ dirName, bundle, thumbnailPath: null });

const pr = Number(process.env.PR);
const baseRepo = process.env.BASE_REPO || "";
const card = {
  pr,
  headRepo: baseRepo,
  headSha: process.env.HEAD_SHA || null,
  author: entry.author.login,
  authorName: entry.author.name || entry.author.login,
  authorProfileUrl: `https://github.com/${entry.author.login}`,
  app: {
    name: entry.appName,
    category: entry.category,
    description: entry.description,
    prompt: entry.prompt,
    durationSeconds: entry.durationSeconds,
  },
  thumbnailUrl: thumbnailUrl || undefined,
  prUrl: `https://github.com/${baseRepo}/pull/${pr}`,
};

const endpoint = base.replace(/\/+$/, "").endsWith("/ingest") ? base : `${base.replace(/\/+$/, "")}/ingest`;
const res = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Ingest-Secret": secret },
  body: JSON.stringify(card),
});
const text = await res.text();
if (!res.ok) {
  console.error(`ingest failed: ${res.status} ${text}`);
  process.exit(1);
}
console.log(`ingested "${entry.appName}" (PR #${pr}) -> board: ${text}`);
