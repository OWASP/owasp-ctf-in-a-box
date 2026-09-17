---
title: Operations
---

[← Docs home](index.md)

# Operations

Running the event once it is up: what organizers do during and after, the
admin panel, how teams work, how to verify the kit before an event, the local
dev-stack for clicking through the real experience, and the current status of
live-GitHub scoring. For standing the kit up in the first place, see
[docs/hosting.md](hosting.md).

**On this page:**
[Running an event](#running-an-event) ·
[Teams](#teams) ·
[Admin panel](#organizer-admin-panel) ·
[Archiving and replaying an event](#archiving-and-replaying-an-event) ·
[Quiz](#quiz) ·
[Jeopardy](#jeopardy) ·
[Verifying it works](#verifying-it-works) ·
[Local dev-stack](#local-dev-stack) ·
[Known limitations](#known-limitations) ·
[Status](#status-and-upstream-dependencies)

## Running an event

**During:**

- The leaderboard and app live at the `EVENT_URL` you configured in `.env`.
- **How fresh the board is.** The folded standings — every module's points,
  team totals, the chart, hint penalties — are computed once and shared by
  every viewer for **10 seconds**, then recomputed on the next request
  (`apps/web/src/lib/leaderboard/folded.ts`). So a quiz answer, a flag or an
  AI solve shows on `/leaderboard` and the landing strip within 10 s rather
  than on the contestant's very next page load. Secure Development points
  take longer: the app's read of the scorer is itself cached for 30 s
  (`next: { revalidate: 30 }` in `lambda.ts`), and the 10 s memo sits on top
  of it, so a score the poller has already ingested can take up to about
  40 s to reach the board — and the poller's own cadence comes before either.
  The projector board refreshes every 30 s regardless. A contestant's own
  `/profile`, `/quiz`, `/flags` and `/challenges` read live and show their
  solve at once. A read that fails is never cached — the next request
  retries.
- Poller logs: `docker compose logs -f sync`.
- All state lives in named Docker volumes, so a box reboot loses nothing.

**After** — preview the teardown, then run it:

```sh
./setup/ctf-setup.sh teardown --dry-run
./setup/ctf-setup.sh teardown
```

This archives each target repo in the event org. It does **not** revoke
credentials or delete secrets — do that yourself: uninstall the GitHub App,
and delete any Actions secrets the org still carries. `LEADERBOARD_URL` /
`LEADERBOARD_TOKEN` are the ones to look for on an org that has hosted an
event before: push ingest was removed in v0.6
([#377](https://github.com/dcotelo/owasp-ctf/issues/377)), so nothing reads
them and they are just credentials every contestant-triggered run can read.
`ctf-setup.sh doctor` reports whether they are still set.

## Teams

Scoring is per team, and **a team is required** — nothing a contestant solves
counts until they are on one. Contestants self-register in the app: create a
team to become its captain and get a join code, join an existing team by code,
or hit **Play solo** for a one-click team of one named after their GitHub
login. Everyone ends up on a team — a solo player is simply a team of one.

The requirement is enforced in three places, earliest first. **At sign-in**:
every GitHub sign-in lands on a post-signin step that sends a contestant with
no team straight to the team card — team setup is the first thing a new
contestant completes, not something discovered later (a `/join/<code>` invite
passes through untouched, since the invite *is* the team step). **At the
module pages**: a signed-in contestant with no team who opens `/quiz`,
`/flags` or `/ai` is sent to the team card too, so nobody who slipped past the first
step discovers the rule by answering a question and watching it not count.
**At the routes**: the quiz and flag submission routes refuse a teamless
login outright — the boundary that actually holds. Organizers are exempt
from both redirects — they sign in to check that their content renders,
which is not playing — but not from the submission check, since an
organizer's points would fold into no team either. **So a teamless
organizer gets a notice above the form instead**, naming the same fix and
the one-click **Play solo**: the exemption is from the redirect, not from
being told. Without it the rule reached them the expensive way — the form
rendered, the route refused the submission, and they learned the
requirement from a solve that did not count, which made the people most
likely to be testing a board the ones guaranteed to discover it by losing
something to it. If registration is closed when a teamless contestant
reaches the team card, it explains that instead of offering forms the
routes would refuse.

> **Secure Development still has no route to refuse.** Its points arrive
> from GitHub through the sync poller rather than through an app route, so a
> contestant who patches a fork while on no team has their score ingested
> against a login that belongs to no team, and it contributes to no team
> total **until they join one** — team totals fold from current membership
> at read time, so already-banked solves count from the moment the login is
> on a team. That deferred-credit behavior is deliberate: refusing the score
> at ingestion would lose it permanently (the poller marks the comment seen),
> whereas banking the score against the login only delays credit. The
> sign-in steering
> above is what closes the gap in practice — it is the only enforcement
> point this module's scoring path passes through — so it matters most for
> events running Secure Development.

Captains
manage the roster from the app: rename the team, remove a member, transfer the
captaincy, regenerate the join code, or disband. The join code doubles as a
shareable link — **Copy invite link** on the team card yields
`https://<your-event>/join/<code>`, which a teammate opens and joins in one
click. Signing in mid-way keeps the invite: the code lives in the URL, so the
GitHub round-trip returns to the same page. Regenerating the code invalidates
any link that carried the old one. Team size is capped at four members by
default; an organizer changes that from the admin panel's **Event** tab
("Players per team") without a rebuild.

The leaderboard ranks **teams**, and each row expands to show its members with
each member's individual points. A flag solved by several teammates counts
**once** for the team, so a team's total can be lower than its members' scores
added together — the leaderboard dedupes shared solves rather than
double-counting them. Organizers open or close the registration window from
the admin panel below — by hand with the **Team registration** switch, or on
a timer with the **Registration opens** / **Registration closes** schedule
fields. While it is closed nobody can create or join a team, and a captain
cannot rename it, remove a member or regenerate its code; **transfer
captaincy, disband and leave still work**, because those are exits and
gating them would trap a captain behind a closed window.

![A contestant's profile: the header shows their points plus one done-out-of-available stat per enabled module, and the team card below carries the join code, invite link and captain controls](assets/profile.jpg)

<sup>The profile is where teams live day to day: the join code and invite link
to share, the captain's controls, and a header stat per enabled module.</sup>

## Organizer admin panel

Anyone listed in `.env`'s `ADMIN_LOGINS` (checked case-insensitively against
their GitHub login) can sign in and reach `/admin` — everyone else gets a
403, on both the page and its API routes.

Those are the **bootstrap** admins: read from the environment at runtime, so
changing them needs a restart, not a rebuild. An empty or unset
`ADMIN_LOGINS` locks everyone out of `/admin`. Everyone else is granted from
the panel itself, on the **Admins** tab, and takes effect immediately (see
below).

The header is one row — `Admin · <event name> · <phase badge> · until <date>`
— with the same phase vocabulary and colours as the public phase strip. The
controls sit behind a **left sidebar** in three groups (it collapses to a
"Sections" drawer on narrow screens):

- **Run** — **Overview**, **Activity**, **Insights**, **Support**.
- **Content** — **one destination per enabled module**, in event-config
  order, labelled with that module's name as the organizer has set it. A
  module's own knobs live in its own destination, so an event that doesn't
  run a module never sees its settings at all.
- **Setup** — **Event** (identity, modules, freeze, team registration, team
  size, the schedule, then demo seed and the master reset at the bottom),
  **Hints**, **Admins**, **Sponsors**.

![The admin panel's Event tab: the per-module switches, the freeze and team-registration toggles, the players-per-team cap, and the schedule fields with a live "right now: scoring is live" readout](assets/admin-event.jpg)

**Overview is the default** on load, regardless of how many modules are
enabled — unless the URL names another destination (see the deep links
below). It answers "is scoring on, how many teams, is anything stuck" in one
screen: the phase and time remaining, **Scoring** and **Registration** as
switches you can flip from there, the team / player / submitted / stuck
figures (stuck leads when it is non-zero), the poller's sync health line
(one line — last poll, ingested, dropped, running/paused — that opens into
the full breakdown, repos polled, last drop and last error, the old Status
card), the five most recent activity rows, and a setup-status line per
module ("checking…" until that module's own panel has reported its counts;
"enabled" for a module with nothing countable). The figures and the activity
rows load when you open Overview and, **while the event phase is live,
refresh every 15 seconds**; the stamp on the phase row ("updated 12s ago ·
refreshes every 15 s") says how old the read is, and reads "auto-refresh
paused while the event is not live" before scoring opens or once it is
frozen or over — the panel still loads once when you open it, but the
numbers do not move in those phases, so nothing is re-polled. While live, a
hidden browser tab never polls, and switching back to it refreshes at once.
A read that fails says so in place rather than sitting on "Loading…", keeps
the previous figures and the stamp's age (so retained data is never called
"updated"), and clears itself when a later refresh succeeds.

Every on/off control in the panel — the module switches, Freeze scoring and
Team registration on Event, Scoring and Registration on Overview, Hints
enabled — is a switch that reports its own save beside the row: "Saving…",
then "Saved" for a moment, or the reason the server refused it (with the
switch snapped back to the stored state). Overview's Scoring switch and
Event's Freeze scoring row write the same setting, so a flip on either
screen shows "Saved" on both. The numeric fields do the same and no longer
show a browser spinner: type the value, tab out, read the line under it.

The hint policy has its own **Hints** destination because it is event-wide:
Secure Development, Jeopardy and AI all sell their hints through the same
four settings. (It sat on the Secure Development tab for a while, which left
a classic-only or ai-only event with no hint switch at all, then in a section
of Event.) **Every move has been a UI relocation only** — the underlying
storage keys (`hintsEnabled`, `hintCost`, `hintsMinSolves`,
`hintsUnlockAfterMin`) and their validation are completely unchanged, so no
deployed event's settings, or their meaning, changed by upgrading.

**Every module screen opens with a sticky header and a setup status line.**
The header is the module's name and its **Enabled** switch — the same control
as the module's row on Event, with the same lock (the last live module cannot
be switched off) and the same confirmation, so a flip on either screen shows
"Saved" on both. Under it, one line — "Setup complete · 4 categories · 12
challenges" — opens into the setup checklist: what contestants experience in
that module, the steps you do **in this panel** in dependency order, and a
link to that module's section of this page. The checklist is **expanded only
while a step the panel can verify is still to do**; once questions or
challenges or categories exist it collapses to the line, and stays collapsed
while the counts are still loading ("checking…") rather than accuse a set-up
module on first paint. Steps done outside the panel (`ctf-setup.sh`, the
GitHub org, `.env`) are not repeated — the screen exists only while the
module is enabled, so they are behind you; the linked guide has them. A
second line, **What is safe to change mid-event**, opens the safe / not-safe
lists. All of it is registry content (the module contract's §5.9), not copy
typed into each tab.

**Settings card.** Below the status line, one card holds the module's
**title** and **blurb** side by side, its own knobs (the quiz's retry gate,
the cooldowns), and — on every module that sells hints — a link to the Hints
screen where their price lives. The title is capped at 60 characters, the
blurb at 200; both are plain text only — control characters and Unicode
bidi-override characters are rejected, since there is no markup to sanitise,
only rendered text to keep intact. **Leaving a field blank clears the override
and restores the module's registry default** — the field's placeholder shows
what that default is, so clearing it is discoverable rather than a guess.
Changes are
live on the next request; there is no rebuild and no cache to wait out.

**Where a rename actually shows up.** Set a title and it replaces the module's
name in three places on every event: **the tab's own label**, **the nav link**
(header and footer alike), and **the module's own page header and browser tab
title** (`/challenges` for Secure Development, `/quiz` for Quiz, `/flags` for
Jeopardy). Two further
surfaces exist but are **suppressed on a single-module event**, which is what
most events are:

- the **leaderboard's per-module block heading** — hidden while only one
  module is enabled, because a row's points *are* that module's and the
  heading would only restate the column above it;
- the **landing page's per-module section heading** — a lone module's section
  is headed "What to expect" instead, and the page's uppercase kicker comes
  from the module's registry tagline, which is **not** overridable at all.
  (A module with no registry `home` block is the exception: its section
  heading *is* its title, override included, because there is no authored
  heading to prefer. Neither module shipped today is in that position.)

So on a one-module event a rename reaches three surfaces, not five. Nothing is
broken if you cannot find your new name on the leaderboard or the landing
page — those two only start naming modules once there are two to tell apart.

**The blurb is contestant-facing copy — write it as such.** It reaches three
places:

- the **meta description** of the module's own page (what a search result or a
  chat link preview shows);
- **`/quiz`'s and `/flags`'s page header**, as the lede under the title. This
  is the module describing itself; the "You've answered 2 of 5 questions."
  (or "You've solved N of M challenges.") line is *your* progress, and sits
  above the questions/challenges instead;
- the **landing page section lede**, but only for a module that ships no
  registry `home` block. All four modules that exist today have one, so
  today this
  is a fallback for a future module rather than something you can see —
  Secure Development's, Quiz's, Jeopardy's, and AI's landing copy all come
  from the
  registry and are
  not organizer-editable.

Leaving it blank restores the module's registry default, which is a complete
sentence, so a blank blurb is a perfectly good answer — it is never an empty
line on a page.

The panel offers:

- **Identity** (Event tab, top of the page) — how the event names itself, a
  runtime `/admin` setting (issue #386). It is the only place these five
  fields exist: there is no config file to set them in and nothing is baked
  into the image. Each restores its default when left blank: **Event name** (≤80
  characters; blank restores "OWASP CTF"; shown in page titles, the header,
  the leaderboard, and this panel's own master-reset confirmation),
  **Tagline** (≤160; one line under the event name on the landing page;
  blank hides it), **Location** (≤160; shown beside the dates on the landing
  page and in the page description; blank hides it), **Contact e-mail**
  (≤254; the organizers' own inbox, rendered as a `mailto:` link on the
  privacy and terms pages; blank hides it), and **Discord invite** (≤200;
  must be an `https://` URL; the header, hero, rules, how-to-play, FAQ and
  404 pages link to it; blank hides every Discord mention). Changes are live
  on the **next page load** — no rebuild, no cache to wait out.
- **Status** — the sync poller's heartbeat (last poll time, comments
  ingested, comments **dropped**, repos polled, last error) and a
  best-effort leaderboard freshness read.

  **Read Ingested and Dropped together.** Ingested is points that reached the
  leaderboard; Dropped is points that reached a contestant's PR and stopped
  there — the scorer rejected the submission, or the comment carried a
  `ctf-score:` marker the poller could not read. Dropped should be **0** on a
  healthy event; it turns amber and a **Last drop** line names the repo, the
  PR, and the reason when it isn't. Neither figure resets on its own: a
  dropped score is still missing after the poller recovers, so the pointer to
  the PR that needs looking at stays up (unlike Last error, which describes
  only the most recent tick). A nonzero Dropped means a contestant is looking
  at a correct score on their PR that the leaderboard does not show — go read
  the poller's logs for the matching line, fix the cause, and re-run that PR's
  scoring workflow.

  Routine things are deliberately **not** counted here: a comment re-read at
  the cursor boundary, and the workflow's own "⏳ Scoring in progress…"
  placeholder, are both expected and leave Dropped at 0. The poller's logs
  carry a per-repo breakdown of those on any tick where something
  non-routine happened.
- **Freeze** — a pause switch. Pausing **freezes ingestion, not fork
  Actions**: contestants' PRs keep getting judged and commented on exactly
  as before, and the poller's cursor just holds in place — nothing is lost,
  only deferred. The scorer reads the same flag and answers `POST /score`
  with `503` while it is set, so a submission that reaches the writer anyway
  is refused rather than written. Un-pausing picks up right where it left off.
- **Modules** (Event tab) — which modules this event serves, switchable
  **during the event without a rebuild**. Switching one off removes its nav
  link and stops its board resolving on everyone's next page load; switching it
  on brings both back.

  **It deletes nothing.** A disabled module's answers, solves, attempts and
  points stay exactly where they are, so re-enabling restores the same board —
  the toggle is a switch, not a delete. Use it to pull a broken board out of an
  event without losing what contestants have already done.

  For Secure Development specifically: switching it off does not stop the
  poller or the scorer — ingestion keeps running underneath, and any points
  it records while the board is off show up on the board again the moment
  you switch it back on.

  One thing it refuses, on purpose: **Secure Development on a deployment with
  no scorer image.** The scorer and sync containers are chosen when the stack
  comes up (`SCORE_IMAGE` in `.env`), and the app cannot start one, so the
  switch is greyed out with that reason and the server refuses the write.
  Everything else — including switching the last board off — is yours. An
  event with nothing on shows "No boards are open yet" and points at this
  panel.

  A Secure Development left **on** from before the scorer image was removed
  is not force-disabled outright — it is hidden from contestants (the module
  contract's usual "switched off" behaviour) and drops out of the stored
  enabled set automatically the next time you change any module here, so it
  never comes back on its own once the deployment has a scorer image again.

  **What is on before you touch anything:** Secure Development, and only
  when the deployment has a scorer image (`SCORE_IMAGE` in `.env`); otherwise
  nothing. Quiz, Jeopardy and AI always start off. Nothing else influences
  enablement — there is no config file and no baked default (#386) — and
  which Secure Development targets run is a separate setting on that module's
  own tab; if the settings read fails the app falls back to that same "all
  six" default rather than to a surprise.

  **What a contestant sees.** The module's nav link disappears from the header
  and the footer, and its route stops resolving — with a page that says the
  module is switched off, that their link is fine, and that nothing they have
  already solved is affected. It is deliberately not the generic "that page
  doesn't exist, your link is wrong or out of date": their link was right, the
  page was there a minute ago, and sending them to hunt for a better URL wastes
  their time mid-event. `/challenges` behaves like the other boards' switched-off
  pages.

  A newly enabled module's own **admin tab** appears on the next page load,
  since the tab strip is rendered server-side.

- **Team registration** — an open/close switch for the team-forming window.
  While closed, players cannot create or join teams (**Play solo** included),
  and a captain cannot rename the team, remove a member or regenerate the
  join code. **Transfer captaincy, disband and leave are deliberately not
  gated** (`team-store.ts` says so at each one): they are exits, and gating
  them would trap a captain the moment registration closes. Existing teams
  keep their scores. The switch is one of two things that close registration
  — the scheduled window below is the other.
- **Schedule (auto dates)** — four optional date-time fields, on the Event
  tab beneath the players-per-team cap: **Scoring opens** / **Scoring
  closes** (`scoringStartsAt` / `scoringEndsAt`) and **Registration opens** /
  **Registration closes** (`registrationStartsAt` / `registrationEndsAt`).
  You enter local time; each is stored as an ISO instant, and a blank field
  means no bound on that side. They stack **on top of** the manual toggles
  rather than replacing them: scoring is live only when it is not frozen
  *and* inside its window, registration is open only when the switch is open
  *and* inside its window — either condition on its own closes it. Because
  four fields plus two switches is a boolean nobody should do in their head
  mid-event, the section shows the **effective** state in a live
  **Right now:** readout — "scoring is live" / "is frozen (manual)" / "is
  frozen (outside its window)", and the same three for registration —
  computed from the very fields it edits. The scoring window is honoured by
  every reader of scoring state (the app, the scorer, the sync poller — see
  [architecture](architecture.md)); the registration window is enforced by
  `team-store.ts` on exactly the mutations the manual switch gates.
- **Hint controls** (the **Hints** destination, under Setup) — whether hints are enabled and
  what they cost. Hints are **on by default** and cost 10 points each; the
  cost (`hintCost`) is a whole number from 0 to **100000**. This is
  the **only** hint switch: there is no environment variable, and the toggle
  takes effect immediately across every surface — whether a hint **can be
  bought**, whether the challenges page **offers** the button and its notice
  banner, and whether the leaderboard shows the **hint-penalty** column.
  Turning hints off does not forgive points already spent: the spend stays
  recorded, so switching back on restores the penalties rather than wiping
  them. The one thing the toggle cannot do is turn hints on without
  `UPSTASH_REDIS_REST_*` credentials — the hint text lives only there.
- **Hint gating** — two knobs that decide *who* may buy a hint and *when*,
  enforced server-side in `revealHint` (the API is the boundary; the UI only
  hides things):
  - **Solves required** (`hintsMinSolves`, default **1**, at most **1000**) —
    a login must
    already have solved that many challenges **on that target** before it can
    buy any of that target's hints. This is the anti-farming gate: a hint's
    price lands on the account that reveals it, but the hint *text* is
    trivially relayed, so a throwaway account could otherwise buy hints, eat
    a penalty nobody cares about, and pass the text to a real team. Requiring
    earned progress makes that cost the same real work the event scores. Set
    to `0` to disable.
  - **Unlock after** (`hintsUnlockAfterMin`, default **0**, at most
    **100000** minutes) — minutes after
    the scheduled scoring start before *any* hint can be bought, so the early
    game is decided on unaided work. Needs a scoring start (the **Scoring
    opens** field under **Schedule** above) to have any effect; `0` means
    hints are available immediately.

  Both fail **closed**: if the solve lookup errors, the hint is refused
  rather than handed out unverified. Denials return `403` with a message
  naming what's missing. The module check is **per target**: a hint on a
  secure-development target requires that module enabled, a classic hint
  requires `classic`, an ai hint requires `ai`, and each refuses outright
  when its module is off (`hint-store.ts`'s `hintGate`). In practice only
  classic and ai ever reach it: **Secure Development has no hints**, because
  nothing in the kit authors hint text for a target, so no challenge on
  `/challenges` offers one and that page shows no hint banner (issue #334). Jeopardy and AI
  count "solves required" across the whole board rather than per app, the
  same way secure-development counts per target — see [the AI
  section](#ai) for its own hint text/knobs. The quiz has no hints by
  design — a question's hint is its choices.
- **Hint penalties apply to teams too.** A team's displayed points are its
  scorer total minus the **sum** of its members' hint spend, floored at 0,
  and the team board re-ranks on the penalised figure (a `−N hints` chip
  shows the deduction). Note the deliberate asymmetry with flag scoring: a
  flag solved by two teammates counts **once**, but a hint bought by two
  teammates is charged **twice** — hints are individually purchased, so
  redundant buying is the team's own coordination cost.

- **Activity** (its own tab) — the live event log: sign-ins, quiz, classic
  and ai solves (an ai solve's entry also notes whether it came in via flag
  or via event), and team create/join/leave/rename, newest first, with type
  chips and a login filter. Backed by one capped Redis list
  (`ctf:activity:log`, newest ~5,000 entries — older ones drop
  automatically), written **fail-open** so a Redis blip can lose a log line
  but never fail the sign-in or solve it describes. Entries carry the
  challenge/question id or team slug — **never a flag, an answer, or hint
  text** — and no IP or device data, which is what keeps the tab safe to
  screen-share mid-event. It loads when you open the tab and, while the
  event phase is live, refreshes every 15 seconds — re-reading as many rows
  as you have paged in, so the log never jumps back to its first page under
  you — with an "updated Ns ago" stamp beside the count; **Refresh** is the
  same read for when you won't wait. The master reset wipes it with the rest
  of the event's progress.

- **Insights** (its own tab) — engagement metrics for the event, computed
  **entirely from data the box already stores**. Nothing is collected from
  contestants' forks, and no new tracking was added: quiz answers and classic
  solves already carry a timestamp per item per login, Secure Development
  solves are timestamped as they are ingested, attempts are counted per login,
  and `firstTeamAt` supplies the funnel's conversion moment.

  It computes when you open the tab, not when the admin page loads — the fold
  is O(contestants) — and, while the event phase is live, recomputes every
  30 seconds (half Overview's cadence, for the same reason) with an "updated
  Ns ago" stamp beside the "as of" time; **Refresh** is the same read for when
  you won't wait. You get:

  ![The Insights tab: the five participation figures, a ten-minute-bucket solve timeline, and the hardest-first challenge table with solves, attempts, solve rate, average tries and median time to solve per challenge](assets/admin-insights.jpg)


  - **Participation** — on a team / ever on a team / submitted / scored /
    **stuck** (submitted and never scored). The gap between the last two is the
    number worth watching during an event.
  - **Solves over time**, in ten-minute buckets with a time axis (first,
    middle and last bucket, UTC; dated once the buckets cross midnight), so
    a room going quiet is visible and datable.
  - **Hardest first** — every challenge by solves, attempts, solve rate,
    *average tries taken by the people who did solve it*, and the *median time
    from their first attempt to their solve*. Those last two are the difficulty
    signal solve rate alone hides: a challenge everyone eventually solved on
    their fourth attempt, forty minutes in, is harder than its 100% rate
    suggests. Each row is named by its **title** — the quiz question's prompt,
    the challenge's title — with its generated id underneath, so the table can
    be read out without decoding slugs; a challenge deleted since it was solved
    keeps its metrics and shows its id alone. **Download challenges CSV**
    exports the full table, `title` beside `id` rather than instead of it.
  - **Where attention went** — scorers per module, hint buyers and spend, and
    how many hints were bought *before* the buyer solved the thing. A hint
    bought afterwards bought nothing, so that split is the difference between
    "hints are used" and "hints help".

  **What each figure counts.** Several of these mean something narrower than
  their label, and the narrow reading is the one that matters when you quote a
  number at a closing ceremony:

  | Figure | Counts | Does not count |
  |---|---|---|
  | **On a team** | Distinct logins on a team **right now** | Anyone who has since left |
  | **Ever on a team** | Distinct logins that have **ever** joined one — survives leaving and switching | Signing in; that leaves no record at all |
  | **Submitted** | Made at least one submission in any module | — |
  | **Scored** | Earned at least one point-bearing item in any module, Secure Development included | Submissions that never landed a point |
  | **Stuck** | Submitted **and never scored** | Anyone who has not submitted yet |
  | **Solves** (per challenge) | Distinct contestants who earned it | Repeat submissions by the same person |
  | **Attempts** (per challenge) | Every submission against it, right or wrong | Secure Development items, which do not appear in this table at all |
  | **Solve rate** | solves ÷ **the people who tried it** | The rest of the event; this is not an event-wide difficulty figure |
  | **Avg tries** | Mean attempts taken by the contestants who **did** solve it | Everyone still stuck on it — which is why a low rate and a low average can coexist |
  | **Median time** | Median seconds from a contestant's **first attempt** to their solve | Items earned before `firstAt` existed; those carry no start time |
  | **Team points** | The **sum** of each member's own totals | Nothing — and that is the catch: the leaderboard folds the **union** of their solves, so a challenge two teammates both solved counts once there and twice here |
  | **Hints before solving** | Hints bought **before** the buyer earned that item | Hints bought afterwards, and hints for items never solved |

  Solve rate can never exceed 100%: its denominator is the larger of "people
  with an attempt row" and "people who solved it", because an earned row can
  exist without an attempt row (the demo seed writes answers directly, and so
  does any data predating the attempts hash). Dividing by attempt rows alone
  once produced solve rates of 200% and 300% on a seeded event.

  The tab ends with **what these numbers do not measure**, and that list ships
  in the API payload too rather than living only here — a metric whose limits
  travel separately from it gets quoted without them. In short: team points on
  this tab *sum* each member's totals while the leaderboard folds the *union*
  of their solves; attempt rows carry a first and a last time but not one per
  try, so the timeline is solves rather than submissions; signing in leaves no record,
  so the funnel starts at "ever on a team"; Secure Development has no
  per-challenge attempt data, since its scores arrive already judged; and
  anything earned before these timestamps existed carries no start time, so
  early-event figures cover fewer contestants than late-event ones.

  **Admin-only, and it stays that way.** A solve rate is harmless to publish,
  but this payload is computed from per-contestant rows, so every field added
  to it later is one edit away from carrying a login. A public post-event
  summary, if you want one, should be an explicit export of chosen aggregates
  rather than this endpoint with its guard removed.

- **Support** (its own tab) — act on **one** contestant or **one** team,
  mid-event, without touching anybody else. Before this tab existed the only
  destructive control was the master reset below, so an organizer facing a
  single stuck contestant chose between doing nothing and wiping the event.

  Look a contestant up by GitHub login and the tab shows their team, their
  points and solves per module, their attempt count and their hint spend. Every
  action stays disabled until a lookup returns — seeing the score you are about
  to delete is the guard against resetting the wrong person from a
  half-remembered username while a room waits.

  ![The Support tab after a contestant lookup: their team and captain status, when they first joined a team, points and solves per module, attempt count and hint spend, with the reset and delete controls beneath](assets/admin-support.jpg)


  From there: **reset progress** (clears their quiz answers, classic and AI solves, attempts and
  hints; keeps the account and the team), **delete contestant** (all of that
  plus the team membership and the account record), or **remove from team**.
  Team-side, there is **transfer captaincy** and **disband** — the captain-only
  controls, available to an organizer for when the captain is unreachable. That
  is the common live ticket: a captainless team cannot rename, remove a member,
  regenerate its code, or disband on its own, and nothing else can rescue it.

  Two deliberate refusals. A **captain cannot be deleted or removed** while they
  hold the team — transfer or disband first, or you would leave a team nobody
  can administer. And **disbanding deletes nobody's points**: solves are per
  contestant, so the players keep what they earned and can regroup.

  > **Secure Development solves come back.** The scorer writes them with
  > `HSETNX` so replays are no-ops, and the poller re-submits from the PR
  > comments it reads — so a per-contestant reset clears them, and the next
  > time that contestant's PR is scored they are written again. The tab warns
  > when this applies. To make it stick, close the contestant's PR or freeze
  > scoring first. Quiz, classic and ai have no such problem: those writes
  > originate in the app, so a delete is final.

  Every action is admin-gated and writes an audit line naming **both** the
  actor and the target — "who deleted that team, and when" is a question asked
  after an event, not during it. The destructive ones require type-to-confirm
  against the specific login or slug, not a generic word.

- **Master reset** (danger zone) — wipes **all** contestant progress so a test
  run or a botched setup can be cleared before the real event. It deletes every
  solve, team, per-player record, join code, and hint purchase; it **keeps**
  everything you authored — quiz questions and their answer key, classic and AI
  challenges with their flags, hints and categories — along with your admin
  settings, and appends the reset to the audit log. It does rotate the AI
  module's launch keypair (see [below](#ai)), so an external challenge site
  re-fetches the public key on its next verification. It is server-side and
  admin-gated, and requires **typing the event name** — the current runtime
  name from the Identity section above, not a fixed default — to proceed (a
  single click can't fire it).

  The reset also **freezes scoring** and bumps a reset epoch that the sync poller
  honours by dropping its cursor. This is what makes a reset stick in **poll
  mode**: without it, the poller would re-ingest the same PR comments within a
  cycle and undo the wipe. So the intended flow is *reset → box is frozen →
  unfreeze when ready*. If you reset **after** real PRs exist and then unfreeze,
  the poller re-reads those still-present comments — for a post-event wipe that
  stays gone, also delete (or the org, archive) the source PR comments.

- **Quiz controls** (Quiz tab, present only when the `quiz` module is enabled) — the two
  retry-gate knobs (max attempts, accepted from 0 to **100**; retry cooldown,
  from 0 to **100000** minutes) plus full question
  authoring: add, edit, reorder (drag, or Move up / Move down from the row's
  **⋯** menu), and delete (also in that menu). See [Quiz](#quiz) below for
  what these do and their defaults.
- **Jeopardy controls** (Jeopardy tab, present only when the `classic` module
  is enabled) — the submission-cooldown knob (in **seconds**, not minutes)
  plus category management and full challenge authoring: add, edit, reorder
  (drag, or Move up / Move down from the row's **⋯** menu), and delete (also
  in that menu), with the list grouped by category the way contestants see
  the board. See [Jeopardy](#jeopardy) below for what these do and their
  defaults.
- **Seed demo data** (danger zone) — populates the leaderboard with fake
  contestants, teams, and real-challenge-id solves so you can preview the app
  without running real PRs. When the `quiz` module is enabled, this also seeds
  a small demo question bank with some already answered, so the board shows a
  genuinely combined score (patch points plus quiz points) rather than just
  one module. When the `classic` module is enabled, it seeds a demo flag board
  the same way — categories, challenges (flags included), and a spread of
  solves — so a multi-module event previews as one combined board. See
  [Jeopardy](#jeopardy) below. When the `ai` module is enabled, it seeds two
  demo challenges and a spread of solves for them, plus the `AI` category to
  hold them. Their **launch URL templates deliberately point at a placeholder
  host that does not resolve**, because a demo dataset cannot ship an
  externally hosted challenge site — so **Open challenge** dead-ends on both,
  and both are gradable by flag in the box instead, which keeps the demo board
  clearable end to end. Neither is seeded as `event`-mode on purpose: that mode
  can *only* be solved by an external arena reporting the solve, so seeding one
  put a challenge on the board that nobody could clear
  ([#355](https://github.com/dcotelo/owasp-ctf/issues/355)). See
  [AI](#ai) below for what the modes mean. Sponsors are seeded too, always —
  three placeholder ones, one per tier, so the landing-page strip, the
  footer, and `/sponsors` all preview populated instead of empty. Each
  carries a plain solid-color placeholder logo (nothing resembling a real
  brand mark) and uses the `.example` TLD, which cannot resolve to anything
  real. The seed also writes
  **attempt** rows, including some for items that were tried and never
  earned, so the
  **Insights** tab previews a plausible event rather than one where
  every challenge was solved first try by everyone who looked at it. Seed
  and its inverse, **Clear demo data**, are ordinary admin actions — no
  `DEMO_MODE` env var gates them any more (issue #419); admin auth plus a
  type-to-confirm click, same as every other destructive control on this
  screen, is the whole safety net. Both buttons live **inside the Event tab's
  danger zone**, above the master reset: Seed writes fake rows into the live
  event and Clear deletes rows again, which is the same class of action as a
  wipe, not ordinary setup. Clear removes exactly the run-state rows
  Seed added — the fake contestants, teams, solves, and sponsors — but
  deliberately leaves the demo quiz/classic/ai questions, challenges, flags,
  and categories in place: once written they're authored content, the same
  way a master reset already treats real challenges, so remove those by
  hand from their own admin tab if you don't want them.

**Every destination has its own URL.** `/admin/overview`, `/admin/activity`,
`/admin/insights`, `/admin/support`, `/admin/event`, `/admin/hints`,
`/admin/admins`, and one per enabled module — `/admin/quiz`,
`/admin/classic`, `/admin/ai`, `/admin/secure-development`. That is what the
sidebar links to, so a link is safe to bookmark, paste into a runbook, or
read out over a call. Switching tabs updates the address bar without a page
load, and Back walks the destinations you visited, so the URL always names
the screen in front of you.

The older `/admin?tab=<id>` form still works and still means the same thing —
docs, bookmarks and cross-links written before this keep resolving. This is
what `/quiz`, `/flags` and `/ai` link an organizer to when the module has no
content yet — an empty board shows them **Author questions** / **Author
challenges** instead of the contestant's "check back soon". An unknown or
not-enabled tab name, in either form, falls back to **Overview** rather than
404ing.

**Every setting says whether it saved.** The number knobs (hint cost and
gating, players per team, the retry gate, the cooldowns) and the four
schedule fields commit when you leave the field, and report beside it:
**Saving…** while the write is in flight, **Saved** for a moment after, or the
reason it was refused. Junk, a fraction, a negative, or a blanked field snaps
back to the stored value with that reason ("Whole numbers only — kept 10.");
a value the server refuses is rewritten through the field's own label ("Hint
cost must be a whole number between 0 and 100,000.") and the field snaps back
too, so what you see is always what is stored. The switches — module on/off,
Freeze scoring, Team registration, Hints enabled, and Overview's Scoring and
Registration — report the same three states beside their own row, so
nothing in the panel writes into the error line under it any more except the
demo seed and the master reset.

Every settings change is recorded in an audit log (who, when, what changed)
alongside the setting itself; the log (`ctf:admin:audit`) keeps the newest
**500** entries and drops older ones automatically. The five Identity fields
are the exception to "what changed": the audit line names the field and
whether it was set or cleared, never the value — `eventDiscord` can carry an
invite/join token and `eventContact` is personal data, so neither is fit for
an admin-visible log. **Disruptive controls
prompt for confirmation**: the freeze and team-registration toggles, each
module's Enable/Disable switch, and **removing an admin** on the Admins tab
ask a one-click "are you sure?"; every control in the Event tab's danger zone
— **Seed demo data**, **Clear demo data** and the master reset — requires
type-to-confirm. Opening a different question or
challenge while an unsaved draft is open also asks before discarding it —
the module forms sit below the list, so every list control stays clickable
while you write.
**The panel accepts only the event's name** as that phrase — exactly the
**Event name** currently set on the Event tab's Identity section (or its
default, `OWASP CTF`, if you have not changed it). The route behind the button,
`POST /api/admin/reset`, additionally accepts the literal `RESET` as its
`confirm` value; that is a raw-API fallback for a scripted reset, and the
panel never offers it.

When the `quiz` module is enabled, the master reset also clears every
contestant's quiz answers and attempts (and the two aggregate point/answered
counters the leaderboard reads) — but it deliberately **keeps your authored
questions and their answer keys**, the same way it keeps the event's
identity and policy settings. A reset event doesn't mean re-building the quiz
from scratch.
See [Quiz](#quiz) below.

**A reset that cannot finish now fails instead of reporting a count.** The
wipe walks the keyspace in pages, and a page it cannot read used to be treated
as "that was the last one" — so a sweep that stopped halfway still returned
`cleared: 412` and an organizer opened a "fresh" event holding the previous
one's solves, with nothing having reported a problem. The reset now surfaces
the error. Deletions already made stand, and **re-running it is safe**:
deleting a key that is already gone does nothing, so the fix for a failed
reset is to run it again.

`classic` is scoped exactly the same way: the master reset clears every
contestant's flag solves and attempts (and the three aggregate
points/solved/solve-count hashes the leaderboard reads) but deliberately
**keeps your authored challenges, their flags, and your categories** — the
same organizer content/contestant progress line the quiz reset draws. A
rehearsal on the `classic` module wipes back to the challenge set you wrote,
ready to run for real. See [Jeopardy](#jeopardy) below.

### Targets

Also on the **Secure Development** tab: which of the six targets (Juice Shop,
DVWA, WebGoat, Security Shepherd, VulnerableApp, VAmPI) this event actually
runs, as a checkbox list. `ctf-setup.sh org` forks and provisions all six for
every event that provisions Secure Development at all — six forks, six
scoring workflows, six package Read grants — regardless of this setting; an
event with no `secure-development` block forks and grants nothing (see
[modules.md](modules.md)). The checkboxes decide which of those six
contestants see and which the sync poller reads, not which get provisioned.
At least one target must stay checked — the last box is disabled, the same
lock as the last live module's Enabled switch, because unchecking every
target is what disabling the whole module is for.

A change here reaches contestants on their **next page load** (the challenge
browser, the leaderboard's per-app breakdown, and the module's setup-status
counts all read the stored list at request time) and reaches the sync poller
on its **next tick** (it re-reads the list from Redis every poll rather than
once at startup). Absent — a fresh event, or one that has never touched this
control — defaults to all six on both sides; a Redis read that fails during a
page render also falls back to all six (fail open), but a poll tick that
cannot read the list polls **nothing** that tick and records the failure as
the poller's `lastError`, rather than guessing (a wrong guess here would mean
scoring the wrong repos or none at all).

This panel is the only place the running set is chosen; there is no file and
no environment variable that also names targets, so nothing can disagree with
it. The [event archive](#archiving-and-replaying-an-event)
carries the setting: an export's snapshot includes `secureDevTargets`, and
importing one restores exactly the target list it was exported with.

### Re-run cooldown

On the **Secure Development** tab. It is the minimum minutes between *scored*
runs on the same PR — every run hands back a per-challenge pass/fail, so a
short cooldown lets a contestant iterate a check-gaming patch against the
rubric. The default is **5** minutes (a blank field means the default; it is
the same `5` the fork workflow carries as `COOLDOWN_MINUTES`), the field
accepts 0 to **1440** — a day, long enough for any "one scored run per
session" policy and short enough that a typo cannot freeze scoring for a
week — and `0` disables it.

It takes effect on the **next push**, with no re-rendering of any fork's
workflow: each fork's Action reads the current value from the event when it
runs. If the box is unreachable the Action uses the value baked into its
workflow instead, so scoring continues either way.

### Players per team

The cap defaults to four and is changed from the **Event** tab. It is enforced
**when someone joins**, inside the same atomic Redis script that adds them to
the roster — so the number the panel shows and the number the join path
enforces are always the same value, read through one resolver.

**Lowering it never evicts anyone.** A team already at five keeps its five
players when the cap drops to four; it simply cannot take another. Raising it
takes effect on the next join.

A cap of 0 is rejected: it would refuse every join, including into a captain's
own team, while the UI advertised "0 players max". The accepted range is 1 to
100.

If Redis is briefly unreachable the cap falls back to the default rather than
refusing joins — the opposite of the admin access check, and for the same
reason in reverse: a registration outage is a worse failure than being briefly
wrong about a team size.

### Adding and removing admins

The **Admins** tab grants organizer access at runtime. Type a GitHub login,
press *Add admin*, and they can reach `/admin` immediately — no rebuild, no
redeploy, no `.env` edit.

Two kinds of admin appear in the list:

| Source | Where it lives | Removable from the panel? |
| --- | --- | --- |
| `.env`'s `ADMIN_LOGINS` | read from the environment at startup | **no** — restart to change; marked `.env` |
| Added on this tab | `ctf:admin:admins` in Redis | yes |

**A bootstrap admin cannot be revoked here, and that is the point.** It is
the recovery path: no sequence of clicks, and no compromised admin session,
can lock every organizer out of the panel. If you genuinely need to remove
one, edit `ADMIN_LOGINS` in `.env` and restart — the same cost as adding one
used to be.

You *can* remove yourself, and the panel asks first. It is safe because, if
`ADMIN_LOGINS` contains at least one login, a bootstrap admin remains.

Only an admin can create an admin; there is no self-service path in. Every
grant and revocation is written to the same audit log as the rest of the
panel's changes, recording who did it and when.

**If Redis is unavailable**, runtime grants stop resolving and those admins
get a 403 — the access check fails **closed**, deliberately, and deliberately
unlike the freeze read, which fails *open* so a Redis blip cannot drop live
submissions. A bootstrap admin still gets in, because that check never
touches Redis at all — which is exactly when you most need the panel.

## Sponsors

The **Sponsors** tab (issue #405) is recognition-only: name, logo, link, a
short blurb. Sponsors get no sponsored challenges, no prizes wired into
scoring, no contestant data, and no lead capture — anything past that is out
of scope for this tab entirely. It is a platform feature, not a module: there
is no toggle to turn it off, and it renders on the landing page, the footer,
`/sponsors`, and the leaderboard's projector display (`?display=1`) if and
only if at least one sponsor is configured. An event with no sponsors ships
zero sponsor pixels anywhere.

**The tab is the list.** Each sponsor is a card showing its logo as it will
actually appear — on the site's own dark background, untreated — next to its
name, tier and link. That is the fastest answer to "did that upload work, and
does this logo read against a dark theme?", which previously meant opening the
public pages to check.

**Add a sponsor.** **+ Add sponsor** opens a dialog: name, an `https://` link,
an optional one-line blurb, a tier (Gold/Silver/Community — display grouping
and a label only; every sponsor appears on every surface regardless of tier),
and the logo. A logo is optional — without one, the sponsor's name renders as
plain text everywhere a logo would have gone. **Edit** on a row opens the same
dialog on that record, with the logo currently on file shown next to
**Replace logo…**, so you can see what you are replacing before you replace
it. Choosing a file previews it immediately; nothing is written until you
save. A file that is not a PNG, JPEG or WebP is refused in the dialog with
the reason, rather than after a round trip — though the box still decides for
itself from the uploaded bytes, and ignores whatever type your browser
claimed.

**Order is the arrows, not a number.** Each row has ↑ and ↓ buttons that move
the sponsor one place and save the new order straight away (the endpoint
renumbers the whole list); the arrow at either end of the list is disabled.
The row moves as soon as you click, while the write is still in flight, and
the saved order replaces it when the box answers. If the write is refused,
the list snaps back to the order the box actually holds and says why — so a
move that looks like it stuck, stuck.

**Sponsor logo size.** One control at the top of the tab — Small, Medium
(the default) or Large — sizes sponsor logos on the two surfaces where they
are a credit row rather than the content: the landing page's strip below the
hero, and the leaderboard's projector display (`?display=1`). Each surface
scales it for its own viewing distance, so Large on a projector is much
bigger than Large on the landing page. The `/sponsors` page is deliberately
not affected: it is the page that exists to show sponsors, and it keeps its
own layout.

**The 64KB PNG/JPEG/WebP-only rule, and why.** A logo must be a PNG, JPEG or
WebP under 64KB, decoded. **SVG is rejected outright**, with its own error
message explaining why: an SVG served from this box's own origin executes any
script it carries the moment someone opens the logo's URL directly in a
browser — being referenced only from an `<img>` tag elsewhere on the site does
not stop that. Export the logo as PNG, JPEG or WebP first; most design tools
do this in one step. The declared file type and filename are ignored — only
the file's own bytes decide, so renaming a `.svg` to `.png` does not get it
past this check.

**Prefer PNG or WebP with a transparent background.** JPEG has no alpha
channel, so its own background — usually white — renders as a solid rectangle
against the site's dark theme everywhere the logo appears, and on the
leaderboard's projector display (`?display=1`) it erases the logo entirely:
that surface renders every PNG/WebP logo as a white silhouette
(`brightness-0 invert`, meant for a transparent image), and an opaque JPEG's
whole rectangle turns uniformly white under the same filter, so the display
board skips it for JPEG and shows the logo in its real colors instead.

**Replace or remove a logo.** Saving the edit dialog with a new file replaces
the old logo immediately — the URL contestants already loaded stays the same
(`/api/sponsors/logo/<id>`), but its `ETag` changes, so a cached copy refreshes
within about five minutes. **Remove logo on save** clears it back to the
plain-text name; it is offered only on a sponsor that actually has a logo.

**A master reset clears sponsors too** — unlike a challenge's flag or
description, a sponsor list is scoped to one event run, and there is no
"disabled" state to fall back to; deleting a sponsor (or resetting the event)
is the only off switch. Re-add sponsors after a reset if the next run needs
them.

**In the event archive.** A sponsor-carrying export embeds each logo's bytes
as base64 inside the JSON bundle — a sponsor-heavy archive is noticeably
larger than one with none. Importing a bundle with a `sponsors` section
replaces the box's sponsor list wholesale, like every other section of an
archive import.

## Archiving and replaying an event

The **Event** tab carries an **Event archive** section — its own collapsed
block, above the danger zone rather than inside it, because **Export changes
nothing** and is the thing to run *before* anything risky (an **Export** button
and an **Import a bundle (replaces everything)** box, backed by `GET`/`POST
/api/admin/event`) for exporting
the whole event as one JSON file, or replacing it wholesale from a
previously exported one — publishing a finished event's content, or
stamping out a repeat run of the same CTF, without re-authoring anything by
hand.

**What a bundle carries.** Jeopardy, Quiz and AI **content** — challenges,
flags, hints and categories, quiz questions with their answer keys, and each
AI challenge's mode, launch URL template and **per-challenge signing key**
(so an external site configured against it keeps working after a restore) —
plus **policy** settings: the hint controls (enabled, cost, and its two
gating knobs), the quiz retry-gate knobs, Jeopardy's and AI's submission
cooldowns, the re-run cooldown, the team-size cap and registration switch,
module title/blurb overrides, and which modules are enabled. It also carries an informational **event
identity** block — `name`, `theme`, `dates`, `location` and `ctfStartsAt` —
read from the running box at export time.

**How a bundle is recognised.** The file's top level is stamped
`"kind": "archive"` next to a numeric `version`, and import checks both
before it looks at anything else: a file whose `kind` is not exactly
`archive`, or whose `version` this box does not know, is refused with the
field named. A per-module export — the Jeopardy board's or the Quiz bank's
own **Export** — carries no `kind` at all (it is a bare `version` plus
content) and is refused here for that reason; feed those to their own
module's import box, not this one.

**What it does not carry: contestant run state.** No teams, no users, no
solves, no attempts, no hint purchases, no admin audit log. That is the
whole security property that makes a bundle safe to hand out at all — it is
authored content and policy, never who played or how they did. It also never
carries the AI module's **launch keypair**: that is module identity, not
content, and an import leaves the box's own keypair in place so every
deployed external verifier and every token already in a contestant's browser
keeps working (ADR 53).

**Export** warns you of two things on the panel itself, before you do
anything with the downloaded file:

- if Secure Development is enabled, that its content — target repos, forks,
  rubrics, the GitHub App installation — lives outside the box and is **not**
  included in the bundle;
- if scoring is currently **effectively live** — not manually paused, and
  inside its scheduled scoring window (either one on its own makes scoring
  not-live) — that you should not publish this bundle while contestants can
  still play.

**The exported file contains every flag and every quiz answer key, in
plaintext.** Publishing a running event's bundle hands every contestant the
whole answer sheet. Only publish an archive once the event is over, or
before it starts as a fresh, unsolved seed — never while it is live, and
treat the file with the same care as `/admin` access itself.

**Import is replace-all, and it is destructive.** Confirming an import first
validates and applies the file's policy settings, then runs the same reset
the master reset button does — wiping every team, solve, attempt, and hint
purchase — and replaces the entire Jeopardy board, Quiz bank and AI catalogue
with exactly what the file contains (a section absent from the file leaves
that module empty, not as it was — replace-all, not merge). Settings go first and fail-fast: a bad or
cross-box-incompatible settings block is rejected before anything is wiped,
never after. It is **refused outright (`409`)** while scoring is
**effectively live** — not manually paused, and inside its scheduled scoring
window; manually pausing scoring is one way to make the event eligible for
import, but so is simply being outside that window even with `paused`
false. The panel gates the button behind two
confirmations in sequence — a plain warning naming exactly what gets wiped,
then a type-to-confirm phrase — so there is no single click that can fire
it.

**Import is not atomic — re-run it if it fails partway.** Once the settings
have validated, the reset and the three content replacements run in sequence
against Redis, and there is no cross-step transaction rolling them back: a
storage error partway through can leave the event reset and only partially
replaced. This is the same non-atomic property the master reset already has,
and it is deliberately bounded — import only runs while scoring is not live,
against an event you have chosen to overwrite. If an import errors, fix the
storage problem and simply run it again: it is a full replace-all, so a
second successful run overwrites whatever the failed one left behind.

**Name, tagline and location travel with the bundle; contact and Discord
never do.** The event's identity is a runtime `/admin` setting now (issue
#386), so on import only the supported identity fields — `name`, `theme`
and `location` — are applied, through the same validated settings patch as
every other policy field, before anything destructive runs — a restore or a
repeat run of the same CTF renames itself without a rebuild. The bundle's
`dates` and `ctfStartsAt` are informational only (they travel with the
export for the record — see above) and are **not** reapplied on import: both
are derived from the **Scoring opens** / **Scoring closes** schedule, which an
organizer sets for the new run on the Event tab, so importing a bundle never
overwrites this event's actual dates. **Contact e-mail and Discord
invite are deliberately left
out of the bundle**, even though both are runtime settings too: they are
organizer PII (a private inbox, an invite link), not needed to replay the
event, and not something an organizer should be handing out inside a file
they might publish or share — re-enter them by hand on the new box's
Identity section after import.

## Quiz

Switch Quiz on from `/admin` → Event → Modules and contestants get a second,
self-paced way to earn points: single- and multiple-choice questions,
answered directly in the app alongside Secure Development's patch
challenges. It doesn't touch GitHub,
the scorer, or `sync` at all — see
[docs/architecture.md](architecture.md#quiz-data-flow) for how it scores
entirely inside the app.

![The quiz as a contestant sees it: answered questions collapsed to what they earned, open ones showing their choices, remaining attempts and point value](assets/quiz.jpg)

<sup>What a contestant sees: answered questions collapse to what they earned;
open ones show their choices, the attempts they have left, and what a correct
answer is worth.</sup>

**Authoring** happens in `/admin`, under the Quiz module's section (see
"Quiz controls" above): add a question with a prompt, pick **single choice**
or **multiple choice**, give it two or more labeled choices, mark which
one(s) are correct, and set its point value. **Editing an existing question
prefills its current correct answer(s)**, so fixing a typo in a prompt
doesn't mean re-picking the answer from memory — get that wrong and you'd
silently change what counts as correct for every contestant, with no warning
and no way to notice until the scores look off. The answer key is visible
only inside the edit form and only to an admin (`/admin` is gated, and anyone
through that gate can already rewrite or delete the answer outright); the
question list itself doesn't show it, and it never reaches a contestant —
`/quiz` is served from a separate, keyless read that never touches the answer
hash at all.

**You don't type a question id.** Adding a question mints one from its prompt
plus a short random suffix (`which-header-mitigates-clickjack-k3f9qa`) when
you save. The suffix is not decoration: two questions worded identically
would otherwise land on the same id, and the second would overwrite the first
*and* inherit every answer already banked against it.

**An existing question's id never changes.** The edit form shows it,
read-only, and there is no way to alter it. That is deliberate rather than
merely conservative: the id is the field name in `ctf:quiz:questions` and
`ctf:quiz:key` **and** the reference every contestant's answer row is
recorded against, so changing it would orphan every answer already banked —
the points would stay on the leaderboard with no question behind them. If a
question needs a different id, delete it and add a new one, and read the
paragraph below first about what deletion does and doesn't take with it.

**Ordering is done by dragging.** The question list in `/admin` is sortable:
drag a row to where you want it, or use **Move up** / **Move down** from the
row's **⋯** menu (the keyboard-operable path — dragging is not the only way
in; **Delete** lives in the same menu, and opens the confirmation). The
stored `order` field is rewritten from the resulting positions and the moved
questions are saved immediately; contestants see the new order on their next
page load. There is no order number to type any more, and nothing to
renumber by hand.

**Deleting a question removes it from the quiz and hides it from
contestants — but points already banked for it remain on the leaderboard.**
Deletion drops the question and its answer key, nothing else: nobody can
answer it any more, and it disappears from every contestant's board, but the
contestants who already answered it correctly keep those points, and their
answer/attempt history for it is left alone. If you need those points gone
too, use the master reset (which clears all quiz progress at once, for
everyone). There is no way to un-award a single question. The delete button
is still gated behind typing a phrase to confirm, the same pattern the master
reset uses — deleting mid-event changes what contestants see, even though it
doesn't take points back. The phrase is now the question's **prompt** (cut at
a word boundary for a long one; the dialog shows exactly what to type, and
names the id alongside it). It used to be the id, which stopped being a
useful gate once ids were generated: transcribing
`which-header-mitigates-clickjack-k3f9qa` proves you can copy a string, not
that you read which question you were about to remove.

**Grading is all-or-nothing and order-insensitive**: a submission scores
points only if its set of selected choices exactly matches the correct set —
not a subset, not a superset. Picking three choices when two are correct
scores 0, the same as picking only one of two correct choices; that's still
one spent attempt, exactly like any other wrong answer. Single-choice
questions follow the identical rule — they simply have exactly one correct
choice, so "exact match" reduces to "picked the right one." There is no
partial credit for either question type.

**Retry gate** — two admin-panel knobs, next to the question list:

- **Max attempts** (`quizMaxAttempts`, default **3**) — graded attempts a
  contestant gets on one question before the retry gate refuses further
  submissions. `0` means unlimited. Both settings are global — there is no
  per-question override.
- **Retry after** (`quizRetryAfterMin`, default **5**) — minutes a
  contestant must wait after an attempt before trying that question again.
  `0` means no cooldown.

Both are enforced by a server-side Redis script, not just a JS-side
pre-check, so a burst of near-simultaneous submissions can't outrun the
attempt cap. The cooldown is computed from the last attempt's timestamp on
every check, never a stored unlock time — so lowering it mid-event lifts an
active cooldown immediately, and raising it applies to the very next check.
A wrong attempt spends one of the allotted attempts; once a question is
answered correctly it's done — no more attempts to spend, right or wrong.

Contestants can see the budget: each unanswered question carries a
`2 of 3 attempts left` chip next to its points badge, counted down from the
same attempts row the gate itself reads. The chip is absent when **Max
attempts** is `0` (nothing to ration) and once the question is answered.
Lowering the cap mid-event can leave a contestant holding more spent
attempts than the new cap allows; the chip floors at `0 of N` rather than
reporting a negative budget.

**Points and scoring.** A question's points are captured on the answer
record at the moment it's answered correctly, so re-pricing a question
later never changes what a contestant already earned — only a future
correct answer sees the new price. A team's quiz total dedupes by
question: if two teammates both answer the same question correctly, the
team's board still counts it once, the same rule already used for shared
flags. Quiz points show up as an addition on top of a contestant's or
team's other points, never folded silently into a single number with no
breakdown — see the architecture doc for how that addition happens.

**Quiz points get a contestant a leaderboard row on their own — a scored PR
is no longer required.** The board's login set is the union of whoever the
scoring backend reports and whoever holds quiz points, so someone who
answers a question before ever opening a PR (or on an event that has no
`secure-development` module at all) gets a row the moment they earn any quiz
points, not on their first scored submission. A team gets the same
treatment: a team with no per-flag data of its own (no members with a
scored PR yet) still shows its members' combined quiz total, deduped by
question. See [docs/architecture.md](architecture.md#leaderboard-with-no-scoring-backend)
for how the board is built when there's no scoring backend behind it at all.

**Bulk authoring: import and export the whole question bank as one file.**
Beyond the admin form's one-question-at-a-time editing, the Quiz tab's own
panel has an **Export questions** button and an **Import a bundle** box
(paste JSON, or choose a `.json` file) for authoring — or backing up — a
whole bank in one pass. This is the same bundle format the Jeopardy module
uses (see [ADR 36](decisions.md#adr-36-quiz-adopts-classics-bundle-format-rather-than-inventing-a-second-one)),
so the rules below will look familiar if you have imported a flag board. A
bundle is a single JSON object: a `version` and a `questions` array where
each entry has exactly the fields the admin form itself collects, correct
answers included. For example, a two-question bundle:

```json
{
  "version": 1,
  "questions": [
    {
      "id": "clickjacking-x7k2",
      "prompt": "Which HTTP header mitigates clickjacking?",
      "type": "single",
      "choices": [
        { "id": "a", "label": "X-Frame-Options" },
        { "id": "b", "label": "Content-Length" }
      ],
      "points": 10,
      "order": 0,
      "correct": ["a"]
    },
    {
      "id": "injection-q9pm",
      "prompt": "Which of these are injection risks?",
      "type": "multi",
      "choices": [
        { "id": "a", "label": "String-concatenated SQL" },
        { "id": "b", "label": "Parameterized queries" },
        { "id": "c", "label": "eval() on user input" }
      ],
      "points": 15,
      "order": 1,
      "correct": ["a", "c"]
    }
  ]
}
```

Every id in `correct` must be one of that question's own `choices`, a
`"single"` question must have exactly one correct answer, and no two choices
within a question may share an id. The whole file is validated in one pass
before anything is written: every row's problems are reported together, and
if the file has even one bad row, nothing is imported — there is no partial
write from a mostly-good file.

**Import is upsert by id, and it never deletes.** Each question in the file
is created if its id is new to the bank, or overwritten in place if that id
already exists — that is the entire rule. A question currently in the bank
but simply not mentioned in the file is left completely untouched. Worth
stating plainly because the natural assumption runs the other way: importing
a 10-question file into a bank that already has 15 does **not** shrink it to
10. There is no way to delete a question through import; use the admin
form's own Delete button for that, one at a time.

**Ids round-trip, so an export is a genuinely usable backup.** Re-importing
an unmodified export updates every question in place instead of duplicating
it. Because a contestant's answer history is keyed by question id, this also
means re-importing your own backup never detaches anyone's already-banked
points from the question that earned them.

**Max attempts and Retry after are not part of a bundle.** They are event
policy rather than content, and they are shared by every question, so
importing a question set never changes the retry gate you set on the tab —
in either direction. Set those two where they live, in the panel.

**The exported file contains every answer key in plaintext.** Export is the
quiz's entire answer sheet in one JSON file. Do not commit it to a public
repository, paste it into a public issue or chat, or otherwise share it
casually; treat it with the same care as `/admin` access itself.

**What the quiz doesn't do (yet):** free-text answers, partial credit, and
per-question attempt/cooldown overrides are all out of scope — the two
retry knobs are global settings, not per-question ones.

## Jeopardy

Switch Jeopardy on from `/admin` → Event → Modules and contestants get a
jeopardy-style flag board: a set of organizer-authored challenges, each
hiding a flag, graded the instant a contestant submits a matching string.
Like the quiz, it doesn't touch GitHub, the scorer, or `sync` at all — see
[docs/architecture.md](architecture.md#jeopardy-data-flow) for how it scores
entirely inside the app.

![The classic flag board: each card shows its point value and solve count, a case-sensitive badge where casing matters, and instant solved/not-quite feedback under the submission box](assets/flags.jpg)

<sup>The board as a contestant sees it: every card says what it's worth and how
many people have solved it, a badge marks the flags where casing matters, and
grading answers the instant you submit.</sup>

**Authoring** happens in `/admin`, under the Jeopardy module's tab (see
"Jeopardy controls" above). Before adding a challenge you need at least one
**category** — categories are a row of chips in the order contestants see
them (add; move a chip left or right, rename it, or remove it, with the
controls that appear when you hover or focus it), and a category can only be
removed while no challenge still files under it; the panel tells you exactly
how many challenges are blocking a removal.

**Renaming carries the challenges across.** A typo in a category ten
challenges already use is one edit, not eleven: the rename rewrites every
challenge filed under it as part of the same operation. Renaming to a name
another category already holds is refused rather than merged — merging two
categories is a different and lossier thing to ask for. Changing only the
capitalisation of the same category ("web" to "Web") is a rename, not a
clash. If a rename is interrupted part-way, run the same rename again: it
picks up from wherever it stopped, and no challenge vanishes from the panel
in the meantime. The challenge list is grouped under
those categories, each heading carrying its count. A challenge itself has a title, a
category (picked from that list), a Markdown description (a live preview
renders alongside the box as you type), a point value, and a flag.

![The Jeopardy module's admin tab: the module's title and blurb, the submission cooldown, the ordered categories as chips carrying move, rename and remove controls, and the challenge list grouped by category with drag-to-reorder, Edit, and a per-row menu for the rest](assets/admin-classic.jpg)

<sup>The whole module is authored here — categories, challenges, cooldown,
even the module's display name — live, with no rebuild.</sup>

**Flag matching forgives what should be forgiven.** Submissions are trimmed
and Unicode-normalised on both sides, and compared case-insensitively —
copy-paste from a terminal picks up trailing spaces, accents can be typed two
ways that look identical, and none of that is the skill being tested.

**Case-sensitive flags** are the one exception, per challenge, off by default.
Turn it on only when the capitalisation *is* the answer: a recovered password,
a base64 string, a case-sensitive hash. Trimming and Unicode normalisation
still apply — only the case-folding stops. Contestants see a **case-sensitive**
badge on the challenge card, so nobody loses a solve to a shift key without
being told; that the flag is case-sensitive gives away nothing about what it
says. A challenge authored before this existed, or left unticked, grades
exactly as it always did.

**A flag is stored in plaintext, and it is visible to anyone with `/admin`
access.** The flag input is masked by default (a Reveal toggle uncovers it,
in case you're screen-sharing the panel), but there is no hashing and no
one-way transform anywhere in the store beyond the case/whitespace
normalization grading itself uses (below) — an organizer opening a
challenge to fix a typo sees the flag exactly as it was typed. That is a
deliberate trade-off, not an oversight: withholding it would buy nothing
(anyone through the `/admin` gate can already rewrite or delete the flag
outright) while costing real correctness — an edit form that starts blank
turns every typo fix into a chance to silently redefine what counts as
solved. Treat `/admin` access itself as the actual secrecy boundary for
every flag on the board.

**You don't type a challenge id.** Adding a challenge mints one from its
title plus a short random suffix when you save, exactly like the quiz's
question ids, and for the same reason: it's the reference every contestant's
solve is recorded against, so on an existing challenge it never changes.
Delete and re-add if a challenge genuinely needs a new one, after reading
the deletion paragraph below.

**Ordering is done by dragging**, the same as the quiz's question list: drag
a row, or use Move up / Move down from its **⋯** menu, and the stored `order`
is rewritten from the resulting positions. The order is one sequence across
the whole board; within a category group the moves step past the group's own
neighbours, so a challenge never leaves its category by being moved.

**Deleting a challenge removes it from the board and hides it from
contestants — but points already banked for it remain on the leaderboard.**
Nobody can submit against a deleted challenge's id again, but the
contestants who already solved it keep those points, and their solve/attempt
history for it is left alone. Deletion is gated behind typing the
challenge's own title to confirm (falling back to its id for a
blank/whitespace-only title), the same pattern the quiz's delete and the
master reset use.

**Matching is whitespace-insensitive and — by default — case-insensitive,
normalized identically on both the authoring and submission sides.** The
stored flag is trimmed, then Unicode-NFC-normalized, then lowercased before
comparison — every submitted flag goes through the same normalization before
it's checked, so a stray leading/trailing space never costs a contestant a
solve, and neither does capitalization unless the challenge is marked
**case-sensitive** (see above), in which case only the case-folding stops.

**There is no cap on attempts — only a cooldown, and it is set in
SECONDS.** The **Submission cooldown (sec)** field (`classicCooldownSec`,
default **5**, capped at **3600** — one hour) is the only throttle: a
contestant can try a challenge as many times as they like, but must wait
that many seconds between submissions on the *same* challenge once they've
made one. Set it to `0` to remove the cooldown entirely. This is worth
calling out plainly because every other retry-gate setting on this platform
(the quiz's retry cooldown, the hint gate's unlock delay) is in **minutes**
— classic's own knob is not.

**Points are static.** A challenge's point value is fixed by whoever wrote
it and is read off the challenge record at the instant of a correct solve;
there is no decay as more people solve it and no first-blood bonus for being
first. Re-pricing a challenge afterward never changes what a contestant
already banked, the same rule the quiz follows.

**Team totals dedupe by challenge**, the same rule already used for the quiz
and for secure-development's shared flags: if two teammates both solve the
same challenge, the team's board counts it once, not twice. Jeopardy points
show up as an addition on top of a contestant's or team's other points,
using the exact same union-and-add mechanism the quiz does — see the
architecture doc for the details.

**A classic solve gets a contestant a leaderboard row on their own — a
scored PR is no longer required,** the same rule the quiz established: the
board's login set is the union of whoever the scoring backend reports and
whoever holds quiz or classic points, so a login with only classic points
(or an event running the `classic` module alone) still gets a row.

**The master reset clears classic progress, and demo mode seeds a classic
board** — both exactly as they do for the quiz; see the notes under
"Organizer admin panel" above. A rehearsal on the `classic` module resets
back to the challenges, flags, and categories you authored, which the reset
keeps.

**Bulk authoring: import and export the whole challenge set as one file.**
Beyond the admin form's one-challenge-at-a-time editing, the Jeopardy tab's
own panel has an **Export challenges** button and an **Import a bundle**
box (paste JSON, or choose a `.json` file) for authoring — or backing up —
many challenges in one pass. A bundle is a single JSON object: a
`categories` list, and a `challenges` array where each entry has exactly the
fields the admin form itself collects, flag included — plus the form's two
optional ones: `caseSensitive` (absent means false) and `hint` (absent means
no hint; as secret as `flag` itself). For example, a two-challenge,
two-category bundle:

```json
{
  "version": 1,
  "categories": ["Web", "Crypto"],
  "challenges": [
    {
      "id": "web-warmup-x7k2",
      "title": "Web Warmup",
      "category": "Web",
      "description": "Find the flag hidden in the page source.",
      "points": 100,
      "order": 0,
      "flag": "CTF{view_source_ftw}"
    },
    {
      "id": "crypto-basics-q9pm",
      "title": "Crypto Basics",
      "category": "Crypto",
      "description": "Decode the Base64 string to find the flag.",
      "points": 150,
      "order": 0,
      "flag": "CTF{base64_is_not_encryption}",
      "caseSensitive": true,
      "hint": "The padding character is a giveaway."
    }
  ]
}
```

Every challenge's `category` must appear in that same file's own
`categories` list — a bundle has to be self-contained, so importing it
never silently depends on categories the target event happens to already
have. The whole file is validated in one pass before anything is written:
every row's problems are reported together, and if the file has even one
bad row, nothing is imported — there's no partial write from a mostly-good
file.

**Import is upsert by id, and it never deletes.** Each challenge in the
file is created if its id is new to the board, or overwritten in place if
that id already exists — that is the entire rule. A challenge that's
currently on the board but simply isn't mentioned in the file is left
completely untouched. This is worth stating plainly because the natural
assumption runs the other way: importing a 10-challenge file into a board
that already has 15 does **not** shrink the board to 10 — the other 5 stay
exactly as they were. There is no way to delete a challenge through import;
use the admin form's own Delete button for that, one at a time.

**Ids round-trip, so an export is a genuinely usable backup.** Exporting
writes back the same ids the board already has, so re-importing an
unmodified export updates every challenge in place instead of duplicating
it. Because a contestant's solve history is keyed by challenge id, this
also means re-importing your own backup never detaches anyone's
already-banked points from the challenge that earned them.

**Categories are unioned, not replaced.** Importing a file appends any of
its categories that the board doesn't already have, in the order the file
lists them, after the categories already there — the existing order is
left exactly as it was. Importing a bundle can only grow the category
list, never reorder or drop anything from it.

**The exported file contains every flag in plaintext.** Export is the
event's entire answer key in one JSON file — every challenge's flag,
unmasked. Do not commit it to a public repository, paste it into a public
issue or chat, or otherwise share it casually; treat it with the same care
as `/admin` access itself, since a saved copy of the file protects nothing
on its own.

**Jeopardy has paid hints too** (#210, after the board itself shipped
without them): a challenge can carry an optional `hint`, sold through the
same paid-hint gate and knobs as secure-development targets — cost,
minimum solves, unlock delay, and the penalty fold all work identically.
See the hints section under [Organizer admin
panel](#organizer-admin-panel).

**What classic still doesn't do:** no file attachments — a challenge's
description is text only, with nowhere to attach an image, a capture file,
or a binary for contestants to download.

## AI

Switch AI on from `/admin` → Event → Modules and contestants get a third way
to earn points: prompt-injection and guardrail challenges hosted on an
**external** site, graded **inside** the box. Like the quiz and classic, it
doesn't touch GitHub, the scorer, or `sync` at all — see
[docs/architecture.md](architecture.md#ai-data-flow) for how it scores
entirely inside the app, and how a solve can arrive back three different
ways.

![The AI challenge board: category-grouped tiles with point values and paid-hint markers; each tile opens the challenge page with its personal launch link](assets/ai-board.jpg)

<sup>The board as a contestant sees it: every tile carries its category,
point value, and a 💡 marker where a paid hint is on offer, the same board
component classic's flag list uses.</sup>

### What the external site has to be configured to do

The box hosts none of the challenge itself. Somebody stands up a site, and
that site has to do four things — the admin panel's **Wiring the external
site** drawer says the same next to the values you paste, and
[docs/ai-module.md](ai-module.md) is the full contract:

1. **Accept the launch token.** A challenge's launch URL must contain the
   literal `{token}` placeholder; the box substitutes a freshly minted token
   there and sends the contestant to the result. No cookie crosses the
   boundary — that token is the whole identity.
2. **Verify it against the published public key.** `GET /api/ai/launch-key`,
   verify with **hard-coded** Ed25519, and pin `aud` to the challenge id you
   expect. Never let the token's own `alg` or `kid` choose the algorithm or
   the key. Cache the key for about five minutes (it is served
   `Cache-Control: public, max-age=300`), but **re-fetch on any verification
   failure and after an event reset** — a master reset rotates the keypair,
   and a site caching the old key indefinitely rejects every launch token
   issued afterwards.
3. **Report the solve, signed.** For an `event` or `both` challenge, POST
   `/api/ai/event` with `X-CTF-Signature: sha256=<hex>` over the exact bytes
   `"<unix-timestamp>.<raw request body>"`, using **that challenge's own**
   signing key, plus a matching `X-CTF-Timestamp` within ±300 seconds of the
   box's clock. Re-serializing the body before signing is the most expensive
   mistake available here — it fails exactly like a wrong key would.
4. **Expect one award per token.** The token's `jti` is a one-shot nonce; a
   replay answers `409`, not a second award.

<img src="assets/diagrams/ai-launch-token-flow.svg" alt="Animated diagram. The handshake between the box and an external AI challenge site, and which key does what. The box mints an Ed25519 JWT scoped to one challenge (sub is the player's login, aud is the challenge id, 24-hour expiry, jti as the replay nonce) and substitutes it into the challenge's launch URL wherever the operator wrote the {token} placeholder. The contestant opens that link on the external site, which fetches the module-wide public key from /api/ai/launch-key and caches it for about five minutes, re-fetching on any verification failure, then verifies with hard-coded Ed25519, never trusting the token's own alg or kid, pinning aud to the challenge it expects. The site re-reads GET /api/ai/state rather than trusting the token's mint-time progress snapshot. On a solve it POSTs /api/ai/event with the token and challenge id, signed with that challenge's own secret HMAC key over the exact string timestamp-dot-raw-body. The box checks the signature within 300 seconds, then the token, then claims the jti exactly once, so a replay gets 409, and the shared atomic award script banks the points. The launch key is public, one per event, and fetched; the signing key is secret, one per challenge, and pasted in from the admin panel.">

<sup>The two keys are not interchangeable, and conflating them is the usual
wiring failure. The <strong>launch key</strong> is public, one per event, and
you fetch it to <em>verify</em>. The <strong>signing key</strong> is secret,
one per challenge, and you paste it in to <em>sign</em>. A leaked launch key
costs nothing — it is public by design; a leaked signing key lets anyone
assert solves for that one challenge, so rotate it.</sup>

**Nothing is live until you have proved it.** The panel's **Send test**
signs a demo event with the challenge's real key and runs the whole pipeline
with `dryRun: true` — writing no solve and claiming no nonce — then relays
the box's own verdict. **Would award** is the answer you want; every other
verdict is read in the Send test list further down this section.

**Authoring** happens in `/admin`, under the AI module's tab. Before adding
a challenge you need at least one **category** — same chip row as classic's
(add, move left or right, rename, and remove only while no challenge still
files under it, the panel naming exactly how many are blocking a removal),
capped at
**50 categories** with names of at most **64
characters** each (`AI_CATEGORIES_MAX`/`AI_CATEGORY_MAX_LEN`, enforced in
`setAiCategories`).


**Renaming behaves exactly as it does on Jeopardy**, and for the same reasons:
the rename rewrites every AI challenge filed under that category in the same
operation, so a typo ten challenges share is one edit rather than eleven.
Renaming onto a name another category already holds is **refused, not merged**
— including when the two differ only in capitalisation, since two casings would
split one category across two headings on the board. Changing only the
capitalisation of the category being renamed ("jailbreak" to "Jailbreak") is a
rename and is allowed. If a rename is interrupted part-way, **run the same
rename again**: the challenges move before the list is rewritten, so a repeat
finishes from wherever it stopped, and no challenge disappears from the panel
in the meantime.

A challenge itself has a title, a category, a Markdown description (live
preview alongside the box, same as classic's), a point value, and one more
thing neither sibling module has: a **solve mode**, a tri-state that decides
what a contestant sees and where a solve can come from:

- **`flag`** — graded by a typed flag, exactly like classic: the shared
  flag-submission form renders on `/ai/[id]` and nothing outside the box
  can assert a solve.
- **`event`** — launcher-only. No in-box form renders at all; the
  challenge stores no flag (an event-mode upsert deletes both flag hashes
  regardless of what the form last held), and the external site reports the
  solve itself, signed, to the module's own event endpoint. **This mode has
  no in-box fallback**: a signed event is the *only* way it can ever be
  awarded, `/api/ai/submit` answers `409 wrong-mode` for it, and a
  contestant has nothing to type. So an event-mode challenge whose external
  backend is missing, unreachable, or not yet posting events is unsolvable
  by anyone — which is the intended design (the arena is what judges a
  "make the model misbehave" objective, and a copyable flag would defeat it
  the first time one contestant shared the string), but it does mean the
  external half has to actually exist before the board goes live. Note that
  the per-challenge **Send test** button does not establish that: it signs
  the demo event *in-process with the box's own copy of the signing key*, so
  it proves this side is configured (mode, schedule, key present) and proves
  nothing about whether the external backend is reachable or holds the same
  key. The only check that covers the external half is a real signed POST
  from that backend — have the integrator send one with `dryRun: true`,
  which returns a verdict without claiming the token's nonce or awarding
  points.
- **`both`** — either path works: the in-box form for a typed flag, or the
  external site's signed report.

Every graded challenge also needs a **launch URL template** — the address of
the externally hosted challenge, which the launcher substitutes a freshly
minted token into. It must be an absolute `https://` URL (`http://` is
accepted only for `localhost`/`127.0.0.1`), and it must contain the literal
`{token}` placeholder somewhere in it — checked against the raw string, not
a parsed URL, so a template that puts the placeholder inside a path segment
isn't punished for looking like invalid syntax. `validateUrlTemplate`
(`ai-keys.ts`) is the **one** implementation of that check, run identically
on the admin form (as-you-type feedback) and again inside the store on
submit (`upsertAiChallenge`) — the client-side check is a convenience only,
never a substitute for the server's own.

**Flag and case sensitivity** work exactly like classic's, because they
share the same code: `ai-keys.ts` re-exports `normalizeFlag` and
`caseSensitiveFlagForm` from `classic-keys.ts` directly rather than
reimplementing them, so a flag is trimmed and Unicode-NFC-normalized on both
the authoring and submission sides, and case-folded unless the challenge's
own **case-sensitive** toggle is on. Both the flag field and the
case-sensitivity toggle are hidden by the form entirely in `event` mode —
there's no flag left to apply either one to. The flag input masks by
default (a Reveal toggle uncovers it), the same screen-share consideration
as classic's.

**Hint text** is optional and works like classic's paid hints — sold
through the same gate and knobs (cost, minimum solves, unlock delay, penalty
fold; see the hints section under [Organizer admin
panel](#organizer-admin-panel)) — with one save-time rule worth calling
out: saving the field **empty is a deliberate clear**, not "leave
unchanged" — the store deletes the hint row on an empty string, exactly
like classic.

**Position ordering is a plain editable number**, not drag-and-drop. Unlike
quiz's and classic's question/challenge lists, this panel has no
reorder-by-dragging UI — organizers curate a long-running board there;
nothing about this task called for the same parity here, so `order` is just
another field the form edits directly.

**The integration panel** is what an external challenge actually wires up
against. It comes in two parts. The **Endpoints** block sits once, above the
challenge list — **three endpoint URLs**, Submit (`/api/ai/submit`), Event
(`/api/ai/event`), and State (`/api/ai/state`), each with its own copy
button so an integrator never has to hand-assemble the full origin, and each
with a collapsed **demo** under it answering send / receive / expect: a
runnable request (the Event one computes its own signature at run time, for
the same reason the per-challenge curl does), the 200 it returns, and the
handful of refusals worth designing for — a wrong flag, a cooldown, a
`replay`, an `invalid-signature`. State is marked **read-only**, because it
is the one route of the three that writes nothing and can be tried against a
live event with no consequence. Every value in those demos is a placeholder
(`aik_…`, `eyJ…`); the real signing key and the one-click dry run stay on
the per-challenge row below. The full contract, including the complete error
table, is [docs/ai-module.md](ai-module.md). The three URLs are
the same for every challenge, which is why they are not repeated per row. The
rest is **per challenge**, collapsed under each row's summary line (open it
with the "Integration — signing key, test curl, Send test" disclosure; a
flag-only row's disclosure says the panel is not needed for it), and
carries:

- **The per-challenge signing key**, masked by default (`aik_…`) with a
  Reveal toggle and its own Copy button — the raw key is never referenced in
  the rendered markup while masked, not merely styled to look hidden.
- **Rotate**, behind a confirm dialog, because it takes effect immediately
  with no grace window. Its consequence sentence, verbatim: "The external
  system stops posting until you redeploy it with the new key." It is amber,
  not red — rotating is recoverable by pasting the new key into the external
  site; red in the panel is reserved for what cannot be undone (deletes, the
  master reset). A Send test that comes back **solved** or **would-award** is
  shown in green; only a refusal or a failure is red.
- **A ready-to-run test curl** that computes its own HMAC signature at the
  moment you run it (`TS=$(date +%s)` and an `openssl dgst -hmac` call
  inline) rather than shipping a pre-signed one — a signature is only valid
  for a few minutes either side of its timestamp, so a static, pre-signed
  snippet would already be expired by the time anyone pasted it.
- **A Send test button.** This does not hit the network from the browser to
  the external side and back — it POSTs to `/api/admin/ai/test`, which
  mints a short-lived demo launch token for the *organizer's own login*,
  signs a demo solve event with the challenge's real signing key, and calls
  the real `/api/ai/event` handler in-process with `dryRun: true` —
  hard-coded server-side, never taken from the request — so nothing is
  written: no nonce is claimed, no points are awarded. It is safe to click
  against a live event, and it relays that handler's real verdict verbatim
  rather than inventing one. The panel renders exactly one of two lines
  under the button: a green **Would award — the dry run verified end to
  end.** for the good case, or a red **Test result: `<name>`** for anything
  else, where `<name>` is the verdict or error string the route handed back
  (or `unavailable` when it handed back nothing readable — a 503, or the
  request itself failing). The panel now prints a one-sentence explanation
  under that name for every verdict listed below, so the table here is a
  reference rather than something to look up mid-event. Reading the result:
  - **`would-award`** (shown as the green line) — good: the dry run
    verified the whole pipeline end
    to end (signature, token, rate limit, team, schedule).
  - **`paused`**, **`solved`**, **`no-team`** — the signature and token
    were fine and a gate refused the award, relayed as-is: scoring is frozen
    or outside its scheduled window (the dry run honours the schedule like a
    real event), the organizer's own login already holds this challenge, or
    the organizer is on no team (the event route refuses a teamless login
    before the award, organizers included). None of these is a fault on the
    external side.
  - **`unavailable`** — Redis could not be read, or the request itself
    failed; try again.
  - **`wrong-mode`** — this challenge is `flag`-only. The panel doesn't
    even render the signing key, curl, or Send test for a flag-only
    challenge in the first place (only the three endpoint URLs stay,
    since an external site embedding one still needs them); seeing
    `wrong-mode` at all means the challenge's mode changed after the panel
    loaded — refresh and re-check.
  - **`no-signing-key`** — a legacy row with no signing key ever minted.
    Unlike the two above, this one never reaches the event handler: the test
    route itself answers `400 {"error":"no-signing-key"}` before any dry run,
    and the panel shows it as **Test result: no-signing-key**. Click Rotate
    once to mint one.

**The cooldown knob** — `aiCooldownSec`, on the AI tab — throttles only the
**graded flag path**: a signed event has no wrong answer to rate-limit, so
it is never subject to this cooldown. `null` (the field left blank) means
the **5-second default**; set a value in `[0, 3600]` seconds to override it,
the same bounds classic's own cooldown enforces.

**What contestants see:** the board (`/ai`) lists every challenge with its
category, points, and a 💡 marker where a hint is on offer. Opening one
(`/ai/[id]`) mints that contestant a **personal, one-click launch link** —
the page says so plainly: "This link is yours — it signs you in on the
challenge site." That is worth repeating to contestants directly: the link
carries a token naming *them* as the player, so sharing it hands away the
ability to submit as them on that challenge, exactly like sharing a
password would. A `flag`/`both` challenge also renders the same in-box
flag-submission form classic uses, right below the launcher.

**Gaps**, stated honestly:

- **No per-tab bulk import/export.** Unlike quiz and classic, the AI tab has
  no Export/Import bundle button of its own — every challenge is authored one
  at a time through the add/edit/delete form. The whole-event archive on the
  Event tab does carry the AI catalogue (challenges, flags, hints, categories
  and per-challenge signing keys; never the launch keypair), so moving an AI
  board between boxes or restoring one after a wipe goes through the archive.
- **A master reset rotates the module-wide launch keypair**, not any
  individual challenge's signing key. Every previously issued launch token
  stops verifying, and any external integration that cached the public key
  from `GET /api/ai/launch-key` needs to re-fetch it — see
  [docs/ai-module.md](ai-module.md)'s "Keys and rotation" section (§9) for
  what an integrator should watch for.

## Verifying it works

### The box, from outside: `/health` and `/health/deep`

Two URLs answer the two questions an organizer asks before doors open, from
any browser or phone, no login:

- `https://<EVENT_URL>/health` — is the app up, and is it the build you just
  deployed? Compare `revision` to the commit you expect.
- `https://<EVENT_URL>/health/deep` — can it score? `200` with every
  dependency `"ok"` is the answer you want; `503` names which of `redis` or
  `scorer` is `"down"`. `sync.ageSec` is how long since the poller last
  polled — if that number keeps growing while Secure Development is live,
  score comments are piling up on GitHub and the leaderboard is not moving.

### The box under load: `scripts/load-test.sh`

Before content authoring, not after — the harness seeds synthetic contestants
and a master reset is already on the plan between the two. It runs
`scripts/load-seed.mjs` **inside the Fly machine's `app` container** (srh is on
the private network; the container already holds the URL and token the app
writes through) to create N `load-XXXX` contestants (N at least 2) on teams
of 2–4 with a
realistic spread of Secure Development, quiz and flag solves attached to the
catalogue the box already has; then drives `/leaderboard` at 10 req/s and
`?display=1` at 2 req/s with autocannon while sampling machine memory, and
writes one Markdown report. Ownership is a **manifest, not a name**:
`load-0001` is a legal GitHub login and nothing reserves it, so the seed
records every key and every shared-hash field it writes in a manifest
(`ctf:load-seed:manifest` plus two sets of keys and fields, each batch adding
only its own delta, so a large seed stays linear), and refuses to run if any
of them already exists
and is not in its previous manifest (a real contestant may own that login).
The check and the write are one Redis-side script per batch, so a
contestant registering such a login *between* the two cannot be written
over — there is no between. A collision aborts *that batch* before it writes
anything; batches before it are already committed and recorded in the
manifest (marked incomplete), so the seed can be partial and the next seed
refuses to run until `--clean` has removed it. Still, run the harness before
registration opens (or with it closed): a contestant who registers
`load-0042` *after* the seed would be sharing rows the next `--clean`
removes.
The manifest is written incrementally — each batch of writes ends by
recording what has landed so far — so a seed that dies half-way leaves a
manifest naming exactly the rows it wrote, marked incomplete, and the next
seed refuses to run until `--clean` has removed them. `--clean` needs no
`--count`: it deletes exactly the manifest's entries and the manifest — so a
challenge removed or a module switched off after seeding cannot strand a
row, and nothing absent from the manifest is ever targeted. What *is*
listed is deleted whole, later writes included: that is the
`load-0042`-registers-after-the-seed case above, and the reason to run the
harness before registration opens. One seed or clean runs at a time — both
hold a Redis lock (`ctf:load-seed:lock`) for the whole operation, so a clean
cannot race a seed and orphan its rows; a run that finds the lock held
refuses and prints who has held it since when. The lock never expires by
itself: after a crashed run, `scripts/load-test.sh --app owasp-ctf
--break-lock` clears it once you are sure nothing is running (the seeder is
not in the app image — the script uploads it the same way a run does, then
calls its `--break-lock`, which refuses if the lock changed hands meanwhile).

```sh
scripts/load-test.sh --app owasp-ctf --url https://ctf.dcotelo.dev --count 200
scripts/load-test.sh --app owasp-ctf --clean
```

Pass bar for a ~100-player event, on the percentile autocannon reports
(p97.5 — it has no p95, so the bar is the stricter one): `/leaderboard` p97.5
under 1.5 s at 10 req/s, `?display=1` under 1 s, zero 5xx, zero connection
errors and zero timeouts (both are columns in the report; any of them fails
the run outright, because a request that never got an answer is not a
latency measurement), machine memory under 80 %. The script applies that bar
at exit: it returns 0 only when the run was valid *and* every criterion was
met, 1 when the run could not be trusted or the bar was missed (each miss is
named on stderr as `BAR MISSED: …`), 2 on a usage error — so a run inside a
shell loop or CI cannot pass by accident. The report carries every number
either way. A miss on memory means `fly scale vm`; a miss on `/leaderboard`
alone means the page's own cost is the problem (see #434, #444, #446).
`/api/admin/metrics` needs an admin session the script deliberately does not
carry (a cookie in a command line is readable by every local user) — time it
from a logged-in tab.

Fail directions: the **seed fails closed** — a settings hash whose module
list it cannot parse, or Secure Development live with no `LEADERBOARD_API_URL`
in the container, or a key or field it is about to write that already exists
outside its own manifest, aborts before a single write, because a seed that
guessed would attach points to a board that does not show them or write over
a contestant. A quiz or classic row the seeder cannot read, or a scorer answer without a
`challenges` list, is the same refusal — never a partial seed. The report's directory is
created and its path checked writable *before* the seed, so a run that could
not write its report never leaves rows behind. The **run
fails** if a setup step failed (finding the machine, uploading the seeder) or
the seed did not report success (the report then says so and nothing is
driven), if a phase failed to run or left no parseable result
(autocannon missing, a DNS failure — ordinary 5xx responses are counted in
the table, not this), or if the memory sampler produced no sample; in every
case the report is still written and says so, naming only the phase and its exit status (autocannon's own
error text can echo the target URL, so it stays out of the report). `--clean`
deletes the data first and the manifest only once every deletion succeeded,
so an interrupted clean can always be re-run. The seeder's own error line
is a redacted label — never the token or a URL. Not seeded on purpose:
`ctf:classic:solvecount` — a shared per-challenge counter that real solves
raise; the harness omits it because an exact clean could not lower it back
safely — and hint purchases.

Before an event, four checks in this order: `FLY_AUTO_STOP=off` is set and
deployed (an idle-suspended machine takes Redis and the poller down with it);
`/health/deep` is 200; the external monitor described in
[docs/hosting.md](hosting.md#monitoring) is enabled and posting to the
organizers' channel; the Cloudflare rate-limiting rule on `/api/*` described
in [docs/hosting.md](hosting.md#cloudflare-in-front-of-the-box) is present
and enabled (the zone's Security rules page lists it; to prove it, first
`GET` a deliberately nonexistent path such as `/api/rate-probe` once and see
the normal 404, then burst the same `GET` about 130 times in a few seconds
from one address — it answers `429` after about a hundred. Use only a
nonexistent `GET` path, never a `POST` to a submit, answer, hint or gate
route, which would spend real cooldowns and attempt caps). See
[docs/troubleshooting.md](troubleshooting.md) for what a 503 means and what
to do.

### The org and the bootstrap keys: `ctf-setup.sh doctor`

Read-only, no `--dry-run` needed, and the first thing to run when something
looks wrong. Alongside the per-fork provisioning matrix (see
[docs/hosting.md](hosting.md#fork-setup-and-the-contest-flow)) it checks
three facts that have no other alarm:

- **`ADMIN_LOGINS` is non-empty.** Empty means `/admin` forbids every login,
  which is silent until an organizer tries to open the panel mid-event.
- **`GITHUB_ORG` is set.** `doctor` takes no separate org argument —
  `GITHUB_ORG` *is* the org it inspects, so there is no second value for it
  to disagree with; what it catches is the key being absent. With Secure
  Development off (no `SCORE_IMAGE`) that is only a warning: an app-only
  event has no org.
- **The `sync` GitHub App is installed on the org.** Without it the poller
  authenticates against nothing and no score ever reaches the leaderboard.
  Checked by App id against the org's installations, and it **fails closed**:
  a `gh` error (a token without `admin:org`, say) reports "not verified" and a
  non-zero exit, never "installed".

### Which build is live: `GET /health`

Public, unauthenticated, and the fastest way to answer "did my fix reach the
box?":

```console
$ curl -s https://ctf.example.org/health
{"status":"ok","version":"0.4.0","revision":"d3399e9abcde","builtAt":"2026-09-07T02:01:49.000Z"}
```

| Field | Means |
|---|---|
| `status` | Always `ok` when the app answers at all. **Liveness only** — it does *not* check Redis, GitHub or the scorer, so a 200 here means the Node process is serving requests and nothing more. Dependency status is on the admin **Overview**, behind the organizer gate. |
| `version` | The repo tag this build was cut from. Only moves on a release, so it cannot tell you whether a deploy happened. |
| `revision` | The commit the image was built from. **This is the field that answers whether a deploy landed.** |
| `builtAt` | When the image was built. Distinguishes two deploys of the same commit — a redeploy after a config or secret change rebuilds the image without moving the sha. |

`revision` and `builtAt` are baked at build time from `APP_BUILD_REV` and
`APP_BUILT_AT` (Docker build args). `deploy/fly/deploy.sh` and
`scripts/dev-stack` fill them in; a build that passes neither reports
`"unknown"` and `null` rather than failing. `deploy.sh` deliberately reports
`unknown` when the working tree is dirty, because the sha would not describe
the image it built.

Watching for a deploy to land:

```sh
until curl -s https://ctf.example.org/health | grep -q '"revision":"abc1234'; do sleep 15; done
```

The payload is world-readable by design: on an open-source kit the commit sha
and the release tag are already public. Nothing else belongs in it — see the
comment at the top of `apps/web/src/app/health/route.ts` for the list of
things deliberately kept out, and the test that pins the field set.

### The offline gates

No GitHub org, Action runs, or scorer image access needed to check the kit
itself:

```sh
./scripts/smoke.sh
```

This brings the full poll pipeline up against fixture GitHub comments and a
mock scorer, then asserts: Redis and the Upstash-compatible REST proxy work,
`sync` ingests fixture score comments, scores match the fixtures, a forged
comment from an untrusted author is dropped, and unauthenticated `POST /score`
is rejected. It is what CI runs, and the fastest way to sanity-check a change
to `sync`, the compose stack, or the setup script.

The scorer engine has two more gates of its own:

```sh
./scripts/acceptance-scorer.sh                                   # declarative probe path
./scripts/acceptance-target.sh vampi erev0s/vampi@sha256:0a5a224b6e14ae7da6a6ea265178ff71286ff903aec74adee98f660bb0e4ca12  # a real target, end to end
```

`acceptance-scorer.sh` closes the judge → PR-comment marker → leaderboard loop
against a fake target app: it POSTs the marker the judge wrote the way `sync`
does, and asserts the leaderboard then shows rubric-derived points. It also
runs the judge twice, once with `SCORE_API`/`SCORE_TOKEN` set and once with
neither, and requires the two reports to be byte-identical — that environment
is dead since push ingest was removed
([#377](https://github.com/dcotelo/owasp-ctf/issues/377)), and this is the
assertion that keeps it dead.
`acceptance-target.sh` is the **stock-scores-zero gate**: it boots the real,
unpatched upstream image and asserts every challenge fails against it. Any
challenge that passes there asserts the exploit rather than the fix, and the
gate fails the build rather than handing every contestant a free point. The
full testing strategy is in
[docs/architecture.md](architecture.md#testing-strategy).

## Local dev-stack

Want to click through the actual contestant experience — leaderboard,
challenge browsing, teams, a score landing on the board — without a GitHub
org, an OAuth app, or a real contestant PR? One command:

```sh
./scripts/dev-stack up
```

This generates a throwaway `.env.dev-stack` if you have no `.env` (never
touches or overwrites a real one), builds the scorer image locally from
`scorer/` and the app image from `apps/web/`, brings up `redis`,
`srh`, `scorer`, `app` and `caddy`, and seeds a few demo players onto the
leaderboard through the scorer's real bearer-authed `POST /score` — the same
endpoint a scored PR hits, so it exercises the real validation and Redis-write
path rather than poking Redis keys directly. It prints the URL to open when
it's done.

It needs no config file — there is no such thing any more (#386). The two
identities it has to know, `ADMIN_LOGINS` and `GITHUB_ORG`, come from your
environment if you exported them, else from `.env`, and `ADMIN_LOGINS` falls
back to whatever login `gh` is authenticated as; each is read at start-up, so
changing one means a restart, not a rebuild. Everything else — the event's
name, which modules run, which Secure Development targets — is an `/admin`
setting.

Watch a new score land live, without a real PR:

```sh
./scripts/dev-stack score <login> <juice-shop|dvwa> <n>   # marks the first <n> catalogue challenges solved
./scripts/dev-stack score alice-dev juice-shop 3
./scripts/dev-stack score carol-dev dvwa 2
```

Those are the only two targets the script knows — it seeds a curated slice
of each one's rubric catalogue, and refuses any other target name.

Tear down with `./scripts/dev-stack down` (keeps seeded data in the Redis
volume for next time) or `./scripts/dev-stack down --wipe` (also drops it).

**What this does not do:** sign you in. `/admin` needs a real session whose
GitHub login is in `ADMIN_LOGINS`, which needs a real GitHub OAuth app —
there is no local bypass for that boundary, and the script does not add one.
`dev-stack up` tells you exactly what to add: an OAuth app's client
id/secret and your login in `ADMIN_LOGINS`, written to `.env` when you have
one or to the generated `.env.dev-stack` otherwise. Edit that file, then run
`./scripts/dev-stack down && ./scripts/dev-stack up` to apply it — a restart,
not a rebuild, since `ADMIN_LOGINS` and the OAuth settings are read at start.

## Known limitations

**The pre-event gate's page block (`proxy.ts`) is page-only.** With
`CHALLENGES_GATE_ENABLED=true` and `CHALLENGES_GATE_PASSWORD` set in `.env`
(compose passes both through to the app), every enabled module's own page
route (`/challenges`, `/quiz`, `/flags`, `/ai`) redirects a visitor without a
valid unlock cookie to `/gate`. That list is exact-match and it is *pages* —
the gate deliberately does not widen over `/api/*`. (The proxy's matcher
does carry `/api/:path*`, but only for the cross-origin write assertion;
gating the APIs would put the gate in front of `/api/auth/*`, breaking the
sign-in a contestant needs in order to pass the gate, and in front of
`/api/gate` itself, and would answer API calls with a page redirect an API
client can't act on.) `/ai/[id]` — the one route that mints a launch token —
is deliberately **not** in that exact-match list: it enforces the gate
itself, at mint time, rather than inheriting it from the middleware (see
below).

Instead, the three module routes that bank points or leak challenge content
— `POST /api/quiz/answer`, `POST /api/classic/submit`, and
`POST /api/hints/reveal` — run their own server-side gate check
(`requireGatePassed()`) beside their other rules, and refuse with
**403 `{ error: "gate" }`** while the lock screen is up. The ai module reaches
the same guarantee a different way: its two cross-origin routes,
`POST /api/ai/submit` and `POST /api/ai/event`, are cookie-blind by design
and read no gate at all — the gate is enforced exactly once, at token-mint
time, when `/ai/[id]` renders (and re-checked, redundantly, in that same
page's in-box Server Action, `submitAiFlagAction` in `[id]/actions.ts`). A
launch token in hand already proves the gate had passed when it was minted,
so the routes that redeem that token don't re-check it themselves.
Everything else the API routes already enforced independently still holds
regardless: the session-backed routes (quiz answer, classic submit, hints
reveal) still require a session — the ai module's own cross-origin routes
authenticate differently, as just described (`/api/ai/submit` by launch
token alone, `/api/ai/event` by launch token plus the per-challenge HMAC,
neither reading a session) — and the admin **pause** and the **scheduled
scoring window** are checked on every write, and per-question attempt caps
and cooldowns (or classic's/ai's own submission cooldown) apply. So an
organizer who additionally sets the scoring window (or keeps the event
paused) is not exposed even if they somehow rely on the password gate alone
— the schedule/pause pair in the admin panel (see [Organizer admin
panel](#organizer-admin-panel)) is still the control that actually stops
early scoring.

Read the gate for what it is: a "the board opens at the keynote" curtain over
the contestant-facing pages and the handful of API routes that bank points or
leak content, and a way to keep the challenge list unpublished until the
event starts. It is **not** an authorization boundary — every API route
(gated or not) still enforces its own rules independently, including
`/api/admin/*` (organizers must be able to configure the event before
kickoff) and `/api/team/*` (registration has its own separate window and is
meant to be open pre-event). If you need scoring genuinely shut until a
moment in time, set the scoring window (or keep the event paused) as well as
— or instead of — the password gate.

## Status and upstream dependencies

The kit is complete, tested offline and running live: `scripts/smoke.sh`
exercises the whole poll pipeline, `sync` has unit tests for parsing, cursors
and idempotency, every target's rubric is gated against its stock image, and a
hosted instance runs continuously from the same Compose file this repo ships,
with `GET /health` reporting the revision serving it. The full live-GitHub
scoring path now **ships in-kit** — the two changes this section used to wait
on from other OWASP-CTF repos landed here instead:

1. **Scorer bearer auth** — the in-repo engine's `POST /score` requires
   `Authorization: Bearer <token>` (`scorer/src/serve.js`), checked
   constant-time, and the scorer refuses to boot without a token — so `sync`
   authenticates to the one writer without an OIDC provider.
2. **The scoring workflow** — the kit's own
   `scorer/consumer-workflow.example.yml` replaces the upstream
   `score-action`: it always posts the machine-readable result comment
   (pass/fail and points only, no exploit detail) and reads the judge's report
   only from `CTF_OUT_DIR` and only when the scorer step succeeded. It needs no
   org secrets of its own — the comment is the transport, so there is nothing
   for it to authenticate to.

What none of that bounds: **no real event has yet driven real contestant PRs
through real GitHub end to end**, and nothing here has been exercised at the
concurrency of a full cohort. A live instance catches what mocks cannot — an
end-to-end pass over one is where a batch of real defects were found, several
of them invisible to a green CI run — but one operator clicking through a
deployed box is not forty contestants pushing at once. Until an event has run,
treat `scripts/smoke.sh` as the source of truth that the pipeline works, and
the live box as evidence that it works when deployed.

Known limits, in the open:

- **Security Shepherd result matching** carried a real under-crediting bug:
  the vendored helper read an echoed 32-hex user id out of a refusal page and
  called it a result key, so a correct patch scored ❌ on 29 of the target's
  40 challenges. That is fixed in the vendored copy (#101) — a bare key must
  now be 64–128 hex, and real keys match with their surrounding context. The
  stated residual (see the matcher's own comment in
  `scorer/rubric.owasp/securityshepherd/tests/helpers.js`): a refusal phrased
  "isn't correct" or "never correct" — rather than "not correct" — would
  still read as a solve. The bias runs the same safe direction as before:
  it can under-credit a correct patch, never award a free point.
- **srh subset** — `srh` (`hiett/serverless-redis-http`), the
  Upstash-compatible REST proxy in front of Redis, implements only a subset
  of Upstash's REST API (no path-style `GET /get/<key>` shortcut, for
  example). The app is wired to it today for real team-membership and
  hint-purchase data. That the app's Redis client stays inside that subset
  is no longer unverified: `apps/web/src/lib/upstash.ts` exposes exactly two
  entry points, `upstashPipeline` and `upstashEval`, and the seven
  `*.upstash.test.ts` suites drive both against a real Redis behind `srh` in
  the `app` CI job — with `CTF_LUA_SUITES_REQUIRED=1` turning a skip into a
  failure, so pipelining and `EVAL` are exercised end to end on every run.
