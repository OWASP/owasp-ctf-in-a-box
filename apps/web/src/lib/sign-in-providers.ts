// Registry of the OAuth sign-in providers. A dependency-free leaf with no
// `server-only`, so the admin client bundle can import the ids and labels;
// the env read takes `env` as a parameter for the same reason.

export const SIGN_IN_PROVIDERS = ["github", "google", "discord"] as const;
export type SignInProviderId = (typeof SIGN_IN_PROVIDERS)[number];

export const PROVIDER_LABEL: Record<SignInProviderId, string> = {
  github: "GitHub",
  google: "Google",
  discord: "Discord",
};

export const PROVIDER_ENV: Record<SignInProviderId, { id: string; secret: string }> = {
  github: { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
  google: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  discord: { id: "DISCORD_CLIENT_ID", secret: "DISCORD_CLIENT_SECRET" },
};

/** The admin-settings field holding each provider's on/off switch. */
export const PROVIDER_SWITCH_FIELD: Record<
  SignInProviderId,
  "signInGithub" | "signInGoogle" | "signInDiscord"
> = {
  github: "signInGithub",
  google: "signInGoogle",
  discord: "signInDiscord",
};

type Env = Record<string, string | undefined>;

/** Providers with both a client id and secret set (non-blank after trim), in
 *  registry order. */
export function configuredProviders(env: Env = process.env): SignInProviderId[] {
  return SIGN_IN_PROVIDERS.filter((p) => {
    const { id, secret } = PROVIDER_ENV[p];
    return (env[id] ?? "").trim() !== "" && (env[secret] ?? "").trim() !== "";
  });
}

/** Configured providers whose switch is on. A switch that is on without keys
 *  is never enabled. */
export function enabledSignInProviders(
  settings: { signInProviders: Record<SignInProviderId, boolean> },
  env: Env = process.env,
): SignInProviderId[] {
  return configuredProviders(env).filter((p) => settings.signInProviders[p]);
}
