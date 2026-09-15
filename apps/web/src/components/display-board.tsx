"use client";

// Display mode — the projector surface (DESIGN.md: "legible from the back of
// a room"). Reached from the leaderboard's Display button (?display=1): no
// nav, no search, no chrome — the top ten as a wall of type, plus the phase
// answer projected where the whole room reads it.
//
// Refreshes itself with router.refresh() every 30 seconds: the board is a
// Server Component's data, so a refresh re-reads the standings without a full
// reload — the cadence poll-mode scores land at anyway. The interval is
// cleared on unmount and skipped entirely under reduced data? No — refresh is
// data, not motion; reduced-motion governs animation and this is neither.

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SponsorLogoSize } from "@/lib/sponsors-keys";

export type DisplayRow = {
  key: string;
  rank: number;
  name: string;
  points: number;
  /** Items completed — the breadth figure the individual board ranks by.
   *  Absent on team rows: a team's breadth isn't computed here. */
  solved?: number;
};

/** A sponsor's projector-surface credit: just enough to render a logo (or a
 *  name, when there is none) — no url, since this is a display nobody
 *  clicks. `logoSrc` points at the public logo route (issue #405); `w`/`h`
 *  are the stored intrinsic dimensions, so the row lays out without a
 *  layout shift while a logo loads. */
export type DisplaySponsor = {
  key: string;
  name: string;
  logoSrc: string | null;
  w?: number;
  h?: number;
  /** JPEG carries no alpha channel — the `brightness-0 invert` treatment
   *  below assumes a transparent PNG/WebP and turns an opaque JPEG's own
   *  background into an equally opaque white rectangle, erasing the logo
   *  inside it. Skip the filter for that one format rather than silently
   *  breaking it; see the render site below. */
  logoType?: "image/png" | "image/webp" | "image/jpeg";
};

// Same podium vocabulary as the leaderboard rank chips — rank 3 is the
// palette teal, not a literal bronze, so the wall display and the board a
// contestant checks on their phone agree on what third place looks like.
const PODIUM: Record<number, string> = { 1: "#d4a017", 2: "#a1a1aa", 3: "#14b8a6" };

/** Projector-scale sizing for the sponsor credit row, keyed by the SAME
 *  organizer setting the landing strip reads (`sponsorLogoSize`) — one knob,
 *  so a logo an organizer sized up in /admin is sized up on the wall too.
 *  The values are not the strip's: this surface is metres from its audience,
 *  and the old fixed 2.2vh (~24px on a 1080p projector) read as a fleck.
 *  `/sponsors` is deliberately still untouched by the setting — it is a page
 *  you read at arm's length with its own layout. */
const LOGO_SIZE_CLASSES: Record<SponsorLogoSize, string> = {
  sm: "h-[4vh]",
  md: "h-[5.5vh]",
  lg: "h-[7vh]",
};

/** The name-only fallback (a sponsor with no logo) tracks the same setting,
 *  so a credit row mixing logos and names stays visually level. */
const LOGO_FALLBACK_TEXT_CLASSES: Record<SponsorLogoSize, string> = {
  sm: "text-[1.4vh]",
  md: "text-[1.8vh]",
  lg: "text-[2.2vh]",
};

export default function DisplayBoard({
  rows,
  eventName,
  phaseLabel,
  sponsors = [],
  logoSize,
}: {
  rows: DisplayRow[];
  eventName: string;
  phaseLabel: string | null;
  /** Empty on a box with no sponsors configured — the credit row renders
   *  nothing at all in that case, same "render iff non-empty" rule the other
   *  three sponsor surfaces follow. */
  sponsors?: DisplaySponsor[];
  /** The organizer's `sponsorLogoSize`. Absent (an older caller, or a box
   *  with nothing stored) means the medium preset, matching the strip's own
   *  fallback direction. */
  logoSize?: SponsorLogoSize;
}) {
  const router = useRouter();
  const logoClasses = LOGO_SIZE_CLASSES[logoSize ?? "md"];
  const fallbackTextClasses = LOGO_FALLBACK_TEXT_CLASSES[logoSize ?? "md"];
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(id);
  }, [router]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#1a1a2e] px-[4vw] py-[3vh]">
      <div className="flex items-baseline justify-between gap-6">
        <div className="flex min-w-0 items-baseline gap-[1.5vw]">
          <h1 className="truncate font-display text-[3.5vh] font-black tracking-tight text-white">
            {eventName}
          </h1>
        </div>
        <div className="flex items-baseline gap-6">
          {phaseLabel && (
            <span className="font-mono text-[2vh] uppercase tracking-widest text-[#8f8f9b]">
              {phaseLabel}
            </span>
          )}
          <Link href="/leaderboard" className="ds-link font-mono text-[1.6vh]">
            exit
          </Link>
        </div>
      </div>

      <ol className="mt-[3vh] flex flex-1 flex-col justify-evenly">
        {rows.map((row) => (
          <li key={row.key} className="flex items-baseline gap-[2vw]">
            <span
              className="w-[6vw] flex-none text-right font-display text-[4.2vh] font-black tabular-nums"
              style={{ color: PODIUM[row.rank] ?? "#8f8f9b" }}
            >
              {row.rank}
            </span>
            <span className="min-w-0 flex-1 truncate font-display text-[4.2vh] font-bold text-white">
              {row.name}
            </span>
            {row.solved !== undefined && (
              <span className="flex-none font-mono text-[2vh] tabular-nums text-[#22c55e]">
                {row.solved} solved
              </span>
            )}
            <span className="w-[14vw] flex-none text-right font-mono text-[4.2vh] font-bold tabular-nums text-white">
              {row.points.toLocaleString("en-US")}
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-[2vh] flex items-center justify-between gap-[2vw]">
        {sponsors.length > 0 ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-[1.5vw] opacity-70">
            {sponsors.map((sponsor) =>
              sponsor.logoSrc ? (
                // Native <img>, not next/image: this is a logo credit row on
                // a self-contained overlay, not a page asset worth Next's
                // optimizer — the same call sponsor-strip.tsx makes.
                <img
                  key={sponsor.key}
                  src={sponsor.logoSrc}
                  alt={`${sponsor.name} logo`}
                  width={sponsor.w}
                  height={sponsor.h}
                  className={
                    sponsor.logoType === "image/jpeg"
                      ? `${logoClasses} w-auto object-contain`
                      : `${logoClasses} w-auto object-contain brightness-0 invert`
                  }
                />
              ) : (
                <span key={sponsor.key} className={`font-mono ${fallbackTextClasses} text-[#8f8f9b]`}>
                  {sponsor.name}
                </span>
              ),
            )}
          </div>
        ) : (
          <span />
        )}
        {/* Not `text-[#8f8f9b]/60` — that composites to 2.86:1 (issue #316),
            and this is a projector surface read from across a room. */}
        <p className="flex-none text-right font-mono text-[1.4vh] text-muted">refreshes every 30s</p>
      </div>
    </div>
  );
}
