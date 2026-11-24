export const SCHEMA_VERSION_KEY = "ctf:meta:schema-version";
export const CURRENT_SCHEMA_VERSION = "2";

// Solve store: one Redis hash per target, one field per (player, challenge).
// Writes are monotonic — a solve keeps its EARLIEST timestamp, whatever order
// the scores arrive in, and a replay is a no-op. Reads are one HGETALL per known target. The memory
// store mirrors the same contract for tests/dev.

export const solvesKey = (target) => `ctf:solves:${target}`;
const solveField = (player, id) => `${player}:${id}`;
// Same key/field the app (admin-store.ts) writes and the sync poller
// (sync/src/redis.js) reads — "1" means paused, anything else does not.
const ADMIN_SETTINGS_KEY = "ctf:admin:settings";
// The manual freeze's closed intervals, newest first, one JSON {from, to} per
// entry. apps/web admin-store.ts writes it atomically with the `paused` flag.
const ADMIN_PAUSES_KEY = "ctf:admin:pauses";
// A player's score hold, a set of tokens: apps/web's deleteUser adds one
// before it deletes anything (and leaves it once the account row is gone),
// unlinkGithub adds one for the length of the unlink. Only its existence is
// read here, whatever its type.
export const scoreHoldKey = (player) => `ctf:score-hold:${player}`;
// The better-auth user rows hash, field = player id: apps/web
// auth-store/keys.ts rowsKey(AUTH_PREFIX, "user"). Both sides pin this literal.
export const AUTH_USER_ROWS_KEY = "ctf:auth:user";

// A GitHub login's link to a player: apps/web github-link.ts LINK_GITHUB_PREFIX
// and sync/src/redis.js resolve the same key, the login lowercased.
export const LINK_GITHUB_PREFIX = "ctf:link:github:";

// The solve write, judged against the master-reset epoch and the score hold
// in the same EVAL, so no reset, delete or unlink can land between the checks
// and the write.
//
// The reset check comes first and reads `resetAt` from the settings hash at
// write time, not the value the judge read: a score timed before the CURRENT
// epoch is 'pre-reset' (final, nothing written), so a score judged before a
// master reset and written after its sweep cannot bring a solve back, with or
// without a login and whatever the links did meanwhile. resetEvent writes the
// epoch before it sweeps a solve. The app writes the epoch as epoch
// milliseconds (all digits), compared here with the score's time in ms. Then
// any epoch other than the one the caller judged the score against (ARGV[5])
// is 'stale' (nothing written, the caller retries and judges again): a score
// timed after a reset that landed since the judge, which a clock-skewed `at`
// up to five minutes ahead can be, is judged against the new event's freeze
// and window rather than written into it.
//
// Then the hold: a hold with the account row still present is a delete or
// unlink in progress ('pending': write nothing, the caller retries and
// re-resolves the link); a hold with the row gone is a deleted player
// ('deleted': refused for good). Then, when the caller names the login it
// resolved the player from (ARGV[3] non-empty), the link must still name this
// player: one that moved or went since the resolution (an unlink or delete
// that finished, a delete-all's link sweep) is 'unlinked', nothing written,
// and the caller retries and re-resolves. Otherwise each `<player>:<id>` keeps
// the earlier of its stored time and this one: sync presents verdicts in
// comment-edit order, which is not always the order they were judged in, so
// first-written is not first-earned. A replay is a no-op. Times are compared as
// strings, which orders them because serve.js normalizes every `at` with
// toISOString().
// KEYS: [1] ctf:solves:<target>, [2] ctf:score-hold:<player>, [3] ctf:auth:user,
// [4] ctf:link:github:<login> (any key when ARGV[3] is empty),
// [5] ctf:admin:settings
// ARGV: [1] player, [2] at (ISO), [3] lowercased login or '', [4] at as epoch
// ms, [5] the resetAt the caller judged the score against or '', [6..]
// challenge ids
export const RECORD_SOLVES_SCRIPT = `
local reset = redis.call('HGET', KEYS[5], 'resetAt')
if reset and reset ~= '' then
  if string.match(reset, '^%d+$') and tonumber(ARGV[4]) < tonumber(reset) then return 'pre-reset' end
  if reset ~= ARGV[5] then return 'stale' end
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then return 'pending' end
  return 'deleted'
end
if ARGV[3] ~= '' and redis.call('GET', KEYS[4]) ~= ARGV[1] then return 'unlinked' end
for i = 6, #ARGV do
  local field = ARGV[1] .. ':' .. ARGV[i]
  local cur = redis.call('HGET', KEYS[1], field)
  if not cur or ARGV[2] < cur then redis.call('HSET', KEYS[1], field, ARGV[2]) end
end
return 'ok'
`;
const SOLVE_VERDICTS = new Set(["ok", "pending", "deleted", "unlinked", "pre-reset", "stale"]);

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
  // Test seams mirroring ctf:score-hold:<player>, the ctf:auth:user rows and
  // the ctf:link:github:<login> keys (lowercased login -> player id).
  const holds = new Set();
  const users = new Set();
  const links = new Map();
  return {
    holds,
    users,
    links,
    async recordSolves(target, player, ids, at, login = "", judgedResetAt = "") {
      if (ids.length === 0) return "ok";
      const reset = typeof policy?.resetAt === "string" ? policy.resetAt : "";
      if (reset !== "") {
        if (/^\d+$/.test(reset) && Date.parse(at) < Number(reset)) return "pre-reset";
        if (reset !== judgedResetAt) return "stale";
      }
      if (holds.has(player)) return users.has(player) ? "pending" : "deleted";
      const lower = String(login).toLowerCase();
      if (lower !== "" && links.get(lower) !== player) return "unlinked";
      let hash = hashes.get(solvesKey(target));
      if (!hash) hashes.set(solvesKey(target), (hash = new Map()));
      for (const id of ids) {
        const field = solveField(player, id);
        if (!hash.has(field) || at < hash.get(field)) hash.set(field, at); // earliest wins; replays no-op
      }
      return "ok";
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

// Keep in sync with test/fixtures/v1-fingerprints.json. The scorer has
// its own copy because its Docker build context is independent of the web app.
export const V1_FINGERPRINT_PATTERNS = [
  "ctf:solves:*",
  "ctf:team:*",
  "ctf:user:*",
  "ctf:joincode:*",
  "ctf:sd:held:*",
  "ctf:relink:*",
  "ctf:hints:*",
  "ctf:quiz:answers:*",
  "ctf:quiz:attempts:*",
  "ctf:quiz:points",
  "ctf:quiz:answered",
  "ctf:quiz:lastAt",
  "ctf:classic:solves:*",
  "ctf:classic:attempts:*",
  "ctf:classic:points",
  "ctf:classic:solved",
  "ctf:classic:solvecount",
  "ctf:classic:lastAt",
  "ctf:classic:opened:*",
  "ctf:activity:log",
  "ctf:sponsors",
  "ctf:sponsors:logo",
  "ctf:adjustments",
];

/** The Redis-backed solve store: POST /pipeline with a JSON array of command
 *  arrays, bearer token; results come back positionally as { result } or
 *  { error }. Solve persistence uses EVAL (RECORD_SOLVES_SCRIPT) + HGETALL;
 *  the pause reads use HMGET and LRANGE, and the team read SCAN, HGET and
 *  SMEMBERS — all within the subset SRH's env mode supports. `fetchImpl`, `log` and `timeoutMs` are seams. */
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

  /** One EVAL through the pipeline, in the wire shape apps/web upstashEval
   *  sends; throws like `pipeline` on any error. */
  async function evalScript(script, keys, args) {
    const [result] = await pipeline([["EVAL", script, keys.length, ...keys, ...args]]);
    return result;
  }

  return {
    /** "ok" | "pending" | "deleted" | "unlinked" | "pre-reset" | "stale" — see
     *  RECORD_SOLVES_SCRIPT. `at` is the ISO solve time. `login` is the GitHub
     *  login the player was resolved from, or "" for a caller that resolved
     *  none; `judgedResetAt` is the settings' `resetAt` the score was judged
     *  against, or "". A script error or any other reply throws, so the
     *  caller answers 5xx and sync retries. */
    async recordSolves(target, player, ids, at, login = "", judgedResetAt = "") {
      if (ids.length === 0) return "ok";
      const atMs = Date.parse(at);
      if (!Number.isFinite(atMs)) throw new Error("recordSolves: unparseable at");
      const lower = String(login).toLowerCase();
      const verdict = await evalScript(
        RECORD_SOLVES_SCRIPT,
        [solvesKey(target), scoreHoldKey(player), AUTH_USER_ROWS_KEY, `${LINK_GITHUB_PREFIX}${lower}`, ADMIN_SETTINGS_KEY],
        [player, at, lower, String(atMs), judgedResetAt ?? "", ...ids],
      );
      if (!SOLVE_VERDICTS.has(verdict)) {
        throw new Error(`recordSolves: unexpected script reply ${JSON.stringify(verdict)}`);
      }
      return verdict;
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
    /**
     * Fails CLOSED: Redis marker reads, fingerprint scans, and marker writes
     * must all succeed; legacy data or unsupported schema versions refuse startup.
     */
    async ensureCompatible() {
      const readVersion = async () => {
        const [version] = await pipeline([["GET", SCHEMA_VERSION_KEY]]);
        if (version !== null && typeof version !== "string") {
          throw new Error("invalid Redis schema marker response");
        }
        return version;
      };

      const version = await readVersion();

      if (version === CURRENT_SCHEMA_VERSION) return;
      if (version !== null) {
        throw new Error(`unsupported Redis schema version: ${version}`);
      }

      for (const pattern of V1_FINGERPRINT_PATTERNS) {
        const legacyKeys = await this.findKeysByPatterns([pattern]);
        if (legacyKeys.length > 0) {
          // Another v2 service may have initialized the marker while this
          // fingerprint scan was running. Only a confirmed v2 marker makes
          // the matching key safe to ignore.
          const concurrentVersion = await readVersion();
          if (concurrentVersion === CURRENT_SCHEMA_VERSION) return;
          if (concurrentVersion !== null) {
            throw new Error(`unsupported Redis schema version: ${concurrentVersion}`);
          }

          throw new Error(
            `Incompatible Redis data detected (matching fingerprint: ${pattern}). Export required data, perform a master reset on v1, then deploy v2.`,
          );
        }
      }

      const [result] = await pipeline([
        ["SET", SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION, "NX"],
      ]);

      if (result === "OK") return;

      const concurrentVersion = await readVersion();
      if (concurrentVersion === CURRENT_SCHEMA_VERSION) return;

      throw new Error("Redis schema marker initialization failed; refusing to start");
    },
    async findKeysByPatterns(patterns) {
      const found = new Set();

      for (const pattern of patterns) {
        let cursor = "0";

        do {
          const [res] = await pipeline([
            ["SCAN", cursor, "MATCH", pattern, "COUNT", 1000],
          ]);

          if (
            !Array.isArray(res) ||
            res.length !== 2 ||
            typeof res[0] !== "string" ||
            !/^\d+$/.test(res[0]) ||
            !Array.isArray(res[1]) ||
            !res[1].every((key) => typeof key === "string")
          ) {
            throw new Error("invalid Redis SCAN response");
          }

          const [nextCursor, keys] = res;
          cursor = nextCursor;

          for (const key of keys) {
            found.add(key);
          }
        } while (cursor !== "0");
      }

      return [...found];
    },
  };
}
