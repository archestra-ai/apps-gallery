import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  slugify,
  expectedDirName,
  submissionDirsFromPaths,
  isProtectedPath,
  validateSubmission,
  deriveIndexEntry,
} from "./lib/submission.mjs";
import { validateBundle } from "../schema/app-recording-bundle.mjs";
import { chooseReviewer } from "./lib/governance.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_DIR = "piercypixel_example_app";
// A real Archestra bundle kept as a test fixture (apps/ ships empty in this repo,
// so the example lives here rather than as a committed submission).
const EXAMPLE_FIXTURE = join(repoRoot, "scripts", "__fixtures__", "example-recording.json");
const exampleBundle = () => JSON.parse(readFileSync(EXAMPLE_FIXTURE, "utf8"));

test("slugify mirrors the platform (underscores, trimmed)", () => {
  assert.equal(slugify("Archestra Snake 3310"), "archestra_snake_3310");
  assert.equal(slugify("  Hello, World!  "), "hello_world");
  assert.equal(slugify("Example App"), "example_app");
});

test("expectedDirName is <login>_<slug>", () => {
  assert.equal(expectedDirName("octocat", "Example App"), "octocat_example_app");
  assert.equal(expectedDirName("piercypixel", "Archestra Snake 3310"), "piercypixel_archestra_snake_3310");
});

test("submissionDirsFromPaths accepts only the two files under one folder", () => {
  const ok = submissionDirsFromPaths([
    "apps/octocat_example_app/recording.json",
    "apps/octocat_example_app/thumbnail.png",
  ]);
  assert.deepEqual(ok.dirs, ["octocat_example_app"]);
  assert.deepEqual(ok.malformed, []);
  assert.deepEqual(ok.unrelated, []);
});

test("submissionDirsFromPaths accepts a WebP (or jpg) thumbnail, not just PNG", () => {
  const webp = submissionDirsFromPaths([
    "apps/octocat_example_app/recording.json",
    "apps/octocat_example_app/thumbnail.webp",
  ]);
  assert.deepEqual(webp.dirs, ["octocat_example_app"]);
  assert.deepEqual(webp.malformed, []);

  const jpg = submissionDirsFromPaths(["apps/octocat_example_app/thumbnail.jpg"]);
  assert.deepEqual(jpg.dirs, ["octocat_example_app"]);
  assert.deepEqual(jpg.malformed, []);

  // A non-image extension is still smuggled cargo, not a thumbnail.
  const bad = submissionDirsFromPaths(["apps/octocat_example_app/thumbnail.gif"]);
  assert.deepEqual(bad.dirs, []);
  assert.deepEqual(bad.malformed, ["apps/octocat_example_app/thumbnail.gif"]);
});

test("submissionDirsFromPaths separates a smuggled extra file under apps/ from merely unrelated repo files", () => {
  const mixed = submissionDirsFromPaths([
    "apps/octocat_example_app/recording.json",
    "scripts/validate-submission.mjs", // repo maintenance — not apps/-prefixed
    "apps/octocat_example_app/evil.sh", // apps/-prefixed but not an allowed filename
  ]);
  assert.deepEqual(mixed.dirs, ["octocat_example_app"]);
  // A file smuggled into an otherwise-legit submission folder is always
  // suspicious, regardless of what else changed — it must never be
  // downgraded to "just unrelated maintenance."
  assert.deepEqual(mixed.malformed, ["apps/octocat_example_app/evil.sh"]);
  assert.deepEqual(mixed.unrelated, ["scripts/validate-submission.mjs"]);
});

test("isProtectedPath covers the machinery that decides whether a submission is valid", () => {
  for (const p of [
    ".github/workflows/validate.yml",
    "scripts/validate-submission.mjs",
    "scripts/lib/submission.mjs",
    "schema/app-recording-bundle.mjs",
    "package.json",
    "package-lock.json",
  ]) {
    assert.equal(isProtectedPath(p), true, `${p} should be protected`);
  }
  // Docs and content are not machinery — a maintenance PR touching only these
  // must stay mergeable alongside anything else.
  for (const p of ["README.md", "CONTRIBUTING.md", "categories.json", "logo.svg", "apps/octocat_app/recording.json"]) {
    assert.equal(isProtectedPath(p), false, `${p} should not be protected`);
  }
});

test("submissionDirsFromPaths flags machinery changes that ride along with a submission", () => {
  // The shape an automated approver must refuse: routine-looking content plus
  // a quiet edit to the thing that judges it.
  const smuggled = submissionDirsFromPaths([
    "apps/octocat_example_app/recording.json",
    "scripts/validate-submission.mjs",
    ".github/workflows/validate.yml",
    "README.md",
  ]);
  assert.deepEqual(smuggled.dirs, ["octocat_example_app"]);
  assert.deepEqual(smuggled.protectedHits, ["scripts/validate-submission.mjs", ".github/workflows/validate.yml"]);
  // README stays merely "unrelated" — flagged for the log, not for a failure.
  assert.ok(smuggled.unrelated.includes("README.md"));

  // A clean submission trips nothing.
  const clean = submissionDirsFromPaths([
    "apps/octocat_example_app/recording.json",
    "apps/octocat_example_app/thumbnail.png",
  ]);
  assert.deepEqual(clean.protectedHits, []);

  // A pure maintenance PR carries machinery paths and no submission. The
  // validator exits 0 for it (CODEOWNER review governs), so the bucket being
  // populated here must not be read as "fail" on its own.
  const maintenance = submissionDirsFromPaths([".github/workflows/validate.yml", "scripts/build-index.mjs"]);
  assert.deepEqual(maintenance.dirs, []);
  assert.equal(maintenance.protectedHits.length, 2);
});

test("chooseReviewer is deterministic and distributes", () => {
  const owners = ["a", "b", "c"];
  assert.equal(chooseReviewer(owners, 7), "b"); // 7 % 3 = 1
  assert.equal(chooseReviewer(owners, 7), "b"); // stable
  assert.equal(chooseReviewer(owners, 9), "a"); // 9 % 3 = 0
  assert.equal(chooseReviewer([], 3), null);
});

test("chooseReviewer advances past the PR's own author instead of dropping the assignment", () => {
  const owners = ["a", "b", "c"];
  // 9 % 3 = 0 -> "a" is the raw pick; excluding "a" advances to "b".
  assert.equal(chooseReviewer(owners, 9, "a"), "b");
  // A non-matching exclude never changes the pick.
  assert.equal(chooseReviewer(owners, 9, "z"), "a");
  // Every owner excluded (single-maintainer pool submitting their own PR) -> no reviewer.
  assert.equal(chooseReviewer(["a"], 9, "a"), null);
});

test("contract: the committed example bundle validates against the vendored schema", () => {
  const res = validateBundle(exampleBundle());
  assert.equal(res.ok, true, res.ok ? "" : res.error);
});

test("contract: a bundle carrying audio events (current client) validates", () => {
  // The recorder mixes in an opus audio track: one audio-config then a stream
  // of audio-chunks. These arrive interleaved among the video events, so the
  // vendored schema must know both kinds or the whole bundle is rejected.
  const b = exampleBundle();
  b.recording.events.push(
    { kind: "audio-config", t: 10, codec: "opus", sampleRate: 48000, numberOfChannels: 2, description: "T3B1c0hlYWQ=" },
    { kind: "audio-chunk", t: 10, tsUs: 66101243003, data: "AAAA" },
  );
  const res = validateBundle(b);
  assert.equal(res.ok, true, res.ok ? "" : res.error);
});

test("contract: a bundle whose chat edits opt into the enhancement (current client) validates", () => {
  // Toggling "replay the AI-enhanced consolidation" in the player stamps
  // edits.chat.enhancementEnabled. The whole bundle is rejected if the vendored
  // schema doesn't know the key, so a submitter who used that toggle could not
  // submit at all — which is exactly how this drifted out of sync once already.
  const b = exampleBundle();
  b.edits = { cuts: [{ fromMs: 100, toMs: 200 }], chat: { enhancementEnabled: true } };
  const res = validateBundle(b);
  assert.equal(res.ok, true, res.ok ? "" : res.error);
});

test("contract: the deprecated enhancementDisabled flag still validates", () => {
  // Bundles recorded before the default flipped still carry the old key.
  const b = exampleBundle();
  b.edits = { cuts: [], chat: { enhancementDisabled: true } };
  const res = validateBundle(b);
  assert.equal(res.ok, true, res.ok ? "" : res.error);
});

test("schema is strict: an unknown chat-edits key is still rejected", () => {
  // Re-syncing the schema must not turn into loosening it: edits.chat stays
  // closed, so the next drift fails loudly here instead of in a submitter's PR.
  const b = exampleBundle();
  b.edits = { cuts: [], chat: { enhancementEnabled: true, sneaky: "payload" } };
  assert.equal(validateBundle(b).ok, false);
});

test("contract: the example fixture passes full submission validation", () => {
  const dir = writeTemp(exampleBundle(), EXAMPLE_DIR);
  const res = validateSubmission({ appsDir: dir.appsDir, dirName: dir.name });
  assert.equal(res.ok, true, res.errors.join("\n"));
  assert.equal(res.entry.appName, "Example App");
  assert.equal(res.entry.category, "Developer Tools");
  assert.equal(res.entry.author.login, "piercypixel");
  assert.equal(res.entry.durationSeconds, 12);
});

test("deriveIndexEntry: final-cut duration wins; userPromptCount falls back to transcript", () => {
  const b = exampleBundle();
  delete b.meta.userPromptCount; // force the transcript fallback
  b.meta.finalCutDurationMs = 8000;
  b.recording.durationMs = 999999; // raw is ignored when finalCut is present
  const e = deriveIndexEntry({ dirName: EXAMPLE_DIR, bundle: b });
  assert.equal(e.durationSeconds, 8);
  assert.equal(e.userPromptCount, 1); // one role:"user" message
  assert.equal(e.author.name, "Mark Novikov");
});

test("schema is strict: unknown meta keys are rejected", () => {
  const b = exampleBundle();
  b.meta.sneaky = "payload";
  assert.equal(validateBundle(b).ok, false);
});

test("playability: a bundle with no non-empty segment HTML is rejected by submission validation", () => {
  const b = exampleBundle();
  b.recording.segments = [{ version: 1, html: "", atMs: 0 }];
  const dir = writeTemp(b, "octocat_example_app");
  const res = validateSubmission({ appsDir: dir.appsDir, dirName: dir.name });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /non-empty app HTML/.test(e)), res.errors.join("\n"));
});

test("category sanitize: a category with angle brackets is rejected, spaces & ampersands pass", () => {
  const bad = exampleBundle();
  bad.enhancement.category = "<script>";
  const d1 = writeTemp(bad, "octocat_example_app");
  assert.equal(validateSubmission({ appsDir: d1.appsDir, dirName: d1.name }).ok, false);

  const good = exampleBundle();
  good.enhancement.category = "Games & Experiments";
  const d2 = writeTemp(good, "octocat_example_app");
  assert.equal(validateSubmission({ appsDir: d2.appsDir, dirName: d2.name }).ok, true);
});

test("content: folder must match <login>_<slug(appName)>", () => {
  const b = exampleBundle();
  const dir = writeTemp(b, "octocat_wrong_name");
  const res = validateSubmission({ appsDir: dir.appsDir, dirName: dir.name });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /folder name must be/.test(e)));
});

test("thumbnail: a WebP thumbnail (the client's canvas/video format) validates and keeps its .webp path", () => {
  const dir = writeTemp(exampleBundle(), "octocat_example_app");
  writeFileSync(join(dir.appsDir, dir.name, "thumbnail.webp"), webpLossless(320, 400));
  const res = validateSubmission({ appsDir: dir.appsDir, dirName: dir.name });
  assert.equal(res.ok, true, res.errors.join("\n"));
  assert.equal(res.entry.thumbnailPath, `apps/${dir.name}/thumbnail.webp`);
});

test("thumbnail: an undersized image is rejected regardless of format", () => {
  const dir = writeTemp(exampleBundle(), "octocat_example_app");
  writeFileSync(join(dir.appsDir, dir.name, "thumbnail.webp"), webpLossless(64, 64));
  const res = validateSubmission({ appsDir: dir.appsDir, dirName: dir.name });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /thumbnail\.webp is too small/.test(e)), res.errors.join("\n"));
});

// --- helper: write a bundle to a throwaway apps/<dir>/recording.json ---
function writeTemp(bundle, dirName) {
  const root = mkdtempSync(join(tmpdir(), "gallery-test-"));
  const appsDir = join(root, "apps");
  mkdirSync(join(appsDir, dirName), { recursive: true });
  writeFileSync(join(appsDir, dirName, "recording.json"), JSON.stringify(bundle));
  return { appsDir, name: dirName };
}

// A minimal lossless-WebP (VP8L) buffer whose header carries the given size —
// enough for the dimension check, which only reads the RIFF/VP8L header.
function webpLossless(width, height) {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8L", 12, "ascii");
  buf[20] = 0x2f; // VP8L signature byte
  buf.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return buf;
}
