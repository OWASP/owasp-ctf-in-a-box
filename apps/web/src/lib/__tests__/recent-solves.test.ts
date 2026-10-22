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
    if (commands[0][0] === "ZREVRANGE") return [{ result: rows.map(([id]) => id) }];
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

  it("bounds the read to the requested limit and never asks for zero", async () => {
    readReturns([]);
    expect(await listRecentSolves(0)).toEqual([]);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();

    readReturns([]);
    await listRecentSolves(999);
    const [commands] = mocks.upstashPipeline.mock.calls[0];
    expect(commands[0]).toEqual(["ZREVRANGE", RECENT_SOLVES_KEY, 0, RECENT_SOLVES_MAX - 1]);
  });
});
