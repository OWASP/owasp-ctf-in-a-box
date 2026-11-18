import { describe, expect, it } from "vitest";
import { SIGN_IN_PROVIDERS, configuredProviders, enabledSignInProviders } from "../sign-in-providers";

const githubKeys = { GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b" };

describe("SIGN_IN_PROVIDERS", () => {
  it("is GitHub alone", () => {
    expect(SIGN_IN_PROVIDERS).toEqual(["github"]);
  });
});

describe("configuredProviders", () => {
  it("needs both id and a non-blank secret", () => {
    expect(configuredProviders(githubKeys)).toEqual(["github"]);
    expect(configuredProviders({ GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "  " })).toEqual([]);
    expect(configuredProviders({ GITHUB_CLIENT_SECRET: "b" })).toEqual([]);
  });
  it("is empty with no keys", () => {
    expect(configuredProviders({})).toEqual([]);
  });
});

describe("enabledSignInProviders", () => {
  it("is GitHub when it has keys and its switch is on", () => {
    expect(enabledSignInProviders({ signInProviders: { github: true } }, githubKeys)).toEqual(["github"]);
  });
  it("drops GitHub when its switch is off", () => {
    expect(enabledSignInProviders({ signInProviders: { github: false } }, githubKeys)).toEqual([]);
  });
  it("never enables GitHub without keys", () => {
    expect(enabledSignInProviders({ signInProviders: { github: true } }, {})).toEqual([]);
  });
});
