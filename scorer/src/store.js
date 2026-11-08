// Solve store: one Redis hash per target, one field per (author, challenge).
// Writes are monotonic — HSETNX semantics keep the FIRST solve timestamp and
// make replays no-ops. Reads are one HGETALL per known target. The memory
// store mirrors the same contract for tests/dev.

export const solvesKey = (target) => `ctf:solves:${target}`;
const solveField = (author, id) => `${author}:${id}`;
// The projector feed (#542): the app writes app-module solves with the same
// keys and event shape (apps/web/src/lib/recent-solves.ts), and this service
// writes Secure Development solves here because it is where HSETNX tells a
// fresh solve from a replay. The event carries no login.
export const RECENT_SOLVES_KEY = "ctf:feed:recent-solves";
export const RECENT_SOLVES_DATA_KEY = "ctf:feed:recent-solves:data";
// Advanced atomically by the app's master reset. A feed write carries the
// value captured before scoring, so a solve in flight across a reset cannot
// repopulate the fresh event. Lives outside `ctf:feed:*` so the reset's
// prefix sweep leaves it for RESET_SCRIPT to advance with the wipe.
export const RECENT_SOLVES_GENERATION_KEY = "ctf:admin:feed-generation";
export const RECENT_SOLVES_MAX = 50;
const recentId = (target, id, team) => `secure-development:${target}:${id}:${team}`;
// Same atomic write as the app's RECORD_SCRIPT: reject a write captured before
// the last reset, dedupe by team + item, then trim the sorted set and its data
// hash together. KEYS: [1]=sorted set [2]=data hash [3]=reset generation.
// ARGV: id, score, event JSON, retention cap, captured generation.
export const RECENT_SCRIPT = `
local generation = redis.call('GET', KEYS[3]) or '0'
if generation ~= ARGV[5] then return -1 end
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
local last = -(tonumber(ARGV[4]) + 1)
local evicted = redis.call('ZRANGE', KEYS[1], 0, last)
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, last)
for i = 1, #evicted do redis.call('HDEL', KEYS[2], evicted[i]) end
return 1
`;
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
  const recent = new Map(); // id -> { score, event }, newest-first on read
  let feedGeneration = 0; // mirrors ctf:admin:feed-generation
  let paused = false; // test seam mirroring ctf:admin:settings.paused
  // No event settings to judge a score's time against until a test sets
  // some — the same answer the Redis store gives when it cannot read them.
  let policy = null;
  return {
    async recordSolves(target, author, ids, at) {
      let hash = hashes.get(solvesKey(target));
      if (!hash) hashes.set(solvesKey(target), (hash = new Map()));
      const added = [];
      for (const id of ids) {
        const field = solveField(author, id);
        if (!hash.has(field)) {
          hash.set(field, at); // HSETNX: replays no-op
          added.push(id);
        }
      }
      return added;
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
    async getTeamForLogin(login) {
      const normalized = String(login).trim().toLowerCase();
      const team = teams.find((t) => t.members.some((m) => String(m).toLowerCase() === normalized));
      return team ? { slug: team.slug, name: team.name || team.slug } : null;
    },
    async getFeedGeneration() {
      return String(feedGeneration);
    },
    // Test seam mirroring the app's master reset: advance the fence and clear
    // the feed in one synchronous step, exactly as RESET_SCRIPT does in Redis.
    __resetFeed() {
      feedGeneration += 1;
      recent.clear();
    },
    async recordRecentSolves(entries, generation) {
      if (generation === undefined || generation === null) return;
      if (String(generation) !== String(feedGeneration)) return;
      for (const entry of entries) {
        const id = recentId(entry.target, entry.id, entry.team);
        if (recent.has(id)) continue;
        const event = {
          module: "secure-development",
          app: entry.target,
          challengeId: entry.id,
          points: entry.points,
          team: entry.team,
          teamName: entry.teamName,
          at: entry.at,
        };
        const score = Date.parse(entry.at);
        recent.set(id, { score: Number.isFinite(score) ? score : Date.now(), event });
      }
      const kept = [...recent.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, RECENT_SOLVES_MAX);
      recent.clear();
      for (const [id, row] of kept) recent.set(id, row);
    },
    async getRecentSolves() {
      return [...recent.values()]
        .sort((a, b) => b.score - a.score)
        .map((row) => row.event);
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
 *  { error }. Solve persistence uses HSETNX + HGETALL; the pause reads use
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

  /** Fallback for a login whose casing differs from the one the app stored:
   *  membership sets hold the stored spelling, so match them case-insensitively.
   *  Only reached when the exact user-key read misses. */
  async function findTeamSlugForMember(normalized) {
    let cursor = "0";
    do {
      const [page] = await pipeline([["SCAN", cursor, "MATCH", "ctf:team:*:members", "COUNT", 1000]]);
      if (!Array.isArray(page) || page.length < 2 || !Array.isArray(page[1])) return null;
      cursor = String(page[0]);
      for (const key of page[1]) {
        if (typeof key !== "string") continue;
        const [members] = await pipeline([["SMEMBERS", key]]);
        if (!Array.isArray(members)) continue;
        if (members.some((member) => String(member).toLowerCase() === normalized)) {
          return key.replace(/^ctf:team:/, "").replace(/:members$/, "");
        }
      }
    } while (cursor !== "0");
    return null;
  }

  return {
    async recordSolves(target, author, ids, at) {
      if (ids.length === 0) return [];
      const results = await pipeline(ids.map((id) => ["HSETNX", solvesKey(target), solveField(author, id), at]));
      return ids.filter((_, i) => results[i] === 1);
    },
    async getTeamForLogin(login) {
      const normalized = String(login).trim().toLowerCase();
      const [exact] = await pipeline([["HGET", `ctf:user:${login}`, "team"]]);
      let slug = typeof exact === "string" && exact ? exact : null;
      if (!slug) slug = await findTeamSlugForMember(normalized);
      if (!slug) return null;
      const [name] = await pipeline([["HGET", `ctf:team:${slug}`, "name"]]);
      return { slug, name: typeof name === "string" && name ? name : slug };
    },
    async getFeedGeneration() {
      const [raw] = await pipeline([["GET", RECENT_SOLVES_GENERATION_KEY]]);
      return typeof raw === "string" && raw ? raw : "0";
    },
    async recordRecentSolves(entries, generation) {
      if (entries.length === 0) return;
      if (generation === undefined || generation === null) return;
      await pipeline(
        entries.map((entry) => {
          const event = {
            module: "secure-development",
            app: entry.target,
            challengeId: entry.id,
            points: entry.points,
            team: entry.team,
            teamName: entry.teamName,
            at: entry.at,
          };
          const score = Date.parse(entry.at);
          return [
            "EVAL",
            RECENT_SCRIPT,
            3,
            RECENT_SOLVES_KEY,
            RECENT_SOLVES_DATA_KEY,
            RECENT_SOLVES_GENERATION_KEY,
            recentId(entry.target, entry.id, entry.team),
            String(Number.isFinite(score) ? score : Date.now()),
            JSON.stringify(event),
            String(RECENT_SOLVES_MAX),
            String(generation),
          ];
        }),
      );
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
