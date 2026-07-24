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
// DEPENDENCY-FREE (node builtins only).
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
//   REVIEWERS_JSON  — JSON array of the PR's requested reviewers [{login,kind,name?}] (users + teams)
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const reconcile = args.includes("--reconcile");

const a2aUrl = (process.env.HACKATHON_AGENT_A2A_URL || "").trim().replace(/\/+$/, "");
const token = (process.env.HACKATHON_A2A_TOKEN || "").trim();
if (!a2aUrl || !token) {
  console.log("HACKATHON_AGENT_A2A_URL / _TOKEN not set — skipping agent call.");
  process.exit(0);
}

const pr = Number(process.env.PR) || 0;
const baseRepo = process.env.BASE_REPO || "";

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
  ].join("\n");
  finalLog = `sent board reconcile request${pr ? ` (PR #${pr})` : ""}.`;
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
  const login = bundle.meta?.github?.login || process.env.AUTHOR_LOGIN || "unknown";

  const enh = bundle.enhancement || {};
  const meta = bundle.meta || {};
  const durationMs = meta.finalCutDurationMs ?? bundle.recording?.durationMs ?? 0;

  // The PR's requested reviewers (users + teams), read by the workflow via `gh pr view`. This is the
  // source of truth for who reviews — the agent must NOT guess. May be empty (reviewers get requested
  // slightly later); a follow-up review_requested event re-runs intake and the card posts then.
  let reviewers = [];
  try { reviewers = JSON.parse(process.env.REVIEWERS_JSON || "[]"); } catch { reviewers = []; }

  const card = {
    pr,
    headRepo: baseRepo,
    headOwner: (process.env.HEAD_REPO || "").split("/")[0] || undefined,
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
    reviewers,
    recordingUrl: process.env.RECORDING_URL || undefined,
    thumbnailUrl: thumbnailUrl || undefined,
    prUrl: `https://github.com/${baseRepo}/pull/${pr}`,
  };

  // Lead with a clean title line so the agent conversation is named usefully, then a short, explicit
  // instruction. Intake is a single deterministic tool call — the card already carries the reviewers,
  // recording URL, and thumbnail; the agent neither guesses reviewers nor calls github_copilot.
  text = [
    `Hackathon intake — ${card.app.name} (PR #${pr})`,
    "",
    `A new App Gallery submission opened as PR #${pr} in ${baseRepo}. Run intake now: call`,
    `hackathon__ingest_submission with the card below verbatim. That single call stores the`,
    `submission, sets its reviewer SET from card.reviewers (do NOT guess or reassign), fetches +`,
    `stores the recording from card.recordingUrl, and posts the Slack review card. Do not call any`,
    `github_copilot tool during intake.`,
    "",
    "```json",
    JSON.stringify(card, null, 2),
    "```",
  ].join("\n");
  finalLog = `sent intake for "${card.app.name}" (PR #${pr}, reviewers: ${reviewers.map((x) => x.login).join(", ") || "none yet"}).`;
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
let parsed;
try { parsed = JSON.parse(out); } catch { parsed = null; }
if (parsed?.error) {
  console.error(`A2A error: ${JSON.stringify(parsed.error)}`);
  process.exit(1);
}
// Concise result summary (state + a short slice of what the agent said) — enough to tell a completed
// run from one that asked/paused, without dumping the whole response.
const r = parsed?.result ?? parsed;
const state = r?.status?.state ?? r?.state ?? r?.kind ?? "(no state field)";
const said = [];
const collect = (m) => { for (const p of (m?.parts ?? [])) if (typeof p?.text === "string") said.push(p.text); };
collect(r?.status?.message); collect(r); (r?.history ?? []).forEach(collect); (r?.artifacts ?? []).forEach(collect);
console.log(`A2A state: ${typeof state === "string" ? state : JSON.stringify(state)}`);
if (said.length) console.log(`agent: ${said.join(" | ").slice(0, 600)}`);
if (/INPUT_REQUIRED/.test(out)) {
  console.warn(`Note: the Hackathon agent paused for a tool approval — set its ${reconcile ? "reconcile" : "intake"} tools to auto-run. PR #${pr}.`);
}
console.log(finalLog);
