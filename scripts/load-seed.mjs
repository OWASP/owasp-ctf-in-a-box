#!/usr/bin/env node
// Synthetic contestants for a load test (issue #439).
//
// RUNS INSIDE THE APP CONTAINER, not on a laptop: srh sits on the machine's
// private network, and the app container already carries the URL and token
// it writes through (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) plus
// the scorer's address (LEADERBOARD_API_URL). scripts/load-test.sh does the
// `fly ssh sftp put` + `fly ssh console --container app -C "node ..."` dance.
//
// WHAT IT WRITES. The same keys `seedDemoData` (apps/web/src/lib/admin-store.ts)
// writes for the demo roster, for N generated contestants on teams of 2–4:
//   ctf:team:<slug> hash + ctf:team:<slug>:members set + ctf:user:<login>
//     (team, joinedAt, firstTeamAt)
//   ctf:solves:<target>  <login>:<challengeId> -> ISO   (Secure Development)
//   ctf:quiz:answers:<login> / ctf:quiz:attempts:<login> + ctf:quiz:points /
//     ctf:quiz:answered aggregates
//   ctf:classic:solves:<login> / ctf:classic:attempts:<login> +
//     ctf:classic:points / ctf:classic:solved aggregates
// It attaches solves to the CATALOGUE THE BOX ALREADY HAS (quiz questions,
// classic challenges, the scorer's /challenges) so titles resolve and the
// leaderboard/metrics folds see real ids. It writes NO catalogue of its own.
//
// Deliberately not written: ctf:classic:solvecount — a shared per-challenge
// counter that real solves raise; the harness omits it because an exact
// clean could not lower it back safely. Hint purchases are omitted too (no
// penalty path on a load run). Both are noted in the report.
//
// OWNERSHIP IS THE MANIFEST, NOT A NAME PATTERN. `load-0001` is a legal
// GitHub login and nothing in the app reserves it, so the harness cannot
// infer "ours" from the shape of a key. Instead every seed writes an exact
// manifest — every key and every shared-hash field it wrote — to
// ctf:load-seed:manifest, and:
//   - the SEED writes each batch through ONE Lua script (EVAL, atomic on the
//     Redis side, the same road the app's grading scripts take through srh):
//     the script checks every key and field the batch is about to write and
//     returns a collision — writing nothing — if any already exists and is not
//     claimed by the manifest so far; only then does it write, and it SETs the
//     manifest in the same script. So a contestant registering a legal
//     `load-0042` between a check and a write cannot be overwritten: there is
//     no "between". A JS-side probe still runs first, purely to report every
//     collision at once before the first batch; the script is the authority;
//   - the manifest is written INCREMENTALLY: every batch of writes ends with
//     a SET of the manifest covering the previous run plus every batch that
//     has completed, so a seed that dies half-way leaves a manifest naming
//     exactly the rows it managed to write (and `--clean` removes them). The
//     planned-but-unwritten rows are never listed — a clean cannot reach a
//     key some other owner creates later. The one residual window is a batch
//     whose writes landed but whose own SET failed; the abort message says
//     which batch, and a re-run's collision probe will refuse until it is
//     cleaned by hand;
//   - the CLEAN deletes exactly the manifest's entries and the manifest, and
//     reads no catalogue, no --count and no pattern — a challenge removed or a
//     module disabled after seeding cannot strand a field, and nothing absent
//     from the manifest is ever targeted. (What IS listed is deleted whole:
//     a contestant who registers `load-0042` AFTER the seed shares a listed
//     key and loses it with the clean — which is why the harness runs before
//     registration opens.) No manifest means nothing to clean. A manifest
//     from a larger earlier --count stays merged in, so a smaller re-run
//     still owns — and later cleans — the rows the earlier run wrote;
//   - seed and clean are SERIALIZED by a token lock (ctf:load-seed:lock, SET
//     NX, held for the whole operation, released by a token-checked script):
//     a clean racing a seed could otherwise delete the new manifest under it
//     and orphan the seed's rows. The lock does not expire on its own — a
//     crashed run leaves it, the next run refuses and prints its age, and
//     the operator clears it with --break-lock once sure nothing is running.
//
// FAIL DIRECTIONS. The seed fails CLOSED: a settings hash it cannot parse, or
// Secure Development live with no scorer address, aborts before a single
// write — a seed that guessed which modules are live would attach points to
// a board that does not show them and the load test would measure the wrong
// page. A collision (above) aborts the same way.
//
// IDEMPOTENT AND REVERSIBLE. Logins are `load-0001`…, teams `load-team-01`…
// (teams of 2–4, so --count is at least 2); the same --count regenerates the
// same set, so a re-run rewrites its own rows. Master reset also removes
// them; --clean is so the box does not depend on that.

import { parseArgs } from "node:util";

const LOGIN_PREFIX = "load-";
const TEAM_PREFIX = "load-team-";
const BATCH = 200;
const WINDOW_MS = 2 * 60 * 60 * 1000;

/** Where the seed records exactly what it wrote; the clean's only input. */
export const MANIFEST_KEY = "ctf:load-seed:manifest";
/** One seed or clean at a time: a token lock held for the whole operation. */
export const LOCK_KEY = "ctf:load-seed:lock";
/** The shared hashes keyed by login or `<login>:<id>` that the seed writes fields INTO (everything else it writes is a whole key of its own). */
export const SHARED_HASHES = ["ctf:quiz:points", "ctf:quiz:answered", "ctf:classic:points", "ctf:classic:solved"];

// ---------------------------------------------------------------------------
// Pure helpers (exported for scripts/test/load-seed.test.mjs)
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so the same --count yields the same data. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The i-th seeded login (`load-0001`…): a stable name, not an ownership claim — the manifest is. */
export function loginFor(i) {
  return `${LOGIN_PREFIX}${String(i).padStart(4, "0")}`;
}

/** Teams of 2–4, in order, every login on exactly one team. */
export function partitionTeams(logins, rand) {
  const teams = [];
  let i = 0;
  let n = 1;
  while (i < logins.length) {
    const remaining = logins.length - i;
    let size = 2 + Math.floor(rand() * 3); // 2..4
    size = Math.min(size, remaining);
    // Never leave exactly one login behind: shrink this team (to no fewer
    // than 2) or, when it is already 2, grow it — 3 stays inside the cap.
    if (remaining - size === 1) size = size > 2 ? size - 1 : size + 1;
    if (remaining < 2) size = remaining; // n=1 is the only legitimate solo
    const members = logins.slice(i, i + size);
    const slug = `${TEAM_PREFIX}${String(n).padStart(2, "0")}`;
    teams.push({ slug, name: `Load Team ${n}`, captain: members[0], members });
    i += size;
    n += 1;
  }
  return teams;
}

/** A random subset of `ids` of size drawn from [min, max], stable under `rand`. */
export function pickSubset(ids, min, max, rand) {
  if (ids.length === 0) return [];
  const want = Math.min(ids.length, min + Math.floor(rand() * (max - min + 1)));
  const pool = ids.slice();
  const out = [];
  while (out.length < want) {
    const k = Math.floor(rand() * pool.length);
    out.push(pool.splice(k, 1)[0]);
  }
  return out;
}

/** One attempts-hash row in the shape the app's parser reads, firstAt clamped to the window. */
export function attemptRow(tries, earnedAtMs, gapMinutes, floorMs) {
  const firstAtMs = Math.max(earnedAtMs - (5 + (tries - 1) * gapMinutes) * 60_000, floorMs);
  return JSON.stringify({
    attempts: tries,
    firstAt: new Date(firstAtMs).toISOString(),
    lastAt: new Date(earnedAtMs).toISOString(),
    lastAtMs: earnedAtMs,
  });
}

/**
 * Which modules the settings hash says are live, or null for "no list stored"
 * (every module counts as live then). FAILS CLOSED on a list it cannot read:
 * guessing here would seed points onto a board that does not show them.
 */
export function liveModules(settings) {
  const raw = settings && settings.enabledModuleIds;
  if (raw === undefined || raw === null || raw === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ctf:admin:settings enabledModuleIds is not valid JSON — refusing to guess which modules are live");
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
    throw new Error("ctf:admin:settings enabledModuleIds is not a list of module ids — refusing to guess which modules are live");
  }
  return parsed;
}

/**
 * The catalogue a seed attaches to, from the raw store rows. Pure so the
 * error paths are testable, and FAIL CLOSED throughout: a quiz or classic row
 * that is not the JSON the app writes, a live Secure Development module with
 * no scorer address, or a scorer answer without a `challenges` list, each
 * abort the seed before any write. A partial catalogue would seed a board
 * whose titles do not resolve and measure the wrong page.
 */
export function resolveCatalogue({ enabled, quizRows, classicRows, sdChallenges, scorerUrl }) {
  const live = (id) => enabled === null || enabled.includes(id);
  const parseRows = (rows, what) => Object.entries(rows || {}).map(([id, v]) => {
    let row;
    try { row = JSON.parse(v); } catch { throw new Error(`${what} row ${id} is not valid JSON — refusing to seed against a catalogue this seeder cannot read`); }
    if (!row || typeof row !== "object" || typeof row.id !== "string") throw new Error(`${what} row ${id} has no id — refusing to seed against a catalogue this seeder cannot read`);
    return row;
  });
  const quiz = live("quiz")
    ? parseRows(quizRows, "ctf:quiz:questions").map((q) => ({ id: q.id, points: Number(q.points) || 0, choices: Array.isArray(q.correct) ? q.correct : [] }))
    : [];
  const classic = live("classic")
    ? parseRows(classicRows, "ctf:classic:challenges").map((c) => ({ id: c.id, points: Number(c.points) || 0 }))
    : [];
  const sd = {};
  if (live("secure-development")) {
    if (!scorerUrl) throw new Error("Secure Development is live but LEADERBOARD_API_URL is not set — refusing to seed a board with no scorer catalogue");
    if (!Array.isArray(sdChallenges)) throw new Error("Secure Development is live but the scorer's /challenges did not answer with a challenges list — refusing to seed");
    for (const c of sdChallenges) {
      if (!c || typeof c.app !== "string" || typeof c.id !== "string") throw new Error("the scorer's /challenges carries an entry without app/id — refusing to seed");
      (sd[c.app] ||= []).push(c.id);
    }
  }
  return { quiz, classic, sd };
}

/** Everything one run writes, as pipeline commands, from a resolved catalogue. */
export function buildCommands({ count, catalogue, now = Date.now(), seed = 439 }) {
  const rand = rng(seed + count);
  const logins = Array.from({ length: count }, (_, i) => loginFor(i + 1));
  const teams = partitionTeams(logins, rand);
  const base = now - WINDOW_MS;
  const at = (frac) => new Date(base + Math.min(0.999, Math.max(0, frac)) * WINDOW_MS);
  const cmds = [];
  const createdAt = new Date(base).toISOString();

  for (const t of teams) {
    cmds.push(["HSET", `ctf:team:${t.slug}`, "name", t.name, "captain", t.captain, "createdAt", createdAt, "joinCode", t.slug.slice(-6)]);
    cmds.push(["SADD", `ctf:team:${t.slug}:members`, ...t.members]);
    for (const m of t.members) cmds.push(["HSET", `ctf:user:${m}`, "team", t.slug, "joinedAt", createdAt, "firstTeamAt", createdAt]);
  }

  let sdSolves = 0;
  let quizAnswers = 0;
  let classicSolves = 0;

  logins.forEach((login, li) => {
    // Secure Development: 0–6 solves per target the box has, spread over the window.
    for (const [target, ids] of Object.entries(catalogue.sd)) {
      for (const id of pickSubset(ids, 0, 6, rand)) {
        cmds.push(["HSET", `ctf:solves:${target}`, `${login}:${id}`, at(rand()).toISOString()]);
        sdSolves += 1;
      }
    }
    // Quiz: answer 0–70% of the bank; one extra failed attempt on a question not answered.
    if (catalogue.quiz.length) {
      const answered = pickSubset(catalogue.quiz, 0, Math.ceil(catalogue.quiz.length * 0.7), rand);
      let points = 0;
      for (const q of answered) {
        const ts = at(rand());
        cmds.push(["HSET", `ctf:quiz:answers:${login}`, q.id, JSON.stringify({ choices: q.choices, points: q.points, at: ts.toISOString() })]);
        cmds.push(["HSET", `ctf:quiz:attempts:${login}`, q.id, attemptRow(1 + (li % 3), ts.getTime(), 3 + (li % 7), base)]);
        points += q.points;
        quizAnswers += 1;
      }
      const missed = catalogue.quiz.find((q) => !answered.includes(q));
      if (missed) cmds.push(["HSET", `ctf:quiz:attempts:${login}`, missed.id, attemptRow(1 + (li % 2), at(rand()).getTime(), 5, base)]);
      if (answered.length) {
        cmds.push(["HSET", "ctf:quiz:points", login, points]);
        cmds.push(["HSET", "ctf:quiz:answered", login, answered.length]);
      }
    }
    // Classic: solve 0–50% of the board; one extra failed attempt.
    if (catalogue.classic.length) {
      const solved = pickSubset(catalogue.classic, 0, Math.ceil(catalogue.classic.length * 0.5), rand);
      let points = 0;
      for (const c of solved) {
        const ts = at(rand());
        cmds.push(["HSET", `ctf:classic:solves:${login}`, c.id, JSON.stringify({ points: c.points, at: ts.toISOString() })]);
        cmds.push(["HSET", `ctf:classic:attempts:${login}`, c.id, attemptRow(1 + ((li + 1) % 3), ts.getTime(), 2 + (li % 9), base)]);
        points += c.points;
        classicSolves += 1;
      }
      const missed = catalogue.classic.find((c) => !solved.includes(c));
      if (missed) cmds.push(["HSET", `ctf:classic:attempts:${login}`, missed.id, attemptRow(2 + (li % 3), at(rand()).getTime(), 4, base)]);
      if (solved.length) {
        cmds.push(["HSET", "ctf:classic:points", login, points]);
        cmds.push(["HSET", "ctf:classic:solved", login, solved.length]);
      }
    }
  });

  return { cmds, logins, teams, stats: { contestants: count, teams: teams.length, sdSolves, quizAnswers, classicSolves } };
}

/** True when `key` is a shared hash the seed writes fields into rather than a key it owns whole. */
export function isSharedHash(key) {
  return SHARED_HASHES.includes(key) || key.startsWith("ctf:solves:");
}

/**
 * The exact record of what a seed writes: every whole key and, for the shared
 * hashes, every field. Derived from the commands, so it cannot drift from
 * the writes. This is what ownership means to the harness.
 */
export function manifestFor(cmds) {
  const keys = new Set();
  const fields = {};
  for (const c of cmds) {
    if (isSharedHash(c[1])) (fields[c[1]] ||= new Set()).add(c[2]);
    else keys.add(c[1]);
  }
  return { keys: [...keys].sort(), fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, [...v].sort()])) };
}

/**
 * What a seed must NOT write over: every key or field in `manifest` that
 * `existing` says is already in the store and the previous manifest does not
 * claim. `existing` is { keys: Set<string>, fields: { key: Set<field> } } as
 * the probe found them. Empty means the seed may proceed.
 */
export function collisions(manifest, existing, previous = null) {
  const prevKeys = new Set(previous ? previous.keys : []);
  const prevFields = previous ? previous.fields : {};
  const out = [];
  for (const k of manifest.keys) if (existing.keys.has(k) && !prevKeys.has(k)) out.push(k);
  for (const [k, fs] of Object.entries(manifest.fields)) {
    const have = existing.fields[k];
    if (!have) continue;
    const prev = new Set(prevFields[k] || []);
    for (const f of fs) if (have.has(f) && !prev.has(f)) out.push(`${k}#${f}`);
  }
  return out;
}

/** The union of two manifests: a re-run keeps owning every row an earlier run wrote. */
export function mergeManifests(a, b) {
  const keys = new Set([...(a ? a.keys : []), ...(b ? b.keys : [])]);
  const fields = {};
  for (const m of [a, b]) {
    if (!m) continue;
    for (const [k, fs] of Object.entries(m.fields || {})) (fields[k] ||= new Set()) && fs.forEach((f) => fields[k].add(f));
  }
  return { keys: [...keys].sort(), fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, [...v].sort()])) };
}

/**
 * The Lua the seed runs per batch. ARGV[1] is the batch's ops as JSON
 * (`{cmd, key, field?, args, claimed}`), ARGV[2] the manifest key, ARGV[3]
 * the manifest JSON to record once the batch has landed. Every check runs
 * before any write, so the batch either lands whole with its manifest or
 * returns the first collision having written nothing. Atomic because Redis
 * runs a script without interleaving other clients' commands.
 */
export const SEED_SCRIPT = `
local ops = cjson.decode(ARGV[1])
for _, op in ipairs(ops) do
  if not op.claimed then
    if op.field then
      if redis.call('HEXISTS', op.key, op.field) == 1 then return 'collision:' .. op.key .. '#' .. op.field end
    else
      if redis.call('EXISTS', op.key) == 1 then return 'collision:' .. op.key end
    end
  end
end
for _, op in ipairs(ops) do
  redis.call(op.cmd, op.key, unpack(op.args))
end
redis.call('SET', ARGV[2], ARGV[3])
return 'ok:' .. #ops
`;

/**
 * The seed's writes cut into batches for SEED_SCRIPT. Each batch carries its
 * ops — every op marked `claimed` when the manifest SO FAR (the previous run
 * merged with every batch before this one) already owns that key or field,
 * so a login's rows split across two batches are not a self-collision — and
 * the manifest to record once it has landed: previous plus every command up
 * to and including this batch, `complete: true` only on the last. Only
 * committed writes are ever recorded.
 */
export function planBatches(cmds, previous, batchSize = BATCH) {
  const batches = [];
  for (let i = 0; i < cmds.length; i += batchSize) {
    const upto = Math.min(cmds.length, i + batchSize);
    const before = mergeManifests(previous, manifestFor(cmds.slice(0, i)));
    const beforeKeys = new Set(before.keys);
    const ops = cmds.slice(i, upto).map((c) => {
      const key = c[1];
      const shared = isSharedHash(key);
      const field = shared ? String(c[2]) : undefined;
      const claimed = shared ? (before.fields[key] || []).includes(field) : beforeKeys.has(key);
      return { cmd: c[0], key, ...(shared ? { field } : {}), args: c.slice(2).map(String), claimed };
    });
    const soFar = mergeManifests(previous, manifestFor(cmds.slice(0, upto)));
    batches.push({ ops, manifest: { ...soFar, complete: upto === cmds.length } });
  }
  return batches;
}

/**
 * The exact inverse of a manifest: DEL its keys, HDEL its fields. The
 * manifest itself is NOT in this list — the caller deletes it in a separate
 * call only after every one of these succeeded, so a failed deletion can
 * never leave seeded rows behind with no manifest to find them by.
 */
export function cleanCommands(manifest) {
  const cmds = [];
  const keys = manifest.keys || [];
  for (let i = 0; i < keys.length; i += 100) cmds.push(["DEL", ...keys.slice(i, i + 100)]);
  let fields = 0;
  for (const [key, names] of Object.entries(manifest.fields || {})) {
    for (let i = 0; i < names.length; i += 100) cmds.push(["HDEL", key, ...names.slice(i, i + 100)]);
    fields += names.length;
  }
  return { cmds, keys: keys.length, fields };
}

/** Only https, or http to a private/local endpoint (the compose `srh` service, loopback, Fly's `.internal`); the token rides in the Authorization header. */
export function assertRedisUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("UPSTASH_REDIS_REST_URL is not a URL");
  }
  if (u.protocol === "https:") return u;
  if (u.protocol !== "http:") throw new Error(`UPSTASH_REDIS_REST_URL must be https:// or a private http:// endpoint, got ${u.protocol}`);
  const h = u.hostname.toLowerCase();
  let privateHost;
  if (h.startsWith("[")) {
    // An IPv6 literal: only loopback, link-local (fe80::/10) and unique-local
    // (fc00::/7) may carry the token in cleartext; a public address may not.
    const v6 = h.slice(1, -1);
    privateHost = v6 === "::1" || /^fe[89ab][0-9a-f]?:/.test(v6) || /^f[cd][0-9a-f]{2}:/.test(v6);
  } else {
    privateHost = h === "localhost" || h === "127.0.0.1" || h.endsWith(".internal") || !h.includes(".");
  }
  if (!privateHost) throw new Error("UPSTASH_REDIS_REST_URL is plain http:// to a public host — the token would travel in cleartext; use https://");
  return u;
}

/** Token-checked release: deletes the lock only if it still holds OUR token, so a run can never release a lock another run took over. */
export const LOCK_RELEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, v = pcall(cjson.decode, raw)
if ok and type(v) == 'table' and v.token == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/** What the lock holds: the token that releases it, and who/when for the operator who finds it stale. */
export function lockValue(token, now = Date.now(), pid = process.pid) {
  return JSON.stringify({ token, startedAt: new Date(now).toISOString(), pid });
}

/** The operator-facing description of a lock someone else holds. */
export function describeLock(raw, now = Date.now()) {
  try {
    const v = JSON.parse(raw);
    const ageMin = Math.max(0, Math.round((now - Date.parse(v.startedAt)) / 60_000));
    return `held since ${v.startedAt} (${ageMin} min ago, pid ${v.pid})`;
  } catch {
    return "held (unreadable lock value)";
  }
}

/** A log-safe label for a failure: name + capped message for an Error, a fixed string otherwise; any bearer token or URL in the message is redacted. */
export function errorLabel(err) {
  if (!(err instanceof Error)) return "failed (non-Error throw)";
  const msg = String(err.message || "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url redacted]")
    .slice(0, 200);
  return `${err.name || "Error"}: ${msg}`;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** One srh pipeline call; throws on HTTP failure and on the first per-command error (the app's client does not — this one must). */
async function pipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("UPSTASH_REDIS_REST_URL/TOKEN are not set — run this inside the app container");
  const base = assertRedisUrl(url);
  const res = await fetch(`${base.href.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`pipeline HTTP ${res.status}`);
  const replies = await res.json();
  const bad = replies.find((r) => r && r.error);
  if (bad) throw new Error(`pipeline command error: ${String(bad.error).slice(0, 120)}`);
  return replies;
}

/** HGETALL's flat [k, v, k, v] reply as an object. */
const flat = (arr) => {
  const o = {};
  for (let i = 0; i + 1 < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
};

/** The previous run's manifest, or null when this harness has nothing on the box. */
async function readManifest() {
  const [r] = await pipeline([["GET", MANIFEST_KEY]]);
  if (!r.result) return null;
  const m = JSON.parse(r.result);
  if (!Array.isArray(m.keys) || !m.fields || typeof m.fields !== "object") throw new Error("ctf:load-seed:manifest is not in the shape this seeder writes — refusing to guess; clean it by hand");
  return { keys: m.keys, fields: m.fields, complete: m.complete !== false };
}

/** Which of the manifest's keys and fields already exist in the store (EXISTS / HEXISTS, batched). */
async function probeExisting(manifest) {
  const keys = new Set();
  for (let i = 0; i < manifest.keys.length; i += BATCH) {
    const slice = manifest.keys.slice(i, i + BATCH);
    const replies = await pipeline(slice.map((k) => ["EXISTS", k]));
    slice.forEach((k, j) => { if (Number(replies[j].result) > 0) keys.add(k); });
  }
  const fields = {};
  const pairs = Object.entries(manifest.fields).flatMap(([k, fs]) => fs.map((f) => [k, f]));
  for (let i = 0; i < pairs.length; i += BATCH) {
    const slice = pairs.slice(i, i + BATCH);
    const replies = await pipeline(slice.map(([k, f]) => ["HEXISTS", k, f]));
    slice.forEach(([k, f], j) => { if (Number(replies[j].result) > 0) (fields[k] ||= new Set()).add(f); });
  }
  return { keys, fields };
}

/** The store rows the seed attaches to, resolved fail-closed by resolveCatalogue. */
async function readCatalogue() {
  const [settingsRes, quizRes, classicRes] = await pipeline([
    ["HGETALL", "ctf:admin:settings"],
    ["HGETALL", "ctf:quiz:questions"],
    ["HGETALL", "ctf:classic:challenges"],
  ]);
  const enabled = liveModules(flat(settingsRes.result));
  const scorerUrl = process.env.LEADERBOARD_API_URL || "";
  let sdChallenges = null;
  if ((enabled === null || enabled.includes("secure-development")) && scorerUrl) {
    const res = await fetch(`${scorerUrl.replace(/\/$/, "")}/challenges`);
    if (!res.ok) throw new Error(`scorer /challenges HTTP ${res.status}`);
    const data = await res.json();
    // Handed through as-is: resolveCatalogue is the one place that decides a
    // missing or malformed list is a refusal, and it is the tested seam.
    sdChallenges = data && data.challenges;
  }
  return resolveCatalogue({ enabled, quizRows: flat(quizRes.result), classicRows: flat(classicRes.result), sdChallenges, scorerUrl });
}

/** Take the lock or refuse: SET NX with our token; a held lock is reported with its age. */
async function acquireLock(token) {
  const [r] = await pipeline([["SET", LOCK_KEY, lockValue(token), "NX"]]);
  if (r.result === "OK") return;
  const [cur] = await pipeline([["GET", LOCK_KEY]]);
  throw new Error(`another seed or clean is ${describeLock(cur.result)} — wait for it, or run --break-lock once you are sure nothing is running`);
}

/** Release only our own lock (token-checked in Redis). */
async function releaseLock(token) {
  await pipeline([["EVAL", LOCK_RELEASE_SCRIPT, "1", LOCK_KEY, token]]);
}

/** CLI entry: --count N [--dry-run] seeds and records a manifest; --clean [--dry-run] removes exactly what the manifest lists; --break-lock clears a stale lock. Seed and clean hold the lock end to end. */
async function main() {
  const { values } = parseArgs({
    options: { count: { type: "string", default: "200" }, clean: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false }, "break-lock": { type: "boolean", default: false } },
  });
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 2 || count > 5000) throw new Error("--count must be an integer in 2..5000 (teams are 2–4)");

  if (values["break-lock"]) {
    const [cur] = await pipeline([["GET", LOCK_KEY]]);
    if (!cur.result) { console.log(JSON.stringify({ mode: "break-lock", note: "no lock was held" })); return; }
    await pipeline([["DEL", LOCK_KEY]]);
    console.log(JSON.stringify({ mode: "break-lock", broke: describeLock(cur.result) }));
    return;
  }

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await acquireLock(token);
  try {
    await run(values, count);
  } finally {
    await releaseLock(token).catch(() => {}); // a failed release leaves the lock for --break-lock; the run's own error wins
  }
}

/** The seed or clean proper, run under the lock. */
async function run(values, count) {
  const previous = await readManifest();
  if (values.clean) {
    if (!previous) { console.log(JSON.stringify({ mode: "clean", keys: 0, fields: 0, commands: 0, note: "no manifest — nothing seeded by this harness is on the box" })); return; }
    const plan = cleanCommands(previous);
    const summary = { mode: "clean", keys: plan.keys, fields: plan.fields, commands: plan.cmds.length, previousComplete: previous.complete };
    if (values["dry-run"]) { console.log(JSON.stringify({ ...summary, dryRun: true })); return; }
    // Data first, in batches; the manifest goes only once every deletion has
    // succeeded, in its own call — a failed batch throws before it and the
    // manifest stays to find the remaining rows by on the next --clean.
    for (let i = 0; i < plan.cmds.length; i += BATCH) await pipeline(plan.cmds.slice(i, i + BATCH));
    await pipeline([["DEL", MANIFEST_KEY]]);
    console.log(JSON.stringify(summary));
    return;
  }

  if (previous && !previous.complete) throw new Error("the previous seed did not finish (its manifest is marked incomplete) — run --clean first, then seed again");
  const catalogue = await readCatalogue();
  const plan = buildCommands({ count, catalogue });
  const manifest = manifestFor(plan.cmds);
  const clash = collisions(manifest, await probeExisting(manifest), previous);
  if (clash.length) throw new Error(`refusing to seed: ${clash.length} key(s)/field(s) already exist and are not this harness's (first: ${clash[0]}) — a contestant may own that login`);
  const batches = planBatches(plan.cmds, previous);
  const summary = { mode: "seed", ...plan.stats, commands: plan.cmds.length, batches: batches.length, manifest: { keys: manifest.keys.length, fields: Object.values(manifest.fields).reduce((n, a) => n + a.length, 0) }, catalogue: { quiz: catalogue.quiz.length, classic: catalogue.classic.length, sdTargets: Object.keys(catalogue.sd).length, sdChallenges: Object.values(catalogue.sd).reduce((n, a) => n + a.length, 0) } };
  if (values["dry-run"]) { console.log(JSON.stringify({ ...summary, dryRun: true })); return; }

  for (let i = 0; i < batches.length; i++) {
    let reply;
    try {
      [reply] = await pipeline([["EVAL", SEED_SCRIPT, "0", JSON.stringify(batches[i].ops), MANIFEST_KEY, JSON.stringify(batches[i].manifest)]]);
    } catch (err) {
      throw new Error(`seed aborted in batch ${i + 1} of ${batches.length} (${errorLabel(err)}); the manifest records the batches that completed — run --clean, then seed again`);
    }
    const out = String(reply && reply.result);
    if (out.startsWith("collision:")) {
      throw new Error(`refusing to seed: ${out.slice("collision:".length)} was written by someone else between the probe and batch ${i + 1} of ${batches.length} — nothing from that batch was written; the manifest records the batches before it — run --clean, then seed again`);
    }
    if (!out.startsWith("ok:")) throw new Error(`seed script answered unexpectedly in batch ${i + 1}: ${out.slice(0, 60)}`);
  }
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { console.error(errorLabel(err)); process.exit(1); });
}
