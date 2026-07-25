#!/usr/bin/env node
// Trigger the org-wide Hackathon agent over its A2A endpoint. Two modes, ONE A2A message either way:
//
//   intake (default):  the agent makes ONE deterministic hackathon__ingest_submission call with the
//     card below — the board server then stores it, sets the reviewer SET, fetches + stores the
//     recording, and posts the Slack review card. Reads only the recording.json the workflow
//     downloaded; never runs anything from the PR.
//
//   --reconcile:  a PR just closed/merged. Ingest is NOT run (it always (re-)writes the submission
//     as pending and would reset a just-resolved PR). Instead ask the agent to call
//     hackathon__reconcile_board, which syncs the whole board to each PR's real GitHub state
//     (merged → approved, closed-without-merge → declined, still-open → unchanged). Needs no
//     recording — it reads nothing but env.
//
// REVIEWERS ARE OPTIONAL. The set is routinely empty on `opened` (governance assigns the round-robin
// reviewer seconds later, and that assignment is made with GITHUB_TOKEN so it cannot re-trigger this
// workflow). Intake must land the submission either way: when there are no reviewers we omit the
// field entirely rather than sending `[]`, and the board is asked to post the card regardless.
//
// FAILS LOUDLY. The A2A envelope carries no machine-readable outcome — a completed intake is just the
// agent's prose — so HTTP 200 alone is not evidence that anything landed. We require the agent to
// echo an explicit INTAKE_OK / RECONCILE_OK marker and exit non-zero otherwise, printing what the
// agent actually said. See scripts/lib/review-intake.mjs.
//
// DEPENDENCY-FREE (node builtins + this repo's own lib only).
//
// Usage:
//   node scripts/ci/notify-review.mjs <recording.json> [thumbnailUrl]   # intake
//   node scripts/ci/notify-review.mjs --reconcile                       # board reconcile
// Env (both modes):
//   HACKATHON_AGENT_A2A_URL  — the agent's A2A endpoint (…/v2/a2a/<agentId>)
//   HACKATHON_A2A_TOKEN      — Archestra bearer token (archestra_…) for that endpoint
//   PR, BASE_REPO            — used for the message/JSON-RPC id and, in intake, the card
// Env (intake only):
//   HEAD_REPO, HEAD_SHA, AUTHOR_LOGIN
//   RECORDING_URL   — raw.githubusercontent URL of this submission's recording.json (server fetches it)
//   REVIEWERS_JSON  — JSON array of the PR's requested reviewers [{login,kind,name?}]; may be empty
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MARKERS, assessResponse, buildCard, normalizeReviewers } from "../lib/review-intake.mjs";

const args = process.argv.slice(2);
const reconcile = args.includes("--reconcile");
const mode = reconcile ? "reconcile" : "intake";
const marker = MARKERS[mode];

const a2aUrl = (process.env.HACKATHON_AGENT_A2A_URL || "").trim().replace(/\/+$/, "");
const token = (process.env.HACKATHON_A2A_TOKEN || "").trim();
if (!a2aUrl || !token) {
  console.log("HACKATHON_AGENT_A2A_URL / _TOKEN not set — skipping agent call.");
  process.exit(0);
}

const pr = Number(process.env.PR) || 0;
const baseRepo = process.env.BASE_REPO || "";

// How the agent must sign off, in both modes. CI keys the pass/fail on this line, because nothing
// else in the response distinguishes "ran the tool" from "wrote a friendly paragraph".
const signOff = [
  "",
  "Finish your reply with exactly one of these as its own final line:",
  `  ${marker.ok} <id>          — the tool call succeeded`,
  `  ${marker.failed} <reason>  — it did not`,
  `CI fails the run if the ${marker.ok} line is missing, so never omit it.`,
];

// Build the single message text for whichever mode we're in, plus the final one-line success log.
let text;
let finalLog;

if (reconcile) {
  // Lead with a clean title line so the agent conversation is named usefully, then a short, explicit
  // instruction. This is a whole-board sync — the card fields don't apply and we must NOT re-ingest.
  text = [
    `Hackathon board reconcile${pr ? ` (PR #${pr})` : ""}`,
    "",
    `A pull request just closed or merged${baseRepo ? ` in ${baseRepo}` : ""}. Call`,
    `hackathon__reconcile_board now to sync the review board to GitHub's real PR state`,
    `(merged → approved, closed without merge → declined, still open → unchanged), then confirm`,
    `what changed. Do NOT ingest or reset any submission back to pending.`,
    ...signOff,
  ].join("\n");
  finalLog = `board reconcile confirmed${pr ? ` (PR #${pr})` : ""}.`;
} else {
  const recordingPath = args[0];
  const thumbnailUrl = args[1] || "";
  if (!recordingPath) {
    console.error(
      "usage: notify-review.mjs <recording.json> [thumbnailUrl]  |  notify-review.mjs --reconcile",
    );
    process.exit(1);
  }

  const bundle = JSON.parse(readFileSync(recordingPath, "utf8"));

  // The PR's requested reviewers, read by the workflow via `gh pr view`. This is the source of truth
  // for who reviews — the agent must NOT guess — but it is allowed to be empty, and an empty set must
  // not hold the submission back.
  const reviewers = normalizeReviewers(process.env.REVIEWERS_JSON);

  const card = buildCard({
    pr,
    baseRepo,
    headRepo: process.env.HEAD_REPO || "",
    headSha: process.env.HEAD_SHA || "",
    bundle,
    authorLogin: process.env.AUTHOR_LOGIN || "",
    reviewers,
    recordingUrl: process.env.RECORDING_URL || "",
    thumbnailUrl,
  });

  // Reviewer handling is spelled out per case so the agent never invents a reviewer to fill a gap,
  // and never withholds the Slack card because the field is absent.
  const reviewerRule = reviewers.length
    ? [
        "Set the reviewer SET from card.reviewers exactly — do NOT guess, reassign, or add anyone.",
        "If the board cannot resolve a reviewer's login to an Archestra user, keep that reviewer and",
        "show their name/login as plain text on the board and the Slack card.",
      ]
    : [
        "This card carries NO reviewers field: none are assigned yet. Ingest and post the Slack review",
        "card anyway, omitting the reviewers field on the board and on the card. Do NOT guess, invent,",
        "or assign a reviewer — CI re-sends intake with the real set once one is requested.",
      ];

  // Lead with a clean title line so the agent conversation is named usefully, then a short, explicit
  // instruction. Intake is a single deterministic tool call — the card already carries the reviewers,
  // recording URL, and thumbnail; the agent neither guesses reviewers nor calls github_copilot.
  text = [
    `Hackathon intake — ${card.app.name} (PR #${pr})`,
    "",
    `A new App Gallery submission opened as PR #${pr} in ${baseRepo}. Run intake now: call`,
    `hackathon__ingest_submission with the card below verbatim. That single call stores the`,
    `submission, fetches + stores the recording from card.recordingUrl, and posts the Slack review`,
    `card. Do not call any github_copilot tool during intake.`,
    "",
    ...reviewerRule,
    "",
    "```json",
    JSON.stringify(card, null, 2),
    "```",
    ...signOff,
  ].join("\n");
  finalLog = `intake confirmed for "${card.app.name}" (PR #${pr}, reviewers: ${
    reviewers.map((x) => x.login).join(", ") || "none — field omitted"
  }).`;
}

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

const verdict = assessResponse({ body: out, mode });
// The contextId is the agent-side chat this run created — the handle you need to pull the actual
// transcript (and the tool calls it made) out of Archestra when a run goes wrong.
const contextId = out.match(/"contextId"\s*:\s*"([^"]+)"/)?.[1];
if (contextId) console.log(`A2A contextId: ${contextId}`);
if (verdict.state) console.log(`A2A state: ${verdict.state}`);
if (verdict.said.length) console.log(`agent:\n${verdict.said.join("\n---\n")}`);

if (!verdict.ok) {
  console.error(`::error::Hackathon ${mode} did NOT complete for PR #${pr} — ${verdict.reason}.`);
  // The whole response, because a run that fails here is one whose envelope we did not expect.
  if (!verdict.said.length) console.error(`raw response (first 3000): ${out.slice(0, 3000)}`);
  process.exit(1);
}

console.log(finalLog);
