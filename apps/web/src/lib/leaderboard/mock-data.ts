// Fixture data shaped exactly like the proposed Upstash v2 / scorer API
// contract (see the scorer repo's PR for the write side).
// This is the schema preview for the backend review — once the scorer ships
// pushLeaderboardV2 and the read API, `LEADERBOARD_SOURCE=upstash` (v2) can
// point at the real thing with no UI changes.

import type { AppId } from "@/lib/apps";
import { rankByStanding } from "./rank";
import type { ChallengeCatalog, ChallengeResult, LeaderboardEntry, TeamStanding } from "./types";

type Sample = {
  login: string;
  team: string | null;
  updatedAt: string;
  apps: Partial<Record<AppId, ChallengeResult[]>>;
};

// A handful of real catalogue keys per app (not the full 326) — enough to
// exercise every UI state (patched / open / missing, all six apps, mixed
// difficulty and OWASP codes).
const juiceShop = (statuses: ChallengeResult["status"][]): ChallengeResult[] => [
  { key: "redirectCryptoCurrencyChallenge", name: "Outdated Allowlist", points: 1, owasp: "A01", status: statuses[0] },
  { key: "loginAdminChallenge", name: "Login Admin", points: 2, owasp: "A05", status: statuses[1] },
  { key: "reflectedXssChallenge", name: "Reflected XSS", points: 2, owasp: "A05", status: statuses[2] },
  { key: "dbSchemaChallenge", name: "Database Schema", points: 3, owasp: "A05", status: statuses[3] ?? "missing" },
];

const dvwa = (statuses: ChallengeResult["status"][]): ChallengeResult[] => [
  { key: "brute-low", name: "Brute Force (Low)", points: 1, owasp: "A07", status: statuses[0] },
  { key: "exec-low", name: "Command Injection (Low)", points: 1, owasp: "A03", status: statuses[1] },
  { key: "csrf-low", name: "CSRF (Low)", points: 1, owasp: "A01", status: statuses[2] ?? "missing" },
];

const webgoat = (statuses: ChallengeResult["status"][]): ChallengeResult[] => [
  { key: "auth-bypass-verify-account", name: "Auth Bypass: Verify Account", points: 2, owasp: "A07", status: statuses[0] },
  { key: "csrf-confirm-flag-1", name: "CSRF: Basic GET Flag", points: 1, owasp: "A01", status: statuses[1] ?? "missing" },
];

const securityShepherd = (statuses: ChallengeResult["status"][]): ChallengeResult[] => [
  { key: "Challenge-4-CSRF-1", name: "CSRF 1", points: 1, owasp: "A01", status: statuses[0] },
  { key: "Challenge-1-BrokenCrypto-3", name: "Insecure Cryptographic Storage 3", points: 2, owasp: "A04", status: statuses[1] ?? "missing" },
];

const vulnerableApp = (statuses: ChallengeResult["status"][]): ChallengeResult[] => [
  { key: "Challenge-1-Authentication-Level-1", name: "AuthenticationVulnerability (LEVEL_1)", points: 1, owasp: "A07", status: statuses[0] },
  { key: "Challenge-8-Authentication-Level-8", name: "AuthenticationVulnerability (LEVEL_8)", points: 3, owasp: "A07", status: statuses[1] ?? "missing" },
];

const vampi = (statuses: ChallengeResult["status"][]): ChallengeResult[] => [
  { key: "Challenge-3-SQLi", name: "SQL Injection in Username Lookup", points: 2, owasp: "API1", status: statuses[0] },
  { key: "Challenge-4-MassAssignment", name: "Mass Assignment Privilege Escalation", points: 1, owasp: "API6", status: statuses[1] ?? "missing" },
];

const SAMPLES: Sample[] = [
  {
    login: "octocat",
    team: "seg-fault",
    updatedAt: "2026-08-07T18:03:11Z",
    apps: {
      "juice-shop": juiceShop(["patched", "patched", "patched", "open"]),
      dvwa: dvwa(["patched", "patched", "open"]),
      webgoat: webgoat(["patched", "open"]),
      vampi: vampi(["patched", "patched"]),
    },
  },
  {
    login: "mona",
    team: "seg-fault",
    updatedAt: "2026-08-07T17:41:02Z",
    apps: {
      "juice-shop": juiceShop(["patched", "patched", "open", "missing"]),
      dvwa: dvwa(["patched", "open", "missing"]),
      webgoat: webgoat(["patched", "missing"]),
      vulnerableapp: vulnerableApp(["patched", "open"]),
    },
  },
  {
    login: "hubot",
    team: "null-terminators",
    updatedAt: "2026-08-07T16:58:40Z",
    apps: {
      dvwa: dvwa(["patched", "open", "open"]),
      webgoat: webgoat(["open", "missing"]),
      vampi: vampi(["patched", "open"]),
    },
  },
  {
    login: "defunkt",
    team: "null-terminators",
    updatedAt: "2026-08-07T15:12:09Z",
    apps: {
      dvwa: dvwa(["patched", "open", "missing"]),
      securityshepherd: securityShepherd(["patched", "missing"]),
    },
  },
  {
    login: "torvalds",
    team: "0xcafebabe",
    updatedAt: "2026-08-07T14:30:55Z",
    apps: {
      "juice-shop": juiceShop(["patched", "patched", "patched", "patched"]),
      dvwa: dvwa(["patched", "patched", "patched"]),
      webgoat: webgoat(["patched", "patched"]),
      securityshepherd: securityShepherd(["patched", "patched"]),
      vulnerableapp: vulnerableApp(["patched", "patched"]),
      vampi: vampi(["patched", "patched"]),
    },
  },
  {
    login: "gaearon",
    team: "0xcafebabe",
    updatedAt: "2026-08-07T13:05:21Z",
    apps: {
      "juice-shop": juiceShop(["patched", "open", "missing", "missing"]),
      vulnerableapp: vulnerableApp(["patched", "missing"]),
    },
  },
  {
    login: "yyx990803",
    team: null,
    updatedAt: "2026-08-07T12:44:18Z",
    apps: {
      dvwa: dvwa(["patched", "missing", "missing"]),
      vampi: vampi(["open", "missing"]),
    },
  },
  {
    login: "sindresorhus",
    team: null,
    updatedAt: "2026-08-07T11:20:03Z",
    apps: {
      "juice-shop": juiceShop(["open", "missing", "missing", "missing"]),
    },
  },
  {
    login: "tj",
    team: null,
    updatedAt: "2026-08-06T22:15:47Z",
    apps: {
      webgoat: webgoat(["missing", "missing"]),
    },
  },
  {
    login: "nobody",
    team: null,
    updatedAt: "2026-08-06T20:00:00Z",
    apps: {},
  },
];

const TEAM_NAMES: Record<string, string> = {
  "seg-fault": "Segfault Syndicate",
  "null-terminators": "null_terminators",
  "0xcafebabe": "0xCafeBabe",
};

// Mock team-store data doesn't model captaincy, so the fixture pins one
// explicitly per team (falls back to the first member otherwise).
const TEAM_CAPTAINS: Record<string, string> = {
  "seg-fault": "octocat",
  "null-terminators": "hubot",
  "0xcafebabe": "torvalds",
};

/** Sums a team's points as the UNION of patched (app, challenge key) pairs
 *  across its members — a flag two teammates both solved counts once, not
 *  once per solver. This is what the real scorer/lambda path does with
 *  per-flag data; the mock mirrors it here since it has that same per-flag
 *  detail available on each entry's `apps[].challenges`. */
function teamPoints(members: LeaderboardEntry[]): number {
  const seen = new Set<string>();
  let points = 0;
  const catalog = buildMockCatalog();
  for (const entry of members) {
    for (const [app, progress] of Object.entries(entry.apps) as [AppId, LeaderboardEntry["apps"][AppId]][]) {
      for (const id of progress?.solvedIds ?? []) {
        const dedupeKey = `${app}:${id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        points += catalog[app]?.find((c) => c.key === id)?.points ?? 0;
      }
    }
  }
  return points;
}

/** The catalogue every mock row's `solvedIds` point into: the union of each
 *  sample's fixture rows per target, deduped by key. Built from the same
 *  fixtures so the two can never disagree. */
export function buildMockCatalog(): ChallengeCatalog {
  const out: ChallengeCatalog = {};
  for (const sample of SAMPLES) {
    for (const [app, challenges] of Object.entries(sample.apps) as [AppId, ChallengeResult[]][]) {
      const list = (out[app] ??= []);
      for (const c of challenges) {
        if (!list.some((k) => k.key === c.key)) list.push({ key: c.key, name: c.name, points: c.points, owasp: c.owasp });
      }
    }
  }
  return out;
}

function summarize(sample: Sample) {
  let points = 0;
  let patched = 0;
  let failed = 0;
  let total = 0;
  const apps: LeaderboardEntry["apps"] = {};
  for (const [app, challenges] of Object.entries(sample.apps) as [AppId, ChallengeResult[]][]) {
    const appPatched = challenges.filter((c) => c.status === "patched");
    const appOpen = challenges.filter((c) => c.status === "open");
    const appPoints = appPatched.reduce((n, c) => n + c.points, 0);
    const appMax = challenges.reduce((n, c) => n + c.points, 0);
    points += appPoints;
    patched += appPatched.length;
    failed += appOpen.length;
    total += challenges.length;
    apps[app] = {
      app,
      points: appPoints,
      maxPoints: appMax,
      patched: appPatched.length,
      total: challenges.length,
      // The fixtures are authored as full ChallengeResult rows for readability;
      // what ships is the same shape the lambda source produces — ids only,
      // joined against buildMockCatalog() at render (issue #434).
      solvedIds: appPatched.map((c) => c.key),
    };
  }
  return { points, patched, failed, total, apps };
}

export function buildMockEntries(): LeaderboardEntry[] {
  return rankByStanding(
    SAMPLES.map((sample) => {
      const { points, patched, failed, total, apps } = summarize(sample);
      return {
        rank: 0, // assigned by rankByStanding
        login: sample.login,
        team: sample.team,
        points,
        patched,
        failed,
        total,
        apps,
        updatedAt: sample.updatedAt,
        // The fixture's updatedAt is the last scoring change, i.e. a solve.
        lastSolveAt: sample.updatedAt,
      };
    }),
  );
}

export function buildMockTeams(entries: LeaderboardEntry[]): TeamStanding[] {
  const bySlug = new Map<string, LeaderboardEntry[]>();
  for (const entry of entries) {
    if (!entry.team) continue;
    const existing = bySlug.get(entry.team) ?? [];
    existing.push(entry);
    bySlug.set(entry.team, existing);
  }
  return [...bySlug.entries()]
    .map(([slug, members]) => ({
      slug,
      name: TEAM_NAMES[slug] ?? slug,
      captain: TEAM_CAPTAINS[slug] ?? members[0].login,
      members: members.map((m) => m.login),
      points: teamPoints(members),
      rank: 0,
    }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
    .map((team, i) => ({ ...team, rank: i + 1 }));
}

export function findMockSample(login: string): Sample | undefined {
  return SAMPLES.find((s) => s.login === login);
}
