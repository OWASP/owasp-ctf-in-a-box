// The demo roster's account rows live under `ctf:auth:`, outside every
// master-reset prefix, so "seed then clear" is the only road that removes
// them. The mocked seed/clear suites pin which commands are sent; this one
// runs them against a REAL Redis and reads the account hash and the email
// index back. Gating comes from live-redis.ts.
//
// The demo ids are derived from the fixture, so the keys are fixed, not
// run-unique: the suite clears the demo before and after itself.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { liveConfigured } from "./live-redis";
import { actor } from "./audit-actor";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: {} }));

describe.skipIf(!liveConfigured)("demo accounts against a live SRH proxy", () => {
  let demo: typeof import("@/lib/demo-seed");
  let fixture: typeof import("@/lib/demo-fixture");
  let resetPrefixes: readonly [string, string][];
  let upstashPipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];

  const emailKey = (login: string) => `ctf:auth:user:by:email:${login}@demo.invalid`;

  async function readRow(id: string): Promise<string | null> {
    const [r] = await upstashPipeline([["HGET", "ctf:auth:user", id]]);
    expect(r.error).toBeUndefined();
    return (r.result as string | null) ?? null;
  }
  async function indexMembers(login: string): Promise<string[]> {
    const [r] = await upstashPipeline([["SMEMBERS", emailKey(login)]]);
    expect(r.error).toBeUndefined();
    return r.result as string[];
  }
  const seed = () => demo.runDemoSeed({ enabledModuleIds: [] } as never, actor("alice"));

  beforeAll(async () => {
    demo = await import("@/lib/demo-seed");
    fixture = await import("@/lib/demo-fixture");
    ({ RESET_PREFIXES: resetPrefixes } = await import("@/lib/admin-store"));
    ({ upstashPipeline } = await import("@/lib/upstash"));
  });
  beforeEach(async () => {
    await demo.clearDemoData(actor("alice"));
  });
  afterAll(async () => {
    await demo.clearDemoData(actor("alice"));
  });

  it("seeds an account row and an email index entry per demo player, naming each", async () => {
    await seed();
    for (const c of fixture.DEMO_CONTESTANTS) {
      const id = demo.demoPlayerId(c.login);
      const row = JSON.parse((await readRow(id))!);
      expect(row).toMatchObject({ id, name: c.login, login: c.login });
      expect(await indexMembers(c.login)).toEqual([id]);
    }
  });

  it("is idempotent: a second seed leaves one row and one index member each", async () => {
    await seed();
    await seed();
    for (const c of fixture.DEMO_CONTESTANTS) {
      expect(await indexMembers(c.login)).toEqual([demo.demoPlayerId(c.login)]);
    }
  });

  it("clear removes the account rows AND their email index entries", async () => {
    await seed();
    await demo.clearDemoData(actor("alice"));
    for (const c of fixture.DEMO_CONTESTANTS) {
      expect(await readRow(demo.demoPlayerId(c.login))).toBeNull();
      expect(await indexMembers(c.login)).toEqual([]);
    }
  });

  it("no master-reset pattern reaches the account store, and clear still removes accounts after a reset-style wipe of the event rows", async () => {
    const globToRe = (g: string) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    for (const [, pattern] of resetPrefixes) {
      expect(globToRe(pattern).test("ctf:auth:user"), pattern).toBe(false);
      expect(globToRe(pattern).test("ctf:auth:user:by:email:x@demo.invalid"), pattern).toBe(false);
    }
    await seed();
    const wipe: (string | number)[][] = [];
    for (const t of fixture.DEMO_TEAMS) wipe.push(["DEL", `ctf:team:${t.slug}`, `ctf:team:${t.slug}:members`]);
    for (const c of fixture.DEMO_CONTESTANTS) wipe.push(["DEL", `ctf:user:${demo.demoPlayerId(c.login)}`]);
    await upstashPipeline(wipe);
    for (const c of fixture.DEMO_CONTESTANTS) expect(await readRow(demo.demoPlayerId(c.login))).not.toBeNull();
    await demo.clearDemoData(actor("alice"));
    for (const c of fixture.DEMO_CONTESTANTS) {
      expect(await readRow(demo.demoPlayerId(c.login))).toBeNull();
      expect(await indexMembers(c.login)).toEqual([]);
    }
  });

  it("a demo account an organizer edited survives the clear", async () => {
    await seed();
    const edited = fixture.DEMO_CONTESTANTS[0].login;
    const id = demo.demoPlayerId(edited);
    const row = { ...JSON.parse((await readRow(id))!), name: "Renamed By Organizer" };
    await upstashPipeline([["HSET", "ctf:auth:user", id, JSON.stringify(row)]]);
    await demo.clearDemoData(actor("alice"));
    expect(JSON.parse((await readRow(id))!).name).toBe("Renamed By Organizer");
    const others = fixture.DEMO_CONTESTANTS.slice(1);
    for (const c of others) expect(await readRow(demo.demoPlayerId(c.login))).toBeNull();
    await upstashPipeline([["HDEL", "ctf:auth:user", id], ["DEL", emailKey(edited)]]);
  });
});
