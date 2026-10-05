import "server-only";
import { assertPipelineOk, parseScanPage, upstashEval, upstashPipeline } from "@/lib/upstash";
import { ADMIN_ADMINS_KEY, LOGIN_RE } from "@/lib/admin-admins";
import { TEAM_MAX_MEMBERS_MAX } from "@/lib/team-limits";
import { SCORE_COOLDOWN_MIN_MAX } from "@/lib/scoring-defaults";
import {
  isModuleId,
  MODULE_TITLE_MAX,
  MODULE_BLURB_MAX,
  type ModuleId,
  type ModuleOverrides,
} from "@/lib/modules";
import { EVENT_IDENTITY_KEYS, checkEventIdentityValue, isEventIdentityKey, type EventIdentityOverrides } from "@/lib/event-identity";
import { checkSecureDevTargets, normalizeSecureDevTargets } from "@/lib/secure-dev-targets";
import type { AppId } from "@/lib/apps";
// `secureDevAvailable` (not `defaultEnabledModules`/`defaultModuleIds` from
// `@/lib/enabled-modules`): that module imports `getAdminSettings` from this
// one, so importing it back here would be a cycle. `module-defaults.ts` is
// the pure, dependency-free source both sides compute the same default from;
// admin-store is `server-only`, so calling it with `process.env` here is safe.
// The default the demo seed needs comes with lib/demo-seed.ts (#504 M9).
import { secureDevAvailable } from "@/lib/module-defaults";
import { errorLabel } from "@/lib/error-label";
import { beginScoreLowering, endScoreLowering } from "@/lib/leaderboard/fold-cache";
import { QUIZ_POINTS_KEY, QUIZ_ANSWERED_KEY, QUIZ_LAST_AT_KEY, QUIZ_ANSWERS_PREFIX, QUIZ_ATTEMPTS_PREFIX } from "@/lib/quiz-keys";
import {
  CLASSIC_POINTS_KEY,
  CLASSIC_SOLVED_KEY,
  CLASSIC_SOLVECOUNT_KEY,
  CLASSIC_LAST_AT_KEY,
  CLASSIC_SOLVES_PREFIX,
  CLASSIC_ATTEMPTS_PREFIX,
} from "@/lib/classic-keys";
import {
  AI_POINTS_KEY,
  AI_SOLVED_KEY,
  AI_SOLVECOUNT_KEY,
  AI_LAST_AT_KEY,
  AI_SOLVES_PREFIX,
  AI_ATTEMPTS_PREFIX,
  AI_NONCE_PREFIX,
  AI_LAUNCHKEY_KEY,
} from "@/lib/ai-keys";
import { ACTIVITY_LOG_KEY } from "@/lib/activity-keys";
import { ADMIN_AUDIT_KEY, AUDIT_CAP } from "@/lib/admin-audit-keys";
import { SPONSORS_KEY, SPONSORS_LOGO_KEY, isSponsorLogoSize, type SponsorLogoSize } from "@/lib/sponsors-keys";

// The audit trail's key and cap live in a dependency-free leaf so
// lib/demo-seed.ts can append to the same trail without importing this module
// back (#504 M9). Re-exported so this module's callers keep one import.
export { ADMIN_AUDIT_KEY, AUDIT_CAP };

export const ADMIN_SETTINGS_KEY = "ctf:admin:settings";
export const SYNC_STATUS_KEY = "ctf:sync:status";
export const HINT_COST_MAX = 100000;
/** Caps for the two hint-gating knobs (see hint-store's `hintGate`). */
export const HINT_MIN_SOLVES_MAX = 1000;
export const HINT_UNLOCK_AFTER_MAX = 100000; // minutes
/** Caps for the two quiz retry-gate knobs (see quiz-store's `quizGate`). */
export const QUIZ_MAX_ATTEMPTS_MAX = 100;
export const QUIZ_RETRY_AFTER_MAX = 100000; // minutes
/** Cap for the classic-module submission cooldown (see below). */
export const CLASSIC_COOLDOWN_SEC_MAX = 3600;
/** Cap for the ai-module submission cooldown (see below). Separate constant
 *  from CLASSIC_COOLDOWN_SEC_MAX rather than shared: the two modules' knobs
 *  happen to agree on [0, 3600] today, but nothing ties them together, and a
 *  shared constant would make that agreement look load-bearing when it isn't. */
export const AI_COOLDOWN_SEC_MAX = 3600;

/** The ONLY thing an admin-authoring route may hand `console.error`. Shared
 *  by every `admin/*` route that writes secrets (a flag, a signing key).
 *
 *  Never the caught value itself: a driver can decorate an error with the
 *  request it failed on, and an admin write's arguments can include a flag
 *  or a signing key, so a bare `console.error(err)` could turn an outage into
 *  a secret in the log. It IS `errorLabel` — re-exported under the name the
 *  admin routes already import, not a second copy of the body, so a
 *  change to the shared label reaches these routes too. */
export const adminErrorLabel: (err: unknown) => string = errorLabel;

/** Appends one line to the shared `ctf:admin:audit` trail — the same
 *  LPUSH+LTRIM pattern every admin authoring route uses. Best-effort: an
 *  audit-write failure is logged but never fails a request whose actual data
 *  write already succeeded. `detail` must carry identifiers only, never a
 *  flag, a signing key, or a minted token — callers are responsible for
 *  keeping it that way. */
export async function writeAdminAudit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
  const audit = JSON.stringify({ at: new Date().toISOString(), by: actor, action, ...detail });
  try {
    await upstashPipeline([
      ["LPUSH", ADMIN_AUDIT_KEY, audit],
      ["LTRIM", ADMIN_AUDIT_KEY, 0, AUDIT_CAP - 1],
    ]);
  } catch (err) {
    console.error(`[admin] audit write failed (${action}):`, adminErrorLabel(err));
  }
}

// SCORE_COOLDOWN_MIN_MAX (scoring-defaults.ts), TEAM_MAX_MEMBERS_MAX
// (team-limits.ts) and MODULE_TITLE_MAX / MODULE_BLURB_MAX (@/lib/modules) —
// all used below for validation — are defined in client-safe modules (no
// `server-only`, unlike this file) so the admin panel can read them for its
// fields' `max`. None is re-exported here: every consumer imports from the
// origin module, and a second import path to the same constant is exactly
// the kind of dead surface a later change could silently drift out of sync
// with.
const MODULE_FIELD_RE = /^module(Title|Blurb):(.+)$/;
// Organizer-authored text rendered on pages every contestant loads. Plain text
// only — reject C0 control characters (so nothing can smuggle a terminal
// escape or a line break into a heading) and Unicode bidi override/isolate
// characters (U+202A-U+202E, U+2066-U+2069), which reorder rendered glyphs
// and could visually scramble a heading. This is rendered-text integrity, not
// injection protection — there is no HTML to sanitise because none is ever
// interpreted.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/;

export type AdminSettings = {
  paused: boolean;
  hintsEnabled: boolean | null;
  hintCost: number | null;
  /** Solves a login needs ON THE TARGET before it may buy that target's
   *  hints — the anti-burner gate. Null = no override, use the default. */
  hintsMinSolves: number | null;
  /** Minutes after `scoringStartsAt` before any hint may be bought. Null =
   *  no override; 0 = no time phase. */
  hintsUnlockAfterMin: number | null;
  /** Attempts a login gets per quiz question before the retry gate refuses
   *  further submissions (see quiz-store's `quizGate`). Null = no override,
   *  use the default. 0 = unlimited attempts. */
  quizMaxAttempts: number | null;
  /** Minutes a login must wait after its last attempt before it may retry the
   *  same quiz question. Null = no override; 0 = no cooldown. */
  quizRetryAfterMin: number | null;
  /** Seconds a login must wait between flag submissions on the SAME classic
   *  challenge. null = use the module default. Seconds, not minutes: its job
   *  is blocking scripted brute force, not rationing tries. */
  classicCooldownSec: number | null;
  /** Seconds a login must wait between flag submissions on the SAME ai
   *  challenge. null = use the module default. Mirrors `classicCooldownSec`
   *  exactly, including the module's own script re-enforcing whatever value
   *  this resolves to. */
  aiCooldownSec: number | null;
  /** Minutes a contestant must wait between SCORED runs on the same PR.
   *  Null = no override; the fork workflow's baked default applies. 0 disables
   *  the cooldown. Enforced by the Action inside each fork, which reads it
   *  from /api/public/scoring — see ADR 46. */
  scoreCooldownMin: number | null;
  /** Players allowed on one team. Null = no override, use the default in
   *  team-store. Enforced on JOIN only: lowering it never evicts anyone from a
   *  team that is already over the new cap. */
  teamMaxMembers: number | null;
  teamRegistrationOpen: boolean;
  // Scheduled "auto dates" — nullable ISO instants. scoring* gates the freeze
  // through outsideScoringWindow (before start / after end = paused, and an
  // absent start = not launched, so paused); registration* gates
  // team create/join through outsideWindow (absent bound = open). Enforced at
  // READ time (no scheduler on the box): see effectivePaused below and
  // effectiveRegistrationOpen in schedule-window.ts, mirrored in the scorer
  // (store.js), sync poller (redis.js), and team-store.
  scoringStartsAt: string | null;
  scoringEndsAt: string | null;
  registrationStartsAt: string | null;
  registrationEndsAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Organizer-authored title/blurb overrides, keyed by module id. Unknown or
   *  disabled module ids are dropped on read (see decodeSettings). */
  moduleOverrides: ModuleOverrides;
  /** The modules this event actually serves. Three states:
   *  - absent (`null`) — nothing stored, the deployment default applies
   *    (`defaultEnabledModules`: secure-development alone when a scorer
   *    image is configured, otherwise nothing).
   *  - `[]` — the organizer explicitly switched every module off.
   *  - a list — those ids, with any the registry does not know dropped;
   *    if that drop empties the list, it decodes back to `null` (a stale
   *    field is not a decision to show nothing). */
  enabledModuleIds: ModuleId[] | null;
  /** The organizer's event identity fields — only the fields
   *  actually stored; `resolveSite()` in lib/site.ts lays them over the
   *  defaults. Absent field = default. */
  eventIdentity: EventIdentityOverrides;
  /** Which of the six secure-development targets this event runs, read by
   *  `lib/enabled-apps.ts` per request. `null` means
   *  nothing stored (or the stored value decoded to nothing survivable) —
   *  the deployment default (`DEFAULT_SECURE_DEV_TARGETS`, all six) applies.
   *  Unlike `enabledModuleIds`, there is no explicit-empty state: emptying
   *  every target would leave the secure-development board live with
   *  nothing to show, so `normalizeSecureDevTargets` treats a stored empty
   *  (or all-unknown) list the same as absent. */
  secureDevTargets: AppId[] | null;
  /** How big a sponsor's logo renders on the landing-page strip. Null = no
   *  override, use the default ("md") — see SponsorLogoSize in
   *  sponsors-keys.ts. Scoped to the strip alone; /sponsors and the
   *  leaderboard display board keep their own fixed sizes. */
  sponsorLogoSize: SponsorLogoSize | null;
};

// The window check itself lives in schedule-window.ts (a dependency-free
// leaf) so the /admin Event tab — a Client Component that cannot import this
// server-only module — renders its "right now" readout from the SAME
// implementation instead of a fourth copy of the three-reader contract.
// Re-exported here so every existing caller and test is untouched.
import { outsideScoringWindow, outsideWindow } from "@/lib/schedule-window";
export { outsideScoringWindow, outsideWindow };

/** Effective scoring freeze: the manual toggle OR the scheduled scoring
 *  window — which includes "not launched" (no scoring start). */
export function effectivePaused(s: AdminSettings, nowMs: number = Date.now()): boolean {
  return s.paused || outsideScoringWindow(nowMs, s.scoringStartsAt, s.scoringEndsAt);
}

/** Effective registration state — the rule lives in schedule-window.ts. */
export { effectiveRegistrationOpen } from "@/lib/schedule-window";

export type SyncStatus = {
  lastPollAt: string | null;
  lastError: string | null;
  ingested: number;
  /** Score comments the poller consumed and could not turn into points — a
   *  scorer 4xx, or a `ctf-score:` marker it cannot read. Cumulative, and
   *  never self-clearing: each one is a score sitting on a PR that the
   *  leaderboard will never show until somebody intervenes. `lastDrop` says
   *  which repo and why. */
  dropped: number;
  lastDrop: string | null;
  reposPolled: number;
  paused: boolean;
};

// Dynamic per-module naming fields: moduleTitle:<id> / moduleBlurb:<id>. A
// template literal type (not a bare index signature) so TypeScript still
// catches a typo in any of the fixed field names above.
type ModuleFieldKey = `moduleTitle:${string}` | `moduleBlurb:${string}`;

export type SettingsPatch = {
  paused?: boolean;
  hintsEnabled?: boolean;
  hintCost?: number;
  hintsMinSolves?: number;
  hintsUnlockAfterMin?: number;
  quizMaxAttempts?: number;
  quizRetryAfterMin?: number;
  classicCooldownSec?: number;
  aiCooldownSec?: number;
  scoreCooldownMin?: number;
  teamMaxMembers?: number;
  teamRegistrationOpen?: boolean;
  /** The modules this event serves. Replaces the set wholesale;
   *  see updateAdminSettings for the two things it refuses. */
  enabledModules?: ModuleId[];
  // ISO instant to set the bound, or null/"" to clear it.
  scoringStartsAt?: string | null;
  scoringEndsAt?: string | null;
  registrationStartsAt?: string | null;
  registrationEndsAt?: string | null;
  /** Event identity. "" clears the field back to its default,
   *  the same contract as `moduleTitle:<id>`. */
  eventName?: string;
  eventTheme?: string;
  eventLocation?: string;
  eventContact?: string;
  eventDiscord?: string;
  /** The hero logo's click-through link. */
  eventLogoUrl?: string;
  /** The event's IANA time zone; "" = UTC. */
  eventTimeZone?: string;
  /** Which of the six secure-development targets this event runs.
   *  Replaces the whole set, like `enabledModules`; never
   *  clears — see updateAdminSettings for why there is no empty state. */
  secureDevTargets?: string[];
  /** null/"" clears back to the default ("md") — same contract as the
   *  schedule fields. */
  sponsorLogoSize?: SponsorLogoSize | null | "";
} & Partial<Record<ModuleFieldKey, string>>;

const SCHEDULE_FIELDS = ["scoringStartsAt", "scoringEndsAt", "registrationStartsAt", "registrationEndsAt"] as const;

export class AdminValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "AdminValidationError";
    this.field = field;
  }
}


function flatToObject(flat: unknown): Record<string, string> {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const obj: Record<string, string> = {};
  for (let i = 0; i < arr.length; i += 2) obj[arr[i]] = arr[i + 1];
  return obj;
}

// `paused` is two-state on the wire — "1" or absent — so false and
// never-set are the same value. `hintsEnabled` is deliberately three-state
// ("1"/"0"/absent) since absent means "no override, use the env default".
// `teamRegistrationOpen` is two-state but inverted: absent means open (the
// default), and a stored "0" means registration is closed.
function decodeSettings(h: Record<string, string>): AdminSettings {
  // Dynamic fields: moduleTitle:<id> / moduleBlurb:<id>. Unknown ids are
  // dropped on read as well as rejected on write — a stale override left by a
  // module that has since been disabled must not resurface if it is
  // re-enabled under a different name.
  const moduleOverrides: ModuleOverrides = {};
  for (const [field, value] of Object.entries(h)) {
    const m = MODULE_FIELD_RE.exec(field);
    if (!m) continue;
    const [, which, id] = m;
    // Filtered against the REGISTRY, not against what event.yaml baked in:
    // enablement is a runtime fact, so an organizer who enables classic and
    // renames it must not have the rename silently dropped on every read.
    // An id the registry does not know is still dropped — it can never render.
    if (!isModuleId(id)) continue;
    const slot = (moduleOverrides[id as ModuleId] ??= {});
    if (which === "Title") slot.title = value;
    else slot.blurb = value;
  }

  const eventIdentity: EventIdentityOverrides = {};
  for (const key of EVENT_IDENTITY_KEYS) {
    if (typeof h[key] === "string") eventIdentity[key] = h[key];
  }

  return {
    paused: h.paused === "1",
    hintsEnabled: h.hintsEnabled === undefined ? null : h.hintsEnabled === "1",
    hintCost: h.hintCost === undefined ? null : Number(h.hintCost),
    hintsMinSolves: h.hintsMinSolves === undefined ? null : Number(h.hintsMinSolves),
    hintsUnlockAfterMin: h.hintsUnlockAfterMin === undefined ? null : Number(h.hintsUnlockAfterMin),
    quizMaxAttempts: h.quizMaxAttempts === undefined ? null : Number(h.quizMaxAttempts),
    quizRetryAfterMin: h.quizRetryAfterMin === undefined ? null : Number(h.quizRetryAfterMin),
    classicCooldownSec: h.classicCooldownSec === undefined ? null : Number(h.classicCooldownSec),
    aiCooldownSec: h.aiCooldownSec === undefined ? null : Number(h.aiCooldownSec),
    teamMaxMembers: h.teamMaxMembers === undefined ? null : Number(h.teamMaxMembers),
    scoreCooldownMin: h.scoreCooldownMin === undefined ? null : Number(h.scoreCooldownMin),
    teamRegistrationOpen: h.teamRegistrationOpen !== "0",
    scoringStartsAt: h.scoringStartsAt ?? null,
    scoringEndsAt: h.scoringEndsAt ?? null,
    registrationStartsAt: h.registrationStartsAt ?? null,
    registrationEndsAt: h.registrationEndsAt ?? null,
    updatedBy: h.updatedBy ?? null,
    updatedAt: h.updatedAt ?? null,
    moduleOverrides,
    enabledModuleIds: decodeEnabledModuleIds(h.enabledModules),
    eventIdentity,
    secureDevTargets: normalizeSecureDevTargets(h.secureDevTargets),
    sponsorLogoSize: isSponsorLogoSize(h.sponsorLogoSize) ? h.sponsorLogoSize : null,
  };
}

/** Decodes the runtime enablement set.
 *
 *  - absent            → null: nothing stored, the deployment default applies
 *  - ""                → []:   the organizer switched every module off
 *  - "quiz, classic"   → ["quiz","classic"], unknown ids dropped
 *  - only unknown ids  → null: a stale field is not a decision to show nothing */
function decodeEnabledModuleIds(raw: string | undefined): ModuleId[] | null {
  if (typeof raw !== "string") return null;
  if (raw.trim() === "") return [];
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(isModuleId);
  return ids.length > 0 ? [...new Set(ids)] : null;
}

/** `timeoutMs` bounds the read itself (the pipeline's default otherwise) —
 *  the public /health/deep probe passes its own deadline. */
export async function getAdminSettings(timeoutMs?: number): Promise<AdminSettings> {
  const [res] = await upstashPipeline([["HGETALL", ADMIN_SETTINGS_KEY]], timeoutMs === undefined ? undefined : { timeoutMs });
  // A command-level failure resolves as { error } rather than rejecting.
  // Decoding its missing result would silently serve DEFAULT settings (not
  // paused, baked caps) with no log — so throw, making it behave exactly
  // like the transport error every caller already handles with its own
  // documented fail direction.
  if (res.error) throw new Error(res.error);
  return decodeSettings(flatToObject(res.result));
}

export async function getSyncStatus(): Promise<SyncStatus | null> {
  const [res] = await upstashPipeline([["HGETALL", SYNC_STATUS_KEY]]);
  // An error reply is not "never polled": throw, so /admin and
  // /health/deep report the read as failed rather than as no heartbeat.
  if (res.error) throw new Error(`Upstash HGETALL sync status failed: ${res.error}`);
  const h = flatToObject(res.result);
  if (Object.keys(h).length === 0) return null;
  return {
    lastPollAt: h.lastPollAt ?? null,
    lastError: h.lastError ?? null,
    ingested: Number(h.ingested ?? 0),
    dropped: Number(h.dropped ?? 0),
    lastDrop: h.lastDrop ?? null,
    reposPolled: Number(h.reposPolled ?? 0),
    paused: h.paused === "1",
  };
}

// HDEL the fields being cleared, HSET the changed fields + updatedBy/updatedAt,
// LPUSH one audit line, LTRIM the list — one atomic script so a change can
// never land without its audit record.
// ARGV: [1]=updatedBy [2]=updatedAt [3]=auditLine [4]=cap-1 [5]=numDels
//       [6 .. 5+numDels]=field names to HDEL  [6+numDels ..]=field,value pairs to HSET
const UPDATE_SCRIPT = `
local numDels = tonumber(ARGV[5])
-- The scoring window must be able to open (#464). Checked here, atomically
-- with the write, on the RESULTING bounds: this patch's value for a bound it
-- sets or clears, else the stored one. Stored bounds are normalised ISO-8601
-- UTC strings, so string order is time order. Only when the patch touches a
-- bound: an unrelated save is never refused over a window it does not touch.
local touched, startV, endV = false, nil, nil
local startSet, endSet = false, false
for i = 1, numDels do
  if ARGV[5 + i] == 'scoringStartsAt' then touched = true; startSet = true end
  if ARGV[5 + i] == 'scoringEndsAt' then touched = true; endSet = true end
end
for i = 6 + numDels, #ARGV, 2 do
  if ARGV[i] == 'scoringStartsAt' then touched = true; startSet = true; startV = ARGV[i+1] end
  if ARGV[i] == 'scoringEndsAt' then touched = true; endSet = true; endV = ARGV[i+1] end
end
if touched then
  if not startSet then startV = redis.call('HGET', KEYS[1], 'scoringStartsAt') or nil end
  if not endSet then endV = redis.call('HGET', KEYS[1], 'scoringEndsAt') or nil end
  if startV and endV and endV <= startV then return {'__window_refused__', startV, endV} end
end
redis.call('HSET', KEYS[1], 'updatedBy', ARGV[1], 'updatedAt', ARGV[2])
for i = 1, numDels do redis.call('HDEL', KEYS[1], ARGV[5 + i]) end
for i = 6 + numDels, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1]) end
redis.call('LPUSH', KEYS[2], ARGV[3])
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[4]))
return redis.call('HGETALL', KEYS[1])`;

function windowRefusal(start: string, end: string): AdminValidationError {
  return new AdminValidationError(
    "scoringEndsAt",
    `Scoring closes (${end}) is at or before Scoring opens (${start}), so scoring could never open — clear or move Scoring closes first`,
  );
}

export async function updateAdminSettings(patch: SettingsPatch, actor: string): Promise<AdminSettings> {
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new AdminValidationError("patch", "empty patch");
  const fields: string[] = [];
  const dels: string[] = [];
  const changed: Record<string, boolean | number> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "paused") {
      if (typeof v !== "boolean") throw new AdminValidationError(k, `${k} must be a boolean`);
      // Two-state on the wire: "1" or absent. False must clear the field
      // (HDEL) rather than write "0" — the sync poller and scorer read this
      // key independently with a presence check, so false must equal absent.
      if (v) fields.push(k, "1");
      else dels.push(k);
      changed[k] = v;
    } else if (k === "hintsEnabled") {
      if (typeof v !== "boolean") throw new AdminValidationError(k, `${k} must be a boolean`);
      fields.push(k, v ? "1" : "0");
      changed[k] = v;
    } else if (k === "teamRegistrationOpen") {
      if (typeof v !== "boolean") throw new AdminValidationError(k, `${k} must be a boolean`);
      // Two-state, inverted from `paused`: open is the default (absent), so
      // opening HDELs the field and closing writes the string "0". The team
      // store reads this key with a presence-and-value check, so open must
      // equal absent.
      if (v) dels.push(k);
      else fields.push(k, "0");
      changed[k] = v;
    } else if (k === "hintCost") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > HINT_COST_MAX) {
        throw new AdminValidationError(k, `hintCost must be an integer in [0, ${HINT_COST_MAX}]`);
      }
      fields.push(k, String(v));
      changed[k] = v;
    } else if (k === "hintsMinSolves") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > HINT_MIN_SOLVES_MAX) {
        throw new AdminValidationError(k, `hintsMinSolves must be an integer in [0, ${HINT_MIN_SOLVES_MAX}]`);
      }
      fields.push(k, String(v));
      changed[k] = v;
    } else if (k === "hintsUnlockAfterMin") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > HINT_UNLOCK_AFTER_MAX) {
        throw new AdminValidationError(k, `hintsUnlockAfterMin must be an integer in [0, ${HINT_UNLOCK_AFTER_MAX}]`);
      }
      fields.push(k, String(v));
      changed[k] = v;
    } else if (k === "quizMaxAttempts") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > QUIZ_MAX_ATTEMPTS_MAX) {
        throw new AdminValidationError(k, `quizMaxAttempts must be an integer in [0, ${QUIZ_MAX_ATTEMPTS_MAX}]`);
      }
      fields.push(k, String(v));
      changed[k] = v;
    } else if (k === "quizRetryAfterMin") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > QUIZ_RETRY_AFTER_MAX) {
        throw new AdminValidationError(k, `quizRetryAfterMin must be an integer in [0, ${QUIZ_RETRY_AFTER_MAX}]`);
      }
      fields.push(k, String(v));
      changed[k] = v;
    } else if (k === "classicCooldownSec") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > CLASSIC_COOLDOWN_SEC_MAX) {
        throw new AdminValidationError(k, `classicCooldownSec must be an integer in [0, ${CLASSIC_COOLDOWN_SEC_MAX}]`);
      }
      fields.push(k, String(v));
      changed[k] = v;
    } else if (k === "aiCooldownSec") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > AI_COOLDOWN_SEC_MAX) {
        throw new AdminValidationError(k, `aiCooldownSec must be an integer in [0, ${AI_COOLDOWN_SEC_MAX}]`);
      }
      fields.push(k, String(v));
      changed[k] = v;
    } else if (k === "scoreCooldownMin") {
      // 0 is VALID here, unlike teamMaxMembers: it means "no cooldown", which
      // is a reasonable choice for a short workshop where the feedback loop
      // matters more than the anti-gaming cap.
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > SCORE_COOLDOWN_MIN_MAX) {
        throw new AdminValidationError(k, `scoreCooldownMin must be an integer in [0, ${SCORE_COOLDOWN_MIN_MAX}]`);
      }
      fields.push(k, String(v));
      changed[k] = v;
    } else if (k === "teamMaxMembers") {
      // Floor of 1, not 0. Zero would store a cap no team can satisfy — every
      // join refused, including the captain's own team, with the UI cheerfully
      // advertising "0 players max". Rejecting it here is the difference
      // between a validation error and an event nobody can form a team in.
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > TEAM_MAX_MEMBERS_MAX) {
        throw new AdminValidationError(k, `teamMaxMembers must be an integer in [1, ${TEAM_MAX_MEMBERS_MAX}]`);
      }
      fields.push(k, String(v));
      changed[k] = v;
    } else if (k === "sponsorLogoSize") {
      // null/"" clears back to the default ("md") — same two-state contract
      // as the schedule fields below.
      if (v === null || v === "") {
        dels.push(k);
        changed[k] = null as unknown as boolean;
      } else {
        if (!isSponsorLogoSize(v)) {
          throw new AdminValidationError(k, 'sponsorLogoSize must be "sm", "md", "lg", or null');
        }
        fields.push(k, v);
        changed[k] = v as unknown as boolean;
      }
    } else if ((SCHEDULE_FIELDS as readonly string[]).includes(k)) {
      // Nullable ISO bound: null/"" clears it (HDEL); a value must parse as a
      // date and is stored normalised to its ISO-8601 UTC form.
      if (v === null || v === "") {
        dels.push(k);
        changed[k] = null as unknown as boolean;
      } else {
        if (typeof v !== "string") throw new AdminValidationError(k, `${k} must be an ISO date string or null`);
        // Launch now: "now" means THIS server's clock, so an organizer's
        // skewed laptop clock can never launch into the future. The one
        // sentinel, and only for the scoring start.
        const ms = k === "scoringStartsAt" && v === "now" ? Date.now() : Date.parse(v);
        if (!Number.isFinite(ms)) throw new AdminValidationError(k, `${k} must be a valid ISO date string`);
        const iso = new Date(ms).toISOString();
        fields.push(k, iso);
        changed[k] = iso as unknown as boolean;
      }
    } else if (k === "enabledModules") {
      // Replaces the whole set rather than toggling one id: an organizer's
      // intent is "these are the modules", and a per-id patch would let two
      // admin tabs open at once race each other into a set neither chose.
      if (!Array.isArray(v) || v.some((id) => !isModuleId(id))) {
        throw new AdminValidationError(k, "enabledModules must be an array of known module ids");
      }
      let requested = [...new Set(v as ModuleId[])];

      // The one refusal left: Secure Development needs the scorer
      // and sync containers, which exist only when the stack was brought up
      // with a SCORE_IMAGE. Enabling it here would show a board no run can
      // ever score. Fail closed; the panel disables the switch for the same
      // reason, this is the server's copy of that rule.
      //
      // But refuse only a NEW enable. A deployment that had a scorer image
      // when SD was switched on can still have it stored after SCORE_IMAGE is
      // removed — every write here replaces the whole set, so if a carried-
      // forward SD were refused too, the Modules section would deadlock: any
      // write short of dropping SD fails, and SD's own switch is locked off
      // (module-toggle.ts), so there is no way to drop it either. Read the
      // current hash to tell "already stored" from "new"; a read failure
      // means "cannot confirm it is already stored", so it refuses too.
      //
      // Ruling (CodeRabbit round 1, finding B): secure-development is NEVER
      // WRITTEN when unavailable, carried-forward or not — a stale read
      // between this check and the write below must never be able to
      // re-store it. The read here only ever picks refuse-vs-strip: on a
      // genuinely new enable it refuses; on a carry-forward it
      // STRIPS the id from what gets written instead of passing it through.
      // A concurrent SD-disable landing between this read and our write can
      // therefore at worst turn a strip into a refusal (the stale read still
      // sees it "stored", so this write silently drops it) —
      // it can never turn a strip back into a store, because stripping never
      // depends on the read succeeding: this whole branch only ever removes
      // the id from `requested`, never adds it back.
      const sdId: ModuleId = "secure-development";
      if (requested.includes(sdId) && !secureDevAvailable(process.env)) {
        const stored = await getAdminSettings()
          .then((s) => s.enabledModuleIds ?? [])
          .catch((): ModuleId[] => []);
        const addingSd = !stored.includes(sdId);
        if (addingSd) {
          throw new AdminValidationError(
            k,
            "secure-development cannot be enabled here — this deployment has no scorer image (SCORE_IMAGE is unset)",
          );
        }
        requested = requested.filter((id) => id !== sdId);
      }
      fields.push(k, requested.join(","));
      changed[k] = requested.join(",") as unknown as boolean;
    } else if (isEventIdentityKey(k)) {
      // Event identity. Validation lives in event-identity.ts so
      // the Event tab can share the limits; "" clears (HDEL) — the default is
      // what blank restores, exactly like a module title override.
      //
      // The audit line never carries the value itself, only a redacted
      // marker (CodeRabbit round 2): eventDiscord can embed an invite/join
      // token in its URL, and eventContact is PII — recording either verbatim
      // in an admin-visible log persists a secret/PII where "who changed
      // what" only needs the field name. Every identity key uses the same
      // marker for uniformity rather than special-casing just those two.
      const check = checkEventIdentityValue(k, v);
      if (!check.ok) throw new AdminValidationError(k, check.message);
      if (check.value === "") {
        dels.push(k);
        changed[k] = "cleared" as unknown as boolean;
      } else {
        fields.push(k, check.value);
        changed[k] = "set" as unknown as boolean;
      }
    } else if (k === "secureDevTargets") {
      // Which of the six secure-development targets this event runs.
      // Replaces the whole set, like `enabledModules` — an
      // organizer's intent is "these are the targets", not a per-id toggle.
      // Unlike `enabledModules`/the event identity fields, there is NO
      // clear/HDEL path: `checkSecureDevTargets` never returns an empty
      // list (an all-unknown or empty input is itself a validation error),
      // so every accepted value is stored as a non-empty JSON array
      // (controller ruling R2 — a stored empty set would leave the
      // Secure Development board live with nothing to show).
      const check = checkSecureDevTargets(v);
      if (!check.ok) throw new AdminValidationError(k, check.message);
      fields.push(k, JSON.stringify(check.value));
      changed[k] = JSON.stringify(check.value) as unknown as boolean;
    } else if (MODULE_FIELD_RE.test(k)) {
      const [, which, id] = MODULE_FIELD_RE.exec(k)!;
      // Fail closed: an id the registry does not know is a typo or a probe,
      // never something to store quietly. Checked against the REGISTRY rather
      // than the baked set for the same reason as the read path above — a
      // module enabled at runtime is renameable like any other.
      if (!isModuleId(id)) {
        throw new AdminValidationError(k, `unknown module: ${id}`);
      }
      if (typeof v !== "string") throw new AdminValidationError(k, `${k} must be a string`);
      const max = which === "Title" ? MODULE_TITLE_MAX : MODULE_BLURB_MAX;
      const text = v.trim();
      if (text.length > max) throw new AdminValidationError(k, `${k} must be at most ${max} characters`);
      if (CONTROL_CHARS_RE.test(text)) throw new AdminValidationError(k, `${k} must not contain control characters`);
      // Empty clears the override (HDEL) so the registry default comes back —
      // storing "" would render a blank heading instead.
      if (text === "") dels.push(k);
      else fields.push(k, text);
      changed[k] = text as unknown as boolean;
    } else {
      throw new AdminValidationError(k, `unknown setting: ${k}`);
    }
  }

  // Both bounds in this one patch: refused here, before any write. A single
  // bound is checked against the stored other one inside UPDATE_SCRIPT,
  // atomically with the write, so two organizers cannot race past it.
  const patchedStart = changed.scoringStartsAt as unknown;
  const patchedEnd = changed.scoringEndsAt as unknown;
  if (typeof patchedStart === "string" && typeof patchedEnd === "string" && Date.parse(patchedEnd) <= Date.parse(patchedStart)) {
    throw windowRefusal(patchedStart, patchedEnd);
  }
  const at = new Date().toISOString();
  const audit = JSON.stringify({ at, by: actor, changed });
  // A settings write can LOWER a contestant's folded score: the fold counts
  // only the ENABLED modules' points (`withModuleContributions`), so a module
  // switched off takes its points out. So the write sits inside a
  // score-lowering bracket (#553, fold-cache.ts): the shared in-progress
  // marker goes up and the revision bumps BEFORE the eval — a hint charge on
  // any app task is refused meanwhile, and a fold that read the old points
  // finds its revision moved — and the finally closes it AFTER, whether the
  // reply said "refused" or never came: once the eval was sent, the
  // transport cannot tell "wrote nothing" from "wrote, then the reply was
  // lost". Rather than enumerating which keys can shrink a score: admin-only
  // and rare, so an extra fold is nothing; a missed one is a hint bought on
  // points that do not count. `begin` throws if the marker cannot be set,
  // and nothing is written in that state.
  await beginScoreLowering();
  let result: unknown;
  try {
    result = await upstashEval(
      UPDATE_SCRIPT,
      [ADMIN_SETTINGS_KEY, ADMIN_AUDIT_KEY],
      [actor, at, audit, String(AUDIT_CAP - 1), String(dels.length), ...dels, ...fields],
    );
  } finally {
    await endScoreLowering();
  }
  // The script refused a window that could never open, writing nothing.
  if (Array.isArray(result) && result[0] === "__window_refused__") throw windowRefusal(String(result[1]), String(result[2]));
  return decodeSettings(flatToObject(result));
}

// --- master reset ------------------------------------------------------------

// Event-data key prefixes the master reset wipes. Each label is what the audit
// record + API response reports as a cleared count. Deliberately excludes
// ctf:admin:settings (kept), ctf:admin:audit (appended, not cleared), and
// ctf:sync:status (sync owns it). ctf:user:* covers both the team-membership
// hash and ctf:user:<login>:hints; ctf:team:* covers <slug> and <slug>:members.
//
// Quiz scope (spec Q1): wipes contestant PROGRESS (per-login answers/attempts,
// plus the two running-total aggregate hashes and the award-time hash) and deliberately KEEPS
// `ctf:quiz:questions` / `ctf:quiz:key` — those are organizer CONTENT, like
// `ctf:admin:settings`, not something a reset should ever destroy. The
// aggregates (`ctf:quiz:points`/`ctf:quiz:answered`) MUST still be cleared:
// leaving them would show contestants stale quiz points on a freshly reset
// board with no answers behind them. `ctf:quiz:points`/`ctf:quiz:answered`
// are exact key names, not globs, but `scanDelByPrefix`'s SCAN MATCH works
// the same either way.
//
// Classic scope mirrors quiz's exactly, for the same reason (see
// deleteChallenge's doc comment in classic-store.ts for the same contract
// stated from the single-challenge-delete side): wipes contestant PROGRESS —
// per-login solves/attempts, plus the three aggregate hashes
// (`ctf:classic:points`/`ctf:classic:solved`/`ctf:classic:solvecount`) and
// the award-time hash (`ctf:classic:lastAt`) the leaderboard reads — and deliberately KEEPS `ctf:classic:challenges` /
// `ctf:classic:flag` / `ctf:classic:flagnorm` / `ctf:classic:categories`,
// which are organizer CONTENT, not something a reset should ever destroy.
const RESET_PREFIXES: readonly [string, string][] = [
  ["solves", "ctf:solves:*"],
  ["teams", "ctf:team:*"],
  ["users", "ctf:user:*"],
  ["joinCodes", "ctf:joincode:*"],
  ["hints", "ctf:hints:*"],
  ["quizAnswers", `${QUIZ_ANSWERS_PREFIX}*`],
  ["quizAttempts", `${QUIZ_ATTEMPTS_PREFIX}*`],
  ["quizPoints", QUIZ_POINTS_KEY],
  ["quizAnswered", QUIZ_ANSWERED_KEY],
  // The award times go with the totals they order: a reset contestant
  // left with an old time would be ranked by a solve that does not count.
  ["quizLastAt", QUIZ_LAST_AT_KEY],
  ["classicSolves", `${CLASSIC_SOLVES_PREFIX}*`],
  ["classicAttempts", `${CLASSIC_ATTEMPTS_PREFIX}*`],
  ["classicPoints", CLASSIC_POINTS_KEY],
  ["classicSolved", CLASSIC_SOLVED_KEY],
  ["classicSolveCount", CLASSIC_SOLVECOUNT_KEY],
  ["classicLastAt", CLASSIC_LAST_AT_KEY],
  // ai scope mirrors classic's exactly, same PROGRESS/CONTENT split: solves,
  // attempts, the two per-login aggregate hashes, the award-time hash and the
  // per-challenge solvecount are wiped, while `ctf:ai:challenges` / `ctf:ai:flag` /
  // `ctf:ai:flagnorm` / `ctf:ai:hints` / `ctf:ai:signkey` / `ctf:ai:categories`
  // survive for the same reason classic's catalogue does: organizer CONTENT,
  // not something a reset should ever destroy.
  ["aiSolves", `${AI_SOLVES_PREFIX}*`],
  ["aiAttempts", `${AI_ATTEMPTS_PREFIX}*`],
  ["aiPoints", AI_POINTS_KEY],
  ["aiSolved", AI_SOLVED_KEY],
  ["aiSolveCount", AI_SOLVECOUNT_KEY],
  ["aiLastAt", AI_LAST_AT_KEY],
  // The replay-guard nonces are also contestant PROGRESS in the same sense —
  // spent single-use markers from THIS event, not something a fresh one
  // should start carrying.
  ["aiNonces", `${AI_NONCE_PREFIX}*`],
  // Deliberately DOES clear the launch keypair — unlike `clearAiChallenges`
  // (ai-store.ts), which deliberately does NOT, and that contrast is the
  // point. A master reset starts the event over: no live launch token should
  // survive it, so the published public key must rotate and any deployed
  // external verifier has to re-fetch /api/ai/launch-key on its next check.
  // `clearAiChallenges` backs a replace-all archive IMPORT instead — it must
  // NOT rotate the published key, or every deployed integration breaks and
  // every already-issued token is invalidated for a wipe that was only ever
  // meant to replace the challenge list.
  ["aiLaunchKey", AI_LAUNCHKEY_KEY],
  // The activity log is contestant PROGRESS in the same sense as
  // solves — a record of what people did during the event — so a reset wipes
  // it. Leaving it would let a "fresh" event open with last event's sign-ins.
  ["activity", ACTIVITY_LOG_KEY],
  // Sponsors are the one exception to the CONTENT/PROGRESS split every other
  // entry above follows: unlike a challenge's flag/description, a sponsor
  // configuration is scoped to ONE event run (sponsors funded last year's
  // event are not implicitly this year's), and there is no `enabled` flag to
  // turn them off with instead — deleting IS the off switch (see the sponsors
  // ADR in docs/decisions.md). So a master reset wipes both hashes outright.
  ["sponsors", SPONSORS_KEY],
  ["sponsorsLogo", SPONSORS_LOGO_KEY],
];

// SCAN (never KEYS — non-blocking) a prefix and DEL matches in batches until the
// cursor wraps. Returns how many keys were removed.
async function scanDelByPrefix(pattern: string): Promise<number> {
  let cursor = "0";
  let total = 0;
  do {
    const [scan] = await upstashPipeline([["SCAN", cursor, "MATCH", pattern, "COUNT", 1000]]);
    // Throws on a failed page rather than ending the walk. This
    // one is the reset: a walk that stops early would still report a COUNT
    // — "cleared 412 keys" — for a sweep that never finished, so an
    // organizer opening a "fresh" event would find last event's solves in
    // it with nothing having reported a problem. Failing loudly is the only
    // honest answer. The deletions already made stand, and re-running the
    // reset is safe: deleting an absent key is a no-op.
    const [next, keys] = parseScanPage(scan, `reset ${pattern}`);
    cursor = next;
    if (keys.length > 0) {
      // The DEL is checked too: `total` is incremented from `keys.length`, so
      // an unchecked failure here reports keys as cleared that are still
      // there — a false "done", one command later.
      assertPipelineOk(await upstashPipeline([["DEL", ...keys]]), `reset ${pattern}`);
      total += keys.length;
    }
  } while (cursor !== "0");
  return total;
}

// Freeze scoring, bump the reset epoch (sync reads `resetAt` and clears its
// cursor when it advances — the poll-mode re-ingest fix), RELOCK the event
// (clear the scoring start — a reset event is not launched until an
// organizer launches it again), and append the audit record. One atomic script
// so a reset can never land without its audit line. Exported for the live
// suite only.
// ARGV: [1]=actor [2]=at [3]=resetAt [4]=auditLine [5]=cap-1
export const RESET_SCRIPT = `
redis.call('HSET', KEYS[1], 'paused', '1', 'resetAt', ARGV[3], 'updatedBy', ARGV[1], 'updatedAt', ARGV[2])
redis.call('HDEL', KEYS[1], 'scoringStartsAt')
redis.call('LPUSH', KEYS[2], ARGV[4])
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[5]))`;

/**
 * Master reset: wipe all event data (solves, teams, users, join codes, hints),
 * freeze scoring, bump the sync reset epoch, and audit it. Keeps admin
 * settings. Server-only — callers gate on requireAdmin.
 *
 * Poll-mode note: freezing + the `resetAt` epoch (honoured by sync, which drops
 * its cursor) is what makes the wipe stick; a later unfreeze re-ingests from
 * live PR comments, so a post-event wipe also needs those comments gone.
 */
export async function resetEvent(actor: string): Promise<{ cleared: Record<string, number>; resetAt: string }> {
  const cleared: Record<string, number> = {};
  // Score-lowering bracket (#553, fold-cache.ts): BEFORE the first delete,
  // raise the shared in-progress marker and bump the revision — a hint
  // charge on any app task is refused until the wipe ends, however long it
  // takes, and a fold that read the old points finds its revision moved. It
  // THROWS if the marker cannot be set, and nothing is deleted in that
  // state. The finally closes it AFTER the last write — or after a prefix
  // or the freeze/audit eval threw with earlier deletes standing
  // (`scanDelByPrefix` does not undo).
  await beginScoreLowering();
  try {
    for (const [label, pattern] of RESET_PREFIXES) {
      cleared[label] = await scanDelByPrefix(pattern);
    }
    const at = new Date().toISOString();
    const resetAt = String(Date.now());
    const audit = JSON.stringify({ at, by: actor, action: "reset", cleared });
    await upstashEval(
      RESET_SCRIPT,
      [ADMIN_SETTINGS_KEY, ADMIN_AUDIT_KEY],
      [actor, at, resetAt, audit, String(AUDIT_CAP - 1)],
    );
    return { cleared, resetAt };
  } finally {
    await endScoreLowering();
  }
}

// --- demo seed / clear (admin-gated dangerous settings) ---------------------
//
// The body lives in lib/demo-seed.ts (#504 M9) — it was 43% of this file and
// shares no state with the settings/admin code around it. It reads this
// module's settings snapshot, so it cannot be imported back here; the read
// stays below and the snapshot goes over with the actor. `clearDemoData`
// reads no settings, so it is re-exported as-is.
export { SEED_CATEGORIES_SCRIPT, clearDemoData } from "@/lib/demo-seed";
import { runDemoSeed } from "@/lib/demo-seed";

/** See lib/demo-seed.ts for the seed itself; this wrapper exists only to do
 *  the settings read this module owns. */
export async function seedDemoData(
  actor: string,
): Promise<{ contestants: number; teams: number; solves: number; sponsors: number }> {
  return runDemoSeed(await getAdminSettings(), actor);
}


// --- runtime admins ----------------------------------------------------------

// The key, the login pattern and the READ live in admin-admins.ts so the
// authorization path can import them without pulling in this module and the
// module registry behind it. Re-exported here so callers that already talk to
// the admin store keep one import.
export { ADMIN_ADMINS_KEY, listStoredAdmins } from "@/lib/admin-admins";

// SADD/SREM plus one audit line, in a single script, so a grant can never
// land without its record — the same guarantee updateAdminSettings gives.
const ADMINS_SCRIPT = `
if ARGV[1] == 'add' then redis.call('SADD', KEYS[1], ARGV[2])
else redis.call('SREM', KEYS[1], ARGV[2]) end
redis.call('LPUSH', KEYS[2], ARGV[3])
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[4]))
return redis.call('SMEMBERS', KEYS[1])`;

async function mutateAdmins(action: "add" | "remove", login: string, actor: string): Promise<string[]> {
  const normalized = login.trim().toLowerCase();
  if (!normalized) throw new AdminValidationError("login", "login is required");
  if (!LOGIN_RE.test(normalized)) {
    throw new AdminValidationError("login", `'${login}' is not a GitHub login`);
  }
  const at = new Date().toISOString();
  const audit = JSON.stringify({ at, by: actor, action: `admin:${action}`, login: normalized });
  const res = await upstashEval(
    ADMINS_SCRIPT,
    [ADMIN_ADMINS_KEY, ADMIN_AUDIT_KEY],
    [action, normalized, audit, String(AUDIT_CAP - 1)],
  );
  const arr = Array.isArray(res) ? (res as string[]) : [];
  return arr.map((a) => String(a).toLowerCase()).sort();
}

/** Grant admin to `login` at runtime. Idempotent (SADD). */
export async function addStoredAdmin(login: string, actor: string): Promise<string[]> {
  return mutateAdmins("add", login, actor);
}

/** Revoke a RUNTIME grant. Cannot touch a baked admin — the route refuses
 *  that before calling here, because a baked login is the lockout recovery
 *  path and must survive any mistake made through the panel. */
export async function removeStoredAdmin(login: string, actor: string): Promise<string[]> {
  return mutateAdmins("remove", login, actor);
}
