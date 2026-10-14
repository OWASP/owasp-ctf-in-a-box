import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getViewerHints, resolveHintConfig } from "@/lib/hint-store";
import { listChallenges } from "@/lib/classic-store";
import { visibleNow } from "@/lib/classic-release";
import { errorLabel } from "@/lib/error-label";

/** The viewer's bought Jeopardy hint texts, minus any for a challenge that is
 *  hidden now: on the contestant side it does not exist, for its buyers too.
 *  The spend is untouched. Fails CLOSED: when the challenges cannot be read,
 *  no Jeopardy text is returned rather than one that might be hidden. */
async function visibleClassicHints(texts: Record<string, string>): Promise<Record<string, string>> {
  if (Object.keys(texts).length === 0) return texts;
  try {
    const visible = new Set(visibleNow(await listChallenges()).map((c) => c.id));
    return Object.fromEntries(Object.entries(texts).filter(([id]) => visible.has(id)));
  } catch (err) {
    console.error("hints: challenge read failed, withholding Jeopardy hint text:", errorLabel(err));
    return {};
  }
}

/** The signed-in viewer's full hint state (all apps) — lets the challenges
 *  page pre-reveal everything already bought with a single fetch. */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const login = (session.user as { login?: string }).login;
  if (!login) return NextResponse.json({ error: "session has no GitHub login" }, { status: 400 });

  const hints = await getViewerHints(login);
  const { enabled, cost } = await resolveHintConfig();
  return NextResponse.json({
    enabled,
    cost,
    purchased: hints.purchased,
    classic: await visibleClassicHints(hints.classic),
    ai: hints.ai,
    spent: hints.spent,
    count: hints.count,
  });
}
