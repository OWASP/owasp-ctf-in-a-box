import { loadConfig, REPO_NAMES, TARGETS } from "./config.js";
import { fetchNewScoreComments } from "./github.js";
import { hasScoreMarker, parseScoreComment } from "./parse.js";
import { submitScore } from "./submit.js";
import { loadState, markSeen, parseState, repoState, retireStateFile, saveState, seenKey } from "./state.js";
import { makeRedis, SYNC_STATE_KEY } from "./redis.js";

// Fail-safe wrapper: a broken deps.redis (whatever its origin) must never
// reject the tick — a heartbeat that could not be written must not stop the
// poll, and main() persists the cursor separately, after the tick.
async function writeStatusSafely(redis, log, status) {
  try {
    await redis.writeStatus(status);
  } catch (err) {
    log(`redis writeStatus: ${err.message}`);
  }
}

/**
 * One tick's disposition of one repo's bot comments. Every comment the loop
 * consumes lands in exactly one bucket, and the buckets exist because BOTH of
 * the scoring bugs this event hit had the same shape: a comment was consumed,
 * no score was submitted, and nothing was written down. A `continue` that
 * precedes every logged branch is invisible by construction — no amount of
 * tailing the poller's logs would have found either one.
 *
 * The buckets are not equally interesting, which is the point of separating
 * them:
 *
 *   - `duplicate` / `noMarker` are ROUTINE. `since` is inclusive, so the
 *     boundary comment is re-read on most ticks, and the workflow's
 *     placeholder legitimately carries no score. Counting them without
 *     distinguishing them is what would make a "dropped" figure permanently
 *     nonzero — and a counter that is always nonzero is a counter nobody
 *     reads.
 *   - `invalid` / `rejected` are NOT routine. Each one is a score that
 *     existed on a PR and will never reach the leaderboard without a human.
 *     These two are what `state.dropped` counts and what /admin shows.
 *   - `retried` is a submission that failed transiently and was deliberately
 *     un-marked; the next tick re-presents it. Worth logging, not worth
 *     counting as lost.
 */
const freshTally = () => ({ ingested: 0, duplicate: 0, noMarker: 0, invalid: 0, rejected: 0, retried: 0 });

/** The tally as a log line, listing only what actually happened. Returns null
 *  when the tick was routine (nothing at all, or only the expected boundary
 *  re-read), so a quiet poller stays quiet and any line it does print means
 *  something. */
function summarize(repo, tally) {
  if (tally.noMarker + tally.invalid + tally.rejected + tally.retried === 0) return null;
  const parts = Object.entries(tally)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${n} ${name}`);
  return `poll ${repo}: ${parts.join(", ")}`;
}

export async function tick(cfg, state, deps = {}) {
  const { fetchImpl = fetch, log = console.error, redis = null } = deps;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  state.ingested ??= 0;
  state.dropped ??= 0;

  // A drop is worth a counter AND a description: "3 dropped" tells an
  // organizer something is wrong, `lastDrop` tells them where to look.
  const drop = (why) => {
    state.dropped++;
    state.lastDrop = why;
    state.lastDropAt = nowIso();
    log(why);
  };

  // Read the pause flag FIRST, before the target list — it is fail-open and
  // cheap (unlike getSecureDevTargets below), and reading it up front means
  // the heartbeat this tick writes always carries the REAL paused value, even
  // on the early return below. It used to be read only after the targets
  // fetch, which made an unreadable-targets tick lie and report `paused:
  // false` unconditionally regardless of the actual setting. This does not
  // change WHEN the tick acts on it — the early-return-if-paused check below
  // is still after the reset-epoch check, for the reason given there.
  const paused = redis ? await redis.isPaused() : false;

  // Resolve THIS TICK's target list before anything else touches state or
  // Redis. With no admin override this is the app's full six-target
  // catalogue, but a transport error or an unparseable stored value must not
  // be treated as "poll nothing" (silently going dark) or "poll all six"
  // (silently widening scope back open) — either is a wrong guess dressed up
  // as a safe default. So a failure here fails the WHOLE tick closed: no
  // repo is polled, no cursor moves, and the heartbeat says why. This is
  // deliberately unlike the isPaused/getResetAt reads, which fail open/silent
  // because a miss there already has its own safe direction.
  let targets;
  if (redis) {
    try {
      targets = await redis.getSecureDevTargets();
    } catch (err) {
      await writeStatusSafely(redis, log, {
        lastPollAt: nowIso(),
        ingested: state.ingested,
        dropped: state.dropped,
        lastDrop: state.lastDrop ?? null,
        reposPolled: 0,
        paused,
        lastError: `targets unreadable: ${err.message}`,
      });
      return state;
    }
  } else {
    targets = TARGETS;
  }

  // Master-reset epoch, BEFORE the pause check: a reset also freezes scoring,
  // so we must drop the cursor even while paused, or an unfreeze would re-ingest
  // from the cursor's old position. Clearing repos makes the next poll re-read
  // from scratch; the caller persists `state` after this tick.
  if (redis?.getResetAt) {
    const resetAt = await redis.getResetAt();
    if (resetAt && resetAt !== state.resetAt) {
      state.repos = {};
      state.resetAt = resetAt;
    }
  }

  if (redis && paused) {
    await writeStatusSafely(redis, log, {
      lastPollAt: nowIso(),
      ingested: state.ingested,
      dropped: state.dropped,
      lastDrop: state.lastDrop ?? null,
      reposPolled: 0,
      paused: true,
      lastError: null,
    });
    return state;
  }

  let reposPolled = 0;
  let lastError = null;
  for (const target of targets) {
    reposPolled++;
    const repo = REPO_NAMES[target];
    const rs = repoState(state, repo);
    let result;
    try {
      result = await fetchNewScoreComments(cfg, repo, rs, fetchImpl);
    } catch (err) {
      log(`poll ${repo}: ${err.message}`);
      lastError = err.message;
      continue;
    }
    let stopAt;
    const tally = freshTally();
    for (const c of result.comments) {
      // Keyed on the comment REVISION, not its id — the workflow upserts one
      // comment per target, so the id alone made a re-scored PR unreachable.
      if (!markSeen(rs, c.id, c.updated_at)) {
        tally.duplicate++;
        continue;
      }
      const payload = parseScoreComment(c.body, { targets });
      if (!payload) {
        // A marker that is PRESENT and unusable is a real loss — the workflow
        // meant to report a score and the poller cannot read it. A comment
        // with no marker is just a comment.
        if (hasScoreMarker(c.body)) {
          tally.invalid++;
          drop(`submit ${repo}: comment ${c.id} carries an unusable ctf-score marker, dropped`);
        } else {
          tally.noMarker++;
        }
        continue;
      }
      try {
        const ok = await submitScore(cfg, payload, fetchImpl);
        if (ok) {
          state.ingested++;
          tally.ingested++;
        } else {
          tally.rejected++;
          drop(`submit ${repo}#${payload.pr}: rejected (4xx), dropped`);
        }
      } catch (err) {
        // Retry next tick: drop THIS revision's key, not every key sharing
        // the comment's id.
        rs.seen = rs.seen.filter((k) => k !== seenKey(c.id, c.updated_at));
        stopAt ??= c.updated_at; // record first failure's timestamp
        lastError = err.message;
        tally.retried++;
        log(`submit ${repo}#${payload.pr}: ${err.message}`);
      }
    }
    const summary = summarize(repo, tally);
    if (summary) log(summary);
    // advance cursor to first failure or to full batch, reset etag if any failure
    rs.since = stopAt ?? result.cursor.since;
    rs.etag = stopAt ? null : result.cursor.etag;
  }

  if (redis) {
    await writeStatusSafely(redis, log, {
      lastPollAt: nowIso(),
      ingested: state.ingested,
      dropped: state.dropped,
      lastDrop: state.lastDrop ?? null,
      reposPolled,
      paused: false,
      lastError,
    });
  }
  return state;
}

// Exported for the tests: every collaborator is injectable so main() can be
// exercised WITHOUT a real env, Redis, GitHub, or an unstoppable poll loop.
//
// config-v2 (#386): sync no longer decides "am I enabled" — that used to be
// a module key in the old bind-mounted YAML config, and loadConfig could
// return null for "nothing to poll" (a quiz-only event). Now whether sync
// runs at all is the compose profile's call: if this container is up, it
// polls. The only thing left to guard against is a genuinely broken config
// (GITHUB_ORG unset, a missing secret, ...), which loadConfig reports by
// throwing — caught here so it is a clean, named refusal at startup rather
// than an uncaught rejection.
export async function main(deps = {}) {
  const {
    load = loadConfig,
    log = console.log,
    logErr = console.error,
    readState = loadState,
    writeState = saveState,
    retireFile = retireStateFile,
    makeRedisImpl = makeRedis,
    runTick = tick,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    exit = process.exit,
  } = deps;

  let cfg;
  try {
    cfg = load();
  } catch (err) {
    logErr(`ctf-sync: ${err.message}`);
    return exit(1);
  }

  const redis = makeRedisImpl();
  // No static repo count here any more: which of the six targets get polled
  // is decided per tick from Redis (config-v2), so a count printed once at
  // startup would just be stale the moment an organizer changes it in /admin.
  logErr(`ctf-sync: polling ${cfg.org} every ${cfg.pollIntervalMs}ms`);
  // With no Redis client there is nothing to read secureDevTargets from, so
  // tick() falls back to TARGETS (all six) every tick — worth saying once at
  // boot rather than leaving an organizer to infer it from the poll logs.
  if (!redis) logErr("ctf-sync: no Redis client — polling all six targets");

  // Where the durable state lives (ADR 64). With Redis, in `ctf:sync:state`,
  // next to the scores; the file is read at most once, as a migration seed.
  // With no Redis client (a dev poller), the file at STATE_PATH, as before.
  // `logErr` so a state repair lands in the same stream as the poller's other
  // operational lines — a warning nobody sees is the silent repair this guards
  // against (#63).
  const state = redis
    ? await loadDurableState(cfg, redis, { readState, retire: retireFile, logErr, sleep })
    : readState(cfg.statePath, { log: logErr });
  const persist = redis
    ? async () => {
        try {
          await redis.writePollState(state);
        } catch (err) {
          // Not fatal: the in-memory state stays authoritative for this
          // process and the next tick writes again. Only a restart before a
          // write lands rewinds the cursor to the last one that did, and the
          // re-read that causes is idempotent (the scorer's HSETNX).
          logErr(`ctf-sync: could not save poll state to Redis (${SYNC_STATE_KEY}): ${err.message} — retrying next tick`);
        }
      }
    : async () => writeState(cfg.statePath, state);

  for (;;) {
    await runTick(cfg, state, { redis });
    await persist();
    const jitter = cfg.pollIntervalMs * 0.2 * (2 * Math.random() - 1);
    await sleep(cfg.pollIntervalMs + jitter);
  }
}

/** The migration seed exists but could not be read (#508 review). */
class LegacyStateUnreadable extends Error {
  constructor(path, cause) {
    super(`cannot read ${path}: ${cause.message}`, { cause });
    this.path = path;
  }
}

/** The seed reached Redis but the file could not be moved aside (#508 review). */
class LegacyStateUnretired extends Error {
  constructor(path, cause) {
    super(`cannot move ${path} aside: ${cause.message}`, { cause });
    this.path = path;
  }
}

/**
 * Moves the legacy file aside once its contents are in Redis, or throws
 * LegacyStateUnretired so the caller holds. A file left at STATE_PATH is a
 * stale cursor: if Redis is later wiped, it would seed the key again and
 * resume from it instead of re-reading everything, so polling waits for the
 * move rather than proceeding with the file still there.
 */
function retireOrHold(path, retire, logErr, announce) {
  let moved;
  try {
    moved = retire(path);
  } catch (err) {
    throw new LegacyStateUnretired(path, err);
  }
  if (moved && announce) {
    logErr(`ctf-sync: migrated poll state from ${path} to Redis ${SYNC_STATE_KEY}; the file is now ${path}.migrated`);
  }
}

/**
 * Reads the poller's durable state from Redis before the first tick (ADR 64).
 *
 * FAIL DIRECTION: if Redis cannot be read, the poller HOLDS — it does not
 * tick, logs why on every attempt, and retries each poll interval until the
 * read succeeds. The alternative, starting from an empty cursor, re-reads
 * every score comment: no points are double-counted (the scorer writes with
 * HSETNX), but every Secure Development solve an organizer removed with a
 * per-contestant reset comes back, and /admin's ingested/dropped counters
 * restart at 0 — losing the only record of dropped scores. Holding costs
 * nothing: the comments stay on GitHub and are read once Redis answers, and
 * while Redis is unreadable the scorer could not have written a score anyway.
 * The stale heartbeat (`ctf:sync:status.lastPollAt`) is what shows it in
 * /admin and /health/deep; writing a fresh one here would hide the hold.
 *
 * A key that is ABSENT is different: that is a first boot, or the first boot
 * after upgrading from a build that kept state only on disk. Then an
 * existing state file seeds Redis once and is moved aside (`.migrated`), so a
 * later wipe of Redis — scores and cursor together — re-reads everything and
 * rebuilds the board, instead of resuming from a stale file cursor.
 */
async function loadDurableState(cfg, redis, { readState, retire, logErr, sleep }) {
  for (;;) {
    try {
      const raw = await redis.readPollState();
      if (raw !== null) {
        const state = parseState(raw, `Redis ${SYNC_STATE_KEY}`, { log: logErr });
        // A retry after a failed move lands here: the key is established, so
        // this finishes the migration (or is a no-op once the file is gone).
        retireOrHold(cfg.statePath, retire, logErr, true);
        return state;
      }
      let seed;
      try {
        seed = readState(cfg.statePath, { log: logErr, strict: true });
      } catch (err) {
        // A file that EXISTS but cannot be read is not a first boot: seeding
        // an empty cursor and retiring the file would re-ingest every score
        // comment for good. Hold, exactly as for an unreadable Redis.
        throw new LegacyStateUnreadable(cfg.statePath, err);
      }
      // Establish the key BEFORE the first tick, so the file can be retired
      // only once its contents are safely in Redis.
      await redis.writePollState(seed);
      const hadCursor = Object.keys(seed.repos).length > 0 || (seed.ingested ?? 0) > 0;
      retireOrHold(cfg.statePath, retire, logErr, hadCursor);
      return seed;
    } catch (err) {
      logErr(
        err instanceof LegacyStateUnreadable
          ? `ctf-sync: cannot read the legacy state file ${err.path} (${err.cause.message}) — not polling until it is readable or removed (seeding Redis with an empty cursor would re-ingest every score comment); retrying in ${cfg.pollIntervalMs}ms`
          : err instanceof LegacyStateUnretired
          ? `ctf-sync: poll state is in Redis ${SYNC_STATE_KEY}, but could not move ${err.path} aside (${err.cause.message}) — not polling until it is moved or deleted (a leftover file would re-seed a wiped Redis with a stale cursor); retrying in ${cfg.pollIntervalMs}ms`
          : `ctf-sync: cannot load poll state from Redis (${SYNC_STATE_KEY}): ${err.message} — not polling until it is readable (starting from an empty cursor would re-ingest every score comment); retrying in ${cfg.pollIntervalMs}ms`,
      );
      await sleep(cfg.pollIntervalMs);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`ctf-sync fatal: ${err.message}`);
    process.exit(1);
  });
}
