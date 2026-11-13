import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn<(o: { headers: Headers }) => Promise<unknown>>(),
  listStoredAdmins: vi.fn<() => Promise<string[]>>(),
  envAdmins: vi.fn<() => ReadonlySet<string>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/bootstrap-env", () => ({ envAdmins: mocks.envAdmins }));
vi.mock("@/lib/admin-admins", () => ({ listStoredAdmins: mocks.listStoredAdmins }));

const { getSession, listStoredAdmins, envAdmins } = mocks;

const ID = "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f";

// admin-auth.ts reads envAdmins() ONCE at module load (same shape as the
// baked set it replaced — ADMIN_LOGINS is process config, not something that
// changes without a restart), so each describe block below sets the mock's
// return value and then imports the module fresh via `vi.resetModules()`.
async function loadAdminAuth(admins: readonly string[]) {
  vi.resetModules();
  envAdmins.mockReturnValue(new Set(admins.map((a) => a.toLowerCase())));
  return import("@/lib/admin-auth");
}

beforeEach(() => {
  getSession.mockReset();
  listStoredAdmins.mockReset();
  envAdmins.mockReset();
  listStoredAdmins.mockResolvedValue([]);
});

describe("isEnvAdmin / listEnvAdmins", () => {
  it("matches case-insensitively and never touches the store", async () => {
    const { isEnvAdmin } = await loadAdminAuth(["Alice", "bob"]);
    expect(isEnvAdmin("alice")).toBe(true);
    expect(isEnvAdmin("BOB")).toBe(true);
    expect(isEnvAdmin("carol")).toBe(false);
    expect(isEnvAdmin(undefined)).toBe(false);
    // The point of the sync check: it answers without Redis, so an env
    // admin can still get in while the datastore is down.
    expect(listStoredAdmins).not.toHaveBeenCalled();
  });

  it("lists the env set, lowercased and sorted, for the panel to mark as unremovable", async () => {
    const { listEnvAdmins } = await loadAdminAuth(["Bob", "Alice"]);
    expect(listEnvAdmins()).toEqual(["alice", "bob"]);
  });
});

describe("isAdminLogin", () => {
  it("matches an env admin case-insensitively", async () => {
    const { isAdminLogin } = await loadAdminAuth(["Alice"]);
    expect(await isAdminLogin("alice")).toBe(true);
    expect(await isAdminLogin("ALICE")).toBe(true);
    expect(await isAdminLogin(undefined)).toBe(false);
  });

  it("refuses a login that is neither an env admin nor granted, without needing the store to say so", async () => {
    const { isAdminLogin } = await loadAdminAuth(["Alice"]);
    listStoredAdmins.mockResolvedValue([]);
    expect(await isAdminLogin("bob")).toBe(false);
  });

  it("admits a runtime grant that is not an env admin, as long as ADMIN_LOGINS is non-empty", async () => {
    const { isAdminLogin } = await loadAdminAuth(["Alice"]);
    listStoredAdmins.mockResolvedValue(["carol"]);
    expect(await isAdminLogin("carol")).toBe(true);
    expect(await isAdminLogin("CAROL")).toBe(true);
    expect(await isAdminLogin("dave")).toBe(false);
  });

  // THE ONE THAT MATTERS FOR CONFIG V2. An empty ADMIN_LOGINS is not "no
  // restriction configured" — it is "nobody", full stop, even someone
  // granted admin at runtime before the allowlist was cleared.
  it("refuses EVERYONE, including a runtime grant, when ADMIN_LOGINS is empty", async () => {
    const { isAdminLogin } = await loadAdminAuth([]);
    listStoredAdmins.mockResolvedValue(["alice"]);
    expect(await isAdminLogin("alice")).toBe(false);
    // The fail-closed path never needs the store.
    expect(listStoredAdmins).not.toHaveBeenCalled();
  });
});

describe("requireAdmin", () => {
  it("401 with no session", async () => {
    const { requireAdmin } = await loadAdminAuth(["Alice"]);
    getSession.mockResolvedValue(null);
    expect(await requireAdmin(new Headers())).toEqual({ ok: false, status: 401 });
  });

  // Stores are keyed by a kit player id; a session without one is not a
  // player to act as, admin or not.
  it("401 when the session user id is not a player id", async () => {
    const { requireAdmin } = await loadAdminAuth(["Alice"]);
    getSession.mockResolvedValue({ user: { id: "alice", login: "alice" } });
    expect(await requireAdmin(new Headers())).toEqual({ ok: false, status: 401 });
  });

  it("403 when the login is neither an env admin nor granted", async () => {
    const { requireAdmin } = await loadAdminAuth(["Alice"]);
    getSession.mockResolvedValue({ user: { id: ID, login: "carol" } });
    expect(await requireAdmin(new Headers())).toEqual({ ok: false, status: 403 });
  });

  it("403 when the session has no GitHub login at all", async () => {
    const { requireAdmin } = await loadAdminAuth(["Alice"]);
    getSession.mockResolvedValue({ user: { id: ID } });
    expect(await requireAdmin(new Headers())).toEqual({ ok: false, status: 403 });
  });

  it("passes an env-admin login (case-insensitive)", async () => {
    const { requireAdmin } = await loadAdminAuth(["Alice"]);
    getSession.mockResolvedValue({ user: { id: ID, login: "ALICE" } });
    expect(await requireAdmin(new Headers())).toEqual({ ok: true, login: "ALICE", player: expect.objectContaining({ id: ID, githubLogin: "ALICE" }) });
  });

  it("passes a runtime-granted login", async () => {
    const { requireAdmin } = await loadAdminAuth(["Alice"]);
    listStoredAdmins.mockResolvedValue(["carol"]);
    getSession.mockResolvedValue({ user: { id: ID, login: "Carol" } });
    expect(await requireAdmin(new Headers())).toEqual({ ok: true, login: "Carol", player: expect.objectContaining({ id: ID, githubLogin: "Carol" }) });
  });

  // THE ONE THAT MATTERS. admin-auth gates access, so an unreachable datastore
  // must DENY. This is deliberately the opposite of the manual-freeze read in
  // admin-store, which fails OPEN so a Redis blip cannot drop live
  // submissions — a safety switch and an access check want opposite defaults.
  it("403 — not 200 — when the store is unreachable", async () => {
    const { requireAdmin } = await loadAdminAuth(["Alice"]);
    listStoredAdmins.mockRejectedValue(new Error("redis down"));
    getSession.mockResolvedValue({ user: { id: ID, login: "carol" } });
    expect(await requireAdmin(new Headers())).toEqual({ ok: false, status: 403 });
  });

  it("still admits an ENV admin when the store is unreachable", async () => {
    // The recovery path: a login in ADMIN_LOGINS can reach /admin precisely
    // when Redis is broken, which is when they most need to.
    const { requireAdmin } = await loadAdminAuth(["Alice"]);
    listStoredAdmins.mockRejectedValue(new Error("redis down"));
    getSession.mockResolvedValue({ user: { id: ID, login: "alice" } });
    expect(await requireAdmin(new Headers())).toEqual({ ok: true, login: "alice", player: expect.objectContaining({ id: ID, githubLogin: "alice" }) });
  });

  // Config v2: an empty ADMIN_LOGINS refuses even a runtime-granted admin,
  // and never needs to ask the store.
  it("403s a runtime grant when ADMIN_LOGINS is empty, without touching the store", async () => {
    const { requireAdmin } = await loadAdminAuth([]);
    listStoredAdmins.mockResolvedValue(["alice"]);
    getSession.mockResolvedValue({ user: { id: ID, login: "alice" } });
    expect(await requireAdmin(new Headers())).toEqual({ ok: false, status: 403 });
    expect(listStoredAdmins).not.toHaveBeenCalled();
  });
});
