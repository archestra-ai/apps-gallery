// Shared helpers for validating a submission folder and deriving its gallery
// index entry. Pure data handling — never imports or executes submission code.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateBundle, APP_RECORDING_LIMITS } from "../../schema/app-recording-bundle.mjs";

// Mirror of platform `slugify` (shared/utils.ts) — MUST match the client so the
// folder name a submission arrives under is reproducible from the app name.
export function slugify(name) {
  const slugified = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  let start = 0;
  let end = slugified.length;
  while (start < end && slugified[start] === "_") start++;
  while (end > start && slugified[end - 1] === "_") end--;
  return slugified.slice(start, end);
}

/** `apps/<login>_<slug>` — GitHub logins have no underscores, so the first `_` splits them. */
export function expectedDirName(login, appName) {
  return `${login}_${slugify(appName) || "app-session"}`;
}

// A submission PR may only add these two files, and only under apps/<dir>/.
export const ALLOWED_SUBMISSION_PATH = /^apps\/[^/]+\/(recording\.json|thumbnail\.png)$/;

/**
 * Split a changed-path list into three buckets:
 * - `dirs` — the submission folder(s) a clean recording.json/thumbnail.png
 *   pair was found under.
 * - `malformed` — paths under `apps/` that don't match the exact 2-file
 *   pattern (an extra file smuggled into an otherwise submission-shaped
 *   folder, a nested path, a stray root-level file). Always suspicious,
 *   regardless of what else the PR touches — a genuine submission (automated
 *   or careful hand-made) never produces one.
 * - `unrelated` — paths that aren't under `apps/` at all. On their own these
 *   just mean "not a submission PR" (repo maintenance, docs, workflows);
 *   only `malformed` paths should ever hard-fail the shape check.
 */
export function submissionDirsFromPaths(paths) {
  const allowed = paths.filter((p) => ALLOWED_SUBMISSION_PATH.test(p));
  const rest = paths.filter((p) => !ALLOWED_SUBMISSION_PATH.test(p));
  const malformed = rest.filter((p) => p.startsWith("apps/"));
  const unrelated = rest.filter((p) => !p.startsWith("apps/"));
  const dirs = [...new Set(allowed.map((p) => p.split("/")[1]))];
  return { dirs, malformed, unrelated };
}

const MAX_BUNDLE_BYTES = 100 * 1024 * 1024; // GitHub contents-API single-file ceiling
const MAX_CATEGORY_CHARS = 60;
const MIN_THUMBNAIL_PX = 100;
// Reject ASCII control characters and angle brackets in the free-text category.
const UNSAFE_CATEGORY = /[\x00-\x1f<>]/;

// PNG IHDR parse — signature + width/height, no image library needed.
function readPngSize(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  // IHDR is the first chunk: length(4) + "IHDR"(4) at offset 8, width/height at 16..24.
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return { width, height };
}

/**
 * Validate one submission folder as data.
 * @returns { ok, errors: string[], warnings: string[], entry?, bundle? }
 */
export function validateSubmission({ appsDir, dirName, expectedLogin }) {
  const errors = [];
  const warnings = [];
  const dir = join(appsDir, dirName);
  const recordingPath = join(dir, "recording.json");

  if (!existsSync(recordingPath)) {
    errors.push(`${dirName}: missing recording.json`);
    return { ok: false, errors, warnings };
  }

  const bytes = statSync(recordingPath).size;
  if (bytes > MAX_BUNDLE_BYTES) {
    errors.push(`${dirName}: recording.json is ${(bytes / 1e6).toFixed(1)}MB, over the ${MAX_BUNDLE_BYTES / 1e6}MB limit`);
  }

  let json;
  try {
    json = JSON.parse(readFileSync(recordingPath, "utf8"));
  } catch (e) {
    errors.push(`${dirName}: recording.json is not valid JSON — ${e.message}`);
    return { ok: false, errors, warnings };
  }

  const parsed = validateBundle(json);
  if (!parsed.ok) {
    errors.push(`${dirName}: recording.json fails the bundle schema:\n${parsed.error}`);
    return { ok: false, errors, warnings };
  }
  const bundle = parsed.bundle;

  // --- content validity ---
  const login = dirName.split("_")[0];
  if (expectedLogin && login !== expectedLogin) {
    errors.push(`${dirName}: folder login "${login}" does not match the PR author "${expectedLogin}". Submit your own app under apps/${expectedLogin}_<app>/.`);
  }
  const wantDir = expectedDirName(login, bundle.app.name);
  if (dirName !== wantDir) {
    errors.push(`${dirName}: folder name must be "${wantDir}" for app "${bundle.app.name}" (apps/<login>_<slugified-app-name>/).`);
  }
  if (!bundle.app.name.trim()) errors.push(`${dirName}: app.name is empty.`);

  // --- completeness (gallery needs these to render a useful card) ---
  const enh = bundle.enhancement;
  if (!enh || !enh.description?.trim()) errors.push(`${dirName}: missing enhancement.description (one-sentence app description).`);
  if (!enh || !enh.prompt?.trim()) errors.push(`${dirName}: missing enhancement.prompt (the one-shot build prompt).`);

  const category = enh?.category?.trim() ?? "";
  if (!category) {
    errors.push(`${dirName}: missing category — pick one of the gallery categories or "Other" at submit time.`);
  } else if (category.length > MAX_CATEGORY_CHARS) {
    errors.push(`${dirName}: category exceeds ${MAX_CATEGORY_CHARS} chars.`);
  } else if (UNSAFE_CATEGORY.test(category)) {
    errors.push(`${dirName}: category contains control characters or angle brackets.`);
  }

  // --- playability ---
  const hasHtml = bundle.recording.segments.some((s) => s.html && s.html.trim().length > 0);
  if (!hasHtml) errors.push(`${dirName}: no segment carries non-empty app HTML — nothing to replay.`);
  const durationMs = bundle.meta.finalCutDurationMs ?? bundle.recording.durationMs;
  if (!(durationMs > 0)) errors.push(`${dirName}: final-cut duration is not positive.`);

  // --- thumbnail (optional) ---
  let thumbnailPath;
  const thumbAbs = join(dir, "thumbnail.png");
  if (existsSync(thumbAbs)) {
    const size = readPngSize(readFileSync(thumbAbs));
    if (!size) {
      errors.push(`${dirName}: thumbnail.png is not a valid PNG.`);
    } else if (size.width < MIN_THUMBNAIL_PX || size.height < MIN_THUMBNAIL_PX) {
      errors.push(`${dirName}: thumbnail.png is too small (${size.width}x${size.height}, min ${MIN_THUMBNAIL_PX}px).`);
    } else {
      thumbnailPath = `apps/${dirName}/thumbnail.png`;
    }
  } else {
    warnings.push(`${dirName}: no thumbnail.png — the gallery will render a generated card.`);
  }

  if (errors.length > 0) return { ok: false, errors, warnings, bundle };

  return { ok: true, errors, warnings, bundle, entry: deriveIndexEntry({ dirName, bundle, thumbnailPath }) };
}

/** Lightweight, website-facing entry. Heavy replay data stays in recording.json. */
export function deriveIndexEntry({ dirName, bundle, thumbnailPath }) {
  const login = dirName.split("_")[0];
  const enh = bundle.enhancement ?? {};
  const userPromptCount =
    bundle.meta.userPromptCount ??
    bundle.recording.transcript.filter((m) => m.role === "user").length;
  const durationMs = bundle.meta.finalCutDurationMs ?? bundle.recording.durationMs;
  return {
    slug: dirName,
    appName: bundle.app.name,
    description: enh.description ?? "",
    category: enh.category ?? "Other",
    prompt: enh.prompt ?? "",
    author: {
      login,
      // GitHub profile display name only (never the Archestra display name / email).
      name: bundle.meta.github?.name ?? null,
    },
    avatarUrl: `https://github.com/${login}.png`,
    model: bundle.meta.model ?? null,
    userPromptCount,
    mcpServers: bundle.meta.mcpServers ?? [],
    buildDate: (bundle.meta.createdAt ?? "").slice(0, 10),
    durationSeconds: Math.max(1, Math.round(durationMs / 1000)),
    recordingPath: `apps/${dirName}/recording.json`,
    thumbnailPath: thumbnailPath ?? null,
    formatVersion: bundle.formatVersion,
  };
}
