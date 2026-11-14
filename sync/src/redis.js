// Minimal Upstash REST / SRH client for the sync poller — same wire protocol
// as scorer/src/store.js and apps/web/src/lib/upstash.ts: POST /pipeline with
// a JSON array of command arrays, bearer token, positional { result } replies.
import { TARGETS } from "./config.js";

const SYNC_STATUS_KEY = "ctf:sync:status";
// The poller's DURABLE state (ADR 64): per-repo `since`/ETag cursors, the seen
// cache, `ingested`/`dropped`/`lastDrop`, and the last master-reset epoch it
// applied — one JSON string. It lives next to the scores it describes, so a
// sync restart on a disk that did not survive (Fargate, a container recreated
// without its volume) resumes where it stopped instead of re-reading every
// comment. `ctf:sync:status` is the heartbeat /admin reads; this is sync's
// own and nothing else reads or writes it. The master reset leaves every
// `ctf:sync:*` key alone on purpose: it clears the cursor through the
// `resetAt` epoch instead.
export const SYNC_STATE_KEY = "ctf:sync:state";
const LINK_GITHUB_PREFIX = "ctf:link:github:";
const HELD_BY_PREFIX = "ctf:sd:held:by:";
const HELD_AUTHORS_KEY = "ctf:sd:held:authors";
const ADMIN_SETTINGS_KEY = "ctf:admin:settings";
// player id -> epoch ms the GitHub link was made (apps/web github-link.ts).
const LINK_AT_KEY = "ctf:link:at";

// KEYS[1] = ctf:sd:held:by:<login>, KEYS[2] = ctf:sd:held:authors,
// ARGV[1] = the held field, ARGV[2] = the lowercased login.
const RELEASE_HELD_SCRIPT = `redis.call('HDEL', KEYS[1], ARGV[1])
if redis.call('HLEN', KEYS[1]) == 0 then redis.call('SREM', KEYS[2], ARGV[2]) end
return 1`;

// Generic scheduled window: true when `now` is before start / after end.
// Absent/unparseable bounds are ignored — the registration window's rule;
// scoring goes through outsideScoringWindow below. Mirrors apps/web
// schedule-window.ts outsideWindow and scorer/src/store.js — change all
// three together; test/fixtures/window-corpus.json pins them.
export function outsideWindow(nowMs, startsAt, endsAt) {
  const s = startsAt ? Date.parse(startsAt) : NaN;
  const e = endsAt ? Date.parse(endsAt) : NaN;
  if (Number.isFinite(s) && nowMs < s) return true;
  if (Number.isFinite(e) && nowMs > e) return true;
  return false;
}

// The SCORING window: outsideWindow plus a REQUIRED start (issue #464 —
// every event needs an official launch). An absent or unparseable
// scoringStartsAt means "not launched", so the heartbeat reports scoring as
// paused. Mirrors apps/web
// schedule-window.ts and scorer/src/store.js — change all three together;
// test/fixtures/scoring-window-corpus.json pins them.
export function outsideScoringWindow(nowMs, startsAt, endsAt) {
  const s = startsAt ? Date.parse(startsAt) : NaN;
  if (!Number.isFinite(s)) return true;
  return outsideWindow(nowMs, startsAt, endsAt);
}

// Whether the manual freeze covered the instant `tMs`: inside a closed
// interval [from, to) from the pause log (`ctf:admin:pauses`, one JSON
// {from, to} per entry), or at or after the start of the pause still open.
// An open pause whose start is absent or unparseable covers every instant
// (when it began is unknown); a log entry that does not parse covers nothing.
// The scorer is what judges a score's comment time with it; this copy keeps
// the poller's reading of the freeze identical to the other two. Mirrors
// apps/web schedule-window.ts and scorer/src/store.js — change all three
// together; test/fixtures/pause-interval-corpus.json pins them.
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

// How long one /pipeline round trip may take before it is treated as a failed
// read. A backend that accepts the connection and never answers would
// otherwise stall the tick forever, and `restart: on-failure` cannot help a
// process that never exits. Well above any healthy SRH/Redis latency.
const PIPELINE_TIMEOUT_MS = 10_000;

/** The loggable part of a Redis error reply. Redis's unknown-command error
 *  echoes the command's own arguments ("…, with args beginning with: …");
 *  those are whatever the caller sent, so the tail is dropped and the rest
 *  capped before it can reach a log line. */
export function redisErrorText(error) {
  return String(error).replace(/,?\s*with args beginning with:.*$/s, "").slice(0, 200);
}

/** The poller's Redis client, or null when UPSTASH_REDIS_REST_URL/TOKEN are
 *  unset (main() refuses to start without one: the freeze, the targets, the
 *  durable state and the PR author links all live there). `fetchImpl`, `log` and `timeoutMs` are seams. */
export function makeRedis(env = process.env, fetchImpl = fetch, log = console.error, { timeoutMs = PIPELINE_TIMEOUT_MS } = {}) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
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
    // A per-command failure (WRONGTYPE, NOAUTH, a command SRH does not
    // implement) comes back as { error } inside a 200. Left unchecked it
    // decodes as `undefined`, which every caller would silently read as
    // "not paused" / "no reset" / "written" — the same fail-open answer,
    // minus the log line that makes an outage visible. Throw, so each
    // caller's catch applies its documented direction AND says so.
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
    async isPaused() {
      try {
        // Effective freeze = manual toggle OR scheduled scoring window
        // (including "not launched": no scoringStartsAt at all).
        const [row] = await pipeline([
          ["HMGET", ADMIN_SETTINGS_KEY, "paused", "scoringStartsAt", "scoringEndsAt"],
        ]);
        const [paused, startsAt, endsAt] = Array.isArray(row) ? row : [];
        if (paused === "1") return true;
        return outsideScoringWindow(Date.now(), startsAt, endsAt);
      } catch (err) {
        log(`redis isPaused: ${err.message}`);
        return false; // fail open: a Redis blip must not report a freeze nobody set
      }
    },
    // The master-reset epoch. The admin panel bumps `resetAt` in the settings
    // hash on a wipe; the poller compares it against its own last-seen value
    // and drops its cursor when it advances, so a poll-mode reset actually
    // sticks instead of being re-ingested from the same PR comments.
    async getResetAt() {
      try {
        const [v] = await pipeline([["HGET", ADMIN_SETTINGS_KEY, "resetAt"]]);
        return v ?? null;
      } catch (err) {
        log(`redis getResetAt: ${err.message}`);
        return null; // treat as "no reset" on error — retries next tick
      }
    },
    // The admin panel's secure-development target selection (config-v2): a
    // JSON array of target ids in `ctf:admin:settings.secureDevTargets`,
    // absent/empty meaning "all six" — the same default the pre-config-v2
    // static target list always resolved to for a fully-enabled module.
    // Unlike isPaused/getResetAt, this method does NOT catch and
    // fail open (or fail to some other silently-wrong default): a poller
    // that cannot read the override must not guess which subset to poll —
    // guessing "all six" on a Redis blip would score targets the organizer
    // deliberately turned off, and guessing "none" would freeze scoring
    // nobody asked to freeze. So this throws on a transport error, a
    // per-command error reply, an unparseable value, OR a value that parses
    // fine but normalizes to NO known target id at all (`[]`, `["unknown"]`,
    // or any other list that shares nothing with TARGETS) — that last case
    // used to silently fall back to "all six," which is exactly the
    // silently-wrong-default this whole method exists to refuse. `tick()`
    // (the only caller) treats every one of these as "skip this whole tick,
    // and say so" rather than picking either wrong default. Known ids are
    // also deduped and returned in TARGETS' catalogue order, not the stored
    // order, so the rest of the poller never has to think about
    // admin-supplied ordering.
    async getSecureDevTargets() {
      const [raw] = await pipeline([["HGET", ADMIN_SETTINGS_KEY, "secureDevTargets"]]);
      if (raw === null || raw === undefined || raw === "") return TARGETS;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`secureDevTargets: not valid JSON (${JSON.stringify(String(raw)).slice(0, 100)})`);
      }
      if (!Array.isArray(parsed)) throw new Error("secureDevTargets: expected a JSON array");
      const known = TARGETS.filter((t) => parsed.includes(t));
      if (known.length === 0) {
        throw new Error(`secureDevTargets: no known target id in stored list (${JSON.stringify(parsed).slice(0, 100)})`);
      }
      return known;
    },
    // The durable state, raw (ADR 64). null means the key does not exist: a first
    // boot, or the first boot after upgrading from a file-backed build. Like
    // getSecureDevTargets this does NOT catch: a failed read is not "no
    // state", because treating it as such would start the cursor from zero
    // and re-ingest every score comment — undoing any per-contestant reset
    // and zeroing the /admin counters. main() holds the poller instead.
    async readPollState() {
      const [raw] = await pipeline([["GET", SYNC_STATE_KEY]]);
      return raw ?? null;
    },
    // Throws too, so the caller logs it: a write that silently failed would
    // look fine until the next restart rewound the cursor.
    async writePollState(state) {
      await pipeline([["SET", SYNC_STATE_KEY, JSON.stringify(state)]]);
    },
    // Parks a score whose PR author has no linked kit account, so linking later
    // can release it. `field` is the comment revision key, which makes a retried
    // hold idempotent. One pipeline: the entry and the author index never
    // diverge. Throws on any error, so the caller retries the comment.
    // Key layout mirrors apps/web: ctf:sd:held:by:<lowercased login> (hash),
    // ctf:sd:held:authors (set of lowercased logins).
    async holdScore(login, field, entry) {
      const l = String(login).toLowerCase();
      await pipeline([
        ["HSET", `${HELD_BY_PREFIX}${l}`, field, JSON.stringify(entry)],
        ["SADD", HELD_AUTHORS_KEY, l],
      ]);
    },
    // The scoring window's raw bounds, absent ones as "". Throws on any read
    // error: the release step cannot tell whether a link beat the close
    // without the close, so it keeps every held score for the next tick.
    async readScoringWindow() {
      const [row] = await pipeline([["HMGET", ADMIN_SETTINGS_KEY, "scoringStartsAt", "scoringEndsAt"]]);
      const [startsAt, endsAt] = Array.isArray(row) ? row : [];
      return { startsAt: startsAt ?? "", endsAt: endsAt ?? "" };
    },
    // Lowercased logins with at least one held score. Throws on error.
    async heldAuthors() {
      const [members] = await pipeline([["SMEMBERS", HELD_AUTHORS_KEY]]);
      return Array.isArray(members) ? members : [];
    },
    // One author's held scores, keyed by comment revision. An entry that is
    // not a JSON object comes back as `entry: null` rather than throwing, so
    // one damaged entry cannot block the author's others. Throws on a read
    // error.
    async heldFor(login) {
      const [flat] = await pipeline([["HGETALL", `${HELD_BY_PREFIX}${String(login).toLowerCase()}`]]);
      const out = [];
      const pairs = Array.isArray(flat) ? flat : [];
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        let entry = null;
        try {
          const v = JSON.parse(pairs[i + 1]);
          if (v && typeof v === "object" && !Array.isArray(v)) entry = v;
        } catch {
          entry = null;
        }
        out.push({ field: pairs[i], entry });
      }
      return out;
    },
    // The player a login has claimed and when the link was made (epoch ms),
    // or null when the login is unclaimed. `linkedAt` is null when the link
    // carries no usable time in `ctf:link:at` (apps/web github-link.ts writes
    // it as a decimal string when the link is made); the release rule reads
    // that as "cannot prove it beat the close". Throws on any read error: an
    // unreadable link is not an unlinked author, and the caller retries. The
    // key mirrors apps/web github-link.ts linkKey: the login lowercased.
    async resolveGithubLink(login) {
      const [player] = await pipeline([["GET", `${LINK_GITHUB_PREFIX}${String(login).toLowerCase()}`]]);
      if (typeof player !== "string" || player === "") return null;
      const [raw] = await pipeline([["HGET", LINK_AT_KEY, player]]);
      const linkedAt = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null;
      return { player, linkedAt: Number.isSafeInteger(linkedAt) ? linkedAt : null };
    },
    // Deletes one held score the scorer has judged, and drops the author from
    // the index once nothing of theirs is left. One script so the hash and the
    // index never disagree: an author indexed with no hash would be re-read
    // every tick, one with a hash and no index would never be released.
    async releaseHeld(login, field) {
      const l = String(login).toLowerCase();
      await evalScript(RELEASE_HELD_SCRIPT, [`${HELD_BY_PREFIX}${l}`, HELD_AUTHORS_KEY], [field, l]);
    },
    async writeStatus(s) {
      try {
        const fields = [
          "lastPollAt", s.lastPollAt,
          "ingested", String(s.ingested),
          // Comments consumed that will never become a score without a human.
          // Cumulative and monotonic like `ingested` — unlike `lastError`,
          // which describes only the tick that wrote it. A drop is not
          // self-healing, so it must not be cleared by the next quiet tick.
          "dropped", String(s.dropped ?? 0),
          "reposPolled", String(s.reposPolled),
          "paused", s.paused ? "1" : "0",
        ];
        if (s.lastError) fields.push("lastError", s.lastError);
        if (s.lastDrop) fields.push("lastDrop", s.lastDrop);
        const cmds = [["HSET", SYNC_STATUS_KEY, ...fields]];
        if (!s.lastError) cmds.push(["HDEL", SYNC_STATUS_KEY, "lastError"]);
        await pipeline(cmds);
      } catch (err) {
        log(`redis writeStatus: ${err.message}`);
      }
    },
  };
}
