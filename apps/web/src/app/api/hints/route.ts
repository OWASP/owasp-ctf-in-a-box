import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getViewerHints, resolveHintConfig } from "@/lib/hint-store";

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
    classic: hints.classic,
    classicLevels: hints.classicLevels,
    ai: hints.ai,
    spent: hints.spent,
    count: hints.count,
  });
}
