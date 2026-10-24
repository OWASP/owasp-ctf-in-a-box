// The projector feed's two contracts (#542):
//
//   1. The WRITE is fail-open and stores the team captured then — never a
//      login, never a later rename.
//   2. The READ is a field-by-field public projection: a hidden module,
//      deleted item, disabled target or locked classic story step is DROPPED,
//      not redacted, and a failed Redis read throws for the route to 503.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_SOLVES_DATA_KEY,
  RECENT_SOLVES_KEY,
  RECENT_SOLVES_MAX,
} from "@/lib/recent-solves-keys";

const mocks = vi.hoisted(() => ({
  getViewerTeam: vi.fn(),
  upstashEval: vi.fn(),
  upstashPipeline: vi.fn(),
  isModuleLive: vi.fn<(id: string) => Promise<boolean>>(),
  listChallenges: vi.fn(),
  listStories: vi.fn(),
  listQuestions: vi.fn(),
  listAiChallenges: vi.fn(),
  getChallengeCatalog: vi.fn(),
  getEnabledApps: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/team-store", () => ({ getViewerTeam: mocks.getViewerTeam }));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval, upstashPipeline: mocks.upstashPipeline }));
vi.mock("@/lib/enabled-modules", () => ({ isModuleLive: mocks.isModuleLive }));
vi.mock("@/lib/classic-store", () => ({
  listChallenges: mocks.listChallenges,
  listStories: mocks.listStories,
}));
vi.mock("@/lib/quiz-store", () => ({ listQuestions: mocks.listQuestions }));
vi.mock("@/lib/ai-store", () => ({ listAiChallenges: mocks.listAiChallenges }));
vi.mock("@/lib/challenges", () => ({ getChallengeCatalog: mocks.getChallengeCatalog }));
vi.mock("@/lib/enabled-apps", () => ({ getEnabledApps: mocks.getEnabledApps }));

import { listRecentSolves, recordRecentSolve } from "@/lib/recent-solves";

const T = "2026-08-24T10:00:00.000Z";

type Event = {
  module: "classic" | "quiz" | "ai" | "secure-development";
  app?: string;
  challengeId: string;
  points: number;
  team: string;
  teamName: string;
  at: string;
};

const stored = (over: Partial<Event> = {}): Event => ({
  module: "classic",
  challengeId: "c1",
  points: 50,
  team: "red",
  teamName: "Red Team",
  at: T,
  ...over,
});

/** Feed ids in stored order + their raw hash values. */
function readReturns(rows: [id: string, event: unknown][]) {
  mocks.upstashPipeline.mockImplementation(async (commands: string[][]) => {
    if (commands[0][0] === "ZREVRANGE") {
      // Honor the range so a read that asks for only `limit` entries really
      // returns only those; otherwise a hidden-entry bug cannot be observed.
      const start = Number(commands[0][2]);
      const stop = Number(commands[0][3]);
      const ids = rows.map(([id]) => id);
      const end = stop < 0 ? ids.length + stop : stop;
      return [{ result: ids.slice(start, end + 1) }];
    }
    if (commands[0][0] === "HMGET") {
      const ids = commands[0].slice(2);
      return [{ result: ids.map((id) => rows.find(([rowId]) => rowId === id)?.[1] ?? null) }];
    }
    throw new Error(`unexpected command ${commands[0][0]}`);
  });
}

function readDefaults() {
  mocks.isModuleLive.mockResolvedValue(true);
  mocks.listChallenges.mockResolvedValue([{ id: "c1", title: "Robots Only", points: 50 }]);
  mocks.listStories.mockResolvedValue([]);
  mocks.listQuestions.mockResolvedValue([{ id: "q1", prompt: "What is XSS?", points: 10 }]);
  mocks.listAiChallenges.mockResolvedValue([{ id: "a1", title: "Prompt Leak", points: 20 }]);
  mocks.getChallengeCatalog.mockResolvedValue({
    byApp: {
      dvwa: [{ app: "dvwa", id: "s1", description: "SQL Injection", points: 30 }],
      webgoat: [{ app: "webgoat", id: "w1", description: "Disabled target", points: 40 }],
    },
    total: 2,
  });
  mocks.getEnabledApps.mockResolvedValue([{ id: "dvwa" }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  readDefaults();
  mocks.getViewerTeam.mockResolvedValue({ slug: "red", name: "Red Team", members: ["alice"] });
  mocks.upstashEval.mockResolvedValue({ result: 1 });
});

describe("recordRecentSolve", () => {
  it("stores the team captured now, with no login in the event", async () => {
    await recordRecentSolve({ module: "classic", challengeId: "c1", points: 50, login: "alice", at: T });
    expect(mocks.upstashEval).toHaveBeenCalledTimes(1);
    const [, keys, args] = mocks.upstashEval.mock.calls[0];
    expect(keys).toEqual([RECENT_SOLVES_KEY, RECENT_SOLVES_DATA_KEY]);
    expect(args[0]).toBe("classic:-:c1:red");
    expect(args[1]).toBe(String(Date.parse(T)));
    expect(args[3]).toBe(String(RECENT_SOLVES_MAX));
    const event = JSON.parse(String(args[2]));
    expect(event).toEqual({
      module: "classic",
      challengeId: "c1",
      points: 50,
      team: "red",
      teamName: "Red Team",
      at: T,
    });
    expect(JSON.stringify(event)).not.toContain("alice");
  });

  it("writes no line for a teamless solve", async () => {
    mocks.getViewerTeam.mockResolvedValue(null);
    await recordRecentSolve({ module: "quiz", challengeId: "q1", points: 10, login: "alice" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("resolves at the write timeout even when the store hangs", async () => {
    vi.useFakeTimers();
    try {
      mocks.upstashEval.mockReturnValue(new Promise(() => {}));
      const pending = recordRecentSolve({ module: "classic", challengeId: "c1", points: 50, login: "alice" });
      await vi.advanceTimersByTimeAsync(1500);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the deadline before a slow team lookup and never writes after it", async () => {
    vi.useFakeTimers();
    try {
      mocks.getViewerTeam.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ slug: "red", name: "Red Team", members: ["alice"] }), 5000),
          ),
      );
      let settled = false;
      const pending = recordRecentSolve({
        module: "classic",
        challengeId: "c1",
        points: 50,
        login: "alice",
      }).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeUndefined();
      expect(settled).toBe(true);

      // The lookup may finish later; the expired operation must not write.
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.upstashEval).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a team lookup rejection that arrives after the deadline", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let rejectTeam: (err: Error) => void = () => {};
      mocks.getViewerTeam.mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectTeam = reject;
          }),
      );
      const pending = recordRecentSolve({
        module: "classic",
        challengeId: "c1",
        points: 50,
        login: "alice",
      });
      await vi.advanceTimersByTimeAsync(1500);
      await expect(pending).resolves.toBeUndefined();

      rejectTeam(new Error("late team read failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("fails open when the team read or the write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.getViewerTeam.mockRejectedValueOnce(new Error("redis down"));
      await expect(
        recordRecentSolve({ module: "classic", challengeId: "c1", points: 50, login: "alice" }),
      ).resolves.toBeUndefined();

      mocks.upstashEval.mockRejectedValueOnce(new Error("redis down"));
      await expect(
        recordRecentSolve({ module: "classic", challengeId: "c1", points: 50, login: "alice" }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("listRecentSolves", () => {
  it("resolves current public titles and drops deleted, disabled and malformed lines", async () => {
    readReturns([
      ["classic:-:c1:red", JSON.stringify(stored())],
      ["classic:-:gone:red", JSON.stringify(stored({ challengeId: "gone" }))],
      ["quiz:-:q1:red", JSON.stringify(stored({ module: "quiz", challengeId: "q1", points: 10 }))],
      ["ai:-:a1:red", JSON.stringify(stored({ module: "ai", challengeId: "a1", points: 20 }))],
      [
        "secure-development:dvwa:s1:red",
        JSON.stringify(
          stored({ module: "secure-development", app: "dvwa", challengeId: "s1", points: 30 }),
        ),
      ],
      [
        "secure-development:webgoat:w1:red",
        JSON.stringify(
          stored({ module: "secure-development", app: "webgoat", challengeId: "w1", points: 40 }),
        ),
      ],
      ["classic:-:bad:red", "{not json"],
    ]);

    expect(await listRecentSolves()).toEqual([
      { team: "Red Team", title: "Robots Only", module: "classic", points: 50, at: T },
      { team: "Red Team", title: "What is XSS?", module: "quiz", points: 10, at: T },
      { team: "Red Team", title: "Prompt Leak", module: "ai", points: 20, at: T },
      { team: "Red Team", title: "SQL Injection", module: "secure-development", points: 30, at: T },
    ]);
    // No stored slug/login/id leaks through the projection.
    const body = JSON.stringify(await listRecentSolves());
    for (const secret of ["red", "alice", "c1", "dvwa", "s1"]) expect(body).not.toContain(secret);
  });

  it("drops classic story steps beyond the first for an anonymous projector", async () => {
    mocks.listChallenges.mockResolvedValue([
      { id: "c1", title: "Step One", points: 10 },
      { id: "c2", title: "Hidden Step Two", points: 20 },
    ]);
    mocks.listStories.mockResolvedValue([{ id: "s", title: "Story", intro: "", steps: ["c1", "c2"] }]);
    readReturns([
      ["classic:-:c2:red", JSON.stringify(stored({ challengeId: "c2", points: 20 }))],
      ["classic:-:c1:red", JSON.stringify(stored({ challengeId: "c1", points: 10 }))],
    ]);

    const out = await listRecentSolves();
    expect(out).toEqual([{ team: "Red Team", title: "Step One", module: "classic", points: 10, at: T }]);
    expect(JSON.stringify(out)).not.toContain("Hidden Step Two");
    expect(out.map((item) => item.points)).not.toContain(20);
  });

  it("does not let hidden newest lines consume the projector's slots", async () => {
    mocks.listChallenges.mockResolvedValue([
      { id: "step1", title: "Step One", points: 10 },
      { id: "step2", title: "Locked Two", points: 20 },
      { id: "step3", title: "Locked Three", points: 30 },
    ]);
    mocks.listStories.mockResolvedValue([{ id: "s", title: "Story", intro: "", steps: ["step1", "step2", "step3"] }]);
    mocks.listQuestions.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({ id: `q${i + 1}`, prompt: `Question ${i + 1}`, points: 10 })),
    );
    const quizRows = Array.from(
      { length: 6 },
      (_, i): [string, string] => [
        `quiz:-:q${i + 1}:red`,
        JSON.stringify(stored({ module: "quiz", challengeId: `q${i + 1}`, points: 10 })),
      ],
    );
    readReturns([
      // Newest three are ineligible: two locked story steps and a deleted
      // challenge. They must not displace the five visible quiz solves.
      ["classic:-:step2:red", JSON.stringify(stored({ challengeId: "step2", points: 20 }))],
      ["classic:-:step3:blue", JSON.stringify(stored({ challengeId: "step3", points: 30, team: "blue" }))],
      ["classic:-:gone:red", JSON.stringify(stored({ challengeId: "gone" }))],
      ...quizRows,
    ]);

    const out = await listRecentSolves();
    expect(out.map((item) => item.title)).toEqual([
      "Question 1",
      "Question 2",
      "Question 3",
      "Question 4",
      "Question 5",
    ]);
    expect(JSON.stringify(out)).not.toContain("Locked");
    const [commands] = mocks.upstashPipeline.mock.calls[0];
    expect(commands[0]).toEqual(["ZREVRANGE", RECENT_SOLVES_KEY, 0, RECENT_SOLVES_MAX - 1]);
  });

  it("drops every line whose module is switched off", async () => {
    mocks.isModuleLive.mockImplementation(async (id: string) => id === "quiz");
    readReturns([
      ["classic:-:c1:red", JSON.stringify(stored())],
      ["quiz:-:q1:red", JSON.stringify(stored({ module: "quiz", challengeId: "q1", points: 10 }))],
    ]);

    expect(await listRecentSolves()).toEqual([
      { team: "Red Team", title: "What is XSS?", module: "quiz", points: 10, at: T },
    ]);
  });

  it("throws on a failed sorted-set or hash read, so the route can 503", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    await expect(listRecentSolves()).rejects.toThrow("recent solves read failed");

    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: ["classic:-:c1:red"] }])
      .mockResolvedValueOnce([{ error: "NOAUTH" }]);
    await expect(listRecentSolves()).rejects.toThrow("recent solves read failed");
  });

  it("reads the bounded retained window and never asks for zero", async () => {
    readReturns([]);
    expect(await listRecentSolves(0)).toEqual([]);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();

    readReturns([]);
    await listRecentSolves();
    expect(mocks.upstashPipeline.mock.calls[0][0][0]).toEqual([
      "ZREVRANGE",
      RECENT_SOLVES_KEY,
      0,
      RECENT_SOLVES_MAX - 1,
    ]);

    mocks.upstashPipeline.mockClear();
    readReturns([]);
    await listRecentSolves(999);
    expect(mocks.upstashPipeline.mock.calls[0][0][0]).toEqual([
      "ZREVRANGE",
      RECENT_SOLVES_KEY,
      0,
      RECENT_SOLVES_MAX - 1,
    ]);
  });
});
