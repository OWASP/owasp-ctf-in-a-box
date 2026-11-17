import { describe, expect, it, vi } from "vitest";
import { freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

import {
  getGithubLink,
  recordGithubSignIn,
  releaseGithubLink,
  resolveGithubLogin,
  restoreGithubLink,
  takeGithubLink,
  type TakenLink,
} from "@/lib/github-link";
import { upstashPipeline } from "@/lib/upstash";

describe.skipIf(!liveConfigured)("recordGithubSignIn against a live SRH proxy", () => {
  function fresh() {
    const base = liveKey("link", freshId("l"));
    const gh = `${base}:github:`;
    const us = `${base}:user:`;
    const at = `${base}:at`;
    const blocked = `${base}:blocked`;
    // Stands in for the better-auth user rows hash: a restore checks it.
    const rows = `${base}:rows`;
    return {
      // An account row for each id, as a live player has.
      accounts: async (...ids: string[]) => {
        const [r] = await upstashPipeline([["HSET", rows, ...ids.flatMap((id) => [id, "{}"])]]);
        if (r?.error) throw new Error(r.error);
      },
      dropAccount: async (id: string) => {
        const [r] = await upstashPipeline([["HDEL", rows, id]]);
        if (r?.error) throw new Error(r.error);
      },
      record: (id: string, login: string) => recordGithubSignIn(id, login, gh, us, at, blocked),
      release: (id: string, block: boolean) => releaseGithubLink(id, { block }, { prefix: gh, userPrefix: us, atKey: at, blockKey: blocked }),
      isBlocked: async (login: string) => {
        const [r] = await upstashPipeline([["SISMEMBER", blocked, login]]);
        if (r?.error) throw new Error(r.error);
        return r?.result === 1;
      },
      setPointer: async (id: string, login: string) => {
        const [r] = await upstashPipeline([["SET", `${us}${id}`, login]]);
        if (r?.error) throw new Error(r.error);
      },
      loginKeyExists: async (login: string) => {
        const [r] = await upstashPipeline([["EXISTS", `${gh}${login}`]]);
        if (r?.error) throw new Error(r.error);
        return r?.result === 1;
      },
      resolve: (login: string) => resolveGithubLogin(login, gh),
      dropTime: async (id: string) => {
        const [r] = await upstashPipeline([["HDEL", at, id]]);
        if (r?.error) throw new Error(r.error);
      },
      linkedAt: async (id: string) => {
        const [r] = await upstashPipeline([["HGET", at, id]]);
        // A failed read must not pass for "no time recorded".
        if (r?.error) throw new Error(r.error);
        return r?.result ?? null;
      },
      read: (id: string) => getGithubLink(id, us, at),
      take: (id: string) => takeGithubLink(id, { prefix: gh, userPrefix: us, atKey: at }),
      restore: (id: string, taken: TakenLink) =>
        restoreGithubLink(id, taken, { prefix: gh, userPrefix: us, atKey: at, rowsKey: rows, blockKey: blocked }),
    };
  }

  it("links on first sign-in and is unchanged on the repeat", async () => {
    const t = fresh();
    expect(await t.record("u1", "OctoCat")).toBe("linked");
    expect(await t.resolve("OCTOCAT")).toBe("u1");
    expect(await t.record("u1", "octocat")).toBe("unchanged");
  });

  it("moves the link on a rename and releases the old login", async () => {
    const t = fresh();
    await t.record("u1", "octocat");
    expect(await t.record("u1", "octo-renamed")).toBe("linked");
    expect(await t.resolve("octocat")).toBeNull();
    expect(await t.resolve("octo-renamed")).toBe("u1");
  });

  it("refuses a login another player holds and writes nothing", async () => {
    const t = fresh();
    await t.record("u1", "octo-renamed");
    expect(await t.record("u2", "octo-renamed")).toBe("taken");
    expect(await t.resolve("octo-renamed")).toBe("u1");
  });

  it("a taken rename leaves the player's own link in place", async () => {
    const t = fresh();
    await t.record("u1", "taken-name");
    await t.record("u2", "mine");
    expect(await t.record("u2", "taken-name")).toBe("taken");
    expect(await t.resolve("mine")).toBe("u2");
    expect(await t.resolve("taken-name")).toBe("u1");
  });

  it("does not delete a login key that now names someone else", async () => {
    const t = fresh();
    await t.record("u1", "old");
    await t.record("u1", "new");
    await t.record("u2", "old");
    expect(await t.record("u1", "newer")).toBe("linked");
    expect(await t.resolve("old")).toBe("u2");
  });

  it("stamps the link time on first link, keeps it on unchanged, and refreshes it on a rename", async () => {
    const t = fresh();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(1731500000000));
      expect(await t.record("u1", "octocat")).toBe("linked");
      expect(await t.linkedAt("u1")).toBe("1731500000000");
      vi.setSystemTime(new Date(1731500999000));
      expect(await t.record("u1", "octocat")).toBe("unchanged");
      expect(await t.linkedAt("u1")).toBe("1731500000000");
      expect(await t.record("u1", "octo-renamed")).toBe("linked");
      expect(await t.linkedAt("u1")).toBe("1731500999000");
      expect(await t.read("u1")).toEqual({ login: "octo-renamed", linkedAt: 1731500999000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps a time-less link on the repeat sign-in and never moves an existing time", async () => {
    // A time-less link counts as made after the close; `unchanged` may only
    // fill the gap, which can make a link look later, never earlier.
    const t = fresh();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(1731500000000));
      await t.record("u1", "octocat");
      await t.dropTime("u1");
      expect(await t.linkedAt("u1")).toBeNull();
      vi.setSystemTime(new Date(1731500999000));
      expect(await t.record("u1", "octocat")).toBe("unchanged");
      expect(await t.linkedAt("u1")).toBe("1731500999000");
      vi.setSystemTime(new Date(1731509999000));
      expect(await t.record("u1", "octocat")).toBe("unchanged");
      expect(await t.linkedAt("u1")).toBe("1731500999000");
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes no time for a taken loser", async () => {
    const t = fresh();
    await t.record("u1", "contested");
    expect(await t.record("u2", "contested")).toBe("taken");
    expect(await t.linkedAt("u2")).toBeNull();
    expect(await t.read("u2")).toBeNull();
  });

  it("a blocked release refuses the login on another account and writes nothing", async () => {
    const t = fresh();
    await t.record("u1", "OctoCat");
    expect(await t.release("u1", true)).toBe("octocat");
    expect(await t.isBlocked("octocat")).toBe(true);
    expect(await t.read("u1")).toBeNull();
    expect(await t.linkedAt("u1")).toBeNull();
    expect(await t.record("u2", "OCTOCAT")).toBe("blocked");
    expect(await t.loginKeyExists("octocat")).toBe(false);
    expect(await t.read("u2")).toBeNull();
    expect(await t.linkedAt("u2")).toBeNull();
    // The released player is refused too: the block is on the login.
    expect(await t.record("u1", "octocat")).toBe("blocked");
  });

  it("a plain release leaves no blocklist entry and the login can link again", async () => {
    const t = fresh();
    await t.record("u1", "octocat");
    expect(await t.release("u1", false)).toBe("octocat");
    expect(await t.isBlocked("octocat")).toBe(false);
    expect(await t.loginKeyExists("octocat")).toBe(false);
    expect(await t.read("u1")).toBeNull();
    expect(await t.record("u2", "octocat")).toBe("linked");
    expect(await t.resolve("octocat")).toBe("u2");
  });

  it("a release does not delete a login key that names another player", async () => {
    const t = fresh();
    await t.record("u1", "octocat");
    // A stale reverse pointer: u3 still names a login u1 now holds.
    await t.setPointer("u3", "octocat");
    expect(await t.release("u3", false)).toBe("octocat");
    expect(await t.resolve("octocat")).toBe("u1");
    expect(await t.read("u3")).toBeNull();
  });

  it("a blocked release through a stale pointer does not block a login another player holds", async () => {
    const t = fresh();
    await t.record("u1", "octocat");
    await t.setPointer("u3", "octocat");
    expect(await t.release("u3", true)).toBe("octocat");
    expect(await t.isBlocked("octocat")).toBe(false);
    expect(await t.resolve("octocat")).toBe("u1");
    expect(await t.read("u3")).toBeNull();
    // u1 keeps signing in as before.
    expect(await t.record("u1", "octocat")).toBe("unchanged");
  });

  it("a blocked release through a pointer whose login nobody holds blocks it", async () => {
    const t = fresh();
    await t.setPointer("u3", "octocat");
    expect(await t.release("u3", true)).toBe("octocat");
    expect(await t.isBlocked("octocat")).toBe(true);
    expect(await t.record("u4", "octocat")).toBe("blocked");
  });

  it("a release with no link returns null and blocks nothing", async () => {
    const t = fresh();
    expect(await t.release("u1", true)).toBeNull();
    expect(await t.record("u1", "octocat")).toBe("linked");
  });

  it("a take releases the link and a restore puts it back with its original time", async () => {
    const t = fresh();
    await t.accounts("u1", "u2", "u3");
    await t.record("u1", "OctoCat");
    const time = await t.linkedAt("u1");
    const taken = await t.take("u1");
    expect(taken).toEqual({ login: "octocat", at: time, ours: true });
    expect(await t.resolve("octocat")).toBeNull();
    expect(await t.read("u1")).toBeNull();
    expect(await t.restore("u1", taken!)).toBe("restored");
    expect(await t.resolve("octocat")).toBe("u1");
    expect(await t.read("u1")).toEqual({ login: "octocat", linkedAt: Number(time) });
  });

  it("a restore refuses, writing nothing, once another player holds the login", async () => {
    const t = fresh();
    await t.accounts("u1", "u2", "u3");
    await t.record("u1", "octocat");
    const taken = await t.take("u1");
    expect(await t.record("u2", "octocat")).toBe("linked");
    await expect(t.restore("u1", taken!)).rejects.toThrow(/restore refused \(taken\)/);
    expect(await t.resolve("octocat")).toBe("u2");
    expect(await t.read("u1")).toBeNull();
  });

  it("a restore leaves a newer link of the player's own alone", async () => {
    const t = fresh();
    await t.accounts("u1", "u2", "u3");
    await t.record("u1", "octocat");
    const taken = await t.take("u1");
    await t.record("u1", "octo-new");
    await expect(t.restore("u1", taken!)).rejects.toThrow(/relinked/);
    expect(await t.resolve("octocat")).toBeNull();
    expect(await t.resolve("octo-new")).toBe("u1");
  });

  it("a take through a stale pointer leaves the other player's login key, and the restore does not claim it", async () => {
    const t = fresh();
    await t.accounts("u1", "u2", "u3");
    await t.record("u1", "octocat");
    await t.setPointer("u3", "octocat");
    const taken = await t.take("u3");
    expect(taken).toMatchObject({ login: "octocat", ours: false });
    expect(await t.resolve("octocat")).toBe("u1");
    await t.restore("u3", taken!);
    expect(await t.resolve("octocat")).toBe("u1");
  });

  it("a take with no link returns null", async () => {
    const t = fresh();
    expect(await t.take("u1")).toBeNull();
  });

  it("a restore after the player's account row is gone recreates no link and blocks the login", async () => {
    const t = fresh();
    await t.accounts("u1");
    await t.record("u1", "octocat");
    const taken = await t.take("u1");
    // A delete finished between the take and the restore: its own release
    // found no link to block.
    await t.dropAccount("u1");
    expect(await t.restore("u1", taken!)).toBe("deleted");
    expect(await t.loginKeyExists("octocat")).toBe(false);
    expect(await t.read("u1")).toBeNull();
    expect(await t.linkedAt("u1")).toBeNull();
    expect(await t.isBlocked("octocat")).toBe(true);
    expect(await t.record("u2", "octocat")).toBe("blocked");
  });

  it("a restore for a deleted player leaves a login another account linked meanwhile unblocked", async () => {
    const t = fresh();
    await t.accounts("u1", "u2");
    await t.record("u1", "octocat");
    const taken = await t.take("u1");
    expect(await t.record("u2", "octocat")).toBe("linked");
    await t.dropAccount("u1");
    expect(await t.restore("u1", taken!)).toBe("deleted");
    expect(await t.resolve("octocat")).toBe("u2");
    expect(await t.isBlocked("octocat")).toBe(false);
    expect(await t.read("u1")).toBeNull();
  });
});
