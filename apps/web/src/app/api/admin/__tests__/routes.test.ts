// Route-level tests for the admin status/settings API. Auth guard, store, and
// the leaderboard source are all mocked — no Upstash or GitHub session needed.
//
// The leaderboard freshness read is best-effort: a throw there must degrade
// to `leaderboard: null`, never fail the whole status route (settings/sync
// are the core payload).

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireAdmin,
  getAdminSettings,
  updateAdminSettings,
  getSyncStatus,
  getLeaderboardSource,
  resetEvent,
  seedDemoData,
  clearDemoData,
} = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminSettings: vi.fn(),
  updateAdminSettings: vi.fn(),
  getSyncStatus: vi.fn(),
  getLeaderboardSource: vi.fn(),
  resetEvent: vi.fn(),
  seedDemoData: vi.fn(),
  clearDemoData: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/admin-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin-store")>()),
  getAdminSettings,
  updateAdminSettings,
  getSyncStatus,
  resetEvent,
  seedDemoData,
  clearDemoData,
}));
vi.mock("@/lib/leaderboard/source", () => ({ getLeaderboardSource }));
vi.mock("@/lib/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules")>()),
  isModuleEnabled: () => false,
}));

import { GET } from "@/app/api/admin/status/route";
import { POST } from "@/app/api/admin/settings/route";
import { POST as resetPOST } from "@/app/api/admin/reset/route";
import { POST as seedPOST, DELETE as seedDELETE } from "@/app/api/admin/seed/route";
import { adminErrorLabel } from "@/lib/admin-store";

const req = (body?: unknown) =>
  new Request("http://x/api/admin/settings", { method: "POST", body: JSON.stringify(body ?? {}) });

// The reset route confirms against the RUNTIME name (issue #386), read via
// getAdminSettings().eventIdentity + resolveSite — there is no baked
// event.yaml name any more — see the "runtime event name" cases below.
const SETTINGS = {
  paused: true,
  hintsEnabled: null,
  hintCost: null,
  updatedBy: "alice",
  updatedAt: "t",
  eventIdentity: { eventName: "Runtime CTF" },
};

beforeEach(() => {
  requireAdmin.mockReset();
  getAdminSettings.mockReset();
  updateAdminSettings.mockReset();
  getSyncStatus.mockReset();
  getLeaderboardSource.mockReset();
  resetEvent.mockReset();
  seedDemoData.mockReset();
  clearDemoData.mockReset();
  requireAdmin.mockResolvedValue({ ok: true, login: "alice" });
  getAdminSettings.mockResolvedValue(SETTINGS);
  getSyncStatus.mockResolvedValue(null);
  getLeaderboardSource.mockResolvedValue({
    getLeaderboard: vi.fn().mockResolvedValue({
      entries: [],
      teams: [],
      generatedAt: "t",
      capabilities: { apps: false, teams: false, challenges: false },
    }),
  });
});

describe("GET /api/admin/status", () => {
  it("403 for a non-admin", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    const res = await GET(new Request("http://x/api/admin/status"));
    expect(res.status).toBe(403);
    expect(getAdminSettings).not.toHaveBeenCalled();
  });

  it("401 for no session", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 401 });
    const res = await GET(new Request("http://x/api/admin/status"));
    expect(res.status).toBe(401);
  });

  it("returns settings and sync for an admin", async () => {
    const res = await GET(new Request("http://x/api/admin/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settings: { paused: true }, sync: null });
  });

  it("includes leaderboard freshness computed from entries", async () => {
    getLeaderboardSource.mockResolvedValue({
      getLeaderboard: vi.fn().mockResolvedValue({
        entries: [
          { rank: 1, login: "a", team: null, points: 10, patched: 1, failed: 0, total: 1, apps: {}, updatedAt: "2026-08-14T10:00:00.000Z" },
          { rank: 2, login: "b", team: null, points: 5, patched: 1, failed: 0, total: 1, apps: {}, updatedAt: "2026-08-14T12:00:00.000Z" },
        ],
        teams: [],
        generatedAt: "t",
        capabilities: { apps: false, teams: false, challenges: false },
      }),
    });
    const res = await GET(new Request("http://x/api/admin/status"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leaderboard).toMatchObject({ players: 2, lastUpdatedAt: "2026-08-14T12:00:00.000Z" });
  });

  it("degrades leaderboard to null on a read failure instead of failing the route", async () => {
    getLeaderboardSource.mockResolvedValue({
      getLeaderboard: vi.fn().mockRejectedValue(new Error("source down")),
    });
    const res = await GET(new Request("http://x/api/admin/status"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toMatchObject({ paused: true });
    expect(body.leaderboard).toBeNull();
  });
});

describe("POST /api/admin/settings", () => {
  it("401 for no session", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 401 });
    expect((await POST(req({ paused: true }))).status).toBe(401);
    expect(updateAdminSettings).not.toHaveBeenCalled();
  });

  it("403 for a non-admin", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    expect((await POST(req({ paused: true }))).status).toBe(403);
    expect(updateAdminSettings).not.toHaveBeenCalled();
  });

  it("writes and echoes the new settings", async () => {
    updateAdminSettings.mockResolvedValue(SETTINGS);
    const res = await POST(req({ paused: true }));
    expect(res.status).toBe(200);
    expect(updateAdminSettings).toHaveBeenCalledWith({ paused: true }, "alice");
    expect(await res.json()).toMatchObject({ settings: { paused: true } });
  });

  it("400 with the field on a validation error", async () => {
    const { AdminValidationError } = await import("@/lib/admin-store");
    updateAdminSettings.mockRejectedValue(new AdminValidationError("hintCost", "bad"));
    const res = await POST(req({ hintCost: -1 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "hintCost" });
  });

  it("503 on a Redis failure", async () => {
    updateAdminSettings.mockRejectedValue(new Error("upstash down"));
    expect((await POST(req({ paused: true }))).status).toBe(503);
  });
});

describe("POST /api/admin/reset", () => {
  const rreq = (body?: unknown) =>
    new Request("http://x/api/admin/reset", { method: "POST", body: JSON.stringify(body ?? {}) });

  it("401 for no session, without wiping anything", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 401 });
    expect((await resetPOST(rreq({ confirm: "Runtime CTF" }))).status).toBe(401);
    expect(resetEvent).not.toHaveBeenCalled();
  });

  it("403 for a non-admin, without wiping anything", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    expect((await resetPOST(rreq({ confirm: "Runtime CTF" }))).status).toBe(403);
    expect(resetEvent).not.toHaveBeenCalled();
  });

  it("400 when the confirm phrase does not match, without wiping", async () => {
    const res = await resetPOST(rreq({ confirm: "nope" }));
    expect(res.status).toBe(400);
    expect(resetEvent).not.toHaveBeenCalled();
  });

  it("wipes and returns counts when the runtime event name matches", async () => {
    resetEvent.mockResolvedValue({ cleared: { solves: 3, teams: 1 }, resetAt: "123" });
    const res = await resetPOST(rreq({ confirm: "Runtime CTF" }));
    expect(res.status).toBe(200);
    expect(resetEvent).toHaveBeenCalledWith("alice");
    expect(await res.json()).toMatchObject({ cleared: { solves: 3 }, resetAt: "123" });
  });

  it("also accepts the literal RESET phrase", async () => {
    resetEvent.mockResolvedValue({ cleared: {}, resetAt: "1" });
    expect((await resetPOST(rreq({ confirm: "RESET" }))).status).toBe(200);
    expect(resetEvent).toHaveBeenCalledOnce();
  });

  it("503 on a reset failure", async () => {
    resetEvent.mockRejectedValue(new Error("upstash down"));
    expect((await resetPOST(rreq({ confirm: "RESET" }))).status).toBe(503);
  });

  it("503 when the settings read fails, refusing before any comparison or wipe (fail closed)", async () => {
    // getAdminSettings() throws on a failed HGETALL — the route must map that
    // to a refusal, never fall back to a default name the way the fail-open
    // getSite() snapshot would (CodeRabbit round 2).
    getAdminSettings.mockRejectedValue(new Error("upstash down"));
    const res = await resetPOST(rreq({ confirm: "RESET" }));
    expect(res.status).toBe(503);
    expect(resetEvent).not.toHaveBeenCalled();
  });

  it("rejects a stale confirm name once the organizer renamed the event", async () => {
    requireAdmin.mockResolvedValue({ ok: true, login: "alice" });
    const res = await resetPOST(rreq({ confirm: "Test Event" }));
    expect(res.status).toBe(400);
    expect(resetEvent).not.toHaveBeenCalled();
  });

  // Carried from #389 round 3: this route used to log the raw caught `err`.
  // Node's console.error prints an Error's own enumerable properties too, so
  // a decorated error (a wrapped Redis/HTTP error carrying a token, a URL
  // with credentials, etc.) would leak them straight into the server log.
  // adminErrorLabel(err) reduces it to "<name>: <message>" — prove it for
  // both call sites this route logs an error from.
  //
  // NOTE the assertion shape: `String(someError)` ALSO collapses to
  // "Error: <message>" and drops the decorated fields on its own — so
  // `.map(String).join(...)` proves nothing about what was actually passed
  // to console.error (it would read identically whether the route logged
  // the raw `err` or the label). The real proof is that every argument
  // AFTER the fixed string prefix is itself a `string` — the raw `err` is
  // an `Error` instance (`typeof === "object"`), so passing it directly
  // fails this check regardless of how it later stringifies — and that it
  // equals `adminErrorLabel(err)`'s own output exactly, not merely that it
  // excludes a couple of chosen substrings.
  it("redacts a decorated resetEvent failure before logging it — never the raw err", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const decorated = Object.assign(new Error("upstash down"), {
      token: "SECRET-TOKEN",
      url: "https://leaky.example/creds",
    });
    resetEvent.mockRejectedValue(decorated);
    const res = await resetPOST(rreq({ confirm: "RESET" }));
    expect(res.status).toBe(503);
    expect(spy).toHaveBeenCalledTimes(1);
    const [prefix, ...rest] = spy.mock.calls[0];
    expect(prefix).toBe("[admin/reset] reset failed");
    // Every logged argument past the prefix must be a STRING — not the
    // `Error` object itself — and exactly the redacted label.
    for (const arg of rest) expect(typeof arg).toBe("string");
    expect(rest).toEqual([adminErrorLabel(decorated)]);
    spy.mockRestore();
  });

  it("redacts a decorated settings-read failure before logging it — never the raw err", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const decorated = Object.assign(new Error("upstash down"), {
      token: "SECRET-TOKEN",
      url: "https://leaky.example/creds",
    });
    getAdminSettings.mockRejectedValue(decorated);
    const res = await resetPOST(rreq({ confirm: "RESET" }));
    expect(res.status).toBe(503);
    expect(spy).toHaveBeenCalledTimes(1);
    const [prefix, ...rest] = spy.mock.calls[0];
    expect(prefix).toBe("[admin/reset] settings read failed");
    for (const arg of rest) expect(typeof arg).toBe("string");
    expect(rest).toEqual([adminErrorLabel(decorated)]);
    spy.mockRestore();
  });
});

// No DEMO_MODE gate any more (issue #419) — admin auth + a type-to-confirm
// body are the whole gate, same pattern reset already uses.
describe("POST /api/admin/seed", () => {
  const sreq = (confirm?: string) =>
    new Request("http://x/api/admin/seed", { method: "POST", body: JSON.stringify({ confirm }) });

  it("400 when the confirmation phrase is missing or wrong, without seeding", async () => {
    expect((await seedPOST(sreq(undefined))).status).toBe(400);
    expect((await seedPOST(sreq("seed"))).status).toBe(400);
    expect(seedDemoData).not.toHaveBeenCalled();
  });

  it("400, not a 500 crash, on a literal JSON null body", async () => {
    const res = await seedPOST(new Request("http://x/api/admin/seed", { method: "POST", body: "null" }));
    expect(res.status).toBe(400);
    expect(seedDemoData).not.toHaveBeenCalled();
  });

  it("403 for a non-admin, even with the right phrase", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    expect((await seedPOST(sreq("SEED"))).status).toBe(403);
    expect(seedDemoData).not.toHaveBeenCalled();
  });

  it("seeds and returns counts for an admin with the right phrase", async () => {
    seedDemoData.mockResolvedValue({ contestants: 6, teams: 3, solves: 128 });
    const res = await seedPOST(sreq("SEED"));
    expect(res.status).toBe(200);
    expect(seedDemoData).toHaveBeenCalledWith("alice");
    expect(await res.json()).toMatchObject({ contestants: 6, solves: 128 });
  });

  it("503 on a seed failure", async () => {
    seedDemoData.mockRejectedValue(new Error("upstash down"));
    expect((await seedPOST(sreq("SEED"))).status).toBe(503);
  });
});

describe("DELETE /api/admin/seed", () => {
  const dreq = (confirm?: string) =>
    new Request("http://x/api/admin/seed", { method: "DELETE", body: JSON.stringify({ confirm }) });

  it("400 when the confirmation phrase is missing or wrong, without clearing", async () => {
    expect((await seedDELETE(dreq(undefined))).status).toBe(400);
    expect((await seedDELETE(dreq("CLEAR"))).status).toBe(400);
    expect(clearDemoData).not.toHaveBeenCalled();
  });

  it("400, not a 500 crash, on a literal JSON null body", async () => {
    const res = await seedDELETE(new Request("http://x/api/admin/seed", { method: "DELETE", body: "null" }));
    expect(res.status).toBe(400);
    expect(clearDemoData).not.toHaveBeenCalled();
  });

  it("403 for a non-admin, even with the right phrase", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    expect((await seedDELETE(dreq("CLEAR DEMO DATA"))).status).toBe(403);
    expect(clearDemoData).not.toHaveBeenCalled();
  });

  it("clears and returns counts for an admin with the right phrase", async () => {
    clearDemoData.mockResolvedValue({ contestants: 6, teams: 3, sponsors: 3 });
    const res = await seedDELETE(dreq("CLEAR DEMO DATA"));
    expect(res.status).toBe(200);
    expect(clearDemoData).toHaveBeenCalledWith("alice");
    expect(await res.json()).toMatchObject({ contestants: 6, sponsors: 3 });
  });

  it("503 on a clear failure", async () => {
    clearDemoData.mockRejectedValue(new Error("upstash down"));
    expect((await seedDELETE(dreq("CLEAR DEMO DATA"))).status).toBe(503);
  });
});
