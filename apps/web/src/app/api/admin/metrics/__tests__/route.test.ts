// Metrics route (issue #169). The store is mocked; what this pins is the gate
// and the two output shapes.
//
// The gate is the load-bearing part. The aggregates themselves are harmless to
// publish, but the payload is COMPUTED from per-contestant rows, so every field
// added to it later is one edit away from carrying a login. Keeping the route
// admin-only means that edit cannot become a disclosure by accident.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, computeEventMetrics, challengesToCsv } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  computeEventMetrics: vi.fn(),
  challengesToCsv: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/metrics-store", () => ({ computeEventMetrics, challengesToCsv }));

import { GET } from "@/app/api/admin/metrics/route";
import { decoratedError, expectLabelOnly } from "@/lib/__tests__/log-redaction";

const req = (qs = "") => new Request(`http://x/api/admin/metrics${qs}`);

const METRICS = {
  generatedAt: "2026-08-22T12:34:56.000Z",
  funnel: { onATeam: 3, everOnATeam: 4, attempted: 4, scored: 3, stuck: 1 },
  challenges: [],
  timeline: [],
  teams: [],
  modules: { quiz: 1, classic: 2, secureDevelopment: 0 },
  hints: { buyers: 1, totalSpend: 10 },
  caveats: ["something is not measured"],
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ ok: true, login: "alice" });
  computeEventMetrics.mockResolvedValue(METRICS);
  challengesToCsv.mockReturnValue("module,id\nquiz,q1\n");
});

describe("GET /api/admin/metrics", () => {
  it("403s a non-admin WITHOUT computing anything", async () => {
    // Not just a status check: the fold is an O(contestants) read, so an
    // unauthorized caller must not be able to trigger it either.
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(computeEventMetrics).not.toHaveBeenCalled();
  });

  it("returns the metrics as JSON", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(METRICS);
  });

  it("carries the caveats into the response body", async () => {
    // They ship WITH the numbers on purpose — a metric whose limits travel
    // separately gets quoted without them.
    const body = (await (await GET(req())).json()) as typeof METRICS;
    expect(body.caveats).toEqual(["something is not measured"]);
  });

  it("serves CSV as an attachment when asked", async () => {
    const res = await GET(req("?format=csv"));
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain('filename="challenges-2026-08-22.csv"');
    expect(await res.text()).toBe("module,id\nquiz,q1\n");
  });

  it("ignores an unrecognised format rather than guessing", async () => {
    const res = await GET(req("?format=xlsx"));
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(challengesToCsv).not.toHaveBeenCalled();
  });

  it("503s a compute failure without leaking the reason", async () => {
    computeEventMetrics.mockRejectedValue(new Error("redis exploded"));
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  // ...nor in the server log: label only, never the raw caught value (#500).
  it("logs the label on a compute failure, never the raw err", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      computeEventMetrics.mockRejectedValue(decoratedError("redis exploded"));
      expect((await GET(req())).status).toBe(503);
      expectLabelOnly(spy, { label: "redis exploded" });
    } finally {
      spy.mockRestore();
    }
  });
});
