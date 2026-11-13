import { describe, expect, it, vi } from "vitest";
import { freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

import { getGithubLink, recordGithubSignIn, resolveGithubLogin } from "@/lib/github-link";
import { upstashPipeline } from "@/lib/upstash";

describe.skipIf(!liveConfigured)("recordGithubSignIn against a live SRH proxy", () => {
  function fresh() {
    const base = liveKey("link", freshId("l"));
    const gh = `${base}:github:`;
    const us = `${base}:user:`;
    const at = `${base}:at`;
    return {
      record: (id: string, login: string) => recordGithubSignIn(id, login, gh, us, at),
      resolve: (login: string) => resolveGithubLogin(login, gh),
      dropTime: async (id: string) => {
        const [r] = await upstashPipeline([["HDEL", at, id]]);
        if (r?.error) throw new Error(r.error);
      },
      linkedAt: async (id: string) => {
        const [r] = await upstashPipeline([["HGET", at, id]]);
        return r?.result ?? null;
      },
      read: (id: string) => getGithubLink(id, us, at),
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
});
