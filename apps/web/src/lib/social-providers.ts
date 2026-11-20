import type { BetterAuthOptions } from "better-auth";
import { placeholderEmail } from "@/lib/placeholder-email";
import { PROVIDER_ENV, configuredProviders } from "@/lib/sign-in-providers";

type Env = Record<string, string | undefined>;

/**
 * The better-auth `socialProviders` object: a GitHub entry when its keys are
 * set (sign-in-providers.ts), and nothing otherwise, so an unconfigured
 * provider is not even mounted. Whether GitHub sign-in may be used is the
 * admin switch, checked per request by refuseDisabledProvider in auth.ts.
 *
 * better-auth spreads mapProfileToUser's result over its own mapping of the
 * profile, and the OAuth callback looks a user up by account, then by that
 * mapped email. So every field set here replaces the provider's value:
 *   - email is always a fresh placeholder, so a provider address never
 *     reaches the user row and never matches an existing user;
 *   - `login` is the identity a PR author resolves through.
 */
export function buildSocialProviders(env: Env = process.env): BetterAuthOptions["socialProviders"] {
  if (!configuredProviders(env).includes("github")) return {};
  return {
    github: {
      clientId: env[PROVIDER_ENV.github.id]!.trim(),
      clientSecret: env[PROVIDER_ENV.github.secret]!.trim(),
      mapProfileToUser: (profile) => ({ login: profile.login, email: placeholderEmail() }),
      // Re-applies the mapping on every sign-in so `login` follows a renamed
      // GitHub account. The user.update.before hook in auth.ts keeps the
      // stored email, name and avatar out of that update.
      overrideUserInfoOnSignIn: true,
    },
  };
}
