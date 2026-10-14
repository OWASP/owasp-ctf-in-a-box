// Small OWASP category badge. When the code maps to a known OWASP page it
// renders as a link (new tab) to that Top-10 / API-Top-10 category; otherwise
// it's plain text. THE single implementation, shared by the per-app challenge
// breakdown (progress/challenge-list.tsx) and the catalogue grid
// (challenge-grid.tsx) so the link, the label and the styling stay in one
// place — those two surfaces each carried their own copy until they drifted:
// one had the WCAG 2.5.8 pointer target, the other had a different title and
// a different type size.
//
// The badge resolves its own label and URL from the bare code via
// `owaspCategory`, so a caller only ever passes the code. Callers holding a
// resolved `OwaspCategory` pass `category.code`; nothing needs to pass the
// label, and nothing may pass a URL — a badge must never be able to point
// somewhere lib/owasp.ts didn't sanction.

import { owaspCategory } from "@/lib/owasp";

/**
 * The linked and unlinked badges MUST NOT look alike at rest.
 *
 * They used to: both rendered `text-muted` inside a `border-white/10` chip,
 * and every link affordance sat behind `hover:` / `focus-visible:`. A reader
 * could not tell an "A03" that opens owasp.org from an "API9" that is inert
 * without moving a pointer onto it — and a touch user could not find out at
 * all, since neither hover nor `title` reaches them.
 *
 * So the link carries TWO resting cues, colour and an underline, for the
 * reason globals.css already gives for `.ds-link`: WCAG 1.4.1 (Use of Color,
 * Level A) will not accept colour as the only means of conveying that
 * something is a link. Hover and focus then strengthen what is already
 * visible rather than introducing it.
 *
 * Neither cue changes the badge's box, which matters: these sit in rows that
 * run to ~110 challenges, and a chip that grew by even a pixel would re-flow
 * the truncating name beside it on every row.
 */
const BASE = "flex-none rounded border px-1 text-[11px]";
const PLAIN = `${BASE} border-white/10 text-muted`;
// ds-tap-24 grows the pointer target to the WCAG 2.5.8 24x24 minimum with a
// transparent pseudo-element, without growing the visual chip — see
// globals.css. The chip renders ~23x15, so the link needs it; the inert span
// is not a pointer target and does not.
const LINK =
  `${BASE} ds-tap-24 border-[#2563eb]/40 text-[var(--accent-blue-link)] underline ` +
  "decoration-[color-mix(in_srgb,var(--accent-blue-link)_40%,transparent)] underline-offset-2 " +
  "transition-colors hover:border-[#2563eb]/70 hover:decoration-[var(--accent-blue-link)] " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";

export default function OwaspBadge({ code, className = "" }: { code: string; className?: string }) {
  const category = owaspCategory(code);
  if (!category) return null;

  // An unrecognised code is labelled with itself (see `owaspCategory`), and a
  // title that only repeats the visible text is noise to a screen reader.
  const named = category.label !== category.code;

  if (!category.url) {
    return (
      <span className={`${PLAIN} ${className}`} title={named ? category.label : undefined}>
        {category.code}
      </span>
    );
  }

  return (
    <a
      href={category.url}
      target="_blank"
      rel="noreferrer noopener"
      title={`${named ? category.label : `OWASP ${category.code}`} — opens owasp.org`}
      // The badge sits inside rows whose ancestors handle clicks; following
      // the link must not also toggle the row it lives in.
      onClick={(e) => e.stopPropagation()}
      className={`${LINK} ${className}`}
    >
      {category.code}
    </a>
  );
}
