// Route-level tests for the team captain + join-by-code API. Auth guard and
// the team store are both mocked — no Upstash or GitHub session needed.
//
// login is ALWAYS derived from the session server-side; none of these routes
// trust a client-supplied captain identity.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSession, joinTeam, createSoloTeam, removeMember, renameTeam, transferCaptain, disbandTeam, regenerateCode,
  consumeRateLimit,
} = vi.hoisted(
  () => ({
    getSession: vi.fn(),
    joinTeam: vi.fn(),
    createSoloTeam: vi.fn(),
    removeMember: vi.fn(),
    renameTeam: vi.fn(),
    transferCaptain: vi.fn(),
    disbandTeam: vi.fn(),
    regenerateCode: vi.fn(),
    consumeRateLimit: vi.fn(),
  }),
);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/team-store", () => ({
  joinTeam,
  createSoloTeam,
  removeMember,
  renameTeam,
  transferCaptain,
  disbandTeam,
  regenerateCode,
}));
// Mocked EXPLICITLY: the real module fails open on any Upstash error, so an
// unmocked import would make every test here silently exercise that error
// branch and still pass.
vi.mock("@/lib/rate-limit-store", () => ({
  consumeRateLimit,
  RATE_LIMITS: { teamJoin: { bucket: "team-join", limit: 10, windowSeconds: 600 } },
}));

import { POST as joinPOST } from "@/app/api/team/join/route";
import { POST as removePOST } from "@/app/api/team/remove/route";
import { POST as renamePOST } from "@/app/api/team/rename/route";
import { POST as transferPOST } from "@/app/api/team/transfer/route";
import { POST as disbandPOST } from "@/app/api/team/disband/route";
import { POST as regenPOST } from "@/app/api/team/regen-code/route";
import { POST as soloPOST } from "@/app/api/team/solo/route";

const req = (body?: unknown) => new Request("http://x/api/team/x", { method: "POST", body: JSON.stringify(body ?? {}) });

const SESSION = { user: { login: "alice" } };

beforeEach(() => {
  getSession.mockReset();
  joinTeam.mockReset();
  createSoloTeam.mockReset();
  removeMember.mockReset();
  renameTeam.mockReset();
  transferCaptain.mockReset();
  disbandTeam.mockReset();
  regenerateCode.mockReset();
  consumeRateLimit.mockReset();
  getSession.mockResolvedValue(SESSION);
  consumeRateLimit.mockResolvedValue({ allowed: true });
});

describe("POST /api/team/join rate limiting", () => {
  it("429s without testing the code once the budget is spent", async () => {
    consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 300 });
    const res = await joinPOST(req({ code: "abc123" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(joinTeam).not.toHaveBeenCalled();
  });

  it("charges the session login, not an IP header a caller controls", async () => {
    // An IP key would be spoofable (Caddy APPENDS to x-forwarded-for). This
    // route runs after getSession, so it keys on something a caller cannot
    // forge without forging the session.
    joinTeam.mockResolvedValue({ ok: true, team: { slug: "t" } });
    await joinPOST(req({ code: "abc123" }));
    expect(consumeRateLimit).toHaveBeenCalledWith("team-join", "alice", 10, 600);
  });

  it("does not charge a request that never had a code to test", async () => {
    const res = await joinPOST(req({}));
    expect(res.status).toBe(400);
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it("does not charge an unauthenticated caller", async () => {
    getSession.mockResolvedValue(null);
    await joinPOST(req({ code: "abc123" }));
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });
});

describe("POST /api/team/join", () => {
  it("401 for no session", async () => {
    getSession.mockResolvedValue(null);
    const res = await joinPOST(req({ code: "abc123" }));
    expect(res.status).toBe(401);
    expect(joinTeam).not.toHaveBeenCalled();
  });

  it("400 for a bad body (missing code)", async () => {
    const res = await joinPOST(req({}));
    expect(res.status).toBe(400);
    expect(joinTeam).not.toHaveBeenCalled();
  });

  it("400 when the store rejects the code", async () => {
    joinTeam.mockResolvedValue({ ok: false, error: "Invalid or expired join code" });
    const res = await joinPOST(req({ code: "bad999" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid or expired join code" });
  });

  it("200 on success, calling joinTeam(login, code)", async () => {
    joinTeam.mockResolvedValue({ ok: true, team: "the-avengers" });
    const res = await joinPOST(req({ code: "abc123" }));
    expect(res.status).toBe(200);
    expect(joinTeam).toHaveBeenCalledWith("alice", "abc123");
    expect(await res.json()).toMatchObject({ team: "the-avengers" });
  });
});

describe("POST /api/team/remove", () => {
  it("401 for no session", async () => {
    getSession.mockResolvedValue(null);
    const res = await removePOST(req({ slug: "s", member: "bob" }));
    expect(res.status).toBe(401);
    expect(removeMember).not.toHaveBeenCalled();
  });

  it("403 on a captain-guard failure", async () => {
    removeMember.mockResolvedValue({ ok: false, error: "Only the team captain can do that" });
    const res = await removePOST(req({ slug: "s", member: "bob" }));
    expect(res.status).toBe(403);
    expect(removeMember).toHaveBeenCalledWith("alice", "s", "bob");
  });

  it("200 on success", async () => {
    removeMember.mockResolvedValue({ ok: true, team: "s" });
    const res = await removePOST(req({ slug: "s", member: "bob" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ team: "s" });
  });
});

describe("POST /api/team/rename", () => {
  it("401 for no session", async () => {
    getSession.mockResolvedValue(null);
    const res = await renamePOST(req({ slug: "s", name: "New Name" }));
    expect(res.status).toBe(401);
    expect(renameTeam).not.toHaveBeenCalled();
  });

  it("403 on a captain-guard failure", async () => {
    renameTeam.mockResolvedValue({ ok: false, error: "Only the team captain can do that" });
    const res = await renamePOST(req({ slug: "s", name: "New Name" }));
    expect(res.status).toBe(403);
    expect(renameTeam).toHaveBeenCalledWith("alice", "s", "New Name");
  });

  it("200 on success", async () => {
    renameTeam.mockResolvedValue({ ok: true, team: "s" });
    const res = await renamePOST(req({ slug: "s", name: "New Name" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ team: "s" });
  });
});

describe("POST /api/team/transfer", () => {
  it("401 for no session", async () => {
    getSession.mockResolvedValue(null);
    const res = await transferPOST(req({ slug: "s", to: "bob" }));
    expect(res.status).toBe(401);
    expect(transferCaptain).not.toHaveBeenCalled();
  });

  it("403 on a captain-guard failure", async () => {
    transferCaptain.mockResolvedValue({ ok: false, error: "Only the team captain can do that" });
    const res = await transferPOST(req({ slug: "s", to: "bob" }));
    expect(res.status).toBe(403);
    expect(transferCaptain).toHaveBeenCalledWith("alice", "s", "bob");
  });

  it("200 on success", async () => {
    transferCaptain.mockResolvedValue({ ok: true, team: "s" });
    const res = await transferPOST(req({ slug: "s", to: "bob" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ team: "s" });
  });
});

describe("POST /api/team/disband", () => {
  it("401 for no session", async () => {
    getSession.mockResolvedValue(null);
    const res = await disbandPOST(req({ slug: "s" }));
    expect(res.status).toBe(401);
    expect(disbandTeam).not.toHaveBeenCalled();
  });

  it("403 on a captain-guard failure", async () => {
    disbandTeam.mockResolvedValue({ ok: false, error: "Only the team captain can do that" });
    const res = await disbandPOST(req({ slug: "s" }));
    expect(res.status).toBe(403);
    expect(disbandTeam).toHaveBeenCalledWith("alice", "s");
  });

  it("200 on success", async () => {
    disbandTeam.mockResolvedValue({ ok: true, team: null });
    const res = await disbandPOST(req({ slug: "s" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ team: null });
  });
});

describe("POST /api/team/regen-code", () => {
  it("401 for no session", async () => {
    getSession.mockResolvedValue(null);
    const res = await regenPOST(req({ slug: "s" }));
    expect(res.status).toBe(401);
    expect(regenerateCode).not.toHaveBeenCalled();
  });

  it("403 on a captain-guard failure", async () => {
    regenerateCode.mockResolvedValue({ ok: false, error: "Only the team captain can do that" });
    const res = await regenPOST(req({ slug: "s" }));
    expect(res.status).toBe(403);
    expect(regenerateCode).toHaveBeenCalledWith("alice", "s");
  });

  it("409 in demo mode", async () => {
    regenerateCode.mockResolvedValue({ ok: false, error: "Not available in demo mode" });
    const res = await regenPOST(req({ slug: "s" }));
    expect(res.status).toBe(409);
  });

  it("200 on success, returning the new code", async () => {
    regenerateCode.mockResolvedValue({ ok: true, team: "s", code: "newcod" });
    const res = await regenPOST(req({ slug: "s" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ team: "s", code: "newcod" });
  });
});

// --- one-click solo team (issue #153) ----------------------------------------
//
// A team is now required before anything scores, and a solo player is a team
// of one. The NAME is derived server-side from the session, so this route has
// no inputs at all — which is what keeps it from being a way to mint a team
// named after somebody else.

describe("POST /api/team/solo", () => {
  it("401s an unauthenticated request without touching the store", async () => {
    getSession.mockResolvedValue(null);
    const res = await soloPOST(req());
    expect(res.status).toBe(401);
    expect(createSoloTeam).not.toHaveBeenCalled();
  });

  it("400s a session with no GitHub login, without touching the store", async () => {
    getSession.mockResolvedValue({ user: {} });
    const res = await soloPOST(req());
    expect(res.status).toBe(400);
    expect(createSoloTeam).not.toHaveBeenCalled();
  });

  it("names the team from the SESSION, ignoring anything in the body", async () => {
    createSoloTeam.mockResolvedValue({ ok: true, team: "alice" });
    await soloPOST(req({ login: "mallory", name: "mallorys-team" }));
    expect(createSoloTeam).toHaveBeenCalledWith("alice");
    expect(createSoloTeam).toHaveBeenCalledTimes(1);
  });

  it("works with no body at all — there is nothing to send", async () => {
    createSoloTeam.mockResolvedValue({ ok: true, team: "alice" });
    const res = await soloPOST(new Request("http://x/api/team/solo", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ team: "alice" });
  });

  it("400s with the store's own message when it refuses", async () => {
    createSoloTeam.mockResolvedValue({ ok: false, error: "Registration is closed" });
    const res = await soloPOST(req());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Registration is closed" });
  });
});
