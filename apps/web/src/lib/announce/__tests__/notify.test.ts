// First-blood notify (#590): gate-BEFORE-claim (an unconfigured box must
// not consume the claim), claim-once, team-name resolution and the message
// the sender receives. Store, sender, team-store and the module lists are
// mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAnnounceConfig: vi.fn(),
  claimLedgerField: vi.fn(),
  enqueueAnnouncement: vi.fn(),
  listTeams: vi.fn(),
  listChallenges: vi.fn(),
  listQuestions: vi.fn(),
  listAiChallenges: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/error-label", () => ({ errorLabel: () => "label" }));
vi.mock("@/lib/announce/store", () => ({
  getAnnounceConfig: mocks.getAnnounceConfig,
  claimLedgerField: mocks.claimLedgerField,
}));
vi.mock("@/lib/announce/sender", () => ({ enqueueAnnouncement: mocks.enqueueAnnouncement }));
vi.mock("@/lib/team-store", () => ({ listTeams: mocks.listTeams }));
vi.mock("@/lib/classic-store", () => ({ listChallenges: mocks.listChallenges }));
vi.mock("@/lib/quiz-store", () => ({ listQuestions: mocks.listQuestions }));
vi.mock("@/lib/ai-store", () => ({ listAiChallenges: mocks.listAiChallenges }));

import { notifyFirstBlood } from "@/lib/announce/notify";

const armed = { webhookConfigured: true, firstBlood: true };

beforeEach(() => {
  mocks.getAnnounceConfig.mockReset().mockResolvedValue(armed);
  mocks.claimLedgerField.mockReset().mockResolvedValue(true);
  mocks.enqueueAnnouncement.mockReset().mockResolvedValue(undefined);
  mocks.listTeams.mockReset().mockResolvedValue([{ slug: "t1", name: "Team One", members: ["Alice"] }]);
  mocks.listChallenges.mockReset().mockResolvedValue([{ id: "web-1", title: "Web 1", category: "web", points: 100 }]);
  mocks.listQuestions.mockReset().mockResolvedValue([]);
  mocks.listAiChallenges.mockReset().mockResolvedValue([]);
});

describe("notifyFirstBlood", () => {
  it("does NOT claim when unconfigured or the switch is off (enabling later must not replay)", async () => {
    mocks.getAnnounceConfig.mockResolvedValue({ ...armed, webhookConfigured: false });
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", login: "alice" });
    expect(mocks.claimLedgerField).not.toHaveBeenCalled();

    mocks.getAnnounceConfig.mockResolvedValue({ ...armed, firstBlood: false });
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", login: "alice" });
    expect(mocks.claimLedgerField).not.toHaveBeenCalled();
    expect(mocks.enqueueAnnouncement).not.toHaveBeenCalled();
  });

  it("claims first, and posts only the winner", async () => {
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", login: "alice" });
    expect(mocks.claimLedgerField).toHaveBeenCalledWith("ctf:announce:first", "classic:web-1");
    expect(mocks.enqueueAnnouncement).toHaveBeenCalledTimes(1);
    const [kind, msg] = mocks.enqueueAnnouncement.mock.calls[0];
    expect(kind).toBe("first-blood");
    expect(JSON.stringify(msg)).toContain("Web 1");
  });

  it("does NOT post when the claim was lost", async () => {
    mocks.claimLedgerField.mockResolvedValue(false);
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", login: "alice" });
    expect(mocks.enqueueAnnouncement).not.toHaveBeenCalled();
  });

  it("displays the TEAM name via a case-insensitive membership join", async () => {
    mocks.listTeams.mockResolvedValue([{ slug: "t1", name: "Team One", members: ["ALICE"] }]);
    await notifyFirstBlood({ module: "classic", challengeId: "web-1", login: "alice" });
    const msg = mocks.enqueueAnnouncement.mock.calls[0][1] as { embeds: { description?: string }[] };
    expect(msg.embeds[0].description).toContain("Team One");
  });

  it("falls back to the bare login and to the id when the challenge vanished", async () => {
    mocks.listTeams.mockResolvedValue([]);
    mocks.listChallenges.mockResolvedValue([]);
    await notifyFirstBlood({ module: "classic", challengeId: "gone-1", login: "alice" });
    const msg = mocks.enqueueAnnouncement.mock.calls[0][1] as { embeds: { description?: string }[] };
    expect(msg.embeds[0].description).toContain("alice");
    expect(msg.embeds[0].description).toContain("gone-1");
  });

  it("links the quiz board for quiz (no per-question page) and /ai/<id> for ai", async () => {
    mocks.listQuestions.mockResolvedValue([{ id: "q1", prompt: "Q?", points: 10 }]);
    await notifyFirstBlood({ module: "quiz", challengeId: "q1", login: "alice" });
    expect(JSON.stringify(mocks.enqueueAnnouncement.mock.calls[0][1])).toContain("/quiz");

    mocks.listAiChallenges.mockResolvedValue([{ id: "inj-1", title: "AI 1", category: "ai", points: 50 }]);
    await notifyFirstBlood({ module: "ai", challengeId: "inj-1", login: "alice" });
    expect(JSON.stringify(mocks.enqueueAnnouncement.mock.calls[1][1])).toContain("/ai/inj-1");
  });

  it("never throws, even when the store explodes", async () => {
    mocks.getAnnounceConfig.mockRejectedValue(new Error("redis down"));
    await expect(notifyFirstBlood({ module: "classic", challengeId: "web-1", login: "alice" })).resolves.toBeUndefined();
  });
});
