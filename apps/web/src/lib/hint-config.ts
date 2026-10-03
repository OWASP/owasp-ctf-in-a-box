import "server-only";
import { getAdminSettings } from "@/lib/admin-store";
import { HINT_COST, HINT_DEFAULT_ENABLED, HINT_MIN_SOLVES, HINT_UNLOCK_AFTER_MIN } from "@/lib/hint-defaults";
import { HINTS_SPENT_KEY } from "@/lib/team-keys";
import { upstashPipeline } from "@/lib/upstash";

/**
 * The hint policy reads that the LEADERBOARD needs as well as the store:
 * whether hints can work here at all, the organizer's effective config, and
 * the per-login penalty map.
 *
 * Split out of `hint-store.ts` (#553) because the folded leaderboard's last
 * stage (`leaderboard/hint-penalties.ts`) imports these, and the store now
 * imports the fold (through `hint-balance.ts`) for the affordability gate —
 * one module cannot sit on both sides of that without a cycle.
 * `hint-store.ts` re-exports everything here, so its callers are unchanged;
 * only the leaderboard imports this module directly.
 */

/** CAPABILITY, not policy: whether hints *can* work at all here. Hint text
 *  lives only in Upstash, so without credentials there is nothing to read and
 *  nothing to charge for — no organizer setting can make hints function.
 *  (Read/write is needed, since revealing writes to Redis; that is already
 *  required for TEAM_WRITES_ENABLED.)
 *
 *  Policy — whether an organizer WANTS hints on — is a separate question,
 *  answered by `/admin` on top of `HINT_DEFAULT_ENABLED`. Keeping the two
 *  apart is what lets every read path ask one question and get the same
 *  answer. Check this first where it saves a Redis round-trip: a deployment
 *  with no credentials can never have hints, so there is no point reading
 *  settings to find that out. */
export const HINTS_AVAILABLE = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);

/** Resolves the effective hint config for this request: an admin override
 *  (Task 1's `getAdminSettings`) wins when set, else the baked default.
 *  `??` (not `||`) so an explicit `false`/`0` override beats an "on" default.
 *
 *  This is the SINGLE answer to "are hints on right now". Every read path
 *  goes through it — purchase, page furniture, and leaderboard penalties
 *  alike — so the /admin toggle cannot be true for one and false for another.
 *  It previously governed purchasing only, while three other paths consulted
 *  a module-level env constant, so turning hints off blocked buying but left
 *  the buttons and the penalty column on screen. */
export async function resolveHintConfig(): Promise<{
  enabled: boolean;
  cost: number;
  minSolves: number;
  unlockAfterMin: number;
  scoringStartsAt: string | null;
}> {
  const s = await getAdminSettings();
  return {
    // Capability AND policy. An organizer can turn hints off; no organizer
    // setting can turn them on without the credentials that store the text.
    enabled: HINTS_AVAILABLE && (s.hintsEnabled ?? HINT_DEFAULT_ENABLED),
    cost: s.hintCost ?? HINT_COST,
    minSolves: s.hintsMinSolves ?? HINT_MIN_SOLVES,
    unlockAfterMin: s.hintsUnlockAfterMin ?? HINT_UNLOCK_AFTER_MIN,
    scoringStartsAt: s.scoringStartsAt,
  };
}

/** What the challenges page's hint banner needs: whether to show it, and the
 *  organizer's configured price.
 *
 *  Exists so the page never calls `resolveHintConfig` directly. That reads
 *  admin settings, and `upstashPipeline` THROWS when the Upstash credentials
 *  are absent — which would 500 `/challenges` on any deployment without
 *  Redis. Capability first, same as every other read path here: no
 *  credentials means hints are off and there is nothing to ask Redis. */
export async function getHintNotice(): Promise<{ active: boolean; cost: number }> {
  if (!HINTS_AVAILABLE) return { active: false, cost: HINT_COST };
  const { enabled, cost } = await resolveHintConfig();
  return { active: enabled, cost };
}

/** Penalty points per login — one HGETALL serves the whole leaderboard. */
export async function getHintPenalties(): Promise<Map<string, number>> {
  if (!HINTS_AVAILABLE) return new Map();
  // Hints off => no penalty column. Already-spent points stay recorded in
  // Redis, so re-enabling restores them rather than forgiving them.
  if (!(await resolveHintConfig()).enabled) return new Map();

  const [res] = await upstashPipeline([["HGETALL", HINTS_SPENT_KEY]]);
  // An errored read is not "nobody bought a hint" (#523): throw, so
  // withHintPenalties logs it instead of the board silently going gross.
  if (res.error !== undefined) throw new Error(`hint penalties read failed: ${res.error}`);
  const flat = Array.isArray(res.result) ? (res.result as string[]) : [];
  const penalties = new Map<string, number>();
  for (let i = 0; i < flat.length; i += 2) {
    const points = Number(flat[i + 1]);
    if (Number.isFinite(points) && points > 0) penalties.set(flat[i], points);
  }
  return penalties;
}
