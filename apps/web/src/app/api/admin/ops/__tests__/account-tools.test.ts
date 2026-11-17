// Admin account tools (issue #740): the reset-code, rename and unlink actions
// on the per-player route, the player GitHub login on the lookup, and the
// delete-all-accounts route. The stores are mocked; what these pin is the
// boundary: who may call, the error mapping, and the Secure Development gate.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireAdmin,
  lookupUser,
  renameUser,
  unlinkGithub,
  deleteAllAccounts,
  issuePasswordResetCode,
  getEnabledModuleIds,
  OpsValidationError,
  NotAdminError,
} = vi.hoisted(() => {
  class OpsValidationError extends Error {
    field: string;
    constructor(field: string, message: string) {
      super(message);
      this.field = field;
    }
  }
  class NotAdminError extends Error {}
  return {
    requireAdmin: vi.fn(),
    lookupUser: vi.fn(),
    renameUser: vi.fn(),
    unlinkGithub: vi.fn(),
    deleteAllAccounts: vi.fn(),
    issuePasswordResetCode: vi.fn(),
    getEnabledModuleIds: vi.fn(),
    OpsValidationError,
    NotAdminError,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/admin-ops-store", () => ({
  lookupUser,
  renameUser,
  unlinkGithub,
  deleteAllAccounts,
  resetUserProgress: vi.fn(),
  deleteUser: vi.fn(),
  OpsValidationError,
}));
vi.mock("@/lib/password-reset", () => ({ issuePasswordResetCode }));
vi.mock("@/lib/admin-claim", () => ({ NotAdminError }));
vi.mock("@/lib/enabled-modules", () => ({ getEnabledModuleIds }));

import { GET, POST } from "@/app/api/admin/ops/user/route";
import { DELETE as accountsDELETE } from "@/app/api/admin/ops/accounts/route";

const OCTO = "0c7aca70-0000-4000-8000-00000000000a";
const ALICE = { id: "a11ce000-0000-4000-8000-00000000000c", name: "Alice A.", image: null, githubLogin: "alice" };
const ACTOR = { id: ALICE.id, name: "Alice A." };
const req = (method: string, body?: unknown) =>
  new Request("http://x/api", { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ ok: true, login: "alice", player: ALICE });
  getEnabledModuleIds.mockResolvedValue(new Set(["secure-development"]));
  lookupUser.mockResolvedValue({ id: OCTO, github: { login: "octo", linkedAt: 5 } });
  issuePasswordResetCode.mockResolvedValue({ code: "aaaa-bbbb", expiresAt: "2026-11-16T10:15:00.000Z" });
  renameUser.mockResolvedValue({ from: "old", to: "new" });
  unlinkGithub.mockResolvedValue({ login: "octo" });
  deleteAllAccounts.mockResolvedValue({ cleared: { keys: 3 } });
});

describe("non-admin", () => {
  it("403s every new action without touching a store", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    const calls = [
      POST(req("POST", { id: OCTO, action: "reset-code" })),
      POST(req("POST", { id: OCTO, action: "rename", username: "x" })),
      POST(req("POST", { id: OCTO, action: "unlink-github" })),
      accountsDELETE(req("DELETE", { confirm: "delete all accounts" })),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
    expect(issuePasswordResetCode).not.toHaveBeenCalled();
    expect(renameUser).not.toHaveBeenCalled();
    expect(unlinkGithub).not.toHaveBeenCalled();
    expect(deleteAllAccounts).not.toHaveBeenCalled();
  });
});

describe("reset-code", () => {
  it("issues a code as the acting admin and returns it", async () => {
    const res = await POST(req("POST", { id: OCTO, action: "reset-code" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "aaaa-bbbb", expiresAt: "2026-11-16T10:15:00.000Z" });
    expect(issuePasswordResetCode).toHaveBeenCalledWith(OCTO, ACTOR);
  });
  it("maps a validation error to 400 with its field", async () => {
    issuePasswordResetCode.mockRejectedValueOnce(new OpsValidationError("id", "No player with that id"));
    const res = await POST(req("POST", { id: OCTO, action: "reset-code" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No player with that id", field: "id" });
  });
  it("403s an actor whose grant vanished mid-request", async () => {
    issuePasswordResetCode.mockRejectedValueOnce(new NotAdminError());
    expect((await POST(req("POST", { id: OCTO, action: "reset-code" }))).status).toBe(403);
  });
  it("fails closed with 503 on a store error", async () => {
    issuePasswordResetCode.mockRejectedValueOnce(new Error("boom"));
    expect((await POST(req("POST", { id: OCTO, action: "reset-code" }))).status).toBe(503);
  });
});

describe("rename", () => {
  it("renames through the store", async () => {
    const res = await POST(req("POST", { id: OCTO, action: "rename", username: " new " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: "old", to: "new" });
    expect(renameUser).toHaveBeenCalledWith(OCTO, " new ", ACTOR);
  });
  it("400s a non-string username without calling the store", async () => {
    const res = await POST(req("POST", { id: OCTO, action: "rename", username: 5 }));
    expect(res.status).toBe(400);
    expect(renameUser).not.toHaveBeenCalled();
  });
  it("maps a taken name to 400 on the username field", async () => {
    renameUser.mockRejectedValueOnce(new OpsValidationError("username", "That username is taken."));
    const res = await POST(req("POST", { id: OCTO, action: "rename", username: "bob" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "username" });
  });
});

describe("unlink-github", () => {
  it("unlinks when Secure Development is on", async () => {
    const res = await POST(req("POST", { id: OCTO, action: "unlink-github" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "octo" });
    expect(unlinkGithub).toHaveBeenCalledWith(OCTO, ACTOR);
  });
  it("is refused with 400 when Secure Development is off", async () => {
    getEnabledModuleIds.mockResolvedValue(new Set(["quiz"]));
    const res = await POST(req("POST", { id: OCTO, action: "unlink-github" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Secure Development is off." });
    expect(unlinkGithub).not.toHaveBeenCalled();
  });
  it("maps the store's refusal copy to 400", async () => {
    unlinkGithub.mockRejectedValueOnce(new OpsValidationError("id", "This GitHub link has scored and cannot be removed."));
    const res = await POST(req("POST", { id: OCTO, action: "unlink-github" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "This GitHub link has scored and cannot be removed." });
  });
});

describe("lookup github login", () => {
  it("returns the link when Secure Development is on", async () => {
    const res = await GET(new Request(`http://x/api?id=${OCTO}`));
    expect((await res.json()).github).toEqual({ login: "octo", linkedAt: 5 });
  });
  it("hides it when Secure Development is off", async () => {
    getEnabledModuleIds.mockResolvedValue(new Set());
    const res = await GET(new Request(`http://x/api?id=${OCTO}`));
    expect((await res.json()).github).toBeNull();
  });
});

describe("unknown action", () => {
  it("still 400s", async () => {
    expect((await POST(req("POST", { id: OCTO, action: "nope" }))).status).toBe(400);
  });
});

describe("DELETE /api/admin/ops/accounts", () => {
  it("deletes every account with the typed confirmation", async () => {
    const res = await accountsDELETE(req("DELETE", { confirm: "delete all accounts" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: { keys: 3 } });
    expect(deleteAllAccounts).toHaveBeenCalledWith("delete all accounts", ACTOR);
  });
  it("maps a wrong confirmation to 400", async () => {
    deleteAllAccounts.mockRejectedValueOnce(new OpsValidationError("confirm", "Type delete all accounts to confirm."));
    const res = await accountsDELETE(req("DELETE", { confirm: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Type delete all accounts to confirm.", field: "confirm" });
  });
  it("400s a body with no string confirm", async () => {
    const res = await accountsDELETE(req("DELETE", {}));
    expect(res.status).toBe(400);
  });
  it("fails closed with 503 on a store error", async () => {
    deleteAllAccounts.mockRejectedValueOnce(new Error("boom"));
    expect((await accountsDELETE(req("DELETE", { confirm: "delete all accounts" }))).status).toBe(503);
  });
});
