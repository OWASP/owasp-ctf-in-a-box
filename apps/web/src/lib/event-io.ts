// Pure bundle parser, validator and serializer for a whole-EVENT archive:
// event metadata + policy settings + the classic, quiz and/or ai content
// bundles, composed into one importable/exportable file. This file is
// CLIENT-SAFE ON PURPOSE, mirroring classic-io.ts, quiz-io.ts and ai-io.ts:
// the admin panel's archive import/export UI is a Client Component that needs
// to validate a pasted/uploaded archive in the browser before it ever reaches
// the server, so this file must NEVER import a `server-only` module (e.g.
// admin-store.ts, classic-store.ts, quiz-store.ts, ai-store.ts) or anything
// that pulls in Upstash/Redis. It may only import from classic-io.ts,
// quiz-io.ts and ai-io.ts, themselves client-safe for the same reason, and
// the dependency-free attachments-keys.ts (#186).
//
// `settings` is deliberately an ALLOWLIST of policy fields
// (`EVENT_POLICY_FIELDS`), not a passthrough object: the live admin settings
// blob also carries schedule/run state (`scoringStartsAt`, `scoringEndsAt`,
// registration window, `paused`, `updatedBy`, `updatedAt`) that must never
// round-trip through an archive. Those fields are per-EVENT-RUN state, not
// portable policy — importing an old archive must not silently reopen or
// freeze a schedule an organizer has already set for the current run. A
// hand-edited bundle carrying one of those keys is refused outright rather
// than silently stripped, so the rejection is visible instead of a silent
// no-op.
//
// Validation composes the three content parsers rather than re-implementing
// their rules: `classic`/`quiz`/`ai`, when present, are delegated to
// `parseClassicBundle`/`parseQuizBundle`/`parseAiBundle` verbatim (via a
// JSON.stringify round-trip of the embedded sub-object, since those parsers
// take a JSON string), and every error they report is folded back in with a
// `"classic."`/`"quiz."`/`"ai."` prefix on `where`. This is the same
// reasoning classic-io.ts and quiz-io.ts share with each other (see
// quiz-io.ts's header): one validator per format, never two independent
// answers to the same question.

import { ATTACHMENT_MAX_BYTES } from "@/lib/attachments-keys";
import { parseBundle as parseAiBundle, type AiBundle } from "@/lib/ai-io";
import { parseBundle as parseClassicBundle, type ClassicBundle } from "@/lib/classic-io";
import { parseBundle as parseQuizBundle, type QuizBundle } from "@/lib/quiz-io";
import { parseBundle as parseSponsorsBundle, type SponsorsBundle } from "@/lib/sponsors-io";
import { EVENT_IMAGE_SLOTS, isEventImageSlot, type EventImagesBundle } from "@/lib/event-images-keys";

// Bumped 1 -> 2 when `secureDevTargets` joined EVENT_POLICY_FIELDS (config
// v2, issue #386 PR 3, CodeRabbit round 1): a box running the OLD code (the
// unbumped version, with a narrower EVENT_POLICY_FIELDS that has never heard
// of `secureDevTargets`) that receives an export from a box running this
// code needs a clean "bundle version is newer than this box supports"
// refusal, not the confusing "field not allowed: secureDevTargets" an
// unversioned schema change would produce. EXPORT always writes the current
// version; IMPORT accepts anything from `EVENT_BUNDLE_MIN_VERSION` through
// `EVENT_BUNDLE_VERSION` — see `parseEventBundle`'s version check below and
// its v1-bundle test in event-io.test.ts.
// Bumped 2 -> 3 when the optional `sponsors` sub-bundle joined (issue #405):
// sponsors are a platform feature, not a module, so there is no
// `enabledModuleIds` gate on it — it rides along whenever the exporting box
// has at least one sponsor configured (event-store.ts's exportEventBundle).
export const EVENT_BUNDLE_VERSION = 3;
/** Oldest bundle version `parseEventBundle` still accepts. A v1 bundle never
 *  carries `secureDevTargets` (the field did not exist yet) — its absence is
 *  handled the same way every other optional policy field's absence already
 *  is: `buildPolicyPatch` (event-store.ts) only touches a field that is
 *  actually `in` the parsed settings object, so a v1 import leaves the box's
 *  stored `secureDevTargets` untouched rather than resetting it to the
 *  all-six default. */
export const EVENT_BUNDLE_MIN_VERSION = 1;

export const EVENT_POLICY_FIELDS = [
  "hintsEnabled",
  "hintCost",
  "hintsMinSolves",
  "hintsUnlockAfterMin",
  "quizMaxAttempts",
  "quizRetryAfterMin",
  "classicCooldownSec",
  "aiCooldownSec",
  "scoreCooldownMin",
  "teamMaxMembers",
  "teamRegistrationOpen",
  "moduleOverrides",
  "enabledModuleIds",
  "secureDevTargets",
] as const;

const EVENT_POLICY_FIELD_SET = new Set<string>(EVENT_POLICY_FIELDS);

export type EventBundleEvent = {
  name: string;
  theme?: string;
  dates?: string;
  location?: string;
  ctfStartsAt?: string | null;
};

export type EventPolicySettings = Partial<Record<(typeof EVENT_POLICY_FIELDS)[number], unknown>>;

export type EventBundle = {
  version: number;
  kind: "archive";
  event: EventBundleEvent;
  settings: EventPolicySettings;
  classic?: ClassicBundle;
  quiz?: QuizBundle;
  /** The ai catalogue (#250): challenges with their flags, hints and
   *  per-challenge signing keys, plus categories. Never the launch keypair —
   *  see ai-io.ts. */
  ai?: AiBundle;
  /** Sponsors (#405), present iff the exporting box has at least one
   *  configured — a platform feature, so unlike classic/quiz/ai this is never
   *  gated on `enabledModuleIds`. */
  sponsors?: SponsorsBundle;
  /** Upload bytes (#186), base64, one entry per stored classic upload. The
   *  classic section carries only metadata; these fill it on import. Each
   *  must match a classic upload's `(item, sha256)` in this same archive. */
  attachmentFiles?: AttachmentFile[];
  /** The event's own logo and favicon (#529). Optional and additive, like
   *  `attachmentFiles`: a box built before it ignores the key. */
  eventImages?: EventImagesBundle;
};

export type AttachmentFile = { item: string; sha256: string; bytes: string };

export type EventImportError = { where: string; message: string };

export type EventParseResult = { ok: true; bundle: EventBundle } | { ok: false; errors: EventImportError[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses and validates an event archive document, accumulating EVERY
 *  problem found rather than stopping at the first — the same
 *  every-error-in-one-pass contract classic-io.ts and quiz-io.ts follow.
 *
 *  Validated in order: JSON parse -> top-level shape (`version`, `kind`,
 *  `event`, `settings`) -> at least one of `classic`/`quiz` present -> each
 *  present sub-bundle delegated to its own parser, with errors folded back
 *  under a `"classic."`/`"quiz."` prefix. Returns `{ ok: true, bundle }` only
 *  when zero errors were collected across the whole pass, and the returned
 *  bundle carries the NORMALIZED classic/quiz bundles from the sub-parsers'
 *  own `ok` results — never the raw input objects — so a round-trip through
 *  parse -> serialize -> parse is stable. */
export function parseEventBundle(raw: string): EventParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately generic, with NO part of the underlying SyntaxError or the
    // raw input echoed back — the same rule classic-io.ts and quiz-io.ts
    // follow, for the same reason: V8's JSON.parse message embeds a short
    // excerpt of the offending text verbatim, and an event archive embeds
    // both a classic bundle's flags and a quiz bundle's answer key, so that
    // excerpt can contain secret text either way.
    return { ok: false, errors: [{ where: "(document)", message: "Invalid JSON" }] };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, errors: [{ where: "(document)", message: "Bundle must be an object" }] };
  }

  const errors: EventImportError[] = [];

  const version = parsed.version;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < EVENT_BUNDLE_MIN_VERSION ||
    version > EVENT_BUNDLE_VERSION
  ) {
    if (typeof version === "number" && version > EVENT_BUNDLE_VERSION) {
      errors.push({
        where: "version",
        // The rule, not the submitted value (#515 review): every import error
        // names the position and what is expected, never what was sent.
        message: `Bundle version is newer than this box supports (expected an integer ${EVENT_BUNDLE_MIN_VERSION}-${EVENT_BUNDLE_VERSION})`,
      });
    } else {
      errors.push({
        where: "version",
        message: `Unsupported bundle version: expected an integer ${EVENT_BUNDLE_MIN_VERSION}-${EVENT_BUNDLE_VERSION}`,
      });
    }
  }

  if (parsed.kind !== "archive") {
    errors.push({ where: "kind", message: 'Bundle kind must be "archive"' });
  }

  if (!isPlainObject(parsed.event) || typeof parsed.event.name !== "string") {
    errors.push({ where: "event", message: 'Bundle "event" must be an object with a string "name"' });
  } else {
    // A present-but-wrong-typed optional identity field is REJECTED, not
    // silently dropped — every other bundle field follows that rule, and
    // event-store's `typeof bundle.event.theme === "string"` guard at import
    // would otherwise ignore a non-string value with no error at all (finding
    // M4). `dates`/`ctfStartsAt` are still baked identity facts (PR 3 of #386
    // derives them from the scoring schedule instead), so they get the same
    // treatment as theme/location here even though nothing currently applies
    // them on import.
    if (parsed.event.theme !== undefined && typeof parsed.event.theme !== "string") {
      errors.push({ where: "event.theme", message: '"event.theme" must be a string' });
    }
    if (parsed.event.location !== undefined && typeof parsed.event.location !== "string") {
      errors.push({ where: "event.location", message: '"event.location" must be a string' });
    }
    if (parsed.event.dates !== undefined && typeof parsed.event.dates !== "string") {
      errors.push({ where: "event.dates", message: '"event.dates" must be a string' });
    }
    if (
      parsed.event.ctfStartsAt !== undefined &&
      parsed.event.ctfStartsAt !== null &&
      typeof parsed.event.ctfStartsAt !== "string"
    ) {
      errors.push({ where: "event.ctfStartsAt", message: '"event.ctfStartsAt" must be a string or null' });
    }
  }

  if (!isPlainObject(parsed.settings)) {
    errors.push({ where: "settings", message: '"settings" must be an object' });
  } else {
    const unknownKeys = Object.keys(parsed.settings).filter((k) => !EVENT_POLICY_FIELD_SET.has(k));
    // Counted, not named (#500): a key name is the archive's own text.
    if (unknownKeys.length > 0) {
      errors.push({
        where: "settings",
        message: `field not allowed (${unknownKeys.length}) — "settings" carries only the event-policy fields`,
      });
    }
  }

  if (
    parsed.classic === undefined &&
    parsed.quiz === undefined &&
    parsed.ai === undefined &&
    parsed.sponsors === undefined
  ) {
    errors.push({ where: "(document)", message: "bundle carries no modules" });
  }

  let classic: ClassicBundle | undefined;
  if (parsed.classic !== undefined) {
    const res = parseClassicBundle(JSON.stringify(parsed.classic));
    if (!res.ok) {
      for (const e of res.errors) errors.push({ where: "classic." + e.where, message: e.message });
    } else {
      classic = res.bundle;
    }
  }

  let quiz: QuizBundle | undefined;
  if (parsed.quiz !== undefined) {
    const res = parseQuizBundle(JSON.stringify(parsed.quiz));
    if (!res.ok) {
      for (const e of res.errors) errors.push({ where: "quiz." + e.where, message: e.message });
    } else {
      quiz = res.bundle;
    }
  }

  let ai: AiBundle | undefined;
  if (parsed.ai !== undefined) {
    const res = parseAiBundle(JSON.stringify(parsed.ai));
    if (!res.ok) {
      for (const e of res.errors) errors.push({ where: "ai." + e.where, message: e.message });
    } else {
      ai = res.bundle;
    }
  }

  let sponsors: SponsorsBundle | undefined;
  if (parsed.sponsors !== undefined) {
    const res = parseSponsorsBundle(JSON.stringify(parsed.sponsors));
    if (!res.ok) {
      for (const e of res.errors) errors.push({ where: "sponsors." + e.where, message: e.message });
    } else {
      sponsors = res.bundle;
    }
  }

  let attachmentFiles: AttachmentFile[] | undefined;
  if (parsed.attachmentFiles !== undefined) {
    attachmentFiles = validateAttachmentFiles(parsed.attachmentFiles, classic, parsed.classic !== undefined, errors);
  }

  let eventImages: EventImagesBundle | undefined;
  if (parsed.eventImages !== undefined) {
    eventImages = validateEventImagesSection(parsed.eventImages, errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  // Every check above passed (errors.length === 0), so `parsed.event` and
  // `parsed.settings` have the required shape and this cast is sound.
  const bundle: EventBundle = {
    version: EVENT_BUNDLE_VERSION,
    kind: "archive",
    event: parsed.event as EventBundleEvent,
    settings: parsed.settings as EventPolicySettings,
    ...(classic !== undefined ? { classic } : {}),
    ...(quiz !== undefined ? { quiz } : {}),
    ...(ai !== undefined ? { ai } : {}),
    ...(sponsors !== undefined ? { sponsors } : {}),
      ...(attachmentFiles ? { attachmentFiles } : {}),
    ...(eventImages ? { eventImages } : {}),
  };
  return { ok: true, bundle };
}

/** Indented, not minified — an organizer edits this file by hand. Ends in a
 *  trailing newline, like every other text file in the repo. A single
 *  `JSON.stringify` over the whole composed object already produces the same
 *  indentation classic-io.ts's and quiz-io.ts's own serializers use, so there
 *  is nothing to delegate to them — and a bundle without an embedded
 *  classic/quiz section must still serialize. */
export function serializeEventBundle(bundle: EventBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}

const FILE_KEYS = new Set(["item", "sha256", "bytes"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** The same shape `classic-io.ts` requires of an upload's metadata sha256. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Shape of the archive's upload bytes (#186). Client-safe: the sha256 of
 *  the decoded bytes is verified server-side (event-store) before the import
 *  resets anything. Each file must name a classic upload's `(item, sha256)`
 *  in this archive — bytes for nothing are refused, not silently dropped. */
function validateAttachmentFiles(
  raw: unknown,
  classic: ClassicBundle | undefined,
  classicPresent: boolean,
  errors: EventImportError[],
): AttachmentFile[] {
  const where = "attachmentFiles";
  if (!Array.isArray(raw)) {
    errors.push({ where, message: '"attachmentFiles" must be an array' });
    return [];
  }
  if (!classicPresent) {
    errors.push({ where, message: '"attachmentFiles" needs a "classic" section to attach to' });
    return [];
  }
  const named = new Set<string>();
  for (const c of classic?.challenges ?? []) {
    for (const a of c.attachments ?? []) if ("sha256" in a) named.add(`${c.id}\n${a.sha256}`);
  }
  const out: AttachmentFile[] = [];
  raw.forEach((f, i) => {
    const at = `${where}[${i}]`;
    if (!isPlainObject(f)) return void errors.push({ where: at, message: "Each file must be an object" });
    // #500: every message below names the indexed path and the rule, never
    // the file's own `item`, `sha256` or key names — this list is echoed to
    // the client verbatim, and an archive's values are arbitrary text.
    const unknown = Object.keys(f).filter((k) => !FILE_KEYS.has(k));
    if (unknown.length > 0) {
      errors.push({ where: at, message: `Unknown key(s) (${unknown.length}) — a file is exactly { item, sha256, bytes }` });
    }
    if (typeof f.item !== "string" || typeof f.sha256 !== "string" || typeof f.bytes !== "string") {
      return void errors.push({ where: at, message: "A file is { item, sha256, bytes } — all strings" });
    }
    if (f.bytes.length % 4 !== 0 || !BASE64_RE.test(f.bytes)) {
      errors.push({ where: `${at}.bytes`, message: "bytes must be base64" });
    } else if (Math.floor((f.bytes.length * 3) / 4) > ATTACHMENT_MAX_BYTES + 2) {
      errors.push({ where: `${at}.bytes`, message: `A file can be at most ${ATTACHMENT_MAX_BYTES} bytes` });
    }
    if (!SHA256_RE.test(f.sha256)) {
      errors.push({ where: `${at}.sha256`, message: "sha256 must be 64 lowercase hex digits" });
    } else if (!named.has(`${f.item}\n${f.sha256}`)) {
      errors.push({ where: at, message: "No classic upload in this archive matches this file's item and sha256" });
    }
    out.push({ item: f.item, sha256: f.sha256, bytes: f.bytes });
  });
  return out;
}

/** The `eventImages` section's SHAPE (#529): an object of known slots, each
 *  `{ data: string }`. The bytes themselves are sniffed by
 *  event-images-store's `validateEventImagesBundle`, which the import runs
 *  before anything destructive. Errors name the position, never the value or
 *  key that was sent (#500). */
function validateEventImagesSection(raw: unknown, errors: EventImportError[]): EventImagesBundle | undefined {
  if (!isPlainObject(raw)) {
    errors.push({ where: "eventImages", message: '"eventImages" must be an object' });
    return undefined;
  }
  const unknown = Object.keys(raw).filter((k) => !isEventImageSlot(k));
  if (unknown.length > 0) {
    errors.push({ where: "eventImages", message: `field not allowed (${unknown.length}) — the slots are ${EVENT_IMAGE_SLOTS.join(", ")}` });
  }
  const out: EventImagesBundle = {};
  for (const slot of EVENT_IMAGE_SLOTS) {
    const entry = raw[slot];
    if (entry === undefined) continue;
    const where = `eventImages.${slot}`;
    if (!isPlainObject(entry) || typeof entry.data !== "string" || Object.keys(entry).some((k) => k !== "data")) {
      errors.push({ where, message: `"${where}" must be an object with only a string "data"` });
      continue;
    }
    out[slot] = { data: entry.data };
  }
  return out;
}
