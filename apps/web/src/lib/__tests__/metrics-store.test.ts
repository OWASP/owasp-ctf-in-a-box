// Event engagement metrics (issue #169), computed entirely from stored data.
//
// The load-bearing property is that every figure comes from keys the modules
// already maintain — there is no collection step to get wrong. So what these
// pin is the ARITHMETIC (does a fold double count?), the honesty (are the
// limits reported alongside the numbers?), and the fact that nothing here
// reaches outside Redis.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<{ result?: unknown }[]>>(),
  listTeams: vi.fn<() => Promise<{ slug: string; name: string; members: string[] }[]>>(),
  // Secure Development points come from the leaderboard SOURCE, not from a
  // Redis hash this store reads itself (issue #432): `ctf:solves:*` carries
  // timestamps only, and the per-login SD total is the scorer's `points` on
  // each leaderboard entry. Mocked as the mode plus a fetch, which is exactly
  // the surface the store consumes (`getLeaderboardSource().getLeaderboard()`).
  getLeaderboardSourceMode: vi.fn<() => Promise<"mock" | "lambda" | "upstash" | "empty">>(),
  getLeaderboard: vi.fn<() => Promise<{ entries: { login: string; points: number }[] }>>(),
}));

vi.mock("server-only", () => ({}));
// `parseScanPage` is the REAL parser — see the note in team-store.test.ts.
vi.mock("@/lib/upstash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upstash")>();
  return { assertPipelineOk: actual.assertPipelineOk,
    parseScanPage: actual.parseScanPage, upstashPipeline: mocks.upstashPipeline };
});
vi.mock("@/lib/team-store", () => ({ listTeams: mocks.listTeams }));
vi.mock("@/lib/leaderboard/source", () => ({
  getLeaderboardSourceMode: mocks.getLeaderboardSourceMode,
  getLeaderboardSource: async () => ({ getLeaderboard: mocks.getLeaderboard }),
}));

import { challengesToCsv, computeEventMetrics, type EventMetrics } from "@/lib/metrics-store";

/** Upstash returns a hash as a flat [field, value, ...] array. */
const hash = (obj: Record<string, string | number>) => Object.entries(obj).flat();
const earned = (points: number, at: string) => JSON.stringify({ points, at });
const attempt = (attempts: number, lastAt = "2026-08-22T10:00:00Z") =>
  JSON.stringify({ attempts, lastAt });

/**
 * Drives the store's fixed read order:
 *   1. one pipeline: quiz points, classic points, ai points, hints spent
 *   2. SCAN ctf:solves:*        (secure-dev sweep; repeats until cursor 0)
 *   3. HGETALL of each solves key found
 *   4. EIGHT commands per contestant, batched (answers, solves, ai solves,
 *      quiz attempts, classic attempts, ai attempts, firstTeamAt, hint
 *      purchase times)
 *
 * Written as a queue rather than per-call mocks because `vi.clearAllMocks()`
 * does NOT clear queued one-shot implementations — leftovers from one test
 * surface as phantom replies in the next.
 */
function mockStore(opts: {
  sdKeys?: Record<string, Record<string, string>>;
  quizPoints?: Record<string, number>;
  classicPoints?: Record<string, number>;
  aiPoints?: Record<string, number>;
  hintsSpent?: Record<string, number>;
  perLogin?: Record<
    string,
    {
      quizAnswers?: Record<string, string>;
      classicSolves?: Record<string, string>;
      aiSolves?: Record<string, string>;
      quizAttempts?: Record<string, string>;
      classicAttempts?: Record<string, string>;
      aiAttempts?: Record<string, string>;
      firstTeamAt?: string | null;
      /** `<app>/<challengeId>` -> ISO bought-at. */
      hintTimes?: Record<string, string>;
    }
  >;
  logins?: string[];
  /** Skip auto-registering the logins as a team. */
  noTeam?: boolean;
  /** Per-login Secure Development points, as the leaderboard source reports
   *  them (issue #432). Omitted, the source answers no entries — the shape of
   *  an event whose scorer has nothing yet. `sourceMode` defaults to "lambda"
   *  (a real scorer); "empty" is what the source itself returns when the
   *  module is off, and "mock" is placeholder data the store must not fold. */
  sdPoints?: Record<string, number>;
  sourceMode?: "mock" | "lambda" | "upstash" | "empty";
  /** The source read rejects — a scorer that is down. */
  sourceFails?: boolean;
  /** The three catalogue hashes the title join reads, LAST in the read order.
   *  Omitted, the default mock answers empty and every row keeps its id —
   *  which is the fallback under test in "a challenge deleted since it was
   *  solved". */
  titles?: {
    quiz?: Record<string, string>;
    classic?: Record<string, string>;
    ai?: Record<string, string>;
  };
}) {
  const sdKeys = opts.sdKeys ?? {};
  const keys = Object.keys(sdKeys);

  mocks.getLeaderboardSourceMode.mockResolvedValue(opts.sourceMode ?? "lambda");
  if (opts.sourceFails) mocks.getLeaderboard.mockRejectedValue(new Error("scorer unreachable"));
  else
    mocks.getLeaderboard.mockResolvedValue({
      entries: Object.entries(opts.sdPoints ?? {}).map(([login, points]) => ({ login, points })),
    });

  // Put every contestant on a team unless a test says otherwise. This is not
  // convenience — it is the realistic shape since ADR 47, and it is what makes
  // a contestant who attempted-but-never-scored discoverable at all: they have
  // no points row, so only their team membership knows they exist.
  const named = opts.logins ?? Object.keys(opts.perLogin ?? {});
  if (!opts.noTeam && named.length) {
    mocks.listTeams.mockResolvedValue([{ slug: "all", name: "All", members: named }]);
  }

  mocks.upstashPipeline.mockResolvedValueOnce([
    { result: hash(opts.quizPoints ?? {}) },
    { result: hash(opts.classicPoints ?? {}) },
    { result: hash(opts.aiPoints ?? {}) },
    { result: hash(opts.hintsSpent ?? {}) },
  ]);
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["0", keys] }]);
  if (keys.length) {
    mocks.upstashPipeline.mockResolvedValueOnce(keys.map((k) => ({ result: hash(sdKeys[k]) })));
  }

  const logins = (opts.logins ?? Object.keys(opts.perLogin ?? {})).slice().sort();
  if (logins.length) {
    mocks.upstashPipeline.mockResolvedValueOnce(
      logins.flatMap((l) => {
        const p = opts.perLogin?.[l] ?? {};
        return [
          { result: hash(p.quizAnswers ?? {}) },
          { result: hash(p.classicSolves ?? {}) },
          { result: hash(p.aiSolves ?? {}) },
          { result: hash(p.quizAttempts ?? {}) },
          { result: hash(p.classicAttempts ?? {}) },
          { result: hash(p.aiAttempts ?? {}) },
          { result: [p.firstTeamAt ?? null] },
          { result: hash(p.hintTimes ?? {}) },
        ];
      }),
    );
  }

  // The title join: HGETALL of the quiz, classic and ai catalogues, in that
  // order. Values are the stored rows, so quiz carries `prompt` and the other
  // two carry `title` — the join has to read both.
  if (opts.titles) {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: hash(opts.titles.quiz ?? {}) },
      { result: hash(opts.titles.classic ?? {}) },
      { result: hash(opts.titles.ai ?? {}) },
    ]);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listTeams.mockResolvedValue([]);
  // Default: every unqueued pipeline answers with one empty reply per command.
  // Queued `mockResolvedValueOnce` values still take precedence. Without this,
  // a fold large enough to be split across batches gets `undefined` back for
  // every batch after the first — which is a test artifact, not a real
  // behaviour, and would otherwise look like a bug in the store.
  mocks.upstashPipeline.mockImplementation(async (cmds) => cmds.map(() => ({ result: null })));
});

describe("the funnel", () => {
  it("counts conversion from firstTeamAt, so leavers still count", async () => {
    // ADR 49: firstTeamAt survives leaving and switching. A contestant who
    // quit their team still converted, and the funnel has to say so or it
    // undercounts every dropout it exists to measure.
    mocks.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["alice"] }]);
    mockStore({
      noTeam: true, // this test owns the roster: alice is on one, bob left
      logins: ["alice", "bob"],
      quizPoints: { alice: 10, bob: 5 },
      perLogin: {
        alice: { firstTeamAt: "2026-08-22T09:00:00Z", quizAnswers: { q1: earned(10, "2026-08-22T10:00:00Z") } },
        bob: { firstTeamAt: "2026-08-22T09:30:00Z", quizAnswers: { q1: earned(5, "2026-08-22T10:05:00Z") } },
      },
    });
    const m = await computeEventMetrics();
    expect(m.funnel.onATeam).toBe(1); // only alice is on one NOW
    expect(m.funnel.everOnATeam).toBe(2); // bob converted and left
  });

  it("counts the stuck: attempted, never scored", async () => {
    mockStore({
      perLogin: {
        alice: { classicSolves: { c1: earned(10, "2026-08-22T10:00:00Z") }, classicAttempts: { c1: attempt(1) } },
        bob: { classicAttempts: { c1: attempt(7) } },
      },
      quizPoints: {},
      classicPoints: { alice: 10 },
    });
    const m = await computeEventMetrics();
    expect(m.funnel.attempted).toBe(2);
    expect(m.funnel.scored).toBe(1);
    expect(m.funnel.stuck).toBe(1);
  });

  it("never reports negative stuck when scores arrive without attempt rows", async () => {
    // Secure Development scores land from GitHub with no attempt row at all,
    // so `scored` can exceed anything derived from attempts. The subtraction
    // has to floor at zero rather than print a nonsense negative.
    mockStore({
      sdKeys: { "ctf:solves:dvwa": { "alice:c1": "2026-08-22T10:00:00Z" } },
      logins: ["alice"],
      perLogin: { alice: {} },
    });
    const m = await computeEventMetrics();
    expect(m.funnel.stuck).toBeGreaterThanOrEqual(0);
    expect(m.funnel.scored).toBe(1);
  });
});

describe("per-challenge stats", () => {
  it("counts DISTINCT solvers, not submissions", async () => {
    mockStore({
      perLogin: {
        alice: { classicSolves: { c1: earned(10, "2026-08-22T10:00:00Z") }, classicAttempts: { c1: attempt(3) } },
        bob: { classicSolves: { c1: earned(10, "2026-08-22T10:01:00Z") }, classicAttempts: { c1: attempt(1) } },
      },
      classicPoints: { alice: 10, bob: 10 },
    });
    const m = await computeEventMetrics();
    const c1 = m.challenges.find((c) => c.id === "c1");
    expect(c1?.solves).toBe(2);
    expect(c1?.attempts).toBe(4); // 3 + 1 submissions
  });

  it("reports avg attempts to solve — the signal solve rate alone hides", async () => {
    // Both solved it, so the rate is 100%; it still took four tries each.
    mockStore({
      perLogin: {
        alice: { quizAnswers: { q1: earned(5, "2026-08-22T10:00:00Z") }, quizAttempts: { q1: attempt(4) } },
        bob: { quizAnswers: { q1: earned(5, "2026-08-22T10:00:00Z") }, quizAttempts: { q1: attempt(4) } },
      },
      quizPoints: { alice: 5, bob: 5 },
    });
    const m = await computeEventMetrics();
    const q1 = m.challenges.find((c) => c.id === "q1");
    expect(q1?.solveRate).toBe(1);
    expect(q1?.avgAttemptsToSolve).toBe(4);
  });

  it("leaves solveRate null when nobody attempted, rather than dividing by zero", async () => {
    mockStore({ perLogin: { alice: {} } });
    const m = await computeEventMetrics();
    expect(m.challenges).toEqual([]);
  });

  it("sorts hardest-first, so the stuck challenges are at the top", async () => {
    mockStore({
      perLogin: {
        alice: {
          classicSolves: { easy: earned(1, "2026-08-22T10:00:00Z") },
          classicAttempts: { easy: attempt(1), hard: attempt(9) },
        },
      },
      classicPoints: { alice: 1 },
    });
    const m = await computeEventMetrics();
    expect(m.challenges[0]?.id).toBe("hard");
    expect(m.challenges[0]?.solves).toBe(0);
  });
});

describe("timeline", () => {
  it("buckets solves into 10-minute windows, ascending", async () => {
    mockStore({
      perLogin: {
        alice: {
          quizAnswers: {
            q1: earned(5, "2026-08-22T10:03:00Z"),
            q2: earned(5, "2026-08-22T10:07:00Z"),
            q3: earned(5, "2026-08-22T10:22:00Z"),
          },
        },
      },
      quizPoints: { alice: 15 },
    });
    const m = await computeEventMetrics();
    expect(m.timeline).toEqual([
      { at: "2026-08-22T10:00:00.000Z", solves: 2 },
      { at: "2026-08-22T10:20:00.000Z", solves: 1 },
    ]);
  });

  it("skips an unparseable timestamp instead of poisoning the series", async () => {
    mockStore({
      perLogin: { alice: { quizAnswers: { q1: earned(5, "not-a-date"), q2: earned(5, "2026-08-22T10:00:00Z") } } },
      quizPoints: { alice: 10 },
    });
    const m = await computeEventMetrics();
    expect(m.timeline).toEqual([{ at: "2026-08-22T10:00:00.000Z", solves: 1 }]);
  });
});

describe("honesty", () => {
  it("ships its own caveats in the payload, not only in the docs", async () => {
    // A metric whose limits travel separately from it gets quoted without
    // them. The team-points caveat especially: that column is NOT the
    // leaderboard's figure.
    mockStore({ perLogin: {} });
    const m = await computeEventMetrics();
    expect(m.caveats.join(" ")).toMatch(/leaderboard folds the UNION/);
    expect(m.caveats.join(" ")).toMatch(/timeline plots solves, not submissions/);
    expect(m.caveats.join(" ")).toMatch(/Signing in leaves no record/);
  });

  it("says so when the contestant cap truncated the fold", async () => {
    const many = Array.from({ length: 2100 }, (_, i) => `user${String(i).padStart(4, "0")}`);
    mocks.listTeams.mockResolvedValue([{ slug: "big", name: "Big", members: many }]);
    mockStore({ noTeam: true, logins: many.slice().sort().slice(0, 2000), perLogin: {} });
    const m = await computeEventMetrics();
    expect(m.caveats.join(" ")).toMatch(/Only the first 2000 of 2100/);
  });
});

// Audit F7: the fold works in ids because progress is recorded against ids,
// which is right for the arithmetic and useless to somebody reading numbers
// out at a closing ceremony.
describe("naming the challenges", () => {
  const solvedOne = {
    logins: ["alice"],
    classicPoints: { alice: 10 },
    aiPoints: { alice: 5 },
    quizPoints: { alice: 7 },
    perLogin: {
      alice: {
        classicSolves: { "cookie-jar-x1": earned(10, "2026-08-22T10:00:00Z") },
        aiSolves: { "guardrail-bypass-0l": earned(5, "2026-08-22T10:01:00Z") },
        quizAnswers: { "which-header-k3": earned(7, "2026-08-22T10:02:00Z") },
      },
    },
  };

  it("carries the organizer's own name for each row", async () => {
    mockStore({
      ...solvedOne,
      titles: {
        quiz: { "which-header-k3": JSON.stringify({ prompt: "Which header mitigates clickjacking?" }) },
        classic: { "cookie-jar-x1": JSON.stringify({ title: "Cookie jar" }) },
        ai: { "guardrail-bypass-0l": JSON.stringify({ title: "Guardrail bypass" }) },
      },
    });
    const byId = new Map((await computeEventMetrics()).challenges.map((c) => [c.id, c]));

    // A quiz question's name is its PROMPT; classic and ai carry a title. The
    // join reads both so no caller has to know which.
    expect(byId.get("which-header-k3")?.title).toBe("Which header mitigates clickjacking?");
    expect(byId.get("cookie-jar-x1")?.title).toBe("Cookie jar");
    expect(byId.get("guardrail-bypass-0l")?.title).toBe("Guardrail bypass");
  });

  it("keeps the id on every row, so nothing is renamed out of reach", async () => {
    mockStore({
      ...solvedOne,
      titles: { classic: { "cookie-jar-x1": JSON.stringify({ title: "Cookie jar" }) } },
    });
    const row = (await computeEventMetrics()).challenges.find((c) => c.id === "cookie-jar-x1");
    expect(row?.id).toBe("cookie-jar-x1");
    expect(row?.title).toBe("Cookie jar");
  });

  it("falls back to no title for a challenge deleted since it was solved", async () => {
    // Metrics outlive the catalogue row: the solve happened. Losing the
    // numbers because the label could not be found would be the worse trade.
    mockStore({ ...solvedOne, titles: {} });
    const m = await computeEventMetrics();
    expect(m.challenges).toHaveLength(3);
    expect(m.challenges.every((c) => c.title === null)).toBe(true);
    expect(m.challenges.find((c) => c.id === "cookie-jar-x1")?.solves).toBe(1);
  });

  it("keeps every number when the catalogue read itself fails", async () => {
    // `upstashPipeline` throws on a timeout, a missing URL/token or a non-2xx
    // response — it returns only PER-COMMAND errors as values. An uncaught
    // call here would reject the whole fold, so failing to fetch the LABELS
    // would cost the organizer every NUMBER on the tab.
    mockStore(solvedOne);
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("Upstash pipeline failed: HTTP 503"));
    const m = await computeEventMetrics();
    expect(m.challenges).toHaveLength(3);
    expect(m.challenges.every((c) => c.title === null)).toBe(true);
    expect(m.challenges.find((c) => c.id === "cookie-jar-x1")?.solves).toBe(1);
  });

  it("survives an unparseable catalogue row without losing the others", async () => {
    mockStore({
      ...solvedOne,
      titles: {
        classic: { "cookie-jar-x1": "{not json" },
        ai: { "guardrail-bypass-0l": JSON.stringify({ title: "Guardrail bypass" }) },
      },
    });
    const byId = new Map((await computeEventMetrics()).challenges.map((c) => [c.id, c]));
    expect(byId.get("cookie-jar-x1")?.title).toBeNull();
    expect(byId.get("guardrail-bypass-0l")?.title).toBe("Guardrail bypass");
  });
});

describe("challengesToCsv", () => {
  const metrics = {
    challenges: [
      { module: "classic", id: "c1", title: "Cookie jar", solves: 2, attempts: 5, solveRate: 0.5, avgAttemptsToSolve: 2.5, medianSecondsToSolve: 90, solvedAfterHint: 0 },
      { module: "quiz", id: "q,1", title: null, solves: 0, attempts: 0, solveRate: null, avgAttemptsToSolve: null, medianSecondsToSolve: null, solvedAfterHint: 0 },
    ],
  } as EventMetrics;

  it("emits a header and one row per challenge", () => {
    const lines = challengesToCsv(metrics).trim().split("\n");
    expect(lines[0]).toBe(
      "module,id,title,solves,attempts,solve_rate,avg_attempts_to_solve,median_seconds_to_solve",
    );
    expect(lines).toHaveLength(3);
  });

  it("quotes a field containing a comma, so the columns do not shift", () => {
    expect(challengesToCsv(metrics)).toContain('"q,1"');
  });

  it("carries the title beside the id, never instead of it", () => {
    // The id is what a support question and a store key name; the title is
    // what an organizer reads out at a closing ceremony. A CSV that dropped
    // the id to make room would be unusable for the first job (audit F7).
    expect(challengesToCsv(metrics)).toMatch(/classic,c1,Cookie jar,2,5,/);
  });

  it("writes an EMPTY cell for null, never the string 'null'", () => {
    // A spreadsheet reading `null` as text silently breaks every average over
    // that column. A missing title takes the same treatment as a missing
    // number: an empty cell.
    expect(challengesToCsv(metrics)).toMatch(/quiz,"q,1",,0,0,,,\n/);
  });
});

// --- what firstAt and the hint timestamps unlocked -------------------------

describe("time to solve", () => {
  const attemptFrom = (attempts: number, firstAt: string) =>
    JSON.stringify({ attempts, firstAt, lastAt: firstAt, lastAtMs: Date.parse(firstAt) });

  it("measures from the FIRST attempt, not the last", async () => {
    // The whole reason `firstAt` was added. With only `lastAt`, a contestant
    // who tried at 10:00 and solved at 10:05 would measure as zero seconds.
    mockStore({
      perLogin: {
        alice: {
          classicSolves: { c1: earned(10, "2026-08-22T10:05:00Z") },
          classicAttempts: { c1: attemptFrom(3, "2026-08-22T10:00:00Z") },
        },
      },
      classicPoints: { alice: 10 },
    });
    const m = await computeEventMetrics();
    expect(m.challenges.find((c) => c.id === "c1")?.medianSecondsToSolve).toBe(300);
  });

  it("takes the MEDIAN, so one abandoned tab cannot dominate", async () => {
    mockStore({
      perLogin: {
        alice: {
          classicSolves: { c1: earned(1, "2026-08-22T10:01:00Z") },
          classicAttempts: { c1: attemptFrom(1, "2026-08-22T10:00:00Z") },
        },
        bob: {
          classicSolves: { c1: earned(1, "2026-08-22T10:02:00Z") },
          classicAttempts: { c1: attemptFrom(1, "2026-08-22T10:00:00Z") },
        },
        carol: {
          classicSolves: { c1: earned(1, "2026-08-23T10:00:00Z") },
          classicAttempts: { c1: attemptFrom(1, "2026-08-22T10:00:00Z") },
        },
      },
      classicPoints: { alice: 1, bob: 1, carol: 1 },
    });
    // 60s, 120s, 86400s -> median 120, not the ~29000s mean.
    expect((await computeEventMetrics()).challenges[0]?.medianSecondsToSolve).toBe(120);
  });

  it("is null for rows written before firstAt existed", async () => {
    // Old rows carry no firstAt. A missing duration must read as unknown, not
    // as an instant solve.
    mockStore({
      perLogin: {
        alice: {
          classicSolves: { c1: earned(10, "2026-08-22T10:05:00Z") },
          classicAttempts: { c1: JSON.stringify({ attempts: 2, lastAt: "2026-08-22T10:04:00Z" }) },
        },
      },
      classicPoints: { alice: 10 },
    });
    expect((await computeEventMetrics()).challenges[0]?.medianSecondsToSolve).toBeNull();
  });

  it("discards a solve recorded BEFORE its first attempt", async () => {
    // Corrupt ordering; a negative duration would drag the median below zero.
    mockStore({
      perLogin: {
        alice: {
          classicSolves: { c1: earned(10, "2026-08-22T10:00:00Z") },
          classicAttempts: { c1: attemptFrom(1, "2026-08-22T11:00:00Z") },
        },
      },
      classicPoints: { alice: 10 },
    });
    expect((await computeEventMetrics()).challenges[0]?.medianSecondsToSolve).toBeNull();
  });
});

describe("hint ordering", () => {
  it("separates a hint bought BEFORE the solve from one bought after", async () => {
    // "Hints are used" and "hints help" are different claims. A hint bought
    // after the solve bought nothing, and lumping them together would let the
    // first number masquerade as the second.
    mockStore({
      sdKeys: {
        "ctf:solves:dvwa": {
          "alice:Challenge-1": "2026-08-22T10:10:00Z",
          "bob:Challenge-1": "2026-08-22T10:10:00Z",
        },
      },
      logins: ["alice", "bob"],
      perLogin: {
        alice: { hintTimes: { "dvwa/Challenge-1": "2026-08-22T10:00:00Z" } }, // before
        bob: { hintTimes: { "dvwa/Challenge-1": "2026-08-22T10:20:00Z" } }, // after
      },
    });
    const m = await computeEventMetrics();
    expect(m.hints.boughtBeforeSolving).toBe(1);
    expect(m.hints.boughtAfterSolving).toBe(1);
  });

  // #190: classic slots compare against the login's OWN solve rows, and the
  // per-challenge stat gains a real solvedAfterHint figure.
  it("orders a CLASSIC hint against the login's own solve time, per challenge", async () => {
    mockStore({
      logins: ["alice", "bob"],
      perLogin: {
        alice: {
          classicSolves: { "web-robots-only": JSON.stringify({ points: 50, at: "2026-08-22T10:10:00Z" }) },
          hintTimes: { "classic/web-robots-only": "2026-08-22T10:00:00Z" }, // before
        },
        bob: {
          classicSolves: { "web-robots-only": JSON.stringify({ points: 50, at: "2026-08-22T10:10:00Z" }) },
          hintTimes: { "classic/web-robots-only": "2026-08-22T10:20:00Z" }, // after
        },
      },
    });
    const m = await computeEventMetrics();
    expect(m.hints.boughtBeforeSolving).toBe(1);
    expect(m.hints.boughtAfterSolving).toBe(1);
    const stat = m.challenges.find((c) => c.module === "classic" && c.id === "web-robots-only");
    expect(stat?.solvedAfterHint).toBe(1);
  });

  // Ai hints exist now (Tasks 1-2): the ai target must get the same
  // own-solve-row comparison classic gets, not fall through to the
  // secure-dev branch (which would never match an ai solve row and would
  // silently drop every ai hint purchase from both counts).
  it("orders an AI hint against the login's own solve time, per challenge", async () => {
    mockStore({
      logins: ["alice", "bob"],
      perLogin: {
        alice: {
          aiSolves: { "prompt-injection-1": JSON.stringify({ points: 50, at: "2026-08-22T10:10:00Z" }) },
          hintTimes: { "ai/prompt-injection-1": "2026-08-22T10:00:00Z" }, // before
        },
        bob: {
          aiSolves: { "prompt-injection-1": JSON.stringify({ points: 50, at: "2026-08-22T10:10:00Z" }) },
          hintTimes: { "ai/prompt-injection-1": "2026-08-22T10:20:00Z" }, // after
        },
      },
    });
    const m = await computeEventMetrics();
    expect(m.hints.boughtBeforeSolving).toBe(1);
    expect(m.hints.boughtAfterSolving).toBe(1);
    const stat = m.challenges.find((c) => c.module === "ai" && c.id === "prompt-injection-1");
    expect(stat?.solvedAfterHint).toBe(1);
  });

  it("counts a classic AND an ai hint correctly in the same fold — no cross-module regression", async () => {
    mockStore({
      logins: ["alice", "bob"],
      perLogin: {
        alice: {
          classicSolves: { "web-robots-only": JSON.stringify({ points: 50, at: "2026-08-22T10:10:00Z" }) },
          hintTimes: { "classic/web-robots-only": "2026-08-22T10:00:00Z" }, // before
        },
        bob: {
          aiSolves: { "prompt-injection-1": JSON.stringify({ points: 50, at: "2026-08-22T10:10:00Z" }) },
          hintTimes: { "ai/prompt-injection-1": "2026-08-22T10:00:00Z" }, // before
        },
      },
    });
    const m = await computeEventMetrics();
    expect(m.hints.boughtBeforeSolving).toBe(2);
    expect(m.hints.boughtAfterSolving).toBe(0);
    const classicStat = m.challenges.find((c) => c.module === "classic" && c.id === "web-robots-only");
    const aiStat = m.challenges.find((c) => c.module === "ai" && c.id === "prompt-injection-1");
    expect(classicStat?.solvedAfterHint).toBe(1);
    expect(aiStat?.solvedAfterHint).toBe(1);
  });

  it("counts a hint bought and never solved as NEITHER", async () => {
    mockStore({
      logins: ["alice"],
      perLogin: { alice: { hintTimes: { "dvwa/Challenge-9": "2026-08-22T10:00:00Z" } } },
    });
    const m = await computeEventMetrics();
    expect(m.hints.boughtBeforeSolving).toBe(0);
    expect(m.hints.boughtAfterSolving).toBe(0);
  });

  it("does not match a hint against a DIFFERENT target sharing a challenge id", async () => {
    // Ids are unique within an app's catalogue, not across apps. Flattening
    // the target away would credit a dvwa hint with a webgoat solve.
    mockStore({
      sdKeys: { "ctf:solves:webgoat": { "alice:Challenge-1": "2026-08-22T10:10:00Z" } },
      logins: ["alice"],
      perLogin: { alice: { hintTimes: { "dvwa/Challenge-1": "2026-08-22T10:00:00Z" } } },
    });
    const m = await computeEventMetrics();
    expect(m.hints.boughtBeforeSolving).toBe(0);
    expect(m.hints.boughtAfterSolving).toBe(0);
  });
});

// --- solve rate cannot exceed 100% ------------------------------------------

describe("solveRate denominator", () => {
  it("never reports above 100% when a solve has no attempt row", async () => {
    // Earned rows can exist without an attempt row: the demo seed writes
    // answers directly, and so does any data predating the attempt hash.
    // Dividing by the attempt-row count alone produced 200% and 300% on a
    // seeded event — nonsense on its face, not a subtle inaccuracy.
    mockStore({
      perLogin: {
        alice: { quizAnswers: { q1: earned(5, "2026-08-22T10:00:00Z") } },
        bob: { quizAnswers: { q1: earned(5, "2026-08-22T10:01:00Z") } },
        // Only ONE of the three solvers has an attempt row.
        carol: {
          quizAnswers: { q1: earned(5, "2026-08-22T10:02:00Z") },
          quizAttempts: { q1: attempt(1) },
        },
      },
      quizPoints: { alice: 5, bob: 5, carol: 5 },
    });
    const q1 = (await computeEventMetrics()).challenges.find((c) => c.id === "q1");
    expect(q1?.solves).toBe(3);
    expect(q1?.solveRate).toBe(1);
  });

  it("still reports a genuine partial rate", async () => {
    // Two attempted, one solved — the rate has to stay 50%, so the fix must
    // not have become "always 100%".
    mockStore({
      perLogin: {
        alice: {
          quizAnswers: { q1: earned(5, "2026-08-22T10:00:00Z") },
          quizAttempts: { q1: attempt(1) },
        },
        bob: { quizAttempts: { q1: attempt(4) } },
      },
      quizPoints: { alice: 5 },
    });
    const q1 = (await computeEventMetrics()).challenges.find((c) => c.id === "q1");
    expect(q1?.solveRate).toBe(0.5);
  });

  it("keeps every rate within 0..1 across a mixed board", async () => {
    mockStore({
      perLogin: {
        alice: {
          quizAnswers: { a: earned(1, "2026-08-22T10:00:00Z"), b: earned(1, "2026-08-22T10:00:00Z") },
          quizAttempts: { b: attempt(2), c: attempt(9) },
        },
      },
      quizPoints: { alice: 2 },
    });
    for (const c of (await computeEventMetrics()).challenges) {
      if (c.solveRate === null) continue;
      expect(c.solveRate).toBeGreaterThanOrEqual(0);
      expect(c.solveRate).toBeLessThanOrEqual(1);
    }
  });
});

// --- the ai module folds exactly like classic --------------------------------

describe("the ai module", () => {
  it("counts DISTINCT ai solvers and total attempts, same as classic's fold", async () => {
    // Field-swap of "counts DISTINCT solvers, not submissions" above.
    mockStore({
      perLogin: {
        alice: { aiSolves: { c1: earned(10, "2026-08-22T10:00:00Z") }, aiAttempts: { c1: attempt(3) } },
        bob: { aiSolves: { c1: earned(10, "2026-08-22T10:01:00Z") }, aiAttempts: { c1: attempt(1) } },
      },
      aiPoints: { alice: 10, bob: 10 },
    });
    const m = await computeEventMetrics();
    const c1 = m.challenges.find((c) => c.module === "ai" && c.id === "c1");
    expect(c1?.solves).toBe(2);
    expect(c1?.attempts).toBe(4); // 3 + 1 submissions
    expect(m.modules.ai).toBe(2);
  });

  it("credits ai solves into the funnel and the timeline, same as quiz/classic", async () => {
    mockStore({
      perLogin: {
        alice: { aiSolves: { c1: earned(10, "2026-08-22T10:00:00Z") } },
      },
      aiPoints: { alice: 10 },
    });
    const m = await computeEventMetrics();
    expect(m.funnel.scored).toBe(1);
    expect(m.timeline).toEqual([{ at: "2026-08-22T10:00:00.000Z", solves: 1 }]);
  });

  it("modules.ai stays 0 and no ai rows appear when nobody has touched the module — the same unconditional-but-empty read quiz/classic get when disabled", async () => {
    // metrics-store never gates a read on module enablement for quiz or
    // classic: a disabled module simply never had anything written to its
    // keys, so the fold reads an empty hash and reports 0. Ai is folded the
    // same unconditional way — there is no enablement check to mirror,
    // only the empty-hash-reads-as-zero behaviour.
    mockStore({
      perLogin: { alice: { quizAnswers: { q1: earned(5, "2026-08-22T10:00:00Z") } } },
      quizPoints: { alice: 5 },
    });
    const m = await computeEventMetrics();
    expect(m.modules.ai).toBe(0);
    expect(m.challenges.some((c) => c.module === "ai")).toBe(false);
  });

  it("never lets a poisoned ai record's extra flag/key fields reach the metrics payload", async () => {
    // parseEarned/parseAttemptRow are strict by construction: they read only
    // `points`/`at` (or `attempts`/`firstAt`) off the parsed object and ignore
    // everything else. This pins that a corrupted row — one carrying a flag,
    // a signing key, or a PEM block past the JSON.parse — still cannot make
    // those bytes appear anywhere in the serialized metrics payload.
    const poisoned = JSON.stringify({
      points: 10,
      at: "2026-08-22T10:00:00Z",
      flag: "CTF{leaked}",
      signkey: "aik_should_not_leak",
      privateKey: "-----BEGIN PRIVATE KEY-----poison-----END PRIVATE KEY-----",
    });
    mockStore({
      perLogin: {
        alice: { aiSolves: { c1: poisoned }, aiAttempts: { c1: attempt(1) } },
      },
      aiPoints: { alice: 10 },
    });
    const m = await computeEventMetrics();
    const serialized = JSON.stringify(m);
    expect(serialized).not.toMatch(/flag|signkey|aik_|PRIVATE KEY/i);
    const c1 = m.challenges.find((c) => c.module === "ai" && c.id === "c1");
    expect(c1?.solves).toBe(1);
  });

  it("counts a clean ai record the same way — the poisoned test's positive twin", async () => {
    const clean = JSON.stringify({ points: 10, at: "2026-08-22T10:00:00Z" });
    mockStore({
      perLogin: {
        alice: { aiSolves: { c1: clean }, aiAttempts: { c1: attempt(1) } },
      },
      aiPoints: { alice: 10 },
    });
    const m = await computeEventMetrics();
    const c1 = m.challenges.find((c) => c.module === "ai" && c.id === "c1");
    expect(c1?.solves).toBe(1);
    expect(c1?.attempts).toBe(1);
  });
});

describe("challengesToCsv carries the ai module column", () => {
  it("emits an ai row with its module value", () => {
    const metrics = {
      challenges: [
        {
          module: "ai",
          id: "a1",
          title: "Guardrail bypass",
          solves: 1,
          attempts: 2,
          solveRate: 0.5,
          avgAttemptsToSolve: 2,
          medianSecondsToSolve: 30,
          solvedAfterHint: 0,
        },
      ],
    } as EventMetrics;
    const lines = challengesToCsv(metrics).trim().split("\n");
    expect(lines[1]).toBe("ai,a1,Guardrail bypass,1,2,0.5000,2.00,30");
  });
});

// --- Secure Development points in team totals (issue #432) ------------------
//
// Found on the live box: every team's points on the Insights tab read lower
// than its members added up to on the leaderboard, and the shortfall was
// exactly each team's Secure Development points — the fold summed quiz +
// classic + ai and nothing else, while three lines earlier the funnel counted
// an SD-only contestant as having scored, and the caveat under the table said
// SD "contributes to participation and points". A team's row has to agree
// with the sentence printed beneath it.
describe("team points include Secure Development (issue #432)", () => {
  it("reports a team whose only points are Secure Development, not 0", async () => {
    mockStore({
      sdKeys: { "ctf:solves:dvwa": { "alice:c1": "2026-08-22T10:00:00Z" } },
      sdPoints: { alice: 25 },
      logins: ["alice"],
      perLogin: { alice: {} },
    });
    const m = await computeEventMetrics();
    expect(m.teams).toEqual([{ slug: "all", name: "All", size: 1, points: 25 }]);
  });

  it("adds Secure Development to the module points, per member", async () => {
    mockStore({
      quizPoints: { alice: 100, bob: 50 },
      classicPoints: { alice: 200 },
      aiPoints: { bob: 75 },
      sdPoints: { alice: 36, bob: 22 },
      logins: ["alice", "bob"],
      perLogin: { alice: {}, bob: {} },
    });
    const m = await computeEventMetrics();
    // (100 + 200 + 36) + (50 + 75 + 22)
    expect(m.teams[0].points).toBe(483);
  });

  // The scorer records the PR author's own spelling; the team roster holds
  // the session's. Every login join in this repo lowercases both sides.
  it("joins the source's login case-insensitively", async () => {
    mockStore({
      sdPoints: { Alice: 10 },
      logins: ["alice"],
      perLogin: { alice: {} },
    });
    const m = await computeEventMetrics();
    expect(m.teams[0].points).toBe(10);
  });

  // Same direction as the solves sweep above it: a scorer that cannot be
  // reached costs the SD share of the totals and SAYS so — it never costs the
  // organizer the whole panel.
  it("degrades to module points with a caveat when the source read fails", async () => {
    mockStore({
      quizPoints: { alice: 100 },
      sourceFails: true,
      logins: ["alice"],
      perLogin: { alice: {} },
    });
    const m = await computeEventMetrics();
    expect(m.teams[0].points).toBe(100);
    expect(m.caveats.some((c) => /Secure Development points could not be read/.test(c))).toBe(true);
  });

  // "mock" is the board's placeholder data behind an amber banner. Folding it
  // into team totals here would put invented points on a screen with no
  // banner, so the store leaves them out and names the reason instead.
  it("leaves placeholder scorer data out, with a caveat, in mock mode", async () => {
    mockStore({
      quizPoints: { alice: 100 },
      sdPoints: { alice: 999 },
      sourceMode: "mock",
      logins: ["alice"],
      perLogin: { alice: {} },
    });
    const m = await computeEventMetrics();
    expect(m.teams[0].points).toBe(100);
    expect(m.caveats.some((c) => /placeholder/.test(c))).toBe(true);
  });

  it("reads nothing from the source when the module is off (empty mode)", async () => {
    mockStore({
      quizPoints: { alice: 100 },
      sourceMode: "empty",
      logins: ["alice"],
      perLogin: { alice: {} },
    });
    const m = await computeEventMetrics();
    expect(m.teams[0].points).toBe(100);
    expect(mocks.getLeaderboard).not.toHaveBeenCalled();
  });
});
