import { describe, expect, it } from "vitest";
import { isPlaceholderEmail } from "../placeholder-email";
import { buildSocialProviders } from "../social-providers";

const githubKeys = { GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b" };

type Mapper = (profile: Record<string, unknown>) => Record<string, unknown>;
type Built = Record<string, { clientId: string; clientSecret: string; mapProfileToUser?: unknown; overrideUserInfoOnSignIn?: boolean }>;

describe("buildSocialProviders", () => {
  it("registers nothing without keys", () => {
    expect(buildSocialProviders({})).toEqual({});
    expect(buildSocialProviders({ GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "  " })).toEqual({});
  });

  it("registers GitHub alone when its keys are set", () => {
    expect(Object.keys(buildSocialProviders(githubKeys) ?? {})).toEqual(["github"]);
  });

  it("hands GitHub its trimmed keys", () => {
    const built = buildSocialProviders({ GITHUB_CLIENT_ID: " a ", GITHUB_CLIENT_SECRET: "b\n" }) as Built;
    expect([built.github.clientId, built.github.clientSecret]).toEqual(["a", "b"]);
  });

  it("github carries the login and a placeholder email", () => {
    const built = buildSocialProviders(githubKeys) as Built;
    expect(typeof built.github.mapProfileToUser).toBe("function");
    const mapped = (built.github.mapProfileToUser as Mapper)({ login: "Octo", email: "o@x.com" });
    expect(mapped.login).toBe("Octo");
    expect(isPlaceholderEmail(String(mapped.email))).toBe(true);
    expect(String(mapped.email)).toMatch(/@accounts\.invalid$/);
    expect(built.github.overrideUserInfoOnSignIn).toBe(true);
  });
});
