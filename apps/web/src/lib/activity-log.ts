import "server-only";
import { errorLabel } from "@/lib/error-label";

// The activity log (issue #212): one capped Redis list of who-did-what-when
// entries, feeding the admin panel's Activity tab. Two rules govern
// everything here, both from the issue:
//
//   1. FAIL-OPEN, ALWAYS. `logActivity` is called from inside sign-in, flag
//      submission and team mutations. A Redis blip losing a log line is
//      fine; a Redis blip failing a login or dropping a correct flag is
//      not. So the writer swallows every error and never throws.
//
//   2. `detail` CARRIES IDs ONLY, NEVER ANSWERS. Challenge/question ids and
//      team slugs — never flags, hint text, or submitted answers. The log
//      is admin-only today, but the rule is what keeps it safe to
//      screen-share mid-event and safe against any future loosening of who
//      can read it.

import { upstashPipeline } from "@/lib/upstash";
import { ACTIVITY_LOG_KEY, ACTIVITY_LOG_MAX, type ActivityType } from "@/lib/activity-keys";

/** `type` is a plain string on the READ side, wider than `ActivityType` on
 *  the write side, on purpose: the list outlives deploys, so a reader must
 *  render entries written by builds with a different type vocabulary rather
 *  than dropping them. */
export type ActivityEntry = {
  at: string;
  type: string;
  /** Null on a row that names its player by GitHub login only (`login`, no
   *  `userId`): the list outlives deploys, so it can hold rows in that shape,
   *  and they render under that login rather than vanishing while `total`
   *  still counts them. */
  userId: string | null;
  name: string;
  detail?: string;
};

/** Who an entry is about: the player id, and their display name at the time
 *  of writing, so the log renders without a profile lookup per row. */
export type ActivityActor = { id: string; name: string };

/** How long a caller waits on the log write before moving on. Fail-open has
 *  to cover HANGS as well as errors: upstashPipeline's fetch carries no
 *  timeout of its own, and this writer sits inside sign-in callbacks and
 *  submit routes — a stalled Upstash request must not keep those pending. */
const LOG_WRITE_TIMEOUT_MS = 1500;

/** The display name for a bare player id, from the account store. A lookup
 *  failure or a missing profile falls back to the short-id name rather than
 *  losing the line. Imported lazily: player.ts reaches auth.ts, which imports
 *  this module for its sign-in hook. */
async function resolveActor(actor: string | ActivityActor): Promise<ActivityActor> {
  if (typeof actor !== "string") return actor;
  const { displayNameOf, getPlayerProfiles } = await import("@/lib/player");
  try {
    const profile = (await getPlayerProfiles([actor])).get(actor);
    return { id: actor, name: profile?.name ?? displayNameOf({ id: actor }) };
  } catch (err) {
    console.warn("[activity] name lookup failed", errorLabel(err));
    return { id: actor, name: displayNameOf({ id: actor }) };
  }
}

/**
 * Appends one entry and trims the list, in one pipeline — a caller can never
 * grow the list past the cap by racing the trim, because every write carries
 * its own.
 *
 * Fire-and-forget by contract: resolves (never rejects) whether or not the
 * write landed, and resolves within LOG_WRITE_TIMEOUT_MS even if Redis
 * hangs — the write itself is left running (it may still land) with its
 * rejection handled, only the caller stops waiting. Callers may `await` it
 * for ordering or drop the promise; neither can fail them.
 */
export async function logActivity(type: ActivityType, actor: string | ActivityActor, detail?: string): Promise<void> {
  try {
    const at = new Date().toISOString();
    // The catch is attached to the write BEFORE the race: if the timeout wins
    // and the write rejects later, that rejection is already handled rather
    // than surfacing as an unhandled rejection. A bare id has its name looked
    // up inside the same raced work, so a slow lookup is bounded too.
    const write = resolveActor(actor)
      .then((who) => {
        const entry = JSON.stringify({ at, type, userId: who.id, name: who.name, ...(detail ? { detail } : {}) });
        return upstashPipeline([
          ["LPUSH", ACTIVITY_LOG_KEY, entry],
          ["LTRIM", ACTIVITY_LOG_KEY, 0, ACTIVITY_LOG_MAX - 1],
        ]);
      })
      .then(
        () => undefined,
        // The one place a lost log line surfaces at all. Deliberately not
        // rethrown — see rule 1 in the header.
        (err) => console.warn("[activity] log write failed", errorLabel(err)),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LOG_WRITE_TIMEOUT_MS);
    });
    try {
      await Promise.race([write, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Belt-and-braces for anything synchronous above (JSON.stringify can't
    // realistically throw here, but rule 1 is absolute).
    console.warn("[activity] log write failed", errorLabel(err));
  }
}

/**
 * Records a sign-in from better-auth's `hooks.after`, which fires on EVERY
 * auth endpoint — so this filters to the OAuth callback itself. A session
 * present on any other path (a `/get-session` cookie refresh, `/sign-out`)
 * is not a sign-in and must not be logged as one.
 *
 * Split out of the hook closure in auth.ts so the path filter and the
 * player extraction are directly testable without standing up a better-auth
 * middleware context.
 */
export async function recordCallbackLogin(path: string, newSession: unknown): Promise<void> {
  // Matches both the endpoint template ("/callback/:id") and a literal
  // request path ("/callback/github") — which of the two the hook sees is a
  // better-auth internal this deliberately doesn't depend on.
  if (!path.startsWith("/callback")) return;
  // Fail-open like the writer: this runs inside the sign-in hook.
  let actor: ActivityActor;
  try {
    const { displayNameOf, PLAYER_ID_RE } = await import("@/lib/player");
    const row = (newSession as { user?: Record<string, unknown> } | null)?.user;
    const id = row?.id;
    if (typeof id !== "string" || !PLAYER_ID_RE.test(id)) return;
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    actor = { id, name: displayNameOf({ id, username: text(row?.username), login: text(row?.login), name: text(row?.name) }) };
  } catch (err) {
    console.warn("[activity] sign-in entry skipped", errorLabel(err));
    return;
  }
  await logActivity("login", actor);
}

/**
 * One page of the log, newest first, plus the list's total length so the
 * admin tab can say how much more there is to load.
 *
 * No server-side filtering, deliberately: the whole list is at most
 * `ACTIVITY_LOG_MAX` short JSON rows, so the tab reads all of it while a
 * filter is on and filters client-side, instead of this read growing a
 * second, subtler pagination contract ("offset within the filtered view").
 * Malformed rows are skipped, not fatal — one corrupt entry must not blank
 * the whole tab.
 *
 * Unlike the writer this THROWS on Redis failure: a reader with no data has
 * nothing useful to degrade to, and the route maps the throw to a 503.
 */
export async function listActivity(offset: number, limit: number): Promise<{ entries: ActivityEntry[]; total: number }> {
  const [range, len] = await upstashPipeline([
    ["LRANGE", ACTIVITY_LOG_KEY, offset, offset + limit - 1],
    ["LLEN", ACTIVITY_LOG_KEY],
  ]);
  if (range.error || len.error) throw new Error(range.error ?? len.error);

  const rows = Array.isArray(range.result) ? (range.result as unknown[]) : [];
  const entries: ActivityEntry[] = [];
  for (const row of rows) {
    if (typeof row !== "string") continue;
    try {
      const parsed = JSON.parse(row) as Partial<ActivityEntry> & { login?: unknown };
      if (typeof parsed.at !== "string" || typeof parsed.type !== "string") continue;
      const userId = typeof parsed.userId === "string" && parsed.userId ? parsed.userId : null;
      const login = typeof parsed.login === "string" && parsed.login ? parsed.login : null;
      const fallback = userId ?? login;
      if (!fallback) continue;
      entries.push({
        at: parsed.at,
        type: parsed.type,
        userId,
        name: typeof parsed.name === "string" && parsed.name ? parsed.name : fallback,
        ...(typeof parsed.detail === "string" ? { detail: parsed.detail } : {}),
      });
    } catch {
      continue;
    }
  }
  return { entries, total: typeof len.result === "number" ? len.result : 0 };
}
