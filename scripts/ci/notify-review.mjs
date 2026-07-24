#!/usr/bin/env node
// Trigger the org-wide Hackathon agent to run intake for a submission, via its A2A
// endpoint. The agent ingests the card onto the board, mints the replay link, announces
// it in the review Slack channel, and assigns a reviewer. Pure data in, one A2A message
// out — reads only the recording.json the workflow downloaded; never runs anything from
// the PR. DEPENDENCY-FREE (node builtins only) so CI needs no `npm install`.
//
// Usage: node scripts/ci/notify-review.mjs <recording.json> [thumbnailUrl]
// Env:
//   PR, BASE_REPO, HEAD_SHA
//   HACKATHON_AGENT_A2A_URL  — the agent's A2A endpoint (…/v2/a2a/<agentId>)
//   HACKATHON_A2A_TOKEN      — Archestra bearer token (archestra_…) for that endpoint
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

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

// The workflow downloads the bundle to a bare `recording.json`, so take the author from the
// bundle itself (meta.github.login), falling back to the PR author the workflow passes.
const bundle = JSON.parse(readFileSync(recordingPath, "utf8"));
const login = bundle.meta?.github?.login || process.env.AUTHOR_LOGIN || "unknown";

// Same card fields the gallery index uses (mirrors scripts/lib/submission.mjs deriveIndexEntry),
// extracted inline so this script pulls in no zod-backed schema module (CI runs it without deps).
const enh = bundle.enhancement || {};
const meta = bundle.meta || {};
const durationMs = meta.finalCutDurationMs ?? bundle.recording?.durationMs ?? 0;

const pr = Number(process.env.PR);
const baseRepo = process.env.BASE_REPO || "";
const card = {
  pr,
  headRepo: baseRepo,
  headSha: process.env.HEAD_SHA || null,
  author: login,
  authorName: meta.github?.name || login,
  authorProfileUrl: `https://github.com/${login}`,
  app: {
    name: bundle.app?.name || "Untitled app",
    category: enh.category || "Other",
    description: enh.description || "",
    prompt: enh.prompt || "",
    durationSeconds: Math.max(1, Math.round(durationMs / 1000)),
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
  // The agent paused for a tool approval — its intake tools should be set to auto-run
  // so unattended CI intake can complete. Don't fail the PR over it.
  console.warn(`Note: the Hackathon agent paused for a tool approval (set its intake tools to auto-run). PR #${pr}.`);
}
console.log(`sent intake for "${card.app.name}" (PR #${pr}) to the Hackathon agent.`);
