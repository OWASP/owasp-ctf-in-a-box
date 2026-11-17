import type { BetterAuthOptions } from "better-auth";
import { placeholderEmail } from "@/lib/placeholder-email";
import { PROVIDER_ENV, configuredProviders } from "@/lib/sign-in-providers";

type Env = Record<string, string | undefined>;

/**
 * The better-auth `socialProviders` object: one entry per provider with keys
 * (sign-in-providers.ts), and no others, so an unconfigured provider is not
 * even mounted. Whether a configured one may be used is the admin switch,
 * checked per request by refuseDisabledProvider in auth.ts.
 *
 * better-auth spreads mapProfileToUser's result over its own mapping of the
 * profile, and the OAuth callback looks a user up by account, then by that
 * mapped email. So every field set here replaces the provider's value:
 *   - email is always a fresh placeholder, so a provider address never
 *     reaches the user row and never matches an existing user;
 *   - only GitHub sets `login`, the identity a PR author resolves through.
 *     Google and Discord set the name to "player" and the image to undefined
 *     (the mapper type admits no null), so the profile's name and picture
 *     never reach the row either.
 */
export function buildSocialProviders(env: Env = process.env): BetterAuthOptions["socialProviders"] {
  const configured = configuredProviders(env);
  const keys = (p: keyof typeof PROVIDER_ENV) => ({
    clientId: env[PROVIDER_ENV[p].id]!.trim(),
    clientSecret: env[PROVIDER_ENV[p].secret]!.trim(),
  });
  const anonymous = () => ({ email: placeholderEmail(), name: "player", image: undefined });
  return {
    ...(configured.includes("github") && {
      github: {
        ...keys("github"),
        mapProfileToUser: (profile) => ({ login: profile.login, email: placeholderEmail() }),
        // Re-applies the mapping on every sign-in so `login` follows a renamed
        // GitHub account. The user.update.before hook in auth.ts keeps the
        // stored email, name and avatar out of that update.
        overrideUserInfoOnSignIn: true,
      },
    }),
    ...(configured.includes("google") && { google: { ...keys("google"), mapProfileToUser: anonymous } }),
    ...(configured.includes("discord") && { discord: { ...keys("discord"), mapProfileToUser: anonymous } }),
  };
}
