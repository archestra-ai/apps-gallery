#!/usr/bin/env node
// Build the submission PR body with the managed preview block merged in, and
// print it to stdout for `gh pr edit --body-file`. Pure data in, text out — it
// only reads a recording.json that the workflow already downloaded; it never
// runs anything from the PR.
//
// Usage: node scripts/ci/pr-preview.mjs <recording.json> <thumbnailUrl>
//   env PR_BODY — the PR's current body (author's text to preserve).
import { readFileSync } from "node:fs";
import { previewFromBundle, buildPreviewBlock, mergePreviewIntoBody } from "../lib/pr-preview.mjs";

const recordingPath = process.argv[2];
const thumbnailUrl = process.argv[3] || "";
if (!recordingPath) {
  console.error("usage: pr-preview.mjs <recording.json> <thumbnailUrl>");
  process.exit(1);
}

const bundle = JSON.parse(readFileSync(recordingPath, "utf8"));
const block = buildPreviewBlock({ ...previewFromBundle(bundle), thumbnailUrl });
process.stdout.write(mergePreviewIntoBody(process.env.PR_BODY ?? "", block));
