// Pure bundle parser, validator and serializer for a whole-EVENT archive:
// event metadata + policy settings + the classic, quiz and/or ai content
// bundles, composed into one importable/exportable file. This file is
// CLIENT-SAFE ON PURPOSE, mirroring classic-io.ts, quiz-io.ts and ai-io.ts:
// the admin panel's archive import/export UI is a Client Component that needs
// to validate a pasted/uploaded archive in the browser before it ever reaches
// the server, so this file must NEVER import a `server-only` module (e.g.
// admin-store.ts, classic-store.ts, quiz-store.ts, ai-store.ts) or anything
// that pulls in Upstash/Redis. It may only import from classic-io.ts,
// quiz-io.ts and ai-io.ts, themselves client-safe for the same reason.
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

import { parseBundle as parseAiBundle, type AiBundle } from "@/lib/ai-io";
import { parseBundle as parseClassicBundle, type ClassicBundle } from "@/lib/classic-io";
import { parseBundle as parseQuizBundle, type QuizBundle } from "@/lib/quiz-io";
import { parseBundle as parseSponsorsBundle, type SponsorsBundle } from "@/lib/sponsors-io";

// Bumped 1 -> 2 when `secureDevTargets` joined EVENT_POLICY_FIELDS (config
// v2, issue #386 PR 3, CodeRabbit round 1): a box running the OLD code (the
// unbumped version, with a narrower EVENT_POLICY_FIELDS that has never heard
// of `secureDevTargets`) that receives an export from a box running this
// code needs a clean "bundle version 2 is newer than this box supports"
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
};

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
        message: `Bundle version ${version} is newer than this box supports (expected ${EVENT_BUNDLE_MIN_VERSION}-${EVENT_BUNDLE_VERSION})`,
      });
    } else {
      errors.push({
        where: "version",
        message: `Unsupported bundle version: expected ${EVENT_BUNDLE_MIN_VERSION}-${EVENT_BUNDLE_VERSION}, got ${String(version)}`,
      });
    }
  }

  if (parsed.kind !== "archive") {
    errors.push({ where: "kind", message: `Bundle kind must be "archive", got ${String(parsed.kind)}` });
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
    for (const key of unknownKeys) {
      errors.push({ where: "settings", message: `field not allowed: ${key}` });
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
