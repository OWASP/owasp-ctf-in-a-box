// A first-blood producer reads its config, then awaits listTeams() and the
// challenge lookup before enqueueing. If the organizer disables the stream and
// re-enables it during that window, the notification composed from the OLD
// config must not borrow the NEW epoch and post. This runs the real notify and
// sender against a store whose enqueue is the same atomic counter check the
// Lua script performs: the captured pre-toggle stamp is rejected.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    config: {
      webhookConfigured: true,
      webhookGeneration: 0,
      firstBlood: true,
      launch: false,
      pause: false,
      milestones: false,
      marks: "",
      webhookUrl: "https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaaaa",
      kindEpochs: { "first-blood": 0, launch: 0, pause: 0, resume: 0, milestone: 0 },
    },
    entries: [] as { id: string; kind: string; stamp: { webhookGeneration: number; kindEpoch: number } }[],
    listTeams: vi.fn(),
  };
  return { state, listTeams: state.listTeams };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/error-label", () => ({ errorLabel: () => "label" }));
vi.mock("@/lib/announce/store", () => ({
  getAnnounceConfig: async () => structuredClone(mocks.state.config),
  claimLedgerField: async () => true,
  // The atomic enqueue contract: write only while the captured counters still
  // match the live config and the switch is on.
  outboxEnqueue: async (id: string, kind: string, _payload: unknown, webhookGeneration: number, kindEpoch: number) => {
    const config = mocks.state.config;
    if (!config.firstBlood || config.webhookGeneration !== webhookGeneration || config.kindEpochs["first-blood"] !== kindEpoch) {
      return false;
    }
    mocks.state.entries.push({ id, kind, stamp: { webhookGeneration, kindEpoch } });
    return true;
  },
  getWebhookDeliveryTarget: async () => ({ url: mocks.state.config.webhookUrl, generation: mocks.state.config.webhookGeneration }),
  outboxPending: async () => [],
  outboxRetryable: async () => [],
  outboxClaim: async () => null,
  outboxComplete: async () => {},
  outboxSkip: async () => {},
  outboxPrune: async () => {},
  bumpStatus: async () => {},
}));
vi.mock("@/lib/team-store", () => ({ listTeams: mocks.listTeams }));
vi.mock("@/lib/classic-store", () => ({
  readChallengeRecords: async () => [{ id: "web-1", title: "Web 1", category: "web", points: 100 }],
  listStories: async () => [],
}));
vi.mock("@/lib/quiz-store", () => ({ listQuestions: async () => [] }));
vi.mock("@/lib/ai-store", () => ({ listAiChallenges: async () => [] }));
vi.mock("@/lib/story-lock", () => ({ storyPositions: () => new Map(), isLocked: () => false }));

import { notifyFirstBlood } from "@/lib/announce/notify";

beforeEach(() => {
  mocks.state.config.firstBlood = true;
  mocks.state.config.webhookGeneration = 0;
  mocks.state.config.kindEpochs["first-blood"] = 0;
  mocks.state.entries = [];
  mocks.listTeams.mockReset();
});

describe("first-blood enqueue race", () => {
  it("rejects a notification whose config was captured before the stream toggled", async () => {
    let releaseTeams: (() => void) | undefined;
    mocks.listTeams.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseTeams = () => resolve([{ slug: "t1", name: "Team One", members: ["alice"] }]);
        }),
    );

    const notify = notifyFirstBlood({ module: "classic", challengeId: "web-1", login: "alice" });
    await vi.waitFor(() => expect(mocks.listTeams).toHaveBeenCalledTimes(1));

    // Disable and re-enable while the producer is suspended in listTeams().
    // Each edge advances the kind epoch, so the captured epoch is now stale.
    mocks.state.config.firstBlood = false;
    mocks.state.config.kindEpochs["first-blood"] += 1;
    mocks.state.config.firstBlood = true;
    mocks.state.config.kindEpochs["first-blood"] += 1;

    releaseTeams?.();
    await notify;

    expect(mocks.state.entries).toHaveLength(0);
  });
});
