---
title: Module contract
---

[← Docs home](index.md)

# Module contract

**For module authors.** Read this for the contract a new vertical must
satisfy; read [scorer.md](scorer.md) for authoring rubrics inside the
existing `secure-development` module (the far more common task); read
[architecture.md](architecture.md)'s quiz/classic data flows for a worked
example of an app-side module end to end.

A **module** is a CTF vertical — a family of challenges with its own targets,
scoring logic, and provisioning steps — plugged into the OWASP CTF
platform (event config, sync/scorer pipeline, `ctf-setup`, leaderboard). v1
ships four playable registered modules: `secure-development` (the OWASP Secure
Development CTF patch-the-vulnerability format: fork target app, find + patch
the vuln, PR back, GitHub Actions scores the patch), `quiz` (a self-paced
single/multi-select question bank, authored in `/admin` and scored entirely
inside the app — no GitHub, `sync`, or `scorer` involvement at all), `classic`
(a jeopardy-style flag board: organizer-authored challenges, each
hiding a flag, graded the instant a contestant submits a matching string —
scored entirely inside the app exactly like `quiz`, with no GitHub/`sync`/
`scorer` involvement either; §5 covers what its UI contract satisfies and
what it still doesn't, for both app-side modules), and `ai` (externally
hosted AI/LLM challenges: an organizer authors each challenge in `/admin` —
mode flag/event/both, the external launch URL, categories, an optional paid
hint, a submission cooldown — and a contestant plays it on the external site
or types a flag back on `/ai/[id]`; see
[docs/ai-module.md](ai-module.md) for the external integrator's side of the
contract). This document is
the contract a new
module (forensics, api-security, cloud, …) must satisfy to plug in, with
`secure-development` as the worked example throughout, since it is the one
module that actually exercises the GitHub-mediated scoring contract (§2–3,
§6–8) that `quiz` and `classic` deliberately bypass.

There is no event configuration file. The platform's own bootstrap facts
(`GITHUB_ORG`, `ADMIN_LOGINS`, `SCORE_IMAGE`, `EVENT_URL`) live in `.env`, and
everything an organizer changes — which modules run, what a module's content
is, hints, teams — lives in the `ctf:admin:settings` hash behind `/admin`
([ADR 55](decisions.md#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml)).
A module therefore has no config-file namespace of its own to claim; what it
needs from an organizer it asks for in the panel. For the
higher-level split of what the control plane owns versus what a module
supplies, see the [platform-and-modules table](architecture.md#platform-and-modules);
the sections below are the enforceable contract behind it.

## Section 1. Module identity & registration

1. MUST be registered as a `ModuleId` in `apps/web/src/lib/modules.ts` — the
   union and the registry beside it are the whole list of module ids the
   platform knows. That registration is what makes an id valid platform-wide,
   and it is the only place an id is declared: **there is no config-file
   namespace** a module can appear under, no `modules:` map, and no `enabled:`
   key for a module to invent (#386). A module MUST NOT expect one.

   A module that needs a setup-time fact — something the containers must know
   before they can start — asks for an `.env` key, and the kit has exactly one
   such module-owned key today: `SCORE_IMAGE`, whose non-emptiness *is*
   `secure-development`'s "this deployment runs me" answer (§1.2 below and
   [docs/hosting.md](hosting.md#the-four-bootstrap-keys)). Anything an
   organizer might change mid-event is a runtime `/admin` setting instead, not
   an env key. `quiz`, `classic` and `ai` need no bootstrap key at all.

2. MUST be **runtime-toggleable**, like every other module. Organizers switch
   modules on and off from `/admin` during an event, and the live set lives in
   `ctf:admin:settings`
   ([ADR 52](decisions.md#adr-52-modules-are-switched-at-runtime-secure-development-is-configured-at-setup),
   superseded by
   [ADR 55](decisions.md#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml)).
   The deployment's starting set and its outage fallback are the
   `SCORE_IMAGE`-derived default — `secure-development` alone when a scorer
   image exists, nothing when it does not. Nothing is read from a file, and
   nothing is baked into an image.

   A module whose services are **profile-gated** — chosen once, when the
   stack comes up, not when a switch is flipped — MUST
   expose that availability fact to the app as a runtime env var (`SCORE_IMAGE`
   is the worked example) and refuse enabling when it is absent, with the
   reason, in both the panel and the server. `quiz`, `classic` and `ai` need no
   such env var, since their routes, nav entries and tabs ship in every `app`
   image regardless.

   `secure-development` is the worked example of the gating too: in
   `docker-compose.yml` both of its services — the `scorer` that judges and
   the `sync` poller that brings scores back — carry `profiles: ["secdev"]`,
   so one profile brings the module up whole and there is no line-up in which
   one of them runs without the other. That is the shape to copy: one profile
   per module, not a profile per way of using it.

   Disabling MUST NOT delete a module's data. Re-enabling has to restore the
   same board, or the toggle is a destructive action wearing a switch.

3. MUST NOT expect dynamic/plugin-style registration in v1. Registration is
   deliberate: a module id exists because the kit ships code for it, and adding
   one means editing that code. This is a v1 constraint, not a permanent
   architectural stance.

   What a new module has to touch depends on how far into the platform it
   reaches. A purely app-side module (`quiz`, `classic`, `ai`) is the app
   registry and nothing else — neither `sync` nor `setup/ctf-setup.sh` knows
   those ids exist, and neither needs to. A module with **provisioning** of its
   own (forks, GitHub Apps, package grants — anything `ctf-setup.sh` must do
   before the event) adds its own step to that script, the way
   `secure-development`'s per-target fork loop (`all_targets()`, unconditional
   since #386) does. A module with **targets** duplicates its target list the
   way `secure-development` does, and `scripts/check-module-registries.mjs` is
   what keeps the copies honest: it parses the three independently-maintained
   lists — `sync/src/config.js`'s `TARGETS`, `apps/web/src/lib/apps.ts`'s
   `AppId` union, and the names in `scorer/src/targets.js` — and fails if any
   two disagree. It is a check, never a generator (ADR 10, amended by ADR 55:
   the *registration* stays deliberate and duplicated; only the *selection*
   moved to runtime). A target list that disagrees across those three is the
   failure the check exists to catch: an id the app renders and `sync` does not
   poll is a challenge nobody can ever score.

4. Which of a module's **targets or content items are live** is a runtime
   `/admin` setting, never a setup-time one. `secure-development` is the worked
   example: `ctf-setup.sh org` forks and provisions all six of
   `setup/targets.tsv` unconditionally, and `secureDevTargets` in
   `ctf:admin:settings` picks the subset contestants actually see — read per
   request by the app and per tick by the sync poller (see
   [docs/operations.md](operations.md#targets)). Points already banked on a
   target later removed from the list keep counting; removing a target hides a
   board, it does not rewrite history.

   The ingest transport was the last thing still chosen before the boxes came
   up — `SCORE_INGEST` in `.env`, read by `docker-compose.yml` to pick a
   Caddyfile and a profile — and it is gone, along with the choice it made
   (Section 3). Its history is the lesson worth keeping. That value was
   declared in two places at once, the event config file and `.env`, with
   nothing syncing them, and a box duly ran one transport while its config
   claimed the other (#372/#374). A module MUST NOT add a second knob that has to agree with an
   existing one — and, on this evidence, should think twice before adding a
   first one.

5. MUST state whether it is **Archivable**: whether its content is wholly
   self-contained in Redis, and therefore carried whole by the whole-event
   archive bundle (`GET`/`POST /api/admin/event`, `event-store.ts`; see
   `docs/operations.md`'s
   ["Archiving and replaying an event"](operations.md#archiving-and-replaying-an-event)
   for the organizer-facing contract). `quiz` and `classic` are: their whole
   catalogue — questions/choices/answer keys, or challenges/categories/flags
   — lives in Redis and round-trips through their own `exportBundle`/
   `importBundle` (`quiz-store.ts`/`classic-store.ts`), which the event
   bundle composes directly. `secure-development` is **not**: its content is
   target repos, forks, rubrics and the GitHub App installation, none of
   which live in the box, so a bundle assembled while it is enabled names
   what it could not carry (an export-time warning, and an import-time
   `skipped` entry) rather than silently omitting it.

## Section 2. Scoring ingestion contract (the hard boundary)

1. MUST submit every score through the single writer: `POST /score` on the
   local scorer. `sync/src/submit.js` is the only write path this repo
   implements, and the poll pipeline is the only thing that walks it; there is
   no second write path. A module MUST NOT invent one.

2. Payload MUST be `{author, target, solved: string[], pr: number, sha:
   string}`, delivered as a bearer-authenticated JSON POST, and a success
   response is `202`:

   ```js
   // sync/src/submit.js
   const res = await fetchImpl(`${cfg.scorerUrl}/score`, {
     method: "POST",
     headers: { authorization: `Bearer ${cfg.scorerToken}`, "content-type": "application/json" },
     body: JSON.stringify(payload),
   });
   ```

   (`sync/test/submit.test.js`: "POSTs payload with bearer token, true on
   202".)

3. `author` MUST match the GitHub-login grammar before it is ever sent,
   because it becomes a datastore key on the scorer side:

   ```
   /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/
   ```

   (`sync/src/parse.js`, `GITHUB_LOGIN` — the comment there is explicit:
   "Same grammar the scorer enforces — author becomes a Redis key segment
   there.") A module's scoring path MUST validate any author string against
   this grammar before it reaches `POST /score`; never pass through an
   unvalidated string from PR/comment metadata.

4. Writes MUST be treated as monotonic/idempotent on the receiving end —
   modules MAY deliver at-least-once. `sync`'s own poller relies on this:
   on a submit failure it un-marks the comment as seen and retries on the
   next tick (`sync/src/index.js`, `tick()`: `rs.seen = rs.seen.filter((k)
   => k !== seenKey(c.id, c.updated_at));` — keyed on comment revision,
   `id@updated_at`, not bare id), and replays of an already-applied
   score are expected to be no-ops on the scorer side, not double-counts.

## Section 3. Score transport

> There is one transport and nothing selects it. A module reaching the
> platform from outside copies the shape below. Push ingest — the scoring
> workflow POSTing straight at a public `/score` on the box — was removed in
> v0.6 ([#377](https://github.com/OWASP/owasp-ctf-in-a-box/issues/377),
> [ADR 56](decisions.md#adr-56-poll-is-the-score-transport-push-ingest-is-removed)),
> along with `caddy/Caddyfile.push`, the `push` profile and the judge's
> `SCORE_API`/`SCORE_TOKEN` hook, so a module MUST NOT expect an inbound
> route to exist for it.

1. **Poll**: the workflow embeds a machine-readable HTML-comment block in
   its PR comment, `<!-- ctf-score: {...} -->` (`sync/src/parse.js`,
   `MARKER`), authored by the trusted workflow identity
   (`github-actions[bot]` — `cfg.commentAuthor`, default in
   `sync/src/config.js`). The poller filters comments by author **before**
   parsing the JSON block:

   ```js
   // sync/src/github.js
   comments: all.filter((c) => c.user?.login === cfg.commentAuthor),
   ```

   `scripts/smoke.sh` proves the trust filter: a forged comment authored by
   `mallory` carrying a valid `ctf-score` block is fetched but never
   scored, because it's dropped by the author filter, not by JSON parsing.
   Nothing reaches the box for any of this: `sync` fetches outbound, and
   `caddy/Caddyfile.poll` — the only Caddyfile — has no `/score` route at all.

2. **Trust is the comment author, and nothing else.**
   A module using this transport MUST post its score comment from the
   org-repo workflow context (e.g. a `pull_request_target` Action running
   as `github-actions[bot]`), never from a user-controlled identity —
   trust here is entirely the GitHub-authenticated comment author, not
   anything in the payload.

3. A new transport (e.g. a webhook relay, a different trust anchor) is a
   new `sync` adapter, not a config toggle. Propose it via an issue first;
   it changes the trust model, not just wiring.

## Section 4. Leaderboard mapping

1. The scorer exposes `GET /leaderboard`; the local test fixture
   (`test/fixtures/mock-scorer.mjs`) returns `{leaderboard: [{author,
   points, solved}]}` computed as one point per solved challenge ID — a
   simplified stand-in for smoke-testing, not the real scoring/pricing
   logic (that lives in this repo's scorer engine, `scorer/src/serve.js`'s
   `buildLeaderboard`). The real scorer's leaderboard entries carry, per
   author, points plus a per-target solved/total breakdown.

2. A module MUST define its own challenge catalogue: a fixed set of target
   keys (`secure-development`'s is the `TARGETS` enum in
   `sync/src/config.js` — `juice-shop`, `dvwa`, `webgoat`,
   `securityshepherd`, `vulnerableapp`, `vampi`) and, per target, a stable
   set of challenge IDs with known totals, so the leaderboard can render
   "solved / total" and unsolved counts read as remaining work, not as
   absent data. `secure-development`'s challenge IDs (e.g. `sqli-low`,
   `exec-low`, `restfulXss` — see the fixture score comments in
   `test/fixtures/mock-github.mjs`) are opaque strings scoped per target;
   the module owns their meaning.

3. Challenge IDs are stable keys once published — renaming one breaks
   provenance (a contestant's recorded solve no longer maps to any current
   challenge). Treat catalogue IDs like a public API: add, don't rename.

## Section 5. UI / presentation contract

**Honesty constraint up front:** the vendored contestant app (`apps/web/`,
see `apps/web/VENDORED.md`) now derives its module registry from a runtime
set rather than hardcoding a single module. `src/lib/modules.ts`'s
`moduleDefsFor` maps every enabled id to a `ModuleDef` — display name,
description, and nav entry are code-side registry data (`REGISTRY` in
`modules.ts`); whether a module is *live* is decided at runtime, from the
`ctf:admin:settings` set that defaults to Secure Development alone when the
deployment has a `SCORE_IMAGE`, otherwise nothing
([ADR 52](decisions.md#adr-52-modules-are-switched-at-runtime-secure-development-is-configured-at-setup),
amended by #386). Four ids are registered today, all four
**real, working modules** rather than registry-proving placeholders:
`secure-development` (targets, catalogue,
GitHub-mediated scoring — the worked example throughout this document),
`quiz` (a self-paced single/multi-select question bank, scored entirely
inside the app — see
[docs/architecture.md#quiz-data-flow](architecture.md#quiz-data-flow) for its
data flow and `docs/operations.md`'s "Quiz" section for the organizer-facing
authoring/retry-knob guide), `classic` (a jeopardy-style flag board,
also scored entirely inside the app — see
[docs/architecture.md#jeopardy-data-flow](architecture.md#jeopardy-data-flow)
for its data flow and `docs/operations.md`'s "Jeopardy" section for the
organizer-facing authoring/cooldown guide), and `ai` (challenges hosted on an
external site, played there or graded by a typed flag back on `/ai/[id]`).
Registered and selectable, and its contract, store layer, contestant surface
**and** admin section have all shipped: the nav entry, the `/ai` board and
the `/ai/[id]` challenge page (the launcher, and the in-box flag form for a
`flag`/`both` challenge), plus a full authoring UI
(`admin-ai-controls.tsx`) for mode/URL/categories/hint and the
`aiCooldownSec` submission-cooldown knob. Its catalogue rides in the
whole-event archive bundle (`ai-io.ts`, the third section beside `classic`
and `quiz`, carrying flags, hints, categories and per-challenge signing keys
but never the launch keypair); the remaining gap is narrower — the AI tab has
no bundle button of its own, so a board is moved through the archive rather
than a per-module export. See [docs/ai-module.md](ai-module.md) for what an external
challenge site must implement to integrate with it. An id outside the
registry is rejected wherever it is offered: the `/admin` settings route
validates `enabledModules` against `ALL_MODULE_IDS` and answers an unknown id
with an `AdminValidationError`, and `isModuleId` guards every other read, so
a stray id can never turn into a half-enabled module.

Display metadata (item 1) and the enablement rule (item 4) now hold for real
across the app, not just as a filter over one hardcoded target list:
`resolved-modules.ts`'s `getNavLinks`/`getNavGroups`, running `site.ts`'s
`buildNavLinks`/`buildNavGroups` over the LIVE resolved-module list, splice a
module's nav entry into the header iff that module is enabled *and* defines a
`nav` — all three app-side modules do now, `quiz`'s pointing at `/quiz` (`apps/web/src/app/(site)/quiz/`,
rendering `components/quiz-board.tsx`), `classic`'s at `/flags`
(`apps/web/src/app/(site)/flags/`, rendering `components/challenge-board.tsx`)
and `ai`'s at `/ai` (`apps/web/src/app/(site)/ai/`, rendering that same
`components/challenge-board.tsx` — the board and the challenge page are
shared by both flag-graded modules, with a different `basePath`);
the leaderboard pipeline's
`withModuleContributions` (`src/lib/leaderboard/module-contributions.ts`)
attributes `secure-development`'s scorer-sourced *gross* points (hint
penalties fold last, netting the final all-module total once — the module
blocks show gross, the row's `−N hints` marker reconciles them) into a
per-module `ModuleProgress`, and now *also* computes `quiz`'s, `classic`'s
and `ai`'s points app-side and adds them into the combined total (never
attributes them — the scorer never sees a quiz question, a captured flag,
or an ai challenge solve, so there is nothing of theirs to attribute from) —
see
the architecture doc for why secure-development and the three app-side modules
use different verbs there. An
expanded leaderboard row renders each enabled
module's own detail block (`components/module-detail.tsx`) instead of one
hardcoded shape — `secure-development`'s branch shows the existing
patched/target breakdown, `quiz`'s shows an answered/total count, `classic`'s
a solved/total count, and `ai`'s a cleared/total count of its own — with the
per-module heading suppressed while only one module is enabled, so a
single-module event's row reads exactly as it did before; `/profile` renders
the same per-module blocks for the signed-in contestant's own progress,
built off the shared `components/progress/progress-row.tsx` — module, target
and module-without-targets are all one row shape, each carrying its module's
own unit word (`patched` / `answered` / `solved` / `cleared`, with `flags` as
classic's verb on the team card) and a bar that measures POINTS at every
level, since points are what the board ranks on. A module whose source
reports no ceiling shows what was earned rather than an `N / 0 pts` fraction — the page's headline total was already net and correct before
this, what it was missing was the per-module breakdown behind it; the admin
panel
(`app/(site)/admin/admin-controls.tsx`) is a tab shell — seven control-plane
tabs that belong to the platform itself (**Overview**, **Event**, **Hints**,
**Admins**, **Support**, **Activity**, **Insights**), then one tab per
enabled module, labelled with that module's organizer-resolved `title` — with
the four hint controls on the Hints tab (they are event policy shared by
every module that sells hints), Secure Development's re-run cooldown in its
own tab (`app/(site)/admin/admin-secure-dev-tab.tsx`), the quiz's two retry-gate
knobs plus its full
question-authoring UI (`components/admin-quiz-controls.tsx`) in Quiz's,
classic's submission-cooldown knob plus its full challenge/category
authoring UI (`components/admin-classic-controls.tsx`) in Jeopardy's, and
ai's submission-cooldown knob plus its own challenge/category authoring UI
(`components/admin-ai-controls.tsx`) in AI's —
so the generic "No settings for this module yet." fallback that a module
tab renders when it defines no controls is, today, dead code for all four
shipped modules; it stays wired for whatever module ships next with no
settings of its own. Every module tab opens with an identity editor
(`app/(site)/admin/admin-module-identity.tsx`) for that module's title/blurb override (item 1
above); this is the same organizer-resolved name rendered in the tab label
itself, the nav, and the module's own page header — plus the leaderboard block
and the landing-page section heading on a *multi-module* event, both of which
are suppressed while only one module is enabled (see item 1 for the full
reach). The
landing page (`app/page.tsx`) is composed the same way: the platform frame
(logo, event name, dates, countdown, its own CTAs, Discord link, progress
card) stays code, and each enabled module's `home` block (item 5 above)
supplies the page's tagline, hero paragraph, "what to expect" section, and
optional CTA/extra section — so a quiz-only event's landing page never
mentions forks or patches. `/how-to-play` and `/rules` are composed the same
way from each module's `guide` and `rules` blocks (item 6 below), so the
step-by-step guide and the fair-play rules describe the game the event is
actually running — as are `/faq`, `/terms` and the 404's route directory
(item 7). The existing challenge
catalogue (item 2) and per-target solved/total leaderboard columns (item 3)
predate this work and satisfy those items for `secure-development`; `quiz`
and `classic` each satisfy the same items with their own semantics — a flat
answered/total count and a flat solved/total count respectively (item 3
below covers the difference). The organizer admin panel that was tracked as Spec B is still
built out — freeze, scheduled scoring windows, team-registration windows, hint
toggles/cost, demo seed, and the master reset (see `docs/operations.md`'s
"Organizer admin panel" and "Status and upstream dependencies"). What remains
open there is score adjustments and player removal — and offering this
vendored delta back to `OWASP-CTF/ctf-owasp-org` once upstream write access
opens.

What remains open from this work and the quiz work before it, so a real
third module isn't mistaken for a fully general n-module platform:

- **No per-module leaderboards or module switcher exist.** The leaderboard is
  one board; a module's contribution shows only as a row's expandable
  per-module breakdown, never a separate view. This is unchanged by `quiz` or
  `classic` going live — each added its own breakdown block, not a second or
  third board.
- **`sync` still doesn't score anything for `quiz`, `classic` or `ai`, by
  design, not as a gap.**
  `sync` has no notion of those ids at all — since config v2 (#386) it reads
  `.env` plus the Secure Development target list in `ctf:admin:settings`, and
  nothing else; it scores `secure-development`
  alone, because none of the three app-side modules ever produces a score for
  GitHub to relay in the
  first place — all three grade server-side inside the app's own Redis keys
  (see the architecture doc; `ai` takes its solve reports over its own
  authenticated app route, never through the scorer). Per-module
  ingest/rubric plumbing was for a
  module that needs scorer-mediated scoring; `quiz`, `classic` and `ai` are
  proof one doesn't
  always need it, not evidence that plumbing is still missing.
- **No free-text questions, no partial credit, and no per-question
  attempt/cooldown overrides** — single- and multi-select only, all-or-nothing
  grading, and the two retry-gate settings (`quizMaxAttempts`,
  `quizRetryAfterMin`) are global, not settable per question.
- **`quiz` and `classic` both have bulk import/export, in one shared format.**
  Either tab can export its content as a single versioned JSON bundle and
  import one back — upsert by id, never deletes; classic additionally unions
  its categories rather than replacing them. See
  [ADR 36](decisions.md#adr-36-quiz-adopts-classics-bundle-format-rather-than-inventing-a-second-one)
  for why the two formats are deliberately the same, and
  [docs/operations.md](operations.md#quiz) /
  [docs/operations.md](operations.md#jeopardy) for the organizer-facing
  contracts. Neither bundle carries its module's retry-gate settings: those
  are event policy, live-editable in `/admin`, and an import must never move
  them.
- **`classic` still has no file attachments — plainly, not by omission.**
  A challenge's `description` is Markdown text only, with nowhere to attach
  a downloadable file (an image, a pcap, a binary) for a contestant to pull
  down. Attachments are scoped to a later PR in this same series (#186).
- **`classic` HAS paid hints (issue #190).** An organizer attaches optional
  hint text in the admin classic form (or a bundle's `hint` field); the text
  is secret until purchased — its own hash, `ctf:classic:hints`, exactly the
  flag hashes' storage rule — and contestants buy it on the challenge's own
  page through the SAME reveal machinery, cost, gating knobs and penalty
  fold as secure-development's hints. The anti-burner gate counts solves on
  the whole classic board (categories are display groupings, not progress
  domains).

This section remains the contract a *new* module (forensics, api-security,
cloud, …) must satisfy to plug into the same UI: it is now proven against
four
real modules with genuinely different shapes — `secure-development`
(GitHub-mediated scoring, per-target progress), `quiz` (app-side scoring,
a flat answered/total count), `classic` (app-side scoring, a flat
solved/total count), and `ai` (challenges hosted outside the box, scored
app-side from a signed event or a typed flag, a flat solved/total count) —
which is what makes item 3 below a contract
about *defining your own progress semantics*, not an accidental description
of one module's shape.

1. **Display metadata.** A module MUST provide a human-readable display
   name, a short description, and a nav label, sourced from the module's
   own config/catalogue — never hardcoded into the app per module. Worked
   example: `secure-development` supplies "Secure Development" as its
   display name (not a string baked into `ctf-owasp-org`'s UI layer).

   A module's registry display name/description MAY be overridden at
   runtime by the organizer — a title (≤60 chars) and a blurb (≤200 chars)
   per module, editable from that module's own `/admin` tab, plain text only
   (control characters and Unicode bidi-override/isolate characters
   rejected), stored on the same `ctf:admin:settings` hash the rest of the
   runtime override layer uses (`moduleTitle:<id>`/`moduleBlurb:<id>` —
   decision 19's override-else-default precedence applies here too: leaving
   a field blank clears the override and restores the registry default,
   never stores an empty string).

   **Two resolved fields, and they are not interchangeable.**
   `ResolvedModule.title` is the module's name — the override if there is
   one, the registry `displayName` otherwise — and it is what a surface that
   has always shown the module's name must render.
   `ResolvedModule.titleOverride` is the organizer's rename *alone*, or
   `undefined`, and it is what a surface with its own established default
   must render *instead of* that default. The rule the platform follows, and
   a new module MUST follow: **an explicit rename replaces the module's name
   wherever it appears; with no rename, each surface's existing default
   stands unchanged.** The nav is the worked example —
   `secure-development`'s registry `nav.label` is "Challenges" while its
   `displayName` is "Secure Development", because one describes the
   destination page and the other names the module — so the nav reads
   `titleOverride || nav.label`, and an event that never touched `/admin`
   still says "Challenges". Reading `title` there instead renames the nav on
   every such event, which is a real bug this kit shipped and fixed. Same for
   `/challenges`, whose page title defaults to "Challenges", not to the
   module's display name.

   **Where a rename reaches, honestly.** On every event: the module's admin
   tab label, its nav link (header *and* footer), and its own page
   header/`<title>`. The header's convention changes once 2+ modules have a
   `nav` entry: `site.ts`'s `buildNavGroups` collapses them into one dropdown
   literally labelled "Challenges", whose items read each module's `title`
   (the override, or `displayName`) rather than `nav.label` — a dropdown
   called "Challenges" containing an item also called "Challenges" would be
   nonsense. A rename still reaches it, just through `title` instead of
   `titleOverride || nav.label`; the footer stays flat and keeps the
   `nav.label` convention regardless of module count (see `getNavLinks` vs.
   `getNavGroups` in `resolved-modules.ts`). Exactly one module still renders
   as a plain link, identical to a single-module event before grouping
   existed. Only on a **multi-module** event: the leaderboard's
   per-module block heading and the module's landing-page section heading —
   both are deliberately suppressed while a single module is enabled (there
   is nothing to disambiguate), and the landing page's uppercase kicker comes
   from the registry `home.tagline`, which is not overridable at all. So a
   single-module event sees three surfaces change, not five. (A module with
   no `home` block is the one exception: with no authored heading to prefer,
   its landing-page section is headed by its resolved `title`, so a rename
   reaches it even on a single-module event.)

   The **blurb** has a smaller reach than the title, but it is rendered copy,
   not metadata: it supplies the module page's meta description
   (`generateMetadata`) **and** that page's header lede — `/quiz` renders it
   under the title, where a per-viewer progress line used to sit. A module
   that has no registry `home` block also gets it as the lede of its
   landing-page section, so a module can ship a route and a sentence about
   itself before it ships hero copy. `secure-development` HAS a `home` block
   and its own page title, so it consumes the blurb only as a meta
   description; a new module should assume the blurb will be read by a
   contestant, not by a crawler alone.

   A module MUST NOT read its own registry `displayName`/`description`
   directly in any surface that names it — it must go through the resolved
   fields, or an organizer's override silently does nothing there.

2. **Challenge catalogue for UI.** A module MUST expose, per challenge: id,
   title, target/app grouping, and point value — built on the same
   catalogue and the same stable challenge IDs required for scoring (item
   4.2 above). The UI reads challenge titles and groupings from this
   catalogue; it MUST NOT need a code change per challenge to render a new
   one. Renaming a challenge ID breaks its UI history exactly as it breaks
   scoring provenance (item 4.3) — one stability rule, not two.

3. **Leaderboard presentation.** A module MUST define its own progress
   semantics: what columns and progress indicators the leaderboard/app show
   for it. Worked example: `secure-development` shows a patched/total count
   per target (e.g. `dvwa: <solved>/<total>`) across its up-to-six
   configured targets, `<total>` coming from that target's per-challenge
   count in the catalogue (item 4.2). Second worked example, proving the
   "MUST specify its own equivalent" clause for real rather than only in the
   abstract: `quiz` has no per-app grouping at all, so it shows a flat
   `<answered>/<total>` count instead (`ModuleDetail`'s `quiz` variant,
   rendered by `components/module-detail.tsx`) — a module with a different
   structure MUST specify its own equivalent rather than forcing the
   patched/total shape.

4. **Enablement rule.** A module's UI surfaces (nav entry, challenge list,
   leaderboard columns) MUST appear if and only if the module's id is in the
   runtime live set — `getEnabledModuleIds()` / `isModuleLive()` in
   `apps/web/src/lib/enabled-modules.ts`, backed by `ctf:admin:settings`'s
   `enabledModules`, which defaults to Secure Development alone when the
   deployment has a `SCORE_IMAGE` and to nothing otherwise
   ([ADR 52](decisions.md#adr-52-modules-are-switched-at-runtime-secure-development-is-configured-at-setup),
   amended by #386). Nothing about a module outside that set may leak into
   nav, leaderboard, or challenge listings; a contestant on an event that
   hasn't switched a module on gets an app with no trace of it, not a
   greyed-out or hidden-but-present surface. This reaches
   the module's own dedicated route, not just its nav entry: a disabled
   module's page MUST 404, not merely disappear from the header — worked
   example, `/challenges` (`app/(site)/challenges/page.tsx`) calls
   `notFound()` as its first statement when `secure-development` is
   disabled, the same gate `/quiz` already ran for its own module.



5. **Landing-page contribution (optional).** A module MAY contribute a
   `home` block to its registry entry (`ModuleHome` in
   `apps/web/src/lib/modules.ts`): an uppercase tagline, a hero `intro`
   paragraph, a "what to expect" heading/lede, numbered `steps`, an optional
   `cta` into the module's own route, and an optional full-width `extra`
   section. The platform frame (`app/page.tsx`) owns the logo, event name,
   dates, countdown, its own CTAs, the Discord link, and the
   progress-tracking card; it composes each enabled module's `home` block in
   registry order alongside that frame. A module with no `home` contributes
   nothing to the landing page — valid, not an error — and an event whose
   enabled modules all lack one still renders the frame on its own.

   `intro` and `steps` are **functions**, not static strings — they take a
   `HomeContext` (`appCount`, `appList`, `topAppsList`, `totalChallenges`,
   built once per render so two modules can't disagree about how many
   targets the event has) and must be called server-side, with only the
   resulting strings ever handed further down the tree. A module's `home`
   block MUST NOT be passed to a Client Component for this reason — see
   `docs/decisions.md`'s ADR on why `ResolvedModule` omits `home` entirely
   and server code reaches it through a dedicated accessor instead.

6. **Guide and rules contributions (optional).** The same split applies to
   `/how-to-play` and `/rules`, which used to be secure-development's
   workflow written out longhand — patch, fork, pull request — on every
   event, whether or not that module was enabled.

   A module MAY contribute a `guide` block (`ModuleGuide`): the page lede
   and meta description, an optional "the loop" callout, an optional callout
   above the steps, the numbered `steps`, an optional end-to-end `example`
   (with code blocks and a bonus note), "good to know" `notes`, a `scoring`
   paragraph and a `cta`. The platform frame (`app/(site)/how-to-play`) owns
   the page header, the "Good to know" and "How scoring works" cards, the
   links to the rules and leaderboard, and the organizer/Discord line, and
   composes each enabled module's block in registry order — with a per-module
   heading only when more than one module is guided, and each module's own
   lede promoted to the page lede when it is the only one.

   A module MAY also contribute a `rules` block (`ModuleRules`), bucketed by
   the `/rules` section it belongs in: `teams`, `fairPlay`, `conduct`,
   `scoring`. The platform keeps the section headings and the genuinely
   event-wide rules (team size, code of conduct, prizes, organizer
   decisions); a module owns every rule that names its own artifacts —
   targets, pull requests, patches, hints, questions. "Fair play" is written
   entirely by the modules — but the principles under it (don't collude,
   don't attack the platform) hold on any event, so the platform renders two
   generic fallback bullets if, and only if, no enabled module contributed
   any: a module that ships without a `rules` block must not leave a CTF with
   no anti-collusion rule at all. A section that ends up with no rules is not
   rendered.

   `guide.steps`/`guide.example` and `rules` itself are **functions** (of
   `GuideContext`/`RulesContext` — the target count and list, the GitHub org,
   the worked-example variant), so both fields carry the same server-only
   contract as `home`: called server-side, never handed to a Client
   Component, reached through `getModuleGuide`/`getModuleRules` and stripped
   from `ResolvedModule`. Copy is authored as plain data, not JSX; where a
   sentence needs inline markup it uses `Copy`/`CopySegment` (an emphasised
   phrase, a bold lead-in, an external link), rendered by
   `components/module-copy.tsx`. Nothing is written twice — a string lives in
   `home` or in `guide`, never in both.

7. **FAQ, terms and 404 contributions (optional).** The same split reaches
   the last three contestant-facing pages that were written as though every
   event ran `secure-development`.

   A module MAY contribute an `faq` block (`ModuleFaq`), bucketed by where
   its questions land in the platform's own running order:
   `gettingStarted` (before "Can I compete solo?"), `prep` (after it) and
   `playing` (the play loop). Buckets rather than one flat list because the
   platform's own questions are not all at one end — the page reads wrong if
   every module question is shunted to the top or the bottom. `/faq` matters
   more than its traffic suggests: it is in the **header nav**, so a page
   describing a game the event isn't running is linked from every page of
   the site.

   A module MAY contribute a `terms` block (`ModuleTerms`), bucketed by
   `/terms` section: `eligibility`, `scope`, `submissions`, `scoring`. Every
   participation term this kit has written names a module's own artifacts —
   what you submit, where you may test, what a point is worth — so the
   platform keeps only the two that hold on any event (prizes, organizer
   decisions) plus a **fallback list per section**, rendered if and only if
   no enabled module contributed to that section. The fallbacks are not
   decoration: with none, an event whose modules ship no `terms` renders an
   empty "Scope of authorized testing", and that section is the one that
   tells contestants what they are permitted to attack. (Before this, the
   scope statement was hardcoded secure-development copy and rendered as
   *"your authorization to test covers the 0 challenge targets only: ,"* on
   an event with no targets.)

   A module MAY contribute a `routeCard`: the one line under its card in the
   404's directory of routes. The card's label and href come from `nav`
   (`titleOverride || nav.label`, per the naming rule above), so the 404
   offers each enabled module's own route and never a route the event does
   not have.

   All three are **functions** (of `OrgContext`/`RulesContext`) and carry the
   same server-only contract as `guide`/`rules`: called server-side, reached
   through `getModuleFaq`/`getModuleTerms`/`getModuleRouteCard`, stripped
   from `ResolvedModule`.

   Two platform pages — `/privacy` and `/code-of-conduct` — are deliberately
   **not** composed from the registry. They describe the platform's own code
   and policies, not a module's game, so their module-specific claims (hint
   purchases, quiz answers, the GitHub org the code of conduct reaches into)
   are gated on `isModuleEnabled` instead. `/privacy` is an inventory of what
   this codebase stores, and which stores are live is per-event: it must
   neither promise a per-challenge breakdown an event has no notion of, nor
   stay silent about the answers a quiz-only event does keep.

8. **Pre-event gate.** The gate (`proxy.ts` + `/gate`) covers **every enabled
   module's own page route** — the exact `nav.href` each module registers —
   rather than the hardcoded `/challenges` it used to. `proxy.ts` gates the
   registry's FULL route list (`ALL_MODULE_ROUTES`), not the enabled subset —
   enablement is a runtime Redis read the middleware must not depend on, and
   gating a disabled module's page costs nothing while hiding which modules
   an event runs before it opens (see the comment on `GATED_ROUTES`); `/gate`
   sends an unlocked visitor to the first enabled route, falling back to `/`.
   Next requires
   `config.matcher` to be a static literal, so it cannot be computed — it
   lists every registry route by hand and `src/__tests__/proxy.test.ts`
   asserts it covers `ALL_MODULE_ROUTES`, so a newly registered module cannot
   end up silently un-gated. `proxy-quiz-only.test.ts` and
   `proxy-disabled-module.test.ts` pin what it then *does* with them.

   Know what this is and is not. The gate's route set is **page-only and
   exact-match**: it protects the module's page, not any deeper path under
   it, and it deliberately does **not** widen over `/api/*` — that would put
   the gate in front of `/api/auth/*` (breaking the sign-in a contestant
   needs in order to pass the gate) and `/api/gate` itself, and would answer
   API calls with a page *redirect*, which an API client can't act on. (The
   matcher literal itself also carries `/api/:path*`, but that entry serves
   the cross-origin write assertion, not the gate.)

   Instead, the module routes that bank points or leak challenge content
   (three API routes plus the ai module's in-box flag form — `/ai/[id]`'s
   page and server action — while `POST /api/ai/submit` relies on the launch
   token, which can only be minted from a page that already passed the gate)
   call a small server-side check of their own,
   `requireGatePassed()` (`src/lib/gate-request.ts`) — beside the gates they already
   run (`effectivePaused`, attempt caps, cooldowns), after authentication (so
   an unauthenticated caller still gets the more specific 401) and before any
   store read or write:
   - `POST /api/quiz/answer` and `POST /api/classic/submit` — bank points.
   - `POST /api/hints/reveal` — deducts points **and** returns hint text, so
     an ungated call would leak challenge content early, not just score
     early.

   A refused call gets **403 `{ error: "gate" }`**, never a redirect.
   `isGateActive()` is a module-load env read and `verifyGateCookie` is pure
   crypto — neither does I/O, so `requireGatePassed()` can never error
   mid-check; there is no fail-open/fail-closed case to make here, unlike the
   store-backed gates it sits beside.

   Deliberately **not** gated, on purpose: `/api/auth/*` (signing in is how a
   contestant passes the gate), `/api/gate` (the gate itself), `/api/admin/*`
   (organizers must be able to configure the event before kickoff — that's
   the entire point of a pre-event window), `/api/team/*` (team registration
   has its own separate window, `effectiveRegistrationOpen` — registering
   before kickoff is intended), `/api/stats/visit` (telemetry), and
   `GET /api/hints` (it returns the texts of hints the caller has **already
   purchased**, to a caller who must already be authenticated — it reveals
   nothing the buyer has not already paid for and cannot be used to read an
   unbought hint).

   This still is **not** an authorization boundary: it is a "the board opens
   at the keynote" curtain over a handful of scoring/content-leak paths, not
   a replacement for every API route enforcing its own rules
   (authentication, the pause/schedule window, attempt caps) independently —
   they must keep doing so, and a module MUST NOT treat "the gate is up" as
   a reason to skip a check in its own API. See `docs/operations.md`'s
   "Known limitations" for the operator-facing note.

9. **Setup instructions (organizer-facing, optional but expected).** A module
   MAY contribute a `setup` block (`ModuleSetup` in
   `apps/web/src/lib/modules.ts`), and every shipped module does. It is what
   the module's `/admin` tab opens with, ahead of the identity editor and the
   module's own knobs, and it answers, in this order: what contestants
   experience in the module; the minimum an organizer must do before the
   event, as an ordered checklist in dependency order; on every step, whether
   it happens **in this panel** or **outside it** (`ctf-setup.sh`, the GitHub
   org, `.env`); what is safe to change mid-event and what is not; and
   a link to the module's section of [operations.md](operations.md).

   A step may declare a `check` naming a count the module's own admin panel
   already holds — its items, or its categories — and the panel then shows
   "3 questions" / "None yet" beside it instead of asking the organizer to
   remember, and "Checking…" until the panel's list has actually loaded. A
   step the panel cannot verify (a fork provisioned, an App installed)
   declares no `check` and renders as a plain item. Do not fake one: an honest
   static checklist beats a tick that lies.

   It is a **function** of `OrgContext`, like `faq` and `terms`, because
   `secure-development`'s checklist names the event's targets and GitHub org
   — so it carries the same server-only contract: called in `/admin`'s page
   (`getModuleSetup` in `resolved-modules.ts`), stripped from
   `ResolvedModule`, and only its plain-data result reaches the client shell.
   The shell (`admin-controls.tsx`) renders it through one shared component
   (`components/admin-module-setup.tsx`) driven by the modules list, so a
   fifth module gets its setup panel with no per-module code.

## Section 6. Security requirements (non-negotiable)

1. Contestant code MUST run only inside sandboxed containers on an internal
   Docker network — never on the host, never with any token access. This
   is the `pull_request_target` pattern `secure-development` uses: the
   scoring workflow runs in the base (org) repo's context, where the org
   `GITHUB_TOKEN` (needed to pull the org-mirrored scorer image and read org
   secrets) lives, while the untrusted PR code under test executes in a
   sandboxed container on an internal Docker network with no access to
   that token — the isolation pattern the kit's own consumer workflow
   template (`scorer/consumer-workflow.example.yml`) implements, the same
   workflow `setup/ctf-setup.sh`'s `cmd_org` renders per target and commits
   into each forked target repo automatically (§7.2; the `render`
   subcommand's `dist/workflows/` output is the offline/manual alternative).
   A module MUST
   reproduce this isolation for its own scoring workflow, not just inherit
   it by accident.

2. **Oracle discipline**: contestant-visible output (the PR comment and the
   score payload in it) MUST be pass/fail plus points only — never failing-test names,
   assertion messages, or exploit payloads. Verbose diagnostics stay in the
   private workflow log, visible to org admins only. This holds whether or
   not the rubric is private (the stock one ships public — ADR 18): an
   information-rich comment tells a contestant exactly which check to game,
   which is a worse oracle leak than the rubric text itself.

3. Scoring re-runs per submission MUST be rate-capped (e.g. N re-scores per
   PR per hour), so a contestant cannot brute-force the scorer's judgment
   with rapid speculative pushes. (`secure-development`'s shipped consumer
   workflow, `scorer/consumer-workflow.example.yml`, enforces this itself
   with a per-PR `concurrency` group plus a `COOLDOWN_MINUTES` gate; the
   upstream `score-action` path still doesn't — see
   [Status and upstream dependencies](operations.md#status-and-upstream-dependencies).
   Any new module's scoring workflow MUST ship its own cap regardless.)

4. **Stock-scores-zero invariant**: an unpatched, stock copy of a target
   MUST score 0. A module MUST ship a guard (a test or CI check) that
   proves this — feeding the scorer an unmodified target and asserting the
   result is zero points — so a rubric bug can never hand out free points
   for doing nothing.

   The invariant is enforced twice. `scripts/acceptance-scorer.sh` proves it
   offline against a synthetic stock app (fast, no network), and
   `scripts/acceptance-target.sh <target> <stock-image>` proves it against
   each real stock target in CI. A challenge that passes against the stock
   app is a free point for every contestant and fails the build.

## Section 7. Provisioning & lifecycle hooks

**A module that needs no forks and no scored transport is a first-class
citizen, not a lesser one.** `quiz` is the worked example: it satisfies this
section by having nothing to provision at all — no repo to fork, no
workflow to install, no image to mirror, nothing to archive at teardown.
That MUST be a legitimate, fully-supported shape for a module to have, not
just a legitimate shape for a module to have *alongside* one that does need
provisioning. Concretely, that means `ctf-setup.sh org`/`render`/`doctor`
MUST tolerate `secure-development` being the *only* provisioning-needing
module and simply absent — not merely tolerate it being present alongside
`quiz` — and report "nothing to provision/check" rather than erroring
(`has_module secure-development` gates each of the three; see the ADR
referenced in §1.2). A module standing alone this way still owes the rest of
the contract in full: display metadata (§5.1), a challenge catalogue if it
has one (§4.2/§5.2), its own leaderboard progress semantics (§5.3), and the
UI composition surfaces in §5.5/§5.6 — "first-class" means the platform
never assumes a *different* module is also enabled, not that this module
gets to skip sections that apply to it.

`ctf-setup.sh` implements `secure-development`'s provisioning today
(`setup/ctf-setup.sh`, `cmd_org` / `cmd_teardown`):

1. **Fork** each of the six `targets.tsv` targets into the event org,
   unconditionally (config v2, #386: provisioning reads no subset from
   anywhere — which targets contestants actually see is
   chosen afterward, at runtime, in `/admin`)
   (`gh repo fork "$(prov_field "$t" 2)" --org "$org" --fork-name "$name" --clone=false`).

   **`setup/targets.tsv` is the canonical source of both halves of that
   command.** Its `upstream_repo` column names what is forked (`digininja/DVWA`,
   `erev0s/VAmPI`, …, pinned to the `ref` column), and `prov_repo_name` — the
   basename of that same column — names the fork. Nothing else decides a fork's
   name; every other place that spells one out is a **copy**, and there are two
   that matter: `sync/src/config.js`'s `REPO_NAMES`, which decides the repos the
   poller reads score comments from, and `apps/web/src/lib/apps.ts`'s, which
   builds the fork links contestants click.

   Both copies are pinned to the tsv by a differential test on each side
   (`sync/test/repo-names.differential.test.js`,
   `apps/web/src/lib/__tests__/apps-repo-names.differential.test.ts`), and
   `setup/test/ctf_setup.bats` pins the derivation itself. That matters because
   the drift is silent in both directions: a wrong name gives contestants a fork
   link that 404s, or — quieter — leaves the poller watching a repo nobody
   opens PRs against, so scoring stops for that target while every service
   still looks healthy. **A module adding a target adds it to `targets.tsv`
   first**, and updates the copies to match; changing a copy alone is the bug
   the tests exist to catch (issue #149).
2. **Render + commit** the scoring workflow: `cmd_org` renders the in-repo
   template (`scorer/consumer-workflow.example.yml`) per target —
   substituting the event org, the target id, and a default `APP_URL` — and
   commits it as `.github/workflows/ctf-score.yml` on each forked repo's
   `ctf` branch, then disables the fork's inherited workflows. No manual
   install step. The standalone `render` subcommand writes the same files to
   `dist/workflows/<target>.ctf-score.yml` for offline inspection or a
   manual-commit fallback, without committing (no upstream access either way).
3. **Mirror** the scorer image into the event org's own private GHCR
   (`docker pull` whatever `SCORE_IMAGE` names — the organizer's own
   image; there is no upstream default — then `docker tag`/`docker push`
   to `ghcr.io/$org/score:latest`) so forked repos' Actions can pull it
   with their own `GITHUB_TOKEN` rather than organizer credentials.
4. **Teardown**: `gh repo archive "$org/$r" --yes` for every target repo,
   plus a manual reminder to uninstall the GitHub App and delete org
   Actions secrets — `ctf-setup.sh` does not do this automatically.

A new module MUST document its own equivalent of steps 1–4: what it forks
or provisions per event, what workflow/credentials it installs, and what
must be archived or revoked in teardown. The requirement that matters more
than the specific mechanism: **everything a module provisions for an event
MUST be archivable or revocable after the event** — nothing should persist
or keep working once the event org is torn down. `secure-development`
satisfies this because every provisioned artifact (forked repo, mirrored
image, installed workflow) lives entirely inside the disposable per-event
org.

## Section 8. Versioning

Targets MUST be pinned to exact versions/digests — never `:latest`.
`secure-development` inherits this from its upstream: the event org's fork
of each target is "pinned to the canonical vulnerable version" (the
upstream `OWASP-CTF/<target>` repo already sits at a known-vulnerable
commit; `gh repo fork` copies that state as-is, so the fork "inherits the
correct pinned vulnerable version" rather than tracking upstream `HEAD`).

The reason this is load-bearing, not cosmetic: the scoring rubric is
regression tests written against a specific vulnerable version. If a
target silently moved to `:latest` or rebased onto a newer upstream commit,
an unrelated upstream fix could patch a vulnerability the rubric still
expects to be exploitable — deflating every contestant's score on that
challenge to zero regardless of their actual patch — or, in the other
direction, an upstream regression could reintroduce a vuln the rubric
already assumes is gone, inflating scores for a patch nobody wrote. Pinning
the target version is what keeps "score reflects patch quality" true. A new
module MUST pin its targets the same way and MUST NOT configure any target
or scoring dependency (image, base repo, library) to float on `:latest` or
an unpinned branch.

(Note: the *scorer* image is whatever `SCORE_IMAGE` names — your own build;
`docker-compose.yml` keeps `ghcr.io/owasp-ctf/score:latest` only as a
parse-time fallback the kit does not assume access to. Either way it is a
platform-level concern, not a module-authored target, and separate from the
target version pinning above. The reference
implementation of the scorer contract lives in this repo at `scorer/` —
one image, serve + judge modes — and [docs/scorer.md](scorer.md) documents
authoring a rubric and building your own image against it.)

## Section 9. Adding a module: files you will touch

A new vertical is a code change, not config alone (§1.2). Today its definition
is not yet co-located in one directory (a tracked follow-up — the scorer, sync,
and app are separately built images, so a single shared manifest needs a
build-time vendoring step first). Until then, a new module `<name>` with target
`<t>` touches:

| File | What to add |
|---|---|
| `sync/src/config.js` | add `<t>` to `TARGETS` + `REPO_NAMES` (sync has no module list — see §1.3) |
| `apps/web/src/lib/modules.ts` | register the module's display name / description |
| `apps/web/src/lib/apps.ts` | add `<t>` to `AppId` / `REPO_NAMES` / `apps[]` |
| `scorer/src/targets.js` | add `<t>`'s scoring shape (`name` / `catalogueFile` / `byName` / `defaultConcurrency` / `urlEnv`) |
| `scorer/entrypoints/<t>.sh` | the target's bring-up |
| `scorer/rubric.owasp/<t>/` | the vendored rubric, with its catalogue at `tests/challenges/catalogue.<t>.json` |
| `setup/ctf-setup.sh` | the module's own provisioning step, if it has one (§7) |
| `apps/web/src/lib/metrics-store.ts` | add `<name>` to the per-login read list, the `earnedRows` fold and the `modules` split, or Insights reports nothing for it (§10.4) |
| `apps/web/src/lib/activity-keys.ts` | add a `<name>-solve` type and call `logActivity` from the module's submit route on FRESH solves only (id in `detail`, never the answer), or the admin Activity tab never sees the module |
| README target table + [docs/operations.md](operations.md) | document the target for organizers |

Parity guards catch the most common drift: `scorer/test/targets.test.js`
(targets.js ↔ entrypoints ↔ rubric dirs) and `apps/web` `apps.test.ts` /
`apps-catalogue.test.ts` (apps.ts ↔ sync config ↔ catalogue). Run the full test
suite after adding a module — a mismatch across these lists fails loudly.

The table above is the worked example for a module with a **target and a
scorer** — the shape `secure-development` has. A module with no target and no
scorer-mediated scoring at all (`quiz`, and now `classic`) touches a
different, smaller set of files, since none of `scorer/`'s rows apply and
`setup/ctf-setup.sh`'s fork/render/mirror steps have nothing to do (§7).
`classic`'s actual footprint in this PR:

| File | What it added |
|---|---|
| `apps/web/src/lib/classic-keys.ts` | key names/builders, the flag comparison forms (`normalizeFlag`, `caseSensitiveFlagForm`, `flagComparisonForm`), challenge-id generation — dependency-free, shared by the client-side admin form and the server-only store |
| `apps/web/src/lib/classic-store.ts` | the module's own `ctf:classic:*` Redis store, its atomic flag-grading Lua script, and the admin/contestant secrecy split |
| `apps/web/src/lib/markdown.ts` + `apps/web/src/components/markdown.tsx` | the restricted Markdown parser and its node-tree-to-React renderer for challenge descriptions |
| `apps/web/src/app/api/classic/submit/route.ts` + `apps/web/src/app/api/admin/classic/route.ts` | the flag-submission and organizer-authoring wire contract |
| `apps/web/src/app/(site)/flags/page.tsx` + `apps/web/src/components/challenge-board.tsx` + `apps/web/src/components/challenge-detail.tsx` | the contestant-facing board and the challenge page it links to (both shared with `ai`, parameterised by `basePath`) |
| `apps/web/src/components/admin-classic-controls.tsx` | the organizer's cooldown knob, category manager, and challenge authoring UI |
| `apps/web/src/lib/leaderboard/module-contributions.ts` + `apps/web/src/lib/leaderboard/team-fold.ts` | the leaderboard overlay (points added, never attributed) and the union-by-item team dedupe it shares with `quiz` |
| `apps/web/src/lib/modules.ts` | register display name/description/nav plus the `home`/`guide`/`rules`/`faq`/`terms`/`routeCard` copy blocks (§5.5–5.7) |
| `README.md` | document the module |

`ai`'s actual footprint in this PR series — a module shaped like `classic`
(no target, no scorer, app-side grading) but with an external launch step and
two independent ways to report a solve back:

| File | What it added |
|---|---|
| `apps/web/src/lib/ai-keys.ts` | key names/builders, challenge-id generation, the `AiMode` shape, `validateUrlTemplate` — dependency-free, shared by the admin form and the server-only store (`HintTarget` itself lives in `hint-store.ts`, below) |
| `apps/web/src/lib/ai-defaults.ts` | the module's shared constants (`AI_COOLDOWN_SEC`, …) the server and the admin UI both need, so neither can drift from the other |
| `apps/web/src/lib/ai-token.ts` | the launch token: EdDSA/Ed25519 signing and verification (`signLaunchToken`), plus the HMAC signing helper for a `mode: "event"` solve report (`signEventBody`) — see [ADR 53](decisions.md#adr-53-ai-launch-tokens-are-asymmetric-event-signatures-stay-symmetric) for why the two are different key types |
| `apps/web/src/lib/ai-store.ts` | the module's own `ctf:ai:*` Redis store — challenges, the per-challenge signing keys and the one module-wide launch keypair, flag grading, hints — and the admin/contestant secrecy split |
| `apps/web/src/lib/ai-launch.ts` | building a launch URL from a challenge's `urlTemplate` and a minted token (`mintLaunchUrl`/`buildLaunchClaims`) |
| `apps/web/src/lib/ai-http.ts` | shared request/response helpers for the four contestant-facing `/api/ai/*` routes |
| `apps/web/src/lib/app-origin.ts` | the launch token's `iss` — the app's own configured origin, never a request's `Host` header |
| `apps/web/src/app/(site)/ai/page.tsx` + `not-found.tsx` | the contestant-facing board (a 404 when the module is disabled, same gate `/flags` and `/quiz` already run) |
| `apps/web/src/app/(site)/ai/[id]/page.tsx` + `layout.tsx` + `not-found.tsx` + `actions.ts` | the challenge page: the launcher (mints a personal launch URL server-side) and, for a `flag`/`both` challenge, the in-box flag form |
| `apps/web/src/app/api/ai/launch-key/route.ts`, `.../submit/route.ts`, `.../state/route.ts`, `.../event/route.ts` | the four contestant-facing routes: publish the launch public key, grade a typed flag, read a login's own progress, and accept an external site's signed solve event |
| `apps/web/src/app/api/admin/ai/route.ts` + `.../test/route.ts` | the organizer-authoring wire contract, plus the "Send test" route that calls the real `/api/ai/event` handler in-process with `dryRun: true` |
| `apps/web/src/components/admin-ai-controls.tsx` + `admin-ai-integration.tsx` | the organizer's challenge authoring UI (mode, launch URL, categories, hint, `order`) and cooldown knob, plus the per-challenge integration panel (endpoint URLs, the masked signing key with reveal/rotate, a ready-to-run test curl, and the Send test button) |
| `apps/web/src/app/(site)/flags/page.tsx` + `apps/web/src/components/challenge-board.tsx` + `apps/web/src/components/challenge-detail.tsx` | the contestant-facing board and challenge page `ai` shares with `classic`, parameterised by `basePath` (already listed in `classic`'s row above — no separate copy for `ai`) |
| `apps/web/src/components/hint-reveal-button.tsx` | extended to cover an `ai` hint purchase alongside secure-development's and classic's |
| `apps/web/src/lib/hint-store.ts` | `ai` added to `HintTarget`; the anti-burner solve-count gate reads `ai`'s whole-board solve count the same way it reads `classic`'s |
| `apps/web/src/lib/leaderboard/module-contributions.ts` | the leaderboard overlay's `ai` case — points added, never attributed, same verb as `quiz`/`classic` |
| `apps/web/src/lib/metrics-store.ts` | `ai` added to the per-login read list, the `earnedRows` fold and the `modules` split, so Insights reports on it (§10.4) |
| `apps/web/src/lib/activity-keys.ts` | an `ai-solve` activity type, logged on fresh solves only |
| `apps/web/src/lib/admin-store.ts` | the `aiCooldownSec` runtime setting (validated, capped at `AI_COOLDOWN_SEC_MAX`) and the module's rows in `resetEvent`'s PROGRESS/CONTENT split |
| `apps/web/src/lib/demo-fixture.ts` | demo seed data for the `ai` board, gated the same way `quiz`'s and `classic`'s are — a disabled `ai` module leaves the seed byte-for-byte identical to pre-`ai` behavior |
| `apps/web/src/lib/modules.ts` | register display name/description/nav plus the `home`/`guide`/`rules`/`faq`/`terms`/`routeCard` copy blocks (§5.5–5.7) |
| `docs/decisions.md` | [ADR 53](decisions.md#adr-53-ai-launch-tokens-are-asymmetric-event-signatures-stay-symmetric) — why the launch token is asymmetric while event signatures stay symmetric |
| `docs/ai-module.md` + `README.md` | the external integrator's contract, and documenting the module for organizers |

`ai` has no per-tab bulk import/export button of its own, unlike `quiz` and
`classic` (§5), but its catalogue does ride the whole-event archive bundle,
in its own bundle format (`ai-io.ts`, exported and imported through
`event-store.ts` — #155's `ai` half, closed by #250).

Nothing under `scorer/` or `scorer/rubric.owasp/` changes for a module shaped
this way — there is no target, no rubric, and no catalogue for the scorer to
know about.

## Section 10. Engagement-metrics contract (Insights)

The **Insights** tab (`GET /api/admin/metrics`, ADR 50) reports participation,
per-challenge difficulty, solves over time and hint usage. It has **no
collection step and no write path of its own**: every figure is a read over
keys the modules already maintain. That is the design constraint the rest of
this section follows from — Insights can only report what a module already
stores, in the shape it already stores it, and adding a metric is never a
reason to add a tracking write.

See [docs/operations.md](operations.md#organizer-admin-panel) for what each
figure means to an organizer and [docs/architecture.md](architecture.md#engagement-metrics-adr-50)
for the fold itself.

### 10.1 What a module must store to be measurable

Two per-login hashes, both keyed by **lowercased** GitHub login, both with the
**item id** as the field. A module that keeps them gets the full per-challenge
table for free; a module that keeps neither is still counted in participation
and points, and appears nowhere else.

| Hash | Field | Value | What it drives |
|---|---|---|---|
| `ctf:<module>:<earned>:<login>` — `ctf:quiz:answers:<login>`, `ctf:classic:solves:<login>` | item id | `{"points":<n>,"at":"<iso>"}` — the fields the fold reads; a module may store more (quiz rows also carry `choices`) | `scored`, the solves-over-time timeline, per-challenge `solves`, and the numerator of `solveRate` |
| `ctf:<module>:attempts:<login>` | item id | `{"attempts":<n>,"firstAt":"<iso>","lastAt":"<iso>","lastAtMs":<ms>}` | `attempted` and `stuck`, per-challenge `attempts`, `avgAttemptsToSolve`, `medianSecondsToSolve` |

Plus one aggregate the leaderboard already requires:

| Key | Field | Value | What it drives |
|---|---|---|---|
| `ctf:<module>:points` | login | integer | the per-module scorer split, and the per-team point sum |

Three rules about those rows, each of which has cost this repo a wrong number:

1. **`at` is when the item was EARNED**, not when the row was written. The
   timeline buckets on it, so a row stamped at import or seed time moves a
   solve to the wrong ten minutes.
2. **`firstAt` is the FIRST attempt and is carried forward** across every
   later attempt — all three modules' Lua scripts re-read the existing row and
   keep the original (`quiz-store.ts` / `classic-store.ts` / `ai-store.ts`,
   `if not firstAt then firstAt = ARGV[…] end`). It is what makes time-to-solve knowable at all;
   overwriting it each try silently turns every duration into zero.
3. **The attempt row must survive the solve.** `avgAttemptsToSolve` and
   `medianSecondsToSolve` are computed *after* the fact, by matching the
   earned row against the attempt row for the same id. Clearing attempts on
   success destroys both figures and leaves the challenge looking
   first-try-easy.

Parse attempt rows with **`apps/web/src/lib/attempt-row.ts`**, never with
`Number(value)`. The row is JSON; `Number()` on it is `NaN`, which is how the
Support tab reported "0 attempts" for every contestant for two releases
without anything failing.

### 10.2 Item ids are the join key

Per-challenge stats are keyed `<module>:<item id>`, and the earned row and the
attempt row are matched by that id. This is the same stability rule as §4.3 and
for a second reason: renaming an id does not just orphan provenance, it splits
one challenge into two rows in the difficulty table — one with attempts and no
solves, one with solves and no attempts.

Ids must also be **unique within the module**. They do not need to be unique
across modules (the `<module>:` prefix separates them), but anything that
matches rows across two namespaces must carry both parts of the key —
`readSecureDevSolves` keeps the target in `<target>/<login>/<challengeId>`
precisely because challenge ids are unique within a target's catalogue and
nothing makes them unique between targets.

### 10.3 A module with no per-item rows

`secure-development` is this case, and it is a legitimate one. Its scores
arrive from GitHub already judged: there is a timestamped solve
(`ctf:solves:<target>`, field `<login>:<challengeId>`) but no attempt record,
because the attempts happened in a fork the box deliberately does not measure.
It therefore contributes to participation, points and hint ordering, and
contributes **nothing** to the per-challenge difficulty table or the timeline.

That absence is stated in the payload's own `caveats[]` rather than left to be
inferred from an empty row. **A module that cannot supply a figure must make
the gap visible, not render zero** — a blank cell reads as "no data", a zero
reads as "measured, and none".

### 10.4 Registration is NOT automatic

Adding a module does not add it to Insights. `computeEventMetrics`
(`apps/web/src/lib/metrics-store.ts`) names quiz, classic and ai explicitly — the
per-login read list, the `earnedRows` pair it folds, and the `modules` split in
the response. A new module with both hashes still reports nothing until it is
added in those three places.

This is deliberate for now: the fold issues a fixed number of reads per
contestant, and a registry-driven version would make that number depend on how
many modules an event enables. It is a **known limitation**, recorded here so
the next module author finds it in the contract rather than in an empty tab.

### 10.5 What a module must NOT do

- **Do not collect from forks.** A fork can report far more — pages opened,
  time on a challenge, when someone gave up — and none of it credibly.
  Authenticating a fork means a credential every contestant can read, so any
  ingest endpoint is forgeable by the very people being measured. Engagement
  numbers a participant can inflate are worse than numbers that are merely
  incomplete. ADR 46's read-only, policy-only rule for `/api/public/scoring` is
  the other side of the same boundary.
- **Do not add a write purely to feed a metric.** If a figure needs a new
  write, it needs a decision record first: every per-contestant field added is
  one edit away from making an admin payload carry a login.
- **Do not read a module's aggregate counter where a fold over per-login rows
  will do.** `ctf:classic:solvecount` and `ctf:ai:solvecount` exist and would
  be free per-module shortcuts; the fold deliberately ignores them, because
  folding per-login rows produces the same figure for **all three** app-scored
  modules from one source. Reading both invites the two to disagree with no
  way to tell which is right.
