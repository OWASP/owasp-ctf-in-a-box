import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { launchApiAccess } from "@/lib/launch";
import { revealHint } from "@/lib/hint-store";
import { adminSeesHidden } from "@/lib/classic-visibility";
import { consumeRateLimit, RATE_LIMITS } from "@/lib/rate-limit-store";

/** Buys (or re-views) one hint. Charging is atomic and idempotent in Redis —
 *  repeat calls for an owned hint return it for free. Purchases are final;
 *  there is no refund route.
 *
 * Also behind the pre-launch lock (`requireLaunchedApi`, #464, checked after
 * authentication and before `revealHint` is ever called): unlike the other
 * locked routes, this one doesn't just bank points early — it returns hint
 * TEXT, so an unlocked call would leak challenge content before the event
 * launches, not just score early. */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const login = (session.user as { login?: string }).login;
  if (!login) return NextResponse.json({ error: "session has no GitHub login" }, { status: 400 });

  // #464 pre-launch lock. Its own refusal — 403 `not-launched` — never a
  // wrong-answer shape. An admin before launch passes as a PREVIEW: they see
  // the hint text and are charged nothing (the same script, writing nothing).
  const { refused, preview } = await launchApiAccess(login);
  if (refused) return refused;

  // After the lock, before any store write — a refusal here can never follow
  // a charge that already happened.
  const limit = await consumeRateLimit(
    RATE_LIMITS.hintReveal.bucket,
    login,
    RATE_LIMITS.hintReveal.limit,
    RATE_LIMITS.hintReveal.windowSeconds,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many hint requests. Slow down." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => ({}));
  // The price on the contestant's confirm button (#557). Absent, the reveal
  // charges the current price, as an older page did; present, it must be a
  // whole, non-negative number of points, and the script charges exactly
  // that or nothing.
  const hasQuote = body !== null && typeof body === "object" && "quotedCost" in body;
  const quotedCost: unknown = hasQuote ? body.quotedCost : undefined;
  if (hasQuote && !(typeof quotedCost === "number" && Number.isInteger(quotedCost) && quotedCost >= 0)) {
    return NextResponse.json({ error: "Invalid quoted cost" }, { status: 400 });
  }
  const app = typeof body.app === "string" ? body.app : "";
  const id = typeof body.id === "string" ? body.id : "";
  // An admin on a Jeopardy challenge contestants cannot see reads its hint
  // as a dry run, like a preview: shown, never charged.
  const dryRun = preview || (app === "classic" && id !== "" && (await adminSeesHidden(login, id)));
  const result = await revealHint(login, app, id, typeof quotedCost === "number" ? { dryRun, quotedCost } : { dryRun });
  if (!result.ok && "repriced" in result) {
    // 409: the confirmed price is stale. Only the new price goes back, so
    // the control can ask again; nothing was charged.
    return NextResponse.json({ error: result.error, cost: result.cost }, { status: 409 });
  }
  if (!result.ok) {
    const status = result.missing ? 404 : result.forbidden ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({
    hint: result.hint,
    alreadyOwned: result.alreadyOwned,
    spent: result.spent,
    // The price THIS reveal charged (from `revealHint`), not a second
    // `resolveHintConfig()` read an organizer could have changed between the
    // charge and now — so the acknowledgement shows what was actually deducted.
    cost: result.cost,
    // The contestant's net score after this reveal (#553), when the store
    // read one — so the page can say what is left next to the deduction. A
    // lower bound: a solve landing during the purchase is not in it yet.
    ...(result.balance !== undefined ? { balance: result.balance } : {}),
    // An admin preview (#464): the text is shown, nothing was charged.
    ...(result.dryRun ? { dryRun: true } : {}),
  });
}
