// Pure helpers for the Hackathon A2A intake (scripts/ci/notify-review.mjs), unit-tested. No I/O.

/** A2A task states that are NOT a successful completion, for the days the backend reports one. */
const NON_SUCCESS_STATE = /failed|rejected|cancell?ed|input-required|auth-required|unknown/;

/** Per-mode markers the agent must echo so CI can tell "did the work" from "replied politely". */
export const MARKERS = {
  intake: { ok: "INTAKE_OK", failed: "INTAKE_FAILED" },
  reconcile: { ok: "RECONCILE_OK", failed: "RECONCILE_FAILED" },
};

/**
 * Normalize the PR's requested reviewers (`gh pr view --json reviewRequests`) into the card's shape.
 *
 * Reviewers are OPTIONAL. The set is routinely empty on `opened`, because governance assigns the
 * round-robin reviewer a few seconds later — intake must still land the submission rather than wait
 * for a reviewer that may never arrive in this run. Entries without a usable login are dropped
 * instead of forwarded as half-records the board would have to guess at.
 *
 * `name` is always populated (defaulting to the login) so the board has a human label to render for
 * a reviewer it cannot resolve to an Archestra user, instead of dropping them from the card.
 */
export function normalizeReviewers(raw) {
  let list;
  try {
    list = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((x) => {
    const login = typeof x?.login === "string" ? x.login.trim() : "";
    if (!login) return [];
    const name = typeof x?.name === "string" && x.name.trim() ? x.name.trim() : login;
    return [{ login, kind: x?.kind === "team" ? "team" : "user", name }];
  });
}

/**
 * The intake card the agent passes verbatim to hackathon__ingest_submission.
 *
 * Optional fields are left `undefined` so JSON.stringify drops the key entirely. That matters for
 * `reviewers`: an empty array reads as "the reviewer set is known and it is empty", which is not what
 * an unassigned PR means. Omitting the key tells the board to render the submission with no reviewer
 * line at all — and, crucially, to still post it.
 */
export function buildCard({
  pr,
  baseRepo,
  headRepo = "",
  headSha = "",
  bundle = {},
  authorLogin = "",
  reviewers = [],
  recordingUrl = "",
  thumbnailUrl = "",
}) {
  const enh = bundle.enhancement ?? {};
  const meta = bundle.meta ?? {};
  const durationMs = meta.finalCutDurationMs ?? bundle.recording?.durationMs ?? 0;
  const login = meta.github?.login || authorLogin || "unknown";

  return {
    pr,
    headRepo: baseRepo,
    headOwner: headRepo.split("/")[0] || undefined,
    headSha: headSha || null,
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
    reviewers: reviewers.length ? reviewers : undefined,
    recordingUrl: recordingUrl || undefined,
    thumbnailUrl: thumbnailUrl || undefined,
    prUrl: `https://github.com/${baseRepo}/pull/${pr}`,
  };
}

/**
 * Every text part the agent returned.
 *
 * This backend puts them at `result.message.parts` — a completed intake is literally just the agent's
 * prose, with no `status`/`state` anywhere. The previous collector only looked at
 * `result.status.message` and `result.parts`, so it found nothing on every run, successful or not,
 * and the log line it guarded never printed. Keep the other paths for other/future envelopes.
 */
export function collectAgentText(parsed) {
  const r = parsed?.result ?? parsed;
  const said = [];
  const collect = (m) => {
    for (const p of m?.parts ?? []) if (typeof p?.text === "string" && p.text.trim()) said.push(p.text);
  };
  collect(r?.message);
  collect(r?.status?.message);
  collect(r);
  for (const h of r?.history ?? []) collect(h);
  for (const a of r?.artifacts ?? []) collect(a);
  return said;
}

/**
 * Decide whether an A2A SendMessage actually did the work, so CI can fail loudly instead of going
 * green on a no-op.
 *
 * HTTP 200 proves nothing here: the envelope carries no machine-readable outcome, so a run that
 * ingested nothing is byte-shaped identically to one that worked (this is exactly how PR #24 passed
 * every check while never reaching the board). The only reliable signal is the agent confirming the
 * tool call itself, so we require the OK marker and treat anything else — no reply, an approval
 * pause, a failure marker, a non-success state — as a failed intake.
 *
 * Returns { ok, said, state, reason }; `reason` is null only when ok.
 */
export function assessResponse({ body, mode = "intake" }) {
  const { ok: okMarker, failed: failMarker } = MARKERS[mode] ?? MARKERS.intake;
  const fail = (reason, said = [], state = null) => ({ ok: false, said, state, reason });

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fail("the response was not JSON");
  }
  if (parsed?.error) return fail(`the agent returned a JSON-RPC error: ${JSON.stringify(parsed.error)}`);

  const r = parsed?.result ?? parsed;
  const rawState = r?.status?.state ?? r?.state ?? r?.kind ?? null;
  const state = rawState == null || typeof rawState === "string" ? rawState : JSON.stringify(rawState);
  const said = collectAgentText(parsed);
  const text = said.join("\n");

  // Checked before the generic state test below: an approval pause surfaces AS a non-success state,
  // and "set the tools to auto-run" is the actionable message, not "it ended in state X".
  // Unattended CI can't answer an approval prompt, so a pause means the tool never ran.
  if (/INPUT_REQUIRED/i.test(body))
    return fail(
      "the agent paused for a tool approval and wrote nothing — set its intake tools to auto-run",
      said,
      state,
    );

  if (state && NON_SUCCESS_STATE.test(state.toLowerCase().replace(/_/g, "-")))
    return fail(`the task ended in state "${state}"`, said, state);

  if (said.length === 0) return fail("the agent returned no message at all", said, state);
  if (text.includes(failMarker)) return fail(`the agent reported failure (${failMarker})`, said, state);
  if (!text.includes(okMarker))
    return fail(`the agent never confirmed with ${okMarker}, so nothing can be assumed to have landed`, said, state);

  return { ok: true, said, state, reason: null };
}
