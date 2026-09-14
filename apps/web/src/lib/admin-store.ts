import "server-only";
import { createHash } from "node:crypto";
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
// `defaultEnabledModules`, not `defaultModuleIds` from `@/lib/enabled-modules`:
// that module imports `getAdminSettings` from this one, so importing it back
// here would be a cycle. `module-defaults.ts` is the pure, dependency-free
// source both sides compute the same default from; admin-store is
// `server-only`, so calling it with `process.env` here is safe.
import { defaultEnabledModules, secureDevAvailable } from "@/lib/module-defaults";
import {
  DEMO_CONTESTANTS,
  DEMO_TEAMS,
  DEMO_QUESTIONS,
  DEMO_QUIZ_ANSWERS,
  DEMO_CHALLENGES,
  DEMO_CLASSIC_CATEGORIES,
  DEMO_CLASSIC_SOLVES,
  DEMO_AI_CHALLENGES,
  DEMO_AI_CATEGORIES,
  DEMO_AI_SOLVES,
  DEMO_SPONSORS,
} from "@/lib/demo-fixture";
import {
  QUIZ_QUESTIONS_KEY,
  QUIZ_KEY_KEY,
  QUIZ_POINTS_KEY,
  QUIZ_ANSWERED_KEY,
  QUIZ_ANSWERS_PREFIX,
  QUIZ_ATTEMPTS_PREFIX,
  quizAnswersKey,
  quizAttemptsKey,
  canonicalizeChoices,
} from "@/lib/quiz-keys";
import {
  CLASSIC_CHALLENGES_KEY,
  CLASSIC_FLAG_KEY,
  CLASSIC_FLAGNORM_KEY,
  CLASSIC_CATEGORIES_KEY,
  CLASSIC_CATEGORIES_MAX,
  CLASSIC_POINTS_KEY,
  CLASSIC_SOLVED_KEY,
  CLASSIC_SOLVECOUNT_KEY,
  CLASSIC_SOLVES_PREFIX,
  CLASSIC_ATTEMPTS_PREFIX,
  classicSolvesKey,
  classicAttemptsKey,
  normalizeFlag,
} from "@/lib/classic-keys";
import {
  AI_CHALLENGES_KEY,
  AI_FLAG_KEY,
  AI_FLAGNORM_KEY,
  AI_CATEGORIES_KEY,
  AI_CATEGORIES_MAX,
  AI_SIGNKEY_KEY,
  AI_HINTS_KEY,
  AI_POINTS_KEY,
  AI_SOLVED_KEY,
  AI_SOLVECOUNT_KEY,
  AI_SOLVES_PREFIX,
  AI_ATTEMPTS_PREFIX,
  AI_NONCE_PREFIX,
  AI_LAUNCHKEY_KEY,
  aiSolvesKey,
  aiAttemptsKey,
  flagComparisonForm,
} from "@/lib/ai-keys";
import { ACTIVITY_LOG_KEY } from "@/lib/activity-keys";
import { SPONSORS_KEY, SPONSORS_LOGO_KEY } from "@/lib/sponsors-keys";

export const ADMIN_SETTINGS_KEY = "ctf:admin:settings";
export const ADMIN_AUDIT_KEY = "ctf:admin:audit";
export const SYNC_STATUS_KEY = "ctf:sync:status";
export const AUDIT_CAP = 500;
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
 *  by every `admin/*` route that writes secrets (a flag, a signing key) so
 *  each one does not keep its own byte-identical copy.
 *
 *  Never the caught value itself: a driver can decorate an error with the
 *  request it failed on, and an admin write's arguments can include a flag
 *  or a signing key, so a bare `console.error(err)` could turn an outage into
 *  a secret in the log. Name and message, both capped, nothing else. */
export function adminErrorLabel(err: unknown): string {
  if (!(err instanceof Error)) return "non-Error throw";
  return `${err.name}: ${err.message}`.slice(0, 200);
}

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
// with. (The first two used to be re-exported "for server callers"; no
// server caller ever took them from here.)
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
  // Scheduled "auto dates" — nullable ISO instants. Absent = no bound.
  // scoring* gates the freeze (before start / after end = paused); registration*
  // gates team create/join. Enforced at READ time (no scheduler on the box):
  // see effectivePaused / effectiveRegistrationOpen, mirrored in the scorer
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
  /** The modules this event actually serves (issue #386). Three states:
   *  - absent (`null`) — nothing stored, the deployment default applies
   *    (`defaultEnabledModules`: secure-development alone when a scorer
   *    image is configured, otherwise nothing).
   *  - `[]` — the organizer explicitly switched every module off.
   *  - a list — those ids, with any the registry no longer knows dropped;
   *    if that drop empties the list, it decodes back to `null` (a stale
   *    field is not a decision to show nothing). */
  enabledModuleIds: ModuleId[] | null;
  /** The organizer's event identity fields (issue #386) — only the fields
   *  actually stored; `resolveSite()` in lib/site.ts lays them over the
   *  defaults. Absent field = default. */
  eventIdentity: EventIdentityOverrides;
  /** Which of the six secure-development targets this event runs (issue
   *  #386, PR 2), read by `lib/enabled-apps.ts` per request. `null` means
   *  nothing stored (or the stored value decoded to nothing survivable) —
   *  the deployment default (`DEFAULT_SECURE_DEV_TARGETS`, all six) applies.
   *  Unlike `enabledModuleIds`, there is no explicit-empty state: emptying
   *  every target would leave the secure-development board live with
   *  nothing to show, so `normalizeSecureDevTargets` treats a stored empty
   *  (or all-unknown) list the same as absent. */
  secureDevTargets: AppId[] | null;
};

// The window check itself lives in schedule-window.ts (a dependency-free
// leaf) so the /admin Event tab — a Client Component that cannot import this
// server-only module — renders its "right now" readout from the SAME
// implementation instead of a fourth copy of the three-reader contract.
// Re-exported here so every existing caller and test is untouched.
import { outsideWindow } from "@/lib/schedule-window";
export { outsideWindow };

/** Effective scoring freeze: the manual toggle OR the scheduled window. */
export function effectivePaused(s: AdminSettings, nowMs: number = Date.now()): boolean {
  return s.paused || outsideWindow(nowMs, s.scoringStartsAt, s.scoringEndsAt);
}

/** Effective registration state: the manual toggle AND inside the window. */
export function effectiveRegistrationOpen(s: AdminSettings, nowMs: number = Date.now()): boolean {
  return s.teamRegistrationOpen && !outsideWindow(nowMs, s.registrationStartsAt, s.registrationEndsAt);
}

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
  /** The modules this event serves. Replaces the set wholesale (issue #175);
   *  see updateAdminSettings for the two things it refuses. */
  enabledModules?: ModuleId[];
  // ISO instant to set the bound, or null/"" to clear it.
  scoringStartsAt?: string | null;
  scoringEndsAt?: string | null;
  registrationStartsAt?: string | null;
  registrationEndsAt?: string | null;
  /** Event identity (issue #386). "" clears the field back to its default,
   *  the same contract as `moduleTitle:<id>`. */
  eventName?: string;
  eventTheme?: string;
  eventLocation?: string;
  eventContact?: string;
  eventDiscord?: string;
  /** Which of the six secure-development targets this event runs (issue
   *  #386, PR 2). Replaces the whole set, like `enabledModules`; never
   *  clears — see updateAdminSettings for why there is no empty state. */
  secureDevTargets?: string[];
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
    // Filtered against the REGISTRY, not against what event.yaml baked in.
    // It used to drop overrides for anything outside the baked set, which was
    // right while enablement was a build-time fact and wrong the moment it
    // became a runtime one (issue #175): an organizer who enables classic and
    // renames it would have had the rename silently dropped on every read.
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
  };
}

/** Decodes the runtime enablement set.
 *
 *  - absent            → null: nothing stored, the deployment default applies
 *  - ""                → []:   the organizer switched every module off (#386)
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

export async function getAdminSettings(): Promise<AdminSettings> {
  const [res] = await upstashPipeline([["HGETALL", ADMIN_SETTINGS_KEY]]);
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
redis.call('HSET', KEYS[1], 'updatedBy', ARGV[1], 'updatedAt', ARGV[2])
for i = 1, numDels do redis.call('HDEL', KEYS[1], ARGV[5 + i]) end
for i = 6 + numDels, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1]) end
redis.call('LPUSH', KEYS[2], ARGV[3])
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[4]))
return redis.call('HGETALL', KEYS[1])`;

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
    } else if ((SCHEDULE_FIELDS as readonly string[]).includes(k)) {
      // Nullable ISO bound: null/"" clears it (HDEL); a value must parse as a
      // date and is stored normalised to its ISO-8601 UTC form.
      if (v === null || v === "") {
        dels.push(k);
        changed[k] = null as unknown as boolean;
      } else {
        if (typeof v !== "string") throw new AdminValidationError(k, `${k} must be an ISO date string or null`);
        const ms = Date.parse(v);
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

      // The one refusal left (issue #386): Secure Development needs the scorer
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
      // genuinely new enable it refuses (as before); on a carry-forward it
      // STRIPS the id from what gets written instead of passing it through.
      // A concurrent SD-disable landing between this read and our write can
      // therefore at worst turn a strip into a refusal (the stale read still
      // sees it "stored", so this write silently drops it same as before) —
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
      // Event identity (issue #386). Validation lives in event-identity.ts so
      // the Event tab can share the limits; "" clears (HDEL) — the default is
      // what blank restores, exactly like a module title override.
      //
      // The audit line never carries the value itself, only a redacted
      // marker (CodeRabbit round 2): eventDiscord can embed an invite/join
      // token in its URL, and eventContact is PII — recording either verbatim
      // in an admin-visible log persists a secret/PII where "who changed
      // what" only needs the field name. All five identity keys use the same
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
      // Which of the six secure-development targets this event runs (issue
      // #386, PR 2). Replaces the whole set, like `enabledModules` — an
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
  const at = new Date().toISOString();
  const audit = JSON.stringify({ at, by: actor, changed });
  const result = await upstashEval(
    UPDATE_SCRIPT,
    [ADMIN_SETTINGS_KEY, ADMIN_AUDIT_KEY],
    [actor, at, audit, String(AUDIT_CAP - 1), String(dels.length), ...dels, ...fields],
  );
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
// plus the two running-total aggregate hashes) and deliberately KEEPS
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
// (`ctf:classic:points`/`ctf:classic:solved`/`ctf:classic:solvecount`) the
// leaderboard reads — and deliberately KEEPS `ctf:classic:challenges` /
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
  ["classicSolves", `${CLASSIC_SOLVES_PREFIX}*`],
  ["classicAttempts", `${CLASSIC_ATTEMPTS_PREFIX}*`],
  ["classicPoints", CLASSIC_POINTS_KEY],
  ["classicSolved", CLASSIC_SOLVED_KEY],
  ["classicSolveCount", CLASSIC_SOLVECOUNT_KEY],
  // ai scope mirrors classic's exactly, same PROGRESS/CONTENT split: solves,
  // attempts, the two per-login aggregate hashes and the per-challenge
  // solvecount are wiped, while `ctf:ai:challenges` / `ctf:ai:flag` /
  // `ctf:ai:flagnorm` / `ctf:ai:hints` / `ctf:ai:signkey` / `ctf:ai:categories`
  // survive for the same reason classic's catalogue does: organizer CONTENT,
  // not something a reset should ever destroy.
  ["aiSolves", `${AI_SOLVES_PREFIX}*`],
  ["aiAttempts", `${AI_ATTEMPTS_PREFIX}*`],
  ["aiPoints", AI_POINTS_KEY],
  ["aiSolved", AI_SOLVED_KEY],
  ["aiSolveCount", AI_SOLVECOUNT_KEY],
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
  // The activity log (issue #212) is contestant PROGRESS in the same sense as
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
    // Throws on a failed page rather than ending the walk (issue #358). This
    // one is the reset: the old fallback still returned a COUNT — "cleared 412
    // keys" — for a sweep that had stopped early, so an organizer opening a
    // "fresh" event would find last event's solves in it with nothing having
    // reported a problem. Failing loudly is the only honest answer. The
    // deletions already made stand, and re-running the reset is safe: deleting
    // an absent key is a no-op.
    const [next, keys] = parseScanPage(scan, `reset ${pattern}`);
    cursor = next;
    if (keys.length > 0) {
      // The DEL is checked too: `total` is incremented from `keys.length`, so
      // an unchecked failure here reports keys as cleared that are still
      // there — the same false "done" the SCAN fallback gave, one command
      // later (issue #358).
      assertPipelineOk(await upstashPipeline([["DEL", ...keys]]), `reset ${pattern}`);
      total += keys.length;
    }
  } while (cursor !== "0");
  return total;
}

// Freeze scoring, bump the reset epoch (sync reads `resetAt` and clears its
// cursor when it advances — the poll-mode re-ingest fix), and append the audit
// record. One atomic script so a reset can never land without its audit line.
// ARGV: [1]=actor [2]=at [3]=resetAt [4]=auditLine [5]=cap-1
const RESET_SCRIPT = `
redis.call('HSET', KEYS[1], 'paused', '1', 'resetAt', ARGV[3], 'updatedBy', ARGV[1], 'updatedAt', ARGV[2])
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
}

// --- demo seed (DEMO_MODE only) ----------------------------------------------

/**
 * One attempt row in the shape quiz-store's and classic-store's live attempt
 * scripts write: `{attempts, firstAt, lastAt, lastAtMs}`.
 *
 * The seed banks earned rows directly instead of replaying a submission, so
 * without this it produced an event in which nobody had ever *tried* anything:
 * the Insights tab showed a 100% solve rate, "1.0" average tries and a blank
 * median time on every single challenge. That is the same class of gap as the
 * membership timestamps the seed used to skip (ADR 49) — a fixture that
 * bypasses the live write path also bypasses the telemetry that path records,
 * and the first event a new organizer looks at is a seeded one.
 *
 * `firstAt` is derived BACKWARDS from the known earn time, so the ordering the
 * metrics fold guards against (an item earned before its own first attempt)
 * cannot arise here. Deriving a start time forwards could overshoot the earn
 * time and be silently dropped from the median instead of failing loudly.
 *
 * Every row gets a nonzero head start, INCLUDING a one-try row. Deriving
 * `firstAt` from the gaps between tries alone means a first-try solve has
 * `firstAt === lastAt`, and the Insights tab duly reported a median
 * time-to-solve of **0s** — nobody has ever solved anything in zero seconds.
 * A first try is not the moment the contestant met the challenge; the reading
 * came first. So the head start is the time spent before the first submission,
 * and the per-try gaps stack on top of it.
 */
const DEMO_FIRST_TRY_MINUTES = 3;

function demoAttemptRow(tries: number, earnedAt: string, gapMinutes: number, floorMs?: number): string {
  const lastAtMs = Date.parse(earnedAt);
  const elapsedMinutes = DEMO_FIRST_TRY_MINUTES + (tries - 1) * gapMinutes;
  // Clamped to the seed window's start (the scoring open, when scheduled):
  // an earnedAt just inside the window minus a retry gap otherwise lands a
  // first attempt BEFORE scoring opened — the exact contradiction the window
  // clamp exists to prevent.
  const firstAtMs = Math.max(lastAtMs - elapsedMinutes * 60_000, floorMs ?? Number.NEGATIVE_INFINITY);
  const firstAt = new Date(firstAtMs).toISOString();
  return JSON.stringify({ attempts: tries, firstAt, lastAt: earnedAt, lastAtMs });
}

// Per-challenge solver counts are RAISED, never set.
//
// Every other figure the seed writes is keyed by LOGIN, and the fixture owns
// those logins outright — an absolute HSET is what keeps a re-seed idempotent
// instead of doubling totals. `solvecount` is the exception: it is keyed by
// CHALLENGE and counts distinct solvers across everyone, so the fixture's
// number is a floor, not the truth. Writing it absolutely rewrote a real
// contestant's solve out of the public count on every re-seed — silently, since
// their own per-login row survived and still said "Solved" (issue #335).
//
// One EVAL rather than read-then-write so the raise is atomic: a solve landing
// mid-seed is counted, not lost to a stale read.
const RAISE_SOLVECOUNT_SCRIPT = `
local i = 1
while i <= #ARGV do
  local field, floor = ARGV[i], tonumber(ARGV[i + 1])
  local current = tonumber(redis.call('HGET', KEYS[1], field) or '0') or 0
  if current < floor then redis.call('HSET', KEYS[1], field, floor) end
  i = i + 2
end
return 1
`;

// Category lists are UNIONED, never replaced — for the same reason
// `solvecount` above is raised rather than set: the fixture's value is a
// floor, not the truth.
//
// The seed used to `SET` both lists to the demo fixture's, which deleted every
// category an organizer had authored. Their challenges survived (they are
// written per-field, keyed by id) and the admin panel kept listing them, but
// the contestant board renders only categories present in the list, so three
// authored AI challenges and 850 points of content silently left the board
// while "1 category · 5 challenges" read like a healthy setup (issue #344).
// Master reset is no way back: it deliberately preserves authored categories,
// so the list it preserves is the seeded one.
//
// ONE SCRIPT, not read-then-write. Upstash's `/pipeline` is not transactional,
// so a GET here and a SET later leaves a window in which an organizer's own
// category edit is read, ignored and overwritten. Worse, the fixture's
// challenge rows have to name a category the list actually holds, so a rename
// landing inside that window would orphan every row this seed just wrote —
// exactly the failure #344 is about. Both halves therefore happen inside the
// same EVAL, which Redis runs atomically: the union is computed against the
// list as it is at that instant, and the challenge records are written under
// whichever spelling that union kept.
//
// Membership is case-INSENSITIVE, mirroring `setCategories` and classic's
// `importBundle`: "AI" and "ai" as two headings is never what anyone meant,
// and the board's filter is exact equality, so two casings would also split
// challenges across them. The stored order is kept verbatim — it is the order
// the board renders headings in — and unseen fixture names are appended.
export const SEED_CATEGORIES_SCRIPT = `
local stored = {}
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then
    for _, name in ipairs(decoded) do
      if type(name) == 'string' then stored[#stored + 1] = name end
    end
  end
end

-- The union, and the fold -> surviving-spelling map the rows below are
-- rewritten through. Existing spellings win: renaming the organizer's "ai" to
-- the fixture's "AI" would hide THEIR challenges instead of ours.
local canon = {}
local union = {}
for _, name in ipairs(stored) do
  local fold = string.lower(name)
  if canon[fold] == nil then
    canon[fold] = name
    union[#union + 1] = name
  end
end
for _, name in ipairs(cjson.decode(ARGV[1])) do
  local fold = string.lower(name)
  if canon[fold] == nil then
    canon[fold] = name
    union[#union + 1] = name
  end
end

-- Refuse rather than trim, BEFORE anything is written. Dropping the overflow
-- would orphan the fixture rows naming those categories, which is issue #344
-- from the other side; storing a list over the cap would make every later
-- category edit fail validation.
local max = tonumber(ARGV[2])
if #union > max then
  return redis.error_reply('seed would take the category list to ' .. #union .. ', over the limit of ' .. max)
end

-- cjson encodes an empty Lua table as an object, and this value is parsed as
-- an array everywhere it is read.
if #union == 0 then
  redis.call('SET', KEYS[1], '[]')
else
  redis.call('SET', KEYS[1], cjson.encode(union))
end

local written = 0
for i = 3, #ARGV do
  local record = cjson.decode(ARGV[i])
  local kept = canon[string.lower(record['category'])]
  if kept ~= nil then record['category'] = kept end
  redis.call('HSET', KEYS[2], record['id'], cjson.encode(record))
  written = written + 1
end
return written
`;

/** Queues one module's category union and the challenge records that depend on
 *  it. The records arrive already built FIELD BY FIELD by the caller — never a
 *  spread of the fixture object, which carries the flag beside them — and the
 *  script rewrites only their `category`. */
function seedCategoriesAndChallenges(
  cmds: (string | number)[][],
  categoriesKey: string,
  challengesKey: string,
  fixtureCategories: readonly string[],
  max: number,
  records: readonly { id: string; category: string }[],
): void {
  cmds.push([
    "EVAL",
    SEED_CATEGORIES_SCRIPT,
    2,
    categoriesKey,
    challengesKey,
    JSON.stringify(fixtureCategories),
    max,
    ...records.map((record) => JSON.stringify(record)),
  ]);
}

/** Queues the raise for one module's solvecount hash, or nothing when the
 *  fixture seeded no solves for it. */
function raiseSolveCounts(cmds: (string | number)[][], key: string, counts: Map<string, number>): void {
  if (counts.size === 0) return;
  const argv: (string | number)[] = [];
  for (const [challengeId, count] of counts) argv.push(challengeId, count);
  cmds.push(["EVAL", RAISE_SOLVECOUNT_SCRIPT, 1, key, ...argv]);
}

/**
 * Populate a demo leaderboard from the bundled fixture: real challenge-id solves
 * (so the scorer awards points), spread over the last ~6h for a rising
 * score-over-time graph, plus a few teams. When the quiz module is enabled,
 * also seeds a small demo question bank and a spread of correct answers
 * across the same contestants (timestamped inside the same ~6h window) so
 * DEMO_MODE shows a genuinely combined two-module leaderboard. Additive —
 * does not clear first. Gated by the route on DEMO_MODE + requireAdmin;
 * never a production path.
 */
export async function seedDemoData(
  actor: string,
): Promise<{ contestants: number; teams: number; solves: number; sponsors: number }> {
  const now = Date.now();
  const windowMs = 6 * 60 * 60 * 1000;

  const cmds: (string | number)[][] = [];
  // The seed window: the last ~6h, CLAMPED to the scoring schedule when one
  // is set — a fixture stamped before "scoring opens" puts a full race on the
  // chart dated before the phase line says scoring existed, on exactly the
  // demo an organizer inspects first. The window ends at now (or the scoring
  // close, if that already passed) and starts no earlier than the scoring
  // open. A schedule entirely in the future has no valid past instant to
  // clamp to, so it falls back to the unclamped window — future-dated solves
  // would be a worse lie than a mistimed one.
  // Fail closed: this read now also decides WHICH modules get demo rows
  // (issue #386), so it gates a write. A settings blip must abort the seed,
  // not fall back to seeding every module's data regardless of what the
  // organizer actually enabled — let getAdminSettings() throw and propagate.
  const settings = await getAdminSettings();
  // The live module set, same read: which of quiz/classic/ai to seed demo
  // data for must follow what this event is actually serving (issue #386),
  // not what happened to be baked at build time.
  const live = new Set(settings.enabledModuleIds ?? defaultEnabledModules(process.env));
  // Secure Development demo data — only when the module is live, same gate
  // reasoning as quiz/classic/ai below: a deployment with no scorer image
  // (or one that switched the board off) must get a seed byte-for-byte
  // identical to having no secure-development data at all, not solve rows
  // for a board that isn't running.
  const secureDevLive = live.has("secure-development");
  let total = 0;
  if (secureDevLive) {
    for (const c of DEMO_CONTESTANTS) for (const ids of Object.values(c.solves)) total += ids.length;
  }
  const scoringStartMs = settings.scoringStartsAt ? Date.parse(settings.scoringStartsAt) : NaN;
  const scoringEndMs = settings.scoringEndsAt ? Date.parse(settings.scoringEndsAt) : NaN;
  let end = Number.isFinite(scoringEndMs) ? Math.min(now, scoringEndMs) : now;
  let base = Math.max(end - windowMs, Number.isFinite(scoringStartMs) ? scoringStartMs : end - windowMs);
  if (!(base < end)) {
    base = now - windowMs;
    end = now;
  }
  const spanMs = end - base;
  const n = DEMO_CONTESTANTS.length;
  // Spread EACH contestant's solves across the whole window (not a per-contestant
  // block), so every line rises throughout and they interleave. A per-contestant
  // sub-slot phase ((ci+0.5)/n) staggers otherwise-identical tick times so lines
  // don't land exactly on top of each other.
  if (secureDevLive) {
    DEMO_CONTESTANTS.forEach((c, ci) => {
      const kc = Object.values(c.solves).reduce((m, ids) => m + ids.length, 0);
      let j = 0;
      for (const [target, ids] of Object.entries(c.solves)) {
        for (const id of ids) {
          const frac = kc > 0 ? (j + (ci + 0.5) / n) / kc : 0.5;
          const ts = new Date(base + Math.min(0.999, frac) * spanMs).toISOString();
          cmds.push(["HSET", `ctf:solves:${target}`, `${c.login}:${id}`, ts]);
          j++;
        }
      }
    });
  }
  const createdAt = new Date(base).toISOString();
  for (const t of DEMO_TEAMS) {
    cmds.push(["HSET", `ctf:team:${t.slug}`, "name", t.name, "captain", t.captain, "createdAt", createdAt, "joinCode", t.slug.slice(0, 6)]);
    if (t.members.length > 0) cmds.push(["SADD", `ctf:team:${t.slug}:members`, ...t.members]);
    // The membership timestamps too, not just the pointer. Seeding writes the
    // user hash directly rather than going through createTeam/joinTeam, so it
    // is the one path that can produce a member with no `joinedAt` and no
    // `firstTeamAt` — which made the Insights funnel report "ever on a team:
    // 0" beside "on a team: 6" on exactly the event a new organizer looks at
    // first (issue #169 / ADR 49).
    for (const m of t.members) {
      cmds.push([
        "HSET",
        `ctf:user:${m}`,
        "team",
        t.slug,
        "joinedAt",
        createdAt,
        "firstTeamAt",
        createdAt,
      ]);
    }
  }

  // Quiz demo data — only when the module is enabled, so a disabled quiz
  // module leaves the seed byte-for-byte identical to pre-quiz behavior.
  const quizEnabled = live.has("quiz");
  let quizAnswersSeeded = 0;
  if (quizEnabled) {
    // Write the public question + its correct-answer key with the SAME
    // shared `canonicalizeChoices` recipe quiz-store's upsertQuestion uses
    // (dedupe then sort into a JSON array) — GRADE_SCRIPT string-compares a
    // submission's canonicalized array against this key byte-for-byte, so
    // any other shape here would silently make every demo question
    // ungradeable.
    for (const { correct, ...question } of DEMO_QUESTIONS) {
      cmds.push(["HSET", QUIZ_QUESTIONS_KEY, question.id, JSON.stringify(question)]);
      cmds.push(["HSET", QUIZ_KEY_KEY, question.id, JSON.stringify(canonicalizeChoices(correct))]);
    }

    const questionsById = new Map(DEMO_QUESTIONS.map((q) => [q.id, q]));
    const aggregates = new Map<string, { points: number; answered: number }>();
    const nAnswers = DEMO_QUIZ_ANSWERS.length;
    DEMO_QUIZ_ANSWERS.forEach(({ login, questionId }, i) => {
      const q = questionsById.get(questionId);
      if (!q) return; // fixture-consistency guard; should never trigger
      const frac = nAnswers > 0 ? (i + 0.5) / nAnswers : 0.5;
      const at = new Date(base + Math.min(0.999, frac) * spanMs).toISOString();
      // Same shared recipe as the key above: a demo answer's banked
      // `choices` is always the question's full correct set (it's recorded
      // as correct), stored the same way GRADE_SCRIPT stores a live one.
      const choices = canonicalizeChoices(q.correct);
      cmds.push(["HSET", quizAnswersKey(login), questionId, JSON.stringify({ choices, points: q.points, at })]);
      // The tries it took, so "avg tries" and "median time" have something to
      // average. Counts and gaps cycle off the index rather than being random:
      // a seed that produced different numbers on each run would make the
      // Insights tab impossible to screenshot or assert against.
      cmds.push([
        "HSET",
        quizAttemptsKey(login),
        questionId,
        demoAttemptRow(1 + (i % 3), at, 3 + (i % 7), base),
      ]);

      const agg = aggregates.get(login) ?? { points: 0, answered: 0 };
      agg.points += q.points;
      agg.answered += 1;
      aggregates.set(login, agg);
      quizAnswersSeeded++;
    });
    // Attempts that never became answers. Without them every question sits at
    // a 100% solve rate, which reads as "this quiz was too easy" when what it
    // actually means is "nobody who failed was ever recorded". One missed
    // question per contestant who has one, chosen deterministically.
    const answeredBy = new Map<string, Set<string>>();
    for (const { login, questionId } of DEMO_QUIZ_ANSWERS) {
      const set = answeredBy.get(login) ?? new Set<string>();
      set.add(questionId);
      answeredBy.set(login, set);
    }
    DEMO_CONTESTANTS.forEach((c, ci) => {
      const answered = answeredBy.get(c.login) ?? new Set<string>();
      const missed = DEMO_QUESTIONS.find((q) => !answered.has(q.id));
      if (!missed) return;
      const at = new Date(base + Math.min(0.999, (ci + 0.5) / n) * spanMs).toISOString();
      cmds.push(["HSET", quizAttemptsKey(c.login), missed.id, demoAttemptRow(1 + (ci % 2), at, 5 + (ci % 4), base)]);
    });

    // Aggregates are written as the final absolute total (not HINCRBY'd),
    // unlike GRADE_SCRIPT's live increments — the fixture already knows each
    // login's final total, and an absolute HSET keeps re-running the seed
    // idempotent instead of doubling the totals on a second seed.
    for (const [login, agg] of aggregates) {
      cmds.push(["HSET", QUIZ_POINTS_KEY, login, agg.points]);
      cmds.push(["HSET", QUIZ_ANSWERED_KEY, login, agg.answered]);
    }
  }

  // Classic demo data — only when the module is enabled, so a disabled
  // classic module leaves the seed byte-for-byte identical to pre-classic
  // behavior (same reasoning as the quiz gate above).
  const classicEnabled = live.has("classic");
  let classicSolvesSeeded = 0;
  if (classicEnabled) {
    // Public challenge record ONLY — built field by field from `Challenge`'s
    // own shape, never by spreading the fixture object, so the flag (which
    // lives alongside it on the fixture) has no path into
    // ctf:classic:challenges. The authored flag and its normalized form are
    // written into their own separate hashes in the SAME pipeline, exactly
    // as upsertChallenge does — normalizeFlag is the ONLY thing allowed to
    // produce ctf:classic:flagnorm's value; a hand-rolled lowercase here
    // would silently desync from what submitFlag compares against.
    const classicRecords = DEMO_CHALLENGES.map((dc) => ({
      id: dc.id,
      title: dc.title,
      // The fixture's spelling; the script rewrites it to whichever the union
      // kept, which is identical on a board that had no such category and
      // differs only on one that spells it its own way.
      category: dc.category,
      description: dc.description,
      points: dc.points,
      order: dc.order,
    }));
    // The records and the category list they depend on go in together — see
    // SEED_CATEGORIES_SCRIPT for why they cannot be a read and a later write.
    seedCategoriesAndChallenges(
      cmds,
      CLASSIC_CATEGORIES_KEY,
      CLASSIC_CHALLENGES_KEY,
      DEMO_CLASSIC_CATEGORIES,
      CLASSIC_CATEGORIES_MAX,
      classicRecords,
    );
    for (const dc of DEMO_CHALLENGES) {
      cmds.push(["HSET", CLASSIC_FLAG_KEY, dc.id, dc.flag]);
      cmds.push(["HSET", CLASSIC_FLAGNORM_KEY, dc.id, normalizeFlag(dc.flag)]);
    }

    const challengesById = new Map(DEMO_CHALLENGES.map((c) => [c.id, c]));
    const classicAggregates = new Map<string, { points: number; solved: number }>();
    const solveCounts = new Map<string, number>();
    const nSolves = DEMO_CLASSIC_SOLVES.length;
    DEMO_CLASSIC_SOLVES.forEach(({ login, challengeId }, i) => {
      const challenge = challengesById.get(challengeId);
      if (!challenge) return; // fixture-consistency guard; should never trigger
      const frac = nSolves > 0 ? (i + 0.5) / nSolves : 0.5;
      const at = new Date(base + Math.min(0.999, frac) * spanMs).toISOString();
      cmds.push(["HSET", classicSolvesKey(login), challengeId, JSON.stringify({ points: challenge.points, at })]);
      // Same reasoning as the quiz attempt row above: index-derived, not random.
      cmds.push([
        "HSET",
        classicAttemptsKey(login),
        challengeId,
        demoAttemptRow(1 + ((i + 1) % 3), at, 2 + (i % 9), base),
      ]);

      const agg = classicAggregates.get(login) ?? { points: 0, solved: 0 };
      agg.points += challenge.points;
      agg.solved += 1;
      classicAggregates.set(login, agg);

      solveCounts.set(challengeId, (solveCounts.get(challengeId) ?? 0) + 1);
      classicSolvesSeeded++;
    });
    // Unsolved attempts, same reasoning as the quiz block above.
    const solvedBy = new Map<string, Set<string>>();
    for (const { login, challengeId } of DEMO_CLASSIC_SOLVES) {
      const set = solvedBy.get(login) ?? new Set<string>();
      set.add(challengeId);
      solvedBy.set(login, set);
    }
    DEMO_CONTESTANTS.forEach((c, ci) => {
      const solved = solvedBy.get(c.login) ?? new Set<string>();
      const missed = DEMO_CHALLENGES.find((ch) => !solved.has(ch.id));
      if (!missed) return;
      const at = new Date(base + Math.min(0.999, (ci + 0.5) / n) * spanMs).toISOString();
      cmds.push(["HSET", classicAttemptsKey(c.login), missed.id, demoAttemptRow(2 + (ci % 3), at, 4 + (ci % 5), base)]);
    });

    // Aggregates written as the final absolute total (not HINCRBY'd), mirroring
    // the quiz aggregates above — idempotent on a second seed run.
    for (const [login, agg] of classicAggregates) {
      cmds.push(["HSET", CLASSIC_POINTS_KEY, login, agg.points]);
      cmds.push(["HSET", CLASSIC_SOLVED_KEY, login, agg.solved]);
    }
    raiseSolveCounts(cmds, CLASSIC_SOLVECOUNT_KEY, solveCounts);
  }

  // ai demo data — only when the module is enabled, same gate reasoning as
  // quiz and classic above: a disabled ai module leaves the seed byte-for-byte
  // identical to pre-ai behavior.
  //
  // Deliberately does NOT touch `AI_LAUNCHKEY_KEY`: that keypair is
  // module-wide identity material, minted lazily on first real use
  // (`getAiLaunchKeys` in ai-store.ts), never fixture data. Writing one here
  // would hand every seeded demo event the SAME hardcoded private key.
  const aiEnabled = live.has("ai");
  let aiSolvesSeeded = 0;
  if (aiEnabled) {
    // Public challenge record ONLY, built field by field from `AiChallenge`'s
    // own shape (mirrors the classic block above) — the flag and signing key
    // live in DEMO_AI_CHALLENGES only so this function can derive their
    // dedicated hashes, never by spreading the fixture object into
    // ctf:ai:challenges. An event-only challenge (`mode: "event"`) writes
    // NEITHER flag hash, matching how `upsertAiChallenge` treats a non-graded
    // mode: signed events assert that solve, so there is no flag to grade.
    const aiRecords = DEMO_AI_CHALLENGES.map((dc) => ({
      id: dc.id,
      title: dc.title,
      // The fixture's spelling — the script rewrites it, same as classic's.
      category: dc.category,
      description: dc.description,
      points: dc.points,
      order: dc.order,
      mode: dc.mode,
      urlTemplate: dc.urlTemplate,
    }));
    seedCategoriesAndChallenges(
      cmds,
      AI_CATEGORIES_KEY,
      AI_CHALLENGES_KEY,
      DEMO_AI_CATEGORIES,
      AI_CATEGORIES_MAX,
      aiRecords,
    );
    for (const dc of DEMO_AI_CHALLENGES) {
      if (dc.mode !== "event") {
        cmds.push(["HSET", AI_FLAG_KEY, dc.id, dc.flag]);
        cmds.push(["HSET", AI_FLAGNORM_KEY, dc.id, flagComparisonForm(dc.flag, dc.caseSensitive)]);
      }
      // A fixed, obviously-fake demo key rather than a fresh `generateSigningKey()`
      // mint — same choice the classic block above makes for its flag: a
      // reproducible fixture, not fresh CSPRNG output on every seed run.
      cmds.push(["HSET", AI_SIGNKEY_KEY, dc.id, dc.signingKey]);
      if (dc.hint) cmds.push(["HSET", AI_HINTS_KEY, dc.id, dc.hint]);
    }

    const aiChallengesById = new Map(DEMO_AI_CHALLENGES.map((c) => [c.id, c]));
    const aiAggregates = new Map<string, { points: number; solved: number }>();
    const aiSolveCounts = new Map<string, number>();
    const nAiSolves = DEMO_AI_SOLVES.length;
    DEMO_AI_SOLVES.forEach(({ login, challengeId }, i) => {
      const challenge = aiChallengesById.get(challengeId);
      if (!challenge) return; // fixture-consistency guard; should never trigger
      const frac = nAiSolves > 0 ? (i + 0.5) / nAiSolves : 0.5;
      const at = new Date(base + Math.min(0.999, frac) * spanMs).toISOString();
      cmds.push(["HSET", aiSolvesKey(login), challengeId, JSON.stringify({ points: challenge.points, at })]);
      // Same reasoning as the quiz/classic attempt rows above: index-derived,
      // not random, so the seed is reproducible.
      cmds.push(["HSET", aiAttemptsKey(login), challengeId, demoAttemptRow(1 + ((i + 2) % 3), at, 3 + (i % 6), base)]);

      const agg = aiAggregates.get(login) ?? { points: 0, solved: 0 };
      agg.points += challenge.points;
      agg.solved += 1;
      aiAggregates.set(login, agg);

      aiSolveCounts.set(challengeId, (aiSolveCounts.get(challengeId) ?? 0) + 1);
      aiSolvesSeeded++;
    });
    // Unsolved attempts, same reasoning as the quiz/classic blocks above.
    const aiSolvedBy = new Map<string, Set<string>>();
    for (const { login, challengeId } of DEMO_AI_SOLVES) {
      const set = aiSolvedBy.get(login) ?? new Set<string>();
      set.add(challengeId);
      aiSolvedBy.set(login, set);
    }
    DEMO_CONTESTANTS.forEach((c, ci) => {
      const solved = aiSolvedBy.get(c.login) ?? new Set<string>();
      const missed = DEMO_AI_CHALLENGES.find((ch) => !solved.has(ch.id));
      if (!missed) return;
      const at = new Date(base + Math.min(0.999, (ci + 0.5) / n) * spanMs).toISOString();
      cmds.push(["HSET", aiAttemptsKey(c.login), missed.id, demoAttemptRow(2 + (ci % 2), at, 5 + (ci % 3), base)]);
    });

    // Aggregates written as the final absolute total (not HINCRBY'd), mirroring
    // the quiz/classic aggregates above — idempotent on a second seed run, and
    // CONSISTENT with the per-login solve rows and solvecount by construction
    // (both folded from the same DEMO_AI_SOLVES list in this same pass).
    for (const [login, agg] of aiAggregates) {
      cmds.push(["HSET", AI_POINTS_KEY, login, agg.points]);
      cmds.push(["HSET", AI_SOLVED_KEY, login, agg.solved]);
    }
    raiseSolveCounts(cmds, AI_SOLVECOUNT_KEY, aiSolveCounts);
  }

  // Sponsors — a platform feature, not a module, so unlike quiz/classic/ai
  // above this is never gated on `live`: an organizer previewing the demo
  // with every module off still sees what the sponsors feature looks like.
  // The logo's `bytes`/`etag` are derived from the fixture's own base64 data
  // here (same sha256-of-decoded-bytes recipe as sponsors-store.ts's
  // decodeAndValidateLogo), never hand-carried in the fixture, so the two
  // cannot silently drift apart.
  for (const s of DEMO_SPONSORS) {
    const logoBytes = Buffer.from(s.logo.data, "base64");
    const logo = {
      type: s.logo.type,
      bytes: logoBytes.length,
      w: s.logo.w,
      h: s.logo.h,
      etag: createHash("sha256").update(logoBytes).digest("hex").slice(0, 16),
    };
    cmds.push([
      "HSET",
      SPONSORS_KEY,
      s.id,
      JSON.stringify({ id: s.id, name: s.name, url: s.url, blurb: s.blurb, tier: s.tier, order: s.order, logo }),
    ]);
    cmds.push(["HSET", SPONSORS_LOGO_KEY, s.id, s.logo.data]);
  }

  const audit = JSON.stringify({
    at: new Date(now).toISOString(),
    by: actor,
    action: "seed",
    contestants: DEMO_CONTESTANTS.length,
    teams: DEMO_TEAMS.length,
    solves: total,
    ...(quizEnabled ? { quizQuestions: DEMO_QUESTIONS.length, quizAnswers: quizAnswersSeeded } : {}),
    ...(classicEnabled
      ? { classicChallenges: DEMO_CHALLENGES.length, classicSolves: classicSolvesSeeded }
      : {}),
    ...(aiEnabled ? { aiChallenges: DEMO_AI_CHALLENGES.length, aiSolves: aiSolvesSeeded } : {}),
    sponsors: DEMO_SPONSORS.length,
  });
  cmds.push(["LPUSH", ADMIN_AUDIT_KEY, audit]);
  cmds.push(["LTRIM", ADMIN_AUDIT_KEY, 0, AUDIT_CAP - 1]);

  // `upstashPipeline` reports a per-command failure in the RESULT, it does not
  // throw (AGENTS.md). Unchecked, the category script refusing an over-cap
  // union — or any other command failing — would return a cheerful seed count
  // for a seed that did not fully happen. The route turns this into a 503.
  const results = await upstashPipeline(cmds);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Seed failed: ${failed.error}`);
  return {
    contestants: DEMO_CONTESTANTS.length,
    teams: DEMO_TEAMS.length,
    solves: total,
    sponsors: DEMO_SPONSORS.length,
  };
}

// --- runtime admins (issue #147) ---------------------------------------------

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
