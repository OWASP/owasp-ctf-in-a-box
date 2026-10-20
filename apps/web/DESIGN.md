# Design plan — the original identity, enhanced

This branch first shipped a full "review queue" retheme (monochrome
paper-on-ink, Archivo/Public Sans). The organizer reviewed it on the live box
and rejected the theme — the direction is now **the original navy/blue
terminal identity, refined**, with the redesign's structural wins kept.

`DESIGN_SYSTEM.md` is the palette and token authority (it always described
the original identity). This file records what carries over from the
redesign, what reverted, and the rules that keep the two coherent.

## The stance

- **Theme = original.** Deep navy grounds (`#1a1a2e` page, `#16162a` cards,
  `#12121e` deepest), blue `#2563eb` as the single brand accent (`#60a5fa`
  for body-size links), semantic green/red/amber/teal exactly as
  DESIGN_SYSTEM.md defines them. Terminal personality is deliberate:
  the `$ owasp-ctf` wordmark (green `$`, mono), `$ sign-in --github`,
  mono for data. The project logo — a fox, a server box and a flag beside the OWASP
  mark — anchors the landing hero: this kit is an OWASP project and
  says so.
- **Structure = redesign.** The layouts shipped by the redesign stay:
  the landing as a pitch with one state-aware CTA, the challenge browser as
  a stack of collapsible target progress cards (rows in a two-column grid
  behind each; a single-target event auto-opens, any active filter
  force-opens matches), the leaderboard's
  `?display=1` projector mode, the phase line, the "Your run" rail on the
  classic board.

## Enhancements over stock-original (keep these)

- **Amber focus rings** (`outline-[#d4a017]`) everywhere — one focus color,
  visibly distinct from both the blue accent and the grounds. Text inputs
  used to be the exception: they swapped the ring for a 1px amber border
  tint (`focus-visible:outline-none`), which is a weaker indicator than
  anything else in the app and made "everywhere" untrue. They now show the
  ring *and* keep the border tint. The one remaining `outline-none` is the
  confirm dialog's panel, which is a `tabIndex={-1}` programmatic focus
  target Tab never reaches — its controls each keep their ring.
- **`.ds-link`** underlined inline links in `--accent-blue-link`; color
  alone can't carry the affordance inside body text (WCAG 1.4.1).
- **`.ds-tap-24`** grown pointer targets on dense chip rows (WCAG 2.5.8).
- **`tabular-nums`** on everything numeric (ranks, points, counts).
- **Motion discipline**: `head-breathe` (the phase line's HEAD marker) is
  the one animation that survives; everything is neutralized under
  `prefers-reduced-motion`. The old scanline/pulse-glow loops stay retired,
  and `check-land` — the celebratory sweep of a check atom the app never
  rendered (see below) — went with it.
- **`.ds-card` hover** = border brighten + the original accent glow.
- **`.ds-skeleton` + `components/skeleton.tsx`** — the route-loading atom.
  Every page reads Redis at request time, so a nav click used to sit on the
  old page with no acknowledgement; the heavy routes (leaderboard, profile,
  admin) ship a `loading.tsx` built from `SkeletonPage` / `SkeletonHeader` /
  `Skeleton`, shaped like the page it stands in for so the swap fills in
  rather than jumps. `SkeletonPage` carries the one `role="status"`
  announcement — a client-side route change moves no focus and says nothing
  on its own.

  **A `loading.tsx` must never cover a route that can `notFound()`.** A
  Suspense fallback starts the response body, so the status is already sent
  by the time the page runs and a later `notFound()` streams a soft 404 with
  status **200**. The module routes (`/challenges`, `/quiz`, `/flags`) 404 by
  design on an event that has those modules switched off, and the quiz-only
  and classic-only acceptance scripts assert exactly that — a group-wide
  `(site)/loading.tsx` turned every one of those 404s into a 200 and failed
  both. Hence: no group-level loading state, and none on a module route. The
  rule is derived and asserted in `app/__tests__/loading-and-errors.test.tsx`
  rather than left as a comment, because which routes can 404 changes as
  modules come and go.
- **Skip link** — `Skip to content` in the root layout, hidden until focused,
  targeting the `#main-content` every `<main>` in the app now sets (WCAG
  2.4.1). The header runs to a wordmark, up to six module links, a dropdown
  and the auth control; that was the tab cost of reaching any page's content.
- **Error boundaries** — `app/error.tsx` (branded, keeps the chrome, offers
  `retry()` first and prints the digest an organizer can grep for) and
  `app/global-error.tsx` (the root layout itself failed, so no CSS and no
  fonts — every colour there is inline on purpose). Note the prop is
  `retry`, not the `reset` older App Router code uses: this app vendors
  Next 16.3, where `retry` re-fetches the segment's data and `reset` only
  re-renders the same failed children. These catch render faults, not a store
  outage — the Redis reads fail open, and a leaderboard with `redis`/`srh`
  stopped still returns 200 with the page intact.

## The system shape (kept from the redesign)

**The phase line** (`phase-line.tsx`): the event's phases as a git graph
under the header — `registration → live → frozen → results` — HEAD on now.
`resolvePhase` shares `outsideWindow` with enforcement and fails silent on a
settings error by design.

The redesign described a second shape, a **check atom** (`score-check.tsx`:
a status dot + verdict + points, like a CI check line, as the universal form
of every score). It was written but never rendered — no surface ever
imported it — so it was removed rather than left describing a shape the app
does not have. Scores render per surface (the leaderboard's columns, the
profile's per-challenge lists, the boards' tiles), each with its own markup;
what they share is the colour meaning above: green `#22c55e` = scored, red
`#e53e3e` = failed, amber `#d4a017` = pending/attention.

## Type

Original stack: **Poppins** (headings, via the global `h1–h6` rule and the
`font-display` utility), **Barlow** (body), **Geist Mono** (data, prompts,
counts). All `next/font`, self-hosted.

## Rules that keep it coherent

- Blue is the brand: solid CTAs are `bg-[#2563eb] hover:bg-[#1d4ed8]`
  with white text; secondary actions are bordered ghosts that pick up
  `border-[#2563eb]/45` on hover.
- Teal `#14b8a6` is the eyebrow/kicker color and the rank-3 podium accent —
  punctuation, never a surface.
- State colors keep their meanings from the redesign: green only for
  scored/solved, red only for failed/destructive, amber only for
  pending/attention/focus.
- Event copy stays organizer-driven — the event's name and identity are
  runtime `/admin` settings (#386); the `$ owasp-ctf` wordmark is the kit's
  brand and the one deliberate exception.
- **A number the board ranks by is never `hidden sm:`-only.** The
  leaderboard's `solved` / `members` columns are desktop-only for width
  reasons, so both rows restate them as a compact line under the name below
  640px — the phone is where most contestants read the board, and hiding the
  figure that explains the ordering there re-opens the exact gap those
  columns were added to close. Same rule put the target's repo link into the
  expanded challenge card for narrow screens.
