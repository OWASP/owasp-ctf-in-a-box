// Route-level tests for the admin roster. Auth, the grant reads, the revoke
// script and the profile read are mocked; the script itself is pinned by
// admin-claim.upstash.test.ts.
//
// The assertions that matter are the refusals: non-admins get nothing, and
// the last grant cannot be revoked through here.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listAdminGrants: vi.fn(),
  revokeAdmin: vi.fn(),
  getPlayerProfiles: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/admin-grants", () => ({ listAdminGrants: m.listAdminGrants }));
vi.mock("@/lib/admin-claim", () => ({ revokeAdmin: m.revokeAdmin }));
vi.mock("@/lib/admin-store", () => ({ adminErrorLabel: (e: unknown) => (e instanceof Error ? e.message : "x") }));
vi.mock("@/lib/player", async (orig) => ({
  ...(await orig<typeof import("@/lib/player")>()),
  getPlayerProfiles: m.getPlayerProfiles,
}));

import * as route from "@/app/api/admin/admins/route";
import { LAST_ADMIN } from "@/lib/admin-claim-copy";
import { actor } from "@/lib/__tests__/audit-actor";

const { DELETE, GET } = route;
const alice = actor("alice");
const bob = actor("bob");
const ghost = actor("ghost");

const req = (method: string, body?: unknown) =>
  new Request("http://x/api/admin/admins", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const profile = (a: { id: string; name: string }) => [a.id, { ...a, image: null, githubLogin: null }] as const;

beforeEach(() => {
  vi.clearAllMocks();
  m.requireAdmin.mockResolvedValue({ ok: true, player: { ...alice, image: null, githubLogin: null } });
  m.listAdminGrants.mockResolvedValue([alice.id, bob.id, ghost.id]);
  m.getPlayerProfiles.mockImplementation(async (ids: string[]) => {
    const known = new Map([profile(alice), profile(bob)]);
    return new Map(ids.filter((id) => known.has(id)).map((id) => [id, known.get(id)!]));
  });
  m.revokeAdmin.mockResolvedValue({ ok: true, grants: [alice.id] });
});

describe("gating", () => {
  it("refuses a non-admin on GET and DELETE, reading and writing nothing", async () => {
    m.requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    expect((await GET(req("GET"))).status).toBe(403);
    expect((await DELETE(req("DELETE", { id: bob.id }))).status).toBe(403);
    expect(m.listAdminGrants).not.toHaveBeenCalled();
    expect(m.revokeAdmin).not.toHaveBeenCalled();
  });

  it("has no POST: the only way in is a claim code", () => {
    expect("POST" in route).toBe(false);
  });
});

describe("GET", () => {
  it("maps ids to names, marks the viewer, and names an id with no profile", async () => {
    const res = await GET(req("GET"));
    expect(await res.json()).toEqual({
      admins: [
        { id: alice.id, name: "alice", self: true },
        { id: bob.id, name: "bob", self: false },
        { id: ghost.id, name: "(deleted account)", self: false },
      ],
    });
  });

  it("503s when the roster cannot be read", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.listAdminGrants.mockRejectedValue(new Error("redis down"));
    expect((await GET(req("GET"))).status).toBe(503);
    err.mockRestore();
  });
});

describe("DELETE", () => {
  it("revokes by id with the profile name as the audit target", async () => {
    const res = await DELETE(req("DELETE", { id: bob.id }));
    expect(res.status).toBe(200);
    expect(m.revokeAdmin).toHaveBeenCalledWith({ id: bob.id, name: "bob" }, { id: alice.id, name: "alice" });
    expect(await res.json()).toEqual({ admins: [{ id: alice.id, name: "alice", self: true }] });
  });

  it("409s the last admin with the copy that says what to do", async () => {
    m.revokeAdmin.mockResolvedValue({ ok: false, reason: "last-admin" });
    const res = await DELETE(req("DELETE", { id: alice.id }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: LAST_ADMIN });
  });

  it("404s an id that holds no grant", async () => {
    m.revokeAdmin.mockResolvedValue({ ok: false, reason: "not-admin" });
    expect((await DELETE(req("DELETE", { id: bob.id }))).status).toBe(404);
  });

  it("400s a GitHub login, a non-string or bad JSON without touching the store", async () => {
    for (const body of [{ id: "octocat" }, { id: 7 }, { login: bob.id }, "nope"]) {
      expect((await DELETE(req("DELETE", body))).status).toBe(400);
    }
    expect(m.revokeAdmin).not.toHaveBeenCalled();
  });

  it("503s when the revoke throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.revokeAdmin.mockRejectedValue(new Error("redis down"));
    expect((await DELETE(req("DELETE", { id: bob.id }))).status).toBe(503);
    err.mockRestore();
  });
});
