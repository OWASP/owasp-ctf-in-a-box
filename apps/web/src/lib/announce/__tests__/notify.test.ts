// First-blood notify (#590): gate-BEFORE-claim (an unconfigured box must
// not consume the claim), claim-once, the ADR 60 story-lock secrecy gate,
// team-name resolution and the message the sender receives. Store, sender,
// team-store and the module lists are mocked; story-lock itself is real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAnnounceConfig: vi.fn(),
  readLedgerField: vi.fn(),
  enqueueLedgerAnnouncement: vi.fn(),
  listTeams: vi.fn(),
  readChallengeRecords: vi.fn(),
  listStories: vi.fn(),
  listQuestions: vi.fn(),
  listAiChallenges: vi.fn(),
  getPlayerProfiles: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/error-label", () => ({ errorLabel: () => "label" }));
vi.mock("@/lib/announce/store", () => ({
  getAnnounceConfig: mocks.getAnnounceConfig,
  readLedgerField: mocks.readLedgerField,
}));
vi.mock("@/lib/announce/sender", () => ({ enqueueLedgerAnnouncement: mocks.enqueueLedgerAnnouncement }));
vi.mock("@/lib/player", () => ({ getPlayerProfiles: mocks.getPlayerProfiles }));
vi.mock("@/lib/team-store", () => ({ listTeams: mocks.listTeams }));
vi.mock("@/lib/classic-store", () => ({ readChallengeRecords: mocks.readChallengeRecords, listStories: mocks.listStories }));
vi.mock("@/lib/quiz-store", () => ({ listQuestions: mocks.listQuestions }));
vi.mock("@/lib/ai-store", () => ({ listAiChallenges: mocks.listAiChallenges }));

import { challengeEmbedUrl, notifyFirstBlood } from "@/lib/announce/notify";

const armed = {
  webhookConfigured: true,
  firstBlood: true,
  webhookGeneration: 0,
  kindEpochs: { "first-blood": 0, launch: 0, pause: 0, resume: 0, milestone: 0 },
};
const origAuthUrl = process.env.BETTER_AUTH_URL;

beforeEach(() => {
  process.env.BETTER_AUTH_URL = "https://ctf.example.com";
  mocks.getAnnounceConfig.mockReset().mockResolvedValue(armed);
  mocks.readLedgerField.mockReset().mockResolvedValue(JSON.stringify({ playerId: "alice", at: "2026-10-14T12:00:00Z" }));
  mocks.enqueueLedgerAnnouncement.mockReset().mockResolvedValue(true);
  mocks.listTeams.mockReset().mockResolvedValue([{ slug: "t1", name: "Team One", members: ["alice"] }]);
  mocks.getPlayerProfiles.mockReset().mockResolvedValue(new Map());
  mocks.readChallengeRecords.mockReset().mockResolvedValue([{ id: "web-1", title: "Web 1", category: "web", points: 100 }]);
  mocks.listStories.mockReset().mockResolvedValue([]);
  mocks.listQuestions.mockReset().mockResolvedValue([]);
  mocks.listAiChallenges.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  if (origAuthUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = origAuthUrl;
});

describe("notifyFirstBlood", () => {
  it("does NOT claim when unconfigured or the switch is off (enabling later must not replay)", async () => {
    mocks.getAnnounceConfig.mockResolvedValue({ ...armed, webhookConfigured: false });
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", playerId: "alice" });
    expect(mocks.readLedgerField).not.toHaveBeenCalled();

    mocks.getAnnounceConfig.mockResolvedValue({ ...armed, firstBlood: false });
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", playerId: "alice" });
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
  });

  it("claims first, and posts only the winner", async () => {
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", playerId: "alice" });
    expect(mocks.readLedgerField).toHaveBeenCalledWith("ctf:announce:first", "classic:web-1");
    expect(mocks.enqueueLedgerAnnouncement).toHaveBeenCalledTimes(1);
    const [kind, msg, ledger, fields, captured] = mocks.enqueueLedgerAnnouncement.mock.calls[0];
    expect(kind).toBe("first-blood");
    expect(ledger).toBe("ctf:announce:first-announced");
    expect(fields).toEqual(["classic:web-1"]);
    expect(captured).toEqual({ webhookGeneration: 0, kindEpoch: 0 });
    expect(JSON.stringify(msg)).toContain("Web 1");
  });

  it("does NOT post when another player is the recorded first solver", async () => {
    mocks.readLedgerField.mockResolvedValue(JSON.stringify({ playerId: "bob", at: "2026-10-14T12:00:00Z" }));
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", playerId: "alice" });
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
  });

  it("does NOT post when the first-solver record is missing or unreadable", async () => {
    mocks.readLedgerField.mockResolvedValue(null);
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", playerId: "alice" });
    mocks.readLedgerField.mockResolvedValue("not-json");
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", playerId: "alice" });
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
  });

  it("displays the TEAM name via a player-id membership join", async () => {
    mocks.listTeams.mockResolvedValue([{ slug: "t1", name: "Team One", members: ["alice"] }]);
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", playerId: "alice" });
    const msg = mocks.enqueueLedgerAnnouncement.mock.calls[0][1] as { embeds: { description?: string }[] };
    expect(msg.embeds[0].description).toContain("Team One");
  });

  it("withholds a classic challenge that vanished after the solve — a deleted step must not leak its id", async () => {
    // The award named alice first; between that award and this lookup the
    // organizer deleted the record. With no record there is nothing for
    // `storyPositions` to place, so the lock gate could never run — the
    // bare id and its /flags/ URL are exactly what the board redacts.
    mocks.readChallengeRecords.mockResolvedValue([]);
    await notifyFirstBlood({ module: "classic", challengeId: "gone-1", playerId: "alice" });
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
  });

  it("falls back to the display name and to the (escaped) id for a vanished quiz/ai item", async () => {
    mocks.listTeams.mockResolvedValue([]);
    mocks.getPlayerProfiles.mockResolvedValue(
      new Map([["alice", { id: "alice", name: "Alice Display", image: null, githubLogin: "alice" }]]),
    );
    mocks.listQuestions.mockResolvedValue([]);
    await notifyFirstBlood({ module: "quiz", challengeId: "q-missing", playerId: "alice" });
    const msg = mocks.enqueueLedgerAnnouncement.mock.calls[0][1] as { embeds: { description?: string }[] };
    expect(msg.embeds[0].description).toContain("Alice Display");
    // The id is escaped like any other untrusted text — `-` is Markdown.
    expect(msg.embeds[0].description).toContain("q\\-missing");
  });

  it("fails open to the bare id and 0 points when the quiz/ai list read rejects", async () => {
    mocks.listQuestions.mockRejectedValue(new Error("redis down"));
    mocks.listAiChallenges.mockRejectedValue(new Error("redis down"));
    await notifyFirstBlood({ module: "quiz", challengeId: "qmissing", playerId: "alice" });
    await notifyFirstBlood({ module: "ai", challengeId: "aimissing", playerId: "alice" });

    expect(mocks.enqueueLedgerAnnouncement).toHaveBeenCalledTimes(2);
    const ids = ["qmissing", "aimissing"];
    for (const [index, id] of ids.entries()) {
      const msg = mocks.enqueueLedgerAnnouncement.mock.calls[index][1] as {
        embeds: { description?: string; fields?: { name: string; value: string }[] }[];
      };
      expect(msg.embeds[0].description).toContain(id);
      expect(msg.embeds[0].fields).toEqual([{ name: "Points", value: "0", inline: true }]);
    }
  });

  it("never announces a HIDDEN challenge — returns without claiming or enqueueing", async () => {
    mocks.readChallengeRecords.mockResolvedValue([{ id: "web-9", title: "Secret Unreleased Title", category: "web", points: 100, enabled: false }]);
    await notifyFirstBlood({ module: "classic", challengeId: "web-9", playerId: "alice" });
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
  });

  it("returns without claiming or enqueueing when a classic challenge has a future releaseAt", async () => {
    mocks.readChallengeRecords.mockResolvedValue([
      { id: "web-future", title: "Future Challenge", category: "web", points: 100, enabled: false, releaseAt: "2099-01-01T00:00:00Z" },
    ]);
    await notifyFirstBlood({ module: "classic", challengeId: "web-future", playerId: "alice" });
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
  });

  it("fails closed on a per-command HGETALL read error — no claim, no post, no throw", async () => {
    mocks.readChallengeRecords.mockRejectedValue(new Error("Upstash HGETALL failed: ERR command error"));
    await expect(notifyFirstBlood({ module: "classic", challengeId: "web-1", playerId: "alice" })).resolves.toBeUndefined();
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
  });

  it("omits the embed url entirely when BETTER_AUTH_URL is missing or invalid", async () => {
    mocks.listQuestions.mockResolvedValue([{ id: "q1", prompt: "Q?", points: 10 }]);

    delete process.env.BETTER_AUTH_URL;
    await notifyFirstBlood({ module: "quiz", challengeId: "q1", playerId: "alice" });
    let msg = mocks.enqueueLedgerAnnouncement.mock.calls[0][1] as { embeds: Record<string, unknown>[] };
    expect("url" in msg.embeds[0]).toBe(false);

    mocks.enqueueLedgerAnnouncement.mockClear();
    process.env.BETTER_AUTH_URL = "not-a-valid-url";
    await notifyFirstBlood({ module: "quiz", challengeId: "q1", playerId: "alice" });
    msg = mocks.enqueueLedgerAnnouncement.mock.calls[0][1] as { embeds: Record<string, unknown>[] };
    expect("url" in msg.embeds[0]).toBe(false);

    mocks.enqueueLedgerAnnouncement.mockClear();
    process.env.BETTER_AUTH_URL = "ftp://invalid-scheme.example";
    await notifyFirstBlood({ module: "quiz", challengeId: "q1", playerId: "alice" });
    msg = mocks.enqueueLedgerAnnouncement.mock.calls[0][1] as { embeds: Record<string, unknown>[] };
    expect("url" in msg.embeds[0]).toBe(false);
  });

  it("links the quiz board for quiz (no per-question page) and /ai/<id> for ai", async () => {
    mocks.listQuestions.mockResolvedValue([{ id: "q1", prompt: "Q?", points: 10 }]);
    await notifyFirstBlood({ module: "quiz", challengeId: "q1", playerId: "alice" });
    expect(JSON.stringify(mocks.enqueueLedgerAnnouncement.mock.calls[0][1])).toContain("/quiz");

    mocks.listAiChallenges.mockResolvedValue([{ id: "inj-1", title: "AI 1", category: "ai", points: 50 }]);
    await notifyFirstBlood({ module: "ai", challengeId: "inj-1", playerId: "alice" });
    expect(JSON.stringify(mocks.enqueueLedgerAnnouncement.mock.calls[1][1])).toContain("/ai/inj-1");
  });

  it("never throws, even when the store explodes", async () => {
    mocks.getAnnounceConfig.mockRejectedValue(new Error("redis down"));
    await expect(notifyFirstBlood({ module: "classic", challengeId: "web-1", playerId: "alice" })).resolves.toBeUndefined();
  });
});

describe("story-lock secrecy gate (ADR 60)", () => {
  const story = [{ id: "s1", title: "Story", intro: "", steps: ["web-1", "web-2"] }];
  const both = [
    { id: "web-1", title: "Web 1", category: "web", points: 100 },
    { id: "web-2", title: "Web 2", category: "web", points: 150 },
  ];

  beforeEach(() => {
    mocks.readChallengeRecords.mockResolvedValue(both);
    mocks.listStories.mockResolvedValue(story);
  });

  it("announces step 1 — the board shows it to everyone", async () => {
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", playerId: "alice" });
    expect(mocks.readLedgerField).toHaveBeenCalledWith("ctf:announce:first", "classic:web-1");
    const msg = mocks.enqueueLedgerAnnouncement.mock.calls[0][1] as { embeds: { description?: string }[] };
    expect(msg.embeds[0].description).toContain("Web 1");
  });

  it("withholds the WHOLE post for a later step — title, points AND id", async () => {
    await notifyFirstBlood({ module: "classic", challengeId: "web-2", playerId: "alice" });
    // The first-solver record was read (never a claim this caller spends),
    // and nothing — not even the bare id the board also redacts — reaches
    // the sender.
    expect(mocks.readLedgerField).toHaveBeenCalledWith("ctf:announce:first", "classic:web-2");
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
  });

  it("withholds a story step DELETED between the award and the lookup — its id must not leak", async () => {
    // The record is gone but the story line still names the step. With no
    // record, `visibleNow` cannot show it and `storyPositions` (which only
    // places ids in the visible set) never yields a position — so the lock
    // gate below cannot run and the bare id would otherwise post to every
    // team, including those that never unlocked the step.
    mocks.readChallengeRecords.mockResolvedValue([both[0]]);
    await notifyFirstBlood({ module: "classic", challengeId: "web-2", playerId: "alice" });
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the story line cannot be read — no post, no throw", async () => {
    mocks.listStories.mockRejectedValue(new Error("redis down"));
    await expect(notifyFirstBlood({ module: "classic", challengeId: "web-1", playerId: "alice" })).resolves.toBeUndefined();
    expect(mocks.readLedgerField).toHaveBeenCalled();
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
  });
});

describe("challengeEmbedUrl", () => {
  it("validates BETTER_AUTH_URL as an absolute HTTP(S) URL", () => {
    expect(challengeEmbedUrl("quiz", "q1", "https://ctf.example.com")).toBe("https://ctf.example.com/quiz");
    expect(challengeEmbedUrl("classic", "web-1", "https://ctf.example.com:8443")).toBe("https://ctf.example.com:8443/flags/web-1");
    expect(challengeEmbedUrl("ai", "inj-1", "http://localhost:3000")).toBe("http://localhost:3000/ai/inj-1");
  });

  it("returns undefined when missing or invalid", () => {
    expect(challengeEmbedUrl("classic", "web-1", undefined)).toBeUndefined();
    expect(challengeEmbedUrl("classic", "web-1", "")).toBeUndefined();
    expect(challengeEmbedUrl("classic", "web-1", "not-a-url")).toBeUndefined();
    expect(challengeEmbedUrl("classic", "web-1", "/flags/web-1")).toBeUndefined();
    expect(challengeEmbedUrl("classic", "web-1", "ftp://example.com")).toBeUndefined();
    expect(challengeEmbedUrl("classic", "web-1", "javascript:alert(1)")).toBeUndefined();
  });
});
