// The pre-launch lock (issue #464, ADR 59): until the event is launched — a
// scoring start that has passed — every contestant module page redirects to
// the landing page and every module API answers 403 `not-launched`. Admins
// get through as a preview so they can configure and check the event.
//
// Checked in each page and route, never in the proxy: proxy.ts deliberately
// makes no Redis reads (see its header). A page-level check also runs on every
// request, including a soft navigation, which a layout would not.
//
// Fail direction: CLOSED. This is a secrecy boundary (challenge text before
// launch), so a settings read that throws counts as "not launched" for a
// non-admin. That costs nothing live — a Redis outage breaks the challenge
// pages anyway. The scoring FREEZE read is a different decision and still
// fails open (a blip must not drop live submissions).

import "server-only";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { isAdminLogin } from "@/lib/admin-auth";
import { getAdminSettings } from "@/lib/admin-store";
import { isLaunched } from "@/lib/schedule-window";

export type LaunchAccess = { allowed: boolean; preview: boolean };

/** Fixed diagnostic plus the error's name/message only — never the error
 *  object, whose own fields can carry request data (#244). */
function logFailure(what: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`launch lock: ${what} failed (failing closed):`, e.name, e.message);
}

async function viewerIsAdmin(login: string | undefined): Promise<boolean> {
  try {
    return await isAdminLogin(login);
  } catch (err) {
    logFailure("admin check", err);
    return false;
  }
}

/** Who may see module content right now. `preview` marks an admin who is
 *  only through because they are an admin (the event is not launched). */
export async function getLaunchAccess(login: string | undefined, nowMs: number = Date.now()): Promise<LaunchAccess> {
  let launched = false;
  try {
    const s = await getAdminSettings();
    launched = isLaunched(nowMs, s.scoringStartsAt);
  } catch (err) {
    logFailure("settings read", err);
  }
  if (launched) return { allowed: true, preview: false };
  if (await viewerIsAdmin(login)) return { allowed: true, preview: true };
  return { allowed: false, preview: false };
}

/** Page guard: call BEFORE loading any module content. Redirects a refused
 *  viewer to the landing page; returns the access otherwise. */
export async function redirectIfNotLaunched(login: string | undefined): Promise<LaunchAccess> {
  const access = await getLaunchAccess(login);
  if (!access.allowed) redirect("/");
  return access;
}

/** API guard: `null` when allowed, else the 403 `not-launched` response —
 *  its own error, never a wrong-answer shape. */
export async function requireLaunchedApi(login: string | undefined): Promise<NextResponse | null> {
  const access = await getLaunchAccess(login);
  if (access.allowed) return null;
  return NextResponse.json({ error: "not-launched" }, { status: 403 });
}
