// /api/board/recent-solves — the projector feed's public route (#542).
// The pins: launch lock BEFORE any read, no-store for a polling surface,
// a clean 503 on a failed read, and a payload that is exactly the public
// projection (no login/id/slug fields ride along).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  requireLaunchedApi: vi.fn(),
  listRecentSolves: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/launch", () => ({ requireLaunchedApi: mocks.requireLaunchedApi }));
vi.mock("@/lib/recent-solves", () => ({ listRecentSolves: mocks.listRecentSolves }));

import { GET } from "@/app/api/board/recent-solves/route";

const ITEM = {
  team: "Red Team",
  title: "Robots Only",
  module: "classic" as const,
  points: 50,
  at: "2026-08-24T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(null);
  mocks.requireLaunchedApi.mockResolvedValue(null);
  mocks.listRecentSolves.mockResolvedValue([ITEM]);
});

describe("GET /api/board/recent-solves", () => {
  it("returns the projection with no-store and never reads before the launch lock", async () => {
    const res = await GET(new Request("http://box/api/board/recent-solves"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ solves: [ITEM] });
    expect(mocks.listRecentSolves).toHaveBeenCalledWith(5);
    expect(mocks.requireLaunchedApi.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.listRecentSolves.mock.invocationCallOrder[0],
    );
  });

  it("passes a signed-in login to the launch lock, so an admin preview loads", async () => {
    mocks.getSession.mockResolvedValue({ user: { login: "alice" } });
    await GET(new Request("http://box/api/board/recent-solves"));
    expect(mocks.requireLaunchedApi).toHaveBeenCalledWith("alice");
  });

  it("returns the guard's refusal untouched and reads nothing", async () => {
    const refused = new Response(JSON.stringify({ error: "not-launched" }), { status: 403 });
    mocks.requireLaunchedApi.mockResolvedValue(refused);
    const res = await GET(new Request("http://box/api/board/recent-solves"));
    expect(res).toBe(refused);
    expect(mocks.listRecentSolves).not.toHaveBeenCalled();
  });

  it("503s with a generic body when the feed read fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.listRecentSolves.mockRejectedValue(new Error("NOAUTH"));
    try {
      const res = await GET(new Request("http://box/api/board/recent-solves"));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
