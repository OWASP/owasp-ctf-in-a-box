import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashPipeline: vi.fn<(c: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
  beginScoreLowering: vi.fn(),
  endScoreLowering: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline }));
// #553: clearing the demo rows lowers (removes) folded scores; the store
// brackets the clear with the leaf's begin/end (shared in-progress marker +
// revision bump) so no app task charges a hint against those points meanwhile.
vi.mock("@/lib/leaderboard/fold-cache", () => ({
  beginScoreLowering: mocks.beginScoreLowering,
  endScoreLowering: mocks.endScoreLowering,
}));

import { clearDemoData } from "@/lib/admin-store";
import { demoPlayerId } from "@/lib/demo-seed";
import { DEL_ROW_SCRIPT } from "@/lib/auth-store/scripts";
import { DEMO_CONTESTANTS, DEMO_TEAMS, DEMO_SPONSORS } from "@/lib/demo-fixture";
import { ALICE, actor } from "./audit-actor";

type Cmd = (string | number)[];

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
  mocks.upstashPipeline.mockResolvedValue([]);
  mocks.beginScoreLowering.mockReset();
  mocks.endScoreLowering.mockReset();
});

function cmds(): Cmd[] {
  return mocks.upstashPipeline.mock.calls[0]![0];
}

describe("clearDemoData", () => {
  // #553 review: the clear removes folded points; the hint gate reads gross
  // from the ~10 s fold memo. Dropped once, after the pipeline that did the
  // removing — and not at all when that pipeline failed and nothing changed.
  it("opens the score-lowering bracket before the clearing pipeline and closes it after", async () => {
    await clearDemoData(actor("alice"));
    expect(mocks.beginScoreLowering).toHaveBeenCalledTimes(1);
    expect(mocks.endScoreLowering).toHaveBeenCalledTimes(1);
    const write = mocks.upstashPipeline.mock.invocationCallOrder[0];
    expect(mocks.beginScoreLowering.mock.invocationCallOrder[0]).toBeLessThan(write);
    expect(mocks.endScoreLowering.mock.invocationCallOrder[0]).toBeGreaterThan(write);
  });

  it("still closes the bracket when the clear failed — a per-command failure leaves the other deletions standing", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ error: "NOAUTH" }]);
    await expect(clearDemoData(actor("alice"))).rejects.toThrow(/NOAUTH/);
    expect(mocks.endScoreLowering).toHaveBeenCalledTimes(1);
  });

  it("ABORTS before the pipeline when the bracket cannot be opened — fail closed", async () => {
    mocks.beginScoreLowering.mockRejectedValue(new Error("upstash down"));
    await expect(clearDemoData(actor("alice"))).rejects.toThrow("upstash down");
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
    expect(mocks.endScoreLowering).not.toHaveBeenCalled();
  });

  it("issues exactly one pipeline call — no settings read, unlike seedDemoData", async () => {
    await clearDemoData(actor("alice"));
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
  });

  it("HDELs every secure-development fake solve seedDemoData writes", async () => {
    await clearDemoData(actor("alice"));
    const c = cmds();
    for (const contestant of DEMO_CONTESTANTS) {
      for (const [target, ids] of Object.entries(contestant.solves)) {
        for (const id of ids) {
          expect(c).toContainEqual(["HDEL", `ctf:solves:${target}`, `${demoPlayerId(contestant.login)}:${id}`]);
        }
      }
    }
  });

  it("removes every demo team, its member set, and each member's membership fields", async () => {
    await clearDemoData(actor("alice"));
    const c = cmds();
    for (const t of DEMO_TEAMS) {
      expect(c).toContainEqual(["DEL", `ctf:team:${t.slug}`]);
      expect(c).toContainEqual(["DEL", `ctf:team:${t.slug}:members`]);
      for (const m of t.members) {
        expect(c).toContainEqual(["HDEL", `ctf:user:${demoPlayerId(m)}`, "team", "joinedAt", "firstTeamAt"]);
      }
    }
  });

  it("removes each demo contestant's per-player quiz/classic/ai rows, regardless of which modules are live", async () => {
    await clearDemoData(actor("alice"));
    const c = cmds();
    for (const contestant of DEMO_CONTESTANTS) {
      expect(c).toContainEqual(["DEL", `ctf:quiz:answers:${demoPlayerId(contestant.login)}`]);
      expect(c).toContainEqual(["DEL", `ctf:quiz:attempts:${demoPlayerId(contestant.login)}`]);
      expect(c).toContainEqual(["HDEL", "ctf:quiz:points", demoPlayerId(contestant.login)]);
      expect(c).toContainEqual(["HDEL", "ctf:quiz:answered", demoPlayerId(contestant.login)]);
      expect(c).toContainEqual(["HDEL", "ctf:quiz:lastAt", demoPlayerId(contestant.login)]);

      expect(c).toContainEqual(["DEL", `ctf:classic:solves:${demoPlayerId(contestant.login)}`]);
      expect(c).toContainEqual(["DEL", `ctf:classic:attempts:${demoPlayerId(contestant.login)}`]);
      expect(c).toContainEqual(["HDEL", "ctf:classic:points", demoPlayerId(contestant.login)]);
      expect(c).toContainEqual(["HDEL", "ctf:classic:solved", demoPlayerId(contestant.login)]);
      expect(c).toContainEqual(["HDEL", "ctf:classic:lastAt", demoPlayerId(contestant.login)]);

      expect(c).toContainEqual(["DEL", `ctf:ai:solves:${demoPlayerId(contestant.login)}`]);
      expect(c).toContainEqual(["DEL", `ctf:ai:attempts:${demoPlayerId(contestant.login)}`]);
      expect(c).toContainEqual(["HDEL", "ctf:ai:points", demoPlayerId(contestant.login)]);
      expect(c).toContainEqual(["HDEL", "ctf:ai:solved", demoPlayerId(contestant.login)]);
      expect(c).toContainEqual(["HDEL", "ctf:ai:lastAt", demoPlayerId(contestant.login)]);
    }
  });

  it("deletes each demo account only while its row is still the one the seed wrote", async () => {
    await clearDemoData(actor("alice"));
    const dels = cmds().filter((cmd) => cmd[0] === "EVAL" && cmd[1] === DEL_ROW_SCRIPT);
    expect(dels).toHaveLength(DEMO_CONTESTANTS.length);
    for (const contestant of DEMO_CONTESTANTS) {
      const del = dels.find((d) => d[6] === demoPlayerId(contestant.login))!;
      expect(del.slice(2, 6)).toEqual([1, "ctf:auth:user", "ctf:auth", "user"]);
      expect(JSON.parse(String(del[7]))).toMatchObject({ id: demoPlayerId(contestant.login), login: contestant.login });
    }
  });

  it("HDELs every demo sponsor's metadata and logo row", async () => {
    await clearDemoData(actor("alice"));
    const c = cmds();
    for (const s of DEMO_SPONSORS) {
      expect(c).toContainEqual(["HDEL", "ctf:sponsors", s.id]);
      expect(c).toContainEqual(["HDEL", "ctf:sponsors:logo", s.id]);
    }
  });

  it("never touches the demo questions/challenges/flags/categories hashes — authored content, left for the organizer to remove by hand", async () => {
    await clearDemoData(actor("alice"));
    const c = cmds();
    const touchesAuthoredContent = c.some(
      (cmd) =>
        typeof cmd[1] === "string" &&
        /^ctf:(quiz:(questions|key)|classic:(challenges|flag|flagnorm|categories)|ai:(challenges|flag|flagnorm|categories|signkey|hints))$/.test(
          cmd[1],
        ),
    );
    expect(touchesAuthoredContent).toBe(false);
  });

  it("appends a clear-demo audit entry", async () => {
    await clearDemoData(actor("alice"));
    const c = cmds();
    const push = c.find((cmd) => cmd[0] === "LPUSH" && cmd[1] === "ctf:admin:audit");
    expect(push).toBeTruthy();
    const audit = JSON.parse(String(push![2])) as { by: string; name: string; action: string };
    expect(audit.by).toBe(ALICE.id);
    expect(audit.name).toBe("alice");
    expect(audit.action).toBe("clear-demo");
  });

  it("returns the fixture counts", async () => {
    const result = await clearDemoData(actor("alice"));
    expect(result).toEqual({
      contestants: DEMO_CONTESTANTS.length,
      teams: DEMO_TEAMS.length,
      sponsors: DEMO_SPONSORS.length,
    });
  });

  it("throws when the pipeline reports a per-command failure (upstashPipeline does not throw on its own)", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ error: "NOAUTH Authentication required." }]);
    await expect(clearDemoData(actor("alice"))).rejects.toThrow(/Clear demo data failed/);
  });

  it("logs but does not throw when only the trailing audit LPUSH/LTRIM fail — cleanup already succeeded", async () => {
    mocks.upstashPipeline.mockImplementation((c) =>
      Promise.resolve(c.map((_, i) => (i >= c.length - 2 ? { error: "NOAUTH Authentication required." } : { result: "OK" }))),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await clearDemoData(actor("alice"));
    expect(result).toEqual({
      contestants: DEMO_CONTESTANTS.length,
      teams: DEMO_TEAMS.length,
      sponsors: DEMO_SPONSORS.length,
    });
    expect(spy).toHaveBeenCalledWith("[admin] clear-demo audit write failed:", expect.stringContaining("NOAUTH"));
    spy.mockRestore();
  });
});
