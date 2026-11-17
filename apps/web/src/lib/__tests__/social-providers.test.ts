import { describe, expect, it } from "vitest";
import { isPlaceholderEmail } from "../placeholder-email";
import { buildSocialProviders } from "../social-providers";

const allSix = {
  GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b",
  GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "d",
  DISCORD_CLIENT_ID: "e", DISCORD_CLIENT_SECRET: "f",
};

type Mapper = (profile: Record<string, unknown>) => Record<string, unknown>;
const mapperOf = (id: "github" | "google" | "discord") => {
  const entry = (buildSocialProviders(allSix) as Record<string, { mapProfileToUser?: unknown }>)[id];
  expect(typeof entry?.mapProfileToUser).toBe("function");
  return entry.mapProfileToUser as Mapper;
};

describe("buildSocialProviders", () => {
  it("registers nothing without keys", () => {
    expect(buildSocialProviders({})).toEqual({});
  });

  it("registers exactly the configured providers", () => {
    expect(Object.keys(buildSocialProviders({ GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "d" }) ?? {})).toEqual(["google"]);
    expect(Object.keys(buildSocialProviders(allSix) ?? {})).toEqual(["github", "google", "discord"]);
  });

  it("hands each provider its own keys", () => {
    const built = buildSocialProviders(allSix) as Record<string, { clientId: string; clientSecret: string }>;
    expect([built.github.clientId, built.github.clientSecret]).toEqual(["a", "b"]);
    expect([built.google.clientId, built.google.clientSecret]).toEqual(["c", "d"]);
    expect([built.discord.clientId, built.discord.clientSecret]).toEqual(["e", "f"]);
  });

  // The providers spread mapProfileToUser's result over their own mapping, so
  // every field the profile would otherwise fill must be present in the result.
  it.each(["google", "discord"] as const)("%s maps no identity from the profile", (id) => {
    const mapped = mapperOf(id)({
      sub: "1", id: "1", email: "real@x.com", name: "Real Name", global_name: "Real Name",
      picture: "u", image_url: "u", login: "evil",
    });
    expect(mapped).not.toHaveProperty("login");
    expect(isPlaceholderEmail(String(mapped.email))).toBe(true);
    expect(String(mapped.email)).toMatch(/@accounts\.invalid$/);
    expect(mapped.name).toBe("player");
    expect(Object.hasOwn(mapped, "image")).toBe(true);
    expect(mapped.image).toBeUndefined();
  });

  it.each(["google", "discord"] as const)("%s does not re-apply the profile on sign-in", (id) => {
    const built = buildSocialProviders(allSix) as Record<string, { overrideUserInfoOnSignIn?: boolean }>;
    expect(built[id].overrideUserInfoOnSignIn).toBeUndefined();
  });

  it("github carries the login and a placeholder email", () => {
    const mapped = mapperOf("github")({ login: "Octo", email: "o@x.com" });
    expect(mapped.login).toBe("Octo");
    expect(isPlaceholderEmail(String(mapped.email))).toBe(true);
    const built = buildSocialProviders(allSix) as Record<string, { overrideUserInfoOnSignIn?: boolean }>;
    expect(built.github.overrideUserInfoOnSignIn).toBe(true);
  });
});
