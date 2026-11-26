import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { errorLabel } from "@/lib/error-label";
import { listHeldScores } from "@/lib/sd-held";

/**
 * Secure Development scores held for authors with no linked account, and the
 * ones no link can still release. ADMIN-ONLY and read-only: it names PR
 * authors, and nothing here writes (no other verb is exported). `?login=`
 * narrows it to one GitHub login (case-insensitive, an optional leading @),
 * which Support's search uses.
 */
export const dynamic = "force-dynamic";

/** GitHub's login shape: letters, digits and single hyphens, at most 39. */
const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const raw = new URL(request.url).searchParams.get("login");
  const login = raw === null ? null : raw.trim().replace(/^@/, "").toLowerCase();
  if (login !== null && !LOGIN_RE.test(login)) {
    return NextResponse.json({ error: "login is not a GitHub login" }, { status: 400 });
  }

  try {
    const entries = await listHeldScores();
    return NextResponse.json({ entries: login === null ? entries : entries.filter((e) => e.login === login) });
  } catch (err) {
    console.error("[admin/sd/held] read failed", errorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
