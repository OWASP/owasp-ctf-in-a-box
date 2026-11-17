import { describe, expect, it } from "vitest";
import { configuredProviders, enabledSignInProviders } from "../sign-in-providers";

const allSix = {
  GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b",
  GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "d",
  DISCORD_CLIENT_ID: "e", DISCORD_CLIENT_SECRET: "f",
};

describe("configuredProviders", () => {
  it("needs both id and a non-blank secret", () => {
    expect(configuredProviders({
      GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b",
      GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "  ",
    })).toEqual(["github"]);
  });
  it("is empty with no keys", () => {
    expect(configuredProviders({})).toEqual([]);
  });
  it("follows registry order", () => {
    expect(configuredProviders(allSix)).toEqual(["github", "google", "discord"]);
  });
});

describe("enabledSignInProviders", () => {
  it("drops providers whose switch is off", () => {
    expect(enabledSignInProviders({ signInProviders: { github: false, google: true, discord: true } }, allSix))
      .toEqual(["google", "discord"]);
  });
  it("never enables a provider without keys", () => {
    expect(enabledSignInProviders(
      { signInProviders: { github: true, google: true, discord: true } },
      { DISCORD_CLIENT_ID: "x", DISCORD_CLIENT_SECRET: "y" },
    )).toEqual(["discord"]);
  });
});
