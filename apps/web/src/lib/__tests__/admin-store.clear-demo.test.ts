import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashPipeline: vi.fn<(c: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline }));

import { clearDemoData } from "@/lib/admin-store";
import { DEMO_CONTESTANTS, DEMO_TEAMS, DEMO_SPONSORS } from "@/lib/demo-fixture";

type Cmd = (string | number)[];

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
  mocks.upstashPipeline.mockResolvedValue([]);
});

function cmds(): Cmd[] {
  return mocks.upstashPipeline.mock.calls[0]![0];
}

describe("clearDemoData", () => {
  it("issues exactly one pipeline call — no settings read, unlike seedDemoData", async () => {
    await clearDemoData("alice");
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
  });

  it("HDELs every secure-development fake solve seedDemoData writes", async () => {
    await clearDemoData("alice");
    const c = cmds();
    for (const contestant of DEMO_CONTESTANTS) {
      for (const [target, ids] of Object.entries(contestant.solves)) {
        for (const id of ids) {
          expect(c).toContainEqual(["HDEL", `ctf:solves:${target}`, `${contestant.login}:${id}`]);
        }
      }
    }
  });

  it("removes every demo team, its member set, and each member's membership fields", async () => {
    await clearDemoData("alice");
    const c = cmds();
    for (const t of DEMO_TEAMS) {
      expect(c).toContainEqual(["DEL", `ctf:team:${t.slug}`]);
      expect(c).toContainEqual(["DEL", `ctf:team:${t.slug}:members`]);
      for (const m of t.members) {
        expect(c).toContainEqual(["HDEL", `ctf:user:${m}`, "team", "joinedAt", "firstTeamAt"]);
      }
    }
  });

  it("removes each demo contestant's per-login quiz/classic/ai rows, regardless of which modules are live", async () => {
    await clearDemoData("alice");
    const c = cmds();
    for (const contestant of DEMO_CONTESTANTS) {
      expect(c).toContainEqual(["DEL", `ctf:quiz:answers:${contestant.login}`]);
      expect(c).toContainEqual(["DEL", `ctf:quiz:attempts:${contestant.login}`]);
      expect(c).toContainEqual(["HDEL", "ctf:quiz:points", contestant.login]);
      expect(c).toContainEqual(["HDEL", "ctf:quiz:answered", contestant.login]);

      expect(c).toContainEqual(["DEL", `ctf:classic:solves:${contestant.login}`]);
      expect(c).toContainEqual(["DEL", `ctf:classic:attempts:${contestant.login}`]);
      expect(c).toContainEqual(["HDEL", "ctf:classic:points", contestant.login]);
      expect(c).toContainEqual(["HDEL", "ctf:classic:solved", contestant.login]);

      expect(c).toContainEqual(["DEL", `ctf:ai:solves:${contestant.login}`]);
      expect(c).toContainEqual(["DEL", `ctf:ai:attempts:${contestant.login}`]);
      expect(c).toContainEqual(["HDEL", "ctf:ai:points", contestant.login]);
      expect(c).toContainEqual(["HDEL", "ctf:ai:solved", contestant.login]);
    }
  });

  it("HDELs every demo sponsor's metadata and logo row", async () => {
    await clearDemoData("alice");
    const c = cmds();
    for (const s of DEMO_SPONSORS) {
      expect(c).toContainEqual(["HDEL", "ctf:sponsors", s.id]);
      expect(c).toContainEqual(["HDEL", "ctf:sponsors:logo", s.id]);
    }
  });

  it("never touches the demo questions/challenges/flags/categories hashes — authored content, left for the organizer to remove by hand", async () => {
    await clearDemoData("alice");
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
    await clearDemoData("alice");
    const c = cmds();
    const push = c.find((cmd) => cmd[0] === "LPUSH" && cmd[1] === "ctf:admin:audit");
    expect(push).toBeTruthy();
    const audit = JSON.parse(String(push![2])) as { by: string; action: string };
    expect(audit.by).toBe("alice");
    expect(audit.action).toBe("clear-demo");
  });

  it("returns the fixture counts", async () => {
    const result = await clearDemoData("alice");
    expect(result).toEqual({
      contestants: DEMO_CONTESTANTS.length,
      teams: DEMO_TEAMS.length,
      sponsors: DEMO_SPONSORS.length,
    });
  });

  it("throws when the pipeline reports a per-command failure (upstashPipeline does not throw on its own)", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ error: "NOAUTH Authentication required." }]);
    await expect(clearDemoData("alice")).rejects.toThrow(/Clear demo data failed/);
  });
});
