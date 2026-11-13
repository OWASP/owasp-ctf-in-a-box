"use client";

// GitHub sign-in control rendered inside <SiteHeader>. Reads the session
// reactively via authClient.useSession() — there's a brief signed-out flash
// on first paint (deliberate: fetching the session in the root layout would
// force every static marketing page to become dynamic).

import Image from "next/image";
import { displayNameOf } from "@/lib/display-name";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { oauthErrorCallbackURL, postSigninCallbackURL } from "@/lib/post-signin";
import MenuChevron from "@/components/menu-chevron";

// Admin menu VISIBILITY only. The real gate is server-side in
// requireAdmin(), so showing the item to a non-admin — or hiding it from an
// admin — never grants or denies access, it only affects the menu.
//
// Config v2: `ADMIN_LOGINS` is server-only (it must never reach the client
// bundle, unlike the old baked `event.yaml` list — see bootstrap-env.ts), so
// there is no instant client-side check any more. Every viewer, env admin or
// not, waits on the round-trip below: `/api/me/admin` answers through
// `isAdminLogin`, which covers both env admins and runtime grants.

// The pages that only make sense WITH a session. Signing out anywhere else
// stays put (a refresh re-renders the same public page signed out), but
// signing out here used to refresh in place too — landing the person on
// /admin's "Forbidden" wall or /profile's sign-in prompt, which reads as an
// error when all they did was sign out.
const SESSION_ONLY_PREFIXES = ["/admin", "/profile"] as const;

/** Where to send someone after sign-out: home from a session-gated page,
 *  `null` (= refresh in place) from a public one. Prefix matching is
 *  segment-aware so a hypothetical public /profiles never false-positives.
 *  Exported for direct testing — the click handler is client state a static
 *  render cannot drive. */
export function signOutDestination(pathname: string): string | null {
  const gated = SESSION_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return gated ? "/" : null;
}

/** Whether the Admin menu item should render, given the signed-in user id and
 *  the round-trip's answer for it (`null` = not asked yet, or the menu has
 *  not opened). `false` until `granted` names THIS user — a stale answer
 *  for a previous account (see the `granted` state's comment) never shows
 *  the link for a new one. Exported for direct testing — same reason as
 *  `signOutDestination` (this repo has no @testing-library/jsdom-act setup
 *  to observe a live re-render, so the state transition is proven here as a
 *  pure function instead). */
export function showAdminLink(
  userId: string | undefined,
  granted: { userId: string; admin: boolean } | null,
): boolean {
  return typeof userId === "string" && granted !== null && granted.userId === userId && granted.admin;
}

export default function AuthNav() {
  const { data: session, isPending } = authClient.useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Trigger + menu live inside this container, so a pointerdown anywhere
  // outside it closes the menu — the same click-outside contract nav-dropdown
  // uses. This REPLACES an earlier onBlur+setTimeout close (issue #222): that
  // raced the menu-link click, unmounting the <Link> before the click landed
  // in browsers that order blur/click differently (Brave), so the links did
  // nothing. A pointerdown-outside listener never fires for a click INSIDE the
  // menu, so a link navigates cleanly.
  const menuRef = useRef<HTMLDivElement>(null);
  // Hydration guard. The server always renders the pending placeholder, but
  // useSession() is backed by a client store whose fetch can RESOLVE before
  // React hydrates (big pages, slow mains) — the first client render then
  // shows the signed-in menu against the server's placeholder and React
  // throws #418 on every affected full load. Gating on mounted pins the
  // first client render to the placeholder no matter how fast the session
  // arrives; the deliberate signed-out flash (see header comment) already
  // covers the UX of that extra frame.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Deferred so this reads as subscribing to mount rather than a render-time
    // computation — satisfies react-hooks/set-state-in-effect.
    const timeout = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(timeout);
  }, []);
  // Keyed by user id so switching accounts cannot carry the previous viewer's
  // answer over. `null` = not asked yet.
  const [granted, setGranted] = useState<{ userId: string; admin: boolean } | null>(null);

  // Close on a pointerdown outside the menu, and on Escape. Only wired while
  // the menu is open, so a closed menu subscribes to nothing.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const userId = session?.user.id;

  // Asked WHEN THE MENU OPENS, not on mount, and only once per account — there
  // is no instant answer any more (config v2: no client-side allowlist), so
  // nobody sees the Admin item until this resolves. `/api/me/admin` returns
  // one boolean about the caller and nothing else; see that route for why it
  // is not admin-gated.
  //
  // In a handler rather than an effect deliberately: this is a response to a
  // user action, not synchronisation with an external system.
  async function ensureAdminChecked() {
    if (!userId || granted?.userId === userId) return;
    try {
      const res = await fetch("/api/me/admin");
      const data = (res.ok ? await res.json().catch(() => ({})) : {}) as { admin?: boolean };
      setGranted({ userId, admin: data.admin === true });
    } catch {
      // Menu visibility only: a failed check hides the link, which is the safe
      // direction and costs a runtime admin one extra navigation.
      setGranted({ userId, admin: false });
    }
  }

  // Show the loading placeholder only before we have ANY session answer, not
  // on every revalidation. `useSession()` flips `isPending` true each time its
  // store refetches in the background, but keeps the last `session` data — so
  // gating on `isPending` alone swapped the real avatar/menu for this
  // non-interactive placeholder mid-session, and a click landing on that frame
  // did nothing (the menu felt like it needed a second click). `!session`
  // scopes the placeholder to the genuine no-data window: the first load
  // (session still undefined) and a real sign-out. A background refetch keeps
  // the cached session, so the menu stays put and clickable.
  if (!mounted || (isPending && !session)) {
    return <div className="h-8 w-8 flex-none animate-pulse rounded-full bg-white/[0.06]" aria-hidden="true" />;
  }

  if (!session) {
    return (
      <button
        type="button"
        onClick={() =>
          // Through the post-signin step (issue #217): a teamless contestant
          // meets the team card first; a teamed one lands on /profile as before.
          // errorCallbackURL points a failed callback at the landing page's
          // own error banner rather than better-auth's default `/error`,
          // which this app has no page for (issue #380), carrying /profile
          // through as `?next=` so the retry offers the same destination.
          authClient.signIn.social({
            provider: "github",
            callbackURL: postSigninCallbackURL("/profile"),
            errorCallbackURL: oauthErrorCallbackURL("/profile"),
          })
        }
        className="flex-none rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-xs text-zinc-300 transition-colors hover:border-[#2563eb]/50 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
      >
        <span className="text-[#22c55e]">$</span> sign-in --github
      </button>
    );
  }

  // The kit's display rule (username, then GitHub login, then profile name),
  // the same one every board row uses.
  const displayName = displayNameOf(session.user);
  const showAdmin = showAdminLink(userId, granted);

  return (
    <div ref={menuRef} className="relative flex-none">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          void ensureAdminChecked();
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
      >
        {session.user.image ? (
          <Image
            src={session.user.image}
            alt=""
            width={26}
            height={26}
            className="rounded-full border border-white/10"
            unoptimized
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-[26px] w-[26px] items-center justify-center rounded-full border border-white/10 bg-white/[0.06] font-mono text-[11px] uppercase text-zinc-300"
          >
            {displayName.slice(0, 1)}
          </span>
        )}
        <span className="hidden font-mono text-xs text-zinc-300 sm:inline">{displayName}</span>
        {/* Below `sm:` the name is hidden and this is the whole trigger, so the
            chevron is what keeps a bare avatar reading as a menu rather than as
            an ornament — it matters more at that width, not less (#411). */}
        <MenuChevron open={open} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-40 overflow-hidden rounded-md border border-white/10 bg-[#16162a] py-1 shadow-xl"
        >
          <Link
            href="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.06] hover:text-white"
          >
            Profile
          </Link>
          {showAdmin && (
            <Link
              href="/admin"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.06] hover:text-white"
            >
              Admin
            </Link>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              await authClient.signOut();
              // Session-gated pages redirect home instead of refreshing in
              // place — see signOutDestination. router.refresh() runs in both
              // branches so the router's server-component cache drops the
              // signed-in render either way.
              const destination = signOutDestination(pathname);
              if (destination) router.push(destination);
              router.refresh();
            }}
            className="block w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-white/[0.06] hover:text-white"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
