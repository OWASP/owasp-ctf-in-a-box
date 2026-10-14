// Discord delivery (#590): the enqueue gate, the coalesced flush, the pack,
// the flush-time kind filter ("stop disabled announcements immediately") and
// the retry pass. The store is mocked — this pins the SENDER's decisions;
// the store's own lease/outbox semantics are pinned in store.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAnnounceConfig: vi.fn(),
  getWebhookUrl: vi.fn(),
  outboxEnqueue: vi.fn(),
  outboxPending: vi.fn(),
  outboxRetryable: vi.fn(),
  outboxClaimLease: vi.fn(),
  outboxComplete: vi.fn(),
  outboxPrune: vi.fn(),
  bumpStatus: vi.fn(),
  postToDiscord: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/error-label", () => ({ errorLabel: () => "label" }));
vi.mock("@/lib/announce/store", () => ({
  getAnnounceConfig: mocks.getAnnounceConfig,
  getWebhookUrl: mocks.getWebhookUrl,
  outboxEnqueue: mocks.outboxEnqueue,
  outboxPending: mocks.outboxPending,
  outboxRetryable: mocks.outboxRetryable,
  outboxClaimLease: mocks.outboxClaimLease,
  outboxComplete: mocks.outboxComplete,
  outboxPrune: mocks.outboxPrune,
  bumpStatus: mocks.bumpStatus,
}));

import { enqueueAnnouncement, flush, flushRetries } from "@/lib/announce/sender";
import type { DiscordMessage } from "@/lib/announce/messages";

const URL = "https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaaaa";
const message: DiscordMessage = { embeds: [{ title: "t" }], allowed_mentions: { parse: [] } };

const configured = (over: Record<string, unknown> = {}) => ({
  webhookConfigured: true,
  releases: true,
  firstBlood: true,
  leaders: true,
  leaderScope: "first",
  launch: true,
  pause: true,
  registration: true,
  milestones: true,
  marks: "",
  daily: true,
  dailyAt: "09:00",
  dailyTopN: 10,
  webhookUrl: URL,
  ...over,
});

function entry(kind: string, status = "pending", n = 0) {
  return { kind, payload: message, at: new Date().toISOString(), n, status };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  // Call history from the previous test must not leak into "was it called"
  // assertions; implementations are re-stated right below.
  vi.clearAllMocks();
  mocks.getAnnounceConfig.mockResolvedValue(configured());
  mocks.getWebhookUrl.mockResolvedValue(URL);
  mocks.outboxEnqueue.mockResolvedValue(undefined);
  mocks.outboxPending.mockResolvedValue([]);
  mocks.outboxRetryable.mockResolvedValue([]);
  mocks.outboxClaimLease.mockResolvedValue(true);
  mocks.outboxComplete.mockResolvedValue(undefined);
  mocks.outboxPrune.mockResolvedValue(undefined);
  mocks.bumpStatus.mockResolvedValue(undefined);
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("enqueueAnnouncement", () => {
  it("writes nothing when unconfigured or the kind's switch is off", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(configured({ webhookConfigured: false }));
    await enqueueAnnouncement("release", message);
    expect(mocks.outboxEnqueue).not.toHaveBeenCalled();

    mocks.getAnnounceConfig.mockResolvedValue(configured({ releases: false }));
    await enqueueAnnouncement("release", message);
    expect(mocks.outboxEnqueue).not.toHaveBeenCalled();
  });

  it("enqueues and arms a coalesced flush when armed", async () => {
    await enqueueAnnouncement("release", message);
    expect(mocks.outboxEnqueue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.outboxPending).toHaveBeenCalled();
  });
});

describe("flush", () => {
  it("leases, packs up to 10 embeds into ONE post, marks sent", async () => {
    mocks.outboxPending.mockResolvedValue([
      { id: "1", entry: entry("release") },
      { id: "2", entry: entry("first-blood") },
    ]);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string) as { embeds: unknown[]; allowed_mentions: unknown };
    expect(body.embeds).toHaveLength(2);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(mocks.outboxComplete).toHaveBeenCalledWith("1", "sent");
    expect(mocks.outboxComplete).toHaveBeenCalledWith("2", "sent");
    // The URL is the only thing fetch ever sees as a destination.
    expect(fetchMock.mock.calls[0][0]).toBe(URL);
  });

  it("skips an entry whose switch went off since enqueue ('stop disabled immediately')", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(configured({ releases: false }));
    mocks.outboxPending.mockResolvedValue([{ id: "1", entry: entry("release") }]);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxComplete).toHaveBeenCalledWith("1", "skipped");
  });

  it("marks a failed POST failed and records the status", async () => {
    mocks.outboxPending.mockResolvedValue([{ id: "1", entry: entry("release") }]);
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await flush();
    expect(mocks.outboxComplete).toHaveBeenCalledWith("1", "failed");
    expect(mocks.bumpStatus).toHaveBeenCalledWith("release", "failed", expect.any(String));
  });

  it("does nothing at all without a webhook", async () => {
    mocks.getWebhookUrl.mockResolvedValue(null);
    mocks.outboxPending.mockResolvedValue([{ id: "1", entry: entry("release") }]);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
  });
});

describe("flushRetries", () => {
  it("re-delivers failed entries with attempts remaining, same lease discipline", async () => {
    mocks.outboxRetryable.mockResolvedValue([{ id: "9", entry: entry("leader", "failed", 1) }]);
    await flushRetries();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.outboxComplete).toHaveBeenCalledWith("9", "sent");
  });
});
