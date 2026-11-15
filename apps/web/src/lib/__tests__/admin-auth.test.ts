import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn<(o: { headers: Headers }) => Promise<unknown>>(),
  isAdminGrantee: vi.fn<(id: string) => Promise<boolean>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/admin-grants", () => ({ isAdminGrantee: mocks.isAdminGrantee }));

import { isAdminPlayer, requireAdmin } from "@/lib/admin-auth";

const { getSession, isAdminGrantee } = mocks;

const ID = "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f";
const h = new Headers();

beforeEach(() => {
  getSession.mockReset();
  isAdminGrantee.mockReset();
  isAdminGrantee.mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireAdmin", () => {
  it("admits a player holding a grant", async () => {
    isAdminGrantee.mockResolvedValue(true);
    getSession.mockResolvedValue({ user: { id: ID, name: "Alice" } });
    expect(await requireAdmin(h)).toEqual({ ok: true, player: expect.objectContaining({ id: ID }) });
    expect(isAdminGrantee).toHaveBeenCalledWith(ID);
  });

  it("403s a signed-in player with no grant", async () => {
    getSession.mockResolvedValue({ user: { id: ID } });
    expect(await requireAdmin(h)).toEqual({ ok: false, status: 403 });
  });

  it("401s signed out without touching Redis", async () => {
    getSession.mockResolvedValue(null);
    expect(await requireAdmin(h)).toEqual({ ok: false, status: 401 });
    expect(isAdminGrantee).not.toHaveBeenCalled();
  });

  // Stores are keyed by a kit player id; a session without one is not a
  // player to act as, admin or not.
  it("401s when the session user id is not a player id", async () => {
    getSession.mockResolvedValue({ user: { id: "alice", login: "alice" } });
    expect(await requireAdmin(h)).toEqual({ ok: false, status: 401 });
  });

  // An access check fails CLOSED: an unreachable datastore denies. The
  // manual-freeze read fails open instead, because a safety switch and an
  // access check want opposite defaults.
  it("403s when the grant read throws", async () => {
    isAdminGrantee.mockRejectedValue(new Error("redis down"));
    getSession.mockResolvedValue({ user: { id: ID } });
    expect(await requireAdmin(h)).toEqual({ ok: false, status: 403 });
  });

  it("ignores the GitHub login entirely", async () => {
    getSession.mockResolvedValue({ user: { id: ID, login: "octocat" } });
    expect((await requireAdmin(h)).ok).toBe(false);
    expect(isAdminGrantee).toHaveBeenCalledWith(ID);
  });

  it("ADMIN_LOGINS in the environment grants nothing", async () => {
    vi.stubEnv("ADMIN_LOGINS", "octocat");
    getSession.mockResolvedValue({ user: { id: ID, login: "octocat" } });
    expect((await requireAdmin(h)).ok).toBe(false);
  });
});

describe("isAdminPlayer", () => {
  it("is false for undefined or a non-UUID without Redis", async () => {
    expect(await isAdminPlayer(undefined)).toBe(false);
    expect(await isAdminPlayer("octocat")).toBe(false);
    expect(isAdminGrantee).not.toHaveBeenCalled();
  });

  it("asks the roster for a player id", async () => {
    isAdminGrantee.mockResolvedValue(true);
    expect(await isAdminPlayer(ID)).toBe(true);
  });

  it("propagates a read failure for the caller's fail direction", async () => {
    isAdminGrantee.mockRejectedValue(new Error("redis down"));
    await expect(isAdminPlayer(ID)).rejects.toThrow("redis down");
  });
});
