// Password reset codes: what the writers hand Redis and the auth store. The
// Upstash seam and better-auth are mocked, so this pins the contract with the
// scripts; the live suite (password-reset.upstash.test.ts) pins what the
// scripts and the auth store do with it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  upstashEval: vi.fn(),
  upstashPipeline: vi.fn(),
  ia: {
    findUserById: vi.fn(),
    findAccounts: vi.fn(),
    updateAccount: vi.fn(),
    linkAccount: vi.fn(),
    deleteUserSessions: vi.fn(),
  },
  hash: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/upstash")>()),
  upstashEval: m.upstashEval,
  upstashPipeline: m.upstashPipeline,
}));
vi.mock("@/lib/auth", () => ({
  auth: { $context: Promise.resolve({ internalAdapter: m.ia, password: { hash: m.hash } }) },
}));

import { hashClaimCode, normalizeClaimCode, NotAdminError } from "@/lib/admin-claim";
import { ADMIN_AUDIT_KEY } from "@/lib/admin-audit-keys";
import { ADMIN_GRANTS_KEY } from "@/lib/admin-grants";
import { OpsValidationError } from "@/lib/ops-errors";
import {
  issuePasswordResetCode,
  redeemPasswordResetCode,
  RESET_CODE_PREFIX,
  resetCodeKey,
  resetPointerKey,
} from "@/lib/password-reset";
import { ALICE, actor } from "./audit-actor";

const BOB = actor("bob");
const CODE = "0123-4567-89ab-cdef-0123-4567-89ab-cdef";
const PLAIN = "0123456789abcdef0123456789abcdef";
const HASH = "3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9";
const PW = "correct horse battery";

/** The pipeline replies, in call order; anything past them is an empty OK. */
function pipelineReplies(...replies: unknown[][]) {
  for (const r of replies) m.upstashPipeline.mockResolvedValueOnce(r);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.upstashPipeline.mockResolvedValue([{ result: null }, { result: null }]);
  m.upstashEval.mockResolvedValue(1);
  m.hash.mockResolvedValue("scrypt-hash");
  m.ia.findUserById.mockResolvedValue({ id: BOB.id, name: "bob", displayUsername: "Bob" });
  m.ia.findAccounts.mockResolvedValue([{ id: "acc-1", providerId: "credential" }]);
  m.ia.updateAccount.mockResolvedValue({});
  m.ia.linkAccount.mockResolvedValue({});
  m.ia.deleteUserSessions.mockResolvedValue(undefined);
});

describe("issuePasswordResetCode", () => {
  it("returns a 39-char grouped code with a 15-minute expiry", async () => {
    const { code, expiresAt } = await issuePasswordResetCode(BOB.id, ALICE);
    expect(code).toHaveLength(39);
    expect(code).toMatch(/^([0-9a-f]{4}-){7}[0-9a-f]{4}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(890_000);
  });

  it("stores the code under its hash, never the plaintext, with the fixed keys and a 900 s TTL", async () => {
    const { code } = await issuePasswordResetCode(BOB.id, ALICE);
    const hash = hashClaimCode(normalizeClaimCode(code)!);
    const [, keys, args] = m.upstashEval.mock.calls[0];
    expect(keys[0]).toBe(ADMIN_GRANTS_KEY);
    expect(keys[1]).toBe(`${RESET_CODE_PREFIX}by:${BOB.id}`);
    expect(keys[2]).toBe(`${RESET_CODE_PREFIX}${hash}`);
    expect(keys).toContain(ADMIN_AUDIT_KEY);
    expect(keys).toContain("ctf:auth:user");
    expect(args[0]).toBe(ALICE.id);
    expect(args[1]).toBe(BOB.id);
    expect(JSON.parse(args[2] as string)).toEqual({ player: BOB.id, by: ALICE.id, name: ALICE.name });
    expect(args[3]).toBe("900");
    const sent = JSON.stringify([m.upstashEval.mock.calls, m.upstashPipeline.mock.calls]);
    expect(sent).not.toContain(normalizeClaimCode(code)!);
    expect(sent).not.toContain(code);
  });

  it("audits the player and the code id, never the code or the full hash", async () => {
    const { code } = await issuePasswordResetCode(BOB.id, ALICE);
    const hash = hashClaimCode(normalizeClaimCode(code)!);
    const [, , args] = m.upstashEval.mock.calls[0];
    const line = (args as string[]).map((a) => {
      try {
        return JSON.parse(a) as Record<string, unknown>;
      } catch {
        return null;
      }
    }).find((v) => v && v.action === "ops:password-reset-code");
    expect(line).toMatchObject({ by: ALICE.id, name: ALICE.name, action: "ops:password-reset-code", player: BOB.id, codeId: hash.slice(0, 8) });
    expect(line).not.toHaveProperty("code");
    expect(JSON.stringify(line)).not.toContain(hash);
  });

  it("names the player's current code as the one to replace", async () => {
    pipelineReplies([{ result: HASH }]);
    await issuePasswordResetCode(BOB.id, ALICE);
    const [, keys, args] = m.upstashEval.mock.calls[0];
    expect(keys[3]).toBe(resetCodeKey(HASH));
    expect(args).toContain(HASH);
  });

  it("throws NotAdminError, without retrying, when the issuer holds no grant", async () => {
    m.upstashEval.mockResolvedValue(-1);
    await expect(issuePasswordResetCode(BOB.id, ALICE)).rejects.toBeInstanceOf(NotAdminError);
    expect(m.upstashEval).toHaveBeenCalledTimes(1);
  });

  it("throws OpsValidationError on id when the player has no account", async () => {
    m.upstashEval.mockResolvedValue(-2);
    const err = await issuePasswordResetCode(BOB.id, ALICE).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect((err as OpsValidationError).field).toBe("id");
  });

  it("refuses a malformed player id without touching Redis", async () => {
    await expect(issuePasswordResetCode("octocat", ALICE)).rejects.toBeInstanceOf(OpsValidationError);
    expect(m.upstashEval).not.toHaveBeenCalled();
  });

  it("retries a lost race on the player's pointer, then gives up", async () => {
    m.upstashEval.mockResolvedValueOnce(-3).mockResolvedValueOnce(1);
    await expect(issuePasswordResetCode(BOB.id, ALICE)).resolves.toBeDefined();
    m.upstashEval.mockReset();
    m.upstashEval.mockResolvedValue(-3);
    await expect(issuePasswordResetCode(BOB.id, ALICE)).rejects.toThrow();
  });

  it("throws on an error reply reading the pointer", async () => {
    pipelineReplies([{ error: "NOAUTH" }]);
    await expect(issuePasswordResetCode(BOB.id, ALICE)).rejects.toThrow(/NOAUTH/);
    expect(m.upstashEval).not.toHaveBeenCalled();
  });
});

describe("redeemPasswordResetCode", () => {
  /** The pre-read finds the code naming `player`, and the consume script
   *  hands it back. */
  function codeFor(player: string) {
    pipelineReplies([{ result: JSON.stringify({ player, by: ALICE.id, name: ALICE.name, gen: 0 }) }]);
    m.upstashEval.mockResolvedValueOnce(["ok", player]);
  }

  it("refuses a 5-char password without consuming the code", async () => {
    await expect(redeemPasswordResetCode(CODE, "short")).resolves.toEqual({ ok: false, reason: "password" });
    await expect(redeemPasswordResetCode(CODE, "p".repeat(129))).resolves.toEqual({ ok: false, reason: "password" });
    expect(m.upstashEval).not.toHaveBeenCalled();
    expect(m.upstashPipeline).not.toHaveBeenCalled();
  });

  it("refuses a malformed code without touching Redis", async () => {
    await expect(redeemPasswordResetCode("nope", PW)).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(m.upstashEval).not.toHaveBeenCalled();
    expect(m.upstashPipeline).not.toHaveBeenCalled();
  });

  it("an unknown code is invalid and writes no password", async () => {
    await expect(redeemPasswordResetCode(CODE, PW)).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(m.upstashPipeline.mock.calls[0][0]).toEqual([["GET", resetCodeKey(HASH)]]);
    expect(m.hash).not.toHaveBeenCalled();
  });

  it("a code the consume script refuses is invalid and writes no password", async () => {
    pipelineReplies([{ result: JSON.stringify({ player: BOB.id }) }]);
    m.upstashEval.mockResolvedValueOnce(["invalid"]);
    await expect(redeemPasswordResetCode(CODE, PW)).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(m.hash).not.toHaveBeenCalled();
    expect(m.ia.updateAccount).not.toHaveBeenCalled();
  });

  it("consumes by hash with the player's pointer, and hands Redis no plaintext", async () => {
    codeFor(BOB.id);
    await redeemPasswordResetCode(CODE, PW);
    const [, keys, args] = m.upstashEval.mock.calls[0];
    expect(keys.slice(0, 2)).toEqual([resetCodeKey(HASH), resetPointerKey(BOB.id)]);
    expect(args).toEqual([HASH, BOB.id]);
    const sent = JSON.stringify([m.upstashEval.mock.calls, m.upstashPipeline.mock.calls]);
    expect(sent).not.toContain(PLAIN);
    expect(sent).not.toContain(CODE);
    expect(sent).not.toContain(PW);
  });

  it("updates an existing credential account, revokes every session and audits as the player", async () => {
    codeFor(BOB.id);
    await expect(redeemPasswordResetCode(CODE, PW)).resolves.toEqual({ ok: true, player: BOB.id });
    expect(m.hash).toHaveBeenCalledWith(PW);
    expect(m.ia.updateAccount).toHaveBeenCalledWith("acc-1", { password: "scrypt-hash" });
    expect(m.ia.linkAccount).not.toHaveBeenCalled();
    expect(m.ia.deleteUserSessions).toHaveBeenCalledWith(BOB.id);
    const auditCall = m.upstashPipeline.mock.calls.find((c) => c[0][0][0] === "LPUSH");
    expect(auditCall![0][0][1]).toBe(ADMIN_AUDIT_KEY);
    const line = JSON.parse(auditCall![0][0][2] as string);
    expect(line).toMatchObject({ by: BOB.id, name: "Bob", action: "ops:password-reset-used", player: BOB.id, codeId: HASH.slice(0, 8) });
    expect(JSON.stringify(line)).not.toContain(HASH);
  });

  it("creates the credential account for a provider-only player", async () => {
    codeFor(BOB.id);
    m.ia.findAccounts.mockResolvedValue([{ id: "acc-gh", providerId: "github" }]);
    await expect(redeemPasswordResetCode(CODE, PW)).resolves.toEqual({ ok: true, player: BOB.id });
    expect(m.ia.linkAccount).toHaveBeenCalledWith({ userId: BOB.id, providerId: "credential", accountId: BOB.id, password: "scrypt-hash" });
    expect(m.ia.updateAccount).not.toHaveBeenCalled();
  });

  it("is invalid when the player's account is gone, and writes nothing", async () => {
    codeFor(BOB.id);
    m.ia.findUserById.mockResolvedValue(null);
    await expect(redeemPasswordResetCode(CODE, PW)).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(m.ia.linkAccount).not.toHaveBeenCalled();
    expect(m.ia.deleteUserSessions).not.toHaveBeenCalled();
  });

  it("throws when the password write fails after the code is consumed", async () => {
    codeFor(BOB.id);
    m.ia.updateAccount.mockRejectedValue(new Error("redis down"));
    await expect(redeemPasswordResetCode(CODE, PW)).rejects.toThrow();
    expect(m.ia.deleteUserSessions).not.toHaveBeenCalled();
  });

  it("throws when the session revoke fails", async () => {
    codeFor(BOB.id);
    m.ia.deleteUserSessions.mockRejectedValue(new Error("redis down"));
    await expect(redeemPasswordResetCode(CODE, PW)).rejects.toThrow();
  });

  it("throws on an error reply from the pre-read rather than reading it as no code", async () => {
    pipelineReplies([{ error: "NOAUTH" }]);
    await expect(redeemPasswordResetCode(CODE, PW)).rejects.toThrow(/NOAUTH/);
  });

  it("still reports success when only the audit line fails", async () => {
    codeFor(BOB.id);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.upstashPipeline.mockResolvedValue([{ error: "OOM" }, { error: "OOM" }]);
    await expect(redeemPasswordResetCode(CODE, PW)).resolves.toEqual({ ok: true, player: BOB.id });
    expect(JSON.stringify(err.mock.calls)).not.toContain(PLAIN);
    err.mockRestore();
  });
});
