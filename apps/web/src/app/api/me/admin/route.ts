import { NextResponse } from "next/server";
import { getPlayer } from "@/lib/player";
import { isAdminLogin } from "@/lib/admin-auth";

/**
 * "Is the CURRENT session an admin?" — one boolean, for menu visibility.
 *
 * The header's admin link is rendered by a Client Component, which can read
 * neither Redis nor `ADMIN_LOGINS` (server-only, config v2) — so this route
 * is the only way it learns admin status at all, for env admins and runtime
 * grants alike (issue #147).
 *
 * This route discloses NOTHING but the caller's own status: no list, no other
 * logins, and it is not gated on being an admin — a non-admin gets `false`,
 * which they could infer anyway from the panel 403ing. That is why it lives
 * under /api/me rather than /api/admin: `requireAdmin` on it would make it
 * useless for the one question it answers.
 *
 * Signed out is `false`, not 401: the nav asks this on every signed-in mount
 * and an error status there would be noise, not information.
 */
export async function GET(request: Request) {
  try {
    const player = await getPlayer(request.headers);
    return NextResponse.json({ admin: await isAdminLogin(player?.githubLogin ?? undefined) });
  } catch {
    // Fail closed, quietly. A datastore blip hides a menu item; it must never
    // reveal one, and it must not surface as an error toast on every page.
    return NextResponse.json({ admin: false });
  }
}
