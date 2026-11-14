import { beforeEach, describe, expect, it, vi } from "vitest";

const upstash = vi.hoisted(() => ({ upstashPipeline: vi.fn(), upstashEval: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => upstash);

import { getGithubLink, linkKey, linkOnUserWrite, recordGithubSignIn, resolveGithubLogin } from "@/lib/github-link";

beforeEach(() => {
  upstash.upstashPipeline.mockReset();
  upstash.upstashEval.mockReset();
});

describe("github link", () => {
  it("lowercases the login in the key", () => {
    expect(linkKey("OctoCat")).toBe("ctf:link:github:octocat");
  });

  it("throws when the GET result carries an error", async () => {
    upstash.upstashPipeline.mockResolvedValue([{ error: "NOAUTH" }]);
    await expect(resolveGithubLogin("octo")).rejects.toThrow(/NOAUTH/);
  });

  it("returns null for an unlinked login", async () => {
    upstash.upstashPipeline.mockResolvedValue([{ result: null }]);
    expect(await resolveGithubLogin("Octo")).toBeNull();
  });

  it("passes the lowercased login and both keys to the script", async () => {
    upstash.upstashEval.mockResolvedValue("linked");
    await recordGithubSignIn("id-1", "OctoCat");
    const [, keys, args] = upstash.upstashEval.mock.calls[0];
    expect(keys).toEqual(["ctf:link:github:octocat", "ctf:link:user:id-1", "ctf:link:at"]);
    expect(args.slice(0, 3)).toEqual(["id-1", "octocat", "ctf:link:github:"]);
  });

  it("passes the current epoch ms to the script", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1731500000000));
      upstash.upstashEval.mockResolvedValue("linked");
      await recordGithubSignIn("id-1", "octo");
      const [, , args] = upstash.upstashEval.mock.calls[0];
      expect(args[3]).toBe("1731500000000");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("getGithubLink", () => {
    it("reads the reverse pointer and the link time in one pipeline", async () => {
      upstash.upstashPipeline.mockResolvedValue([{ result: "octocat" }, { result: "1731500000000" }]);
      expect(await getGithubLink("id-1")).toEqual({ login: "octocat", linkedAt: 1731500000000 });
      expect(upstash.upstashPipeline).toHaveBeenCalledWith([
        ["GET", "ctf:link:user:id-1"],
        ["HGET", "ctf:link:at", "id-1"],
      ]);
    });

    it("returns null when the player has no link", async () => {
      upstash.upstashPipeline.mockResolvedValue([{ result: null }, { result: null }]);
      expect(await getGithubLink("id-1")).toBeNull();
    });

    it("returns a null time when only the login is set", async () => {
      upstash.upstashPipeline.mockResolvedValue([{ result: "octocat" }, { result: null }]);
      expect(await getGithubLink("id-1")).toEqual({ login: "octocat", linkedAt: null });
    });

    // Sync's resolveGithubLink accepts only a safe decimal integer; anything
    // else is no time, which counts as after the close in both places.
    it.each(["", " ", "-5", "1e3", "12.5", "0x10", "99999999999999999999"])("reads link time %j as no time", async (raw) => {
      upstash.upstashPipeline.mockResolvedValue([{ result: "octocat" }, { result: raw }]);
      expect(await getGithubLink("id-1")).toEqual({ login: "octocat", linkedAt: null });
    });

    it("throws when either reply carries an error", async () => {
      upstash.upstashPipeline.mockResolvedValue([{ error: "NOAUTH" }, { result: null }]);
      await expect(getGithubLink("id-1")).rejects.toThrow(/NOAUTH/);
      upstash.upstashPipeline.mockResolvedValue([{ result: "octocat" }, { error: "WRONGTYPE" }]);
      await expect(getGithubLink("id-1")).rejects.toThrow(/WRONGTYPE/);
    });
  });

  it("rejects an unexpected script reply", async () => {
    upstash.upstashEval.mockResolvedValue(null);
    await expect(recordGithubSignIn("id-1", "octo")).rejects.toThrow(/unexpected/);
  });

  describe("linkOnUserWrite", () => {
    it("records the link for a user with a login", async () => {
      upstash.upstashEval.mockResolvedValue("linked");
      await linkOnUserWrite({ id: "id-1", login: "Octo" });
      expect(upstash.upstashEval).toHaveBeenCalledTimes(1);
    });

    it("skips a user with no login or an empty one", async () => {
      await linkOnUserWrite({ id: "id-1" });
      await linkOnUserWrite({ id: "id-1", login: "" });
      await linkOnUserWrite(null);
      expect(upstash.upstashEval).not.toHaveBeenCalled();
    });

    it("logs taken without the login or id, and does not throw", async () => {
      upstash.upstashEval.mockResolvedValue("taken");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await linkOnUserWrite({ id: "id-secret", login: "secret-login" });
      const line = String(spy.mock.calls[0]?.[0]);
      spy.mockRestore();
      expect(line).toBe("[auth] github login already linked to another player");
    });

    it("swallows a Redis error and logs only its label", async () => {
      upstash.upstashEval.mockRejectedValue(new Error("boom"));
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await linkOnUserWrite({ id: "id-1", login: "octo" });
      const line = String(spy.mock.calls[0]?.[0]);
      spy.mockRestore();
      expect(line).toContain("Error: boom");
      expect(line).not.toContain("octo");
    });
  });
});
