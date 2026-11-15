// The admin claim, issue and revoke scripts (admin-claim.ts) EXECUTED against a
// live Redis on run-unique keys. The mocked suite pins what the writers hand
// each script; this pins single use, expiry, the last-admin guard and the audit
// line shape. See live-redis.ts for the harness.

import { createHash } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!liveConfigured)("admin claim scripts against a live Redis", () => {
  const used: string[] = [];
  let suite = 0;
  /** A fresh set of keys per test, so no test reads what another wrote. */
  function keys() {
    suite += 1;
    const k = (name: string) => {
      const key = liveKey("admin-claim", `${suite}:${name}`);
      used.push(key);
      return key;
    };
    return { grants: k("grants"), spent: k("spent"), audit: k("audit"), code: (hash: string) => k(`code:${hash}`) };
  }

  async function load() {
    const claim = await import("@/lib/admin-claim");
    const { upstashEval, upstashPipeline } = await import("@/lib/upstash");
    return { claim, upstashEval, pipeline: upstashPipeline };
  }

  afterAll(async () => {
    const { pipeline } = await load();
    if (used.length) await pipeline([["DEL", ...used]]);
  });

  async function runClaim(k: ReturnType<typeof keys>, player: string, hash: string, boot: string) {
    const { claim, upstashEval } = await load();
    return upstashEval(
      claim.CLAIM_SCRIPT,
      [k.grants, k.spent, k.code(hash), k.audit],
      [player, `name-${player.slice(-2)}`, hash, boot, "2026-11-15T00:00:00.000Z", "499"],
    );
  }

  async function runIssue(k: ReturnType<typeof keys>, hash: string, by: string) {
    const { claim, upstashEval } = await load();
    const line = JSON.stringify({ at: "x", by, name: "issuer", action: "admin:code-issue", codeId: hash.slice(0, 8) });
    return upstashEval(claim.ISSUE_SCRIPT, [k.code(hash), k.audit], [JSON.stringify({ by, name: "issuer" }), "900", line, "499"]);
  }

  it("bootstrap claim grants once", async () => {
    const { pipeline } = await load();
    const k = keys();
    const h = sha("boot-1");
    expect(await runClaim(k, id(1), h, h)).toEqual(["ok", "bootstrap"]);
    const [member, spent] = await pipeline([["SISMEMBER", k.grants, id(1)], ["SISMEMBER", k.spent, h]]);
    expect([member.result, spent.result]).toEqual([1, 1]);
    expect(await runClaim(k, id(2), h, h)).toEqual(["invalid"]);
  });

  it("a rotated bootstrap hash is claimable again, and the old one is refused", async () => {
    const k = keys();
    const [h1, h2] = [sha("boot-a"), sha("boot-b")];
    expect(await runClaim(k, id(1), h1, h1)).toEqual(["ok", "bootstrap"]);
    expect(await runClaim(k, id(2), h1, h2)).toEqual(["invalid"]);
    expect(await runClaim(k, id(2), h2, h2)).toEqual(["ok", "bootstrap"]);
  });

  it("works while admins exist (lock-out recovery)", async () => {
    const { pipeline } = await load();
    const k = keys();
    await pipeline([["SADD", k.grants, id(9)]]);
    const h = sha("boot-recover");
    expect(await runClaim(k, id(1), h, h)).toEqual(["ok", "bootstrap"]);
  });

  it("an empty bootstrap hash grants nothing", async () => {
    const k = keys();
    expect(await runClaim(k, id(1), "", "")).toEqual(["invalid"]);
  });

  it("already-admin consumes nothing", async () => {
    const { pipeline } = await load();
    const k = keys();
    const h = sha("issued-aa");
    await pipeline([["SADD", k.grants, id(1)]]);
    expect(await runIssue(k, h, id(1))).toBe(1);
    expect(await runClaim(k, id(1), h, "")).toEqual(["already-admin"]);
    const [exists] = await pipeline([["EXISTS", k.code(h)]]);
    expect(exists.result).toBe(1);
  });

  it("an issued code is single-use under a race", async () => {
    const { pipeline } = await load();
    const k = keys();
    const h = sha("issued-race");
    await pipeline([["SADD", k.grants, id(1)]]);
    await runIssue(k, h, id(1));
    const [before] = await pipeline([["LLEN", k.audit]]);
    const results = await Promise.all([runClaim(k, id(2), h, ""), runClaim(k, id(3), h, "")]);
    expect(results.map((r) => (r as string[])[0]).sort()).toEqual(["invalid", "ok"]);
    const [count, after, head] = await pipeline([["SCARD", k.grants], ["LLEN", k.audit], ["LINDEX", k.audit, 0]]);
    expect(count.result).toBe(2);
    expect((after.result as number) - (before.result as number)).toBe(1);
    expect(JSON.parse(head.result as string).action).toBe("admin:grant");
  });

  it("an issued code expires", async () => {
    const { pipeline } = await load();
    const k = keys();
    const h = sha("issued-ttl");
    expect(await runIssue(k, h, id(1))).toBe(1);
    expect(await runIssue(k, h, id(1))).toBe(0);
    const [ttl, lines] = await pipeline([["TTL", k.code(h)], ["LLEN", k.audit]]);
    expect(ttl.result as number).toBeGreaterThan(890);
    expect(ttl.result as number).toBeLessThanOrEqual(900);
    expect(lines.result).toBe(1);
  });

  it("the grant audit line names the grantee, the path and the code id, never a login or full hash", async () => {
    const { pipeline } = await load();
    const k = keys();
    const h = sha("issued-audit");
    await runIssue(k, h, id(1));
    expect(await runClaim(k, id(2), h, "")).toEqual(["ok", "code"]);
    const [head] = await pipeline([["LINDEX", k.audit, 0]]);
    const line = JSON.parse(head.result as string) as Record<string, unknown>;
    expect(line).toMatchObject({
      action: "admin:grant",
      by: id(2),
      player: id(2),
      playerName: "name-02",
      via: "code",
      codeId: h.slice(0, 8),
      issuedBy: id(1),
      at: "2026-11-15T00:00:00.000Z",
    });
    expect("login" in line).toBe(false);
    expect(Object.values(line).some((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))).toBe(false);
  });

  it("revoke refuses the last admin, then removes one of two with an audit line", async () => {
    const { claim, upstashEval, pipeline } = await load();
    const k = keys();
    const revoke = (target: string) =>
      upstashEval(claim.REVOKE_SCRIPT, [k.grants, k.audit], [target, JSON.stringify({ action: "admin:revoke", player: target, playerName: "t" }), "499"]);
    await pipeline([["SADD", k.grants, id(1)]]);
    expect(await revoke(id(1))).toEqual(["last-admin"]);
    const [still] = await pipeline([["SMEMBERS", k.grants]]);
    expect(still.result).toEqual([id(1)]);
    await pipeline([["SADD", k.grants, id(2)]]);
    expect(await revoke(id(2))).toEqual(["ok", id(1)]);
    const [head] = await pipeline([["LINDEX", k.audit, 0]]);
    expect(JSON.parse(head.result as string)).toMatchObject({ action: "admin:revoke", player: id(2), playerName: "t" });
  });

  it("revoke of a non-admin writes nothing", async () => {
    const { claim, upstashEval, pipeline } = await load();
    const k = keys();
    await pipeline([["SADD", k.grants, id(1), id(2)]]);
    expect(await upstashEval(claim.REVOKE_SCRIPT, [k.grants, k.audit], [id(3), "{}", "499"])).toEqual(["not-admin"]);
    const [lines] = await pipeline([["LLEN", k.audit]]);
    expect(lines.result).toBe(0);
  });
});
