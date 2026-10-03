import "server-only";
export { AI_COOLDOWN_SEC } from "./ai-defaults";

import { getAdminSettings } from "@/lib/admin-store";
import { scoringClosure } from "@/lib/schedule-window";
import { errorLabel } from "@/lib/error-label";
import { readLastAt } from "@/lib/last-at";
import { AI_COOLDOWN_SEC, AI_NONCE_TTL_SEC } from "@/lib/ai-defaults";
import { foldTeamItems } from "@/lib/leaderboard/team-fold";
import { generateLaunchKeyPair, generateSigningKey, type AiLaunchKeyPair } from "@/lib/ai-token";
import { AI_BUNDLE_VERSION, type AiBundle, type AiBundleChallenge } from "@/lib/ai-io";
import { MARKDOWN_MAX } from "@/lib/markdown";
import { upstashEval, upstashPipeline } from "@/lib/upstash";
import {
  AI_CATEGORIES_KEY as CATEGORIES_KEY,
  AI_CATEGORIES_MAX,
  AI_CATEGORY_MAX_LEN,
  AI_CHALLENGES_KEY as CHALLENGES_KEY,
  AI_FLAG_KEY as FLAG_KEY,
  AI_FLAGNORM_KEY as FLAGNORM_KEY,
  AI_HINTS_KEY as HINTS_KEY,
  AI_HINT_MAX,
  AI_ID_RE,
  AI_JTI_RE,
  AI_LAUNCHKEY_KEY as LAUNCHKEY_KEY,
  AI_POINTS_KEY as POINTS_KEY,
  AI_POINTS_MAX,
  AI_SIGNKEY_KEY as SIGNKEY_KEY,
  AI_SOLVECOUNT_KEY as SOLVECOUNT_KEY,
  AI_SOLVED_KEY as SOLVED_KEY,
  AI_LAST_AT_KEY as LAST_AT_KEY,
  aiAttemptsKey as attemptsKey,
  aiNonceKey as nonceKey,
  aiSolvesKey as solvesKey,
  caseSensitiveFlagForm,
  flagComparisonForm,
  isAiMode,
  normalizeFlag,
  validateUrlTemplate,
  type AiMode,
} from "@/lib/ai-keys";

/**
 * The ai (externally hosted AI/LLM challenge) module. This file is the only
 * place that touches `ctf:ai:*` during normal contestant and authoring
 * activity. The one documented exception, as in classic: `admin-store.ts`'s
 * demo seed and master reset reuse the key names from `ai-keys.ts` directly.
 *
 * Secrecy boundary — a CONTESTANT boundary, with FOUR secret hashes rather
 * than classic's three, plus one secret string:
 *
 *   - `listAiChallenges` (CONTESTANT path) issues no command against
 *     `ctf:ai:flag`, `ctf:ai:flagnorm`, `ctf:ai:hints`, `ctf:ai:signkey` or
 *     `ctf:ai:launchkey`, and `AiChallenge` has no field any of them could ride
 *     in.
 *   - `listAiChallengesForAdmin` (behind `requireAdmin`) reads all four hashes
 *     and returns them in an `AdminAiChallenge` shape that is deliberately NOT
 *     assignable to `AiChallenge`, so handing an admin row to a
 *     contestant-facing component is a compile error rather than a leak.
 *   - `getAiSigningKey` is the ONE per-challenge key reader a route may call:
 *     one field of one hash. A route that needs a key must never reach for the
 *     admin lister instead — see that function's own docstring.
 *   - `getAiLaunchKeys` returns the module-wide launch keypair and is
 *     MINT-SIDE ONLY. A route that merely needs to VERIFY a token calls
 *     `getAiLaunchPublicKey`, which hands back the public half alone.
 *
 * `ctf:ai:launchkey`'s private half is the most dangerous secret in the module.
 * A flag lets its holder claim one solve; an event signing key lets its holder
 * assert solves on ONE challenge for players who already hold a box-minted
 * token; the launch PRIVATE key lets its holder mint identity itself, naming
 * any user on any challenge. Treat any code path that could carry it — or a
 * flag, or an event key — into a contestant payload as a critical bug.
 */

/** Public-safe challenge record. Never carries a flag, a hint or a key. */
export type AiChallenge = {
  id: string;
  title: string;
  category: string;
  description: string;
  points: number;
  order: number;
  /** Which solve paths are live for this challenge (see `AiMode`). PUBLIC:
   *  the page has to know whether to render a flag input at all. */
  mode: AiMode;
  /** The organizer's launch template, containing `{token}`. PUBLIC: it is
   *  rendered into an anchor the contestant clicks. */
  urlTemplate: string;
  /** Compare this challenge's flag with case intact. Absent means false —
   *  the forgiving default, same rule as classic. */
  caseSensitive?: boolean;
};

/** The ADMIN-gated surface: the public record and its three secrets, side by
 *  side but in SEPARATE fields. Not assignable to `AiChallenge` on purpose. */
export type AdminAiChallenge = {
  challenge: AiChallenge;
  /** The flag AS AUTHORED. Empty when the challenge is event-only, or when
   *  the row is missing — worth seeing in the edit form either way. */
  flag: string;
  hint: string | null;
  /** ADMIN SURFACES ONLY. Empty only for a record written before its key was
   *  minted, which the panel renders as "no key yet — rotate to mint one". */
  signingKey: string;
};

export class AiValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "AiValidationError";
    this.field = field;
  }
}

function parseChallenge(raw: string): AiChallenge | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as Record<string, unknown>;
    if (typeof c.id !== "string") return null;
    if (typeof c.title !== "string") return null;
    if (typeof c.category !== "string") return null;
    if (typeof c.description !== "string") return null;
    if (typeof c.points !== "number") return null;
    if (typeof c.order !== "number") return null;
    // A record whose mode does not parse is DROPPED rather than defaulted: a
    // wrong default here would either hide a flag input the challenge needs or
    // offer one it cannot grade.
    if (!isAiMode(c.mode)) return null;
    if (typeof c.urlTemplate !== "string") return null;
    return {
      id: c.id,
      title: c.title,
      category: c.category,
      description: c.description,
      points: c.points,
      order: c.order,
      mode: c.mode,
      urlTemplate: c.urlTemplate,
      // Carried back only when stored true, mirroring how it is written.
      ...(c.caseSensitive === true ? { caseSensitive: true as const } : {}),
    };
  } catch {
    return null;
  }
}

/** Board reading order: cheapest first, then the organizer's `order`, then id
 *  as a stable tiebreak. Same rule as classic's. */
function compareChallenges(a: AiChallenge, b: AiChallenge): number {
  return a.points - b.points || a.order - b.order || a.id.localeCompare(b.id);
}

function parseChallengeHash(flat: unknown): AiChallenge[] {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const out: AiChallenge[] = [];
  for (let i = 0; i < arr.length; i += 2) {
    const parsed = parseChallenge(arr[i + 1]);
    if (parsed) out.push(parsed);
  }
  return out;
}

function hashToMap(flat: unknown): Map<string, string> {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const out = new Map<string, string>();
  for (let i = 0; i < arr.length; i += 2) {
    if (typeof arr[i + 1] === "string") out.set(arr[i], arr[i + 1]);
  }
  return out;
}

/** All ai challenges in board order. The ONLY list function a
 *  contestant-facing route or the leaderboard may call. */
export async function listAiChallenges(): Promise<AiChallenge[]> {
  const [res] = await upstashPipeline([["HGETALL", CHALLENGES_KEY]]);
  const challenges = parseChallengeHash(res.result);
  challenges.sort(compareChallenges);
  return challenges;
}

/** The same list WITH each challenge's flag, hint and signing key — for the
 *  `requireAdmin`-gated authoring surface ONLY. All four hashes in one
 *  pipeline, so they come from the same instant. */
export async function listAiChallengesForAdmin(): Promise<AdminAiChallenge[]> {
  const [challengesRes, flagRes, hintRes, keyRes] = await upstashPipeline([
    ["HGETALL", CHALLENGES_KEY],
    ["HGETALL", FLAG_KEY],
    ["HGETALL", HINTS_KEY],
    ["HGETALL", SIGNKEY_KEY],
  ]);
  const flagById = hashToMap(flagRes.result);
  const hintById = hashToMap(hintRes.result);
  const keyById = hashToMap(keyRes.result);

  const rows = parseChallengeHash(challengesRes.result).map((challenge) => ({
    challenge,
    flag: flagById.get(challenge.id) ?? "",
    hint: hintById.get(challenge.id) ?? null,
    signingKey: keyById.get(challenge.id) ?? "",
  }));
  rows.sort((a, b) => compareChallenges(a.challenge, b.challenge));
  return rows;
}

/** ONE challenge's signing key. This is the ONLY key reader a route may call.
 *
 *  `listAiChallengesForAdmin` is NOT that function, even though it is the other
 *  thing that returns a key. It `HGETALL`s all four secret hashes, so calling
 *  it to answer "what is challenge X's key?" pulls every flag and every signing
 *  key in the event into a local variable — and the routes that need a key are
 *  the cross-origin, cookie-blind, unauthenticated ones. One `console.error`
 *  over the result, or one error-echoing 503, would dump the whole secret set
 *  to the public internet. This reads exactly one field of exactly one hash.
 *
 *  `null` means "no usable key": a bad id, a missing row, or a reply that is
 *  not a string. Callers must refuse on `null` — never fall back to `""`, which
 *  `ai-token.ts` rejects outright because an empty HMAC key is guessable. */
export async function getAiSigningKey(id: string): Promise<string | null> {
  if (!AI_ID_RE.test(id)) return null;
  const [res] = await upstashPipeline([["HGET", SIGNKEY_KEY, id]]);
  return typeof res.result === "string" && res.result ? res.result : null;
}

function parseLaunchKeys(raw: unknown): AiLaunchKeyPair | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { publicKey, privateKey } = parsed as Record<string, unknown>;
    if (typeof publicKey !== "string" || !publicKey) return null;
    if (typeof privateKey !== "string" || !privateKey) return null;
    return { publicKey, privateKey };
  } catch {
    return null;
  }
}

/** The module-wide Ed25519 launch keypair, minted on first use.
 *
 *  SERVER-ONLY and MINT-SIDE ONLY. The private half names users: whoever holds
 *  it can mint a token for anybody, so it must never reach a response, a log or
 *  a client bundle. A caller that only needs to CHECK a token wants
 *  `getAiLaunchPublicKey` instead.
 *
 *  The first write is a check-then-act, so it is done with an atomic `SET NX`
 *  followed by a `GET` in the SAME pipeline — the same lesson as the signing
 *  key's `HSETNX` mint. Two concurrent first uses would otherwise each generate
 *  a different keypair and the later write would win silently, leaving the
 *  losing caller minting tokens with a private key that was never persisted:
 *  every one of them would fail verification against the public key the box
 *  actually publishes, and nothing anywhere would say why.
 *
 *  So the value RETURNED is always the one read back, never the local
 *  candidate. If the read-back is unusable we do not know which pair is live,
 *  and an error is the honest answer.
 *
 *  A stored-but-corrupt record throws rather than being overwritten: silently
 *  minting a fresh pair over it would invalidate every launch token already in
 *  a contestant's browser, mid-event, with no message anywhere. */
export async function getAiLaunchKeys(): Promise<AiLaunchKeyPair> {
  const [existing] = await upstashPipeline([["GET", LAUNCHKEY_KEY]]);
  if (existing.error) throw new Error(`Upstash GET failed: ${existing.error}`);
  // `null` (no key yet) is the ONLY reply that mints. A present-but-unparseable
  // value falls through to the SET NX below, which is a no-op against it, and
  // then fails on the read-back — loudly, without destroying anything.
  if (existing.result !== null && existing.result !== undefined) {
    const found = parseLaunchKeys(existing.result);
    if (found) return found;
    throw new Error("ai launch keys: the stored keypair is unusable (refusing to overwrite it)");
  }

  const candidate = generateLaunchKeyPair();
  const [, persistedRes] = await upstashPipeline([
    ["SET", LAUNCHKEY_KEY, JSON.stringify(candidate), "NX"],
    ["GET", LAUNCHKEY_KEY],
  ]);
  if (persistedRes.error) throw new Error(`Upstash GET failed: ${persistedRes.error}`);
  const persisted = parseLaunchKeys(persistedRes.result);
  if (!persisted) throw new Error("Upstash GET returned no usable ai launch keypair");
  return persisted;
}

/** The PUBLIC half alone — safe to serve, and meant to be. Publishing it is
 *  what lets a key-holding backend AND a pure static SPA verify a launch token
 *  without either of them being able to mint one.
 *
 *  It reads the same record as `getAiLaunchKeys` (there is only one), so it
 *  mints the pair on first use too; it just never lets the private half out of
 *  this module. */
export async function getAiLaunchPublicKey(): Promise<string> {
  return (await getAiLaunchKeys()).publicKey;
}

/** Claims a signed event's `jti` exactly once, and reports whether THIS caller
 *  is the one that got it. `false` means "refuse this request".
 *
 *  Fails CLOSED, which is the DELIBERATE OPPOSITE of the pause gate above: a
 *  Redis error, a `null` (the key was already there), or any reply this does
 *  not recognise all return `false`. The pause check fails open because a blip
 *  must not drop a submission a contestant is entitled to make; this one cannot
 *  afford that, because it is the single check standing between a captured
 *  signed request and unlimited re-awards. "I cannot prove this is fresh" and
 *  "this is a replay" have to reach the caller as the same answer.
 *
 *  `SET ... NX EX` is one atomic round trip on purpose. A GET-then-SET would
 *  let two copies of the same captured request both observe "not seen yet".
 *
 *  A malformed `jti` (not `AI_JTI_RE`) is refused before any Redis call, same
 *  as a replay — fail closed, same direction as the rest of this function. The
 *  value arrives inside a request body and becomes part of a Redis key name,
 *  so an unbounded one is an unbounded key. */
export async function claimAiNonce(jti: string): Promise<boolean> {
  if (typeof jti !== "string" || !AI_JTI_RE.test(jti)) {
    // No value logged — the jti is caller-supplied and becomes a key name. The
    // diagnostic matters because if a future minter's jti alphabet ever drifts
    // from `AI_JTI_RE`, the only other symptom is "every event is a replay".
    console.error("ai nonce: refused a malformed jti");
    return false;
  }
  try {
    const [res] = await upstashPipeline([
      ["SET", nonceKey(jti), new Date().toISOString(), "NX", "EX", AI_NONCE_TTL_SEC],
    ]);
    if (res.error) {
      // Redis' own error text, capped — never the command, whose arguments
      // include the caller's `jti`.
      console.error("ai nonce: claim failed (redis error):", String(res.error).slice(0, 200));
      return false;
    }
    return res.result === "OK";
  } catch (err) {
    console.error("ai nonce: claim failed (transport):", errorLabel(err));
    return false;
  }
}

/** Gives a claimed `jti` back, for the caller that claimed it and then could
 *  not use it. One `DEL` on the nonce key.
 *
 *  WHY THIS IS NOT A REPLAY HOLE. The nonce's only job is to stop the replay of
 *  an award that HAPPENED. `/api/ai/event` claims before awarding (it must —
 *  claiming after would let two copies of one captured request both award), so a
 *  refusal from `awardAiEvent` leaves a jti spent on nothing. The integrator
 *  holds ONE token per launch and its retry — standard on a 5xx — would then
 *  read `409 replay` forever. Releasing is safe because `AWARD_SCRIPT` is
 *  idempotent (a retry that lands twice answers `already: true`) and every
 *  signature, token, skew, budget and team check re-runs on the retry.
 *
 *  NEVER THROWS, and returns nothing to check. The caller is already on a
 *  refusal path answering the integrator; a failed release only means the
 *  nonce sits until its TTL and the integrator re-launches, which is strictly
 *  better than turning a store blip into a 500. Errors are swallowed with a
 *  redacted log, same discipline as `claimAiNonce`.
 *
 *  A malformed `jti` is refused before any Redis call — same `AI_JTI_RE` guard,
 *  same reason: the value becomes part of a key name. */
export async function releaseAiNonce(jti: string): Promise<void> {
  if (typeof jti !== "string" || !AI_JTI_RE.test(jti)) {
    console.error("ai nonce: refused to release a malformed jti");
    return;
  }
  try {
    const [res] = await upstashPipeline([["DEL", nonceKey(jti)]]);
    if (res.error) {
      // Redis' own error text, capped — never the command, whose arguments
      // include the caller's `jti`.
      console.error("ai nonce: release failed (redis error):", String(res.error).slice(0, 200));
    }
  } catch (err) {
    console.error("ai nonce: release failed (transport):", errorLabel(err));
  }
}

/** The organizer's category display order. Absent or unparseable reads as an
 *  empty list — a board with no categories yet, not an error. */
export async function listAiCategories(): Promise<string[]> {
  const [res] = await upstashPipeline([["GET", CATEGORIES_KEY]]);
  if (typeof res.result !== "string") return [];
  try {
    const parsed = JSON.parse(res.result) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

/** How the solve was earned. `flag` is the default for any row written before
 *  this field existed. */
export type AiSolveSource = "flag" | "event";
type Solve = { points: number; at: string; source: AiSolveSource };
type Attempt = { attempts: number; lastAt: string };

function extractSolve(v: Record<string, unknown>): Solve | null {
  if (typeof v.points !== "number" || typeof v.at !== "string") return null;
  return { points: v.points, at: v.at, source: v.source === "event" ? "event" : "flag" };
}

function extractAttempt(v: Record<string, unknown>): Attempt | null {
  if (typeof v.attempts !== "number" || typeof v.lastAt !== "string") return null;
  return { attempts: v.attempts, lastAt: v.lastAt };
}

function parseHashEntries<T>(flat: unknown, extract: (parsed: Record<string, unknown>) => T | null): Record<string, T> {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const out: Record<string, T> = {};
  for (let i = 0; i < arr.length; i += 2) {
    const value = parseJsonValue(arr[i + 1], extract);
    if (value !== null) out[arr[i]] = value;
  }
  return out;
}

function parseJsonValue<T>(raw: unknown, extract: (parsed: Record<string, unknown>) => T | null): T | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return extract(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

export type ViewerAi = {
  solved: Record<string, Solve>;
  attempts: Record<string, Attempt>;
};

/** One caller's ai progress. Two HGETALLs in one pipeline against that login's
 *  own hashes — no secret key is touched. */
export async function getViewerAi(login: string): Promise<ViewerAi> {
  const [solvesRes, attemptsRes] = await upstashPipeline([
    ["HGETALL", solvesKey(login)],
    ["HGETALL", attemptsKey(login)],
  ]);
  return {
    solved: parseHashEntries(solvesRes.result, extractSolve),
    attempts: parseHashEntries(attemptsRes.result, extractAttempt),
  };
}

function parseCounterHash(flat: unknown): Map<string, number> {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const out = new Map<string, number>();
  for (let i = 0; i < arr.length; i += 2) {
    const n = Number(arr[i + 1]);
    if (Number.isFinite(n)) out.set(arr[i], n);
  }
  return out;
}

/** Distinct solvers per challenge — distinct by construction, because
 *  AWARD_SCRIPT's already-solved guard runs before any increment. */
export async function getAiSolveCounts(): Promise<Map<string, number>> {
  const [res] = await upstashPipeline([["HGETALL", SOLVECOUNT_KEY]]);
  return parseCounterHash(res.result);
}

/** `itemIds` is present only on the TEAM path, whose fold already dedupes by
 *  item id — the aggregate per-login path has running counters with no memory
 *  of which items produced them. Where it is present a caller can union it
 *  with the live catalogue for a denominator that survives an organizer
 *  deleting a solved item; where it is absent the caller clamps. */
export type AiTotal = { points: number; solved: number; lastAt: string | null; itemIds?: string[] };

/** Per-login totals off the two aggregate hashes plus `ctf:ai:lastAt`, in
 *  one pipeline whose cost does not grow with the board. `lastAt` is the
 *  login's latest award time, the leaderboard's "whoever got there
 *  first" tiebreak; null for a login that last scored before the time was
 *  recorded, and for everyone when that read fails (`readLastAt` fails
 *  open: the points stand). */
export async function getAiTotals(): Promise<Map<string, AiTotal>> {
  const [pointsRes, solvedRes, lastAtRes] = await upstashPipeline([
    ["HGETALL", POINTS_KEY],
    ["HGETALL", SOLVED_KEY],
    ["HGETALL", LAST_AT_KEY],
  ]);
  // An errored counter read is not "nobody has points": throw, so the
  // leaderboard's own handling applies (it logs and leaves the module off the
  // board) instead of every row silently losing these points.
  const failed = pointsRes.error ?? solvedRes.error;
  if (failed !== undefined) throw new Error(`ai totals read failed: ${failed}`);
  const points = parseCounterHash(pointsRes.result);
  const solved = parseCounterHash(solvedRes.result);
  const lastAt = readLastAt(lastAtRes, "ai");

  const totals = new Map<string, AiTotal>();
  for (const login of new Set([...points.keys(), ...solved.keys()])) {
    totals.set(login, { points: points.get(login) ?? 0, solved: solved.get(login) ?? 0, lastAt: lastAt.get(login) ?? null });
  }
  return totals;
}

/** A TEAM's total is the UNION of challenges its members solved, never the sum
 *  of member aggregates — summing double counts a challenge two teammates both
 *  solved, and the aggregates have no memory of WHICH challenges contributed.
 *  One pipeline for the whole board; a login on two teams is fetched once. */
export async function getTeamAiTotalsBatch(teams: readonly (readonly string[])[]): Promise<AiTotal[]> {
  const indexByLogin = new Map<string, number>();
  for (const members of teams) {
    for (const login of members) {
      if (!indexByLogin.has(login)) indexByLogin.set(login, indexByLogin.size);
    }
  }
  const logins = [...indexByLogin.keys()];
  if (logins.length === 0) return teams.map(() => ({ points: 0, solved: 0, lastAt: null, itemIds: [] }));

  const results = await upstashPipeline(logins.map((login) => ["HGETALL", solvesKey(login)]));
  return teams.map((members) => {
    const { points, completed, lastAt, itemIds } = foldTeamItems(
      members.map((login) => results[indexByLogin.get(login) ?? -1]),
    );
    return { points, solved: completed, lastAt, itemIds };
  });
}

/** Replaces the category list. Names are trimmed and deduped, and ORDER IS
 *  CONTENT — it is the order the board renders headings in, which is why this
 *  is one JSON array in a string key rather than a Redis set. */
export async function setAiCategories(names: string[]): Promise<string[]> {
  if (!Array.isArray(names)) throw new AiValidationError("categories", "Categories must be a list");
  const cleaned: string[] = [];
  for (const raw of names) {
    if (typeof raw !== "string") throw new AiValidationError("categories", "Category names must be strings");
    const name = raw.trim();
    if (!name) continue;
    if (name.length > AI_CATEGORY_MAX_LEN) {
      throw new AiValidationError("categories", `Category names must be at most ${AI_CATEGORY_MAX_LEN} characters`);
    }
    if (!cleaned.includes(name)) cleaned.push(name);
  }
  if (cleaned.length > AI_CATEGORIES_MAX) {
    throw new AiValidationError("categories", `At most ${AI_CATEGORIES_MAX} categories`);
  }
  const [res] = await upstashPipeline([["SET", CATEGORIES_KEY, JSON.stringify(cleaned)]]);
  if (res.error) throw new Error(`Upstash SET failed: ${res.error}`);
  return cleaned;
}

/** What a rename did. Mirrors classic-store's `CategoryRename` rather than
 *  importing it: the two module stores are deliberately independent, and the
 *  rest of this file mirrors classic's contracts the same way. */
export type CategoryRename = { categories: string[]; moved: number };

/**
 * Renames one category and carries every challenge in it across.
 *
 * Mirrors `renameCategory` in classic-store.ts — read that one's comment for
 * why the challenges are written BEFORE the list (the resulting partial state
 * is the one a retry can finish from) and why an existing name is refused
 * rather than merged.
 *
 * The collision check folds case, exactly as classic's does, even though
 * `setAiCategories` dedupes case-SENSITIVELY (`cleaned.includes`). Without the
 * fold a rename could land `["Web", "web"]`, which the panel's own
 * `renameCategoryDecision` forbids and which would split one category's
 * challenges across two headings. The stricter rule is the right one on both
 * sides; a case-only rename of the SAME entry stays allowed, which is what the
 * index comparison protects.
 */
export async function renameAiCategory(from: string, to: string): Promise<CategoryRename> {
  const target = to.trim();
  if (!target) throw new AiValidationError("categories", "A category name cannot be empty");
  if (target.length > AI_CATEGORY_MAX_LEN) {
    throw new AiValidationError("categories", `Category names must be at most ${AI_CATEGORY_MAX_LEN} characters`);
  }

  const categories = await listAiCategories();
  const source = from.trim();
  const index = categories.findIndex((name) => name.toLowerCase() === source.toLowerCase());
  if (index === -1) throw new AiValidationError("categories", `No category named "${from}"`);
  const targetFold = target.toLowerCase();
  if (categories.some((name, i) => i !== index && name.toLowerCase() === targetFold)) {
    throw new AiValidationError(
      "categories",
      `"${target}" already exists. Rename it to something else, or move these challenges one at a time.`,
    );
  }

  // Same fail-closed read as classic's: `listAiChallenges` does not check the
  // reply's error, so a failed HGETALL would look like "nothing uses this
  // category" and the rename would orphan every challenge in it.
  const [challengesRes] = await upstashPipeline([["HGETALL", CHALLENGES_KEY]]);
  if (challengesRes.error) throw new Error(`Upstash HGETALL failed: ${challengesRes.error}`);
  const moving = parseChallengeHash(challengesRes.result).filter((c) => c.category === source);
  if (moving.length > 0) {
    const writes = await upstashPipeline(
      moving.map((c) => ["HSET", CHALLENGES_KEY, c.id, JSON.stringify({ ...c, category: target })]),
    );
    // Per-command errors are values, not throws (AGENTS.md) — an unchecked
    // `.result` would report a partial move as a complete one.
    const failed = writes.find((w) => w.error);
    if (failed) throw new Error(`Upstash HSET failed: ${failed.error}`);
  }

  const next = [...categories];
  next[index] = target;
  const [res] = await upstashPipeline([["SET", CATEGORIES_KEY, JSON.stringify(next)]]);
  if (res.error) throw new Error(`Upstash SET failed: ${res.error}`);

  return { categories: next, moved: moving.length };
}

export type AiUpsertSecrets = { flag?: string; hint?: string | null };

/** Creates or updates one challenge, and guarantees it has a signing key.
 *
 *  The key is minted ONLY when the challenge has none. An edit must never
 *  rotate silently: the organizer has already pasted that key into an external
 *  system, and a rename that invalidated it would break a live integration
 *  with no message anywhere saying why. Rotation is its own explicit call.
 *
 *  A `mode: "event"` challenge stores no flag at all — both flag hashes are
 *  DELETED rather than left holding a stale value that a later mode change
 *  would silently resurrect. */
export async function upsertAiChallenge(c: AiChallenge, secrets: AiUpsertSecrets = {}): Promise<AdminAiChallenge> {
  if (!AI_ID_RE.test(c.id)) throw new AiValidationError("id", `Invalid challenge id: ${c.id}`);
  if (typeof c.title !== "string" || !c.title.trim()) {
    throw new AiValidationError("title", "Challenge title is required");
  }
  if (!isAiMode(c.mode)) throw new AiValidationError("mode", `Unknown mode: ${String(c.mode)}`);

  const categories = await listAiCategories();
  if (!categories.includes(c.category)) {
    throw new AiValidationError("category", `Unknown category: ${c.category}`);
  }
  if (typeof c.description !== "string" || c.description.length > MARKDOWN_MAX) {
    throw new AiValidationError("description", `Description must be at most ${MARKDOWN_MAX} characters`);
  }
  // Points are read back INSIDE AWARD_SCRIPT by matching a plain integer — a
  // non-integer would either silently award 0 or corrupt HINCRBY mid-script,
  // after the solve row had already been written, with no way to roll back.
  if (!Number.isInteger(c.points) || c.points < 0 || c.points > AI_POINTS_MAX) {
    throw new AiValidationError("points", `Challenge points must be an integer in [0, ${AI_POINTS_MAX}]`);
  }
  // `order` is checked for the same reason, and the failure it prevents is
  // WORSE than a bad `points`. `parseChallenge` drops any record whose order is
  // not a number, so a NaN (which `JSON.stringify` writes as `null`) or any
  // other non-integer arriving here at runtime persists a row that BOTH
  // `listAiChallenges` and `listAiChallengesForAdmin` skip — an invisible,
  // uneditable challenge whose `ctf:ai:flag` and `ctf:ai:signkey` rows stay
  // live and which AWARD_SCRIPT still grades.
  if (!Number.isInteger(c.order)) {
    throw new AiValidationError("order", "Challenge order must be an integer");
  }

  const template = validateUrlTemplate(c.urlTemplate);
  if (!template.ok) throw new AiValidationError("urlTemplate", template.reason);

  const graded = c.mode !== "event";
  const flag = typeof secrets.flag === "string" ? secrets.flag.trim() : "";
  if (graded && !flag) {
    throw new AiValidationError("flag", "A flag is required unless the challenge is event-only");
  }
  const hint = secrets.hint;
  if (hint != null && (typeof hint !== "string" || hint.length > AI_HINT_MAX)) {
    throw new AiValidationError("hint", `Hint must be at most ${AI_HINT_MAX} characters`);
  }
  const authoredHint = typeof hint === "string" && hint.trim() ? hint.trim() : null;

  // Minting a key is a check-then-act, so it has to be done with an atomic
  // HSETNX rather than a separate HGET-then-HSET: two concurrent creates (or
  // edits of a legacy keyless row) could otherwise both observe "no key yet"
  // and each mint a different key, with the later write winning silently —
  // the losing caller would return a key that was never persisted, exactly
  // the broken-integration failure mode this function exists to prevent.
  // HSETNX either plants the candidate (fresh row) or is a no-op (a key
  // already exists); the follow-up HGET in the SAME pipeline reads back
  // whichever key actually won, so every racer converges on one value.
  //
  // That pipeline is the ONLY thing this function writes to SIGNKEY_KEY. The
  // write pipeline below deliberately carries no `HSET ctf:ai:signkey`: it
  // would be a second, later write of a value read before it, and
  // `rotateAiSigningKey` can commit in between — the HSET would then put the
  // REVOKED key back, silently, with nothing anywhere saying the rotation was
  // undone. HSETNX has already guaranteed the row exists, so there is nothing
  // left for it to do but lose that race.
  const candidateKey = generateSigningKey();
  const [, effectiveKeyRes] = await upstashPipeline([
    ["HSETNX", SIGNKEY_KEY, c.id, candidateKey],
    ["HGET", SIGNKEY_KEY, c.id],
  ]);
  // No fallback to `candidateKey`. If the HGET is unusable we do not know
  // which key is live — the candidate may have lost the HSETNX race — and
  // returning it would hand the organizer a key to paste into an external
  // system that the box will never accept. An error is the honest answer.
  if (effectiveKeyRes.error) throw new Error(`Upstash HGET failed: ${effectiveKeyRes.error}`);
  const signingKey = typeof effectiveKeyRes.result === "string" ? effectiveKeyRes.result : "";
  if (!signingKey) throw new Error("Upstash HGET returned no signing key for this challenge");

  const record: AiChallenge = { ...c, urlTemplate: template.value };
  const results = await upstashPipeline([
    ["HSET", CHALLENGES_KEY, c.id, JSON.stringify(record)],
    graded ? ["HSET", FLAG_KEY, c.id, flag] : ["HDEL", FLAG_KEY, c.id],
    graded
      ? ["HSET", FLAGNORM_KEY, c.id, flagComparisonForm(flag, c.caseSensitive)]
      : ["HDEL", FLAGNORM_KEY, c.id],
    authoredHint ? ["HSET", HINTS_KEY, c.id, authoredHint] : ["HDEL", HINTS_KEY, c.id],
  ]);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash HSET failed: ${failed.error}`);

  return { challenge: record, flag: graded ? flag : "", hint: authoredHint, signingKey };
}

/** Mints a NEW signing key for an existing challenge. The old key stops
 *  working immediately — there is no grace window, so the panel warns before
 *  calling this. Refuses on an unknown challenge rather than creating an
 *  orphan key row nothing will ever read. */
export async function rotateAiSigningKey(id: string): Promise<string> {
  if (!AI_ID_RE.test(id)) throw new AiValidationError("id", `Invalid challenge id: ${id}`);
  const [existing] = await upstashPipeline([["HGET", CHALLENGES_KEY, id]]);
  if (typeof existing.result !== "string") {
    throw new AiValidationError("id", `Unknown challenge: ${id}`);
  }
  const key = generateSigningKey();
  const [res] = await upstashPipeline([["HSET", SIGNKEY_KEY, id, key]]);
  if (res.error) throw new Error(`Upstash HSET failed: ${res.error}`);
  return key;
}

/** Deletes a challenge and every secret hanging off it — the record and the
 *  four secret hashes, nothing else. A swallowed error here would leave a live
 *  signing key for a challenge nobody can see, so failures are surfaced rather
 *  than ignored.
 *
 *  NO aggregate is touched, exactly as `deleteChallenge` in classic-store.ts:
 *  solve rows keep what they earned, and `ctf:ai:solvecount` keeps its count.
 *  Clearing banked progress is the master reset's job (admin-store's
 *  `resetEvent`), not this one's. Dropping the solvecount row here would be a
 *  half-cascade with a permanent failure mode: recreate the id (which
 *  `upsertAiChallenge` allows) and the counter restarts at 0 while every prior
 *  solver still holds a solve row, so AWARD_SCRIPT's already-solved guard means
 *  none of them can ever re-increment it — the board would show "0 solvers" on
 *  a challenge dozens of people demonstrably solved. Because the aggregates
 *  outlive the challenge, a login can hold more solves than the challenge list
 *  has entries; the leaderboard overlay clamps the denominator for exactly that
 *  reason. */
export async function deleteAiChallenge(id: string): Promise<void> {
  if (!AI_ID_RE.test(id)) throw new AiValidationError("id", `Invalid challenge id: ${id}`);
  const results = await upstashPipeline([
    ["HDEL", CHALLENGES_KEY, id],
    ["HDEL", FLAG_KEY, id],
    ["HDEL", FLAGNORM_KEY, id],
    ["HDEL", HINTS_KEY, id],
    ["HDEL", SIGNKEY_KEY, id],
  ]);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash HDEL failed: ${failed.error}`);
}

/** Deletes ONLY the content keys — challenges, both flag hashes, the signing
 *  keys, hints and categories — plus `ctf:ai:solvecount`, which is a per-
 *  CHALLENGE counter that a catalogue-wide wipe legitimately zeroes. Never the
 *  per-login run state (`ctf:ai:points`, `ctf:ai:solved`, `solves:<login>`,
 *  `attempts:<login>`).
 *
 *  For a replace-all import: the caller wipes the board clean before writing a
 *  fresh bundle over it, so a challenge dropped from the new bundle doesn't
 *  linger from the old one. That caller is `event-store.ts`'s archive import
 *  (the same one that calls classic's `clearChallenges`) — it is NOT the master
 *  reset. `resetEvent`'s `RESET_PREFIXES` deliberately KEEPS the catalogue, and
 *  wiring this into it would destroy the organizer's challenges, every flag and
 *  every signing key mid-event, breaking every deployed external integration
 *  with no recovery. Contestant HISTORY is deliberately untouched — solve and
 *  attempt rows survive, as they do through `deleteAiChallenge`. Note the one
 *  place this is broader than that function: it DOES clear `ctf:ai:solvecount`,
 *  per the first paragraph. That is a per-challenge counter for a catalogue
 *  that is about to be replaced wholesale, not a per-login aggregate — the
 *  per-login ones (`ctf:ai:points`, `ctf:ai:solved`) survive here too.
 *
 *  `ctf:ai:launchkey` is NOT touched either, and that is deliberate. It is
 *  module-wide identity material, not catalogue content: dropping it here would
 *  silently rotate the module's public key on every archive import, breaking
 *  every deployed verifier and invalidating every token already in a
 *  contestant's browser — for a wipe that was only ever meant to replace the
 *  challenge list.
 *
 *  Surfaces per-command errors for the same reason as above. */
export async function clearAiChallenges(): Promise<void> {
  const results = await upstashPipeline([
    ["DEL", CHALLENGES_KEY],
    ["DEL", FLAG_KEY],
    ["DEL", FLAGNORM_KEY],
    ["DEL", HINTS_KEY],
    ["DEL", SIGNKEY_KEY],
    ["DEL", CATEGORIES_KEY],
    ["DEL", SOLVECOUNT_KEY],
  ]);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash DEL failed: ${failed.error}`);
}

// Mirrors classic-store.ts's local alias exactly: admin-store.ts exports the
// concrete `AdminSettings` type, not a `ResolvedAdminSettings` name, so this
// derives it from `getAdminSettings`'s own return type instead of importing a
// type that does not exist there.
type ResolvedAdminSettings = Awaited<ReturnType<typeof getAdminSettings>>;

type AiGate =
  | { allowed: true }
  | { allowed: false; reason: "paused" | "ended" | "solved" | "cooldown" | "unavailable"; retryAt?: string };

/** The cheap, NON-ATOMIC pre-check.
 *
 *  - The pause/schedule check fails OPEN (`settings` null reads as not paused):
 *    a Redis blip must never silently drop a live submission. Same fail-open
 *    the scorer and sync poller implement.
 *  - The solve/attempt lookup fails CLOSED with its OWN reason, "unavailable" —
 *    never "cooldown". Reporting an unverifiable lookup as a fact about the
 *    contestant's attempts turns a blip into a support argument.
 *
 *  AWARD_SCRIPT re-checks the already-solved guard and the cooldown against
 *  state read at execution time and is what actually enforces them. */
async function evaluateGate(
  settings: ResolvedAdminSettings | null,
  login: string,
  challengeId: string,
  cooldownSec: number,
  preview = false,
): Promise<AiGate> {
  // A preview (an admin before launch) is graded exactly while scoring
  // is closed, so the pause is what is being previewed, not a refusal.
  // `scoringClosure` (#567) is `effectivePaused` with the WHY kept: a passed
  // scheduled end answers `ended`, every other closure `paused`.
  if (!preview && settings) {
    const closure = scoringClosure(Date.now(), settings.paused, settings.scoringStartsAt, settings.scoringEndsAt);
    if (closure) return { allowed: false, reason: closure };
  }

  let solve: Solve | null;
  let attempt: Attempt | null;
  try {
    const [solveRes, attemptRes] = await upstashPipeline([
      ["HGET", solvesKey(login), challengeId],
      ["HGET", attemptsKey(login), challengeId],
    ]);
    if (solveRes.error) throw new Error(solveRes.error);
    if (attemptRes.error) throw new Error(attemptRes.error);
    solve = parseJsonValue(solveRes.result, extractSolve);
    attempt = parseJsonValue(attemptRes.result, extractAttempt);
  } catch (err) {
    console.error("ai gate: solve/attempt lookup failed:", errorLabel(err));
    return { allowed: false, reason: "unavailable" };
  }

  if (solve) return { allowed: false, reason: "solved" };

  // Nothing a preview does is recorded, so there is nothing for it to cool.
  if (!preview && cooldownSec > 0 && attempt) {
    const lastMs = Date.parse(attempt.lastAt);
    if (Number.isFinite(lastMs)) {
      const retryAtMs = lastMs + cooldownSec * 1000;
      if (Date.now() < retryAtMs) {
        return { allowed: false, reason: "cooldown", retryAt: new Date(retryAtMs).toISOString() };
      }
    }
  }

  return { allowed: true };
}

// Awards one solve and records everything it changes atomically. BOTH solve
// paths run this script: ARGV[8] is '1' for a graded flag submission and '0'
// for a signed event, which is the ONLY difference between them. Sharing one
// script is deliberate — two scripts would eventually disagree about the
// already-solved guard, and that guard is what makes the solve counter
// distinct-by-construction.
//
//   1. HGET the challenge record. Missing -> {'missing'} (bad/deleted id).
//   2. HEXISTS the solve row BEFORE any write -> {'already'}, nothing touched.
//   3. Event only: refuse a challenge the organizer authored as mode "flag"
//      -> {'mode'}. The graded path is refused for an event-only challenge
//      ACCIDENTALLY (there is no `flagnorm` row, so step 4 returns {'missing'});
//      without this line the mirror did not hold, because the event path never
//      looks at a flag hash and so had nothing to trip over. The route
//      checks the mode first; this is the copy that cannot be bypassed by a
//      missed check or a later reorder. Matched off `cRaw`, the record the
//      script already holds — no caller string is interpolated — and anchored
//      with a trailing [,}] like the points match, for the same reason.
//   4. Graded only: re-check the cooldown WITHOUT writing, then spend an
//      attempt, then compare. The cooldown arrives as ARGV (the CURRENT admin
//      setting, resolved on every call — never a stored cutoff) and is combined
//      with the attempts row the script reads at execution time.
//   5. Award: solve row + the three counters.
//
// The points match is anchored with a trailing [,}] so it can only match a
// complete "points":<int> pair. Nothing here lowercases anything: Lua's
// string.lower is ASCII-only and would disagree with the JS recipe on any
// non-ASCII flag, producing a challenge nobody can solve.
//
// ARGV[9] (the solve source) is interpolated into stored JSON, so it must only
// ever be a module-internal literal — never caller input.
export const AWARD_SCRIPT = `
local cRaw = redis.call('HGET', KEYS[4], ARGV[1])
if not cRaw then return {'missing'} end
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then return {'already'} end

local points = 0
local caseSensitive = false
local found = string.match(cRaw, '"points":(%-?%d+)[,}]')
if found then points = tonumber(found) end
if string.match(cRaw, '"caseSensitive":true[,}]') then caseSensitive = true end

if ARGV[8] == '0' and string.match(cRaw, '"mode":"flag"[,}]') then return {'mode'} end

-- DRY RUN (ARGV[10] == '1', #464 admin preview, flag path): grade as normal,
-- skip the cooldown refusal, and write NOTHING — no attempts row, no solve,
-- no counters. The verdict carries a trailing 'dry'.
local dry = ARGV[10] == '1'

if ARGV[8] == '1' then
  local target = redis.call('HGET', KEYS[3], ARGV[1])
  if not target then return {'missing'} end

  local cooldownMs = tonumber(ARGV[5])
  local nowMs = tonumber(ARGV[6])
  local attemptsRaw = redis.call('HGET', KEYS[1], ARGV[1])
  local attempts = 0
  local lastAtMs = nil
  local firstAt = nil
  if attemptsRaw then
    local foundAttempts = string.match(attemptsRaw, '"attempts":(%d+)[,}]')
    if foundAttempts then attempts = tonumber(foundAttempts) end
    local foundLastAtMs = string.match(attemptsRaw, '"lastAtMs":(%d+)[,}]')
    if foundLastAtMs then lastAtMs = tonumber(foundLastAtMs) end
    firstAt = string.match(attemptsRaw, '"firstAt":"([^"]*)"')
  end

  if not dry and cooldownMs > 0 and lastAtMs and nowMs < (lastAtMs + cooldownMs) then
    return {'cooldown', tostring(lastAtMs + cooldownMs)}
  end

  attempts = attempts + 1
  if not firstAt then firstAt = ARGV[3] end
  if not dry then
    redis.call('HSET', KEYS[1], ARGV[1], '{"attempts":' .. attempts .. ',"firstAt":"' .. firstAt .. '","lastAt":"' .. ARGV[3] .. '","lastAtMs":' .. ARGV[6] .. '}')
  end

  local submitted = ARGV[2]
  if caseSensitive then submitted = ARGV[7] end
  if target ~= submitted then
    if dry then return {'incorrect', '0', 'dry'} end
    return {'incorrect', tostring(attempts)}
  end
end

if dry then return {'correct', tostring(points), 'dry'} end

redis.call('HSET', KEYS[2], ARGV[1], '{"points":' .. points .. ',"at":"' .. ARGV[3] .. '","source":"' .. ARGV[9] .. '"}')
redis.call('HINCRBY', KEYS[5], ARGV[4], points)
redis.call('HINCRBY', KEYS[7], ARGV[4], 1)
redis.call('HINCRBY', KEYS[6], ARGV[1], 1)
-- Keep the LATEST award time (#522). The time is taken before this script
-- runs, so two awards can arrive out of order; toISOString values compare
-- correctly as strings. A stored value that is not an ISO time is replaced.
local prevAt = redis.call('HGET', KEYS[8], ARGV[4])
if not prevAt or not string.match(prevAt, '^%d%d%d%d%-%d%d%-%d%dT') or prevAt < ARGV[3] then
  redis.call('HSET', KEYS[8], ARGV[4], ARGV[3])
end
return {'correct', tostring(points)}`;

export type AiSubmitResult =
  // `already` is a correct solve that awarded nothing FURTHER — `points: 0`
  // because this call banked nothing, NOT because the challenge is worthless.
  // Callers must render the two apart.
  | { ok: true; correct: true; points: number; already?: boolean; dryRun?: true }
  | { ok: true; correct: false; dryRun?: true }
  | { ok: false; reason: "paused" | "ended" | "solved" | "cooldown"; retryAt?: string }
  // `wrong-mode`: a signed event was asserted against a challenge the organizer
  // authored as `mode: "flag"`. Refused by AWARD_SCRIPT itself, so it holds
  // even if a route forgets to check.
  | { ok: false; reason: "unavailable" | "invalid" | "error" | "wrong-mode" };

/** Resolves the settings and the current cooldown, failing OPEN on a settings
 *  error — a Redis blip must not drop a submission a contestant is entitled to
 *  make. The cooldown honours the organizer's `aiCooldownSec` override
 *  (mirroring classic's `classicCooldownSec`) when the settings read
 *  succeeded, and falls back to the module default `AI_COOLDOWN_SEC`
 *  otherwise — the script still enforces whichever value comes back. */
async function resolveSettings(): Promise<{ settings: ResolvedAdminSettings | null; cooldownSec: number }> {
  let settings: ResolvedAdminSettings | null = null;
  try {
    settings = await getAdminSettings();
  } catch (err) {
    console.error("ai: admin settings read failed, treating scoring as live:", errorLabel(err));
  }
  return { settings, cooldownSec: settings?.aiCooldownSec ?? AI_COOLDOWN_SEC };
}

function gateToResult(gate: Exclude<AiGate, { allowed: true }>): AiSubmitResult {
  if (gate.reason === "unavailable") return { ok: false, reason: "unavailable" };
  return gate.retryAt ? { ok: false, reason: gate.reason, retryAt: gate.retryAt } : { ok: false, reason: gate.reason };
}

function readVerdict(verdict: unknown): AiSubmitResult {
  const [status, value, marker] = Array.isArray(verdict) ? (verdict as unknown[]) : [];
  if (status === "missing") return { ok: false, reason: "invalid" };
  // A dry verdict carries a trailing 'dry' from the script itself.
  if (marker === "dry") {
    if (status === "correct") return { ok: true, correct: true, points: Number(value) || 0, dryRun: true };
    if (status === "incorrect") return { ok: true, correct: false, dryRun: true };
    return { ok: false, reason: "error" };
  }
  if (status === "mode") return { ok: false, reason: "wrong-mode" };
  if (status === "cooldown") {
    return { ok: false, reason: "cooldown", retryAt: new Date(Number(value)).toISOString() };
  }
  if (status === "incorrect") return { ok: true, correct: false };
  if (status === "already") return { ok: true, correct: true, points: 0, already: true };
  if (status === "correct") return { ok: true, correct: true, points: Number(value) || 0 };
  return { ok: false, reason: "error" };
}

/** Runs AWARD_SCRIPT. `grade` decides whether the flag comparison happens at
 *  all; `source` is a module-internal literal written into the solve row. */
async function runAward(
  login: string,
  challengeId: string,
  flag: string,
  cooldownSec: number,
  grade: boolean,
  source: AiSolveSource,
  dryRun = false,
): Promise<AiSubmitResult> {
  const now = new Date();
  try {
    const verdict = await upstashEval(
      AWARD_SCRIPT,
      [
        attemptsKey(login), // KEYS[1]
        solvesKey(login), // KEYS[2]
        FLAGNORM_KEY, // KEYS[3] — the normalized flag; ctf:ai:flag is never
        //                          handed to the script at all
        CHALLENGES_KEY, // KEYS[4]
        POINTS_KEY, // KEYS[5]
        SOLVECOUNT_KEY, // KEYS[6]
        SOLVED_KEY, // KEYS[7]
        LAST_AT_KEY, // KEYS[8] — login -> latest award time (#522)
      ],
      [
        challengeId, // ARGV[1]
        grade ? normalizeFlag(flag) : "", // ARGV[2] — case-insensitive form
        now.toISOString(), // ARGV[3]
        login, // ARGV[4]
        cooldownSec * 1000, // ARGV[5]
        now.getTime(), // ARGV[6]
        grade ? caseSensitiveFlagForm(flag) : "", // ARGV[7] — case preserved
        grade ? "1" : "0", // ARGV[8]
        source, // ARGV[9] — literal, never caller input
        dryRun ? "1" : "0", // ARGV[10] — dry run: grade, write nothing (#464)
      ],
    );
    return readVerdict(verdict);
  } catch (err) {
    console.error("ai grading failed:", errorLabel(err));
    return { ok: false, reason: "error" };
  }
}

/** Grades `flag` against an ai challenge and, on success, records the solve
 *  and every total atomically. Never returns the flag itself — `AiSubmitResult`
 *  has no field for one. */
export async function submitAiFlag(
  login: string,
  challengeId: string,
  flag: string,
  opts: { dryRun?: boolean } = {},
): Promise<AiSubmitResult> {
  if (!AI_ID_RE.test(challengeId)) return { ok: false, reason: "invalid" };
  if (typeof flag !== "string" || !flag.trim()) return { ok: false, reason: "invalid" };
  // `dryRun` here is ONLY ever an admin preview: the callers derive it
  // from the launch lock or a signed preview token, never from a request field.
  const dryRun = opts.dryRun === true;

  const { settings, cooldownSec } = await resolveSettings();
  const gate = await evaluateGate(settings, login, challengeId, cooldownSec, dryRun);
  if (!gate.allowed) return gateToResult(gate);

  return runAward(login, challengeId, flag, cooldownSec, true, "flag", dryRun);
}

/** Records a solve asserted by the external side. The CALLER (the route) is
 *  responsible for having verified the signature, the token and the replay
 *  nonce (`claimAiNonce`) before this is reached — this function's job starts
 *  at the pause/schedule gate.
 *
 *  The route SHOULD check the mode too, and report it properly; but it is not
 *  the only thing that does. AWARD_SCRIPT refuses a `mode: "flag"` challenge on
 *  this path itself (`{ ok: false, reason: "wrong-mode" }`), so a missed check
 *  or a later reorder cannot turn every flag-mode challenge into something any
 *  key holder can assert.
 *
 *  `dryRun` runs every gate and writes NOTHING, so an organizer can test a
 *  live integration without awarding points. Its answer is advisory by
 *  definition: the real path re-checks the same conditions inside the script. */
export async function awardAiEvent(
  login: string,
  challengeId: string,
  opts: { dryRun?: boolean; preview?: boolean } = {},
): Promise<AiSubmitResult> {
  if (!AI_ID_RE.test(challengeId)) return { ok: false, reason: "invalid" };
  // `preview` (a token minted for an admin before launch) is always a
  // dry run AND is graded while scoring is closed. A plain `dryRun` (the
  // external side's Send test) still honours the schedule, as documented.
  const preview = opts.preview === true;

  const { settings, cooldownSec } = await resolveSettings();
  // A signed event has no wrong answer, so the cooldown never applies to it —
  // passing 0 keeps a contestant's flag-path cooldown from blocking a solve
  // the external system already granted.
  const gate = await evaluateGate(settings, login, challengeId, 0, preview);
  if (!gate.allowed) return gateToResult(gate);

  // A dry run goes through the SAME script, told to write nothing —
  // so its missing/mode/already checks apply exactly as on a real award.
  if (opts.dryRun || preview) return runAward(login, challengeId, "", cooldownSec, false, "event", true);

  return runAward(login, challengeId, "", cooldownSec, false, "event");
}

// ---------------------------------------------------------------------------
// Bundle export/import — the ai half of the whole-event archive.
// Mirrors classic-store.ts's `exportBundle`/`importBundle` contract exactly;
// see ai-io.ts for the bundle shape and the rules a bundle must satisfy.

/** The current ai catalogue in the shape `importBundle` accepts — so
 *  exporting then re-importing round-trips, which is what makes an export
 *  usable as a backup. Reads the admin-gated list (WITH each flag AS AUTHORED,
 *  each hint and each signing key) and the category list. Optional fields are
 *  emitted only when set, so a board with no hints, no case-sensitive
 *  challenge or no event-only challenge exports without a field appearing on
 *  every row.
 *
 *  Sequential rather than `Promise.all`, so the two reads are issued in a
 *  fixed order — the only order a test with a scripted pipeline can rely on.
 *
 *  Never reads `ctf:ai:launchkey`: the launch keypair is module identity, not
 *  catalogue content, and a bundle must not carry it (see ai-io.ts). */
export async function exportBundle(): Promise<AiBundle> {
  const rows = await listAiChallengesForAdmin();
  const categories = await listAiCategories();
  const challenges: AiBundleChallenge[] = rows.map(({ challenge, flag, hint, signingKey }) => {
    const graded = challenge.mode !== "event";
    // A graded row with no flag row is corrupt data (`upsertAiChallenge` never
    // writes one): exporting it would silently produce a bundle ai-io.ts
    // refuses on import. Fail here, naming the challenge, so the organizer
    // fixes the row instead of discovering the archive is dead at restore time.
    if (graded && !flag) {
      throw new Error(
        `cannot export the ai catalogue: challenge ${challenge.id} is graded (mode "${challenge.mode}") but has no flag — edit it in the admin panel first`,
      );
    }
    return {
      id: challenge.id,
      title: challenge.title,
      category: challenge.category,
      description: challenge.description,
      points: challenge.points,
      order: challenge.order,
      mode: challenge.mode,
      urlTemplate: challenge.urlTemplate,
      ...(challenge.caseSensitive ? { caseSensitive: true as const } : {}),
      // Emitted by MODE, not by presence: ai-io.ts refuses a flag on an
      // event-only row, so a stale flag row on one must not leak into the file.
      ...(graded ? { flag } : {}),
      ...(hint ? { hint } : {}),
      // `""` marks a legacy row whose key was never minted; omitted so the
      // import mints one rather than refusing the whole bundle.
      ...(signingKey ? { signingKey } : {}),
    };
  });
  return { version: AI_BUNDLE_VERSION, categories, challenges };
}

export type AiImportSummary = { created: number; updated: number; categories: number };

/** Bulk upsert of an already-PARSED bundle (`parseBundle` in ai-io.ts has
 *  validated every row). Categories are unioned onto the existing list —
 *  existing order kept verbatim, bundle additions appended, case-insensitive
 *  — and every challenge's `category` is canonicalized to the surviving
 *  spelling, the same invariant classic's import keeps. Challenges are
 *  written field by field the way `upsertAiChallenge` writes them: the record
 *  never carries a flag; a graded row gets its flag, comparison form and
 *  hint HSET (or HDEL when unset); an event-only row gets all three HDELed so
 *  a later mode change cannot resurrect a stale flag.
 *
 *  Signing keys: a key the bundle carries is restored verbatim (HSET) — that
 *  is the point of carrying it, an integrator configured against it keeps
 *  working after a restore. A row without one is minted a key with HSETNX,
 *  which preserves any key already on the box for that id rather than
 *  rotating it silently (the same never-rotate-on-edit rule `upsertAiChallenge`
 *  holds). Everything lands in ONE pipeline.
 *
 *  Never touches `ctf:ai:launchkey`, for the reason `clearAiChallenges`
 *  gives: rotating module identity on an import would break every deployed
 *  verifier. The archive's replace-all clears the catalogue first
 *  (`clearAiChallenges`) and then calls this; standalone, this is a merge. */
export async function importBundle(bundle: AiBundle): Promise<AiImportSummary> {
  const [idsRes, categoriesRes] = await upstashPipeline([
    ["HKEYS", CHALLENGES_KEY],
    ["GET", CATEGORIES_KEY],
  ]);

  // Both reads must have succeeded before anything is written. A failed GET
  // would otherwise read as "no categories yet", and the SET below would then
  // replace the box's whole category list with only the bundle's — a transient
  // read error turned into data loss. Same refusal `upsertAiChallenge` makes
  // when its HGET is unusable.
  const failedRead = [idsRes, categoriesRes].find((r) => r.error);
  if (failedRead) throw new Error(`Upstash read failed before import: ${failedRead.error}`);

  const existingIds = new Set(Array.isArray(idsRes.result) ? (idsRes.result as string[]) : []);

  let existingCategories: string[] = [];
  if (typeof categoriesRes.result === "string") {
    try {
      const parsed = JSON.parse(categoriesRes.result) as unknown;
      if (Array.isArray(parsed)) existingCategories = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      existingCategories = [];
    }
  }

  const unioned = [...existingCategories];
  const seen = new Set(existingCategories.map((name) => name.toLowerCase()));
  for (const name of bundle.categories) {
    const fold = name.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    unioned.push(name);
  }
  const canon = new Map(unioned.map((name) => [name.toLowerCase(), name]));

  let created = 0;
  let updated = 0;
  const commands: (string | number)[][] = [];
  for (const c of bundle.challenges) {
    if (existingIds.has(c.id)) updated += 1;
    else created += 1;

    // The parser already accepted the template; re-running the check here is
    // what yields the NORMALIZED value `upsertAiChallenge` would have stored.
    const template = validateUrlTemplate(c.urlTemplate);
    if (!template.ok) throw new AiValidationError("urlTemplate", template.reason);

    const record: AiChallenge = {
      id: c.id,
      title: c.title.trim(),
      category: canon.get(c.category.toLowerCase()) ?? c.category,
      description: c.description,
      points: c.points,
      order: c.order,
      mode: c.mode,
      urlTemplate: template.value,
      ...(c.caseSensitive ? { caseSensitive: true as const } : {}),
    };
    commands.push(["HSET", CHALLENGES_KEY, c.id, JSON.stringify(record)]);

    const graded = c.mode !== "event";
    const flag = graded && typeof c.flag === "string" ? c.flag.trim() : "";
    if (graded && !flag) throw new AiValidationError("flag", "A flag is required unless the challenge is event-only");
    commands.push(graded ? ["HSET", FLAG_KEY, c.id, flag] : ["HDEL", FLAG_KEY, c.id]);
    commands.push(
      graded ? ["HSET", FLAGNORM_KEY, c.id, flagComparisonForm(flag, record.caseSensitive)] : ["HDEL", FLAGNORM_KEY, c.id],
    );

    const hint = typeof c.hint === "string" && c.hint.trim() ? c.hint.trim() : null;
    commands.push(hint ? ["HSET", HINTS_KEY, c.id, hint] : ["HDEL", HINTS_KEY, c.id]);

    commands.push(
      c.signingKey ? ["HSET", SIGNKEY_KEY, c.id, c.signingKey] : ["HSETNX", SIGNKEY_KEY, c.id, generateSigningKey()],
    );
  }
  commands.push(["SET", CATEGORIES_KEY, JSON.stringify(unioned)]);

  const results = await upstashPipeline(commands);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash bulk import failed: ${failed.error}`);

  return { created, updated, categories: bundle.categories.length };
}
