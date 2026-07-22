// Pure helpers for the submission PR preview. No I/O — given a bundle and a
// thumbnail URL, render a managed markdown block and merge it into a PR body
// idempotently. Called from scripts/ci/pr-preview.mjs (the workflow's I/O side).

// Delimiters for the managed region we own inside the PR body. Everything
// between them (inclusive) is ours to rewrite on each push; anything outside is
// the author's and is left untouched.
export const PREVIEW_START = "<!-- archestra-pr-preview:start -->";
export const PREVIEW_END = "<!-- archestra-pr-preview:end -->";

/** Pick the description + prompt the gallery card is built from, same fields as deriveIndexEntry. */
export function previewFromBundle(bundle) {
  const enh = bundle?.enhancement ?? {};
  return {
    appName: (bundle?.app?.name ?? "").trim(),
    description: (enh.description ?? "").trim(),
    prompt: (enh.prompt ?? "").trim(),
  };
}

// A code fence at least three backticks long, and always longer than the
// longest backtick run inside `text`, so a prompt that itself contains ``` can't
// break out of its fenced block.
function fenceFor(text) {
  let longest = 0;
  for (const run of String(text).matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

// Strip our own markers out of author-supplied text so it can never forge the
// end of the managed region (which would strand trailing content on the next merge).
function stripMarkers(text) {
  return String(text).split(PREVIEW_START).join("").split(PREVIEW_END).join("");
}

/**
 * Render the managed preview block (markers included). `thumbnailUrl` is
 * optional — omit it (null/empty) for a submission with no thumbnail and the
 * image line is dropped, leaving just the description + prompt.
 */
export function buildPreviewBlock({ appName, description, prompt, thumbnailUrl }) {
  const name = stripMarkers(appName || "App");
  const lines = [PREVIEW_START, "", "### App preview", ""];

  if (thumbnailUrl) {
    lines.push(`![${name} thumbnail](${thumbnailUrl})`, "");
  }
  lines.push(`**${name}**`, "");

  if (description) lines.push(stripMarkers(description), "");

  if (prompt) {
    const fence = fenceFor(prompt);
    lines.push("<details>", "<summary>Build prompt</summary>", "", fence, stripMarkers(prompt), fence, "", "</details>", "");
  }

  lines.push(PREVIEW_END);
  return lines.join("\n");
}

/**
 * Replace any existing managed region in `existingBody` with `block`, or append
 * it (separated by a blank line) when none is present. Idempotent: running it on
 * its own output reproduces that output.
 */
export function mergePreviewIntoBody(existingBody, block) {
  const body = existingBody ?? "";
  const start = body.indexOf(PREVIEW_START);
  const end = body.indexOf(PREVIEW_END);

  if (start !== -1 && end !== -1 && end > start) {
    const before = body.slice(0, start);
    const after = body.slice(end + PREVIEW_END.length);
    return `${before.replace(/\s+$/, "")}\n\n${block}\n${after.replace(/^\s+/, "")}`.trim() + "\n";
  }

  const prefix = body.trim();
  return prefix ? `${prefix}\n\n${block}\n` : `${block}\n`;
}
