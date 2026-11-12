// Discord delivery (#590): the enqueue gate, the coalesced flush, the pack,
// the flush-time kind filter ("stop disabled announcements immediately") and
// the retry pass. The store is mocked — this pins the SENDER's decisions;
// the store's own lease/outbox semantics are pinned in store.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAnnounceConfig: vi.fn(),
  getWebhookUrl: vi.fn(),
  getWebhookGeneration: vi.fn(),
  outboxEnqueue: vi.fn(),
  outboxPending: vi.fn(),
  outboxRetryable: vi.fn(),
  outboxClaim: vi.fn(),
  outboxComplete: vi.fn(),
  outboxSkip: vi.fn(),
  outboxPrune: vi.fn(),
  bumpStatus: vi.fn(),
  postToDiscord: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/error-label", () => ({ errorLabel: () => "label" }));
vi.mock("@/lib/announce/store", () => ({
  getAnnounceConfig: mocks.getAnnounceConfig,
  getWebhookUrl: mocks.getWebhookUrl,
  getWebhookGeneration: mocks.getWebhookGeneration,
  outboxEnqueue: mocks.outboxEnqueue,
  outboxPending: mocks.outboxPending,
  outboxRetryable: mocks.outboxRetryable,
  outboxClaim: mocks.outboxClaim,
  outboxComplete: mocks.outboxComplete,
  outboxSkip: mocks.outboxSkip,
  outboxPrune: mocks.outboxPrune,
  bumpStatus: mocks.bumpStatus,
}));

import { enqueueAnnouncement, flush, flushRetries } from "@/lib/announce/sender";
import type { DiscordMessage } from "@/lib/announce/messages";

const URL = "https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaaaa";
const message: DiscordMessage = { embeds: [{ title: "t" }], allowed_mentions: { parse: [] } };

const configured = (over: Record<string, unknown> = {}) => ({
  webhookConfigured: true,
  firstBlood: true,
  launch: true,
  pause: true,
  milestones: true,
  marks: "",
  webhookUrl: URL,
  webhookGeneration: 0,
  kindEpochs: { "first-blood": 0, launch: 0, pause: 0, resume: 0, milestone: 0 },
  ...over,
});

function entry(kind: string, status = "pending", n = 0, webhookGeneration = 0, kindEpoch = 0) {
  return { kind, payload: message, at: new Date().toISOString(), n, status, webhookGeneration, kindEpoch };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  // Call history from the previous test must not leak into "was it called"
  // assertions; implementations are re-stated right below.
  vi.clearAllMocks();
  mocks.getAnnounceConfig.mockResolvedValue(configured());
  mocks.getWebhookUrl.mockResolvedValue(URL);
  mocks.getWebhookGeneration.mockResolvedValue(0);
  mocks.outboxEnqueue.mockResolvedValue(undefined);
  mocks.outboxPending.mockResolvedValue([]);
  mocks.outboxRetryable.mockResolvedValue([]);
  mocks.outboxClaim.mockResolvedValue("lease-token");
  mocks.outboxComplete.mockResolvedValue(undefined);
  mocks.outboxSkip.mockResolvedValue(undefined);
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
    await enqueueAnnouncement("first-blood", message);
    expect(mocks.outboxEnqueue).not.toHaveBeenCalled();

    mocks.getAnnounceConfig.mockResolvedValue(configured({ firstBlood: false }));
    await enqueueAnnouncement("first-blood", message);
    expect(mocks.outboxEnqueue).not.toHaveBeenCalled();
  });

  it("enqueues and arms a coalesced flush when armed", async () => {
    await enqueueAnnouncement("first-blood", message);
    expect(mocks.outboxEnqueue).toHaveBeenCalledTimes(1);
    expect(mocks.outboxEnqueue).toHaveBeenCalledWith(expect.any(String), "first-blood", message, 0, 0);
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.outboxPending).toHaveBeenCalled();
  });

  it("generates an outbox id containing an 8-character random component", async () => {
    await enqueueAnnouncement("first-blood", message);
    const id = mocks.outboxEnqueue.mock.calls[0][0] as string;
    expect(id).toMatch(/^\d+-\d+-[0-9a-f]{8}-first-blood$/);
    await vi.advanceTimersByTimeAsync(300);
  });
});

describe("flush", () => {
  it("leases, packs up to 10 embeds into ONE post, marks sent", async () => {
    mocks.outboxPending.mockResolvedValue([
      { id: "1", entry: entry("first-blood") },
      { id: "2", entry: entry("launch") },
    ]);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [dest, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { embeds: unknown[]; allowed_mentions: unknown };
    expect(body.embeds).toHaveLength(2);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(mocks.outboxComplete).toHaveBeenCalledWith("1", "sent", "lease-token");
    expect(mocks.outboxComplete).toHaveBeenCalledWith("2", "sent", "lease-token");
    expect(mocks.outboxClaim).toHaveBeenCalledWith("1", expect.objectContaining({ kind: "first-blood", status: "pending" }));
    expect(mocks.outboxClaim).toHaveBeenCalledWith("2", expect.objectContaining({ kind: "launch", status: "pending" }));
    // The URL is the only thing fetch ever sees as a destination.
    expect(dest).toBe(URL);
    // Delivery is judged from THIS response alone: a 3xx must come back as
    // an opaque redirect response, never followed to somewhere that could
    // be mistaken for Discord's acceptance (or a rejection).
    expect(init.redirect).toBe("manual");
  });

  it("skips an entry whose switch went off since enqueue ('stop disabled immediately')", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(configured({ firstBlood: false }));
    mocks.outboxPending.mockResolvedValue([{ id: "1", entry: entry("first-blood") }]);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxSkip).toHaveBeenCalledWith("1");
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
  });

  it("leaves an entry with a newer switch epoch pending for a fresh-config pass", async () => {
    // The switch was disabled+re-enabled after this pass read the config, so
    // the entry's epoch is newer than the snapshot. Skipping it would be
    // terminal; it belongs to the next pass.
    mocks.outboxPending.mockResolvedValue([{ id: "1", entry: entry("first-blood", "pending", 0, 0, 1) }]);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxSkip).not.toHaveBeenCalled();
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
  });

  it("marks a failed POST failed and records the status", async () => {
    mocks.outboxPending.mockResolvedValue([{ id: "1", entry: entry("first-blood") }]);
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await flush();
    expect(mocks.outboxComplete).toHaveBeenCalledWith("1", "failed", "lease-token");
    expect(mocks.bumpStatus).toHaveBeenCalledWith("first-blood", "failed", expect.any(String));
  });

  it("does nothing at all without a webhook", async () => {
    mocks.getWebhookUrl.mockResolvedValue(null);
    mocks.outboxPending.mockResolvedValue([{ id: "1", entry: entry("first-blood") }]);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
  });

  it("a failed webhook read leaves pending entries untouched for a retry", async () => {
    mocks.getWebhookUrl.mockRejectedValue(new Error("redis down"));
    mocks.outboxPending.mockResolvedValue([{ id: "1", entry: entry("first-blood") }]);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxClaim).not.toHaveBeenCalled();
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
  });

  it("a rejected lease claim does not post or complete the entry", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.outboxPending.mockResolvedValue([{ id: "1", entry: entry("first-blood") }]);
    mocks.outboxClaim.mockRejectedValue(new Error("redis down"));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("re-arms the coalescing timer when a pass is already active, so the skipped flush is not stranded", async () => {
    // First pass is in flight (flushing set); the enqueue timer firing now
    // must not just return — it must arm a LATER pass for the new entry.
    let secondStarted!: () => void;
    let secondMayFinish!: () => void;
    const secondStartedP = new Promise<void>((r) => {
      secondStarted = r;
    });
    const secondGate = new Promise<void>((r) => {
      secondMayFinish = r;
    });
    mocks.outboxPending
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        secondStarted();
        await secondGate;
        return [];
      });
    const first = flush(); // sets `flushing` synchronously
    await flush(); // the coalescing timer firing mid-pass
    expect(vi.getTimerCount()).toBe(1); // re-armed, not dropped
    await first;
    expect(mocks.outboxPending).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300); // the re-armed timer starts pass two
    await secondStartedP;
    expect(mocks.outboxPending).toHaveBeenCalledTimes(2);
    secondMayFinish();
    // Let pass two drain before the test ends — a stuck `flushing` would
    // make every later test's flush a no-op.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });

  it("skips candidate when atomic claim returns false (e.g. concurrent replica delivered it)", async () => {
    mocks.outboxPending.mockResolvedValue([
      { id: "1", entry: entry("first-blood") },
      { id: "2", entry: entry("launch") },
    ]);
    mocks.outboxClaim.mockImplementation(async (id: string) => (id === "2" ? "token-2" : null));
    await flush();
    expect(mocks.outboxClaim).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { embeds: unknown[] };
    expect(body.embeds).toHaveLength(1);
    expect(mocks.outboxComplete).not.toHaveBeenCalledWith("1", expect.anything(), expect.anything());
    expect(mocks.outboxComplete).toHaveBeenCalledWith("2", "sent", "token-2");
  });

  it("claims leases per batch immediately before posting, preserving lease validity across sequential batches", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: `id-${i + 1}`,
      entry: entry("first-blood"),
    }));
    mocks.outboxPending.mockResolvedValue(items);

    const callOrder: string[] = [];
    mocks.outboxClaim.mockImplementation(async (id: string) => {
      callOrder.push(`claim:${id}`);
      return `token-${id}`;
    });
    fetchMock.mockImplementation(async () => {
      callOrder.push("fetch");
      return { ok: true, status: 200 };
    });

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Batch 1 (ids 1..10) claimed before first fetch
    for (let i = 1; i <= 10; i += 1) {
      expect(callOrder.indexOf(`claim:id-${i}`)).toBeLessThan(callOrder.indexOf("fetch"));
    }
    // Batch 2 (ids 11..12) claimed AFTER first fetch, before second fetch
    const firstFetchIndex = callOrder.indexOf("fetch");
    const secondFetchIndex = callOrder.lastIndexOf("fetch");
    expect(callOrder.indexOf("claim:id-11")).toBeGreaterThan(firstFetchIndex);
    expect(callOrder.indexOf("claim:id-11")).toBeLessThan(secondFetchIndex);
    expect(callOrder.indexOf("claim:id-12")).toBeGreaterThan(firstFetchIndex);
    expect(callOrder.indexOf("claim:id-12")).toBeLessThan(secondFetchIndex);
  });
});

describe("flushRetries", () => {
  it("re-delivers failed entries with attempts remaining, same lease discipline", async () => {
    mocks.outboxRetryable.mockResolvedValue([{ id: "9", entry: entry("launch", "failed", 1) }]);
    await flushRetries();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.outboxComplete).toHaveBeenCalledWith("9", "sent", "lease-token");
  });

  it("delivers a pending entry stranded by a restart or interrupted flush", async () => {
    // Seeded straight into the outbox, never through enqueueAnnouncement, so
    // this process has no local queue id and no coalescing timer to rely on.
    mocks.outboxPending.mockResolvedValue([{ id: "p1", entry: entry("launch", "pending") }]);
    await flushRetries();
    expect(mocks.outboxClaim).toHaveBeenCalledWith("p1", expect.objectContaining({ status: "pending", n: 0 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.outboxComplete).toHaveBeenCalledWith("p1", "sent", "lease-token");
  });

  it("skips candidate when the atomic claim returns no lease during retry sweep", async () => {
    mocks.outboxRetryable.mockResolvedValue([{ id: "r1", entry: entry("launch", "failed", 1) }]);
    mocks.outboxClaim.mockResolvedValue(null);
    await flushRetries();
    expect(mocks.outboxClaim).toHaveBeenCalledWith("r1", expect.objectContaining({ status: "failed", n: 1 }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
  });

  it("delivers an id once even if both sweeps return it", async () => {
    mocks.outboxPending.mockResolvedValue([{ id: "same", entry: entry("launch", "pending") }]);
    mocks.outboxRetryable.mockResolvedValue([{ id: "same", entry: entry("launch", "failed", 1) }]);
    await flushRetries();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.outboxComplete).toHaveBeenCalledTimes(1);
    expect(mocks.outboxComplete).toHaveBeenCalledWith("same", "sent", "lease-token");
  });

  it("a failed webhook read leaves retryable entries untouched for the next sweep", async () => {
    mocks.getWebhookUrl.mockRejectedValue(new Error("redis down"));
    mocks.outboxRetryable.mockResolvedValue([{ id: "9", entry: entry("launch", "failed", 1) }]);
    await flushRetries();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxClaim).not.toHaveBeenCalled();
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
  });

  it("leaves a retryable entry with a newer switch epoch pending", async () => {
    mocks.outboxRetryable.mockResolvedValue([{ id: "9", entry: entry("launch", "failed", 1, 0, 1) }]);
    await flushRetries();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxSkip).not.toHaveBeenCalled();
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
  });

  it("rejects an entry enqueued from before a switch disable after it is re-enabled", async () => {
    // A producer read firstBlood: true (epoch 0) and enqueued after the
    // disable's cancellation scan. Turning it back on keeps the advanced
    // epoch, so the retained entry must not post.
    mocks.getAnnounceConfig.mockResolvedValue(
      configured({ kindEpochs: { "first-blood": 1, launch: 0, pause: 0, resume: 0, milestone: 0 } }),
    );
    mocks.outboxPending.mockResolvedValue([{ id: "race", entry: entry("first-blood", "pending", 0, 0, 0) }]);
    await flushRetries();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxSkip).toHaveBeenCalledWith("race");
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
  });

  it("rejects an entry enqueued from a pre-clear snapshot after the cancellation scan", async () => {
    // A producer read the old config (generation 0) and enqueued after the
    // clear's cancellation scan. The clear advanced the generation, so this
    // entry must not reach the webhook configured afterwards.
    mocks.outboxPending.mockResolvedValue([{ id: "race", entry: entry("launch", "pending", 0, 0) }]);
    mocks.getWebhookGeneration.mockResolvedValue(1);
    await flushRetries();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxSkip).toHaveBeenCalledWith("race");
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
  });

  it("a failed generation read leaves retryable entries untouched", async () => {
    mocks.getWebhookGeneration.mockRejectedValue(new Error("redis down"));
    mocks.outboxRetryable.mockResolvedValue([{ id: "9", entry: entry("launch", "failed", 1) }]);
    await flushRetries();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.outboxClaim).not.toHaveBeenCalled();
    expect(mocks.outboxSkip).not.toHaveBeenCalled();
    expect(mocks.outboxComplete).not.toHaveBeenCalled();
  });
});
