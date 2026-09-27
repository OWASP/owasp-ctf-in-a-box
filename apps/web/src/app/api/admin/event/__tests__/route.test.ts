import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  // A real (not mocked) Error subclass, so `err instanceof EventLiveError` in
  // the route sees the exact same class the test rejects with — mirrors the
  // ClassicValidationError pattern in the classic route test. Declared
  // inside `vi.hoisted` (not at module top level) because `vi.mock` factories
  // below are hoisted above ordinary top-level statements, and referencing a
  // not-yet-hoisted class from inside them throws a TDZ error.
  class FakeLive extends Error {}
  return {
    requireAdmin: vi.fn(), exportEventBundle: vi.fn(), importEventBundle: vi.fn(),
    upstashPipeline: vi.fn(), FakeLive,
  };
});
const FakeLive = h.FakeLive;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: h.upstashPipeline }));
vi.mock("@/lib/event-store", () => ({
  exportEventBundle: h.exportEventBundle, importEventBundle: h.importEventBundle, EventLiveError: h.FakeLive,
}));

import { EVENT_IMPORT_MAX_BYTES, GET, POST } from "@/app/api/admin/event/route";

const post = (body: unknown) =>
  new Request("http://box.test/api/admin/event", { method: "POST", body: JSON.stringify(body) });

const validRaw = JSON.stringify({
  version: 1, kind: "archive", event: { name: "Demo" },
  settings: { hintCost: 10 }, quiz: { version: 1, questions: [] },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, login: "alice" });
  h.upstashPipeline.mockResolvedValue([]);
  h.exportEventBundle.mockResolvedValue({ bundle: { version: 1 }, warnings: [] });
  h.importEventBundle.mockResolvedValue({ summary: {}, skipped: [] });
});

describe("GET /api/admin/event", () => {
  it("403s a non-admin and never exports", async () => {
    h.requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    const res = await GET(new Request("http://box.test/api/admin/event"));
    expect(res.status).toBe(403);
    expect(h.exportEventBundle).not.toHaveBeenCalled();
  });
  it("returns the bundle and warnings for an admin", async () => {
    const res = await GET(new Request("http://box.test/api/admin/event"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bundle: { version: 1 }, warnings: [] });
  });
});

describe("POST /api/admin/event — bounded body (#186)", () => {
  it("413s a declared body over the archive cap before reading or parsing it", async () => {
    const req = new Request("http://x/api/admin/event", {
      method: "POST",
      body: JSON.stringify({ import: validRaw }),
      headers: { "content-type": "application/json", "content-length": String(EVENT_IMPORT_MAX_BYTES + 1) },
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/MB/);
  });

  it("sizes the cap for a full event of attachments as base64, plus headroom", () => {
    expect(EVENT_IMPORT_MAX_BYTES).toBeGreaterThan(Math.ceil((50 * 1024 * 1024 * 4) / 3));
  });
});

describe("POST /api/admin/event", () => {
  it("403s a non-admin and never imports", async () => {
    h.requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    const res = await POST(post({ import: validRaw }));
    expect(res.status).toBe(403);
    expect(h.importEventBundle).not.toHaveBeenCalled();
  });
  it("400s a malformed bundle and does not import", async () => {
    const res = await POST(post({ import: "{not json" }));
    expect(res.status).toBe(400);
    expect(h.importEventBundle).not.toHaveBeenCalled();
  });
  it("rejects a body with extra keys", async () => {
    const res = await POST(post({ import: validRaw, sneaky: 1 }));
    expect(res.status).toBe(400);
  });
  it("imports a valid bundle and writes an audit entry", async () => {
    const res = await POST(post({ import: validRaw }));
    expect(res.status).toBe(200);
    expect(h.importEventBundle).toHaveBeenCalledWith(expect.objectContaining({ kind: "archive" }), "alice");
    // upstashPipeline is called with ONE argument — the two-command array
    // `[["LPUSH", key, audit], ["LTRIM", key, 0, cap - 1]]` (see
    // `writeAudit`) — so `mock.calls` nests four levels deep (calls -> args
    // -> commands -> command); `flat(3)` is what reaches the bare strings.
    // The LPUSH's audit arg is the full JSON-stringified line, not a bare
    // "event-import" element, so this checks for a string CONTAINING the
    // action, the same substring style the classic route test uses
    // (`.toContain(...)` on the stringified audit line).
    const audited = h.upstashPipeline.mock.calls
      .flat(3)
      .some((x) => typeof x === "string" && x.includes("event-import"));
    expect(audited).toBe(true);
  });
  it("maps a live-event import to 409", async () => {
    h.importEventBundle.mockRejectedValue(new FakeLive("live"));
    const res = await POST(post({ import: validRaw }));
    expect(res.status).toBe(409);
  });
  // Finding B: parseEventBundle only checks the bundle's policy keys against
  // the allowlist, not their value types, so a wrong-typed value (e.g. a
  // string hintCost) only surfaces once updateAdminSettings validates it,
  // inside importEventBundle — as a real AdminValidationError, imported here
  // (not mocked) the same way admin/__tests__/routes.test.ts does, so
  // `err instanceof AdminValidationError` in the route matches for real.
  it("maps an AdminValidationError from a bad-but-allowlisted field to 400, without auditing", async () => {
    const { AdminValidationError } = await import("@/lib/admin-store");
    h.importEventBundle.mockRejectedValue(new AdminValidationError("hintCost", "hintCost must be an integer"));
    const res = await POST(post({ import: validRaw }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "hintCost must be an integer", field: "hintCost" });
    expect(h.upstashPipeline).not.toHaveBeenCalled();
  });
});
