import "server-only";
import { upstashPipeline } from "@/lib/upstash";
import { getSyncStatus } from "@/lib/admin-store";
import { secureDevAvailable } from "@/lib/module-defaults";
import { errorLabel } from "@/lib/error-label";

/**
 * The probe behind `GET /health/deep` (issue #437).
 *
 * `/health` is liveness: it must answer 200 whenever the Node process serves
 * requests, because Fly's machine check acts on it and restarting the only
 * machine over a Redis blip is worse than the blip. This is the other
 * question — "can this box actually score right now?" — for the other
 * audience: an external monitor. The failure it exists to catch is the one
 * this kit is DESIGNED to hide from contestants: every fail-open read keeps
 * the site rendering while nothing scores, so the first person to notice a
 * dead Redis or scorer would otherwise be a contestant asking why the board
 * stopped moving.
 *
 * DISCLOSURE CONTRACT. The route is public — a free uptime tier cannot send a
 * header — so this payload lives under /health's rule: nothing an attacker
 * could not already read from the repo. Each dependency is reported as
 * exactly "ok" or "down". The reason (which host refused, which error Redis
 * returned) goes to the server log via `errorLabel` and NEVER into the body.
 * A test pins that no error text, host or URL can reach the payload.
 *
 * WHAT IS PROBED. Redis through srh (`PING` — the same path every read takes)
 * and, only when this deployment has a scorer (`SCORE_IMAGE` set), the
 * scorer's own `/healthz`. On a box with no scorer those keys are ABSENT,
 * not "ok": a check that vouched for a service that does not exist is the
 * vacuous pass this repo already guards against in its scoring tests. The
 * sync poller is REPORTED (age of `lastPollAt`) but never failed on — decided
 * in the brainstorm: a quiet poller is worth seeing, not paging on.
 *
 * COST CAP. Every call costs a Redis round trip and a scorer HTTP call, and
 * the URL is unauthenticated, so it is a small amplifier. Results are cached
 * in-process for `DEEP_HEALTH_CACHE_MS`, degraded ones included: a monitor
 * polling every 30 s plus a room refreshing must not turn a dead scorer into
 * a probe storm against it.
 */

export type DependencyState = "ok" | "down";

export type DeepHealth = {
  status: "ok" | "degraded";
  redis: DependencyState;
  /** Present only when `SCORE_IMAGE` is set. */
  scorer?: DependencyState;
  /** Present only when `SCORE_IMAGE` is set. Informational — never fails the check. */
  sync?: { lastPollAt: string | null; ageSec: number | null };
};

export const DEEP_HEALTH_CACHE_MS = 10_000;
/** Short on purpose: a dependency that takes longer than this to say "ok"
 *  is not ok for a contestant either. */
export const PROBE_TIMEOUT_MS = 2_000;

let cached: { at: number; result: DeepHealth } | null = null;
/** The probe currently running, if any. Concurrent callers that miss the
 *  cache share it instead of each launching their own round: a monitor and a
 *  room of refreshes landing in the same second is one probe, not N. */
let inflight: Promise<DeepHealth> | null = null;

/** Test seam. Module state is the whole point of the cache, so tests reset it. */
export function resetDeepHealthCache(): void {
  cached = null;
  inflight = null;
}

async function probeRedis(): Promise<DependencyState> {
  try {
    const [reply] = await upstashPipeline([["PING"]], { timeoutMs: PROBE_TIMEOUT_MS });
    // upstashPipeline returns per-command errors as values, not throws
    // (NOAUTH, WRONGTYPE) — an error reply to PING is not a PONG.
    if (!reply || reply.error) {
      console.error("[health/deep] redis PING failed:", reply?.error ?? "no reply");
      return "down";
    }
    return "ok";
  } catch (err) {
    console.error("[health/deep] redis unreachable:", errorLabel(err));
    return "down";
  }
}

async function probeScorer(env: Record<string, string | undefined>): Promise<DependencyState> {
  const base = env.LEADERBOARD_API_URL;
  if (!base) {
    // A scorer image with no URL to reach it is a misconfiguration this
    // check should surface, not a "no scorer" that hides the key.
    console.error("[health/deep] SCORE_IMAGE is set but LEADERBOARD_API_URL is not");
    return "down";
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/healthz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[health/deep] scorer /healthz answered HTTP ${res.status}`);
      return "down";
    }
    return "ok";
  } catch (err) {
    console.error("[health/deep] scorer unreachable:", errorLabel(err));
    return "down";
  }
}

async function readSyncAge(now: number): Promise<{ lastPollAt: string | null; ageSec: number | null }> {
  try {
    const status = await getSyncStatus();
    const lastPollAt = status?.lastPollAt ?? null;
    if (!lastPollAt) return { lastPollAt: null, ageSec: null };
    const ms = Date.parse(lastPollAt);
    if (Number.isNaN(ms)) return { lastPollAt, ageSec: null };
    return { lastPollAt, ageSec: Math.max(0, Math.floor((now - ms) / 1000)) };
  } catch (err) {
    // Informational only, and Redis being down is already reported above.
    console.error("[health/deep] sync status unreadable:", errorLabel(err));
    return { lastPollAt: null, ageSec: null };
  }
}

/**
 * Probe every dependency (or serve the cached answer). `now` and `env` are
 * parameters for the tests; production callers pass nothing.
 */
export async function probeDeepHealth(
  now: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): Promise<DeepHealth> {
  if (cached && now - cached.at < DEEP_HEALTH_CACHE_MS) return cached.result;
  if (inflight) return inflight;

  inflight = probeAll(now, env)
    .then((result) => {
      cached = { at: now, result };
      return result;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function probeAll(now: number, env: Record<string, string | undefined>): Promise<DeepHealth> {
  const hasScorer = secureDevAvailable(env);
  const [redis, scorer, sync] = await Promise.all([
    probeRedis(),
    hasScorer ? probeScorer(env) : Promise.resolve(undefined),
    hasScorer ? readSyncAge(now) : Promise.resolve(undefined),
  ]);

  const healthy = redis === "ok" && (scorer === undefined || scorer === "ok");
  const result: DeepHealth = { status: healthy ? "ok" : "degraded", redis };
  if (scorer !== undefined) result.scorer = scorer;
  if (sync !== undefined) result.sync = sync;
  return result;
}
