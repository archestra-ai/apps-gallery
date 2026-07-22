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

// The thumbnail formats the client can emit: a DOM app's PNG/JPEG still, or a
// canvas/video app's WebP frame (canvas.toBlob → image/webp). Kept as one list
// so the allowed-path regex and the on-disk validation agree on the set.
export const THUMBNAIL_EXTS = ["png", "jpg", "jpeg", "webp"];

// A submission PR may only add these two files, and only under apps/<dir>/.
export const ALLOWED_SUBMISSION_PATH = new RegExp(
  `^apps/[^/]+/(recording\\.json|thumbnail\\.(?:${THUMBNAIL_EXTS.join("|")}))$`,
);

/**
 * Split a changed-path list into three buckets:
 * - `dirs` — the submission folder(s) a clean recording.json/thumbnail pair
 *   was found under.
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

// Read a thumbnail's pixel dimensions by sniffing its header — no image library
// needed. Dispatches on the file signature (not the extension, which a hand-made
// PR could misname) and returns null for anything that isn't a PNG/JPEG/WebP.
function readImageSize(bytes) {
  return readPngSize(bytes) ?? readJpegSize(bytes) ?? readWebpSize(bytes);
}

// PNG IHDR parse — signature + width/height.
function readPngSize(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  // IHDR is the first chunk: length(4) + "IHDR"(4) at offset 8, width/height at 16..24.
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return { width, height };
}

// JPEG: walk the marker segments to the Start-Of-Frame, which carries the size.
function readJpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 <= bytes.length) {
    if (bytes[off] !== 0xff) return null;
    const marker = bytes[off + 1];
    // Standalone markers (RSTn, SOI, EOI, TEM) carry no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    // SOF0..SOF15 hold the frame size — except DHT(C4), JPG(C8), DAC(CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = bytes.readUInt16BE(off + 5);
      const width = bytes.readUInt16BE(off + 7);
      return { width, height };
    }
    off += 2 + bytes.readUInt16BE(off + 2); // skip this segment
  }
  return null;
}

// WebP (RIFF container): the canvas encoder emits lossy VP8, but read all three
// chunk types so a hand-made lossless/extended WebP validates too.
function readWebpSize(bytes) {
  if (bytes.length < 30) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    // Lossy keyframe: start code 0x9d 0x01 0x2a, then 14-bit width/height (LE).
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    // Canvas size is stored minus one, as two little-endian 24-bit fields.
    const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
    const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
    return { width, height };
  }
  return null;
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
  const thumbName = THUMBNAIL_EXTS.map((ext) => `thumbnail.${ext}`).find((name) => existsSync(join(dir, name)));
  if (thumbName) {
    const size = readImageSize(readFileSync(join(dir, thumbName)));
    if (!size) {
      errors.push(`${dirName}: ${thumbName} is not a valid image (expected PNG, JPEG, or WebP).`);
    } else if (size.width < MIN_THUMBNAIL_PX || size.height < MIN_THUMBNAIL_PX) {
      errors.push(`${dirName}: ${thumbName} is too small (${size.width}x${size.height}, min ${MIN_THUMBNAIL_PX}px).`);
    } else {
      thumbnailPath = `apps/${dirName}/${thumbName}`;
    }
  } else {
    warnings.push(`${dirName}: no thumbnail — the gallery will render a generated card.`);
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
