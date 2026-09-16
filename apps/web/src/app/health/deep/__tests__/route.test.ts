// `GET /health/deep` — the HTTP contract over the probe (issue #437). The
// probe's behaviour is pinned in lib/__tests__/health-deep.test.ts; this file
// pins what a monitor sees: the status code, the cache header, and — as
// /health's own test does — the exact key set, so the public payload cannot
// quietly grow.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probeDeepHealth: vi.fn<() => Promise<Record<string, unknown>>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/health-deep", () => ({ probeDeepHealth: mocks.probeDeepHealth }));

import { GET } from "@/app/health/deep/route";

beforeEach(() => {
  mocks.probeDeepHealth.mockReset();
});

describe("GET /health/deep", () => {
  it("answers 200 and no-store when every dependency is ok", async () => {
    mocks.probeDeepHealth.mockResolvedValue({
      status: "ok",
      redis: "ok",
      scorer: "ok",
      sync: { lastPollAt: "2026-09-15T11:59:18Z", ageSec: 42 },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["redis", "scorer", "status", "sync"]);
  });

  it("answers 503 when degraded, with the same payload shape", async () => {
    mocks.probeDeepHealth.mockResolvedValue({ status: "degraded", redis: "ok", scorer: "down" });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", redis: "ok", scorer: "down" });
  });

  // The probe already swallows dependency failures; this is the last line
  // if it ever throws anyway. A monitor must get a 503 with a body it can
  // parse, not a Next error page.
  it("answers 503 degraded if the probe itself throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.probeDeepHealth.mockRejectedValue(new Error("unexpected"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded" });
  });
});
