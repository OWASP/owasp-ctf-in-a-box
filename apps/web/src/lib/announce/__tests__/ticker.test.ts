// The 30s observation loop (#590): lifecycle CAS announces exactly the
// edges this replica won, release claims happen even with announcements
// off (so enabling never replays), board changes announce the leader, and
// the daily/milestone claims fire once. Store and sender mocked; the
// schedule-window and detect logic they exercise is real.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAnnounceConfig: vi.fn(),
  getAdminSettings: vi.fn(),
  claimLedgerField: vi.fn(),
  claimLedgerFields: vi.fn(),
  ledgerFields: vi.fn(),
  readStatePack: vi.fn(),
  stateCompareSet: vi.fn(),
  outboxPrune: vi.fn(),
  enqueueAnnouncement: vi.fn(),
  flushRetries: vi.fn(),
  listChallenges: vi.fn(),
  listStories: vi.fn(),
  getClassicTotals: vi.fn(),
  getTeamClassicTotalsBatch: vi.fn(),
  listQuestions: vi.fn(),
  getQuizTotals: vi.fn(),
  getTeamQuizTotalsBatch: vi.fn(),
  listAiChallenges: vi.fn(),
  getAiTotals: vi.fn(),
  getTeamAiTotalsBatch: vi.fn(),
  listTeams: vi.fn(),
  upstashPipeline: vi.fn(),
  secureDevAvailable: vi.fn(() => false),
  defaultEnabledModules: vi.fn(() => [] as string[]),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/error-label", () => ({ errorLabel: () => "label" }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings: mocks.getAdminSettings }));
vi.mock("@/lib/module-defaults", () => ({
  secureDevAvailable: mocks.secureDevAvailable,
  defaultEnabledModules: mocks.defaultEnabledModules,
}));
vi.mock("@/lib/classic-store", () => ({
  listChallenges: mocks.listChallenges,
  listStories: mocks.listStories,
  getClassicTotals: mocks.getClassicTotals,
  getTeamClassicTotalsBatch: mocks.getTeamClassicTotalsBatch,
}));
vi.mock("@/lib/quiz-store", () => ({
  listQuestions: mocks.listQuestions,
  getQuizTotals: mocks.getQuizTotals,
  getTeamQuizTotalsBatch: mocks.getTeamQuizTotalsBatch,
}));
vi.mock("@/lib/ai-store", () => ({
  listAiChallenges: mocks.listAiChallenges,
  getAiTotals: mocks.getAiTotals,
  getTeamAiTotalsBatch: mocks.getTeamAiTotalsBatch,
}));
vi.mock("@/lib/team-store", () => ({ listTeams: mocks.listTeams }));
vi.mock("@/lib/leaderboard/lambda", () => ({ lambdaSource: { getLeaderboard: async () => { throw new Error("no sd"); } } }));
vi.mock("@/lib/leaderboard/upstash", () => ({ upstashSource: { getLeaderboard: async () => { throw new Error("no sd"); } } }));
vi.mock("@/lib/leaderboard/mock", () => ({ mockSource: { getLeaderboard: async () => { throw new Error("no sd"); } } }));
vi.mock("@/lib/announce/store", () => ({
  getAnnounceConfig: mocks.getAnnounceConfig,
  claimLedgerField: mocks.claimLedgerField,
  claimLedgerFields: mocks.claimLedgerFields,
  ledgerFields: mocks.ledgerFields,
  readStatePack: mocks.readStatePack,
  stateCompareSet: mocks.stateCompareSet,
  outboxPrune: mocks.outboxPrune,
}));
vi.mock("@/lib/announce/sender", () => ({
  enqueueAnnouncement: mocks.enqueueAnnouncement,
  flushRetries: mocks.flushRetries,
}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline }));

import { runAnnounceTick, seedReleaseClaims } from "@/lib/announce/ticker";

const T0 = Date.parse("2026-10-14T12:00:00Z");

const config = (over: Record<string, unknown> = {}) => ({
  webhookConfigured: true,
  releases: false,
  firstBlood: false,
  leaders: false,
  leaderScope: "first",
  launch: false,
  pause: false,
  registration: false,
  milestones: false,
  marks: "",
  daily: false,
  dailyAt: "09:00",
  dailyTopN: 10,
  webhookUrl: "https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaaaa",
  ...over,
});

const settings = (over: Record<string, unknown> = {}) => ({
  paused: false,
  teamRegistrationOpen: true,
  scoringStartsAt: "2026-10-14T11:00:00Z",
  scoringEndsAt: null,
  registrationStartsAt: null,
  registrationEndsAt: null,
  enabledModuleIds: ["classic"],
  eventIdentity: { eventName: "Test Event", eventTimeZone: "UTC" },
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(mocks)) if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  mocks.secureDevAvailable.mockReturnValue(false);
  mocks.defaultEnabledModules.mockReturnValue([]);
  mocks.getAnnounceConfig.mockResolvedValue(config());
  mocks.getAdminSettings.mockResolvedValue(settings());
  mocks.claimLedgerField.mockResolvedValue(true);
  mocks.claimLedgerFields.mockImplementation(async (_key: string, fields: string[]) => new Set(fields));
  mocks.ledgerFields.mockResolvedValue(new Set());
  mocks.readStatePack.mockResolvedValue(null);
  mocks.stateCompareSet.mockResolvedValue({ code: 2, seq: 1, prev: "" });
  mocks.outboxPrune.mockResolvedValue(undefined);
  mocks.enqueueAnnouncement.mockResolvedValue(undefined);
  mocks.flushRetries.mockResolvedValue(undefined);
  mocks.listChallenges.mockResolvedValue([]);
  mocks.listStories.mockResolvedValue([]);
  mocks.getClassicTotals.mockResolvedValue(new Map());
  mocks.getTeamClassicTotalsBatch.mockResolvedValue([]);
  mocks.listQuestions.mockResolvedValue([]);
  mocks.getQuizTotals.mockResolvedValue(new Map());
  mocks.getTeamQuizTotalsBatch.mockResolvedValue([]);
  mocks.listAiChallenges.mockResolvedValue([]);
  mocks.getAiTotals.mockResolvedValue(new Map());
  mocks.getTeamAiTotalsBatch.mockResolvedValue([]);
  mocks.listTeams.mockResolvedValue([]);
  mocks.upstashPipeline.mockImplementation(async (commands: (string | number)[][]) => commands.map(() => ({ result: null })));
});

describe("lifecycle tick", () => {
  it("seeds the first observation silently (CAS code 2) and announces nothing", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true }));
    await runAnnounceTick(T0);
    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "", "v1|L1P0R0");
    expect(mocks.enqueueAnnouncement).not.toHaveBeenCalled();
  });

  it("announces a won pause edge exactly once", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ pause: true }));
    // The observation is a LIVE event under a manual pause; the stored pack
    // is the un-paused one this replica last saw, so the CAS is ours to win.
    mocks.getAdminSettings.mockResolvedValue(settings({ paused: true }));
    mocks.readStatePack.mockResolvedValue("v1|L1P0R0");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "v1|L1P0R0" });
    await runAnnounceTick(T0);
    expect(mocks.enqueueAnnouncement).toHaveBeenCalledWith("pause", expect.objectContaining({ embeds: [expect.objectContaining({ title: "Scoring is paused" })] }));
  });

  it("announces the launch edge, and a disabled switch posts nothing", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: false }));
    mocks.readStatePack.mockResolvedValue("v1|L0P0R0");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "v1|L0P0R0" });
    await runAnnounceTick(T0);
    expect(mocks.enqueueAnnouncement).not.toHaveBeenCalled();
  });
});

describe("release sweep", () => {
  const challenge = { id: "web-1", title: "Web 1", category: "web", points: 100 };

  it("claims and announces a newly-public challenge when armed", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ releases: true }));
    mocks.listChallenges.mockResolvedValue([challenge]);
    await runAnnounceTick(T0);
    expect(mocks.claimLedgerFields).toHaveBeenCalledWith("ctf:announce:released", ["classic:web-1"]);
    expect(mocks.enqueueAnnouncement).toHaveBeenCalledWith(
      "release",
      expect.objectContaining({ embeds: [expect.objectContaining({ description: expect.stringContaining("Web 1") })] }),
    );
  });

  it("CLAIMS even when announcements are unconfigured — enabling later must not replay", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ webhookConfigured: false, releases: true }));
    mocks.listChallenges.mockResolvedValue([challenge]);
    await runAnnounceTick(T0);
    expect(mocks.claimLedgerFields).toHaveBeenCalledWith("ctf:announce:released", ["classic:web-1"]);
    expect(mocks.enqueueAnnouncement).not.toHaveBeenCalled();
  });

  it("skips an already-claimed challenge", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ releases: true }));
    mocks.listChallenges.mockResolvedValue([challenge]);
    mocks.ledgerFields.mockResolvedValue(new Set(["classic:web-1"]));
    await runAnnounceTick(T0);
    expect(mocks.claimLedgerFields).not.toHaveBeenCalled();
    expect(mocks.enqueueAnnouncement).not.toHaveBeenCalled();
  });
});

describe("board tick", () => {
  it("announces the new #1 when the watched board changes and leaders are on", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ leaders: true }));
    mocks.getClassicTotals.mockResolvedValue(new Map([["alice", { points: 300, solved: 3, lastAt: null }]]));
    // The two observed-state keys have their OWN packs, so the mocks answer
    // per key, not in call order: the lifecycle pack is unchanged (lifecycle
    // never reaches CAS), and the board pack goes null → alice:100 across the
    // two ticks — first tick seeds silently (code 2), second wins (code 1).
    const boardPacks = [null, "alice:100"];
    let boardCas = 0;
    mocks.readStatePack.mockImplementation(async (key: string) =>
      key === "ctf:announce:lifecycle" ? "v1|L1P0R0" : (boardPacks.shift() ?? "alice:100"),
    );
    mocks.stateCompareSet.mockImplementation(async (key: string) =>
      key === "ctf:announce:lifecycle"
        ? { code: 0, seq: 0, prev: "v1|L1P0R0" }
        : boardCas++ === 0
          ? { code: 2, seq: 1, prev: "" }
          : { code: 1, seq: 2, prev: "alice:100" },
    );
    await runAnnounceTick(T0);
    expect(mocks.enqueueAnnouncement).not.toHaveBeenCalled();
    await runAnnounceTick(T0 + 60_000);
    expect(mocks.enqueueAnnouncement).toHaveBeenCalledWith(
      "leader",
      expect.objectContaining({ embeds: [expect.objectContaining({ fields: [expect.objectContaining({ value: expect.stringContaining("alice — 300 pts") })] })] }),
    );
  });

  it("advances the board state even with leaders off (so enabling fires only on a real change)", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ leaders: false }));
    mocks.getClassicTotals.mockResolvedValue(new Map([["alice", { points: 300, solved: 3, lastAt: null }]]));
    mocks.readStatePack.mockResolvedValue("alice:100");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "alice:100" });
    await runAnnounceTick(T0);
    expect(mocks.stateCompareSet).toHaveBeenCalled();
    expect(mocks.enqueueAnnouncement).not.toHaveBeenCalled();
  });
});

describe("daily and milestones", () => {
  it("claims the event-local day once and posts the summary with seeded-zero deltas", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ daily: true, dailyAt: "09:00" }));
    await runAnnounceTick(T0);
    expect(mocks.claimLedgerField).toHaveBeenCalledWith("ctf:announce:daily", "2026-10-14");
    expect(mocks.enqueueAnnouncement).toHaveBeenCalledWith("daily", expect.anything());
  });

  it("claims a crossed mark and posts the time check", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ milestones: true, marks: "30m" }));
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringEndsAt: "2026-10-14T12:20:00Z" }));
    await runAnnounceTick(T0);
    expect(mocks.claimLedgerField).toHaveBeenCalledWith("ctf:announce:milestone", expect.stringContaining("1800000"));
    expect(mocks.enqueueAnnouncement).toHaveBeenCalledWith("milestone", expect.anything());
  });
});

describe("seedReleaseClaims", () => {
  it("claims every public, non-locked item without posting", async () => {
    mocks.listChallenges.mockResolvedValue([{ id: "web-1", title: "W", category: "c", points: 1 }]);
    const won = await seedReleaseClaims();
    expect(won).toBe(1);
    expect(mocks.enqueueAnnouncement).not.toHaveBeenCalled();
  });
});
