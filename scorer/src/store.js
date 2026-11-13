// Solve store: one Redis hash per target, one field per (player, challenge).
// Writes are monotonic — HSETNX semantics keep the FIRST solve timestamp and
// make replays no-ops. Reads are one HGETALL per known target. The memory
// store mirrors the same contract for tests/dev.

export const solvesKey = (target) => `ctf:solves:${target}`;
const solveField = (player, id) => `${player}:${id}`;
// The player's deletion cutoff, epoch milliseconds, written by apps/web
// admin-ops-store.ts deleteUser BEFORE it clears the player's solves:
// `pending:<ms>` while the delete runs, `<ms>` once the player's record is
// gone, and put back to its earlier value if the delete fails with the player
// still there. A score timed before it belongs to the deleted player: sync
// may have read it before the delete and reach the scorer after the clear.
// While pending it gets a retry (the delete may still fail and the player
// stay); once final it is refused for good. A score timed after it is the
// same account playing again and counts. Read in the same script as the
// write, so the delete cannot slip between the two. A value that is not a
// cutoff refuses every score: it cannot say where the cut is. Keep the key
// and values in step with DELETED_PREFIX and DELETE_PENDING_PREFIX there.
export const deletedKey = (player) => `ctf:deleted:${player}`;
// KEYS[1]=solves hash KEYS[2]=deletion cutoff
// ARGV[1]=at (ISO) ARGV[2]=at (epoch ms) ARGV[3..]=fields.
// 'deleted' / 'pending' = nothing written; 'written' = HSETNX (replays no-op).
const RECORD_SOLVES_SCRIPT = `local c = redis.call('GET', KEYS[2])
if c then
  local pend = string.match(c, '^pending:(%d+)$')
  local cut = tonumber(pend or c)
  if not cut then return 'deleted' end
  if tonumber(ARGV[2]) < cut then
    if pend then return 'pending' end
    return 'deleted'
  end
end
for i = 3, #ARGV do redis.call('HSETNX', KEYS[1], ARGV[i], ARGV[1]) end
return 'written'`;
// Same key/field the app (admin-store.ts) writes and the sync poller
// (sync/src/redis.js) reads — "1" means paused, anything else does not.
const ADMIN_SETTINGS_KEY = "ctf:admin:settings";
// The manual freeze's closed intervals, newest first, one JSON {from, to} per
// entry. apps/web admin-store.ts writes it atomically with the `paused` flag.
const ADMIN_PAUSES_KEY = "ctf:admin:pauses";

// Generic scheduled window: true when `now` is before start / after end.
// Absent or unparseable bounds are ignored (no bound) — the registration
// window's rule; scoring goes through outsideScoringWindow below. Mirrors
// apps/web schedule-window.ts outsideWindow and sync/src/redis.js — change
// all three together; test/fixtures/window-corpus.json pins them.
export function outsideWindow(nowMs, startsAt, endsAt) {
  const s = startsAt ? Date.parse(startsAt) : NaN;
  const e = endsAt ? Date.parse(endsAt) : NaN;
  if (Number.isFinite(s) && nowMs < s) return true;
  if (Number.isFinite(e) && nowMs > e) return true;
  return false;
}

// The SCORING window: outsideWindow plus a REQUIRED start (issue #464 —
// every event needs an official launch). An absent or unparseable
// scoringStartsAt means "not launched", so scoring is closed. The generic
// outsideWindow keeps "absent bound = open" for the registration window.
// Mirrors apps/web schedule-window.ts and sync/src/redis.js — change all
// three together; test/fixtures/scoring-window-corpus.json pins them.
export function outsideScoringWindow(nowMs, startsAt, endsAt) {
  const s = startsAt ? Date.parse(startsAt) : NaN;
  if (!Number.isFinite(s)) return true;
  return outsideWindow(nowMs, startsAt, endsAt);
}

// Whether the manual freeze covered the instant `tMs`: inside a closed
// interval [from, to) from the pause log, or at or after the start of the
// pause still open. An open pause whose start is absent or unparseable covers
// every instant (when it began is unknown); a log entry that does not parse
// covers nothing. Mirrors apps/web schedule-window.ts and sync/src/redis.js
// — change all three together; test/fixtures/pause-interval-corpus.json pins
// them.
export function pausedAt(tMs, paused, pausedSince, pauses) {
  if (paused) {
    const since = pausedSince ? Date.parse(pausedSince) : NaN;
    if (!Number.isFinite(since) || tMs >= since) return true;
  }
  for (const raw of pauses ?? []) {
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    const from = typeof entry?.from === "string" ? Date.parse(entry.from) : NaN;
    const to = typeof entry?.to === "string" ? Date.parse(entry.to) : NaN;
    if (Number.isFinite(from) && Number.isFinite(to) && tMs >= from && tMs < to) return true;
  }
  return false;
}

export function createMemoryStore({ teams = [] } = {}) {
  const hashes = new Map(); // key -> Map(field -> ISO timestamp)
  let paused = false; // test seam mirroring ctf:admin:settings.paused
  // No event settings to judge a score's time against until a test sets
  // some — the same answer the Redis store gives when it cannot read them.
  let policy = null;
  const deleted = new Map(); // test seam mirroring ctf:deleted:<player> (cutoff ms)
  return {
    async recordSolves(target, player, ids, at) {
      // As the script: `pending:<ms>` answers a retry, `<ms>` a refusal, and
      // a value that is neither refuses every score.
      const raw = deleted.get(player);
      if (raw !== undefined) {
        const m = /^pending:(\d+)$/.exec(String(raw));
        const cut = Number(m ? m[1] : raw);
        if (!Number.isFinite(cut)) return "deleted";
        if (Date.parse(at) < cut) return m ? "pending" : "deleted";
      }
      let hash = hashes.get(solvesKey(target));
      if (!hash) hashes.set(solvesKey(target), (hash = new Map()));
      for (const id of ids) {
        const field = solveField(player, id);
        if (!hash.has(field)) hash.set(field, at); // HSETNX: replays no-op
      }
      return "written";
    },
    __markDeleted(player, cutoffMs) {
      deleted.set(player, cutoffMs);
    },
    async getSolves(target) {
      return Object.fromEntries(hashes.get(solvesKey(target)) ?? []);
    },
    async isPaused() {
      return paused;
    },
    __setPaused(v) {
      paused = v;
    },
    async readScoringPolicy() {
      return policy;
    },
    __setPolicy(v) {
      policy = v;
    },
    // Test seam mirroring the redis store's getTeams(): tests inject teams
    // via the `teams` option (see createMemoryStore({ teams: [...] })) since
    // this store has no ctf:team:* data of its own to read.
    async getTeams() {
      return teams.map((t) => ({ ...t, members: [...t.members].sort() }));
    },
  };
}

// Upstash REST / SRH client — same wire protocol as apps/web/src/lib/upstash.ts:
// How long one /pipeline round trip may take before it counts as a failed
// read/write. A backend that accepts the connection and never answers would
// otherwise hang the request — and, for isPaused, hang every POST /score
// behind it. Well above any healthy SRH/Redis latency. Same constant as
// sync/src/redis.js.
const PIPELINE_TIMEOUT_MS = 10_000;

/** The loggable part of a Redis error reply. Redis's unknown-command error
 *  echoes the command's own arguments ("…, with args beginning with: …");
 *  those are whatever the caller sent, so the tail is dropped and the rest
 *  capped before it can reach a log line or an error body. Same rule as
 *  sync/src/redis.js. */
export function redisErrorText(error) {
  return String(error).replace(/,?\s*with args beginning with:.*$/s, "").slice(0, 200);
}

/** The Redis-backed solve store: POST /pipeline with a JSON array of command
 *  arrays, bearer token; results come back positionally as { result } or
 *  { error }. Solve persistence uses one EVAL (HSETNX behind the deletion
 *  marker) + HGETALL; the pause reads use
 *  HMGET and LRANGE, and the team read SCAN, HGET and SMEMBERS — all within the subset
 *  SRH's env mode supports. `fetchImpl`, `log` and `timeoutMs` are seams. */
export function createRedisStore({
  url = process.env.UPSTASH_REDIS_REST_URL,
  token = process.env.UPSTASH_REDIS_REST_TOKEN,
  fetchImpl = fetch,
  log = console.error,
  timeoutMs = PIPELINE_TIMEOUT_MS,
} = {}) {
  if (!url || !token) throw new Error("UPSTASH_REDIS_REST_URL/TOKEN are not set");
  const base = url.replace(/\/$/, "");

  /** One POST /pipeline round trip; throws on HTTP failure, timeout, or any
   *  per-command error, so callers only ever see results or an exception. */
  async function pipeline(commands) {
    const res = await fetchImpl(`${base}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`upstash pipeline: HTTP ${res.status}`);
    const results = await res.json();
    const bad = results.find((r) => r.error);
    if (bad) throw new Error(`upstash: ${redisErrorText(bad.error)}`);
    return results.map((r) => r.result);
  }

  return {
    // "written", or "pending"/"deleted" for a score timed before the player's
    // deletion cutoff while the delete runs / once it is done (nothing
    // written). One script, so the cutoff check and the
    // writes cannot be split by the delete.
    async recordSolves(target, player, ids, at) {
      if (ids.length === 0) return "written";
      const atMs = Date.parse(at);
      if (!Number.isFinite(atMs)) throw new Error("recordSolves: at is not a time");
      const keys = [solvesKey(target), deletedKey(player)];
      const fields = ids.map((id) => solveField(player, id));
      const [outcome] = await pipeline([["EVAL", RECORD_SOLVES_SCRIPT, keys.length, ...keys, at, String(atMs), ...fields]]);
      if (outcome !== "written" && outcome !== "pending" && outcome !== "deleted") {
        throw new Error(`recordSolves: unexpected script reply ${JSON.stringify(outcome).slice(0, 40)}`);
      }
      return outcome;
    },
    async getSolves(target) {
      const [raw] = await pipeline([["HGETALL", solvesKey(target)]]);
      // REST HGETALL returns a flat [field, value, ...] array.
      const out = {};
      if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i += 2) out[raw[i]] = raw[i + 1];
      } else if (raw && typeof raw === "object") {
        Object.assign(out, raw);
      }
      return out;
    },
    async isPaused() {
      try {
        // Effective freeze = the manual toggle OR the scheduled scoring window
        // (not launched — no start — / before start / after end). Mirrors
        // apps/web admin-store's
        // effectivePaused + sync/src/redis.js — keep the three in lockstep.
        const [row] = await pipeline([
          ["HMGET", ADMIN_SETTINGS_KEY, "paused", "scoringStartsAt", "scoringEndsAt"],
        ]);
        const [paused, startsAt, endsAt] = Array.isArray(row) ? row : [];
        if (paused === "1") return true;
        return outsideScoringWindow(Date.now(), startsAt, endsAt);
      } catch (err) {
        // Fail OPEN, not closed: this is a live-scoring endpoint, not an
        // authz gate. A Redis blip must never silently drop real submissions
        // just because the pause check itself couldn't be answered — the
        // freeze is a deliberate organizer action, not the safe default.
        // Open, but never silent: sync/src/redis.js logs the same failure,
        // and an operator reading this stream must see the outage too.
        log(`redis isPaused: ${err.message}`);
        return false;
      }
    },
    // Everything a score's time is judged against: the freeze flag and the
    // start of the pause still open, the scoring window, the master-reset
    // epoch, and the pause log. Null when it cannot be read, and the caller
    // records the score — the same fail-OPEN direction as isPaused, for the
    // same reason: a Redis blip must not drop a live submission.
    async readScoringPolicy() {
      try {
        const [row, pauses] = await pipeline([
          ["HMGET", ADMIN_SETTINGS_KEY, "paused", "pausedSince", "scoringStartsAt", "scoringEndsAt", "resetAt"],
          ["LRANGE", ADMIN_PAUSES_KEY, 0, -1],
        ]);
        const [p, pausedSince, startsAt, endsAt, resetAt] = Array.isArray(row) ? row : [];
        return {
          paused: p === "1",
          pausedSince: pausedSince ?? null,
          startsAt: startsAt ?? null,
          endsAt: endsAt ?? null,
          resetAt: resetAt ?? null,
          pauses: Array.isArray(pauses) ? pauses : [],
        };
      } catch (err) {
        log(`redis readScoringPolicy: ${err.message}`);
        return null;
      }
    },
    // Reads the app's team data (apps/web writes ctf:team:<slug> hash +
    // ctf:team:<slug>:members set). SCAN discovers slugs from the :members
    // keys (a team always has one, even with zero members) since there's no
    // index of slugs; then one pipeline of HGET/SMEMBERS per slug.
    async getTeams() {
      // SCAN may repeat a key within a page or across pages.
      const seen = new Set();
      let cursor = "0";
      do {
        const [res] = await pipeline([
          ["SCAN", cursor, "MATCH", "ctf:team:*:members", "COUNT", 1000],
        ]);
        const [nextCursor, keys] = res;
        cursor = String(nextCursor);
        for (const key of keys ?? []) {
          seen.add(key.replace(/^ctf:team:/, "").replace(/:members$/, ""));
        }
      } while (cursor !== "0");

      const slugs = [...seen];
      if (slugs.length === 0) return [];

      const commands = slugs.flatMap((slug) => [
        ["HGET", `ctf:team:${slug}`, "name"],
        ["HGET", `ctf:team:${slug}`, "captain"],
        ["SMEMBERS", `ctf:team:${slug}:members`],
      ]);
      const results = await pipeline(commands);
      return slugs.map((slug, i) => {
        const [name, captain, members] = results.slice(i * 3, i * 3 + 3);
        return {
          slug,
          name: name || slug,
          captain,
          members: [...(members ?? [])].sort(),
        };
      });
    },
  };
}
