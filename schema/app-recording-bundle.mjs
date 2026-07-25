// =============================================================================
// Vendored copy of the Archestra app-session recording bundle contract.
//
// SOURCE OF TRUTH: platform/shared/app-recording.ts in archestra-ai/archestra.
// This is a pinned, hand-synced ESM copy used by the gallery CI to validate
// submissions without depending on the platform monorepo. Keep it in lockstep
// with the source; `scripts/*.test.mjs` includes a contract test that a real
// bundle produced by the current client validates here.
//
// Divergence from the source, intentional and additive (all optional, so older
// bundles keep validating): `meta.github`, `meta.model`, `meta.userPromptCount`
// and `meta.finalCutDurationMs` — the gallery submission facts the platform
// stamps at record/submit time. See the gallery data contract in CONTRIBUTING.md.
// =============================================================================

import { z } from "zod";

const MAX_EVENT_T_MS = 86_400_000;

const EventTimeSchema = z.number().int().min(0).max(MAX_EVENT_T_MS);

const PointerEventSchema = z
  .object({
    kind: z.literal("pointer"),
    t: EventTimeSchema,
    type: z.enum(["move", "down", "up", "click"]),
    x: z.number(),
    y: z.number(),
    button: z.number().int().optional(),
    selector: z.string().max(1_000).optional(),
    ox: z.number().optional(),
    oy: z.number().optional(),
  })
  .strict();

const KeyEventSchema = z
  .object({
    kind: z.literal("key"),
    t: EventTimeSchema,
    type: z.enum(["down", "up"]),
    key: z.string().max(32),
    code: z.string().max(64),
    alt: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    meta: z.boolean().optional(),
    shift: z.boolean().optional(),
  })
  .strict();

const InputEventSchema = z
  .object({
    kind: z.literal("input"),
    t: EventTimeSchema,
    selector: z.string().max(1_000),
    value: z.string().max(20_000).optional(),
    checked: z.boolean().optional(),
  })
  .strict();

const ScrollEventSchema = z
  .object({
    kind: z.literal("scroll"),
    t: EventTimeSchema,
    selector: z.string().max(1_000).nullable(),
    x: z.number(),
    y: z.number(),
  })
  .strict();

const ViewportEventSchema = z
  .object({
    kind: z.literal("viewport"),
    t: EventTimeSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

const McpEventSchema = z
  .object({
    kind: z.literal("mcp"),
    t: EventTimeSchema,
    method: z.string().max(100),
    toolName: z.string().max(300).optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    isError: z.boolean().optional(),
    durationMs: z.number().int().min(0).optional(),
  })
  .strict();

const SegmentMarkerEventSchema = z
  .object({
    kind: z.literal("segment"),
    t: EventTimeSchema,
    version: z.number().int(),
  })
  .strict();

const CanvasFrameEventSchema = z
  .object({
    kind: z.literal("canvas"),
    t: EventTimeSchema,
    sel: z.string().max(1_000),
    data: z.string().max(2_000_000),
  })
  .strict();

const VideoConfigEventSchema = z
  .object({
    kind: z.literal("video-config"),
    t: EventTimeSchema,
    sel: z.string().max(1_000),
    codec: z.string().max(64),
    codedWidth: z.number().int().positive(),
    codedHeight: z.number().int().positive(),
    description: z.string().max(65_536).optional(),
  })
  .strict();

const VideoChunkEventSchema = z
  .object({
    kind: z.literal("video-chunk"),
    t: EventTimeSchema,
    sel: z.string().max(1_000),
    type: z.enum(["key", "delta"]),
    tsUs: z.number().int().min(0),
    data: z.string().max(2_000_000),
  })
  .strict();

const AudioConfigEventSchema = z
  .object({
    kind: z.literal("audio-config"),
    t: EventTimeSchema,
    codec: z.string().max(64),
    sampleRate: z.number().int().positive(),
    numberOfChannels: z.number().int().positive().max(8),
    description: z.string().max(65_536).optional(),
  })
  .strict();

// Opus frames are all independently decodable, so — unlike video — there is no
// key/delta split and no `sel`; `tsUs` is the encoder's microsecond timestamp.
const AudioChunkEventSchema = z
  .object({
    kind: z.literal("audio-chunk"),
    t: EventTimeSchema,
    tsUs: z.number().int().min(0),
    data: z.string().max(2_000_000),
  })
  .strict();

const DomMutationEventSchema = z
  .object({
    kind: z.literal("dom"),
    t: EventTimeSchema,
    op: z.enum(["html", "attr"]),
    sel: z.string().max(1_000),
    html: z.string().max(1_000_000).optional(),
    name: z.string().max(200).nullable().optional(),
    value: z.string().max(100_000).nullable().optional(),
  })
  .strict();

export const AppRecordingEventSchema = z.discriminatedUnion("kind", [
  PointerEventSchema,
  KeyEventSchema,
  InputEventSchema,
  ScrollEventSchema,
  ViewportEventSchema,
  McpEventSchema,
  SegmentMarkerEventSchema,
  CanvasFrameEventSchema,
  VideoConfigEventSchema,
  VideoChunkEventSchema,
  AudioConfigEventSchema,
  AudioChunkEventSchema,
  DomMutationEventSchema,
]);

export const AppRecordingSegmentSchema = z
  .object({
    version: z.number().int(),
    html: z.string().max(5_000_000),
    atMs: EventTimeSchema,
  })
  .strict();

export const AppRecordingTranscriptPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("tool"),
      name: z.string(),
      label: z.string().optional(),
    })
    .strict(),
]);

export const AppRecordingTranscriptMessageSchema = z
  .object({
    id: z.string(),
    role: z.string(),
    atMs: z.number().int(),
    parts: z.array(AppRecordingTranscriptPartSchema),
  })
  .strict();

const AppRecordingCutSchema = z
  .object({
    fromMs: z.number().int(),
    toMs: z.number().int(),
  })
  .strict();

const AppRecordingMessageEditSchema = z
  .object({
    id: z.string(),
    text: z.string().max(20_000),
  })
  .strict();

const AppRecordingChatEditsSchema = z
  .object({
    // Opt in to replaying the AI-enhanced consolidation instead of the captured
    // chat. The enhancement is packed into the bundle for the gallery either
    // way — this flag only governs what the PLAYER replays.
    enhancementEnabled: z.boolean().optional(),
    // @deprecated Superseded by `enhancementEnabled` once the default flipped to
    // the original chat. Kept so bundles recorded with it still validate.
    enhancementDisabled: z.boolean().optional(),
    removedMessageIds: z.array(z.string()).max(500).optional(),
    editedMessages: z.array(AppRecordingMessageEditSchema).max(500).optional(),
  })
  .strict();

const AppRecordingEditsSchema = z
  .object({
    cuts: z.array(AppRecordingCutSchema).max(500),
    chat: AppRecordingChatEditsSchema.optional(),
  })
  .strict();

const AppRecordingEnhancementSchema = z
  .object({
    description: z.string().max(1_000),
    prompt: z.string().max(20_000),
    response: z.string().max(20_000).optional(),
    category: z.string().max(60).optional(),
  })
  .strict();

export const APP_RECORDING_LIMITS = {
  maxEvents: 50_000,
  maxSegments: 25,
  maxTranscriptMessages: 20_000,
  maxTranscriptPartText: 100_000,
};

// Gallery-facing submitter identity, stamped by the platform at submit time.
// Only the public GitHub login and display name — never an email.
const GallerySubmitterSchema = z
  .object({
    login: z.string().max(100),
    name: z.string().max(200).nullable(),
  })
  .strict();

export const AppRecordingBundleSchema = z
  .object({
    formatVersion: z.literal(1),
    app: z
      .object({
        id: z.string().uuid().nullable(),
        name: z.string(),
      })
      .strict(),
    recording: z
      .object({
        title: z.string(),
        startedAt: z.string(),
        durationMs: z.number().int(),
        events: z.array(AppRecordingEventSchema).max(APP_RECORDING_LIMITS.maxEvents),
        segments: z
          .array(AppRecordingSegmentSchema)
          .min(1)
          .max(APP_RECORDING_LIMITS.maxSegments),
        transcript: z
          .array(AppRecordingTranscriptMessageSchema)
          .max(APP_RECORDING_LIMITS.maxTranscriptMessages),
      })
      .strict(),
    edits: AppRecordingEditsSchema.optional(),
    enhancement: AppRecordingEnhancementSchema.optional(),
    meta: z
      .object({
        authorName: z.string().nullable(),
        createdAt: z.string(),
        platform: z.literal("archestra"),
        mcpServers: z.array(z.string()).max(50).optional(),
        appVersionCount: z.number().int().nonnegative().optional(),
        // --- gallery additions (optional, additive) ---
        github: GallerySubmitterSchema.optional(),
        model: z.string().max(200).optional(),
        userPromptCount: z.number().int().nonnegative().optional(),
        finalCutDurationMs: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

/**
 * Validate an already-parsed JSON value as a recording bundle.
 * Returns { ok: true, bundle } or { ok: false, error } — never throws.
 */
export function validateBundle(json) {
  const result = AppRecordingBundleSchema.safeParse(json);
  if (result.success) return { ok: true, bundle: result.data };
  const issues = result.error.issues
    .slice(0, 20)
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  return { ok: false, error: issues };
}
