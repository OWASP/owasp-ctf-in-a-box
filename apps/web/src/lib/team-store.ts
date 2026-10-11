import "server-only";
import { randomInt } from "node:crypto";
import { cookies } from "next/headers";
import { assertPipelineOk, parseScanPage, upstashEval, upstashPipeline } from "@/lib/upstash";
import { logActivity } from "@/lib/activity-log";
import { TEAM_MAX_MEMBERS } from "@/lib/team-limits";
import { ADMIN_SETTINGS_KEY, outsideWindow } from "@/lib/admin-store";
import { errorLabel } from "@/lib/error-label";
import { joinCodeKey, membersKey, teamKey, userKey } from "@/lib/team-keys";

const MOCK_TEAM_COOKIE = "ctf-mock-team";

/**
 * Gate for real Upstash team writes. When TEAM_WRITES_ENABLED=true, team
 * actions write to Upstash (UPSTASH_REDIS_REST_TOKEN must be a read/write
 * token) under the v2 schema:
 *   HSET ctf:team:<slug> name <name> captain <login> createdAt <iso> joinCode <code>
 *   SADD ctf:team:<slug>:members <login>     (capped at TEAM_MAX_MEMBERS)
 *   HSET ctf:user:<login> team <slug> joinedAt <iso> firstTeamAt <iso>
 *   SET ctf:joincode:<code> <slug>            (reverse index for join-by-code)
 *
 * The two timestamps mean DIFFERENT things and are cleared differently:
 *   joinedAt     when they joined the team they are on NOW. Written on every
 *                join/create, and removed alongside `team` by every path that
 *                clears it (leave, remove, disband) — it is a fact about the
 *                current membership and must not outlive it.
 *   firstTeamAt  the first time this login was EVER on a team. HSETNX, so a
 *                second join never overwrites it, and no path deletes it short
 *                of deleting the contestant.
 *
 * `firstTeamAt` exists for the engagement funnel: signed in ->
 * got on a team -> first solve. Reusing `joinedAt` for that would undercount
 * every contestant who switched teams, silently reporting their conversion as
 * having happened later than it did.
 * When unset, actions persist to a per-browser httpOnly cookie instead, so
 * join/leave stays demoable against the mock leaderboard with zero backend.
 * Captain-only roster actions (remove/rename/transfer/disband/regenerate)
 * are not supported in mock mode — there's no captain or roster concept for
 * a single-cookie, single-player mock.
 *
 * Callers (the /api/team route handlers) are responsible for authenticating
 * the session and deriving `login` server-side — nothing here trusts
 * client-supplied identity.
 */
export const TEAM_WRITES_ENABLED = process.env.TEAM_WRITES_ENABLED === "true";

// Defined in team-limits.ts (no `server-only`) so the admin panel, a Client
// Component, can render it as the field's placeholder. Re-exported here
// because this is where callers expect it.
//
// DO NOT READ IT DIRECTLY to decide whether a team is full — call
// `resolveTeamMaxMembers()`. ADR 31's lesson from the hint toggle is that a
// split-brain comes from surfaces reading the constant while the override
// lives elsewhere: the UI advertises one limit and the join path enforces
// another.
export { TEAM_MAX_MEMBERS } from "@/lib/team-limits";
const NAME_MAX_LENGTH = 32;
const NOT_AVAILABLE_IN_DEMO_MODE = "Not available in demo mode";

export type TeamActionResult = { ok: true; team: string | null } | { ok: false; error: string };

export type JoinCodeResult = { ok: true; team: string; code: string } | { ok: false; error: string };

export type TeamInfo = {
  slug: string;
  name: string;
  members: string[];
};

const REGISTRATION_CLOSED_ERROR = "Team registration is closed";

/** The Unicode bidi controls: marks, embeddings, overrides and isolates. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
/** What renders as nothing: format characters (zero-width spaces and joiners,
 *  the BOM, word joiners) and every other default-ignorable code point. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\s]/gu;

/** The one name check create and rename share (#603). NFC first, so the
 *  length counts what is displayed. Bidi controls are refused rather than
 *  stripped, so a saved name never silently differs from what was typed: one
 *  could render a name reversed, or push it over the points column. A name
 *  with nothing visible left once invisible characters are set aside is
 *  refused too; a zero-width joiner INSIDE a visible name (an emoji sequence)
 *  is kept. */
function checkTeamName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.normalize("NFC").trim();
  if (BIDI_CONTROLS.test(name)) return { ok: false, error: "Team names can't contain text-direction control characters" };
  if (!name.replace(INVISIBLE, "")) return { ok: false, error: "Team name is required" };
  if (name.length > NAME_MAX_LENGTH) {
    return { ok: false, error: `Team name must be ${NAME_MAX_LENGTH} characters or fewer` };
  }
  return { ok: true, name };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
}

// Base32-ish alphabet with ambiguous characters (0/O, 1/l/I) removed so codes
// are easy to read aloud/type. Not cryptographically secret — just short and
// hard to guess/enumerate.
const JOIN_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const JOIN_CODE_LENGTH = 6;
const JOIN_CODE_MAX_ATTEMPTS = 5;

/** Each symbol is an unbiased draw over the alphabet: randomInt rejection-
 *  samples internally. A raw byte reduced `% 31` would not be — 256 % 31 = 8,
 *  so the first eight symbols would land at 9/256 and the rest at 8/256
 *  (CodeQL js/biased-cryptographic-random). */
function generateJoinCodeCandidate(): string {
  let code = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[randomInt(0, JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/** Generates a join code, retrying a few times on the (very unlikely)
 *  chance of a collision with an existing reverse-index key. */
async function generateUniqueJoinCode(): Promise<string> {
  let candidate = generateJoinCodeCandidate();
  for (let attempt = 0; attempt < JOIN_CODE_MAX_ATTEMPTS; attempt++) {
    const [exists] = await upstashPipeline([["EXISTS", joinCodeKey(candidate)]]);
    if (exists.result === 0) return candidate;
    candidate = generateJoinCodeCandidate();
  }
  return candidate;
}

// Each mutation is a single Lua EVAL so every check-and-write is atomic —
// two players racing for a team's last slot can't both get in. Captain-only
// actions guard the caller INSIDE the script (HGET captain == caller) so the
// check and the write happen in the same atomic step.
const CREATE_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], 'team') == 1 then return 'already-on-team' end
if redis.call('EXISTS', KEYS[2]) == 1 then return 'name-taken' end
redis.call('HSET', KEYS[2], 'name', ARGV[2], 'captain', ARGV[1], 'createdAt', ARGV[4], 'joinCode', ARGV[5])
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('HSET', KEYS[1], 'team', ARGV[3], 'joinedAt', ARGV[4])
redis.call('HSETNX', KEYS[1], 'firstTeamAt', ARGV[4])
redis.call('SET', KEYS[4], ARGV[3])
return 'ok'`;

const JOIN_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], 'team') == 1 then return 'already-on-team' end
if redis.call('EXISTS', KEYS[2]) == 0 then return 'not-found' end
if redis.call('SCARD', KEYS[3]) >= tonumber(ARGV[2]) then return 'full' end
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('HSET', KEYS[1], 'team', ARGV[3], 'joinedAt', ARGV[4])
redis.call('HSETNX', KEYS[1], 'firstTeamAt', ARGV[4])
return 'ok'`;

const LEAVE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'team') ~= ARGV[2] then return 'stale' end
if redis.call('HGET', KEYS[2], 'captain') == ARGV[1] and redis.call('SCARD', KEYS[3]) > 1 then return 'captain-must-transfer' end
redis.call('SREM', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[1], 'team', 'joinedAt')
if redis.call('SCARD', KEYS[3]) == 0 then
  local code = redis.call('HGET', KEYS[2], 'joinCode')
  redis.call('DEL', KEYS[2], KEYS[3])
  if code then redis.call('DEL', 'ctf:joincode:' .. code) end
end
return 'ok'`;

const REMOVE_MEMBER_SCRIPT = `
if redis.call('HGET', KEYS[1], 'captain') ~= ARGV[1] then return 'not-captain' end
if redis.call('SISMEMBER', KEYS[2], ARGV[2]) == 0 then return 'not-member' end
if ARGV[2] == ARGV[1] then return 'cannot-remove-captain' end
redis.call('SREM', KEYS[2], ARGV[2])
redis.call('HDEL', KEYS[3], 'team', 'joinedAt')
return 'ok'`;

const RENAME_SCRIPT = `
if redis.call('HGET', KEYS[1], 'captain') ~= ARGV[1] then return 'not-captain' end
if KEYS[2] ~= KEYS[1] and redis.call('EXISTS', KEYS[2]) == 1 then return 'name-taken' end
redis.call('HSET', KEYS[1], 'name', ARGV[2])
return 'ok'`;

const TRANSFER_CAPTAIN_SCRIPT = `
if redis.call('HGET', KEYS[1], 'captain') ~= ARGV[1] then return 'not-captain' end
if redis.call('SISMEMBER', KEYS[2], ARGV[2]) == 0 then return 'not-member' end
redis.call('HSET', KEYS[1], 'captain', ARGV[2])
return 'ok'`;

const DISBAND_SCRIPT = `
if redis.call('HGET', KEYS[1], 'captain') ~= ARGV[1] then return 'not-captain' end
local members = redis.call('SMEMBERS', KEYS[2])
for _, login in ipairs(members) do
  redis.call('HDEL', 'ctf:user:' .. login, 'team', 'joinedAt')
end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return 'ok'`;

const REGENERATE_CODE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'captain') ~= ARGV[1] then return 'not-captain' end
redis.call('DEL', KEYS[3])
redis.call('HSET', KEYS[1], 'joinCode', ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
return 'ok'`;

async function setMockTeam(slug: string): Promise<TeamActionResult> {
  const store = await cookies();
  store.set(MOCK_TEAM_COOKIE, slug, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return { ok: true, team: slug };
}

/** True when the organizer has closed the team-registration window. The
 *  admin store stores "0" for closed and leaves the field absent (⇒ open) by
 *  default, so a single HGET is enough. Roster-shrinking actions (leaveTeam)
 *  are exempt — players can always leave — so this guard is only applied to
 *  team-forming and captain roster mutations.
 *
 *  Fails OPEN on either read-error shape: a transport failure
 *  (`upstashPipeline` throws) or a resolved per-command error (decodes as
 *  every field absent, same as the `Array.isArray` guard below). Same
 *  reasoning as `resolveTeamMaxMembers` above it — a Redis blip must not
 *  itself block registration, and the join/create Lua script still validates
 *  every real invariant (one-team-per-player, capacity, name uniqueness)
 *  atomically regardless of what this check decided. */
async function isRegistrationClosed(): Promise<boolean> {
  try {
    const [res] = await upstashPipeline([
      ["HMGET", ADMIN_SETTINGS_KEY, "teamRegistrationOpen", "registrationStartsAt", "registrationEndsAt"],
    ]);
    if (res.error) {
      // A resolved per-command error (e.g. WRONGTYPE) — not a thrown
      // transport failure, so it must be detected explicitly before the
      // Array.isArray decode below, which would otherwise treat it as
      // "every field absent" silently. Same fail-open verdict, but logged.
      console.error("isRegistrationClosed: settings read failed, failing open:", errorLabel(new Error(res.error)));
      return false;
    }
    const [open, startsAt, endsAt] = Array.isArray(res.result) ? (res.result as (string | null)[]) : [];
    // Closed by the manual toggle OR by the scheduled registration window
    // (before start / after end). Mirrors admin-store's effectiveRegistrationOpen.
    if (open === "0") return true;
    return outsideWindow(Date.now(), startsAt ?? null, endsAt ?? null);
  } catch (err) {
    console.error("isRegistrationClosed: settings read failed, failing open:", errorLabel(err));
    return false;
  }
}

/** Players allowed on one team: the organizer's override, else the default.
 *
 *  The ONE read path, for the join transaction and for every surface that
 *  renders "N players max". Enforced on join only — lowering the cap below an
 *  existing team's size never evicts anyone, it just refuses the next joiner.
 *
 *  Fails OPEN to the default: a Redis blip must not make every team look full
 *  and block registration. Being briefly wrong about the cap is a smaller harm
 *  than a registration outage, and the Lua script still enforces whatever
 *  value it is handed atomically. */
export async function resolveTeamMaxMembers(): Promise<number> {
  try {
    const [res] = await upstashPipeline([["HGET", ADMIN_SETTINGS_KEY, "teamMaxMembers"]]);
    const raw = typeof res.result === "string" ? Number(res.result) : NaN;
    return Number.isInteger(raw) && raw >= 1 ? raw : TEAM_MAX_MEMBERS;
  } catch {
    return TEAM_MAX_MEMBERS;
  }
}

/** The login's team slug, or null when it has none. THROWS on a failed read,
 *  error reply included: read as null, an error looks like "on no
 *  team" — which makes `hasTeam` fail CLOSED on live submissions and
 *  `leaveTeam` report a leave that never happened. Each caller
 *  applies its own documented direction. */
async function getUserTeamSlug(login: string): Promise<string | null> {
  const [current] = await upstashPipeline([["HGET", userKey(login), "team"]]);
  if (current.error) throw new Error(`Upstash HGET user team failed: ${current.error}`);
  return typeof current.result === "string" && current.result ? current.result : null;
}

/**
 * Is this login on a team? The gate every scoring path asks before banking
 * points.
 *
 * Scoring is per TEAM: the leaderboard's per-team total is the union of its
 * members' earned items (`foldTeamTotals`), so points banked by a login that
 * belongs to no team are folded into nothing. A teamless contestant is playing
 * a scoreboard they do not appear on and finds out only when they check.
 * Refusing the submission is the honest answer.
 *
 * Two deliberate exemptions:
 *
 * MOCK MODE returns true. With `TEAM_WRITES_ENABLED` unset there is no team
 * system to be on the wrong side of — `getViewerTeam` falls back to a
 * per-browser cookie — so enforcing here would lock every demo and every
 * local dev-stack out of scoring to protect an invariant that build cannot
 * hold anyway.
 *
 * FAILS OPEN. An unreachable store answers "on a team". This is the same call
 * `effectivePaused` and `resolveTeamMaxMembers` make, for the same reason: a
 * Redis blip must never drop a live submission. Being briefly wrong about
 * membership costs one unattributed score; failing closed costs every
 * contestant every point they earn during the outage. The opposite choice
 * belongs to `requireAdmin`, where granting access wrongly is the worse error.
 */
export async function hasTeam(login: string): Promise<boolean> {
  if (!TEAM_WRITES_ENABLED) return true;
  try {
    return (await getUserTeamSlug(login)) !== null;
  } catch {
    return true;
  }
}

/** The team-name collision verdict, shared by `createTeam` and
 *  `createSoloTeam` so the retry path recognises it without matching on a
 *  user-facing error string. */
const NAME_TAKEN = "name-taken";

/** One create attempt: the registration window and every validity rule are
 *  the caller's business, this is the write. Returns the script's raw verdict
 *  so `createSoloTeam` can tell a collision (retryable) from a refusal (not).
 */
async function attemptCreate(login: string, name: string, slug: string): Promise<string> {
  const createdAt = new Date().toISOString();
  const joinCode = await generateUniqueJoinCode();
  const verdict = await upstashEval(
    CREATE_SCRIPT,
    [userKey(login), teamKey(slug), membersKey(slug), joinCodeKey(joinCode)],
    [login, name, slug, createdAt, joinCode],
  );
  return typeof verdict === "string" ? verdict : "";
}

export async function createTeam(login: string, name: string): Promise<TeamActionResult> {
  const checked = checkTeamName(name);
  if (!checked.ok) return checked;
  const trimmed = checked.name;
  const slug = slugify(trimmed);
  // The team's id (its key and URL) keeps a-z and 0-9 only. A visible name
  // with neither ("Команда", "赤") has no id; say so, not "required".
  if (!slug) return { ok: false, error: "A team name needs at least one letter a–z or digit 0–9" };
  if (!TEAM_WRITES_ENABLED) return setMockTeam(slug);
  if (await isRegistrationClosed()) return { ok: false, error: REGISTRATION_CLOSED_ERROR };

  const verdict = await attemptCreate(login, trimmed, slug);
  if (verdict === "already-on-team") return { ok: false, error: "Leave your current team before creating one" };
  if (verdict === NAME_TAKEN) return { ok: false, error: `Team "${slug}" already exists. Join it instead` };
  // Activity log, success paths only, real writes only (the mock
  // cookie path above records a browser-local choice, not an event fact).
  // Fail-open — a lost log line never fails the mutation it describes.
  await logActivity("team-create", login, slug);
  return { ok: true, team: slug };
}

/** How many names `createSoloTeam` tries before giving up and asking the
 *  contestant for one. Collisions are rare (the first candidate is their own
 *  GitHub login, which is unique among logins), so this only has to survive
 *  someone having taken that name as a team name first. */
const SOLO_NAME_MAX_ATTEMPTS = 4;

/**
 * Creates a team of one, named after the contestant, in a single click.
 *
 * Every contestant must be on a team to be scored, and the docs have always
 * said a solo player is simply a team of one. Without this, "play alone" means
 * inventing a team name first — a naming decision imposed on someone who
 * explicitly does not want a team. The button removes it.
 *
 * The login is only the FIRST candidate, not a guarantee: team names live in
 * their own namespace, so nothing stops another contestant from having already
 * created a team called "octocat". A collision falls back to a suffixed name
 * rather than an error, because the whole promise of this path is that it
 * takes one click.
 */
export async function createSoloTeam(login: string): Promise<TeamActionResult> {
  const base = slugify(login);
  if (!base) return { ok: false, error: "Team name is required" };
  if (!TEAM_WRITES_ENABLED) return setMockTeam(base);
  if (await isRegistrationClosed()) return { ok: false, error: REGISTRATION_CLOSED_ERROR };

  // A GitHub login runs to 39 characters and a team name stops at 32, so the
  // login is NOT automatically a legal team name — clamped here, leaving room
  // for the collision suffix, or this path would mint names `renameTeam` would
  // then refuse to accept.
  const clamped = base.slice(0, NAME_MAX_LENGTH - 4).replace(/-+$/, "");
  if (!clamped) return { ok: false, error: "Team name is required" };

  for (let attempt = 0; attempt < SOLO_NAME_MAX_ATTEMPTS; attempt++) {
    // The suffix uses the join-code alphabet: unambiguous characters, and a
    // team name a contestant may have to read aloud to a teammate later if
    // they stop playing solo.
    const slug = attempt === 0 ? clamped : `${clamped}-${generateJoinCodeCandidate().slice(0, 3)}`;
    const verdict = await attemptCreate(login, slug, slug);
    if (verdict === NAME_TAKEN) continue;
    if (verdict === "already-on-team") {
      return { ok: false, error: "Leave your current team before creating one" };
    }
    await logActivity("team-create", login, slug);
    return { ok: true, team: slug };
  }
  // Four collisions in a row is not a transient condition worth retrying at
  // them silently — hand it back so they can pick a name themselves.
  return { ok: false, error: "Couldn't create a team for you. Pick a team name instead" };
}

/** Joins a team by its captain-shared join code (not the slug). In mock mode
 *  there's no reverse index, so the code is treated as the slug directly. */
export async function joinTeam(login: string, code: string): Promise<TeamActionResult> {
  const trimmedCode = code.trim();
  if (!trimmedCode) return { ok: false, error: "Join code is required" };
  if (!TEAM_WRITES_ENABLED) return setMockTeam(slugify(trimmedCode));
  if (await isRegistrationClosed()) return { ok: false, error: REGISTRATION_CLOSED_ERROR };

  const normalizedCode = trimmedCode.toLowerCase();
  const [codeRes] = await upstashPipeline([["GET", joinCodeKey(normalizedCode)]]);
  // An error reply is not a bad code: never tell a contestant their
  // valid code is invalid because Redis hiccupped.
  if (codeRes.error) throw new Error(`Upstash GET join code failed: ${codeRes.error}`);
  const slug = typeof codeRes.result === "string" && codeRes.result ? codeRes.result : null;
  if (!slug) return { ok: false, error: "Invalid or expired join code" }; // verdict: bad-code

  // Resolved, not the constant: the Lua script enforces the cap inside the
  // transaction, so it has to be handed the value the organizer actually set.
  // Hardcoding it here again is precisely the split this override exists to
  // avoid.
  const maxMembers = await resolveTeamMaxMembers();
  const verdict = await upstashEval(
    JOIN_SCRIPT,
    [userKey(login), teamKey(slug), membersKey(slug)],
    [login, maxMembers, slug, new Date().toISOString()],
  );
  if (verdict === "already-on-team") return { ok: false, error: "Leave your current team before joining another" };
  if (verdict === "not-found") return { ok: false, error: "That team no longer exists" };
  if (verdict === "full") return { ok: false, error: `Team is full (${maxMembers} players max)` };
  if (verdict !== "ok") return { ok: false, error: "Team update failed. Try again" };
  await logActivity("team-join", login, slug);
  return { ok: true, team: slug };
}

export async function leaveTeam(login: string): Promise<TeamActionResult> {
  if (!TEAM_WRITES_ENABLED) {
    const store = await cookies();
    store.delete(MOCK_TEAM_COOKIE);
    return { ok: true, team: null };
  }

  const slug = await getUserTeamSlug(login);
  if (!slug) return { ok: true, team: null };

  // A 'stale' verdict means the membership changed between the read and the
  // script — leaving is idempotent, so treat it as already left.
  const verdict = await upstashEval(LEAVE_SCRIPT, [userKey(login), teamKey(slug), membersKey(slug)], [login, slug]);
  if (verdict === "captain-must-transfer") {
    return { ok: false, error: "Transfer or disband before leaving" };
  }
  // Includes the idempotent 'stale' verdict: either way this login stopped
  // being on `slug`, which is the fact the log records.
  await logActivity("team-leave", login, slug);
  return { ok: true, team: null };
}

/** Captain-only: removes a member from the roster. The captain can't remove
 *  themselves — they must transferCaptain or disbandTeam instead. */
export async function removeMember(
  captainLogin: string,
  slug: string,
  memberLogin: string,
): Promise<TeamActionResult> {
  if (!TEAM_WRITES_ENABLED) return { ok: false, error: NOT_AVAILABLE_IN_DEMO_MODE };
  if (await isRegistrationClosed()) return { ok: false, error: REGISTRATION_CLOSED_ERROR };
  const verdict = await upstashEval(
    REMOVE_MEMBER_SCRIPT,
    [teamKey(slug), membersKey(slug), userKey(memberLogin)],
    [captainLogin, memberLogin],
  );
  if (verdict === "not-captain") return { ok: false, error: "Only the team captain can do that" };
  if (verdict === "cannot-remove-captain") {
    return { ok: false, error: "The captain can't remove themselves — transfer captaincy or disband instead" };
  }
  if (verdict === "not-member") return { ok: false, error: `"${memberLogin}" is not on this team` };
  if (verdict !== "ok") return { ok: false, error: "Team update failed. Try again" };
  return { ok: true, team: slug };
}

/** Captain-only: renames the team's display name. The slug/key is unchanged
 *  (join codes and membership keep working), but the new name still can't
 *  collide with another team's slug. */
export async function renameTeam(captainLogin: string, slug: string, newName: string): Promise<TeamActionResult> {
  if (!TEAM_WRITES_ENABLED) return { ok: false, error: NOT_AVAILABLE_IN_DEMO_MODE };
  const checked = checkTeamName(newName);
  if (!checked.ok) return checked;
  const trimmed = checked.name;
  const newSlug = slugify(trimmed) || slug;
  if (await isRegistrationClosed()) return { ok: false, error: REGISTRATION_CLOSED_ERROR };

  const verdict = await upstashEval(RENAME_SCRIPT, [teamKey(slug), teamKey(newSlug)], [captainLogin, trimmed]);
  if (verdict === "not-captain") return { ok: false, error: "Only the team captain can do that" };
  if (verdict === "name-taken") return { ok: false, error: `Team "${newSlug}" already exists. Choose another name` };
  if (verdict !== "ok") return { ok: false, error: "Team update failed. Try again" };
  await logActivity("team-rename", captainLogin, slug);
  return { ok: true, team: slug };
}

/** Captain-only: hands captaincy to another current member. */
export async function transferCaptain(
  captainLogin: string,
  slug: string,
  toMemberLogin: string,
): Promise<TeamActionResult> {
  if (!TEAM_WRITES_ENABLED) return { ok: false, error: NOT_AVAILABLE_IN_DEMO_MODE };
  // NOT gated by the registration window: transfer is an EXIT for a captain who
  // wants to leave. leaveTeam tells a populated-team captain to transfer or
  // disband first; if the organizer has since closed registration, gating those
  // two would trap the captain with no way out for the rest of the event.
  const verdict = await upstashEval(
    TRANSFER_CAPTAIN_SCRIPT,
    [teamKey(slug), membersKey(slug)],
    [captainLogin, toMemberLogin],
  );
  if (verdict === "not-captain") return { ok: false, error: "Only the team captain can do that" };
  if (verdict === "not-member") return { ok: false, error: `"${toMemberLogin}" is not on this team` };
  if (verdict !== "ok") return { ok: false, error: "Team update failed. Try again" };
  return { ok: true, team: slug };
}

/** Captain-only: disbands the team, clearing every member's team field and
 *  deleting the team's keys, including its join-code reverse index. */
export async function disbandTeam(captainLogin: string, slug: string): Promise<TeamActionResult> {
  if (!TEAM_WRITES_ENABLED) return { ok: false, error: NOT_AVAILABLE_IN_DEMO_MODE };
  // NOT gated by the registration window — disband is an exit for a captain (see
  // transferCaptain). Gating it would trap a captain when registration closes.
  const [codeRes] = await upstashPipeline([["HGET", teamKey(slug), "joinCode"]]);
  const currentCode = typeof codeRes.result === "string" && codeRes.result ? codeRes.result : "";

  const verdict = await upstashEval(
    DISBAND_SCRIPT,
    [teamKey(slug), membersKey(slug), joinCodeKey(currentCode)],
    [captainLogin],
  );
  if (verdict === "not-captain") return { ok: false, error: "Only the team captain can do that" };
  if (verdict !== "ok") return { ok: false, error: "Team update failed. Try again" };
  return { ok: true, team: null };
}

/** Captain-only: invalidates the current join code and issues a new one. */
export async function regenerateCode(captainLogin: string, slug: string): Promise<JoinCodeResult> {
  if (!TEAM_WRITES_ENABLED) return { ok: false, error: NOT_AVAILABLE_IN_DEMO_MODE };
  if (await isRegistrationClosed()) return { ok: false, error: REGISTRATION_CLOSED_ERROR };
  const [codeRes] = await upstashPipeline([["HGET", teamKey(slug), "joinCode"]]);
  const oldCode = typeof codeRes.result === "string" && codeRes.result ? codeRes.result : "";
  const newCode = await generateUniqueJoinCode();

  const verdict = await upstashEval(
    REGENERATE_CODE_SCRIPT,
    [teamKey(slug), joinCodeKey(newCode), joinCodeKey(oldCode)],
    [captainLogin, newCode, slug],
  );
  if (verdict === "not-captain") return { ok: false, error: "Only the team captain can do that" };
  if (verdict !== "ok") return { ok: false, error: "Team update failed. Try again" };
  return { ok: true, team: slug, code: newCode };
}

/** Every team with its members, for the public standings. Live mode only —
 *  the cookie mock is per-browser and has no cross-player view, so this
 *  returns [] when writes are disabled. */
export async function listTeams(): Promise<TeamInfo[]> {
  if (!TEAM_WRITES_ENABLED) return [];

  const prefix = "ctf:team:";
  const suffix = ":members";
  const slugs: string[] = [];
  let cursor = "0";
  do {
    const [scan] = await upstashPipeline([["SCAN", cursor, "MATCH", `${prefix}*${suffix}`, "COUNT", "1000"]]);
    // Throws rather than reading a failed page as "iteration complete" — see
    // parseScanPage. A partial list is worse here than no list: the caller
    // (withTeamStandings) degrades a THROW to the team-less view, which is
    // visibly wrong, but it publishes a short roster as if it were the
    // standings — a team that is competing simply is not on the board.
    const [next, keys] = parseScanPage(scan, "listTeams");
    cursor = next;
    for (const key of keys) slugs.push(key.slice(prefix.length, -suffix.length));
  } while (cursor !== "0");
  if (slugs.length === 0) return [];

  const results = await upstashPipeline(
    slugs.flatMap((slug) => [
      ["HGET", teamKey(slug), "name"],
      ["SMEMBERS", membersKey(slug)],
    ]),
  );
  return slugs.map((slug, i) => {
    const nameRes = results[i * 2]?.result;
    const membersRes = results[i * 2 + 1]?.result;
    return {
      slug,
      name: typeof nameRes === "string" && nameRes ? nameRes : slug,
      members: Array.isArray(membersRes) ? [...(membersRes as string[])].sort() : [],
    };
  });
}

/** The viewer's team as shown on the profile: live Upstash membership when
 *  writes are enabled, otherwise the per-browser mock cookie. */
export async function getViewerTeam(login: string): Promise<TeamInfo | null> {
  if (!TEAM_WRITES_ENABLED) {
    const store = await cookies();
    const slug = store.get(MOCK_TEAM_COOKIE)?.value ?? null;
    return slug ? { slug, name: slug, members: [login] } : null;
  }

  // Unreadable membership reads as "no team" — the documented team-of-one
  // that classic-team.ts relies on (fewer unlocks, never more) — but logged.
  let slug: string | null;
  try {
    slug = await getUserTeamSlug(login);
  } catch (err) {
    console.error("getViewerTeam: membership read failed, showing no team:", errorLabel(err));
    return null;
  }
  if (!slug) return null;
  const [nameRes, membersRes] = await upstashPipeline([
    ["HGET", teamKey(slug), "name"],
    ["SMEMBERS", membersKey(slug)],
  ]);
  const name = typeof nameRes.result === "string" && nameRes.result ? nameRes.result : slug;
  const members = Array.isArray(membersRes.result) ? ([...(membersRes.result as string[])].sort()) : [];
  return { slug, name, members };
}

/**
 * Resolve a join code to the team it belongs to, for DISPLAY only.
 *
 * The shareable `/join/<code>` link needs to show a contestant which team they
 * are about to join before they commit. It deliberately does NOT join: that
 * stays a POST through `/api/team/join`, so a link preview, a prefetch, or a
 * crawler following the URL can never add someone to a team.
 *
 * Returns null for an unknown or expired code — the same answer the join path
 * gives, so a bad link cannot be told apart from a stale one by probing. What
 * it exposes for a VALID code is the team's name and size, which is already
 * public on the leaderboard.
 */
export async function lookupJoinCode(
  code: string,
): Promise<{ slug: string; name: string; memberCount: number } | null> {
  const normalized = code.trim().toLowerCase();
  if (!normalized) return null;
  if (!TEAM_WRITES_ENABLED) return null;

  const [codeRes] = await upstashPipeline([["GET", joinCodeKey(normalized)]]);
  // Error replies throw; the join page catches and shows its own
  // unreadable state instead of "this code has expired".
  if (codeRes.error) throw new Error(`Upstash GET join code failed: ${codeRes.error}`);
  const slug = typeof codeRes.result === "string" && codeRes.result ? codeRes.result : null;
  if (!slug) return null;

  const [nameRes, countRes] = assertPipelineOk(
    await upstashPipeline([
      ["HGET", teamKey(slug), "name"],
      ["SCARD", membersKey(slug)],
    ]),
    "lookupJoinCode team",
  );
  // A code whose team has since been disbanded is treated as expired rather
  // than rendering an empty card: leaveTeam deletes the team key and the code
  // together, but a partially-cleaned state must not become a dead-end page.
  const name = typeof nameRes.result === "string" && nameRes.result ? nameRes.result : null;
  if (!name) return null;
  return { slug, name, memberCount: typeof countRes.result === "number" ? countRes.result : 0 };
}
