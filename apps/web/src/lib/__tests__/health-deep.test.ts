// `/health/deep`'s probe (issue #437). What is worth pinning:
//
//   - each dependency reports "ok" or "down" and NOTHING else — no error
//     text, no host, no URL. The endpoint is public (a free uptime monitor
//     cannot send a header), so the payload has the same disclosure contract
//     as /health: nothing an attacker could not already read from the repo;
//   - the scorer and poller probes exist only when SCORE_IMAGE is set. A box
//     with no scorer that reported "scorer: ok" would be the vacuous pass this
//     repo already guards against elsewhere; the keys must be ABSENT;
//   - the poller is reported, never failed on (decided in brainstorm);
//   - a 10 s cache caps the probe cost at one round per process per window
//     regardless of how many callers hit the URL.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashPipeline: vi.fn<(commands: (string | number)[][], opts?: unknown) => Promise<{ result?: unknown; error?: string }[]>>(),
  getSyncStatus: vi.fn<() => Promise<{ lastPollAt: string | null } | null>>(),
  fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline }));
vi.mock("@/lib/admin-store", () => ({ getSyncStatus: mocks.getSyncStatus }));

import { DEEP_HEALTH_CACHE_MS, probeDeepHealth, resetDeepHealthCache } from "@/lib/health-deep";

const NOW = Date.parse("2026-09-15T12:00:00Z");
const SCORER_URL = "http://scorer:4000";

beforeEach(() => {
  // Call history is what the cache tests assert on; clear it per test.
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetDeepHealthCache();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Happy path by default; tests knock one leg out at a time.
  vi.stubEnv("SCORE_IMAGE", "ghcr.io/example/scorer:1");
  vi.stubEnv("LEADERBOARD_API_URL", SCORER_URL);
  mocks.upstashPipeline.mockResolvedValue([{ result: "PONG" }]);
  mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
  mocks.getSyncStatus.mockResolvedValue({ lastPollAt: "2026-09-15T11:59:18Z" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("probeDeepHealth", () => {
  it("reports ok when Redis PONGs and the scorer answers /healthz", async () => {
    const h = await probeDeepHealth(NOW);
    expect(h).toEqual({
      status: "ok",
      redis: "ok",
      scorer: "ok",
      sync: { lastPollAt: "2026-09-15T11:59:18Z", ageSec: 42 },
    });
    // The scorer probe hits the scorer's own health route, not the leaderboard.
    expect(mocks.fetch.mock.calls[0]![0]).toBe(`${SCORER_URL}/healthz`);
  });

  it("is degraded, naming redis, when the pipeline rejects", async () => {
    mocks.upstashPipeline.mockRejectedValue(new Error("Upstash pipeline failed: HTTP 502 https://srh:8079/pipeline"));
    const h = await probeDeepHealth(NOW);
    expect(h.status).toBe("degraded");
    expect(h.redis).toBe("down");
  });

  // upstashPipeline does not throw on a per-command error (NOAUTH, WRONGTYPE);
  // it returns { error }. A PING that came back as an error is not a PONG.
  it("treats a per-command error reply as redis down", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ error: "NOAUTH Authentication required." }]);
    const h = await probeDeepHealth(NOW);
    expect(h.redis).toBe("down");
    expect(h.status).toBe("degraded");
  });

  it("is degraded, naming the scorer, when /healthz is not 2xx or unreachable", async () => {
    mocks.fetch.mockResolvedValue(new Response("nope", { status: 503 }));
    expect((await probeDeepHealth(NOW)).scorer).toBe("down");
    resetDeepHealthCache();
    mocks.fetch.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.7:4000"));
    const h = await probeDeepHealth(NOW);
    expect(h.scorer).toBe("down");
    expect(h.status).toBe("degraded");
  });

  it("names the scorer as down when SCORE_IMAGE is set but no URL is configured", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "");
    const h = await probeDeepHealth(NOW);
    expect(h.scorer).toBe("down");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  // The disclosure contract. Whatever the dependencies say when they fail,
  // none of it reaches the payload — only the two words do.
  it("never puts an error message, host or URL in the payload", async () => {
    mocks.upstashPipeline.mockRejectedValue(new Error("Upstash pipeline failed: HTTP 502 https://srh:8079/pipeline"));
    mocks.fetch.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.7:4000"));
    const body = JSON.stringify(await probeDeepHealth(NOW));
    expect(body).not.toMatch(/http|srh|ECONNREFUSED|10\.0\.0|4000|8079|Upstash|pipeline/i);
    for (const v of Object.values(await probeDeepHealth(NOW))) {
      if (typeof v === "string") expect(["ok", "down", "degraded"]).toContain(v);
    }
  });

  it("omits the scorer and poller entirely when there is no scorer image", async () => {
    vi.stubEnv("SCORE_IMAGE", "");
    const h = await probeDeepHealth(NOW);
    expect(Object.keys(h).sort()).toEqual(["redis", "status"]);
    expect(h.status).toBe("ok");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.getSyncStatus).not.toHaveBeenCalled();
  });

  it("reports a quiet or unreadable poller without failing on it", async () => {
    mocks.getSyncStatus.mockResolvedValue({ lastPollAt: "2026-09-15T09:00:00Z" });
    let h = await probeDeepHealth(NOW);
    expect(h.sync).toEqual({ lastPollAt: "2026-09-15T09:00:00Z", ageSec: 3 * 3600 });
    expect(h.status).toBe("ok");

    resetDeepHealthCache();
    mocks.getSyncStatus.mockResolvedValue(null);
    h = await probeDeepHealth(NOW);
    expect(h.sync).toEqual({ lastPollAt: null, ageSec: null });
    expect(h.status).toBe("ok");

    resetDeepHealthCache();
    mocks.getSyncStatus.mockRejectedValue(new Error("boom"));
    h = await probeDeepHealth(NOW);
    expect(h.sync).toEqual({ lastPollAt: null, ageSec: null });
    expect(h.status).toBe("ok");
  });

  it("serves the cached result inside the window and re-probes after it", async () => {
    await probeDeepHealth(NOW);
    await probeDeepHealth(NOW + DEEP_HEALTH_CACHE_MS - 1);
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await probeDeepHealth(NOW + DEEP_HEALTH_CACHE_MS);
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(2);
  });

  // A degraded answer is cached too: a monitor polling every 30 s and a room
  // refreshing must not turn a dead scorer into a probe storm against it.
  it("caches a degraded result the same as a healthy one", async () => {
    mocks.fetch.mockRejectedValue(new Error("down"));
    await probeDeepHealth(NOW);
    await probeDeepHealth(NOW + 1000);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
