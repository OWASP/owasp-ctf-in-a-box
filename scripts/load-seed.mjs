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
// Deliberately not written: ctf:classic:solvecount (the seed RAISES it and a
// clean could not un-raise it exactly); hint purchases (no penalty path on a
// load run). Both are noted in the report.
//
// IDEMPOTENT AND REVERSIBLE. Logins are `load-0001`…, teams `load-team-01`…;
// the same --count regenerates the same set, so a re-run rewrites, and
// --clean with the same --count deletes exactly those keys/fields and nothing
// else. Master reset also removes them; --clean is so the box does not depend
// on that.

import { parseArgs } from "node:util";

const LOGIN_PREFIX = "load-";
const TEAM_PREFIX = "load-team-";
const BATCH = 200;
const WINDOW_MS = 2 * 60 * 60 * 1000;

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

export function attemptRow(tries, earnedAtMs, gapMinutes, floorMs) {
  const firstAtMs = Math.max(earnedAtMs - (5 + (tries - 1) * gapMinutes) * 60_000, floorMs);
  return JSON.stringify({
    attempts: tries,
    firstAt: new Date(firstAtMs).toISOString(),
    lastAt: new Date(earnedAtMs).toISOString(),
    lastAtMs: earnedAtMs,
  });
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

/** The exact inverse of buildCommands for the same --count. */
export function cleanCommands({ count, catalogue }) {
  const rand = rng(439 + count);
  const logins = Array.from({ length: count }, (_, i) => loginFor(i + 1));
  const teams = partitionTeams(logins, rand);
  const cmds = [];
  for (const t of teams) cmds.push(["DEL", `ctf:team:${t.slug}`, `ctf:team:${t.slug}:members`]);
  for (const login of logins) {
    cmds.push(["DEL", `ctf:user:${login}`, `ctf:quiz:answers:${login}`, `ctf:quiz:attempts:${login}`, `ctf:classic:solves:${login}`, `ctf:classic:attempts:${login}`]);
    cmds.push(["HDEL", "ctf:quiz:points", login], ["HDEL", "ctf:quiz:answered", login], ["HDEL", "ctf:classic:points", login], ["HDEL", "ctf:classic:solved", login]);
  }
  // SD solves are fields of ctf:solves:<target>; delete every field of ours,
  // whether or not this run wrote it (a stale --count would otherwise leak).
  for (const [target, ids] of Object.entries(catalogue.sd)) {
    for (const login of logins) {
      for (let i = 0; i < ids.length; i += 100) cmds.push(["HDEL", `ctf:solves:${target}`, ...ids.slice(i, i + 100).map((id) => `${login}:${id}`)]);
    }
  }
  return { cmds, logins, teams };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

async function pipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("UPSTASH_REDIS_REST_URL/TOKEN are not set — run this inside the app container");
  const res = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`pipeline HTTP ${res.status}`);
  const replies = await res.json();
  const bad = replies.find((r) => r && r.error);
  if (bad) throw new Error(`pipeline command error: ${bad.error}`);
  return replies;
}

const flat = (arr) => {
  const o = {};
  for (let i = 0; i + 1 < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
};

async function readCatalogue() {
  const [settingsRes, quizRes, classicRes] = await pipeline([
    ["HGETALL", "ctf:admin:settings"],
    ["HGETALL", "ctf:quiz:questions"],
    ["HGETALL", "ctf:classic:challenges"],
  ]);
  const settings = flat(settingsRes.result);
  let enabled = null;
  try { enabled = settings.enabledModuleIds ? JSON.parse(settings.enabledModuleIds) : null; } catch { enabled = null; }
  const live = (id) => enabled === null || enabled.includes(id);

  const quiz = live("quiz")
    ? Object.values(flat(quizRes.result)).map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean)
        .map((q) => ({ id: q.id, points: Number(q.points) || 0, choices: Array.isArray(q.correct) ? q.correct : [] }))
    : [];
  const classic = live("classic")
    ? Object.values(flat(classicRes.result)).map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean)
        .map((c) => ({ id: c.id, points: Number(c.points) || 0 }))
    : [];

  const sd = {};
  const base = process.env.LEADERBOARD_API_URL;
  if (live("secure-development") && base) {
    const res = await fetch(`${base.replace(/\/$/, "")}/challenges`);
    if (!res.ok) throw new Error(`scorer /challenges HTTP ${res.status}`);
    const data = await res.json();
    for (const c of data.challenges || []) (sd[c.app] ||= []).push(c.id);
  }
  return { quiz, classic, sd };
}

async function main() {
  const { values } = parseArgs({
    options: { count: { type: "string", default: "200" }, clean: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false } },
  });
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 5000) throw new Error("--count must be an integer in 1..5000");

  const catalogue = await readCatalogue();
  const plan = values.clean ? cleanCommands({ count, catalogue }) : buildCommands({ count, catalogue });
  const summary = values.clean
    ? { mode: "clean", contestants: count, teams: plan.teams.length, commands: plan.cmds.length }
    : { mode: "seed", ...plan.stats, commands: plan.cmds.length, catalogue: { quiz: catalogue.quiz.length, classic: catalogue.classic.length, sdTargets: Object.keys(catalogue.sd).length, sdChallenges: Object.values(catalogue.sd).reduce((s, a) => s + a.length, 0) } };
  if (values["dry-run"]) { console.log(JSON.stringify({ ...summary, dryRun: true })); return; }

  for (let i = 0; i < plan.cmds.length; i += BATCH) await pipeline(plan.cmds.slice(i, i + BATCH));
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { console.error(String(err && err.message || err)); process.exit(1); });
}
