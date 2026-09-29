import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SEEN_CAP = 500;

/** A plain object — not null, not an array. The only shape `repos` and each
 *  per-repo entry may take. */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

export const freshState = () => ({ repos: {} });

/**
 * Parses a serialized state, repairing anything unusable. `where` names the
 * source in every repair line: the file path, or the Redis key when the state
 * came from `ctf:sync:state` (ADR 64). The same JSON is stored either way, and it
 * gets the same distrust either way.
 *
 * It is JSON this service wrote, so it is tempting to trust its SHAPE once it
 * parses. That was the bug (#63): a partial write, a disk problem or a hand
 * edit during a reset can leave behind valid JSON that is still wrong, and
 * `{}` parses perfectly. `repoState` then dereferenced an absent `repos` — on
 * every repo, on every tick.
 *
 * That throw is not contained anywhere: `tick`'s per-repo `try` wraps only the
 * fetch, so the rejection reaches main's fatal handler and exits 1, compose
 * restarts the container, and it reads the same state again. Ingestion stays
 * down for the whole event, which is why this repairs rather than propagates.
 * A retry cannot fix a stored value that is wrong, so unlike a failed READ
 * (index.js holds the poller until Redis answers), bad CONTENT is repaired.
 *
 * Repairing is not the same as discarding. Anything still usable is kept —
 * re-zeroing `ingested` would misreport the event's totals, and dropping
 * `resetAt` would make the next tick re-apply a master reset it already
 * performed. Only what is actually broken is replaced, and every repair is
 * logged, because a silent repair is how corrupt state goes unnoticed until
 * the cursor quietly re-reads from scratch.
 */
export function parseState(raw, where, { log = console.error } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log(`ctf-sync: state at ${where} is not valid JSON (${err.message}) — starting fresh`);
    return freshState();
  }

  if (!isRecord(parsed)) {
    log(`ctf-sync: state at ${where} is not an object — starting fresh`);
    return freshState();
  }

  if (!isRecord(parsed.repos)) {
    log(`ctf-sync: state at ${where} has no usable "repos" — resetting cursors, keeping the rest`);
    parsed.repos = {};
  }

  // The counters feed `++` and /admin's totals: anything but a non-negative
  // safe integer ("x" would concatenate, -3 would misreport) is reset to 0.
  // An absent counter stays absent; tick defaults it (#508 review).
  for (const field of ["ingested", "dropped"]) {
    const v = parsed[field];
    if (v !== undefined && !(Number.isSafeInteger(v) && v >= 0)) {
      log(`ctf-sync: state at ${where} has an unusable "${field}" (${JSON.stringify(v)}) — resetting it to 0`);
      parsed[field] = 0;
    }
  }
  // resetAt is compared with the settings' ISO string; a non-string never
  // matches, so the master reset would be re-applied on every tick.
  if (parsed.resetAt !== undefined && parsed.resetAt !== null && typeof parsed.resetAt !== "string") {
    log(`ctf-sync: state at ${where} has an unusable "resetAt" (${JSON.stringify(parsed.resetAt)}) — clearing it`);
    parsed.resetAt = null;
  }

  return parsed;
}

/**
 * Reads the state FILE, repairing anything unusable (see `parseState`).
 * Since ADR 64, the file is the store only for a poller with no Redis client; with
 * Redis it is read once, as a migration seed, and then retired (index.js).
 *
 * A MISSING file is not a fault: that is every event's first boot, and warning
 * about it would cry wolf. Anything else is logged — or, with `strict`, thrown:
 * the Redis migration uses that, because seeding Redis with an empty cursor
 * from a file that exists but cannot be read would lose the cursor for good
 * (#508 review).
 */
export function loadState(path, { log = console.error, strict = false } = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return freshState();
    if (strict) throw err;
    // Anything else (permissions, a directory where the file should be) is
    // worth saying out loud.
    log(`ctf-sync: cannot read state at ${path} (${err.message}) — starting fresh`);
    return freshState();
  }
  return parseState(raw, path, { log });
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

/**
 * Moves a migrated state file aside to `<path>.migrated` once its contents are
 * in Redis (ADR 64). Kept rather than deleted, in case an operator wants it, but
 * no longer at STATE_PATH: a file left there would seed a STALE cursor the
 * next time the Redis key is absent. That happens when Redis itself was wiped,
 * scores included, and then the right move is to re-read every comment and
 * rebuild the board, which an old cursor would prevent.
 *
 * Returns true when a file was moved, false when there was none to move.
 */
export function retireStateFile(path) {
  if (!existsSync(path)) return false;
  renameSync(path, `${path}.migrated`);
  return true;
}

/**
 * The live per-repo slot, created or repaired in place.
 *
 * `loadState` guarantees `repos` on the way in, and `tick` re-establishes it
 * after a master reset — but this is exported, so it re-checks rather than
 * assuming. Same reasoning one level down: a per-repo entry can be damaged
 * independently of its parent, and `markSeen` immediately calls
 * `rs.seen.includes(...)`, so a missing or non-array `seen` is the identical
 * crash one field deeper.
 *
 * Field-by-field, not all-or-nothing: a cursor that survived the damage is
 * worth keeping, because discarding `since` silently re-reads the repo's whole
 * comment history.
 */
export function repoState(state, repo) {
  if (!isRecord(state.repos)) state.repos = {};
  const existing = state.repos[repo];
  if (!isRecord(existing)) return (state.repos[repo] = { since: null, etag: null, seen: [] });
  if (!Array.isArray(existing.seen)) existing.seen = [];
  existing.since ??= null;
  existing.etag ??= null;
  return existing;
}

/** The dedupe key for one comment REVISION: its id AND the moment it last
 *  changed.
 *
 *  Keying on the id alone silently lost scores. The scoring workflow UPSERTS
 *  one comment per target — it posts "⏳ Scoring in progress…", then edits
 *  that same comment with the result — so a PR whose first run does not
 *  produce a score (a transient failure, a missing package grant, an
 *  infrastructure break) burns its id on the placeholder. The re-run then
 *  edits the SAME comment id with the real score, `markSeen` reports it as
 *  already handled, and the poller skips it and advances its cursor past it.
 *  Forever, and without a log line: the caller `continue`s before it reaches
 *  any of the logged branches.
 *
 *  Observed exactly that way on a live event: DVWA comment 5364196433 was
 *  created 01:47 reading "Scoring did not complete", updated 02:06 carrying a
 *  real `ctf-score:` marker, and never ingested — the contestant's PR showed
 *  a correct score while the leaderboard showed nothing.
 *
 *  Re-ingesting is safe, which is what makes this the right fix rather than a
 *  risk: `recordSolves` is monotonic (see the scorer's "replaying a solve
 *  changes neither points nor lastSolveAt" test), so the worst case of a key
 *  that changes without the payload changing is one redundant, inert POST. */
export function seenKey(id, updatedAt) {
  return `${id}@${updatedAt ?? ""}`;
}

/** Records a comment revision as handled. Returns false if this exact
 *  revision was already handled.
 *
 *  `updatedAt` is optional only so a caller that genuinely has no timestamp
 *  still dedupes by id; every real caller passes `comment.updated_at`.
 *
 *  State written by an older build holds BARE ids. Those never match a
 *  revision key, so upgrading re-presents each still-cursored comment exactly
 *  once — which is the desired repair, not a regression: it is what recovers
 *  the scores this bug dropped. */
export function markSeen(rs, id, updatedAt) {
  const key = seenKey(id, updatedAt);
  if (rs.seen.includes(key)) return false;
  rs.seen.push(key);
  if (rs.seen.length > SEEN_CAP) rs.seen.splice(0, rs.seen.length - SEEN_CAP);
  return true;
}
