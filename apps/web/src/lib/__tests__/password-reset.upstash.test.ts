// Password reset codes (password-reset.ts) EXECUTED against a live Redis: the
// issue and consume scripts, and the password and session writes through the
// app's real better-auth instance. The keys are the real ones (`ctf:admin:`,
// `ctf:auth:`) because the functions build them; every id and code is fresh
// per test, and afterAll removes what the suite wrote. See live-redis.ts.
// Those writes land in the real audit list (trimmed to its cap) and the real
// account store, so the suite runs only against a throwaway Redis
// (destructiveLiveRedisAllowed in live-redis-guard.ts).

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { liveConfigured } from "./live-redis";
import { destructiveLiveRedisAllowed } from "./live-redis-guard";

vi.mock("server-only", () => ({}));

// auth.ts builds its instance at import; vi.hoisted runs before imports.
vi.hoisted(() => {
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef";
  process.env.GITHUB_CLIENT_ID ??= "test-client-id";
  process.env.GITHUB_CLIENT_SECRET ??= "test-client-secret";
});

const PW = "correct horse battery";

describe.skipIf(!liveConfigured || !destructiveLiveRedisAllowed())("password reset codes against a live Redis", () => {
  const users: string[] = [];
  const admins: string[] = [];

  async function load() {
    const reset = await import("@/lib/password-reset");
    const claim = await import("@/lib/admin-claim");
    const { ADMIN_GRANTS_KEY } = await import("@/lib/admin-grants");
    const { auth } = await import("@/lib/auth");
    const { upstashPipeline } = await import("@/lib/upstash");
    return { reset, claim, ADMIN_GRANTS_KEY, ctx: await auth.$context, pipeline: upstashPipeline };
  }

  async function redis(cmd: (string | number)[]): Promise<unknown> {
    const { pipeline } = await load();
    const [res] = await pipeline([cmd]);
    if (res.error) throw new Error(res.error);
    return res.result;
  }

  /** An admin who holds a grant. */
  async function admin() {
    const { ADMIN_GRANTS_KEY } = await load();
    const id = randomUUID();
    admins.push(id);
    await redis(["SADD", ADMIN_GRANTS_KEY, id]);
    return { id, name: "reset-admin" };
  }

  /** A GitHub player, with a password account too for `"password"`. */
  async function player(kind: "password" | "github") {
    const { ctx } = await load();
    const tag = randomUUID().slice(0, 8);
    const { user } = await ctx.internalAdapter.createOAuthUser(
      { name: `p${tag}`, email: `p${tag}@example.test`, emailVerified: true, image: null, login: `p${tag}` } as never,
      { providerId: "github", accountId: `gh-${tag}` } as never,
    );
    users.push(user.id);
    if (kind === "password") {
      await ctx.internalAdapter.linkAccount({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: await ctx.password.hash("old password 123"),
      });
    }
    return user.id;
  }

  async function passwordOf(userId: string): Promise<string | null> {
    const { ctx } = await load();
    const acc = (await ctx.internalAdapter.findAccounts(userId)).find((a) => a.providerId === "credential");
    return acc?.password ?? null;
  }

  afterAll(async () => {
    const { ctx, ADMIN_GRANTS_KEY, reset } = await load();
    for (const id of users) {
      await ctx.internalAdapter.deleteUserSessions(id);
      for (const a of await ctx.internalAdapter.findAccounts(id)) await ctx.internalAdapter.deleteAccount(a.id);
      await ctx.internalAdapter.deleteUser(id);
      await redis(["DEL", reset.resetPointerKey(id)]);
    }
    if (admins.length) await redis(["SREM", ADMIN_GRANTS_KEY, ...admins]);
  });

  it("issues a code stored under its hash for 900 s, with the player's pointer", async () => {
    const { reset, claim } = await load();
    const [by, who] = [await admin(), await player("password")];
    const { code } = await reset.issuePasswordResetCode(who, by);
    const hash = claim.hashClaimCode(claim.normalizeClaimCode(code)!);
    const [stored, ttl, pointer, pttl] = [
      JSON.parse((await redis(["GET", reset.resetCodeKey(hash)])) as string),
      (await redis(["TTL", reset.resetCodeKey(hash)])) as number,
      await redis(["GET", reset.resetPointerKey(who)]),
      (await redis(["TTL", reset.resetPointerKey(who)])) as number,
    ];
    expect(stored).toMatchObject({ player: who, by: by.id, name: by.name });
    expect(ttl).toBeGreaterThan(890);
    expect(ttl).toBeLessThanOrEqual(900);
    expect(pointer).toBe(hash);
    expect(pttl).toBeGreaterThan(890);
    await redis(["DEL", reset.resetCodeKey(hash)]);
  });

  it("issuing twice for the same player voids the first code", async () => {
    const { reset } = await load();
    const [by, who] = [await admin(), await player("password")];
    const first = await reset.issuePasswordResetCode(who, by);
    const second = await reset.issuePasswordResetCode(who, by);
    expect(await reset.redeemPasswordResetCode(first.code, PW)).toEqual({ ok: false, reason: "invalid" });
    expect(await reset.redeemPasswordResetCode(second.code, PW)).toEqual({ ok: true, player: who });
  });

  it("refuses a non-admin issuer and a player with no account, writing no code", async () => {
    const { reset, claim } = await load();
    const [by, who] = [await admin(), await player("password")];
    await expect(reset.issuePasswordResetCode(who, { id: randomUUID(), name: "x" })).rejects.toBeInstanceOf(claim.NotAdminError);
    const ghost = randomUUID();
    await expect(reset.issuePasswordResetCode(ghost, by)).rejects.toMatchObject({ name: "OpsValidationError", field: "id" });
    expect(await redis(["EXISTS", reset.resetPointerKey(who)])).toBe(0);
    expect(await redis(["EXISTS", reset.resetPointerKey(ghost)])).toBe(0);
  });

  it("refuses a player who holds an admin grant, writing no code and no audit line", async () => {
    const { reset, ADMIN_GRANTS_KEY } = await load();
    const by = await admin();
    const organizer = await player("password");
    admins.push(organizer);
    await redis(["SADD", ADMIN_GRANTS_KEY, organizer]);
    const auditBefore = await redis(["LINDEX", "ctf:admin:audit", 0]);
    const err = await reset.issuePasswordResetCode(organizer, by).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "OpsValidationError", field: "id" });
    expect((err as Error).message).toMatch(/ is an organizer\. Revoke their admin access first\.$/);
    expect(await redis(["EXISTS", reset.resetPointerKey(organizer)])).toBe(0);
    expect(await redis(["LINDEX", "ctf:admin:audit", 0])).toBe(auditBefore);
    // Once the grant is gone the same player can be given a code.
    await redis(["SREM", ADMIN_GRANTS_KEY, organizer]);
    await expect(reset.issuePasswordResetCode(organizer, by)).resolves.toMatchObject({ code: expect.any(String) });
  });

  it("a code issued before the player was granted admin is refused, consumed, and changes nothing", async () => {
    const { reset, ctx, ADMIN_GRANTS_KEY } = await load();
    const [by, who] = [await admin(), await player("password")];
    await ctx.internalAdapter.createSession(who);
    const sessions = `ctf:auth:session:by:userId:${who}`;
    const before = await passwordOf(who);
    const { code } = await reset.issuePasswordResetCode(who, by);
    admins.push(who);
    await redis(["SADD", ADMIN_GRANTS_KEY, who]);
    expect(await reset.redeemPasswordResetCode(code, PW)).toEqual({ ok: false, reason: "invalid" });
    expect(await passwordOf(who)).toBe(before);
    expect(await redis(["SCARD", sessions])).toBe(1);
    // Consumed: dropping the grant does not bring the code back.
    await redis(["SREM", ADMIN_GRANTS_KEY, who]);
    expect(await reset.redeemPasswordResetCode(code, PW)).toEqual({ ok: false, reason: "invalid" });
    expect(await passwordOf(who)).toBe(before);
  });

  it("a grant claimed after the consume and before the write is refused at the guard, and no password is written", async () => {
    const { reset, ctx, ADMIN_GRANTS_KEY, claim } = await load();
    const [by, who] = [await admin(), await player("password")];
    const before = await passwordOf(who);
    const { code } = await reset.issuePasswordResetCode(who, by);
    const original = ctx.password.hash;
    // The grant lands while the new password is hashed: after the consume's
    // organizer check, before the write.
    const spy = vi.spyOn(ctx.password, "hash").mockImplementationOnce(async (pw: string) => {
      admins.push(who);
      await redis(["SADD", ADMIN_GRANTS_KEY, who]);
      return original(pw);
    });
    try {
      expect(await reset.redeemPasswordResetCode(code, PW)).toEqual({ ok: false, reason: "invalid" });
    } finally {
      spy.mockRestore();
    }
    expect(await passwordOf(who)).toBe(before);
    expect(await redis(["EXISTS", claim.resetBusyKey(who)])).toBe(0);
  });

  it("an admin claim while the password is written is busy and spends no code, and works once the write is done", async () => {
    const { reset, ctx, claim } = await load();
    const [by, who] = [await admin(), await player("password")];
    const { code } = await reset.issuePasswordResetCode(who, by);
    const { code: adminCode } = await claim.issueAdminCode(by);
    const adminHash = claim.hashClaimCode(claim.normalizeClaimCode(adminCode)!);
    const original = ctx.internalAdapter.updateAccount.bind(ctx.internalAdapter);
    let midWrite: unknown;
    const spy = vi.spyOn(ctx.internalAdapter, "updateAccount").mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      midWrite = await claim.claimAdmin(adminCode, { id: who, name: "p" }, "").catch((e: Error) => e);
      return original(...args);
    });
    try {
      expect(await reset.redeemPasswordResetCode(code, PW)).toEqual({ ok: true, player: who });
    } finally {
      spy.mockRestore();
    }
    expect(midWrite).toBeInstanceOf(Error);
    expect((midWrite as Error).message).toMatch(/password reset/);
    // Nothing was consumed: the admin code is still there, and the busy key
    // is gone once the write is done.
    expect(await redis(["EXISTS", `${claim.ADMIN_CODE_PREFIX}${adminHash}`])).toBe(1);
    expect(await redis(["EXISTS", claim.resetBusyKey(who)])).toBe(0);
    admins.push(who);
    await expect(claim.claimAdmin(adminCode, { id: who, name: "p" }, "")).resolves.toEqual({ ok: true, via: "code" });
  });

  it("a code redeemed twice concurrently succeeds exactly once", async () => {
    const { reset } = await load();
    const [by, who] = [await admin(), await player("password")];
    const { code } = await reset.issuePasswordResetCode(who, by);
    const results = await Promise.all([
      reset.redeemPasswordResetCode(code, PW),
      reset.redeemPasswordResetCode(code, "another password 1"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "invalid" }]);
    expect(await redis(["EXISTS", reset.resetPointerKey(who)])).toBe(0);
  });

  it("sets the chosen password and empties the player's session set", async () => {
    const { reset, ctx } = await load();
    const [by, who] = [await admin(), await player("password")];
    await ctx.internalAdapter.createSession(who);
    await ctx.internalAdapter.createSession(who);
    const sessions = `ctf:auth:session:by:userId:${who}`;
    expect(await redis(["SCARD", sessions])).toBe(2);
    const { code } = await reset.issuePasswordResetCode(who, by);
    expect(await reset.redeemPasswordResetCode(code, PW)).toEqual({ ok: true, player: who });
    expect(await redis(["SCARD", sessions])).toBe(0);
    expect(await ctx.password.verify({ hash: (await passwordOf(who))!, password: PW })).toBe(true);
    const accounts = await ctx.internalAdapter.findAccounts(who);
    expect(accounts.filter((a) => a.providerId === "credential")).toHaveLength(1);
  });

  it("gives a provider-only player a credential account", async () => {
    const { reset, ctx } = await load();
    const [by, who] = [await admin(), await player("github")];
    expect(await passwordOf(who)).toBeNull();
    const { code } = await reset.issuePasswordResetCode(who, by);
    expect(await reset.redeemPasswordResetCode(code, PW)).toEqual({ ok: true, player: who });
    const accounts = await ctx.internalAdapter.findAccounts(who);
    expect(accounts.map((a) => a.providerId).sort()).toEqual(["credential", "github"]);
    expect(accounts.find((a) => a.providerId === "credential")!.accountId).toBe(who);
    expect(await ctx.password.verify({ hash: (await passwordOf(who))!, password: PW })).toBe(true);
  });

  it("a password out of range consumes nothing", async () => {
    const { reset } = await load();
    const [by, who] = [await admin(), await player("password")];
    const { code } = await reset.issuePasswordResetCode(who, by);
    expect(await reset.redeemPasswordResetCode(code, "short")).toEqual({ ok: false, reason: "password" });
    expect(await reset.redeemPasswordResetCode(code, PW)).toEqual({ ok: true, player: who });
  });

  it("a code whose issuer lost their grant is refused, and consumed", async () => {
    const { reset, ADMIN_GRANTS_KEY, claim } = await load();
    const [by, who] = [await admin(), await player("password")];
    const before = await passwordOf(who);
    const { code } = await reset.issuePasswordResetCode(who, by);
    await redis(["SREM", ADMIN_GRANTS_KEY, by.id]);
    expect(await reset.redeemPasswordResetCode(code, PW)).toEqual({ ok: false, reason: "invalid" });
    const hash = claim.hashClaimCode(claim.normalizeClaimCode(code)!);
    expect(await redis(["EXISTS", reset.resetCodeKey(hash)])).toBe(0);
    expect(await passwordOf(who)).toBe(before);
  });

  it("audits the issue and the use with the code id only", async () => {
    const { reset, claim } = await load();
    const [by, who] = [await admin(), await player("password")];
    const { code } = await reset.issuePasswordResetCode(who, by);
    const hash = claim.hashClaimCode(claim.normalizeClaimCode(code)!);
    await reset.redeemPasswordResetCode(code, PW);
    const lines = ((await redis(["LRANGE", "ctf:admin:audit", 0, 20])) as string[])
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.player === who);
    expect(lines.map((l) => l.action)).toEqual(["ops:password-reset-used", "ops:password-reset-code"]);
    expect(lines[0]).toMatchObject({ by: who, codeId: hash.slice(0, 8) });
    expect(lines[1]).toMatchObject({ by: by.id, name: by.name, codeId: hash.slice(0, 8) });
    const raw = JSON.stringify(lines);
    expect(raw).not.toContain(hash);
    expect(raw).not.toContain(claim.normalizeClaimCode(code)!);
  });
});
