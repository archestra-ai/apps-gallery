#!/usr/bin/env node
// Trigger the org-wide Hackathon agent to run intake for a submission, via its A2A
// endpoint. The agent ingests the card onto the board, mints the replay chat link,
// announces it in the review Slack channel, and assigns a reviewer. Pure data in,
// one A2A message out — reads only the recording.json the workflow downloaded; it
// never runs anything from the PR.
//
// Usage: node scripts/ci/notify-review.mjs <recording.json> [thumbnailUrl]
// Env:
//   PR, BASE_REPO, HEAD_SHA
//   HACKATHON_AGENT_A2A_URL  — the agent's A2A endpoint (…/v2/a2a/<agentId>)
//   HACKATHON_A2A_TOKEN      — Archestra bearer token (archestra_…) for that endpoint
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { deriveIndexEntry } from "../lib/submission.mjs";

const recordingPath = process.argv[2];
const thumbnailUrl = process.argv[3] || "";
if (!recordingPath) {
  console.error("usage: notify-review.mjs <recording.json> [thumbnailUrl]");
  process.exit(1);
}

const a2aUrl = (process.env.HACKATHON_AGENT_A2A_URL || "").trim().replace(/\/+$/, "");
const token = (process.env.HACKATHON_A2A_TOKEN || "").trim();
if (!a2aUrl || !token) {
  console.log("HACKATHON_AGENT_A2A_URL / _TOKEN not set — skipping agent intake.");
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

const text = [
  `A new App Gallery hackathon submission was opened as PR #${pr} in ${baseRepo}.`,
  `Please run intake for it: ingest the submission onto the Hackathon board (card below), mint its replay chat link, announce it in the review Slack channel (with the thumbnail), and assign a reviewer.`,
  "",
  "```json",
  JSON.stringify(card, null, 2),
  "```",
].join("\n");

// Archestra A2A dialect: JSON-RPC "SendMessage", role ROLE_USER, parts [{ text }].
const res = await fetch(a2aUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: pr || 1,
    method: "SendMessage",
    params: { message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }] } },
  }),
});

const out = await res.text();
if (!res.ok) {
  console.error(`A2A SendMessage failed: ${res.status} ${out}`);
  process.exit(1);
}
let parsed;
try { parsed = JSON.parse(out); } catch { parsed = null; }
if (parsed?.error) {
  console.error(`A2A error: ${JSON.stringify(parsed.error)}`);
  process.exit(1);
}
if (/INPUT_REQUIRED/.test(out)) {
  // The agent paused for a tool approval — its intake tools should be set to
  // auto-run so unattended CI intake can complete. Don't fail the PR over it.
  console.warn(`Note: the Hackathon agent paused for a tool approval (set its intake tools to auto-run). PR #${pr}.`);
}
console.log(`sent intake for "${entry.appName}" (PR #${pr}) to the Hackathon agent.`);
