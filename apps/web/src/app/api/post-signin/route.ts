// The landing step every GitHub sign-in routes through (issue #217). Sign-in
// buttons pass their real destination as ?next=, and this decides whether the
// visitor sees it directly or meets the team step first — see
// lib/post-signin.ts for the decision logic and its exemptions.
//
// A GET that only ever 302s: it writes nothing, so a prefetch or a link
// preview hitting it can at worst follow a redirect.
import { getPlayer } from "@/lib/player";
import { isAdminLogin } from "@/lib/admin-auth";
import { hasTeam } from "@/lib/team-store";
import { resolvePostSigninTarget, sanitizeNext } from "@/lib/post-signin";

// Redirect with a RELATIVE Location, never `new URL(path, request.url)`.
// Behind a proxy (Fly, and any reverse proxy that forwards to the app on an
// internal address) `request.url` is the container-local origin — on Fly it
// is literally `https://localhost:3000/…` — so building an absolute Location
// from it sent every post-sign-in hop to localhost (issue: sign-in landed on
// localhost in production). A relative Location is resolved by the browser
// against the address-bar URL it actually navigated to, i.e. the public host,
// so it lands on the real origin without the app needing to know its own URL.
// `target` is always a sanitized same-origin path (leading single slash), so
// a bare-path Location is safe.
function redirect(target: string): Response {
  return new Response(null, { status: 302, headers: { Location: target } });
}

export async function GET(request: Request) {
  const next = sanitizeNext(new URL(request.url).searchParams.get("next"));

  const player = await getPlayer(request.headers);
  // No session on a post-signin hop means the sign-in didn't complete —
  // land home, where the CTA offers it again.
  if (!player) return redirect("/");

  // hasTeam fails OPEN on a store error (team-store.ts), so a Redis blip
  // sends people to their destination rather than herding everyone to the
  // team card; isAdminLogin returns false on error, which only means an
  // organizer sees the team card once — annoying, not wrong.
  const [isAdmin, teamed] = await Promise.all([isAdminLogin(player.githubLogin ?? undefined), hasTeam(player.id)]);
  const target = resolvePostSigninTarget({ next, isAdmin, teamless: !teamed });
  return redirect(target);
}
