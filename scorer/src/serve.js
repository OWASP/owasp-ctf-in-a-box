import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { loadRubric } from "./rubric.js";
import { createMemoryStore, createRedisStore } from "./store.js";

// Mirrors sync/src/parse.js — same grammar, because the author becomes a
// Redis field segment (`<author>:<challengeId>`) in the solves hash.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;
// Targets and challenge ids share the rubric charset (Redis key/field segments).
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

// A legitimate score payload is well under 1 KiB; 64 KiB is generous headroom.
// Callers are bearer-authed only, so this is defense-in-depth — a leaked token
// or a misbehaving CI job must not be able to buffer unbounded bytes in memory.
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Constant-time bearer check (issue #48).
 *
 * The token is score-authoritative, and `!==` on a string returns as soon as
 * two bytes differ, so how long the comparison takes is a function of how much
 * of the token the caller already guessed.
 *
 * Both sides are SHA-256'd before the compare, rather than length-guarding and
 * comparing the raw values. Two reasons, and the second is the one that
 * matters: `timingSafeEqual` THROWS on a length mismatch, so it needs a guard
 * either way — and a length guard is itself an early return that leaks the
 * token's length. Digesting makes every comparison 32 bytes against 32 bytes,
 * so a caller learns nothing from the clock regardless of what they send.
 *
 * A missing header compares as the empty string rather than short-circuiting,
 * for the same reason.
 */
function bearerMatches(header, token) {
  const digest = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createHandler({ rubric = null, store, token, now = () => new Date().toISOString() }) {
  if (!token) throw new Error("refusing to start: set CTF_SCORE_BEARER_TOKEN or SCORER_TOKEN");
  // Without a rubric the board can only cover targets this process has seen
  // solves for — degenerate, but honest.
  const seenTargets = new Set();
  const targetsInPlay = () => (rubric ? [...rubric.targets.keys()] : [...seenTargets].sort());

  async function score(req, res) {
    if (!bearerMatches(req.headers.authorization, token)) return json(res, 401, { error: "unauthorized" });
    // Organizer freeze, the scorer's half: sync (the only caller since push
    // ingest was removed, ADR 56) also holds its cursor while paused, and this
    // refuses anything that reaches /score anyway. Fails open on a store
    // error, so a Redis blip never drops a live submission — see store.js's
    // isPaused for both implementations.
    if (await store.isPaused()) return json(res, 503, { error: "scoring is paused" });
    let body = "";
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        // 413 first, then kill the socket once the response is flushed so the
        // client stops streaming a body we will never read.
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }), () => req.destroy());
        return;
      }
      body += chunk;
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return json(res, 400, { error: "body must be JSON" });
    }
    const { author, target, solved } = data ?? {};
    if (typeof author !== "string" || !GITHUB_LOGIN.test(author)) return json(res, 400, { error: "invalid author" });
    if (typeof target !== "string" || !SEGMENT.test(target)) return json(res, 400, { error: "invalid target" });
    if (rubric && !rubric.targets.has(target)) return json(res, 400, { error: `unknown target: ${target}` });
    if (!Array.isArray(solved) || solved.some((s) => typeof s !== "string")) {
      return json(res, 400, { error: "solved must be an array of strings" });
    }
    // Unknown ids are dropped, not fatal — a stale CI rubric must not lose the
    // rest of the batch. Without a rubric only the charset gate applies.
    const ids = [...new Set(solved)].filter((id) =>
      rubric ? rubric.pointsFor(target, id) !== undefined : SEGMENT.test(id),
    );
    await store.recordSolves(target, author, ids, now());
    if (!rubric) seenTargets.add(target);
    res.writeHead(202).end();
  }

  return async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/score") return await score(req, res);
      if (req.method === "GET" && req.url.split("?")[0] === "/leaderboard") {
        const board = await buildLeaderboard({ store, rubric, targets: targetsInPlay() });
        return json(res, 200, {
          leaderboard: board.entries,
          series: board.series,
          teams: board.teams,
          teamSeries: board.teamSeries,
          catalog: board.catalog,
        });
      }
      // The live challenge catalogue the app's /challenges page prefers over
      // its static per-app cards.
      //
      // This route did not exist for a long time while the app asked for it
      // on every render: `getChallengeCatalog()` fetched it, got a 404, logged
      // an error and fell back to the static counts. The fallback is correct,
      // so nothing looked broken — but the error fired on every request, which
      // is exactly the noise that hides a real one during an event.
      //
      // `owasp` goes out as the bare CODE, not a code/label/link object. The
      // rubric knows the code; how to name and link a category is the app's
      // business (apps/web/src/lib/owasp.ts). Sending presentation strings
      // from here would put OWASP's taxonomy in two repos.
      //
      // Degenerate mode (serve with no rubric) has no per-challenge metadata
      // at all, so this reports an empty catalogue rather than 404ing: "this
      // deployment has no catalogue" is a different answer from "this route
      // does not exist", and the app's `challenges.length === 0` guard already
      // treats the former as "stay on the static cards".
      if (req.method === "GET" && req.url.split("?")[0] === "/challenges") {
        const challenges = rubric
          ? targetsInPlay().flatMap((target) =>
              (rubric.targets.get(target)?.challenges ?? []).map((c) => ({
                app: target,
                id: c.id,
                name: c.name,
                points: c.points,
                owasp: c.owasp ?? null,
              })),
            )
          : [];
        const counts = {};
        for (const c of challenges) counts[c.app] = (counts[c.app] ?? 0) + 1;
        return json(res, 200, { challenges, counts, total: challenges.length });
      }
      if (req.method === "GET" && req.url === "/healthz") return json(res, 200, { ok: true });
      res.writeHead(404).end();
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: err.message });
    }
  };
}

// Earlier solve wins ties; an author with no counted solves sorts last.
function compareLastSolve(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

// Same-timestamp solves need a deterministic secondary order so the series is
// reproducible: challenge id first, then target (a solve's id is only unique
// within its target).
function compareSolve(a, b) {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.target !== b.target) return a.target < b.target ? -1 : 1;
  return 0;
}

// Top-N players charted in the score-over-time series (CTFd-style "top
// players" line chart) — same cap the app's chart renders.
const SERIES_TOP_N = 10;

// Aggregates the solves hashes into the exact GET /leaderboard shape the app's
// lambda source parses (apps/web/src/lib/leaderboard/lambda.ts):
// { leaderboard: [{ rank, author, points, lastSolveAt, apps: { <target>:
//   { solved, total, solvedIds } } }], catalog: { <target>: [{ id, name,
//   points, owasp }] } }. `solvedIds` (per entry and per team) and the
//   top-level `catalog` let the app show WHICH flags are solved, not just
//   counts — ids join to catalog entries. `catalog` is `{}` without a rubric
//   (degenerate mode has no per-challenge metadata).
//   With a rubric, points and totals come from it and
// foreign ids (not in the rubric) are skipped so solved never exceeds total;
// without one, every solve is 1 point and a target's total is the count of
// distinct solved ids seen for it across all authors.
//
// Also returns `series`: the cumulative-score-over-time history for the top
// SERIES_TOP_N players by final score (same ranking as `entries`), for the
// app's leaderboard line chart. Points require a rubric — without one there is
// no per-challenge score to accumulate, so `series` is empty.
export async function buildLeaderboard({ store, rubric, targets }) {
  const authors = new Map(); // author -> { points, lastSolveAt, perTarget: Map, solves: [] }
  const totals = new Map(); // target -> total challenge count
  for (const target of targets) {
    const solves = await store.getSolves(target);
    const known = rubric?.targets.get(target);
    const distinct = new Set();
    for (const [field, at] of Object.entries(solves)) {
      const i = field.indexOf(":");
      if (i < 1) continue;
      const author = field.slice(0, i);
      const id = field.slice(i + 1);
      const points = known ? known.points.get(id) : 1;
      if (points === undefined) continue;
      distinct.add(id);
      let a = authors.get(author);
      if (!a) authors.set(author, (a = { points: 0, lastSolveAt: null, perTarget: new Map(), solves: [] }));
      a.points += points;
      if (a.lastSolveAt === null || at > a.lastSolveAt) a.lastSolveAt = at;
      a.perTarget.set(target, (a.perTarget.get(target) ?? 0) + 1);
      a.solves.push({ at, id, target, points });
    }
    totals.set(target, known ? known.challenges.length : distinct.size);
  }

  const entries = [...authors.entries()].map(([author, a]) => ({
    author,
    points: a.points,
    lastSolveAt: a.lastSolveAt,
    apps: Object.fromEntries(
      targets.map((t) => [
        t,
        {
          solved: a.perTarget.get(t) ?? 0,
          total: totals.get(t),
          solvedIds: a.solves.filter((s) => s.target === t).map((s) => s.id),
        },
      ]),
    ),
  }));
  entries.sort(
    (x, y) =>
      y.points - x.points ||
      compareLastSolve(x.lastSolveAt, y.lastSolveAt) ||
      (x.author < y.author ? -1 : x.author > y.author ? 1 : 0),
  );
  const ranked = entries.map((e, i) => ({ rank: i + 1, ...e }));

  const series = rubric
    ? ranked.slice(0, SERIES_TOP_N).map(({ author }) => {
        const sorted = [...authors.get(author).solves].sort(compareSolve);
        let cumulative = 0;
        return {
          login: author,
          points: sorted.map((s) => ({ t: s.at, score: (cumulative += s.points) })),
        };
      })
    : [];

  // Team rollup (additive — the individual `entries`/`series` above are
  // untouched). A team scores the UNION of its members' solves: a flag solved
  // by two members counts once, at the earliest `at` seen for it. Membership is
  // read fresh from the store, so a solve recorded before a login joined a team
  // still rolls in retroactively. Foreign ids were already dropped upstream (an
  // author only carries solves the rubric — or degenerate charset — accepted).
  const teamsData = await store.getTeams();
  const teamEntries = teamsData.map((team) => {
    const union = new Map(); // `${target}:${id}` -> { at (min), id, target, points }
    for (const login of team.members) {
      const a = authors.get(login);
      if (!a) continue;
      for (const s of a.solves) {
        const key = `${s.target}:${s.id}`;
        const seen = union.get(key);
        if (!seen) union.set(key, { ...s });
        else if (s.at < seen.at) seen.at = s.at;
      }
    }
    let points = 0;
    let lastSolveAt = null;
    const perTarget = new Map();
    for (const it of union.values()) {
      points += it.points;
      if (lastSolveAt === null || it.at > lastSolveAt) lastSolveAt = it.at;
      perTarget.set(it.target, (perTarget.get(it.target) ?? 0) + 1);
    }
    return {
      slug: team.slug,
      name: team.name,
      captain: team.captain,
      members: team.members,
      points,
      lastSolveAt,
      apps: Object.fromEntries(
        targets.map((t) => [
          t,
          {
            solved: perTarget.get(t) ?? 0,
            total: totals.get(t),
            solvedIds: [...union.values()].filter((u) => u.target === t).map((u) => u.id),
          },
        ]),
      ),
      _union: [...union.values()],
    };
  });
  teamEntries.sort(
    (x, y) =>
      y.points - x.points ||
      compareLastSolve(x.lastSolveAt, y.lastSolveAt) ||
      (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
  );
  const rankedTeams = teamEntries.map((e, i) => ({ rank: i + 1, ...e }));

  const teamSeries = rubric
    ? rankedTeams.slice(0, SERIES_TOP_N).map((tm) => {
        const sorted = [...tm._union].sort(compareSolve);
        let cumulative = 0;
        return {
          slug: tm.slug,
          name: tm.name,
          points: sorted.map((s) => ({ t: s.at, score: (cumulative += s.points) })),
        };
      })
    : [];

  const teams = rankedTeams.map(({ _union, ...rest }) => rest);

  // Per-target challenge catalogue (name/points/OWASP per id) — lets the app
  // render which flags are solved, not just counts. Present only with a rubric
  // (degenerate mode has no per-challenge metadata); ids join to the
  // `solvedIds` carried on each entry/team's `apps.<target>`.
  const catalog = rubric
    ? Object.fromEntries(
        targets
          .filter((t) => rubric.targets.get(t))
          .map((t) => [
            t,
            rubric.targets.get(t).challenges.map((c) => ({
              id: c.id,
              name: c.name,
              points: c.points,
              owasp: c.owasp ?? null,
            })),
          ]),
      )
    : {};

  return { entries: ranked, series, teams, teamSeries, catalog };
}

export function startServer({ port = 0, ...opts }) {
  const server = createServer(createHandler(opts));
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

/** The port `serve()` listens on: PORT if set, else 4000.
 *
 *  Checked lexically, not by `Number()`: `Number("abc")` is NaN and
 *  `Number(" ")` is 0, and `listen()` turns either into an ephemeral port —
 *  the API would come up somewhere compose's port mapping does not point,
 *  with a "serving on :54321" line as the only clue. Refuse instead. */
function parsePort(raw) {
  if (raw === undefined || raw === "") return 4000;
  const text = typeof raw === "string" ? raw.trim() : "";
  const n = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535 (got ${JSON.stringify(raw)})`);
  }
  return n;
}

/** Process entry for `score serve`: validates env, loads the rubric, picks
 *  the store (Redis via SRH when UPSTASH_REDIS_REST_URL is set, memory
 *  otherwise) and listens. `log` is injectable so tests can boot it quietly. */
export async function serve(env = process.env, { log = console.error } = {}) {
  const token = env.CTF_SCORE_BEARER_TOKEN ?? env.SCORER_TOKEN;
  if (!token) throw new Error("refusing to start: set CTF_SCORE_BEARER_TOKEN or SCORER_TOKEN");
  const port = parsePort(env.PORT);
  const rubric = loadRubric(env.RUBRIC_DIR);
  const useRedis = Boolean(env.UPSTASH_REDIS_REST_URL);
  const store = useRedis ? createRedisStore({ log }) : createMemoryStore();
  const server = await startServer({ rubric, store, token, port });
  log(
    `ctf-score-engine: serving on :${server.address().port} ` +
      `(${rubric ? `${rubric.targets.size} rubric target(s)` : "no rubric — degenerate mode"}, ` +
      `${useRedis ? "redis" : "memory"} store)`,
  );
  return server;
}
