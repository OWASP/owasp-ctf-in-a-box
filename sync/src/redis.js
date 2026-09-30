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
const ADMIN_SETTINGS_KEY = "ctf:admin:settings";

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
// scoringStartsAt means "not launched", so ingestion holds. Mirrors apps/web
// schedule-window.ts and scorer/src/store.js — change all three together;
// test/fixtures/scoring-window-corpus.json pins them.
export function outsideScoringWindow(nowMs, startsAt, endsAt) {
  const s = startsAt ? Date.parse(startsAt) : NaN;
  if (!Number.isFinite(s)) return true;
  return outsideWindow(nowMs, startsAt, endsAt);
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
 *  unset (a poller with no Redis still polls; it just cannot see the freeze
 *  or write its heartbeat). `fetchImpl`, `log` and `timeoutMs` are seams. */
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
        return false; // fail open: a Redis blip must not freeze ingestion
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
