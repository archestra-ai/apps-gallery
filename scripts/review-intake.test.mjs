import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessResponse,
  buildCard,
  collectAgentText,
  normalizeReviewers,
} from "./lib/review-intake.mjs";

/** The envelope this backend actually returns — no status, no state, agent text under result.message. */
const envelope = (...texts) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 24,
    result: {
      message: {
        messageId: "a72fff59",
        role: "ROLE_AGENT",
        parts: texts.map((text) => ({ text })),
        contextId: "ff2c4259",
      },
    },
  });

test("normalizeReviewers keeps users and teams, and defaults name to the login", () => {
  const raw = JSON.stringify([
    { login: "archestra-ai/engineering", kind: "team", name: "Engineering" },
    { login: "  joeyorlando  ", kind: "user" },
  ]);
  assert.deepEqual(normalizeReviewers(raw), [
    { login: "archestra-ai/engineering", kind: "team", name: "Engineering" },
    { login: "joeyorlando", kind: "user", name: "joeyorlando" },
  ]);
});

test("normalizeReviewers drops entries with no usable login", () => {
  // `gh pr view --json reviewRequests` yields a null login for a shape the jq filter didn't match.
  const raw = JSON.stringify([{ login: null, kind: "user" }, { kind: "team" }, { login: "iskhakov" }]);
  assert.deepEqual(normalizeReviewers(raw), [{ login: "iskhakov", kind: "user", name: "iskhakov" }]);
});

test("normalizeReviewers is empty for unset, empty, or malformed input", () => {
  for (const raw of [undefined, "", "[]", "not json", '{"login":"x"}']) {
    assert.deepEqual(normalizeReviewers(raw), [], `input: ${raw}`);
  }
});

test("buildCard omits the reviewers key entirely when nobody is assigned", () => {
  const card = buildCard({ pr: 24, baseRepo: "archestra-ai/apps-gallery", reviewers: [] });
  assert.equal("reviewers" in JSON.parse(JSON.stringify(card)), false);
  assert.equal(JSON.stringify(card).includes("reviewers"), false);
});

test("buildCard passes reviewers through when they exist", () => {
  const reviewers = [{ login: "joeyorlando", kind: "user", name: "joeyorlando" }];
  const card = buildCard({ pr: 24, baseRepo: "archestra-ai/apps-gallery", reviewers });
  assert.deepEqual(card.reviewers, reviewers);
});

test("buildCard derives the head owner, author and duration from the bundle", () => {
  const card = buildCard({
    pr: 24,
    baseRepo: "archestra-ai/apps-gallery",
    headRepo: "rupakkumar-76319/apps-gallery",
    headSha: "19b85856",
    authorLogin: "rupakkumar-76319",
    bundle: {
      app: { name: "URL Screenshot Capture" },
      enhancement: { category: "Developer Tools", description: "d", prompt: "p" },
      meta: { finalCutDurationMs: 23743, github: { login: "rupakkumar-76319", name: "Rupak Kumar" } },
    },
    recordingUrl: "https://raw.githubusercontent.com/x/y/z/recording.json",
  });
  assert.equal(card.headRepo, "archestra-ai/apps-gallery"); // where the PR lives
  assert.equal(card.headOwner, "rupakkumar-76319"); // where the branch lives
  assert.equal(card.authorName, "Rupak Kumar");
  assert.equal(card.app.durationSeconds, 24);
  assert.equal(card.prUrl, "https://github.com/archestra-ai/apps-gallery/pull/24");
});

test("buildCard never reports a zero duration", () => {
  const card = buildCard({ pr: 1, baseRepo: "o/r", bundle: { meta: {}, recording: { durationMs: 0 } } });
  assert.equal(card.app.durationSeconds, 1);
});

test("collectAgentText reads result.message.parts — the path this backend actually uses", () => {
  assert.deepEqual(collectAgentText(JSON.parse(envelope("first", "second"))), ["first", "second"]);
});

test("collectAgentText still reads task-style envelopes", () => {
  const task = { result: { status: { message: { parts: [{ text: "from status" }] } } } };
  assert.deepEqual(collectAgentText(task), ["from status"]);
});

test("assessResponse accepts a run the agent confirmed", () => {
  const verdict = assessResponse({ body: envelope("Ingested.", "Done.\nINTAKE_OK 7c420338") });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.said.length, 2);
});

test("assessResponse fails a chatty run that never confirms — the silent-green case", () => {
  // PR #24 shape: HTTP 200, well-formed envelope, agent talked, board stayed empty.
  const verdict = assessResponse({ body: envelope("I'll run intake for this submission.") });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /never confirmed with INTAKE_OK/);
  assert.deepEqual(verdict.said, ["I'll run intake for this submission."]);
});

test("assessResponse fails when the agent reports failure itself", () => {
  const verdict = assessResponse({ body: envelope("INTAKE_FAILED could not fetch the recording") });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /reported failure/);
});

test("assessResponse fails on an empty reply, a non-JSON body, and a JSON-RPC error", () => {
  assert.match(assessResponse({ body: envelope() }).reason, /no message at all/);
  assert.match(assessResponse({ body: "<html>502</html>" }).reason, /not JSON/);
  assert.match(
    assessResponse({ body: JSON.stringify({ jsonrpc: "2.0", error: { code: -32000 } }) }).reason,
    /JSON-RPC error/,
  );
});

test("assessResponse fails when the agent paused for a tool approval", () => {
  const body = JSON.stringify({
    result: { status: { state: "INPUT_REQUIRED", message: { parts: [{ text: "Approve? INTAKE_OK" }] } } },
  });
  const verdict = assessResponse({ body });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /auto-run/);
});

test("assessResponse fails on an explicit non-success task state", () => {
  const body = JSON.stringify({
    result: { status: { state: "TASK_STATE_FAILED" }, message: { parts: [{ text: "INTAKE_OK 1" }] } },
  });
  assert.match(assessResponse({ body }).reason, /ended in state "TASK_STATE_FAILED"/);
});

test("assessResponse uses the reconcile marker in reconcile mode", () => {
  const body = envelope("Board reconciled.\nRECONCILE_OK 3-updated");
  assert.equal(assessResponse({ body, mode: "reconcile" }).ok, true);
  // The intake marker must not satisfy a reconcile run, or a mode mix-up would pass silently.
  assert.equal(assessResponse({ body: envelope("INTAKE_OK 1"), mode: "reconcile" }).ok, false);
});
