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
//   - the SEED first checks every key and field it is about to write and
//     ABORTS if any already exists and is not in the previous manifest (a
//     real contestant, or someone else's rows, would otherwise be overwritten
//     or merged into);
//   - the CLEAN deletes exactly the manifest's entries and the manifest, and
//     reads no catalogue, no --count and no pattern — a challenge removed or a
//     module disabled after seeding cannot strand a field, and no real row
//     can be touched. No manifest means nothing to clean.
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
 * error paths are testable: a live Secure Development module with no scorer
 * address, or no scorer catalogue, aborts the seed (fail closed).
 */
export function resolveCatalogue({ enabled, quizRows, classicRows, sdChallenges, scorerUrl }) {
  const live = (id) => enabled === null || enabled.includes(id);
  const parseRows = (rows) => Object.values(rows || {}).map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
  const quiz = live("quiz")
    ? parseRows(quizRows).map((q) => ({ id: q.id, points: Number(q.points) || 0, choices: Array.isArray(q.correct) ? q.correct : [] }))
    : [];
  const classic = live("classic")
    ? parseRows(classicRows).map((c) => ({ id: c.id, points: Number(c.points) || 0 }))
    : [];
  const sd = {};
  if (live("secure-development")) {
    if (!scorerUrl) throw new Error("Secure Development is live but LEADERBOARD_API_URL is not set — refusing to seed a board with no scorer catalogue");
    if (!Array.isArray(sdChallenges)) throw new Error("Secure Development is live but the scorer's /challenges did not answer — refusing to seed");
    for (const c of sdChallenges) (sd[c.app] ||= []).push(c.id);
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

/** The exact inverse of a manifest: DEL its keys, HDEL its fields, then DEL the manifest itself. */
export function cleanCommands(manifest) {
  const cmds = [];
  const keys = manifest.keys || [];
  for (let i = 0; i < keys.length; i += 100) cmds.push(["DEL", ...keys.slice(i, i + 100)]);
  let fields = 0;
  for (const [key, names] of Object.entries(manifest.fields || {})) {
    for (let i = 0; i < names.length; i += 100) cmds.push(["HDEL", key, ...names.slice(i, i + 100)]);
    fields += names.length;
  }
  cmds.push(["DEL", MANIFEST_KEY]);
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
  const privateHost = h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".internal") || !h.includes(".");
  if (!privateHost) throw new Error("UPSTASH_REDIS_REST_URL is plain http:// to a public host — the token would travel in cleartext; use https://");
  return u;
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
  if (!Array.isArray(m.keys) || typeof m.fields !== "object") throw new Error("ctf:load-seed:manifest is not in the shape this seeder writes — refusing to guess; clean it by hand");
  return m;
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
    sdChallenges = data.challenges || [];
  }
  return resolveCatalogue({ enabled, quizRows: flat(quizRes.result), classicRows: flat(classicRes.result), sdChallenges, scorerUrl });
}

/** CLI entry: --count N [--dry-run] seeds and records a manifest; --clean [--dry-run] removes exactly what the manifest lists. */
async function main() {
  const { values } = parseArgs({
    options: { count: { type: "string", default: "200" }, clean: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false } },
  });
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 2 || count > 5000) throw new Error("--count must be an integer in 2..5000 (teams are 2–4)");

  const previous = await readManifest();
  let cmds;
  let summary;
  if (values.clean) {
    if (!previous) { console.log(JSON.stringify({ mode: "clean", keys: 0, fields: 0, commands: 0, note: "no manifest — nothing seeded by this harness is on the box" })); return; }
    const plan = cleanCommands(previous);
    cmds = plan.cmds;
    summary = { mode: "clean", keys: plan.keys, fields: plan.fields, commands: cmds.length };
  } else {
    const catalogue = await readCatalogue();
    const plan = buildCommands({ count, catalogue });
    const manifest = manifestFor(plan.cmds);
    const clash = collisions(manifest, await probeExisting(manifest), previous);
    if (clash.length) throw new Error(`refusing to seed: ${clash.length} key(s)/field(s) already exist and are not this harness's (first: ${clash[0]}) — a contestant may own that login`);
    cmds = [...plan.cmds, ["SET", MANIFEST_KEY, JSON.stringify(manifest)]];
    summary = { mode: "seed", ...plan.stats, commands: cmds.length, manifest: { keys: manifest.keys.length, fields: Object.values(manifest.fields).reduce((n, a) => n + a.length, 0) }, catalogue: { quiz: catalogue.quiz.length, classic: catalogue.classic.length, sdTargets: Object.keys(catalogue.sd).length, sdChallenges: Object.values(catalogue.sd).reduce((n, a) => n + a.length, 0) } };
  }
  if (values["dry-run"]) { console.log(JSON.stringify({ ...summary, dryRun: true })); return; }

  for (let i = 0; i < cmds.length; i += BATCH) await pipeline(cmds.slice(i, i + BATCH));
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { console.error(errorLabel(err)); process.exit(1); });
}
