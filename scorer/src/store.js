// Solve store: one Redis hash per target, one field per (author, challenge).
// Writes are monotonic — HSETNX semantics keep the FIRST solve timestamp and
// make replays no-ops. Reads are one HGETALL per known target. The memory
// store mirrors the same contract for tests/dev.

export const solvesKey = (target) => `ctf:solves:${target}`;
const solveField = (author, id) => `${author}:${id}`;
// Same key/field the app (admin-store.ts) writes and the sync poller
// (sync/src/redis.js) reads — "1" means paused, anything else does not.
const ADMIN_SETTINGS_KEY = "ctf:admin:settings";

// Scheduled scoring window: true when `now` is before start / after end.
// Absent or unparseable bounds are ignored (no bound). Mirrors apps/web
// admin-store.ts outsideWindow and sync/src/redis.js — change all three
// together.
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

export function createMemoryStore({ teams = [] } = {}) {
  const hashes = new Map(); // key -> Map(field -> ISO timestamp)
  let paused = false; // test seam mirroring ctf:admin:settings.paused
  return {
    async recordSolves(target, author, ids, at) {
      let hash = hashes.get(solvesKey(target));
      if (!hash) hashes.set(solvesKey(target), (hash = new Map()));
      for (const id of ids) {
        const field = solveField(author, id);
        if (!hash.has(field)) hash.set(field, at); // HSETNX: replays no-op
      }
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
 *  { error }. Solve persistence uses HSETNX + HGETALL; the pause read uses
 *  HMGET and the team read SCAN, HGET and SMEMBERS — all within the subset
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
    async recordSolves(target, author, ids, at) {
      if (ids.length === 0) return;
      await pipeline(ids.map((id) => ["HSETNX", solvesKey(target), solveField(author, id), at]));
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
    // Reads the app's team data (apps/web writes ctf:team:<slug> hash +
    // ctf:team:<slug>:members set). SCAN discovers slugs from the :members
    // keys (a team always has one, even with zero members) since there's no
    // index of slugs; then one pipeline of HGET/SMEMBERS per slug.
    async getTeams() {
      const slugs = [];
      let cursor = "0";
      do {
        const [res] = await pipeline([
          ["SCAN", cursor, "MATCH", "ctf:team:*:members", "COUNT", 1000],
        ]);
        const [nextCursor, keys] = res;
        cursor = String(nextCursor);
        for (const key of keys ?? []) {
          slugs.push(key.replace(/^ctf:team:/, "").replace(/:members$/, ""));
        }
      } while (cursor !== "0");

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
