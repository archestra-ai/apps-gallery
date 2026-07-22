import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PREVIEW_START,
  PREVIEW_END,
  previewFromBundle,
  buildPreviewBlock,
  mergePreviewIntoBody,
} from "./lib/pr-preview.mjs";

test("previewFromBundle pulls the same fields the gallery card uses", () => {
  const bundle = {
    app: { name: "  Snake 3310  " },
    enhancement: { description: "  A retro snake.  ", prompt: " build snake ", category: "Games" },
  };
  assert.deepEqual(previewFromBundle(bundle), {
    appName: "Snake 3310",
    description: "A retro snake.",
    prompt: "build snake",
  });
});

test("previewFromBundle tolerates a missing enhancement/app", () => {
  assert.deepEqual(previewFromBundle({}), { appName: "", description: "", prompt: "" });
});

test("buildPreviewBlock includes the thumbnail, description, and prompt", () => {
  const block = buildPreviewBlock({
    appName: "Snake 3310",
    description: "A retro snake.",
    prompt: "build snake",
    thumbnailUrl: "https://github.com/octocat/fork/raw/abc/apps/octocat_snake/thumbnail.png",
  });
  assert.ok(block.startsWith(PREVIEW_START));
  assert.ok(block.trimEnd().endsWith(PREVIEW_END));
  assert.match(block, /!\[Snake 3310 thumbnail\]\(https:\/\/github\.com\/octocat\/fork\/raw\/abc\/apps\/octocat_snake\/thumbnail\.png\)/);
  assert.match(block, /\*\*Snake 3310\*\*/);
  assert.match(block, /A retro snake\./);
  assert.match(block, /build snake/);
});

test("buildPreviewBlock drops the image line when there is no thumbnail", () => {
  const block = buildPreviewBlock({ appName: "X", description: "d", prompt: "p", thumbnailUrl: "" });
  assert.doesNotMatch(block, /!\[/);
  assert.match(block, /\*\*X\*\*/);
});

test("buildPreviewBlock fences a prompt that itself contains backtick fences", () => {
  const prompt = "before\n```js\ncode\n```\nafter";
  const block = buildPreviewBlock({ appName: "X", description: "", prompt, thumbnailUrl: "" });
  // The outer fence must be longer than any backtick run in the prompt (4+ here).
  assert.match(block, /\n````+\nbefore/);
  assert.ok(block.includes(prompt));
});

test("buildPreviewBlock strips markers from author text so the region can't be forged", () => {
  const block = buildPreviewBlock({
    appName: `Evil ${PREVIEW_END}`,
    description: `desc ${PREVIEW_END} tail`,
    prompt: "",
    thumbnailUrl: "",
  });
  // Only the single real closing marker remains (the one we appended).
  assert.equal(block.split(PREVIEW_END).length - 1, 1);
});

test("mergePreviewIntoBody appends when no block exists, preserving the author body", () => {
  const merged = mergePreviewIntoBody("Author submission text.", buildPreviewBlock({ appName: "X", thumbnailUrl: "u" }));
  assert.ok(merged.startsWith("Author submission text."));
  assert.ok(merged.includes(PREVIEW_START));
});

test("mergePreviewIntoBody is idempotent — re-running replaces, not duplicates", () => {
  const first = mergePreviewIntoBody("Body.", buildPreviewBlock({ appName: "One", thumbnailUrl: "u1" }));
  const second = mergePreviewIntoBody(first, buildPreviewBlock({ appName: "Two", thumbnailUrl: "u2" }));
  assert.equal(second.split(PREVIEW_START).length - 1, 1);
  assert.equal(second.split(PREVIEW_END).length - 1, 1);
  assert.ok(second.includes("**Two**"));
  assert.ok(!second.includes("**One**"));
  assert.ok(second.startsWith("Body."));
  // A third run over the second output is a no-op.
  assert.equal(mergePreviewIntoBody(second, buildPreviewBlock({ appName: "Two", thumbnailUrl: "u2" })), second);
});

test("mergePreviewIntoBody handles a null/empty existing body", () => {
  const block = buildPreviewBlock({ appName: "X", thumbnailUrl: "u" });
  assert.equal(mergePreviewIntoBody(null, block), `${block}\n`);
});
