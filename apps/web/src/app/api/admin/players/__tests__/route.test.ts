// GET /api/admin/players?q= — the Support tab's search. Admin-gated and fail
// closed; it answers only what a row needs to be picked (id, name, image).

import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, findPlayers } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findPlayers: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/player", () => ({ findPlayers }));

import { GET } from "@/app/api/admin/players/route";
import { decoratedError, expectLabelOnly } from "@/lib/__tests__/log-redaction";

const req = (query = "") => new Request(`http://x/api/admin/players${query}`);
const OCTO = { id: "0c7aca70-0000-4000-8000-00000000000a", name: "octocat", image: "http://img", githubLogin: "OctoCat" };

beforeEach(() => {
  requireAdmin.mockReset();
  findPlayers.mockReset();
  requireAdmin.mockResolvedValue({ ok: true, login: "alice", player: { id: "a11ce000-0000-4000-8000-00000000000c", name: "alice", image: null, githubLogin: "alice" } });
  findPlayers.mockResolvedValue([OCTO]);
});

describe("GET /api/admin/players", () => {
  it.each([401, 403])("refuses with the gate's own %i and never searches", async (status) => {
    requireAdmin.mockResolvedValue({ ok: false, status });
    const res = await GET(req("?q=oct"));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(findPlayers).not.toHaveBeenCalled();
  });

  it("fails closed when the gate itself throws", async () => {
    requireAdmin.mockRejectedValue(new Error("redis down"));
    await expect(GET(req("?q=oct"))).rejects.toThrow();
    expect(findPlayers).not.toHaveBeenCalled();
  });

  it("answers id, name and image only — never the GitHub login", async () => {
    const res = await GET(req("?q=oct"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ players: [{ id: OCTO.id, name: "octocat", image: "http://img" }] });
    expect(findPlayers).toHaveBeenCalledWith("oct");
  });

  it("trims the query", async () => {
    await GET(req("?q=%20oct%20"));
    expect(findPlayers).toHaveBeenCalledWith("oct");
  });

  it.each(["", "?q=", "?q=%20%20", `?q=${"x".repeat(65)}`])("400s a blank or oversized query %j", async (query) => {
    const res = await GET(req(query));
    expect(res.status).toBe(400);
    expect(findPlayers).not.toHaveBeenCalled();
  });

  it("503s a store failure, logging its label only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      findPlayers.mockRejectedValue(decoratedError("redis exploded"));
      const res = await GET(req("?q=oct"));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
      expectLabelOnly(spy, { label: "redis exploded" });
    } finally {
      spy.mockRestore();
    }
  });
});
