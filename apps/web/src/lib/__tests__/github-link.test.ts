import { beforeEach, describe, expect, it, vi } from "vitest";

const upstash = vi.hoisted(() => ({ upstashPipeline: vi.fn(), upstashEval: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => upstash);

import { linkKey, linkOnUserWrite, recordGithubSignIn, resolveGithubLogin } from "@/lib/github-link";

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
    expect(keys).toEqual(["ctf:link:github:octocat", "ctf:link:user:id-1"]);
    expect(args).toEqual(["id-1", "octocat", "ctf:link:github:"]);
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
