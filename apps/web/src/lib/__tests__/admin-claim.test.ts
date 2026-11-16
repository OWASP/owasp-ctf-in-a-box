// Admin claim codes: the code primitives and what the writers hand Redis. The
// Upstash seam is mocked, so this pins the contract with the scripts; the live
// suite (admin-claim.upstash.test.ts) pins what the scripts do with it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { upstashEval, upstashPipeline } = vi.hoisted(() => ({
  upstashEval: vi.fn(),
  upstashPipeline: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval, upstashPipeline }));

import {
  ADMIN_CLAIM_SPENT_KEY,
  ADMIN_CODE_PREFIX,
  ADMIN_GRANT_GEN_KEY,
  claimAdmin,
  codeId,
  formatClaimCode,
  hashClaimCode,
  issueAdminCode,
  normalizeClaimCode,
  NotAdminError,
  revokeAdmin,
} from "@/lib/admin-claim";
import { ADMIN_GRANTS_KEY, countAdminGrants, isAdminGrantee, listAdminGrants } from "@/lib/admin-grants";
import { ADMIN_AUDIT_KEY } from "@/lib/admin-audit-keys";
import { ALICE, actor } from "./audit-actor";

const VECTOR_CODE = "0123-4567-89ab-cdef-0123-4567-89ab-cdef";
const VECTOR_HASH = "3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9";

beforeEach(() => {
  vi.clearAllMocks();
  upstashEval.mockResolvedValue(1);
  upstashPipeline.mockResolvedValue([{ result: [] }]);
});

describe("code primitives", () => {
  it("normalizes case, hyphens and whitespace", () => {
    for (const s of [
      "0123-4567-89AB-cdef-0123-4567-89ab-cdef",
      " 0123 4567 89ab cdef 0123 4567 89ab cdef\n",
      "0123456789abcdef0123456789abcdef",
    ]) {
      expect(normalizeClaimCode(s)).toBe("0123456789abcdef0123456789abcdef");
    }
  });

  it("refuses wrong length and non-hex rather than truncating", () => {
    for (const s of [
      "",
      "0123456789abcdef0123456789abcde",
      "0123456789abcdef0123456789abcdef0",
      "g123456789abcdef0123456789abcdef",
      "0123_4567_89ab_cdef_0123_4567_89ab_cdef",
    ]) {
      expect(normalizeClaimCode(s)).toBeNull();
    }
  });

  it("hashes the normalized code (the test vector claim-code.bats shares)", () => {
    expect(hashClaimCode("0123456789abcdef0123456789abcdef")).toBe(VECTOR_HASH);
    expect(hashClaimCode(normalizeClaimCode(VECTOR_CODE)!)).toBe(VECTOR_HASH);
  });

  it("formats in eight groups of four", () => {
    expect(formatClaimCode("0123456789abcdef0123456789abcdef")).toBe(VECTOR_CODE);
  });

  it("names a code by the first eight hex of its hash", () => {
    expect(codeId(VECTOR_HASH)).toBe("3eb1bd43");
  });
});

describe("claimAdmin", () => {
  it("refuses an unparseable code without touching Redis", async () => {
    await expect(claimAdmin("nope", ALICE, "")).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(upstashEval).not.toHaveBeenCalled();
  });

  it("hands the script the hash, never the code, with the fixed keys and args", async () => {
    upstashEval.mockResolvedValue(["ok", "bootstrap"]);
    await expect(claimAdmin(VECTOR_CODE, ALICE, VECTOR_HASH)).resolves.toEqual({ ok: true, via: "bootstrap" });
    const [, keys, args] = upstashEval.mock.calls[0];
    expect(keys).toEqual([ADMIN_GRANTS_KEY, ADMIN_CLAIM_SPENT_KEY, `${ADMIN_CODE_PREFIX}${VECTOR_HASH}`, ADMIN_AUDIT_KEY, ADMIN_GRANT_GEN_KEY]);
    expect(args.slice(0, 4)).toEqual([ALICE.id, ALICE.name, VECTOR_HASH, VECTOR_HASH]);
    const sent = JSON.stringify(upstashEval.mock.calls);
    expect(sent).not.toContain("0123456789abcdef0123456789abcdef");
    expect(sent).not.toContain(VECTOR_CODE);
  });

  it("passes an empty bootstrap hash when the configured one is not a SHA-256", async () => {
    upstashEval.mockResolvedValue(["invalid"]);
    await claimAdmin(VECTOR_CODE, ALICE, "not-a-hash");
    expect(upstashEval.mock.calls[0][2][3]).toBe("");
  });

  it("maps the script's refusals", async () => {
    upstashEval.mockResolvedValue(["invalid"]);
    await expect(claimAdmin(VECTOR_CODE, ALICE, VECTOR_HASH)).resolves.toEqual({ ok: false, reason: "invalid" });
    upstashEval.mockResolvedValue(["already-admin"]);
    await expect(claimAdmin(VECTOR_CODE, ALICE, VECTOR_HASH)).resolves.toEqual({ ok: false, reason: "already-admin" });
  });

  it("throws on a reply it does not recognise rather than reading it as a grant", async () => {
    upstashEval.mockResolvedValue(["what"]);
    await expect(claimAdmin(VECTOR_CODE, ALICE, VECTOR_HASH)).rejects.toThrow();
  });
});

describe("issueAdminCode", () => {
  it("stores only the hash, with a 900 s TTL, and audits no code", async () => {
    const { code, expiresAt } = await issueAdminCode(ALICE);
    expect(code).toMatch(/^([0-9a-f]{4}-){7}[0-9a-f]{4}$/);
    const [, keys, args] = upstashEval.mock.calls[0];
    const hash = hashClaimCode(normalizeClaimCode(code)!);
    expect(keys).toEqual([ADMIN_GRANTS_KEY, `${ADMIN_CODE_PREFIX}${hash}`, ADMIN_AUDIT_KEY, ADMIN_GRANT_GEN_KEY]);
    expect(args[0]).toBe(ALICE.id);
    expect(args[2]).toBe("900");
    expect(JSON.parse(args[1] as string)).toEqual({ by: ALICE.id, name: ALICE.name });
    const audit = JSON.parse(args[3] as string);
    expect(audit).toMatchObject({ by: ALICE.id, name: ALICE.name, action: "admin:code-issue", codeId: hash.slice(0, 8), expiresAt });
    expect(JSON.stringify(args)).not.toContain(normalizeClaimCode(code)!);
    expect(JSON.stringify(args)).not.toContain(code);
    expect(JSON.stringify(args)).not.toContain(hash.slice(8));
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(890_000);
  });

  it("retries once on a collision, then throws", async () => {
    upstashEval.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await expect(issueAdminCode(ALICE)).resolves.toBeDefined();
    expect(upstashEval).toHaveBeenCalledTimes(2);
    upstashEval.mockReset();
    upstashEval.mockResolvedValue(0);
    await expect(issueAdminCode(ALICE)).rejects.toThrow();
    expect(upstashEval).toHaveBeenCalledTimes(2);
  });

  it("throws NotAdminError, without retrying, when the issuer holds no grant", async () => {
    upstashEval.mockResolvedValue(-1);
    await expect(issueAdminCode(ALICE)).rejects.toBeInstanceOf(NotAdminError);
    expect(upstashEval).toHaveBeenCalledTimes(1);
  });
});

describe("revokeAdmin", () => {
  const bob = actor("bob");

  it("audits the target by id and name, and returns the remaining grants", async () => {
    upstashEval.mockResolvedValue(["ok", ALICE.id]);
    await expect(revokeAdmin(bob, ALICE)).resolves.toEqual({ ok: true, grants: [ALICE.id] });
    const [, keys, args] = upstashEval.mock.calls[0];
    expect(keys).toEqual([ADMIN_GRANTS_KEY, ADMIN_AUDIT_KEY, ADMIN_GRANT_GEN_KEY, "ctf:auth:user"]);
    expect(args[0]).toBe(bob.id);
    expect(args[1]).toBe(ALICE.id);
    expect(JSON.parse(args[2] as string)).toMatchObject({ by: ALICE.id, action: "admin:revoke", player: bob.id, playerName: "bob" });
  });

  it("maps the refusals", async () => {
    upstashEval.mockResolvedValue(["last-admin"]);
    await expect(revokeAdmin(bob, ALICE)).resolves.toEqual({ ok: false, reason: "last-admin" });
    upstashEval.mockResolvedValue(["not-admin"]);
    await expect(revokeAdmin(bob, ALICE)).resolves.toEqual({ ok: false, reason: "not-admin" });
  });

  it("throws NotAdminError when the acting admin no longer holds a grant", async () => {
    upstashEval.mockResolvedValue(["not-admin-actor"]);
    await expect(revokeAdmin(bob, ALICE)).rejects.toBeInstanceOf(NotAdminError);
  });
});

describe("grant reads", () => {
  it("lists sorted ids, checks membership and counts", async () => {
    upstashPipeline.mockResolvedValueOnce([{ result: ["b", "a"] }]);
    expect(await listAdminGrants()).toEqual(["a", "b"]);
    upstashPipeline.mockResolvedValueOnce([{ result: 1 }]);
    expect(await isAdminGrantee(ALICE.id)).toBe(true);
    expect(upstashPipeline.mock.calls[1][0]).toEqual([["SISMEMBER", ADMIN_GRANTS_KEY, ALICE.id]]);
    upstashPipeline.mockResolvedValueOnce([{ result: 3 }]);
    expect(await countAdminGrants()).toBe(3);
  });

  it("throws on an error reply instead of reading it as no grant", async () => {
    upstashPipeline.mockResolvedValue([{ error: "NOAUTH" }]);
    await expect(listAdminGrants()).rejects.toThrow(/NOAUTH/);
    await expect(isAdminGrantee(ALICE.id)).rejects.toThrow(/NOAUTH/);
    await expect(countAdminGrants()).rejects.toThrow(/NOAUTH/);
  });
});
