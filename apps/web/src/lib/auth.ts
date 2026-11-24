import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getOAuthState, getSessionFromCtx } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { username } from "better-auth/plugins";
import type { BetterAuthOptions } from "better-auth";
import { redisAdapter } from "@/lib/auth-store/redis-adapter";
import { errorLabel } from "@/lib/error-label";
import { getGithubLink, isReleasedAndBlocked, linkOnUserWrite } from "@/lib/github-link";
import { recordSignIn } from "@/lib/activity-log";
import { limitAuthAttempt } from "@/lib/auth-rate-limit";
import { placeholderEmail } from "@/lib/placeholder-email";
import { getAdminSettings } from "@/lib/admin-store";
import { SIGN_IN_PROVIDERS, enabledSignInProviders, type SignInProviderId } from "@/lib/sign-in-providers";
import { buildSocialProviders } from "@/lib/social-providers";
import { USERNAME_MAX, USERNAME_MIN, normalizeUsername, usernameProblem } from "@/lib/username-rules";

type AuthCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** The only keys a `/sign-up/email` body may carry. */
const SIGN_UP_FIELDS = new Set(["username", "password", "displayUsername", "callbackURL", "rememberMe"]);

function refuseSignUp(message: string): never {
  throw new APIError("BAD_REQUEST", { message, code: "SIGN_UP_FIELD_REFUSED" });
}

/**
 * The `/sign-up/email` before hook. better-auth's sign-up body schema admits
 * any extra key and runs the rest through parseUserInput, which accepts every
 * user field whose `input` is not false: `login`, the identity everything
 * keys on, among them. So the body is an allowlist, and an account's email
 * and name are set here, never by the client: the email is a placeholder
 * (a username account has no address) and the name is the username as typed.
 * A `displayUsername` must itself be a valid username (so no lookalike
 * character lowercases into the ASCII set) and the same username in another
 * case, so nobody displays as somebody else.
 *
 * It runs before the endpoint validates the body, and better-auth hands the
 * endpoint the object this mutates (the username plugin's own hooks rely on
 * the same order).
 */
export async function refuseSignUpFields(ctx: AuthCtx): Promise<void> {
  if (ctx.path !== "/sign-up/email") return;
  const body: unknown = ctx.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) refuseSignUp("A username and password are required.");
  const fields = body as Record<string, unknown>;
  const extra = Object.keys(fields).filter((k) => !SIGN_UP_FIELDS.has(k));
  if (extra.length > 0) refuseSignUp("Only a username and password can be set at sign-up.");
  if (typeof fields.username !== "string") refuseSignUp("A username and password are required.");
  const typed = fields.username.trim();
  let shown = typed;
  if (fields.displayUsername !== undefined) {
    if (
      typeof fields.displayUsername !== "string" ||
      usernameProblem(fields.displayUsername) !== null ||
      normalizeUsername(fields.displayUsername) !== normalizeUsername(typed)
    ) {
      refuseSignUp("The display name must be your username.");
    }
    shown = fields.displayUsername.trim();
  }
  fields.username = typed;
  fields.displayUsername = shown;
  fields.email = placeholderEmail();
  fields.name = shown;
}

/**
 * An OAuth provider is used for identity only, through its redirect flow.
 * better-auth forwards a client-supplied `scopes` and `additionalParams` into
 * the provider authorization URL, and an `idToken` skips the redirect: the
 * endpoint verifies the token and signs the caller in (or links the account)
 * on the spot. A request carrying any of the three keys (any value, an empty
 * one included) is refused with a 400 instead of trimmed, which makes a
 * tampered client fail loudly.
 */
export async function refuseClientOAuthParams(ctx: AuthCtx): Promise<void> {
  if (ctx.path !== "/sign-in/social" && ctx.path !== "/link-social") return;
  const body = ctx.body;
  if (typeof body !== "object" || body === null) return;
  if (Object.hasOwn(body, "scopes") || Object.hasOwn(body, "additionalParams") || Object.hasOwn(body, "idToken")) {
    throw new APIError("BAD_REQUEST", {
      message: "OAuth scopes and parameters cannot be set by the client.",
      code: "OAUTH_PARAMS_NOT_ALLOWED",
    });
  }
}

function isSignInProvider(value: unknown): value is SignInProviderId {
  return typeof value === "string" && (SIGN_IN_PROVIDERS as readonly string[]).includes(value);
}

const providerDisabled = () =>
  new APIError("FORBIDDEN", { code: "PROVIDER_DISABLED", message: "That sign-in option is not available." });
const linkNotAllowed = () =>
  new APIError("BAD_REQUEST", { code: "LINK_PROVIDER_NOT_ALLOWED", message: "Only a GitHub account can be linked." });

/** Throws unless `provider` is GitHub, its keys are set and its admin switch
 *  is on. An unreadable switch fails closed: an organizer may have switched
 *  GitHub sign-in off for a reason. */
async function assertSignInEnabled(provider: unknown): Promise<void> {
  if (!isSignInProvider(provider)) throw providerDisabled();
  let enabled: SignInProviderId[];
  try {
    enabled = enabledSignInProviders(await getAdminSettings(), process.env);
  } catch (err) {
    console.error(`[auth] could not read sign-in switches: ${errorLabel(err)}`);
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "SIGN_IN_SETTINGS_UNREADABLE",
      message: "Sign-in options could not be loaded. Try again.",
    });
  }
  if (!enabled.includes(provider)) throw providerDisabled();
}

/**
 * The `/sign-in/social` and `/link-social` before hook. Sign-in takes only
 * GitHub, with keys set and its admin switch on. A link is to GitHub
 * alone (it is what ties a player to a PR author) and ignores the switch: an
 * organizer can close GitHub sign-in and still let Secure Development players
 * link. This gates only the start of a flow; gateOAuthCallback gates its
 * completion.
 */
export async function refuseDisabledProvider(ctx: AuthCtx): Promise<void> {
  if (ctx.path !== "/sign-in/social" && ctx.path !== "/link-social") return;
  const body: unknown = ctx.body;
  const provider = typeof body === "object" && body !== null ? (body as Record<string, unknown>).provider : undefined;
  if (ctx.path === "/link-social") {
    if (provider !== "github") throw linkNotAllowed();
    return;
  }
  await assertSignInEnabled(provider);
}

/** What a database hook on the callback is about to write. */
export type CallbackWrite = "user" | "account" | "session";

type HookCtx = { path?: string; params?: Record<string, unknown> } | null | undefined;

// One verdict per callback request: the parsed state object is the request's
// own, so every write of one callback shares a single settings read.
const callbackVerdicts = new WeakMap<object, Promise<void>>();

/**
 * Gates the completion of an OAuth flow, from the user, account and session
 * database hooks on `/callback/:id`. The OAuth state does not name a provider
 * and the callback takes it from the URL, and a state minted while GitHub
 * sign-in was on can reach the callback after an organizer switches it off;
 * refuseDisabledProvider alone would not stop that. So, judged by the
 * provider in the URL and by the state the callback parsed (better-auth takes
 * the link branch on a truthy `link`, and so does this):
 *   - a link writes only a GitHub account and never creates a session;
 *   - a sign-in writes nothing unless GitHub's switch is on.
 * GitHub is the only provider mounted (social-providers.ts), so a callback
 * naming any other id never reaches these hooks; the provider check stays so
 * the gate does not depend on that.
 * On a sign-in the thrown APIError's code becomes the callback's error
 * redirect, and a refused create inside the user-and-account transaction
 * rolls both rows back. The link branch does not catch it, so a refused link
 * is the endpoint's own 400.
 */
export async function gateOAuthCallback(ctx: HookCtx, write: CallbackWrite): Promise<void> {
  if (ctx?.path !== "/callback/:id") return;
  const provider = ctx.params?.id;
  // Outside a request's state (never on a real callback) this reads as no
  // state, which is judged as a sign-in: the stricter of the two.
  const state = await getOAuthState().catch(() => null);
  if (state?.link) {
    if (write === "session" || provider !== "github") throw linkNotAllowed();
    return;
  }
  if (!state) return assertSignInEnabled(provider);
  let verdict = callbackVerdicts.get(state);
  if (!verdict) {
    verdict = assertSignInEnabled(provider);
    callbackVerdicts.set(state, verdict);
  }
  return verdict;
}

/**
 * A GitHub sign-in that would create an account for a login an organizer's
 * delete released and blocked (`ctf:relink:blocked`, until the next master
 * reset). Without it, a deleted player clicks "Sign in with GitHub" and gets
 * a fresh account straight away. Runs on the user create of a sign-in
 * callback only: a link never creates a user, and a returning player still
 * has a row (an update, not a create). Throwing rolls back the user and
 * account rows together; an unreadable blocklist refuses (fail closed).
 */
export async function refuseBlockedGithubSignIn(user: Record<string, unknown> | null | undefined, ctx: HookCtx): Promise<void> {
  if (ctx?.path !== "/callback/:id") return;
  const login = user?.login;
  if (typeof login !== "string" || login === "") return;
  let blocked: boolean;
  try {
    blocked = await isReleasedAndBlocked(login);
  } catch (err) {
    console.error(`[auth] could not read the re-link blocklist on sign-in: ${errorLabel(err)}`);
    throw new APIError("SERVICE_UNAVAILABLE", { message: "Could not check this GitHub account. Try again.", code: "GITHUB_BLOCKLIST_UNREADABLE" });
  }
  if (blocked) {
    throw new APIError("FORBIDDEN", { message: "This GitHub account cannot sign in to this event.", code: "GITHUB_BLOCKED" });
  }
}

/**
 * The `/link-social` before hook. One GitHub account links to one kit
 * account and a player cannot unlink, so a player whose link is recorded
 * cannot start a second one: better-auth would add a second account row and
 * the link write would move the player's link off the old login. A link the
 * kit refused or never recorded (no `ctf:link:user:<id>`) can still be
 * retried. An unreadable link fails closed. A request with no session is left
 * to the endpoint, which answers 401.
 */
export async function refuseSecondGithubLink(ctx: AuthCtx): Promise<void> {
  if (ctx.path !== "/link-social") return;
  const session = await getSessionFromCtx(ctx);
  if (!session) return;
  let link: Awaited<ReturnType<typeof getGithubLink>>;
  try {
    link = await getGithubLink(session.user.id);
  } catch (err) {
    console.error(`[auth] could not read github link before linking: ${errorLabel(err)}`);
    throw new APIError("SERVICE_UNAVAILABLE", { message: "Could not check your GitHub link. Try again.", code: "GITHUB_LINK_UNREADABLE" });
  }
  if (link) {
    throw new APIError("FORBIDDEN", { message: "A GitHub account is already linked.", code: "GITHUB_ALREADY_LINKED" });
  }
}

/**
 * better-auth instance backed by the app's Redis (`redisAdapter`): users,
 * linked accounts and sessions are records under `ctf:auth:`, so a session can
 * be revoked server-side.
 *
 * Invariants:
 *   - `ctf:auth:` sits outside every master-reset prefix (`RESET_PREFIXES`), so
 *     a reset keeps accounts and signed-in contestants stay signed in.
 *   - The event archive never reads or writes these keys.
 *   - Provider tokens are never stored: the adapter nulls every provider's
 *     access, refresh and id tokens on every write, and `storeAccountCookie` is off.
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
  advanced: {
    database: {
      // Lowercase v4 UUIDs: a `.toLowerCase()` join is then the identity on a
      // player id, and no id contains ":" (the solves hash splits
      // `<player>:<challenge>` at the first one). See PLAYER_ID_RE.
      generateId: () => crypto.randomUUID(),
    },
  },
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
    // better-auth would otherwise be free to mirror the provider access and
    // refresh tokens into a client-side `better-auth.account_data` cookie. This
    // app never calls a provider API and only reads
    // session.user.{login,name,email,image}, so token material is attack
    // surface with no use (OWASP A04, data minimisation). The adapter also
    // nulls the tokens on the stored account row.
    storeAccountCookie: false,
    // A verified email does not prove two provider accounts are one person (an
    // address can move between accounts), so a sign-in from a provider identity
    // that has no account row never attaches to a user found by email: each
    // provider identity is its own user (and the mapped email is a fresh
    // placeholder, social-providers.ts, so none could match). Explicit GitHub
    // linking stays available.
    //
    // allowDifferentEmails: a kit account's email is not an identity (kit-owned
    // accounts carry a placeholder), so it never matches the GitHub one. What
    // proves the link is completing GitHub OAuth from a live kit session, which
    // better-auth checks on the callback.
    //
    // updateUserInfoOnLink copies the GitHub profile onto the user at link
    // time, which is how `login` reaches the row and the user.update.after hook
    // records the link. The update.before hook below keeps the kit name and
    // avatar out of it.
    accountLinking: { disableImplicitLinking: true, allowDifferentEmails: true, updateUserInfoOnLink: true },
  },
  // Username and password accounts. No reset mail is configured, so a
  // forgotten password is an organizer's job, and the reset endpoints stay
  // closed below. requireEmailVerification is off: the email is a placeholder.
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    autoSignIn: true,
    requireEmailVerification: false,
  },
  // better-auth's own limiter is off on every path. It keeps per-instance
  // memory, keys on the leftmost x-forwarded-for entry (which the client
  // chooses), and allows 3 sign-ins per 10 s on every /sign-in* path, which
  // would lock a NAT'd room out of OAuth sign-in. limitAuthAttempt
  // (auth-rate-limit.ts) charges Redis budgets, shared by every instance and
  // keyed on the proxy-vouched address (client-ip.ts), on /sign-up/email, /sign-in/username,
  // /sign-in/social and /link-social. It leaves /callback/:id (it consumes a
  // state row a charged request wrote), /get-session and /sign-out (every
  // page load) and the closed paths alone.
  rateLimit: { enabled: false },
  // better-auth mounts its full default endpoint set, and each plugin's,
  // behind the catch-all at app/api/auth/[...all]. This app calls seven of
  // them: /sign-up/email, /sign-in/username, /sign-in/social, /link-social,
  // /callback/:id, /get-session and /sign-out. Everything below is an endpoint
  // this app never calls that mutates the signed-in identity, reads account
  // data, or hands back provider data, so it is closed at the network edge.
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
    // Identity and credential mutation. /sign-up/email is not here: it is
    // open, and like /update-user it parses a request body into the user row,
    // so refuseSignUpFields allowlists its body. Sign-in is by username only,
    // since a username account's email is a placeholder. There is no password
    // change or reset; with no sendResetPassword configured,
    // /request-password-reset answers RESET_PASSWORD_DISABLED anyway.
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
    // Unlinking, and the linked-provider disclosure endpoints. /link-social is
    // open: it starts GitHub OAuth for the signed-in player and links only
    // after the callback proves the GitHub account. A player cannot unlink,
    // and one already linked cannot start a second link (refuseSecondGithubLink).
    "/unlink-account",
    "/list-accounts",
    "/account-info",
    // These two exist purely to hand a provider token back to the caller.
    // /get-access-token returns a provider access token as JSON to anyone
    // holding a valid session cookie — an oracle that would turn a stolen
    // session into a usable provider token. Disabling them means a session
    // compromise can't be escalated into a provider token.
    "/get-access-token",
    "/refresh-token",
    // The username plugin's availability probe: an unthrottled oracle for
    // which usernames exist. Sign-up answers USERNAME_IS_ALREADY_TAKEN.
    "/is-username-available",
  ],
  databaseHooks: {
    // The GitHub login a player signs in with is recorded as their link
    // (github-link.ts). better-auth writes the user row on every GitHub
    // sign-in: create for a new player, update (overrideUserInfoOnSignIn
    // below) for a returning one, so a renamed account re-links here. A link
    // from /link-social writes it through updateUserInfoOnLink.
    //
    // On the OAuth callback (a sign-in or a link) the provider profile carries
    // only GitHub's `login` onto the row: the player's name and avatar are
    // their own, and the email stays the placeholder minted at creation (each
    // mapping mints a fresh one). better-auth merges the returned data over its
    // own, so the fields are set to undefined, which its adapter skips on
    // update, rather than left out.
    //
    // Every user, account and session write on the callback passes
    // gateOAuthCallback first.
    user: {
      create: {
        before: async (user, ctx) => {
          await gateOAuthCallback(ctx, "user");
          await refuseBlockedGithubSignIn(user, ctx);
        },
        after: async (user) => linkOnUserWrite(user),
      },
      update: {
        before: async (data, ctx) => {
          if (ctx?.path !== "/callback/:id") return;
          await gateOAuthCallback(ctx, "user");
          return { data: { ...data, email: undefined, name: undefined, image: undefined } };
        },
        after: async (user) => linkOnUserWrite(user),
      },
    },
    account: {
      create: { before: async (_account, ctx) => gateOAuthCallback(ctx, "account") },
      update: { before: async (_account, ctx) => gateOAuthCallback(ctx, "account") },
    },
    session: {
      create: { before: async (_session, ctx) => gateOAuthCallback(ctx, "session") },
    },
  },
  hooks: {
    // In this order: the rate limit is charged before anything reads the
    // body, and the body checks run before the switch and link reads. Each check
    // returns early off its own path.
    before: createAuthMiddleware(async (ctx) => {
      await limitAuthAttempt(ctx);
      await refuseSignUpFields(ctx);
      await refuseClientOAuthParams(ctx);
      await refuseDisabledProvider(ctx);
      await refuseSecondGithubLink(ctx);
    }),
    // Sign-in timestamps for the admin activity log. The after hook runs on
    // EVERY auth endpoint; recordSignIn filters to the paths where a fresh
    // session means "signed in" (the OAuth callback, username sign-in and
    // sign-up) and extracts the player. A refused sign-in makes no session,
    // so it logs nothing. It is fail-open all the way down: a Redis blip can
    // lose the log line but can never fail the sign-in.
    after: createAuthMiddleware(async (ctx) => {
      await recordSignIn(ctx.path, ctx.context.newSession);
    }),
  },
  // GitHub when its keys are set; refuseDisabledProvider applies the admin
  // switch per request.
  socialProviders: buildSocialProviders(),
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
      // funnels a request body through parseUserInput. There are two:
      // /update-user, which is closed above, and /sign-up/email, which is
      // open and closed to every identity field by refuseSignUpFields. If you
      // add an auth plugin that registers another one (phone-number and
      // email-otp both do), it inherits the same write path and must be
      // closed too. The durable fix is to resolve `login` from the linked
      // GitHub account row rather than trusting the user row's copy.
      login: { type: "string", required: false },
    },
  },
  plugins: [
    // usernameNormalization is the throttle's key function too, so the stored
    // username and the sign-in budget it is charged to always agree.
    username({
      minUsernameLength: USERNAME_MIN,
      maxUsernameLength: USERNAME_MAX,
      usernameValidator: (u) => usernameProblem(u) === null,
      usernameNormalization: normalizeUsername,
    }),
    nextCookies(), // keep last
  ],
} satisfies BetterAuthOptions;

export const auth = betterAuth(authOptions);

export type Session = typeof auth.$Infer.Session;
