import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import type { BetterAuthOptions } from "better-auth";
import { redisAdapter } from "@/lib/auth-store/redis-adapter";
import { recordCallbackLogin } from "@/lib/activity-log";

/**
 * better-auth instance backed by the app's Redis (`redisAdapter`): users,
 * linked accounts and sessions are records under `ctf:auth:`, so a session can
 * be revoked server-side.
 *
 * Invariants:
 *   - `ctf:auth:` sits outside every master-reset prefix (`RESET_PREFIXES`), so
 *     a reset keeps accounts and signed-in contestants stay signed in.
 *   - The event archive never reads or writes these keys.
 *   - Provider tokens are never stored: the adapter nulls the GitHub access,
 *     refresh and id tokens on every write, and `storeAccountCookie` is off.
 *   - The JWE cookie cache lets a request skip the Redis read for up to
 *     `cookieCache.maxAge`, so that is the longest a sign-out or deleted
 *     session keeps working on another device.
 *
 * Bumping `session.cookieCache.version` only makes every request re-read its
 * session from Redis; nobody is signed out. The mass sign-out levers are
 * deleting the `ctf:auth:session` rows (and their index sets) or rotating
 * `BETTER_AUTH_SECRET`.
 */
export const authOptions = {
  database: redisAdapter(),
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  session: {
    expiresIn: 7 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // bounds how long a revoked session keeps working
      strategy: "jwe",
      // No `refreshCache`: it reissues the cookie cache without reading the
      // session row, so a revoked session would never be noticed. better-auth
      // ignores it with a database configured; leaving it out keeps that true
      // even if it stops doing so. `version` must never be "1": cookies minted
      // under "1" are stateless caches valid for 7 days, and would be trusted.
      version: "2",
    },
  },
  account: {
    // better-auth would otherwise be free to mirror the GitHub access and
    // refresh tokens into a client-side `better-auth.account_data` cookie. This
    // app never calls the GitHub API and only reads
    // session.user.{login,name,email,image}, so token material is attack
    // surface with no use (OWASP A04, data minimisation). The adapter also
    // nulls the tokens on the stored account row.
    storeAccountCookie: false,
  },
  // better-auth mounts its full default endpoint set behind the catch-all at
  // app/api/auth/[...all]. This app only ever calls four of them: /sign-in/social,
  // /callback/:id, /get-session and /sign-out. Everything below is a default
  // endpoint that this app never calls and that either mutates the signed-in
  // identity or hands back provider data, so it is closed at the network edge.
  //
  // disabledPaths is enforced in the router's onRequest (api/index.mjs) as an
  // unconditional 404, before originCheck, before rate limiting, and before
  // sessionMiddleware. Three consequences worth knowing:
  //   - Matching is an exact string compare against normalizePathname(), which
  //     returns the literal request path. It is NOT route-pattern matching, so
  //     a parameterized route like "/reset-password/:token" can never be closed
  //     this way — listing it would look like protection and be none.
  //   - It is a denylist. Adding an auth plugin can introduce new endpoints
  //     that are NOT covered here. auth.test.ts fails when that happens.
  //   - It guards the HTTP boundary only. A server-side auth.api.updateUser()
  //     call bypasses it entirely. No app code makes one; that is an invariant,
  //     not something this setting enforces.
  disabledPaths: [
    // THE IMPORTANT ONE. /update-user takes an arbitrary
    // `z.record(z.string(), z.any())` body behind nothing but sessionMiddleware,
    // runs it through parseUserInput — which accepts any additionalField whose
    // `input` is not false, i.e. `login` — and writes the result to the user
    // row and the session. Any signed-in contestant could POST
    // {"login":"someone-else"} and thereafter spend that person's points on
    // hints or move them between teams. Six handlers key their store writes off
    // session.user.login.
    "/update-user",
    // Same shape as /update-user: an arbitrary body behind sessionMiddleware,
    // parsed into the session row. Inert only because this app declares
    // no session.additionalFields, so the parse always comes back empty.
    // Declaring one would make this writable, silently.
    "/update-session",
    // Identity and credential mutation. Verified inert today — /sign-up/email
    // answers EMAIL_PASSWORD_SIGN_UP_DISABLED and /request-password-reset
    // answers RESET_PASSWORD_DISABLED, because no email/password provider is
    // configured. They stay closed so that enabling one later cannot quietly
    // introduce a second identity path where `login` is settable at sign-up.
    "/sign-up/email",
    "/sign-in/email",
    "/change-email",
    "/change-password",
    "/verify-password",
    "/verify-email",
    "/send-verification-email",
    "/request-password-reset",
    "/reset-password",
    "/delete-user",
    "/delete-user/callback",
    // Session enumeration and revocation by the client. The app signs out
    // through /sign-out only; nothing needs to list or revoke other sessions.
    "/list-sessions",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
    // Account linking, and the linked-provider disclosure endpoints.
    "/link-social",
    "/unlink-account",
    "/list-accounts",
    "/account-info",
    // These two exist purely to hand a provider token back to the caller.
    // /get-access-token returns a provider access token as JSON to anyone
    // holding a valid session cookie — an oracle that would turn a stolen
    // session into a usable GitHub token. Disabling them means a session compromise can't be escalated
    // into a GitHub token.
    "/get-access-token",
    "/refresh-token",
  ],
  hooks: {
    // Sign-in timestamps for the admin activity log (issue #212). The after
    // hook runs on EVERY auth endpoint; recordCallbackLogin filters to the
    // OAuth callback (the one path where a fresh session means "signed in")
    // and extracts the login. It is fail-open all the way down — a Redis
    // blip can lose the log line but can never fail the sign-in.
    after: createAuthMiddleware(async (ctx) => {
      await recordCallbackLogin(ctx.path, ctx.context.newSession);
    }),
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      // The GitHub login is the leaderboard row key (the scorer records the
      // PR author's login), so capture it — name/email/image aren't enough.
      mapProfileToUser: (profile) => ({ login: profile.login }),
      // Re-applies the profile on every sign-in so `login` follows a renamed
      // GitHub account; the stored user row would otherwise keep the old one.
      overrideUserInfoOnSignIn: true,
    },
  },
  user: {
    additionalFields: {
      // SECURITY-RELEVANT FIELD. `login` is the contestant's identity: it keys
      // the leaderboard row, hint spend, and team membership.
      //
      // `input: true` (the default) is required here, and is NOT an oversight.
      // better-auth's parseAdditionalUserInputFromProviderProfile
      // (db/schema.mjs, `if (schema[key]?.input === false) continue`) skips
      // `input: false` fields when mapping the OAuth profile, which leaves
      // session.user.login undefined and breaks the /profile gate. Do not
      // "harden" this to `input: false` — verified against the installed
      // better-auth 1.7.16, it regresses sign-in.
      //
      // The consequence is that `login` remains writable by any endpoint that
      // funnels a request body through parseUserInput. The only such endpoint
      // is /update-user, which is closed above. If you add an auth plugin that
      // registers another one (phone-number and email-otp both do), it inherits
      // the same write path and must be closed too. The durable fix is to
      // resolve `login` from the linked GitHub account row rather than trusting
      // the user row's copy.
      login: { type: "string", required: false },
    },
  },
  plugins: [nextCookies()], // keep last
} satisfies BetterAuthOptions;

export const auth = betterAuth(authOptions);

export type Session = typeof auth.$Infer.Session;
