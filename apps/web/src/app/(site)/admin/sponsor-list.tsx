"use client";

// The sponsor list an organizer actually works in: one card per sponsor, with
// the logo shown as contestants will see it.
//
// It replaced a text-only `<ul>` sitting under a permanently open form. Two
// things were wrong with that. A sponsor's logo is the whole point of the
// record and the old list never showed it, so "did that upload work, and does
// it read on a dark background?" could only be answered by leaving the tab.
// And ordering was a raw `order` number box inside the form, which meant
// editing a sponsor to move it — while a `reorder` endpoint capable of doing
// it in one click had been there since the feature shipped, unused.
//
// Pure presentation: every action is a callback the tab owns. That is what
// makes this testable without a DOM — the tab's fetch/effect layer never runs
// under `renderToStaticMarkup`, but this does.

import type { SponsorTier } from "@/lib/sponsors-keys";

export type SponsorRecord = {
  id: string;
  name: string;
  url: string;
  blurb: string;
  tier: SponsorTier;
  order: number;
  logo: { type: string; w: number; h: number } | null;
};

const TIER_CHIP: Record<SponsorTier, string> = {
  gold: "border-[#d4a017]/40 text-[#d4a017]",
  silver: "border-[#a1a1aa]/40 text-[#a1a1aa]",
  community: "border-white/15 text-zinc-400",
};

/** The sponsor's link, minus the scheme and any trailing slash — an organizer
 *  scanning the list wants to recognise the destination, not read a URL. Falls
 *  back to the raw string if it will not parse: showing something the record
 *  actually holds beats showing nothing. */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

function LogoThumb({ sponsor }: { sponsor: SponsorRecord }) {
  // Painted on the site's own dark panel colour rather than a neutral swatch:
  // the question this thumbnail answers is "does this logo read where it will
  // actually appear", and a logo with no transparency (every JPEG, and plenty
  // of PNGs) shows its own background here exactly as it will on the landing
  // page. No `brightness-0 invert` — that is the projector board's treatment
  // and would hide precisely the problem an organizer needs to see.
  if (!sponsor.logo) {
    return (
      <div className="flex h-12 w-24 flex-none items-center justify-center rounded border border-dashed border-white/15 bg-[#12121e] text-[10px] uppercase tracking-wider text-[#d4a017]">
        no logo
      </div>
    );
  }
  return (
    <div className="flex h-12 w-24 flex-none items-center justify-center overflow-hidden rounded border border-white/10 bg-[#1a1a2e] p-1">
      {/* Native <img>, like every other sponsor surface: the bytes come from
          this box's own logo route, already capped at 64KB, so there is
          nothing for Next's optimizer to do. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/sponsors/logo/${sponsor.id}`}
        alt={`${sponsor.name} logo`}
        width={sponsor.logo.w}
        height={sponsor.logo.h}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}

export function SponsorRow({
  sponsor,
  isFirst,
  isLast,
  pending,
  onMove,
  onEdit,
  onDelete,
}: {
  sponsor: SponsorRecord;
  isFirst: boolean;
  isLast: boolean;
  pending: boolean;
  onMove: (id: string, delta: -1 | 1) => void;
  onEdit: (sponsor: SponsorRecord) => void;
  onDelete: (sponsor: SponsorRecord) => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-md border border-white/10 bg-[#12121e] p-3">
      {/* Up/Down rather than drag: this list is a handful of rows an organizer
          sets up once, and a keyboard-reachable button pair needs none of the
          drag affordances (or the pointer precision) a sortable list does. */}
      <div className="flex flex-none flex-col gap-1">
        <button
          type="button"
          disabled={pending || isFirst}
          onClick={() => onMove(sponsor.id, -1)}
          aria-label={`Move ${sponsor.name} up`}
          className="rounded border border-white/10 px-1.5 text-xs leading-5 text-zinc-400 hover:text-white disabled:opacity-30"
        >
          ↑
        </button>
        <button
          type="button"
          disabled={pending || isLast}
          onClick={() => onMove(sponsor.id, 1)}
          aria-label={`Move ${sponsor.name} down`}
          className="rounded border border-white/10 px-1.5 text-xs leading-5 text-zinc-400 hover:text-white disabled:opacity-30"
        >
          ↓
        </button>
      </div>

      <LogoThumb sponsor={sponsor} />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-sm text-zinc-200">{sponsor.name}</span>
          <span
            className={`flex-none rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${TIER_CHIP[sponsor.tier]}`}
          >
            {sponsor.tier}
          </span>
        </span>
        <span className="truncate text-xs text-muted">{linkLabel(sponsor.url)}</span>
        {sponsor.blurb && <span className="truncate text-xs text-muted">{sponsor.blurb}</span>}
      </div>

      <span className="flex flex-none gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => onEdit(sponsor)}
          className="rounded-md border border-white/10 px-2 py-1 font-mono text-xs text-zinc-400 hover:text-white disabled:opacity-40"
        >
          Edit
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onDelete(sponsor)}
          className="rounded-md border border-white/10 px-2 py-1 font-mono text-xs text-zinc-400 transition-colors hover:border-[#e53e3e]/50 hover:text-[#e53e3e] disabled:opacity-40"
        >
          Delete
        </button>
      </span>
    </li>
  );
}

export default function SponsorList({
  rows,
  loading,
  pending,
  onMove,
  onEdit,
  onDelete,
}: {
  /** Already in display order — the store sorts, and a reorder re-sorts. */
  rows: SponsorRecord[];
  /** The first fetch has not answered yet: "none configured" and "not loaded"
   *  are different states and must not share a message. */
  loading: boolean;
  pending: boolean;
  onMove: (id: string, delta: -1 | 1) => void;
  onEdit: (sponsor: SponsorRecord) => void;
  onDelete: (sponsor: SponsorRecord) => void;
}) {
  if (loading) return <p className="mt-4 text-sm text-muted">Loading…</p>;
  if (rows.length === 0) {
    return <p className="mt-4 text-sm text-muted">No sponsors yet — this event ships zero sponsor pixels.</p>;
  }
  return (
    <ul className="mt-4 flex flex-col gap-2">
      {rows.map((row, i) => (
        <SponsorRow
          key={row.id}
          sponsor={row}
          isFirst={i === 0}
          isLast={i === rows.length - 1}
          pending={pending}
          onMove={onMove}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}
