#!/usr/bin/env node
// A read-only differential score auditor: recompute every contestant's and
// every team's score from the raw Redis rows, then diff that against what the
// app actually serves on /leaderboard. A mismatch is a finding.
//
// RUNS INSIDE THE APP CONTAINER (Node 22, built-ins only), exactly like
// scripts/load-seed.mjs: srh sits on the machine's private network and the
// container already holds UPSTASH_REDIS_REST_URL / _TOKEN and the scorer's
// LEADERBOARD_API_URL. scripts/score-audit.sh uploads it and runs it there.
//
// INDEPENDENT ON PURPOSE. Nothing here imports apps/web/src/lib/leaderboard/*
// or any store: the point is a second implementation of the DOCUMENTED rules,
// written from the docs and read (not imported) from the code, so a bug in
// the fold shows up as a disagreement instead of being reproduced.
//
// READ-ONLY, ENFORCED. Every command goes through `pipeline()`, which calls
// `assertReadOnly()` first and throws — sending nothing — on any command not
// in READ_ONLY_COMMANDS. The only HTTP calls are GETs: the scorer's public
// /challenges catalogue and the app's own /leaderboard.
//
// THE RULES, AS DERIVED (file:line at v0.7.0, 37bdb813)
//
//  R1  Which modules count. `ctf:admin:settings` field `enabledModules`, a
//      COMMA list (not JSON): absent → the deployment default (Secure
//      Development iff SCORE_IMAGE is non-empty, else nothing); "" → nothing;
//      only unknown ids → default. Secure Development is dropped whenever
//      SCORE_IMAGE is empty. A disabled module contributes nothing anywhere.
//      apps/web/src/lib/admin-store.ts:393-401, enabled-modules.ts:63-68,
//      module-defaults.ts:11-23, module-contributions.ts:77-81.
//  R2  Secure Development off ⇒ the board has no SD data at all (empty
//      source): leaderboard/source.ts:52.
//  R3  SD points per contestant = Σ rubric points of the ids they solved,
//      from `ctf:solves:<target>` fields `<author>:<challengeId>` (split at
//      the FIRST ':'); ids the rubric does not know are ignored; targets are
//      the rubric's (the scorer's /challenges list). `patched` = count.
//      `lastSolveAt` = the latest solve time. scorer/src/serve.js:190-213,
//      scorer/src/store.js:6-7. The app ATTRIBUTES this total, never adds it
//      again: leaderboard/module-contributions.ts:624-635.
//  R4  Quiz / classic / ai per contestant = the aggregate counters
//      (`ctf:<m>:points` + `ctf:<m>:answered|solved`), ADDED to the row, and
//      only when the completed count is > 0. quiz-store.ts:577-590,
//      classic-store.ts:950-963, ai-store.ts:471-484,
//      module-contributions.ts:639-655.
//  R5  The contestant rows are the union (case-insensitive) of SD authors and
//      logins with completed > 0 in a live app-side module; a module-only
//      login gets a created row. module-contributions.ts:546-608.
//  R6  A team is its CURRENT `ctf:team:<slug>:members` set — the join refuses
//      a login already on a team and leave/remove SREMs it, so a login is on
//      at most one team, and a login that changed teams carries ALL of its
//      solves (including those made before the move) to the new team and
//      none stay with the old one: team totals fold from membership at read
//      time. team-store.ts:117-157 (CREATE/JOIN/LEAVE/REMOVE scripts),
//      team-store.ts:537-572, scorer/src/serve.js:249-253,
//      docs/operations.md:96-110.
//  R7  A team's module total is the UNION of its members' items, never the
//      sum: SD by (target, id) across members; quiz/classic/ai by item id
//      across the members' `ctf:quiz:answers:<login>` /
//      `ctf:classic:solves:<login>` / `ctf:ai:solves:<login>` rows
//      ({points, at} JSON), the EARLIEST row winning, each module counted
//      ONCE. scorer/src/serve.js:256-275, leaderboard/team-fold.ts:43-106,
//      docs/operations.md:118-122 and :1164-1170 ("points count per team").
//  R8  Hint penalty: `ctf:hints:spent` (points, per login), only while hints
//      are enabled (`hintsEnabled` absent → on, "1" → on, else off); fields
//      summed case-insensitively; a contestant's penalty is their own spend;
//      a TEAM's is the SUM of its members' spend (a hint two teammates both
//      bought is charged twice). Applied LAST, to the all-module total,
//      floored at 0. hint-store.ts:165,412-426, hint-penalties.ts:25-30,
//      62-98, folded.ts:49-74.
//  R9  Contestant rank: completed items across modules desc, then (net)
//      points desc, then the latest activity time asc (a row with none sorts
//      last); a full tie falls through to an order this auditor does not
//      model, so it accepts any order WITHIN a tie group. rank.ts:15-17,
//      49-70, hint-penalties.ts:81.
//  R10 Team rank: net points desc; ties keep an earlier stage's order
//      (unmodelled — accepted within the tie group). hint-penalties.ts:97,
//      module-contributions.ts:742.
//  R11 Every login join is case-insensitive (AGENTS.md; hint-penalties.ts:62,
//      module-contributions.ts:178-183, team-standings.ts:91-94). This
//      auditor applies that to the SD team union too, where the scorer joins
//      verbatim (scorer/src/serve.js:259) — a case disagreement there shows
//      up as a mismatch, which is the point.
//
// STORE INVARIANTS it also checks (reported apart from board mismatches, and
// they fail the run too): each app-side aggregate equals its per-login rows
// (the grading Lua writes both atomically); a login is on at most one team,
// and its `ctf:user:<login>` `team` field names that team.
//
// WHAT IT READS FROM THE APP, AND WHY THE FLIGHT PAYLOAD. `GET /leaderboard`
// with `RSC: 1` returns the React Server Components flight stream for the
// page, which carries — as JSON — the exact `data` prop the server handed the
// <Leaderboard> client component: every entry and team with points, ranks,
// module blocks and hint penalties. The rendered HTML shows a formatted
// SUBSET of the same object (collapsed rows, "1.2k"), so parsing it would
// audit the formatter too. The parser here is strict: it resolves only the
// reference forms it knows (`$$`, `$undefined`, `$<row>`, `$<row>:path`),
// requires exactly one object shaped like the board's props, validates every
// field it compares, and THROWS on anything else — a shape it does not
// recognise is never "no diffs". A redirect off /leaderboard (the pre-launch
// lock sends visitors to /) is a failure, not an empty board.
//
// STALENESS. The board is memoized for 10 s (folded.ts:44) and its SD part
// comes through a fetch cached with `revalidate: 30` (lambda.ts:242-244),
// which serves a copy up to 30 s old as fresh, and an older one once (stale)
// while it refreshes behind it. So each attempt (auditAttempt) reads the
// store (S1); when Secure Development is live, waits past that cache
// (--sd-cache-ms, 32 s) so any copy cached before S1 is stale; fetches the
// board once to trigger the refresh; waits past the memo (--settle-ms, 12 s);
// fetches the board it compares; reads the store again (S2); and compares
// only when S1 and S2 are identical. Otherwise it retries, and after
// --attempts it FAILS as unstable. Run it on a quiet box.
//
// OUTPUT: a human summary on stdout, the full JSON report at --report, and a
// last stdout line `{"mode":"score-audit",...}`. Exit 0 only when zero board
// mismatches, zero invariant findings AND a non-vacuous comparison; 1 on
// findings; 2 on usage; 3 when the audit could not be trusted (vacuous, a
// payload it could not parse, an unstable store, a read that failed).

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const MODULES = ["secure-development", "quiz", "classic", "ai"];
export const APP_MODULES = ["quiz", "classic", "ai"];
/** Per-login row hash and aggregate counters for each app-side module. */
export const MODULE_KEYS = {
  quiz: { points: "ctf:quiz:points", count: "ctf:quiz:answered", rows: "ctf:quiz:answers:" },
  classic: { points: "ctf:classic:points", count: "ctf:classic:solved", rows: "ctf:classic:solves:" },
  ai: { points: "ctf:ai:points", count: "ctf:ai:solved", rows: "ctf:ai:solves:" },
};
const BATCH = 200;
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

/** The only Redis commands this script may send. */
export const READ_ONLY_COMMANDS = new Set(["GET", "HGET", "HGETALL", "HMGET", "HEXISTS", "HLEN", "SMEMBERS", "SCARD", "SISMEMBER", "SCAN", "ZRANGE", "EXISTS", "TYPE"]);

/** Throws — before anything is sent — unless every command is a known read. */
export function assertReadOnly(commands) {
  if (!Array.isArray(commands) || commands.length === 0) throw new Error("assertReadOnly: expected a non-empty command list");
  for (const c of commands) {
    const name = Array.isArray(c) && typeof c[0] === "string" ? c[0].toUpperCase() : null;
    if (!name || !READ_ONLY_COMMANDS.has(name)) throw new Error(`refusing to send a non-read-only command: ${name ?? JSON.stringify(c).slice(0, 40)}`);
  }
}

// ---------------------------------------------------------------------------
// Pure: settings decoding
// ---------------------------------------------------------------------------

/** R1: the live module set from the raw settings hash and whether the deployment has a scorer image. */
export function liveModules(settings, scoreImage) {
  const raw = settings ? settings.enabledModules : undefined;
  const fallback = scoreImage ? ["secure-development"] : [];
  let ids;
  if (typeof raw !== "string") ids = fallback;
  else if (raw.trim() === "") ids = [];
  else {
    const known = raw.split(",").map((s) => s.trim()).filter((s) => MODULES.includes(s));
    ids = known.length > 0 ? known : fallback;
  }
  const live = new Set(ids);
  if (!scoreImage) live.delete("secure-development");
  return live;
}

/** R8: hints on unless the organizer stored anything other than "1". */
export function hintsEnabled(settings) {
  const v = settings ? settings.hintsEnabled : undefined;
  return v === undefined || v === null || v === "1";
}

const lc = (s) => String(s).toLowerCase();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One {points, at} earned row, or null when it is not that shape (such a row counts for nothing). */
export function parseEarnedRow(raw) {
  if (typeof raw !== "string") return null;
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object" || typeof v.points !== "number" || typeof v.at !== "string") return null;
  return { points: v.points, at: v.at, ms: Date.parse(v.at) };
}

// ---------------------------------------------------------------------------
// Pure: the recompute
// ---------------------------------------------------------------------------

/**
 * Everything the board should say, from a raw snapshot:
 *   snapshot = {
 *     settings: {field: value},           // ctf:admin:settings
 *     scoreImage: boolean,                // SCORE_IMAGE non-empty in the container
 *     sdCatalogue: [{app, id, points}] | null,
 *     sdSolves: {target: {"<author>:<id>": iso}},
 *     agg: {quiz: {points: {login: n}, count: {login: n}}, classic: …, ai: …},
 *     rows: {quiz: {login: {itemId: json}}, classic: …, ai: …},
 *     hintsSpent: {login: n},
 *     teams: [{slug, name, members: [login]}],
 *     users: {login: teamSlug | null},    // ctf:user:<login> team field
 *   }
 */
export function recompute(snapshot) {
  const live = liveModules(snapshot.settings, snapshot.scoreImage);
  const invariants = [];
  const stats = { sdSolvesCounted: 0, sdSolvesIgnored: 0, quizAnswers: 0, classicSolves: 0, aiSolves: 0, hintLogins: 0 };

  // --- SD per author (R2, R3) ----------------------------------------------
  const sdAuthors = new Map(); // lower -> { login, points, patched, lastSolveAt, solves: Map<target:id, {points, at}> }
  if (live.has("secure-development")) {
    if (!Array.isArray(snapshot.sdCatalogue)) throw new Error("Secure Development is live but the snapshot has no scorer catalogue");
    const points = new Map();
    for (const c of snapshot.sdCatalogue) points.set(`${c.app}\u0000${c.id}`, Number(c.points));
    const targets = [...new Set(snapshot.sdCatalogue.map((c) => c.app))];
    for (const target of targets) {
      for (const [field, at] of Object.entries((snapshot.sdSolves || {})[target] || {})) {
        const i = field.indexOf(":");
        if (i < 1) { stats.sdSolvesIgnored += 1; continue; }
        const author = field.slice(0, i);
        const id = field.slice(i + 1);
        const p = points.get(`${target}\u0000${id}`);
        if (p === undefined) { stats.sdSolvesIgnored += 1; continue; }
        stats.sdSolvesCounted += 1;
        const key = lc(author);
        let a = sdAuthors.get(key);
        if (!a) sdAuthors.set(key, (a = { login: author, spellings: new Set(), points: 0, patched: 0, lastSolveAt: null, solves: new Map() }));
        a.spellings.add(author);
        a.points += p;
        a.patched += 1;
        if (a.lastSolveAt === null || at > a.lastSolveAt) a.lastSolveAt = at;
        const item = `${target}:${id}`;
        const prev = a.solves.get(item);
        if (!prev || at < prev.at) a.solves.set(item, { points: p, at });
      }
    }
    for (const a of sdAuthors.values()) {
      if (a.spellings.size > 1) invariants.push({ kind: "sd-author-case-split", login: a.login, detail: `one login solved Secure Development under ${a.spellings.size} spellings (${[...a.spellings].join(", ")}); the scorer keeps them as separate rows` });
    }
  }

  // --- app-side aggregates per login (R4) and their rows (invariant) -------
  const agg = {}; // module -> Map(lower -> {login, points, completed})
  for (const m of APP_MODULES) {
    const a = (snapshot.agg || {})[m] || { points: {}, count: {} };
    const map = new Map();
    for (const login of new Set([...Object.keys(a.points || {}), ...Object.keys(a.count || {})])) {
      map.set(lc(login), { login, points: num((a.points || {})[login]) ?? 0, completed: num((a.count || {})[login]) ?? 0 });
    }
    agg[m] = map;
    // Invariant: the aggregate equals the per-login rows it summarises.
    const rowsByLogin = (snapshot.rows || {})[m] || {};
    const logins = new Set([...map.values()].map((t) => t.login));
    for (const [login, row] of Object.entries(rowsByLogin)) if (row && Object.keys(row).length) logins.add(login);
    for (const login of logins) {
      const rows = Object.values(rowsByLogin[login] || {}).map(parseEarnedRow).filter(Boolean);
      const rowPts = rows.reduce((s, r) => s + r.points, 0);
      const t = map.get(lc(login));
      const aggPts = t ? t.points : 0;
      const aggN = t ? t.completed : 0;
      if (rowsByLogin[login] === undefined) continue; // rows not read for this login
      if (rowPts !== aggPts || rows.length !== aggN) {
        invariants.push({ kind: "aggregate-vs-rows", module: m, login, detail: `aggregate ${aggPts} pts / ${aggN} items, per-login rows ${rowPts} pts / ${rows.length} items` });
      }
    }
    if (live.has(m)) {
      const n = [...map.values()].reduce((s, t) => s + (t.completed > 0 ? t.completed : 0), 0);
      if (m === "quiz") stats.quizAnswers = n;
      if (m === "classic") stats.classicSolves = n;
      if (m === "ai") stats.aiSolves = n;
    }
  }

  // --- hint penalties (R8) --------------------------------------------------
  const penalty = new Map();
  if (hintsEnabled(snapshot.settings)) {
    for (const [login, v] of Object.entries(snapshot.hintsSpent || {})) {
      const p = num(v);
      if (p === null || p <= 0) continue;
      penalty.set(lc(login), (penalty.get(lc(login)) ?? 0) + p);
    }
  }
  stats.hintLogins = penalty.size;

  // --- team membership (R6) -------------------------------------------------
  const teams = snapshot.teams || [];
  const teamOf = new Map(); // lower login -> slug (first seen)
  const onTeams = new Map(); // lower login -> [slug]
  for (const t of teams) for (const m of t.members) {
    const k = lc(m);
    if (!teamOf.has(k)) teamOf.set(k, t.slug);
    onTeams.set(k, [...(onTeams.get(k) || []), t.slug]);
  }
  for (const [login, slugs] of onTeams) {
    if (slugs.length > 1) invariants.push({ kind: "login-on-several-teams", login, detail: `on ${slugs.join(", ")} — its points count for every one of them` });
  }
  for (const t of teams) for (const m of t.members) {
    const users = snapshot.users || {};
    if (!(m in users)) continue;
    if (users[m] !== t.slug) invariants.push({ kind: "user-team-field", login: m, detail: `in ctf:team:${t.slug}:members but ctf:user:${m} team = ${JSON.stringify(users[m])}` });
  }

  // --- contestant rows (R3, R4, R5, R8) --------------------------------------
  const entries = new Map();
  const touch = (login) => {
    const k = lc(login);
    if (!entries.has(k)) entries.set(k, { login, modules: {}, gross: 0, completed: 0, lastSolveAt: null });
    return entries.get(k);
  };
  for (const a of sdAuthors.values()) {
    const e = touch(a.login);
    e.modules["secure-development"] = { points: a.points, completed: a.patched };
    e.gross += a.points;
    e.completed += a.patched;
    e.lastSolveAt = a.lastSolveAt;
  }
  for (const m of APP_MODULES) {
    if (!live.has(m)) continue;
    for (const t of agg[m].values()) {
      if (t.completed <= 0) continue;
      const e = touch(t.login);
      e.modules[m] = { points: t.points, completed: t.completed };
      e.gross += t.points;
      e.completed += t.completed;
    }
  }
  for (const [k, e] of entries) {
    e.penalty = penalty.get(k) ?? 0;
    e.points = Math.max(0, e.gross - e.penalty);
    const ms = e.lastSolveAt ? Date.parse(e.lastSolveAt) : NaN;
    e.activityMs = Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
    e.team = teamOf.get(k) ?? null;
  }

  // --- team rows (R6, R7, R8) -------------------------------------------------
  const teamRows = new Map();
  for (const t of teams) {
    const modules = {};
    let gross = 0;
    if (live.has("secure-development")) {
      const union = new Map();
      for (const m of t.members) {
        const a = sdAuthors.get(lc(m));
        if (!a) continue;
        for (const [item, s] of a.solves) if (!union.has(item) || s.at < union.get(item).at) union.set(item, s);
      }
      const pts = [...union.values()].reduce((s, x) => s + x.points, 0);
      if (union.size > 0 || pts > 0) modules["secure-development"] = { points: pts, completed: union.size };
      gross += pts;
    }
    for (const mod of APP_MODULES) {
      if (!live.has(mod)) continue;
      const byItem = new Map();
      for (const m of t.members) {
        for (const [item, raw] of Object.entries(((snapshot.rows || {})[mod] || {})[m] || {})) {
          const r = parseEarnedRow(raw);
          if (!r) continue;
          const prev = byItem.get(item);
          if (!prev || r.ms < prev.ms) byItem.set(item, r);
        }
      }
      if (byItem.size === 0) continue;
      const pts = [...byItem.values()].reduce((s, r) => s + r.points, 0);
      modules[mod] = { points: pts, completed: byItem.size };
      gross += pts;
    }
    const pen = t.members.reduce((s, m) => s + (penalty.get(lc(m)) ?? 0), 0);
    teamRows.set(t.slug, { slug: t.slug, name: t.name, members: [...t.members].sort(), modules, gross, penalty: pen, points: Math.max(0, gross - pen) });
  }

  // --- ranks as tie groups (R9, R10) -----------------------------------------
  const entryKey = (e) => [-e.completed, -e.points, e.activityMs];
  assignRankRanges([...entries.values()], entryKey);
  assignRankRanges([...teamRows.values()], (t) => [-t.points]);

  return { live: [...live].sort(), hints: hintsEnabled(snapshot.settings), entries, teams: teamRows, invariants, stats };
}

/** Sorts rows on `key` (a tuple, ascending) and gives each the rank RANGE its tie group occupies. */
export function assignRankRanges(rows, key) {
  const cmp = (a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  };
  const sorted = [...rows].sort(cmp);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && cmp(sorted[i], sorted[j + 1]) === 0) j += 1;
    for (let k = i; k <= j; k += 1) sorted[k].rankRange = [i + 1, j + 1];
    i = j + 1;
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Pure: the flight payload parser
// ---------------------------------------------------------------------------

/** Splits a React flight stream into rows: Map(id -> {tag, value}). JSON rows are parsed; `T` text rows are sized in BYTES. */
export function parseFlightRows(text) {
  const buf = Buffer.from(text, "utf8");
  const rows = new Map();
  let pos = 0;
  while (pos < buf.length) {
    if (buf[pos] === 0x0a) { pos += 1; continue; }
    const colon = buf.indexOf(0x3a, pos);
    if (colon < 0) throw new Error(`flight: a row with no ':' at byte ${pos}`);
    const id = buf.subarray(pos, colon).toString("utf8");
    if (!/^[0-9a-f]*$/.test(id)) throw new Error(`flight: row id ${JSON.stringify(id.slice(0, 20))} is not hex — not a flight stream`);
    pos = colon + 1;
    if (buf[pos] === 0x54 /* T */) {
      const comma = buf.indexOf(0x2c, pos);
      const len = parseInt(buf.subarray(pos + 1, comma).toString("utf8"), 16);
      if (comma < 0 || !Number.isFinite(len)) throw new Error(`flight: malformed text row ${id}`);
      rows.set(id, { tag: "T", value: buf.subarray(comma + 1, comma + 1 + len).toString("utf8") });
      pos = comma + 1 + len;
      continue;
    }
    let nl = buf.indexOf(0x0a, pos);
    if (nl < 0) nl = buf.length;
    const body = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    const first = body[0];
    if (first === "[" || first === "{" || first === '"' || first === "-" || (first >= "0" && first <= "9") || body === "null" || body === "true" || body === "false") {
      try {
        rows.set(id, { tag: "J", value: JSON.parse(body) });
      } catch {
        throw new Error(`flight: row ${id} looks like JSON but does not parse`);
      }
    } else {
      rows.set(id, { tag: first || "", value: body.slice(1) }); // I, HL, E, D, W, X, C… — not model data
    }
  }
  return rows;
}

/** Resolves flight references inside `node`, throwing on any form this auditor does not understand. */
export function resolveRefs(node, rows, path = "data", depth = 0) {
  if (depth > 60) throw new Error(`flight: reference chain too deep at ${path}`);
  if (typeof node === "string") {
    if (!node.startsWith("$")) return node;
    if (node.startsWith("$$")) return node.slice(1);
    if (node === "$undefined") return undefined;
    const m = /^\$([0-9a-f]+)((?::[^:]+)*)$/.exec(node);
    if (!m) throw new Error(`flight: unsupported reference ${JSON.stringify(node.slice(0, 40))} at ${path} — refusing to guess`);
    const row = rows.get(m[1]);
    if (!row || row.tag !== "J") throw new Error(`flight: reference ${JSON.stringify(node.slice(0, 60))} at ${path} points at no JSON row`);
    let cur = row.value;
    for (const seg of m[2] ? m[2].slice(1).split(":") : []) {
      // Only a reference AT this step is followed; the rest of the row (an
      // element tree, with its "$" markers) is walked raw, never resolved.
      if (typeof cur === "string" && cur.startsWith("$") && !cur.startsWith("$$")) cur = resolveRefs(cur, rows, path, depth + 1);
      // A React element is serialized as ["$", type, key, props]; a path walks it by name.
      if (Array.isArray(cur) && cur[0] === "$" && ["type", "key", "props"].includes(seg)) cur = cur[{ type: 1, key: 2, props: 3 }[seg]];
      else if (cur && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, seg)) cur = cur[seg];
      else throw new Error(`flight: reference ${JSON.stringify(node.slice(0, 60))} at ${path} does not resolve (segment ${seg})`);
    }
    return resolveRefs(cur, rows, path, depth + 1);
  }
  if (Array.isArray(node)) return node.map((v, i) => resolveRefs(v, rows, `${path}[${i}]`, depth + 1));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolveRefs(v, rows, `${path}.${k}`, depth + 1);
    return out;
  }
  return node;
}

const isBoardProps = (o) =>
  o && typeof o === "object" && !Array.isArray(o) && "viewerLogin" in o && o.data && typeof o.data === "object" &&
  Array.isArray(o.data.entries) && Array.isArray(o.data.teams) && o.data.capabilities && typeof o.data.generatedAt === "string";

/** The served board from a flight stream: exactly one <Leaderboard> props object, resolved and validated. */
export function extractBoard(text) {
  if (typeof text !== "string" || text.length === 0) throw new Error("flight: empty response");
  const rows = parseFlightRows(text);
  const found = [];
  const walk = (n) => {
    if (Array.isArray(n)) { for (const v of n) walk(v); return; }
    if (n && typeof n === "object") {
      if (isBoardProps(n)) { found.push(n); return; }
      for (const v of Object.values(n)) walk(v);
    }
  };
  for (const r of rows.values()) if (r.tag === "J") walk(r.value);
  if (found.length === 0) throw new Error("flight: no <Leaderboard> props (an object with viewerLogin and data.entries/teams/capabilities/generatedAt) — the page shape changed; refusing to report 'no diffs'");
  if (found.length > 1) throw new Error(`flight: ${found.length} objects look like the board props — ambiguous; refusing to guess`);
  const data = resolveRefs(found[0].data, rows);
  return validateBoard(data);
}

/** Checks every field the diff reads, naming the first bad one. */
export function validateBoard(data) {
  const fail = (p, what) => { throw new Error(`served board: ${p} ${what} — unrecognised shape`); };
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const mods = (m, p) => {
    if (m === undefined) return {};
    if (!m || typeof m !== "object" || Array.isArray(m)) fail(p, "is not an object");
    const out = {};
    for (const [id, b] of Object.entries(m)) {
      if (b === undefined) continue;
      if (!MODULES.includes(id)) fail(`${p}.${id}`, "is not a known module");
      if (!b || !isNum(b.points) || !isNum(b.completed)) fail(`${p}.${id}`, "has no numeric points/completed");
      out[id] = { points: b.points, completed: b.completed };
    }
    return out;
  };
  const entries = data.entries.map((e, i) => {
    const p = `entries[${i}]`;
    if (!e || typeof e !== "object") fail(p, "is not an object");
    if (typeof e.login !== "string" || !e.login) fail(`${p}.login`, "is not a string");
    if (!isNum(e.points)) fail(`${p}.points`, "is not a number");
    if (!Number.isInteger(e.rank) || e.rank < 1) fail(`${p}.rank`, "is not a positive integer");
    if (!(e.team === null || e.team === undefined || typeof e.team === "string")) fail(`${p}.team`, "is not a slug or null");
    if (!(e.hintPenalty === undefined || isNum(e.hintPenalty))) fail(`${p}.hintPenalty`, "is not a number");
    return { login: e.login, rank: e.rank, points: e.points, team: e.team ?? null, hintPenalty: e.hintPenalty ?? 0, modules: mods(e.modules, `${p}.modules`) };
  });
  const teams = data.teams.map((t, i) => {
    const p = `teams[${i}]`;
    if (!t || typeof t !== "object") fail(p, "is not an object");
    if (typeof t.slug !== "string" || !t.slug) fail(`${p}.slug`, "is not a string");
    if (!isNum(t.points)) fail(`${p}.points`, "is not a number");
    if (!Number.isInteger(t.rank) || t.rank < 1) fail(`${p}.rank`, "is not a positive integer");
    if (!Array.isArray(t.members) || !t.members.every((m) => typeof m === "string")) fail(`${p}.members`, "is not a list of logins");
    if (!(t.hintPenalty === undefined || isNum(t.hintPenalty))) fail(`${p}.hintPenalty`, "is not a number");
    return { slug: t.slug, name: t.name, rank: t.rank, points: t.points, members: [...t.members].sort(), hintPenalty: t.hintPenalty ?? 0, modules: mods(t.modules, `${p}.modules`) };
  });
  return { generatedAt: data.generatedAt, capabilities: data.capabilities, entries, teams };
}

// ---------------------------------------------------------------------------
// Pure: the diff
// ---------------------------------------------------------------------------

/** Every disagreement between the recompute and the served board, plus what was compared. */
export function diffBoard(expected, served) {
  const mismatches = [];
  const compared = { contestants: 0, teams: 0, values: 0 };
  const add = (who, field, exp, got, module) => mismatches.push({ who, ...(module ? { module } : {}), field, expected: exp, served: got });
  const cmp = (who, field, exp, got, module) => {
    compared.values += 1;
    if (exp !== got) add(who, field, exp, got, module);
  };
  const cmpModules = (who, exp, got) => {
    for (const m of new Set([...Object.keys(exp), ...Object.keys(got)])) {
      if (!exp[m]) { add(who, "module block", "absent", got[m], m); continue; }
      if (!got[m]) { add(who, "module block", exp[m], "absent", m); continue; }
      cmp(who, "points", exp[m].points, got[m].points, m);
      cmp(who, "completed", exp[m].completed, got[m].completed, m);
    }
  };
  const inRange = (who, range, rank) => {
    compared.values += 1;
    if (rank < range[0] || rank > range[1]) add(who, "rank", range[0] === range[1] ? range[0] : `${range[0]}-${range[1]} (tie group)`, rank);
  };
  const ranksArePermutation = (label, ranks) => {
    const sorted = [...ranks].sort((a, b) => a - b);
    if (!sorted.every((r, i) => r === i + 1)) add(label, "rank sequence", `1..${ranks.length}`, sorted.join(","));
  };

  // contestants
  const servedEntries = new Map();
  for (const e of served.entries) {
    const k = lc(e.login);
    if (servedEntries.has(k)) add(`contestant ${e.login}`, "row", "one row", "duplicate row");
    servedEntries.set(k, e);
  }
  for (const [k, exp] of expected.entries) {
    const got = servedEntries.get(k);
    const who = `contestant ${exp.login}`;
    if (!got) { add(who, "row", `${exp.points} pts`, "missing from the board"); continue; }
    compared.contestants += 1;
    cmp(who, "points (net)", exp.points, got.points);
    cmp(who, "hint penalty", exp.penalty, got.hintPenalty);
    cmp(who, "team", exp.team, got.team);
    cmpModules(who, exp.modules, got.modules);
    inRange(who, exp.rankRange, got.rank);
  }
  for (const [k, got] of servedEntries) if (!expected.entries.has(k)) add(`contestant ${got.login}`, "row", "no row (no counted solve in a live module)", `${got.points} pts`);
  ranksArePermutation("contestants", served.entries.map((e) => e.rank));

  // teams
  const servedTeams = new Map();
  for (const t of served.teams) {
    if (servedTeams.has(t.slug)) add(`team ${t.slug}`, "row", "one row", "duplicate row");
    servedTeams.set(t.slug, t);
  }
  for (const [slug, exp] of expected.teams) {
    const got = servedTeams.get(slug);
    const who = `team ${slug}`;
    if (!got) { add(who, "row", `${exp.points} pts`, "missing from the board"); continue; }
    compared.teams += 1;
    cmp(who, "points (net)", exp.points, got.points);
    cmp(who, "hint penalty", exp.penalty, got.hintPenalty);
    cmp(who, "members", exp.members.map(lc).join(","), got.members.map(lc).join(","));
    cmpModules(who, exp.modules, got.modules);
    inRange(who, exp.rankRange, got.rank);
  }
  for (const [slug, got] of servedTeams) if (!expected.teams.has(slug)) add(`team ${slug}`, "row", "no such team in the store", `${got.points} pts`);
  ranksArePermutation("teams", served.teams.map((t) => t.rank));

  return { mismatches, compared };
}

/** True when the store holds anything the board should show. */
export function storeHasData(expected) {
  return expected.entries.size > 0 || expected.teams.size > 0;
}

/** A stable digest of a snapshot, so two reads can be compared for "nothing moved". */
export function fingerprint(snapshot) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canon(snapshot))).digest("hex");
}

/** The whole audit over a snapshot and a served payload: pure, so the tests drive it end to end. */
export function audit(snapshot, flightText) {
  const expected = recompute(snapshot);
  const served = extractBoard(flightText);
  const { mismatches, compared } = diffBoard(expected, served);
  const vacuous = storeHasData(expected) ? compared.contestants + compared.teams === 0 : true;
  return {
    live: expected.live,
    hintsEnabled: expected.hints,
    counts: {
      expectedContestants: expected.entries.size,
      servedContestants: served.entries.length,
      expectedTeams: expected.teams.size,
      servedTeams: served.teams.length,
      comparedContestants: compared.contestants,
      comparedTeams: compared.teams,
      comparedValues: compared.values,
      ...expected.stats,
    },
    vacuous,
    storeEmpty: !storeHasData(expected),
    mismatches,
    invariants: expected.invariants,
    servedGeneratedAt: served.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// I/O (inside the app container)
// ---------------------------------------------------------------------------

async function boundedFetch(url, init = {}, ms = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    if (ac.signal.aborted) throw new Error(`request timed out after ${ms} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Only https, or http to a private host — the token rides in the Authorization header (same rule as load-seed.mjs). */
export function assertRedisUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("UPSTASH_REDIS_REST_URL is not a URL"); }
  if (u.protocol === "https:") return u;
  if (u.protocol !== "http:") throw new Error(`UPSTASH_REDIS_REST_URL must be https:// or a private http:// endpoint, got ${u.protocol}`);
  const h = u.hostname.toLowerCase();
  const v6 = h.startsWith("[") ? h.slice(1, -1) : null;
  const ok = v6 !== null
    ? v6 === "::1" || /^fe[89ab][0-9a-f]?:/.test(v6) || /^f[cd][0-9a-f]{2}:/.test(v6)
    : ["srh", "localhost", "127.0.0.1"].includes(h) || h.endsWith(".internal");
  if (!ok) throw new Error("UPSTASH_REDIS_REST_URL is plain http:// to a public host — refusing to send the token in cleartext");
  return u;
}

async function pipeline(commands) {
  assertReadOnly(commands);
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("UPSTASH_REDIS_REST_URL/TOKEN are not set — run this inside the app container");
  const base = assertRedisUrl(url);
  const res = await boundedFetch(`${base.href.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`pipeline HTTP ${res.status}`);
  const replies = await res.json();
  if (!Array.isArray(replies) || replies.length !== commands.length) throw new Error("pipeline answered with the wrong number of replies");
  // Unlike the app's client, a per-command error THROWS: an unreadable key must never read as an empty one.
  const bad = replies.find((r) => !r || r.error);
  if (bad) throw new Error(`pipeline command error: ${String(bad && bad.error).replace(/,?\s*with args beginning with:[\s\S]*$/i, "").slice(0, 120)}`);
  return replies.map((r) => r.result);
}

async function batched(commands) {
  const out = [];
  for (let i = 0; i < commands.length; i += BATCH) out.push(...(await pipeline(commands.slice(i, i + BATCH))));
  return out;
}

const flat = (arr) => {
  if (arr !== null && arr !== undefined && !Array.isArray(arr)) throw new Error("HGETALL answered with a non-list");
  const o = {};
  for (let i = 0; i + 1 < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
};

async function scanAll(match) {
  const keys = [];
  let cursor = "0";
  do {
    const [page] = await pipeline([["SCAN", cursor, "MATCH", match, "COUNT", "1000"]]);
    if (!Array.isArray(page) || page.length !== 2 || !Array.isArray(page[1])) throw new Error(`SCAN ${match} answered with an unexpected page`);
    cursor = String(page[0]);
    keys.push(...page[1]);
  } while (cursor !== "0");
  return [...new Set(keys)];
}

/** One consistent-as-possible read of every key the board is folded from. */
export async function readSnapshot() {
  const [settingsRaw] = await pipeline([["HGETALL", "ctf:admin:settings"]]);
  const settings = flat(settingsRaw);
  const scoreImage = typeof process.env.SCORE_IMAGE === "string" && process.env.SCORE_IMAGE.trim() !== "";
  const live = liveModules(settings, scoreImage);

  let sdCatalogue = null;
  const sdSolves = {};
  const orphanTargets = [];
  if (live.has("secure-development")) {
    const scorer = process.env.LEADERBOARD_API_URL;
    if (!scorer) throw new Error("Secure Development is live but LEADERBOARD_API_URL is not set — cannot read the rubric catalogue");
    const res = await boundedFetch(`${scorer.replace(/\/$/, "")}/challenges`);
    if (!res.ok) throw new Error(`scorer /challenges HTTP ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.challenges)) throw new Error("scorer /challenges answered without a challenges list");
    sdCatalogue = body.challenges.map((c) => {
      if (!c || typeof c.app !== "string" || typeof c.id !== "string" || typeof c.points !== "number") throw new Error("scorer /challenges carries an entry without app/id/points");
      return { app: c.app, id: c.id, points: c.points };
    });
    const targets = [...new Set(sdCatalogue.map((c) => c.app))].sort();
    const replies = await batched(targets.map((t) => ["HGETALL", `ctf:solves:${t}`]));
    targets.forEach((t, i) => { sdSolves[t] = flat(replies[i]); });
    for (const k of await scanAll("ctf:solves:*")) {
      const t = k.slice("ctf:solves:".length);
      if (!targets.includes(t)) orphanTargets.push(t);
    }
  }

  const aggKeys = APP_MODULES.flatMap((m) => [MODULE_KEYS[m].points, MODULE_KEYS[m].count]);
  const aggReplies = await pipeline([...aggKeys.map((k) => ["HGETALL", k]), ["HGETALL", "ctf:hints:spent"]]);
  const agg = {};
  APP_MODULES.forEach((m, i) => { agg[m] = { points: flat(aggReplies[i * 2]), count: flat(aggReplies[i * 2 + 1]) }; });
  const hintsSpent = flat(aggReplies[aggKeys.length]);

  const slugs = (await scanAll("ctf:team:*:members")).map((k) => k.slice("ctf:team:".length, -":members".length)).sort();
  const teamReplies = await batched(slugs.flatMap((s) => [["HGET", `ctf:team:${s}`, "name"], ["SMEMBERS", `ctf:team:${s}:members`]]));
  const teams = slugs.map((slug, i) => {
    const members = teamReplies[i * 2 + 1];
    if (!Array.isArray(members)) throw new Error(`SMEMBERS ctf:team:${slug}:members answered with a non-list`);
    return { slug, name: teamReplies[i * 2] || slug, members: [...members].sort() };
  });

  // Per-login rows: for every team member (the team union) and every login an aggregate names (the invariant).
  const logins = new Set();
  for (const t of teams) for (const m of t.members) logins.add(m);
  for (const m of APP_MODULES) for (const l of [...Object.keys(agg[m].points), ...Object.keys(agg[m].count)]) logins.add(l);
  const loginList = [...logins].sort();
  const rowCmds = loginList.flatMap((l) => [...APP_MODULES.map((m) => ["HGETALL", `${MODULE_KEYS[m].rows}${l}`]), ["HGET", `ctf:user:${l}`, "team"]]);
  const rowReplies = await batched(rowCmds);
  const rows = { quiz: {}, classic: {}, ai: {} };
  const users = {};
  const per = APP_MODULES.length + 1;
  loginList.forEach((l, i) => {
    APP_MODULES.forEach((m, j) => { rows[m][l] = flat(rowReplies[i * per + j]); });
    users[l] = rowReplies[i * per + APP_MODULES.length] ?? null;
  });

  return { settings, scoreImage, sdCatalogue, sdSolves, agg, rows, hintsSpent, teams, users, orphanTargets: orphanTargets.sort() };
}

/**
 * The served flight payload. Next 16 answers an `RSC: 1` request on a bare
 * path with a redirect to the same path plus its `_rsc` cache-buster; that
 * one hop (same pathname) is followed, anything else — the pre-launch lock's
 * redirect to `/` in particular — is a failure.
 */
export async function fetchFlight(baseUrl) {
  let url = new URL("/leaderboard", baseUrl);
  for (let hop = 0; hop < 3; hop += 1) {
    const res = await boundedFetch(url, { headers: { RSC: "1" }, redirect: "manual", cache: "no-store" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      const next = loc ? new URL(loc, url) : null;
      if (!next || next.pathname !== "/leaderboard" || next.origin !== url.origin) {
        throw new Error(`/leaderboard redirected to ${next ? next.pathname : "(no location)"} — the board is not being served (pre-launch lock?)`);
      }
      url = next;
      continue;
    }
    if (res.status !== 200) throw new Error(`/leaderboard answered HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/x-component")) throw new Error(`/leaderboard answered ${type || "no content-type"}, not a flight stream`);
    return res.text();
  }
  throw new Error("/leaderboard kept redirecting");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Past the scorer fetch's `revalidate: 30` (lambda.ts:242-244), with margin. */
export const SD_CACHE_WAIT_MS = 32_000;
/** Past the 10 s fold memo (folded.ts:44), with margin. */
export const MEMO_WAIT_MS = 12_000;

/**
 * One attempt, in the order that makes the compared board a function of the
 * store as S1 read it:
 *   1. read the store (S1);
 *   2. if Secure Development is live, wait past the scorer fetch cache, so any
 *      copy cached BEFORE S1 is stale by the next step (a copy younger than
 *      30 s would otherwise be served as fresh and never refreshed);
 *   3. priming fetch: serves that stale copy once and refreshes it behind it;
 *   4. wait past the fold memo, so the priming fold is not the one compared;
 *   5. compared fetch: a new fold over a scorer copy fetched after S1;
 *   6. read the store again (S2) — the attempt is stable only if S1 = S2.
 * The seams (`readSnapshot`, `fetchFlight`, `sleep`) are parameters so the
 * tests can check the order without real waits.
 */
export async function auditAttempt({ readSnapshot: read, fetchFlight: fetchBoard, sleep: wait = sleep, sdCacheMs = SD_CACHE_WAIT_MS, memoMs = MEMO_WAIT_MS }) {
  const s1 = await read();
  if (liveModules(s1.settings, s1.scoreImage).has("secure-development") && sdCacheMs > 0) await wait(sdCacheMs);
  await fetchBoard();
  await wait(memoMs);
  const flight = await fetchBoard();
  const s2 = await read();
  return { snapshot: s1, flight, stable: fingerprint(s1) === fingerprint(s2) };
}

/** The loggable part of an error: its message, any token or URL redacted. */
export function errorLabel(err) {
  if (!(err instanceof Error)) return "failed (non-Error throw)";
  return String(err.message || "").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url redacted]").slice(0, 300);
}

/** Human summary lines for a report. */
export function summarize(report) {
  const c = report.counts || {};
  const out = [];
  out.push(`score-audit: live modules [${(report.live || []).join(", ")}], hints ${report.hintsEnabled ? "on" : "off"}`);
  out.push(`  compared ${c.comparedContestants ?? 0}/${c.expectedContestants ?? 0} contestants (board shows ${c.servedContestants ?? 0}), ${c.comparedTeams ?? 0}/${c.expectedTeams ?? 0} teams (board shows ${c.servedTeams ?? 0}), ${c.comparedValues ?? 0} values`);
  out.push(`  from ${c.sdSolvesCounted ?? 0} Secure Development solves (${c.sdSolvesIgnored ?? 0} ignored: not in the rubric), ${c.quizAnswers ?? 0} quiz answers, ${c.classicSolves ?? 0} flag solves, ${c.aiSolves ?? 0} ai solves, ${c.hintLogins ?? 0} logins with hint spend`);
  if (report.orphanTargets && report.orphanTargets.length) out.push(`  note: solve hashes for targets outside the rubric (ignored by the scorer): ${report.orphanTargets.join(", ")}`);
  out.push(`  board mismatches: ${(report.mismatches || []).length}; store invariant findings: ${(report.invariants || []).length}`);
  for (const m of (report.mismatches || []).slice(0, 200)) out.push(`  MISMATCH ${m.who}${m.module ? ` [${m.module}]` : ""} ${m.field}: expected ${JSON.stringify(m.expected)}, served ${JSON.stringify(m.served)}`);
  if ((report.mismatches || []).length > 200) out.push(`  … ${(report.mismatches || []).length - 200} more in the JSON report`);
  for (const f of (report.invariants || []).slice(0, 100)) out.push(`  INVARIANT ${f.kind}${f.module ? ` [${f.module}]` : ""} ${f.login}: ${f.detail}`);
  if (report.error) out.push(`  AUDIT FAILED: ${report.error}`);
  return out.join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string", default: `http://127.0.0.1:${process.env.PORT || "3000"}` },
      report: { type: "string" },
      "settle-ms": { type: "string", default: String(MEMO_WAIT_MS) },
      "sd-cache-ms": { type: "string", default: String(SD_CACHE_WAIT_MS) },
      attempts: { type: "string", default: "3" },
    },
  });
  const settle = Number(values["settle-ms"]);
  const sdCache = Number(values["sd-cache-ms"]);
  if (!Number.isInteger(sdCache) || sdCache < 0 || sdCache > 120000) { console.error("--sd-cache-ms must be 0..120000"); process.exit(2); }
  const attempts = Number(values.attempts);
  if (!Number.isInteger(settle) || settle < 0 || settle > 120000) { console.error("--settle-ms must be 0..120000"); process.exit(2); }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) { console.error("--attempts must be 1..10"); process.exit(2); }

  let report = { mode: "score-audit", startedAt: new Date().toISOString() };
  let code = 3;
  try {
    let result = null;
    for (let a = 1; a <= attempts && !result; a += 1) {
      const { snapshot: s1, flight, stable } = await auditAttempt({ readSnapshot, fetchFlight: () => fetchFlight(values.url), sdCacheMs: sdCache, memoMs: settle });
      if (!stable) {
        report.unstableAttempts = a;
        continue;
      }
      result = { ...audit(s1, flight), orphanTargets: s1.orphanTargets, fingerprint: fingerprint(s1), attempt: a };
    }
    if (!result) throw new Error(`the store changed during every one of ${attempts} attempt(s) — run the audit on a quiet box`);
    report = { ...report, ...result };
    if (result.vacuous) {
      report.error = result.storeEmpty ? "vacuous: the store holds no scores and no teams — nothing was compared" : "vacuous: the store has data but no contestant or team was compared";
      code = 3;
    } else {
      code = result.mismatches.length === 0 && result.invariants.length === 0 ? 0 : 1;
    }
  } catch (err) {
    report.error = errorLabel(err);
    code = 3;
  }
  report.ok = code === 0;
  report.finishedAt = new Date().toISOString();
  if (values.report) writeFileSync(values.report, JSON.stringify(report, null, 2));
  console.log(summarize(report));
  console.log(JSON.stringify({ mode: "score-audit", ok: report.ok, exit: code, mismatches: (report.mismatches || []).length, invariants: (report.invariants || []).length, comparedContestants: report.counts?.comparedContestants ?? 0, comparedTeams: report.counts?.comparedTeams ?? 0, error: report.error ?? null }));
  process.exit(code);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { console.error(errorLabel(err)); process.exit(3); });
}
