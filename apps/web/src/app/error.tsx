"use client";

// The app's error boundary. Sits at the root segment, so it catches anything
// thrown by a page, by a nested `(site)` layout (the phase line's settings
// read), or by the landing page — everything except the root layout itself,
// which `global-error.tsx` covers.
//
// Why this is worth a file: the app had no error boundary at all, so ANY
// uncaught render error replaced the whole page with Next's unstyled default
// error screen — no header, no route out, and no way to retry short of the
// browser's reload button. An event is exactly the wrong moment to hand a
// contestant a dead end. This keeps the site's chrome, says plainly that the
// fault is ours and not theirs, and offers the retry first.
//
// Note what this is NOT for: a Redis outage does not land here. The store
// reads fail OPEN by design (see AGENTS.md on the pause/schedule contract),
// and a leaderboard with the store stopped still renders — verified by
// stopping `redis`/`srh` under the dev stack and getting a 200 with the page
// intact. So this boundary catches genuine render faults, not the outage that
// is already handled a layer down.
//
// The prop is `retry`, NOT the `reset` older App Router code uses: this app
// vendors Next 16.3, where `retry` became stable and re-fetches the segment's
// data. `reset` still exists but only clears the boundary and re-renders the
// same failed children, which for a data-read failure just fails again.

import Link from "next/link";
import { useEffect } from "react";

export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // The server-side message is withheld from the client in production —
    // only `digest` crosses over. Logging it is what lets an organizer match
    // what the contestant saw to the line in the container's logs, so the
    // digest is printed even though it means nothing on its own.
    console.error("Route error", error.digest ?? "(no digest)", error);
  }, [error]);

  return (
    <main id="main-content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-12 sm:px-6 sm:py-16">
      <div className="flex max-w-2xl flex-col gap-6">
        <p className="text-xs font-medium uppercase tracking-[0.25em] text-[#e53e3e]">
          Error
        </p>
        <h1 className="text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
          That didn&apos;t load
        </h1>
        <p className="text-base leading-relaxed text-zinc-400">
          Something on our side failed while building this page. Nothing you did
          caused it, and nothing you have scored is affected — scores live in
          the store, not in this page.
        </p>

        {/* The terminal flourish the 404 uses, carrying the one piece of
            information an organizer can act on. */}
        <div className="overflow-x-auto rounded-lg border border-white/[0.06] bg-[#12121e] px-6 py-3.5 font-mono text-sm text-muted">
          <span className="text-[#e53e3e]">$</span> ctf render{" "}
          <span className="text-zinc-400">--digest</span>{" "}
          <span>{error.digest ?? "unavailable"}</span>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => retry()}
            className="rounded-md bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1d4ed8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-md border border-white/[0.12] px-4 py-2 text-sm font-semibold text-zinc-300 transition-colors hover:border-white/[0.24] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
          >
            Back to start
          </Link>
        </div>

        <p className="text-sm leading-relaxed text-zinc-400">
          Still failing after a retry? Tell an organizer, and quote the digest
          above — it matches this failure to the server log.
        </p>
      </div>
    </main>
  );
}
