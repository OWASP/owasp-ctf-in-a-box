import { describe, expect, it, vi } from "vitest";
import { freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

import { recordGithubSignIn, resolveGithubLogin } from "@/lib/github-link";

describe.skipIf(!liveConfigured)("recordGithubSignIn against a live SRH proxy", () => {
  function fresh() {
    const base = liveKey("link", freshId("l"));
    const gh = `${base}:github:`;
    const us = `${base}:user:`;
    return {
      record: (id: string, login: string) => recordGithubSignIn(id, login, gh, us),
      resolve: (login: string) => resolveGithubLogin(login, gh),
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
});
