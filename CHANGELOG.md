# Changelog

Releases are repo-level annotated tags cut from `main`
([SemVer](https://semver.org/)); GitHub Releases carry the generated
commit-level notes, and this file keeps the human summary. The version is
repo-level — `apps/web/package.json` tracks the current tag; `scorer` and
`sync` deliberately carry no version field.

## Unreleased

### Changes

- **Changed: a paid hint confirms before it charges, and acknowledges the
  cost afterward (#550).** The challenge page's **Reveal hint** button now
  opens a **Confirm / Cancel** step on the first press instead of charging
  immediately — an accidental click no longer spends points — and once the
  hint is revealed the block shows "−N pts spent" so the deduction is
  acknowledged in place rather than discovered later on the leaderboard. The
  in-row Secure Development hint chip already worked this way; this brings the
  single-challenge control in line.

- **Changed: the leaderboard explains its ~1-minute score cadence (#552).** On
  an event that runs Secure Development, a one-line note tells contestants that
  SD points and team totals land on the next scoring sweep (about once a
  minute), so a solve — or a teammate who just joined — can take a moment to
  appear, rather than reading as a broken board. Events that don't run Secure
  Development don't show it — every other module (classic, quiz, ai) folds
  app-side and updates live.

- **Changed: the default quiz retry cooldown is now 1 minute, down from 5
  (#549).** A wrong answer used to lock a question for five minutes (with a
  three-attempt cap); the default is now one minute, which still deters rapid
  guessing on few-option questions without a long lockout after an honest
  wrong guess. Organizers can still set any value in /admin → Quiz; only the
  baked default changed.

- **Changed: an event names its time zone, and every date and time follows
  it (#547).** A new **Timezone** field in /admin → Event → Identity
  (`eventTimeZone`, an IANA zone; blank = UTC) sets the clock for the landing
  page's dates line, the phase line ("scoring opens Oct 3, 9:00 AM GMT-3"),
  the score chart's time axis and the four /admin schedule inputs. Those
  inputs now read the event's clock, not the organizer's browser — **on a box
  with no zone set they are UTC**, where they used to be the browser's local
  time. Bounds are still stored as ISO instants, so scoring is unchanged;
  countdowns and the admin ops stamps (Insights, Support) are as before. The
  event archive carries the zone like the location.

- **Changed: the landing page's event logo is larger and can link to the
  event's own site (#545).** From `sm` up the hero logo's box grows to 224 px
  tall and 32 rem wide (phones keep 144 px). A new **Logo link** field in
  /admin → Event → Identity (`eventLogoUrl`, https only, no credentials,
  ≤2048 characters) makes the logo open that page in a new tab; blank leaves
  it unlinked, as before. The OWASP credit keeps its own link, and the event
  archive carries the logo link with the logo.

- **Changed: the projector board shows the event's logo and a clock, and the
  landing page's main button is back above the fold (#543).** The projector
  view (`/leaderboard?display=1`) puts the uploaded event logo beside the name
  and adds a clock read from the scoring window: "starts in …" before scoring
  opens, "ends in …" while it is open, "final" after it closes, and "not
  launched" until a start is set. On the landing page the sponsor strip moves
  below the primary button, and the hero has less padding on top.

- **Security: the app, sync and scorer images move to a patched Alpine base
  (#539).** All three pinned a `node:22-alpine` digest whose OpenSSL
  (`libssl3`/`libcrypto3` 3.5.7-r0) carries 2 critical and 7 high CVEs, as
  reported by ECR's scan of a live deploy. The pin moves to a digest with
  3.5.8-r0 (Alpine 3.24.2, Node 22.23.3), still pinned by digest. Rebuild and
  redeploy to pick it up: on AWS `./deploy.sh` and `terraform apply`, on Fly
  `deploy/fly/deploy.sh`. On a Secure Development event, also rebuild the
  scorer image (`docker build --platform linux/amd64 -t <SCORE_IMAGE> scorer/`)
  and push it; the deploy then mirrors the new digest.

- **Changed: an uploaded event logo leads the hero at full size (#538).** It
  was held to a fixed 80 px height, so a portrait or square badge rendered as
  an icon (a 482×603 logo showed at 64×80). It now fills a box up to 192 px
  tall and 24 rem wide (144 px on phones), whatever its shape. The OWASP mark
  beside it is smaller, captioned "Built with OWASP CTF in a Box" and linked
  to the project. With no logo uploaded, the hero is unchanged.

- **Security: brace-expansion patched in the app's dev toolchain
  (GHSA-q2hr-2g5m-vwhr, Dependabot alerts #20 and #21).** Both copies the
  lockfile resolves are bumped: 1.1.18 → 1.1.21, and 5.0.9 → 5.0.12 through a
  scoped `pnpm-workspace.yaml` override (pinned exactly, `5.0.12`), since pnpm keeps 5.0.9 within
  minimatch's own range. Lint-time only (eslint → minimatch); nothing in the
  served app changes. Supersedes Dependabot #517, which bumped only the 1.x
  copy.

- **Added: an event logo and favicon, set in `/admin` → Event (#529).**
  Organizers can upload a logo (PNG, JPEG or WebP, up to 128 KB) that leads
  the landing page's hero, with a smaller OWASP mark kept beside it, and a
  favicon (a square PNG, 32–512 px). **Restore default** puts the built-in
  ones back. The files' real bytes are checked and SVG is refused; both are
  served from the box itself, kept by a master reset, and carried by the
  event archive. No rebuild is needed to brand an event any more.

- **Fixed: the AWS module's first `terraform apply` no longer comes up with
  no route to Redis (#530).** Six security group rule descriptions were
  written `app -> srh`, and EC2 refuses `>` in a rule description. Those
  rules failed to create, including the only ingress to ElastiCache, so srh
  could not reach Redis and the ECS deployment stopped with "No rollback
  candidate". They now read `app to srh`. A new check in the Terraform
  workflow fails any security group or rule description EC2 would refuse,
  since `validate` and the mocked `terraform test` never call EC2.

- **Added: srh, scorer and sync task sizes are AWS Terraform variables (#531).**
  `srh_cpu`, `srh_memory`, `srh_desired_count`, `scorer_cpu`,
  `scorer_memory`, `sync_cpu` and `sync_memory` join the app's existing
  three. The defaults are the sizes every deploy already runs, so nothing
  changes unless you set them. A CPU/memory pair Fargate does not run (for the
  app too) is refused at plan, and `srh_desired_count` must stay at 2 or
  more. The module README has a sizing note for a bigger event.

- **Fixed: a Redis error reply no longer reads as an empty answer on six more
  paths (#499).** `upstashPipeline` returns a per-command error instead of
  throwing, and these reads ignored it. A contestant's team check (`hasTeam`)
  refused live submissions on a Redis fault even though it is meant to let
  them through. Leaving a team reported success when nothing happened. A valid
  join code was called "invalid or expired", both on the join page and when
  joining. `/admin` and `/health/deep` showed "no sync heartbeat", and the
  stored-admins list and the Secure Development board read as empty. Each one
  now throws or says the read failed, so the caller's documented fail
  direction applies and the log names the read.

- **Fixed: three `ctf-setup.sh` answers organizers read before launch
  (#496).** `doctor` (and `launch`'s pre-flight) no longer reports a
  fork's scorer-image grant as verified when its newest scoring run could not
  be read and only an older run had pulled the image. `doctor` no longer
  tells you to run `private` for a public fork that contestants have already
  forked, which `private` skips on purpose. "1 forks" now reads "1 fork". And
  `doctor --dry-run` makes no `gh` calls at all, as every `--dry-run`
  promises: it lists what it would check instead. A grant GitHub would not
  answer for is now a ❌ that fails `doctor`'s exit, not a quiet "unverified",
  and a `GITHUB_APP_ID` that is not a positive number is reported before any
  call.

- **Fixed: a failed Redis read no longer zeroes quiz, Jeopardy or AI points
  in silence (#523).** The per-contestant totals, and the hint-penalty total,
  read their hashes without checking the reply's error, so a `WRONGTYPE`,
  `NOAUTH` or timeout read as "nobody has points" (or "nobody bought a hint"):
  the board re-ranked on the missing points and nothing was logged. They now
  throw, so the leaderboard logs which read failed and leaves that module (or
  the penalties) off the board, as it already did for a read that threw.

- **Changed: the individual leaderboard ranks by points first (#522).**
  Organizers, note this before an event: the order is now points, then items
  completed across modules (a tiebreak only), then whoever got there first.
  Until now items came first, so a contestant with many cheap solves
  outranked one with more points, and the individual view disagreed with the
  team view and the scorer's own board, which already rank by points. The
  board's sort chips are now `points` (the default, the standing order) and
  `solved`; the `rank` chip is gone because it repeated `points`. Rules and
  FAQ now state the order.

- **Fixed: "whoever got there first" now holds for quiz, Jeopardy and AI (#522).**
  The leaderboard breaks a points-and-items tie on each contestant's latest
  award time, but only Secure Development solves carried one: the quiz,
  Jeopardy and AI totals had no time at all, so a tie between two contestants
  who scored there fell back to an arbitrary order, and a later quiz answer
  never counted as activity. Each module's grading script now records the
  award time in `ctf:quiz:lastAt` / `ctf:classic:lastAt` / `ctf:ai:lastAt` in
  the same call that updates the totals, and the event reset, a contestant's
  progress reset and the demo seed and clear keep it in step. Points scored
  before the upgrade have no time until that contestant's next award. A failed
  read of the new hash logs and drops only the tiebreak, never the points.
  `scripts/load-seed.mjs` seeds the new hashes and `scripts/score-audit.mjs`
  reads them, so its tiebreak model matches the board's.

- **Fixed: team totals counted quiz, Jeopardy and AI points twice (#520).**
  On any board whose source reports its own teams (the scorer, i.e. every
  event running Secure Development), each team's total added its quiz,
  Jeopardy and AI points once in `withModuleContributions` and again in
  `withTeamStandings`. A team at 58 Secure Development points plus 2050
  app-side points was served 4158 instead of 2108. The module chips on an
  expanded team row were right (each pass wrote the same value), and
  contestant rows were unaffected. Because the error scaled with each team's
  app-side points, a team strong in Quiz/Jeopardy/AI could rank above a team
  that had more points: the **team ranking was wrong, not just the numbers**,
  on the public board, the display board and the profile's Team progress
  panel. Membership-only teams (not known to the scorer) were counted
  correctly. Present since v0.6.0 (#414). Teams now get their app-side points
  in `withTeamStandings` alone, also when the team store is empty or cannot
  be read. The same fix gives a team's Jeopardy chip the right denominator:
  challenges solved before they were deleted now count in it, as they
  already did for Quiz and AI (#350).

- **Added: a read-only score auditor.** `scripts/score-audit.sh --app
  <fly-app>` runs `scripts/score-audit.mjs` inside the app container: it
  recomputes every contestant's and every team's score, per module and
  overall, with ranks, from the raw Redis rows — a second implementation of
  the documented rules, importing none of the app's fold code — and diffs it
  against the `data` the `/leaderboard` page actually serves (its RSC flight
  payload). It sends only read-only Redis commands (anything else is refused
  before it is sent), fails loudly on a payload shape it does not recognise,
  refuses a vacuous comparison, and exits 0 only on zero mismatches. See
  [Checking score consistency](docs/operations.md#checking-score-consistency-scriptsscore-auditsh).
- **Fixed: the load-test seeder read which modules are live from a field
  nothing writes.** `scripts/load-seed.mjs` parsed a JSON `enabledModuleIds`,
  but the app stores `enabledModules` as a comma list, so every module always
  read as live and a seed attached points to boards that were switched off.
  It now reads the real field with the app's default (absent = Secure
  Development iff `SCORE_IMAGE`, empty = none) and refuses to seed on a list
  holding anything but known module ids. Its test suite now runs in CI.
- **Changed: `scripts/load-test.sh` deletes the seeder it uploaded** to the
  container's `/tmp` on every exit path, without changing the exit status.

## v0.7.0 — 2026-09-30

### Breaking changes

Six of them. Each has a full entry below with the reasoning and the steps;
this is the index an upgrader reads first.

- **Every event needs an official launch (#464).** An empty Scoring opens now
  means *not launched*: nothing scores, and every module page and API is
  locked for non-admins until the event is launched. **After upgrading, press
  Launch in `/admin` → Event** (or set Scoring opens), or the box stays closed.
- **The pre-event password gate is removed (#464).** The launch lock replaces
  it, and its `CHALLENGES_GATE_*` keys are no longer read; see the next item.
- **The v0.7 migration shims are gone (#503).** Delete, by hand, any leftover
  `SCORE_INGEST`, `CHALLENGES_GATE_ENABLED` and `CHALLENGES_GATE_PASSWORD`
  lines in `.env` / `.env.fly`, and the `LEADERBOARD_URL` /
  `LEADERBOARD_TOKEN` org Actions secrets: `doctor` no longer reports them.
- **Event bundles are version 2 (#463, #186).** An export from this release
  carries `stories` (and `attachments` when a challenge has files); a box on
  v0.6.0 or earlier refuses it. Upgrade the destination box first.
- **Switching a module off stops its grading (#495).** Quiz, Jeopardy and AI
  grading routes answer `403 {"error": "unavailable"}` while the module is
  off, including the external AI site's `POST /api/ai/submit` and
  `POST /api/ai/event` (see `docs/ai-module.md` §7).
- **The AWS module's inputs changed (#476).** An existing `terraform.tfvars`
  needs `github_client_id` (and `github_app_id` with Secure Development),
  new SSM secrets, and the image placeholders from
  `terraform.tfvars.example`; `docs/aws.md` has the commands.

### Changes

- **An import's "bundle version is newer" error no longer repeats the
  submitted version.** It states the rule (the supported range) like every
  other import error since #515.

- **Breaking: the v0.7 migration shims are removed (#503).** v0.6 kept a few
  one-release aids for keys and secrets that push ingest (#377) and the
  password gate (#464) left behind. They are gone:
  - `ctf-setup.sh doctor` no longer names a leftover `SCORE_INGEST` line or
    `CHALLENGES_GATE_ENABLED` / `CHALLENGES_GATE_PASSWORD` keys in `.env`,
    and no longer reads the org's Actions secrets to look for
    `LEADERBOARD_URL` / `LEADERBOARD_TOKEN`. It makes no
    `orgs/<org>/actions/secrets` call at all now.
  - The Secure Development setup checklist in `/admin` drops its "Nothing to
    configure for the transport" step.
  - `scripts/acceptance-scorer.sh` no longer runs the judge a second time
    with `SCORE_API`/`SCORE_TOKEN` set to prove them inert.
  - Test-only: `apps/web/src/test/enabled-modules-baked.ts`, which mimicked
    the deleted `event.yaml` bake by reading the module set off a fake
    `isModuleEnabled` export, is replaced by `enabled-modules-mock.ts`. Each
    of the 56 suites now states its live module set in its own mock.

  Nothing reads any of those keys or secrets, and nothing did in v0.6
  either: a box still boots with them. What changes is that nobody tells you
  they are there. **Upgrading from v0.5 or earlier straight to this release:**
  delete any `SCORE_INGEST`, `CHALLENGES_GATE_ENABLED` and
  `CHALLENGES_GATE_PASSWORD` line from `.env` (and `.env.fly`), and delete
  the `LEADERBOARD_URL` / `LEADERBOARD_TOKEN` Actions secrets from the event
  org (Settings → Secrets and variables → Actions). Those two secrets are
  readable by every run a contestant's pull request triggers. The event is
  locked until you press **Launch** in `/admin` → Event; the password gate
  those keys set is not coming back.

- **The remaining log and import-error echoes name the label and the
  position, never the value (#500 follow-up).** The server-side `catch` sites
  #510 left alone (the leaderboard overlays, the challenge catalogue fetch,
  the activity log, the launch lock and AI preview check, the rate limiter,
  the country counter, the attachment download and six `/api/admin/*` routes)
  now log the shared `errorLabel(err)` instead of the caught value, so a
  driver-decorated error or a thrown string cannot carry a request into the
  log. The quiz, Jeopardy, AI, sponsors and event-archive import validators
  no longer repeat a submitted value or key name in their messages: an error
  names the indexed position and the rule, e.g. `questions[3].correct[1]`,
  "must be one of this question's choice ids", and a duplicate names the
  earlier position it collides with. Admins see different import-error text;
  no import that passed before is refused, and none that failed now passes.

- **Team join codes draw every symbol uniformly (#435).** A join code's six
  symbols were `randomBytes` values reduced `% 31`, and 256 is not a multiple
  of 31, so the first eight symbols of the alphabet came up 9/256 of the time
  and the other 23 at 8/256 (CodeQL `js/biased-cryptographic-random`, high).
  The loss was about 0.012 bits over a whole code, but the alert stayed open
  on every PR. Each symbol is now `randomInt(0, 31)` from `node:crypto`, which
  rejection-samples. The alphabet, length and format are unchanged, and
  existing codes keep working.

- **sync's cursor now lives in Redis (`ctf:sync:state`).** Before, it lived
  only in `state.json` on sync's disk, so a restart on Fargate (or any sync
  container recreated without its volume) re-read every score comment.
  Nothing was double-counted, but Secure Development solves removed by a
  per-contestant reset came back, and `/admin`'s ingested/dropped counters
  went back to 0.
  - The cursor, seen cache, counters and reset epoch are read at startup and
    written after every tick. A restart resumes where it stopped.
  - If Redis cannot be read at startup, sync **holds**: it logs
    `cannot load poll state from Redis (ctf:sync:state) … not polling until it
    is readable` and retries each poll interval, instead of starting from an
    empty cursor.
  - **Upgrade:** the first boot copies an existing `STATE_PATH` file into
    Redis and renames it `state.json.migrated`. No action needed. The compose
    `sync-state` volume and the Fly `STATE_PATH` stay, for that migration and
    for a sync run with no Redis client.
  - See ADR 64.

- **The empty board says nobody has scored yet (#482).** Searching a board with no scored contestants used to answer with the spelling nudge, which is wrong when there is nobody to check the spelling against. A typed query now reads "Nobody has scored yet" instead, and only the empty search box still draws the "board is wide open" podium. Covered by regression tests on the board-state helpers.

- **Switching a module off stops its grading (#495).** Turning Quiz,
  Jeopardy or AI off in `/admin` hid the board but left its grading routes
  live: `POST /api/quiz/answer`, `POST /api/classic/submit`, and the AI
  module's token-authenticated `POST /api/ai/submit` and `POST /api/ai/event`.
  An answer from an already-open tab, a curl, or the external AI challenge
  site still banked points that reappeared on re-enable. All four now refuse
  with `403 {"error": "unavailable"}` as their first check, before any
  session, token, signature or key is read, the same gate the AI module's
  in-box submit action already had. An admin preview or an AI `dryRun` is
  refused too. External AI integrators: the new 403 is in the
  error table, `docs/ai-module.md` §7.

- **Dependency refresh: Next.js 16.3.6, `@types/node` 26.6.2, Caddy image
  digest.** `next` and `eslint-config-next` move 16.3.5 → 16.3.6, the fix for
  GHSA-vcvr-r3jv-pc5j (remote code execution in `next/og`'s
  `ImageResponse`). The app does not use `next/og` or `ImageResponse`, so it
  was not exploitable here; the bump is hygiene. `@types/node` moves to
  26.6.2 in the lockfile, and `docker-compose.yml` pins the current
  `caddy:2-alpine` digest (Caddy 2.11.4).

- **Security headers on every deployment (audit S1).** The app now sends
  `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`,
  `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and HSTS on
  every response, and no longer sends `X-Powered-By`. Before this only Caddy
  set them, so AWS and Fly boxes, which run no Caddy, sent none. Caddy keeps
  the same values as a deferred defence-in-depth block, and a test fails if
  the two drift apart.

- **Event-archive imports over 10 MB work (audit S2).** The Next proxy cut
  every request body at 10 MB, so an archive with more than about 7 MB of
  attachments failed with a bare "invalid request payload". The import route
  is now outside the proxy matcher and runs the proxy's cross-origin check
  itself. It accepts up to its documented cap of about 75 MB and refuses a
  larger body with a `413` that names the cap. See ADR 40.

- **Contribution gates (#483).** A PR that changes `apps/`, `sync/`,
  `scorer/`, `setup/` or `deploy/` now fails the `changelog` check without a
  CHANGELOG entry (test-only and `.md` paths are exempt; the `no-changelog`
  label skips it). PRs are labeled by path automatically, and a new
  CodeRabbit check warns on a behavior change that ships no test.
  CONTRIBUTING.md lists what a PR needs to pass.
- **Challenge files and links (#186).** A classic challenge can carry
  uploaded files (up to 5 MiB each, 50 MiB per event, 10 attachments per
  challenge) and external links.
  - Uploads are stored in Redis and served only to whoever can see the
    challenge, through the same visibility check as the challenge page. They
    are always served as a download, never rendered.
  - Links are marked as public to anyone with the URL.
  - Challenge bundles carry attachment metadata; the event archive carries
    the bytes, sha256-checked before an import replaces anything. A bundle
    that names a file the box lacks records it as missing until it is
    re-uploaded.
  - **Breaking for older boxes:** a bundle exported from a challenge with
    files carries an `attachments` list, which a box on an earlier release
    refuses (v0.6.0 and earlier already refuse any version 2 file, see
    stories below). Upgrade the destination box to this release or later
    before importing; a bundle with no files carries no `attachments` key.
  - The demo's two forensics challenges now ship a real synthetic pcap and
    JPEG. See ADR 61.

- **Classic stories (#463, part 1).** A story is an ordered chain of classic
  challenges that a team unlocks one step at a time.
  - Step N+1 opens once any teammate solves step N.
  - The board shows a lane per story above the categories, and a locked step
    appears only as "??? — step N of M".
  - Grading and hint reveal enforce the lock inside their Lua scripts,
    before reading any secret. A locked step costs nothing and is answered
    exactly like an unknown challenge.
  - A locked step's page, metadata and board-items entry reveal nothing.
  - See ADR 60.

- **Authoring stories, and bundle v2 (#463, part 2).**
  - A **Stories** block on the Jeopardy tab creates stories, orders their
    steps with ↑ / ↓, and saves the whole list in one request. The server
    refuses a step that names a missing challenge, and a challenge placed in
    two stories.
  - Challenge bundles are now **version 2** and carry a `stories` list.
    Import merges the stories by id, and a merge that would put one
    challenge in two stories refuses the whole file. Version 1 files still
    import unchanged.
  - **Breaking for older boxes:** an export from this version is stamped
    `"version": 2`, which a box running an earlier release refuses (it
    accepts only version 1). Export from the newer box only into a box on
    this release or later; a hand-made version 1 file (no `stories`) still
    imports everywhere.

- **Forks stay private until launch; `ctf-setup.sh launch` (#465).** `org`
  (and the new `private` subcommand) sets each detached Secure Development
  fork private while the event is not launched. On launch day,
  `ctf-setup.sh launch` checks every fork is detached and the scorer package
  private, waits for Launch in `/admin`, and only then makes every fork
  public.
  `doctor` warns about a fork that is public before launch or private after.

- **A Launch block in `/admin`.** The Event tab now shows **Not launched**,
  **Scheduled for …** or **Live since …**.
  - **Launch now** (with a confirmation) writes `scoringStartsAt: "now"`, and
    the server resolves that on its own clock.
  - **Un-launch** (a confirmed, dangerous action) clears the start. Solves
    already banked are kept.
  - **A master reset now returns the event to not launched.** Its script
    clears the scoring start in the same atomic step that freezes and
    audits.
  - **`/health/deep` reports `launched`**, and `ctf-setup.sh doctor` warns
    while the box is not launched.
  - This is the last PR of #464.

- **Admins preview the event before launch, with dry-run grading.** An admin
  who opens a module page before launch sees a **Preview — event not
  launched** banner, with a link to view the event as a contestant.
  - Their flags, quiz answers, AI flags and events, and hint reveals are
    graded by the same Lua scripts as a real submission. Each script takes a
    new trailing dry-run argument, compares as usual, and writes nothing:
    no solve, points, attempt, cooldown, solve count, hint charge or
    activity-log line.
  - The answer carries `dryRun: true`, and the UI says "preview only,
    nothing was recorded".
  - The AI module's launch token gains a signed `ctf.preview` claim for this
    case. The admin Send test mints its token that way before launch, so it
    can now reach **Would award**.
  - Part of #464.

- **Breaking: every event needs an official launch — an empty scoring start
  now means "not launched".** A blank `scoringStartsAt` used to mean "no
  bound, always open"; it now means nothing scores. That covers the app's
  flag, quiz and AI graders, and the scorer and `sync`, which hold Secure
  Development ingestion. Paid hint reveals are not gated by this change;
  #464's page lock covers them. The three readers change together
  through a new `outsideScoringWindow`, pinned by a shared corpus
  (`test/fixtures/scoring-window-corpus.json`). The registration window keeps
  its old meaning, so a blank bound there is still open. **After upgrading,
  set Scoring opens in `/admin` → Event**, or scoring stays closed. This is
  PR 1 of #464. The page lock, admin preview and a Launch button follow, and
  ADR 59 records the decision. CI now also runs all three suites when only a
  window corpus changes; before this, such an edit ran none of them.

- **Breaking: the pre-event password gate is removed; the launch lock
  replaces it.** Gone: the `CHALLENGES_GATE_ENABLED`/`CHALLENGES_GATE_PASSWORD`
  keys, the `/gate` page and `POST /api/gate`, the HMAC-signed unlock cookie,
  and the per-IP attempt throttle — the site now stores no IP address at all.
  In its place, until the event is launched (a Scoring opens that has passed)
  every module page — `/challenges`, `/flags`, `/quiz`, `/ai`, their detail
  pages, and `/leaderboard` — redirects a non-admin to `/` before loading any
  content, and the module APIs (`POST /api/classic/submit`,
  `/api/quiz/answer`, `/api/hints/reveal`, `GET /api/board/items`, and the ai
  module's in-box flag action, which also guards the launch-token mint)
  answer `403 { "error": "not-launched" }`, a refusal the classic, quiz and
  hint UIs name. Unlike the gate, it covers the APIs, it follows the one
  clock instead of a second switch, and admins browse every page as a
  preview. It fails closed: a settings or admin-check error counts as not
  launched. The landing page counts down to a scheduled start, or says
  "Launching soon." with none, and points signed-out visitors at forming a
  team while registration is open. `launch-guard-coverage.test.ts` fails if
  a module page or route lacks the guard. **After upgrading, delete any
  `CHALLENGES_GATE_*` lines from `.env`** — nothing reads them, and
  `ctf-setup.sh doctor` names them. Part of #464.

- **Every screenshot and the demo GIF now show the current brand.** The
  rename in #456 reached every string a `grep` can see and none of the
  pictures: all fourteen raster assets under `docs/assets/` predated it, and
  the audit of them turned up two that were wrong rather than merely stale.
  `wizard.jpg` spelled the retired name in its ASCII banner and its title line
  **and** still showed a `3/9 Event config (event.yaml)` step — a file ADR 55
  retired — so it was wrong about the architecture too; `admin-event.jpg`
  showed the retired name as the default event name. Both are recaptured, the
  wizard from the script's real dry-run output via `vhs`. The other eleven
  contestant and admin shots, and the seven-frame `demo.gif`, are recaptured
  from the live box on the default event name, so the header wordmark reads
  `$ OWASP CTF in a Box` throughout — the old ones read `$ owasp-ctf`, which
  was that box's custom event name at the time, not a hardcoded string, but
  looked exactly like the retired slug. Three captions moved to match what
  their image now shows: `docs/hosting.md`'s wizard caption (the dry run
  ticks secrets and event basics, and the scorer-image check is the first
  pending step), `docs/operations.md`'s flag-board caption (it described a
  challenge detail page with a submission box, which no board shot has ever
  shown), and the README's `demo.gif` caption (the team view no longer
  expands a target down to its challenge rows; the GIF ends on the team's
  open flags instead). Untouched on purpose: `doctor.jpg`, which carries no
  brand string, and `ai-board.jpg`, a signed-out shot whose footer shows the
  hardcoded `$ owasp-ctf` wordmark — that string is a code change, not a
  recapture, and gets its own PR.
- **The footer's wordmark is the runtime event name, like the header's.**
  `site-footer.tsx` rendered a hardcoded `$ owasp-ctf` under every page while
  the header rendered `$ <event name>` — so an organizer's rename reached one
  end of the page and not the other, and after the September 2026 rename the
  retired slug sat under the new brand on every route. The header already had
  a test forbidding that slug (`site-header.test.tsx`); nothing forbade it in
  the footer. The footer now reads `event.name` from the same `getSite()` it
  already awaited, and `site-footer-wordmark.test.tsx` pins it, scoped to the
  prompt so the repo link's legitimate `owasp-ctf-in-a-box` href does not
  trip it. The 404 and error pages' terminal flourishes drop the slug too —
  `$ owasp-ctf goto …` and `$ owasp-ctf render …` become `$ ctf goto …` and
  `$ ctf render …`. Those lines are pretend CLI *commands*, so the event name
  is the wrong thing to put there (a program with spaces in its name reads as
  garbage); `ctf` is the identifier family the glossary already keeps, carries
  no brand, and is what `DESIGN_SYSTEM.md` §7 now uses as its example. The
  glossary's `ctf-*` row records it, so the next sweep does not rediscover
  it as an inconsistency.

- **The wizard banner is one line again.** The two-line logotype #457
  introduced (`OWASP CTF` over `IN A BOX`, ten rows) is replaced by the whole
  name on one line in figlet's `small` font — 76 columns, four rows, one row
  shorter than the original `OWASP CTF` banner, in the brand's own casing.
  All caps in that font lands on exactly 80 columns, one wrap away from
  garbage on the terminal the wizard targets; `in a Box` is what fits.
  `docs/assets/wizard.jpg` is recaptured from the new output.

- **The AWS module's provider lock file is now committed.** It had been
  gitignored since the module was written, grouped with `*.tfstate` and
  `*.tfplan` under "never commit these" — but a dependency lock is not state,
  it is this module's `pnpm-lock.yaml`. The consequence was that `versions.tf`'s
  `~> 6.0` / `~> 3.6` constraints floated: every `terraform init`, including
  each CI run, resolved whatever provider build the registry served that day,
  with nothing verifying the download. `.terraform.lock.hcl` now pins
  `hashicorp/aws` and `hashicorp/random` to a version and a checksum, with
  `h1:` hashes for the four platforms that run `init` against this module —
  `linux_amd64` (CI) plus `linux_arm64`, `darwin_amd64` and `darwin_arm64`
  (operators). That platform list is about review and reproducibility, not
  availability: a missing platform hash does **not** break `terraform init`,
  because the `zh:` hashes in a registry-sourced lock cover every platform and
  a writable `init` appends the `h1:` it needs. What the list avoids is every
  operator's first `init` rewriting the lock under them.
  `deploy/aws-terraform/README.md` spells out both that and the Dependabot
  gotcha: it re-locks for its own platform only, so regenerate the full set
  with `terraform providers lock -platform=...` on any provider-bump PR.

- **The rename's leftovers: the setup wizard, the AWS stack and the names
  table.** A sweep for the retired brand across the whole tree found six live
  strings the rename had not reached, all outside the areas its own diff
  touched. The biggest is the **wizard's ASCII banner**, the first thing an
  organizer sees — it still spelled `OWASP CTF`, having been rebranded *to*
  that name in #368. It is now a two-line logotype (the whole name in one run
  of that font is ~128 columns; the wizard has to read at 80), with the second
  word right-aligned under the first so the block stays 54 columns wide. Also
  renamed: the **OAuth App name the wizard dictates** — organizers were being
  told to register a fresh app under the retired brand — the wizard's `… setup
  wizard` line and its bats assertion, the App-creation page's `<title>`, the
  script's header comment, and the two `description` strings in
  `deploy/aws-terraform` (`elasticache.tf`, `kms.tf`) whose own README had been
  renamed without them. Those are in-place attribute updates; no AWS resource
  is replaced. **No identifier moved** — see below for why, and note that the
  `<title>` and event-name assertions in `scripts/acceptance-app.sh` and
  `scripts/acceptance-quiz-only.sh` were already correct and are untouched.

- **`docs/glossary.md`'s names table now explains the split it asserts.** The
  table said two strings keep the old brand "because they name things that
  already exist in somebody's GitHub account". That is true of the `OWASP CTF
  sync` GitHub App and only of it; it was never true of the wizard banner,
  which names nothing GitHub stores — so the banner was being held back by a
  reason that did not apply to it, and the entry did not say which of the
  wizard's two banners it meant. The paragraph now claims the exception for the
  one string it fits and says explicitly that the banner and the per-event
  OAuth App name follow the brand instead. The table also gains a `ctf-*` row
  for the service identifiers that are *also* runtime log prefixes — `ctf-sync`
  and `ctf-score-engine` are each both a `package.json` name and the string
  every line that service logs begins with, which is why renaming them is a
  worse trade than the inconsistency — and the `owasp-ctf` row now names the
  Fly app as its third use.

- **Renamed: the kit is now called OWASP CTF in a Box.** This is the name the
  OWASP Foundation approved when the project was transferred into the org; the
  repo had been carrying the pre-transfer name throughout. The rename reaches
  the brand — the README, the docs site title, the ADR index, `CONTRIBUTING.md`,
  `SECURITY.md`, the design system, the `LICENSE` copyright line — **and the
  default event name**, which the glossary has always kept deliberately equal
  to the brand. One behaviour change follows from that: a box whose organizer
  never set an event name now shows "OWASP CTF in a Box" where it showed
  "OWASP CTF" (`DEFAULT_EVENT_IDENTITY.eventName`, and with it the page
  `<title>`, the header and the leaderboard). That is a rename of the default,
  not of anything stored — a box with a name set in `/admin` → Event →
  Identity is untouched. What deliberately did **not** move: the `owasp-ctf`
  image namespace and repo directory (renaming it breaks every `SCORE_IMAGE`
  already sitting in a `.env`), the `OWASP-CTF` fork org,
  `ghcr.io/owasp-ctf/score`, and the `OWASP CTF sync` GitHub App, whose name
  belongs to an app already installed in someone's account.
  `docs/glossary.md`'s names table is the authority on that split; ADR 14
  carries an amendment for the changed default; and the entries below that use
  the old name are history, left as written.

- **The repo now meets the OWASP Project Policy's requirements for a project
  under the Foundation.** The kit was transferred into the OWASP org, and the
  governance files still described an unaffiliated project. Five things
  changed. The README, `docs/index.md` and `docs/glossary.md` said "not
  affiliated with or endorsed by the OWASP Foundation" — the policy requires
  the opposite ("Projects must identify as an OWASP project in their
  branding"), so they now identify the project and link its home page at
  `owasp.org/projects/ctf-in-a-box`, and carry the Branding Guidelines' own
  Statement of Non-Endorsement instead, which is what that sentence was
  actually reaching for. `CONTRIBUTING.md` gains a DCO section: the policy
  names the Developer Certificate of Origin as the contributor agreement
  every OWASP project must use, so every commit needs `git commit -s`.
  Documentation is relicensed **CC BY-SA 4.0** (`docs/LICENSE`) — the policy
  splits the two, OSI-approved for source and Creative Commons for
  documentation; code stays MIT and the root `LICENSE` is untouched.
  `CODE_OF_CONDUCT.md` names the OWASP Code of Conduct as authoritative over
  its Contributor Covenant text and adds the Foundation escalation path
  (compliance@owasp.org, the conflict-resolution and whistleblower policies,
  the Project Committee) for a report that concerns the project's own
  leaders. And the app footer now carries the OWASP attribution — links to
  owasp.org, the project page and the repo, plus the trademark and
  non-endorsement notices — because the policy asks for that branding on any
  domain the project maintains, and an event box runs on the organizer's own
  hostname.

- **One footer, not four (#474).** The site footer stacked four bands, each
  with its own divider, and read as four footers. It is now a main block
  (wordmark and dates, the site nav, the policy links, the OWASP attribution)
  plus one bottom bar (the trademark notice and the sponsor credit), with the
  bar's divider the only one inside it. The phone column follows source
  order, so a screen reader hears what the eye sees. Every footer link is
  padded to meet WCAG 2.5.8, the main nav is labelled "Site", and the landing
  page no longer credits its sponsors twice.

- **The AWS module runs a current event (#476).** Its task definitions had
  not kept up with poll scoring (#377) or with sync's move to a GitHub App, so
  an applied stack could not sign anyone in, served the mock leaderboard,
  refused team writes, and started neither sync nor the scorer.
  - The app now gets `GITHUB_CLIENT_ID`, `LEADERBOARD_SOURCE=lambda`,
    `TEAM_WRITES_ENABLED=true` and, on a Secure Development event,
    `LEADERBOARD_API_URL`.
  - sync gets the GitHub App's id, installation id and private key, the
    scorer's URL and its bearer token. The scorer gets that token too.
  - The scorer has a Cloud Map name and its own security group, reachable on
    `:4000` from the app and sync only.
  - On every deployment, not only AWS: when `GITHUB_APP_INSTALLATION_ID` is
    unset, sync now asks GitHub for the App's installation on `GITHUB_ORG`.
    It used to take the first installation the App listed, which polls
    nothing when that is another org, and it now refuses an App not
    installed there. A non-numeric `GITHUB_APP_INSTALLATION_ID` is refused
    at start-up, and the Terraform variables check both App ids at plan
    time.
  - Traffic between the stack's own services stays HTTP with a bearer
    token, with the network as the boundary (ADR 63). TLS on those hops is
    the post-event follow-up #484.
  - `stack.tftest.hcl` now reads `docker-compose.yml` and fails if any
    environment key compose gives the app, the scorer or sync is missing from
    its ECS task.
  - **Breaking for an existing `terraform.tfvars`:** `github_client_id` is now
    required, and so is `github_app_id` when `enable_secure_development` is
    true. In SSM, `GITHUB_TOKEN` is no longer read; store
    `GITHUB_APP_PRIVATE_KEY` (base64 of the `.pem`) and `SCORER_TOKEN`
    instead. `docs/aws.md` and the module README list the commands.
- **Fixed: hint errors are logged as a label, and archive-import errors no
  longer echo the file's values (#500).**
  - Four hint-store failure logs (the hint gate's solve lookup, a failed hint
    reveal, and the classic and ai hint-list reads) passed the caught error
    object itself to `console.error`. They now log `errorLabel(err)`, the name
    and message only, like every other store.
  - Importing an event archive refused a bad attachment file with a message
    that repeated its `sha256`, its `item` and any unknown key names. Those
    messages now give the file's position and the rule it broke, and a
    `sha256` that is not 64 lowercase hex digits gets its own error.
  - `ai-http.ts` and `admin-store.ts` had their own copies of `errorLabel`.
    Both now use the one in `error-label.ts` (`adminErrorLabel` is kept as an
    alias), and a test fails if another copy appears in `apps/web/src`.

- **The AWS stack comes up (#476, pre-event bring-up fixes).** The stack
  had never been applied, and a rehearsal would have stopped at the first
  image build.
  - **ECS Exec is on by default** (`enable_ecs_exec`), so `aws ecs
    execute-command` gives an operator a shell in a running task on event day.
  - **srh's health check could never pass.** It called `GET /ping`, which
    the pinned srh answers with a 404, so srh never went healthy and the first
    apply hung. It now POSTs `["PING"]` as JSON and requires `PONG`. The
    command lives in `srh-healthcheck.sh`, which `terraform.yml` runs inside
    the pinned srh image against a real Redis.
  - **The app image could not be built.** `deploy.sh` used `apps/web` as the
    build context, but the Dockerfile needs the repo root. It now builds the
    way compose and the Fly deploy do.
  - **Everything is built for `linux/amd64`**, and every task definition says
    X86_64. An Apple Silicon laptop used to push arm64 images.
  - **The scorer and sync now live in the stack's own ECR.** Fargate could
    pull neither: the scorer package is private and sync is published nowhere.
    `deploy.sh` builds sync, mirrors the scorer from `--scorer-source`
    (default `$SCORE_IMAGE`) and writes all three image refs. The execution
    role pulls those three repositories by name, in place of the managed
    policy's `"*"`.
  - Every service rolls back a deployment that never goes healthy. srh runs
    two tasks, with a health check that rides out an ElastiCache failover.
  - `backend.tf.example` and the README's Remote state section set up the S3
    state a real event needs. The bootstrap docs, the tfvars example and the
    `next_steps` output now agree.
  - **Breaking for an existing `terraform.tfvars`:** a
    `ghcr.io/<org>/score:latest` `scorer_image`, or a hand-pushed
    `sync_image`, is refused at plan time. Replace both with the placeholder
    from `terraform.tfvars.example`, re-run the bootstrap apply to create the
    two new repositories, then run `./deploy.sh --scorer-source
    <SCORE_IMAGE>`, which writes both. `docker login` to the scorer's registry
    first.
  - **On a stack that is already running an event:** do not take this
    upgrade mid-event. The first apply after it replaces the scorer and sync
    task definitions (new image refs) and the execution role's policy, and
    brings a second srh task up, so every service rolls once. Take it before
    the event or after it, never during one; `/admin` → Freeze first if you
    must.

- **Docs: an AWS event-day runbook, and the gaps an organizer should know
  about.** `docs/aws.md` now covers running the event on ECS: watching the
  services, a shell with ECS Exec, freezing scoring, what an app task loss,
  an srh restart, an ElastiCache failover and a sync restart each look like,
  rolling back a bad image, running the load pass by hand (the load-test
  harness is Fly-only), and a tear-down that exports first and deletes the
  hand-made SSM parameters. `docs/troubleshooting.md` gains the matching ECS
  recipes. `docs/operations.md` and the `/admin` help text now say that the
  quiz attempt cap, the quiz retry cooldown and the classic cooldown count
  per contestant while points count per team, so a team of N gets N times
  the budget. The pre-event checks now dispatch `stock-scores-zero` and
  `patched-scores-right` on the release commit. The `ctf-setup.sh` header
  now describes `launch` in the order it runs: wait for Launch, then make
  the forks public.

- **Docs drift from the pre-v0.7.0 audit (#501).** `docker-compose.yml` no
  longer passes `DEMO_MODE` to the app. Nothing has read it since #419 (demo
  seed/clear are admin-gated, ADR 58), so a `.env` that still sets it boots
  exactly as before; delete the line at leisure. A `.nvmrc` pins Node 22 for
  `nvm use`. The ADR index lists 54, 57 and 58, and ADR 57's heading no
  longer wraps (its anchor had lost half its title). The Makefile, AGENTS.md
  and CONTRIBUTING.md now name the AWS `deploy.sh` shellcheck and bats suite
  CI runs, and CONTRIBUTING describes the AWS module as ECS, not an EC2 box.
  A new `scripts/check-docs-drift.mjs`, run by the `shell` job's bats suite,
  fails a PR whose ADR index, local shell commands or Node pin drift from
  the source they copy. Stale comments, test counts and push-era wording
  are corrected.

## v0.6.0 — 2026-09-20

### Breaking changes

Five of them, and one chore that is not optional. Each has a full entry below
with the reasoning; this is the index an upgrader reads first.

- **`event.yaml` is deleted** — `.env` bootstraps the box and `/admin` runs the
  event ([ADR 55](docs/decisions.md)). Migration steps are under *Migrating a
  running event* in the configuration v2 entry.
- **Push score ingest is removed** — poll is the one score transport
  ([ADR 56](docs/decisions.md)). A hand-rolled `--profile push` bring-up now
  starts the app with **no scorer and no poller**; use `--profile secdev
  --profile app`.
- **The kit is renamed OWASP CTF** — new repo, docs and image paths.
- **The repo moved to the OWASP org** — `OWASP/owasp-ctf-in-a-box`. Git
  remotes and `github.com` links redirect, so a clone keeps working. **The
  docs site does not redirect**: `dcotelo.github.io/owasp-ctf/` is gone and
  the site is now at `owasp.github.io/owasp-ctf-in-a-box/`. Update any
  bookmark or link of your own that points at the old Pages host.
- **The AWS module is ECS Fargate + ElastiCache + ALB** — an existing EC2
  deploy does not upgrade in place.
- **Revoke the old leaderboard credentials.** If your event org still carries
  `LEADERBOARD_URL` and `LEADERBOARD_TOKEN` from a push-era setup, delete them
  now. Nothing reads them any more and they authorize nothing — but they are
  readable by the Actions run that a contestant's own pull request triggers,
  which is the worst place for a credential to sit. `ctf-setup.sh doctor`
  reports them fail-closed: a `gh` error reads "not verified", never "absent".

- **Changed: the kit lives in the OWASP org now (#454).** The repository is
  `OWASP/owasp-ctf-in-a-box` and the documentation site is
  `owasp.github.io/owasp-ctf-in-a-box/`. Every reference the kit ships moved
  with it: the README and its CI badge, `SECURITY.md`, the issue-template
  config, every `docs/` page, the setup wizard's closing links, the `sync`
  GitHub App manifest, and the two the app serves at runtime — the landing
  page's repo button and `DOCS_URL` in `modules.ts`, which every module's
  setup checklist links through.

  GitHub 301-redirects the repo itself, so an existing clone, a `gh` command
  and any `github.com/dcotelo/owasp-ctf` link all keep working. **GitHub
  Pages does not redirect after a transfer** — the old docs host returns 404,
  which is why this is a fix rather than a rename: a box running an earlier
  build links its contestants and organizers to a dead site.

- **Docs: the Cloudflare rate-limiting rule in front of the box (#438, edge
  layer).** The reference domain has always been proxied by Cloudflare and
  the repo never said so. `docs/hosting.md` gains a section on why the edge
  is the only place a per-IP control can live, the one Free-plan rule to
  create (`/api/*`, 100 requests per 10 s per IP, block 10 s, zone-level not
  account-level) and its verification; the pre-event checklist in
  `docs/operations.md` grows from three checks to four.

- **Fixed: the leaderboard fold runs once per 10 s, not once per viewer
  (#444).** Composing the board — the scorer read, every module's points,
  team standings, the chart series and hint penalties — cost roughly 500
  Redis commands per page view at 200 contestants, and the result was the
  same for everyone (the "you" highlight is applied on the client). The load
  test (#439) measured 2.7 req/s served against 10 demanded after the payload
  fix (#434). `/leaderboard`, `?display=1` and the landing page's live strip
  now read one memoized fold, refreshed every 10 s; concurrent viewers share
  the fold in flight, and a fold that throws is never cached. An app-side
  solve (quiz, flag, AI) reaches the board within 10 s; a Secure Development
  score within about 40 s, since the scorer read underneath was already
  cached for 30 s; a contestant's own pages still read live.

- **Fixed: the leaderboard no longer ships a copy of the Secure Development
  catalogue in every row (#434).** Each contestant and team row carried the
  full per-challenge list — name, points, OWASP code — when only which ids
  were solved differed between rows. The load test (#439) measured it: at 200
  contestants the page was 13 MB and served 0.3 requests a second against 10
  demanded. The catalogue now travels once, on `LeaderboardData.catalog`;
  rows carry `apps[].solvedIds` (narrowed to ids the catalogue still holds);
  `AppBreakdown` joins the two at render, for the one row that is open.
  `/profile` and `/challenges` read the same shape. The scorer's own
  response was already built this way — the expansion happened in the app.

- **Added: a load-test harness (#439).** `scripts/load-seed.mjs` writes N
  synthetic contestants on teams — the demo seed's exact key families,
  attached to the box's own catalogue — from inside the Fly machine, failing
  closed when it cannot tell which modules are live or when a row it is about
  to write already exists outside its own manifest; `--clean` removes exactly
  what that manifest lists, with no catalogue, no `--count` and no name
  pattern. `scripts/load-test.sh` ships it there, drives
  the two public hot pages with autocannon at fixed rates, samples machine
  memory (and fails the run if it could not) and writes one report on
  autocannon's p97.5. Its first run on the live box at 200 contestants measured
  `/leaderboard` at 13 MB and 0.3 req/s against 10 demanded, which is what
  promoted #434 to pre-event work.

- **Added: `/health/deep` and a Fly machine check (#437).** The box had no
  health check and no monitor, and every read fails open by design — so a
  dead Redis or scorer left the site rendering with nothing scoring, and the
  first person to notice would have been a contestant. `/health` stays
  liveness-only and is now Fly's `http_service` check; the new public
  `GET /health/deep` probes Redis through srh and (when `SCORE_IMAGE` is set)
  the scorer's `/healthz`, answering 503 with each dependency reported as
  exactly `"ok"` or `"down"` and nothing more, reporting the poller's last
  poll age without failing on it, and caching results for 10 s so an
  unauthenticated URL cannot become a probe storm. `docs/hosting.md` gains a
  Monitoring section for pointing a free uptime service at it.

- **Fixed: Insights team points now include Secure Development (#432).**
  The Teams table on `/admin/insights` summed each member's Quiz, Jeopardy
  and AI points and nothing else, so on a secure-development event every
  team read lower than the leaderboard by exactly its SD points — under a
  caveat that promised SD "contributes to participation and points". The
  per-login SD total is read from the leaderboard source (the scorer's own
  `points`, before the module overlays add theirs); a scorer that cannot be
  reached costs the SD share and says so in the caveats, and `mock` mode's
  placeholder scores are left out with the reason printed rather than folded
  in as if real.

- **Added: recognition-only sponsor support (#417, #421, #423, #425, #426,
  #427, #428, #429, #431).** An event can credit the organizations funding it
  without any of that touching scoring: a `/sponsors` page, a strip on the
  landing page, and a row on the projector board, all driven from an `/admin`
  Sponsors tab built around the list rather than a single editor. Logos are
  uploaded as PNG, WebP or JPEG and served from the box, never hotlinked. How
  large they render is one organizer setting (`sponsorLogoSize`, small/medium/
  large) applied to both the strip and the board — the board's logos were a
  fixed 2.2vh, which read as an illegible fleck from the back of a room, which
  is the whole point of that surface. A sponsor's name renders beside its logo
  and stands in for it when there is none. The `/sponsors` page carries a
  standing notice that sponsors fund the event and have no influence over
  challenge content, scoring or results.

- **Changed: Classic CTF is now called Jeopardy (#424).** The module keeps its
  id (`classic`) and every Redis key it has ever written — this is the label
  contestants and organizers read, nothing else. The "CTF" and "Challenges"
  suffixes are dropped from the other module names for the same reason: the
  nav said "Classic CTF Challenges" inside a CTF.

- **Changed: demo data is an admin control, not a build-time gate (#419,
  #430).** `DEMO_MODE` is gone. **Seed demo data** and the new **Clear demo
  data** both live in the Event tab's danger zone, behind the same
  type-to-confirm every destructive control there uses. A rehearsal can now be
  set up and torn down from the panel without a redeploy — which is what made
  it possible to rehearse on the box at all.

- **Added: the leaderboard chart plots every enabled module (#415).** It
  charted Secure Development alone, so a quiz-only or Jeopardy event watched a
  flat line sit under a visibly rising board. **Fixed (#418):** on mobile the
  same chart read stale or flat when the time domain was mostly dead time —
  the series was there, compressed into the last few pixels.

- **Fixed: a leaderboard source's teams no longer hide the ones contestants
  created (#413).** **Fixed: the profile trigger opens a menu, so it now looks
  like one (#411)** — it was styled as a plain link, so nobody found sign-out.

- **Fixed: four findings from the live e2e audit (#379, #380, #383, #384).**
  The progress sliver, the profile page's ceiling, the OAuth error copy, and
  the `ctf` branch instructions on `/challenges`.

- **Fixed: two deploy failures (#365, #422).** Redis is handed its data dir
  before it drops privileges, so a fresh volume no longer comes up read-only.
  Fly build attestations are disabled — they raced the registry and failed the
  push, intermittently and with an error that named neither cause.

- **Docs and internals.** Every diagram is one animated-SVG system sharing a
  palette, a reduced-motion block and a `<desc>` that is the embedding page's
  alt text (#361). The demo seed's AI challenges, and the fact that event mode
  has no in-box fallback, are documented (#356). The stale references the ECS
  revamp and the rebrand left behind are gone (#366). `AGENTS.md` records how
  to talk to CodeRabbit through PR comments (#388).

- **Added: the setup wizard offers an optional fly.io deploy as its closing
  step (#371).** It used to end at the local `docker compose` bring-up,
  leaving an organizer to find `deploy/fly/deploy.sh init --from .env`, the
  hostname and the second OAuth callback out of
  [docs/fly.md](docs/fly.md) for themselves. It now asks *"Deploy to fly.io
  now?"* — default **no**, so a run that only wants the box is unchanged —
  and on yes prepares `.env.fly`, writes the public hostname there as
  `EVENT_URL` (never into `.env`, which stays the compose box's), prints the
  OAuth callback that hostname needs, previews the deploy and asks before
  running it, then hands off `fly certs add` for a custom domain. It skips
  itself with instructions when `flyctl` is missing or signed out, for an
  app-only event, and a failed or abandoned deploy never takes the run down.

- **BREAKING: push score ingest is removed; poll is the score transport
  (#377, [ADR 56](docs/decisions.md)).** A fork's Action writes its score
  comment on the PR and the `sync` poller reads it — that is now the only way
  a secure-development score reaches the box, and there is no setting to
  choose it. Gone: `caddy/Caddyfile.push` (compose mounts a constant
  `caddy/Caddyfile.poll`), the `push` compose profile and its bring-up notice
  service, the `SCORE_INGEST` key itself — from `.env.example`, the wizard,
  `scripts/dev-stack`, `deploy/fly/deploy.sh` and both AWS task definitions —
  the AWS module's `score_ingest` variable, the judge's
  `SCORE_API`/`SCORE_TOKEN` leaderboard POST, and with it the
  `<!-- ctf-score:not-recorded -->` marker that POST was the only writer of.
  The rendered consumer workflow no longer passes those two secrets to the
  scorer.

  **Upgrading:** nothing to do for a poll event, which is every event this kit
  has ever set up. A box whose `.env` still says `SCORE_INGEST=push` comes up
  exactly as before — nothing reads the key — but it is now polling, and
  `ctf-setup.sh doctor` says so once and invites you to delete the line (a
  leftover `poll` is silent: it already agrees with the behaviour). The one
  thing that does change under you is a hand-rolled bring-up: `docker compose
  --profile push --profile app up` now starts the app with **no scorer and no
  poller**, because that profile no longer exists on any service. Bring the
  stack up with `--profile secdev --profile app` — which is what the wizard
  and `scripts/dev-stack` have always printed for a poll event. `doctor`
  also still reports leftover `LEADERBOARD_URL`/`LEADERBOARD_TOKEN` org
  secrets, fail-closed — a `gh` error or an empty reply reads "not verified",
  never "absent" — and those are worth deleting now more than before: they are
  readable by the runs a contestant's PR triggers and authorize nothing at
  all. Push was deprecated and removed inside the same unreleased version on
  purpose; ADR 56 records why, under *Alternatives rejected*.

- **Fixed: a Fly deploy could ship the previous event org's credentials
  without saying so (#381).** `.env.fly` and `.env` were never compared, so a
  re-created org — new OAuth app, new sync App — deployed silently against the
  old one: every sign-in bounced with `?error=application_suspended` and `sync`
  logged `GitHub 401 minting installation token` on every poll, while the
  deploy, `/health` and `doctor` (which reads `.env`) all looked fine. A deploy
  now names every external-system key the two files disagree on — before the
  build and again in the closing summary, key names only, never a value — and
  warns rather than refuses, since per-environment OAuth apps are legitimate.
  `init --refresh` gained three fixes of its own: an explicitly blank
  `GITHUB_APP_INSTALLATION_ID=` line in `.env` now **clears** the pinned id
  (that blank means "let `sync` auto-discover the installation"), while an
  explicit blank of any other key keeps the deployed value and says why rather
  than locking everyone out of `/admin`, and a key absent from `.env`
  altogether keeps the deployed value for every key including the installation
  id; the source is read in every form `docker compose`
  accepts (`KEY = value`, `KEY: value`, quoted, `export`-prefixed) instead of
  `KEY=value` alone; and a line in any of those forms is now replaced in place
  rather than having a second assignment appended. Both `init` and a deploy
  warn when the env file assigns a key twice, naming it and stating that the
  last assignment wins.

- **Fixed: the challenge browser's OWASP category filter offered codes from
  targets the organizer had unticked (#391).** The scorer's catalogue carries
  every target in its rubric, and the filter was built from the whole of it
  rather than from the runtime target list, so narrowing targets on
  **Secure Development → Targets** left the filter offering categories that
  matched nothing on the board. It now follows the enabled targets, as the
  page's totals already did.

- **BREAKING: configuration v2 — `event.yaml` is deleted; `.env` bootstraps
  the box and `/admin` runs the event (#386, [ADR 55](docs/decisions.md)).**
  One change, shipped over four parts, that replaces two overlapping config
  planes with two separate ones. Nothing is baked into an image any more, and
  no image takes a configuration build-arg.

  **Removed.** `event.yaml` and `event.yaml.example`; the `EVENT_CONFIG_B64`
  build-arg and the `EVENT_CONFIG` env var; `apps/web/Dockerfile`'s config
  `ARG` and the compose `build.args` entry that fed it;
  `apps/web/scripts/generate-event-config.mjs` with its generated
  `event-config.generated.ts` and the `prebuild`/`predev`/`pretest` hooks
  that ran it; `sync`'s yaml reader and its bind-mounted `/config/event.yaml`;
  `setup/test/corpus` and the cross-reader corpus suites that pinned the three
  yaml parsers against each other; the wizard's `--config` flag, its yaml
  writer, its `KNOWN_MODULES` mirror, its `--targets` flag and its "which
  modules" question; Fly's `--config` flag; and AWS's `event_yaml_b64`
  variable.

  **New in `.env`, read at container start.** `GITHUB_ORG` — the event org for
  fork links and for the repos `sync` polls; empty renders bare repo names in
  the app, and makes `sync` refuse to start naming the key. `ADMIN_LOGINS` —
  a comma-separated list of GitHub logins allowed into `/admin`, matched
  case-insensitively; empty or unset **locks everyone out**, including
  organizers who used to be in the `admins` list, so set it and restart (no
  rebuild). `SCORE_IMAGE` gains a meaning: **non-empty is how a box says it
  runs Secure Development** — it picks the compose profile, it is the default
  module set on a first boot, and it gates the module's admin toggle.

  **Moved to `/admin`, live, with no restart.** Which modules run: before an
  organizer touches the panel, Secure Development is the only board on — and
  only with a `SCORE_IMAGE`; Quiz, Classic and AI start off, and switching the
  last board off is allowed (the landing page then says "No boards are open
  yet"). Which Secure Development targets run: `ctf-setup.sh org` now forks
  and provisions **all six** of `setup/targets.tsv` for every event — six
  forks, six scoring workflows, six package Read grants — and **Secure
  Development → Targets** picks the live subset, defaulting to all six, at
  least one required, taking effect on the next page load and the next poll
  tick. The event's identity — name, tagline, location, contact e-mail,
  Discord invite — on the Event tab's Identity section, defaulting to
  "OWASP CTF" and empty. The event's dates and countdown now derive from the
  **Scoring opens** / **Scoring closes** schedule rather than a separate
  field. Event archives carry `secureDevTargets` and name/theme/location and
  restore them on import (bundle format v2; a v1 archive still imports,
  leaving the stored target list untouched); contact e-mail and Discord
  invite are deliberately never exported.

  **Compose profile renamed `poll` → `secdev`.** `scorer` carries
  `["secdev", "push"]` and `sync` carries `["secdev"]`. Whoever brings the
  stack up adds `--profile secdev` **iff `SCORE_IMAGE` is non-empty** —
  `scripts/dev-stack` and `deploy/fly/render-compose.sh` do it for you. The
  `push` profile is unchanged here (its deprecation is #377).

  **Deploy paths.** Fly and AWS bake nothing and carry `GITHUB_ORG` and
  `ADMIN_LOGINS` as runtime environment instead: Fly's `deploy.sh init
  --refresh` now refreshes both alongside the other external credentials and
  falls through to the top-up prompts rather than exiting (#381), and the AWS
  app task definition gained `GITHUB_ORG`/`ADMIN_LOGINS` in place of the
  config bake.

  **Migrating a running event.** There is no compatibility shim and no
  migration step — `event.yaml` is simply not read by anything. On a box: add
  `GITHUB_ORG` and `ADMIN_LOGINS` to `.env`, then bring the stack up with
  `--profile secdev --profile app` (drop `secdev` if you have no
  `SCORE_IMAGE`); delete `event.yaml`. On Fly: `deploy/fly/deploy.sh init
  --refresh` copies both keys into `.env.fly`, then deploy as usual. On AWS:
  set the new `github_org` and `admin_logins` Terraform variables and drop
  `event_yaml_b64`. Everything else the file used to say — which modules run,
  which targets run, the event's identity, the dates — is now set in `/admin`
  on the running box, and the module content, teams, scores and hint spend in
  Redis are untouched by any of this.

- **README and docs screenshots caught up with the rename.** The wizard and
  `doctor` terminal shots still showed the CTF-in-a-box banner, the old
  eight-step numbering and the `ctf-in-a-box-test` org; the challenge browser
  linked the old org's forks; the admin Event tab named the old test event.
  All four are recaptured from the current script and the live box. The
  README's heading now carries the OWASP logo the app itself shows (a
  light/dark pair, since the mark is black on transparent), and its two
  references to the AWS module as "one EC2 box" now describe the ECS Fargate
  stack that replaced it.

- **The Fly module now refuses push mode instead of deploying a box that
  scores nothing (#373).** `docs/fly.md` said push "works"; it never did
  there. In compose, caddy routes `POST /score` to `scorer:4000`; a Fly
  machine has no caddy and `fly.toml` exposes only the app on port 3000, so a
  fork's Action would POST every score into a 404 — silently, since that step
  does not fail the workflow. `deploy.sh` now exits with the reason and the
  fix when `.env.fly` says `SCORE_INGEST=push` (dry-run included), and the
  docs say poll-only. Routing `/score` on Fly, if ever wanted, stays tracked
  in #373.
- **The wizard's "Score ingest" answer now reaches `.env` (#372).** It was
  written to `event.yaml` only, while `SCORE_INGEST` in `.env` — the switch
  `docker-compose.yml`, the Caddy profile and the wizard's own bring-up step
  actually read — kept its `poll` template value. An organizer who answered
  `push` got a push label on a poll deployment with no warning. The wizard now
  writes both from the one answer, and `doctor` and the bring-up step warn,
  naming both files and both values, whenever the two disagree.
- **The wizard now verifies last, after you have done the UI-only steps
  (#370).** It used to run `doctor` the instant the org was provisioned and
  *then* tell you to detach the forks and grant the package — so every first
  run ended on a table of ⚠️ for steps you had not been given the chance to
  do. It now prints that checklist, pauses for you (skipped under
  `--dry-run`), brings the containers up, and runs `doctor` as a closing
  ninth step, so a clean table on the last screen means the event is ready.

- **sync's poll cursor now survives a Fly restart (#364).** The
  single-volume layout puts it at `/data/sync/state.json`, but sync runs as
  `node` and a fresh Fly volume is root-owned, so pointing `STATE_PATH` there
  failed with EACCES — and the live `.env.fly`, written before `init` added
  the knob, never pointed there at all, so the cursor sat on ephemeral disk
  and every suspend/resume re-read every fork. The sync image now has an
  entrypoint that creates and `chown`s the state directory as root and drops
  to `node` (via `su-exec`) before starting the poller, mirroring what redis's
  command does for its own directory. `deploy.sh` warns when an env file
  lacks `REDIS_DIR`/`STATE_PATH` and names the two lines to add.

- **BREAKING: the kit is now called OWASP CTF.** Repo at
  `github.com/dcotelo/owasp-ctf`, docs at `dcotelo.github.io/owasp-ctf`, Fly
  app `owasp-ctf`, and the Terraform defaults `name = "owasp-ctf"` /
  `ssm_prefix = "/owasp-ctf"`. Every resource the AWS module names from those
  defaults is named differently from here on; there is no migration from the
  old names. The scorer image path `ghcr.io/owasp-ctf/score` predates the
  rebrand and is unchanged. The brand and the neutral default event name are
  now the same string, so a build that lost `EVENT_CONFIG_B64` no longer gives
  itself away by its name — check for an empty `admins` list and a 403 on
  `/admin` instead.

  This project remains unaffiliated with, and unendorsed by, the OWASP
  Foundation; OWASP® is a registered trademark of the OWASP Foundation.

- **A teamless organizer is now told before they submit, not after (#357).**
  Scoring is per team and every submit route refuses a teamless login, but
  organizers are exempt from the two redirects that steer contestants to team
  setup — an organizer opening a module page to check their content renders is
  not playing. The exemption covered the *information* as well as the
  redirect: the form rendered, the route refused the submission, and the rule
  arrived attached to a solve that did not count. The population most likely
  to be testing a board was the one guaranteed to discover the requirement by
  losing a submission to it.

  A notice now sits above the form on `/flags/<id>`, `/quiz` and `/ai/<id>`
  for a signed-in viewer with no team, and it names **Play solo** — the
  one-click team of one that already existed on the profile and that none of
  the no-team copy mentioned. The refusal messages name it too, so the
  cheapest exit is visible at both moments. The exemption itself is unchanged;
  what changed is that it no longer exempts anyone from knowing. Costs one
  extra `hasTeam` read per admin module page view, which is what buys the
  notice.

- **BREAKING: the AWS module is now ECS Fargate + ElastiCache + ALB, replacing
  the single EC2 box.** An existing EC2 deploy does **not** upgrade with an
  `apply` — that would destroy the instance and build the new stack around a
  database that never existed. Migrate instead: export the event archive, stand
  the new stack up beside the old one, import, move DNS, then destroy the old
  (steps in the module README).

  The driver was durability, not fashion. On the box, Redis was a container
  writing an append-only file to an EBS volume — our fsync policy, our volume,
  our restore procedure, and no backups unless the operator built them. Poll
  mode survives "the box died"; nothing there survived "the box died and the
  quiz answers, the classic flags and every team went with it". ElastiCache
  makes that AWS's problem, and once Redis is managed the ALB (health checks, a
  task swap without dropping the event) and Fargate (no instance to patch)
  follow nearly for free. ADR 54 records the alternatives, including the two it
  rejects: EKS, and keeping EC2 with backups bolted on.

  **The app did not change.** It, the scorer and sync speak only the Upstash
  REST API and never raw Redis, so ElastiCache changed exactly one thing — what
  `srh` connects *to*. `srh` stays; everything above it is the code compose
  runs. ADR 41's boundary also stays in the security groups: the ALB alone
  reaches the app, the app and workers alone reach `srh`, `srh` alone reaches
  ElastiCache, and the app has no route to Redis at all. Tasks sit in public
  subnets with no permitted inbound, because a NAT gateway costs about what the
  whole instance did, per AZ, before a byte moves.

  Three things are worse on purpose and are written down rather than left to be
  discovered: it costs roughly **four times** the EC2 bill at the defaults
  (itemised, with the two dials that bring it down); **Terraform state now
  contains a secret**, the generated ElastiCache AUTH token, so an encrypted
  remote backend stops being advice; and **durability is snapshots, not AOF**,
  so a restore loses up to a day rather than up to a second — which is why the
  event archive export remains the backup that matters for authored content.

  **Every event secret is encrypted with a KMS key the stack creates**, and
  `aws ssm put-parameter --key-id` is required rather than optional: the task
  execution role's `kms:Decrypt` names that one key, where it previously held
  `"*"` narrowed only by a `kms:ViaService` condition — enough to reach any
  SecureString in the account that delegates to IAM. The bootstrap apply now
  targets the key alongside ECR, so the secrets step lands between the two
  applies rather than before them, and a parameter stored under a different key
  fails at task start with an `AccessDeniedException`. About a dollar a month.

  The image bake moved off the instance into `deploy/aws-terraform/deploy.sh`,
  because Terraform cannot build an image and `event.yaml` is baked at build
  time — an image built without `EVENT_CONFIG_B64` ships an empty `admins` list
  and 403s every organizer. Tags are content-addressed (revision + config hash)
  into an immutable repository, so a redeploy with nothing changed is a no-op
  instead of an error, and `--dry-run` prints every command while running none
  of them, with the config redacted.

  The ALB health-checks `/health`, not `/`. A page that reads Redis is the wrong
  probe for something wired to task replacement: a blip would deregister every
  app task, and replacing them cannot fix Redis. It also proved nothing — the
  app streams its shell with HTTP 200 and puts render failures in the body,
  which is exactly how #312 stayed invisible to status-code checks.

  Verified with **no AWS account**: `srh` speaks TLS + AUTH to a cache
  configured as ElastiCache presents itself, and `EVAL`/`EVALSHA` survive the
  hop, with a wrong token rejected as the control. Worth knowing when a
  handshake fails — `srh` verifies against CAStore's embedded bundle, not the
  OS trust store, so the fix is a newer `srh_image` and never a mounted CA.
- **Fixed: the demo board shipped a challenge nobody could solve (#355).**
  **Seed demo data** wrote `Jailbreak Arena` as an `event`-mode AI challenge
  worth 400 points. That mode is graded *only* by an external arena POSTing a
  signed solve event — it renders no flag form by design — and the fixture's
  launch URL points at `ai-demo.example.org`, a reserved documentation domain
  with no DNS record. So the demo showed a challenge whose own description
  promised the external side would report the solve, with a Launch button that
  dead-ended and no other way to clear it. The seeded solve rows made the board
  look like two contestants already had.

  It is now flag-gradable (`mode: "both"` — the panel labels that "Either —
  flag or external event") with a flag and a rewritten description that says
  what a real event-graded challenge would do instead. The demo board plays end
  to end; what event mode looks like stays documented in `docs/ai-module.md`
  §5, which is the honest place for it, since demonstrating it needs a second
  system. The seed test now asserts **no** demo challenge is `event`-mode, so
  reintroducing one fails before it reaches a board.
- **Fixed: a team could vanish from the leaderboard while its own profile page
  still showed it (#358).** Found on a live board — the Teams view listed four
  teams holding seven members while Insights, reading the same function,
  counted eight people on a team. The missing one had created a team minutes
  earlier and was competing; from the board's perspective they were not there.

  Every SCAN walk in the app read a failed page through a `["0", []]` fallback,
  and `"0"` is the cursor value meaning ITERATION COMPLETE. `upstashPipeline`
  reports a per-command failure as `{ error }` rather than throwing, so a
  failed page did not retry, did not throw and did not return empty — it ended
  the walk and handed back the pages gathered so far, indistinguishable from a
  full sweep. Because it depends on which page fails, it is intermittent, and
  two readers of the same data disagreed.

  **Five walks shared the shape, and the leaderboard was the least severe.**
  The master reset returned a `cleared` count for a sweep that had stopped
  early, so an organizer could be told the event was wiped and open a "fresh"
  one still holding the previous event's solves; clearing one contestant's
  progress could report success having removed part of it; and two counters
  (Insights participation, the pre-delete confirmation count) silently
  undercounted. All five now parse a page through one helper that throws, and
  each caller applies its own documented fail direction — the leaderboard
  degrades to the team-less view it already had a `catch` for, Insights records
  a caveat and keeps the figures it can still stand behind, and the reset and
  the clear fail loudly rather than claim to have finished. Re-running a failed
  reset is safe: deleting an absent key is a no-op.

  The regression tests fail the *partial* case specifically — first page good,
  second page failing. Asserting only that an all-failing walk returns nothing
  would have passed against the bug, since a first-page failure returned empty
  under the old code too.

- **Dependencies.** `next` and `eslint-config-next` 16.3.4 → 16.3.5 (#450,
  backported fixes only, including CSP nonces on `loading`/`template` script
  tags and two `next/image` disk-cache corrections); `better-auth` 1.7.2 →
  1.7.5 (#401, #452); `@types/node` 26.4.1 → 26.6.1 (#400, #451);
  `@types/react-dom` and the react group (#399, #409); `yaml` 2.9.0 → 2.9.1 in
  `scorer` (#449). Dependabot now keeps the node base image on its current
  line, patches only, rather than proposing a major it cannot test (#408).

## v0.5.0 — 2026-09-07

The admin panel every URL of which had stopped loading, a security bump, and
a long run of numbers that finally agree with each other.

- **Fixed: every `/admin` URL returned the error boundary instead of the panel
  (#312, fixed by #324).** For the whole window between #297 and #324, an
  organizer could not freeze scoring, edit a question or a flag, reset the
  event, manage admins, or read Activity or Insights — the entire control plane
  was unreachable in production, on every URL shape, and a signed-out visitor
  never even got the "Forbidden — Organizer access only" wall, because the
  throw happened in the route file before the panel ran.

  `resolveAdminTab`, `adminTabHref` and `tabFromLocation` lived in
  `admin-controls.tsx`, which is `"use client"`. A function exported from a
  Client Component is a client *reference*, not a callable, so the two route
  files that CALL `resolveAdminTab` threw at request time: *"Attempted to call
  resolveAdminTab() from the server but resolveAdminTab is on the client."*
  They now live in `admin-tabs.ts`, which carries no marker, and
  `admin-controls.tsx` re-exports them for its own client callers — the shape
  `team-limits.ts` and `admin-admins.ts` already use.

  **Nothing in CI could see it**, which is the part worth carrying forward:
  `"use client"` is inert under vitest, so the call simply succeeds there;
  `next build` compiles it without complaint because the error is raised per
  request; and `acceptance-app.sh` never requested `/admin`. Full CI was green
  on `main` with the panel dead. Two guards were added with the fix — a static
  check that neither route imports the helpers from the client module, and an
  `acceptance-app.sh` assertion that requests `/admin` and `/admin/overview`
  against a real image and asserts the rendered copy. It asserts on **copy, not
  status**: the shell streams with HTTP 200 and the failure arrives inside the
  body, so a status check returns 200 on a fully dead panel.

  If you are running an event on a build from that window, redeploy.

- **Deleting a solved challenge no longer tells a contestant they finished
  the module (#330, #343).** The numerator on `/profile` counts solve records,
  which survive deletion on purpose — the admin dialog promises it — while the
  denominator counted the live catalogue. So an organizer who deleted two
  solved AI challenges mid-event handed every affected contestant
  "5 / 5 cleared  870 / 850 pts", a bar filled past its own end, above a board
  showing 3 / 3.

  Both halves now count the **union** by identity: the live catalogue plus any
  solve whose challenge is gone, valued at what the solve record banked, which
  is the only figure a deleted challenge still has. Clamping was the first
  attempt and is not the same thing — `max(live, solved)` stops the ratio
  exceeding one but reports 5 / 5 where the truth is 5 / 7, calling a module
  finished with two challenges still open on it. Secure Development keeps a
  clamp, having no per-item identity to union over: its catalogue is baked
  from the rubrics, so it can only lose a whole target from under banked
  points.

  The follow-up is the part worth carrying forward: the first pass moved the
  module rows and the header ceiling onto the union and **left the footer
  behind**, so one page read "500 / 700 pts" in a row and "0 pts still on the
  board" beneath it — the same wrong claim in a second voice. When a
  denominator changes, every reader of it changes with it.
- **The leaderboard and the profile now agree on how much of a module is
  left (#348).** Expanding a team on `/leaderboard` read "AI Challenges
  5 / 5 cleared" while `/profile` read "5 / 7 cleared" for the same contestant
  in the same minute. The board said the module was finished; the profile said
  five of seven, and the board's is the more authoritative-looking of the two.

  The denominator has to be the live catalogue **unioned** with items solved
  whose challenge an organizer has since deleted — solve records survive
  deletion on purpose, which is what splits the two counts. That rule reached
  the profile in #330 and #343 but not the board, because it lived inside
  `profile/module-blocks.ts`, a module the leaderboard cannot import. It now
  lives in `leaderboard/denominators.ts` and both surfaces draw from it, with
  a test that computes the same fixture both ways and fails if they diverge.

  No new Redis reads: the team fold already dedupes members' solves by item id
  (that is how a flag two teammates both solved counts once), so the ids the
  union needs were in hand and simply were not carried out of it. Rows built
  from the per-login aggregate counters still clamp, because those counters are
  running totals with no memory of which items produced them — and clamping is
  documented as the fallback it is, not a second spelling of the union.

- **Seeding demo data no longer deletes the categories an organizer
  authored (#344).** The seed wrote both module category lists with an
  absolute `SET`, so **Seed demo data** replaced them with the fixture's. The
  challenges themselves survived — they are written per-field, keyed by id —
  and the admin panel kept listing them, but the contestant board renders only
  categories present in the list. Three authored AI challenges and 850 points
  of content silently left `/ai`, together with the viewer's three solves of
  them, while the panel two clicks away read "1 category · 5 challenges" like
  a healthy setup. A master reset is no way back: it preserves authored
  categories on purpose, so the list it preserves is the seeded one.

  Both lists are now **unioned** — the organizer's order kept verbatim, then
  any demo category not already present appended, matching case-insensitively
  the way `setCategories` and classic's `importBundle` already do. Each seeded
  challenge is written under whichever spelling the union kept, so seeding
  "AI" onto a board that spells it "ai" no longer stores rows the board's
  exact-match filter cannot see. A union that would exceed the 50-category cap
  refuses outright, writing nothing, since trimming it would orphan the demo
  challenges and storing it would block every later category edit.

  The union and those challenge writes happen in **one Lua script**, not a read
  followed by a write. Upstash's `/pipeline` is not transactional, so a `GET`
  and a later `SET` leave a window in which an organizer's own category edit is
  read, ignored and overwritten — and because the challenge rows have to name a
  category the list actually holds, a rename landing inside that window would
  orphan every row the seed just wrote, which is #344 again by another route.
  Redis runs the script atomically, so the union is computed against the list as
  it is at that instant.

  Two things say so now, because an organizer can still reach that state by
  hand or through an import that spells a category differently: each module's
  admin panel warns, in amber, when challenges sit in a category absent from
  the list — with the count on the status line, which no longer reads a green
  "setup complete" above it — and the seed's confirmation names the authored
  content it touches instead of only "contestants, teams, and solves". The
  seed remains `DEMO_MODE`-only and cannot be reached in a real event.

- **`demo.gif` shows the leaderboard as it is now (#321).** The walkthrough on
  the README and the docs home still showed the pre-#294 team row — a `PTS`
  header over flat module chips above a flat target list — which is the shape
  #348 and #350 have since changed twice more. It is re-recorded against the
  running app: the score-over-time sweep reading each team's total at that
  instant, then the leading team opening into its members, one progress row per
  module, its per-target breakdown, and a target's own flags with their OWASP
  category badges and open/patched status. Nine frames at the original's
  pacing, 1456x821 to match the stills beside it.

- **The admin screenshots in the docs show the admin panel that exists
  (#321).** Four of them predated the redesign entirely: an outer `CONTROLS`
  frame with seven flat horizontal tabs, no AI tab at all, module toggles as
  checkboxes, categories as full-width rows with Move up / Move down / Remove,
  the Hardest-first table naming every challenge by generated id, and a
  standalone STATUS card that Overview absorbed. `leaderboard-team.jpg` showed
  the pre-#294 team row — a `PTS` header over flat module chips above a flat
  target list — rather than `net pts` over one progress row per module.

  All five are recaptured against the running app, and two alt texts that
  described replaced controls are corrected with them: the category chips now
  carry rename (#306) as well as move and remove, and a challenge row's
  delete lives in its row menu rather than beside Edit. `admin-support.jpg`
  now shows the state its own alt text has always described — the panel after
  a contestant lookup, not the empty form above it.

  `demo.gif` is still the pre-#294 row and is not re-recorded here: its value
  is a rising score-over-time sweep, which needs a demo-seeded event rather
  than the one this was captured on. Tracked on #321.

- **Security: two unauthenticated RCE advisories in Next.js are closed
  (#238).** `next` moves 16.3.2 → **16.3.4**, which the release notes list as
  carrying fixes for
  [GHSA-2xp9-vwfh-vxw4](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4)
  — unauthenticated remote code execution in the Image Optimization API when
  AVIF files are used — and
  [GHSA-p293-qw3h-jr36](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36),
  unauthenticated RCE on Windows-hosted servers. The bump also carries
  `@img/sharp-libvips` 1.3.2 → 1.3.3 (`sharp` stays 0.35.4).

  **The first one reaches this app.** `apps/web/next.config.ts` allows
  `avatars.githubusercontent.com` under `images.remotePatterns`, so
  `/_next/image` is a live, unauthenticated route on every deployment of this
  kit. The second does not: the app ships from `node:22-alpine`, and the kit
  has no Windows host anywhere in it — recorded rather than dropped so nobody
  has to re-derive that it was considered.

  Nothing in the kit's own code changed. It is here because this file is the
  only place a self-hosting organizer learns that upgrading is
  security-relevant rather than optional — fixes land on `main` and ride the
  next tag, and nothing is backported ([SECURITY.md](SECURITY.md)). An event
  already running should redeploy.
- **The CI workflow pins every action to a commit SHA, and stops handing the
  checkout token to build steps (#299).** `ci.yml`'s actions moved from
  floating tags to 40-character SHAs, and all thirteen of its checkouts now
  carry `persist-credentials: false`, so a compromised action release cannot
  become a compromised run of this repo's CI and a build step cannot reach the
  credential the checkout used. The kit's own CI is in
  [SECURITY.md](SECURITY.md)'s scope, which is why it is worth an entry.

  Scoped to `ci.yml`. `codeql.yml`, `pages.yml`, `terraform.yml`,
  `stock-scores-zero.yml` and `patched-scores-right.yml` still use floating
  `@v` tags and do not set `persist-credentials`; finishing them is tracked
  separately rather than quietly implied here.
- **Dependencies, CI and internals, in one place.** These would otherwise be
  silent — a Dependabot PR prompts nobody to write a changelog entry, which is
  how the two security-relevant bumps above were nearly missed:
  - `better-auth` 1.7.1 → 1.7.2 (#273). Sessions are stateless JWE cookies
    signed by `BETTER_AUTH_SECRET`, and `auth.ts`'s `disabledPaths` denylist
    is version-sensitive by construction, so auth bumps are treated as
    security changes and `auth.test.ts` gates them.
  - A **required CI gate** now fails when the duplicated KNOWN_MODULES and
    target lists disagree across `sync`, `setup`, the app and the scorer
    (#286, #288, #289) — the drift ADR 10 accepts by duplicating them.
  - A root `Makefile` wraps the commands CI runs, so `make help` lists them
    rather than each contributor rediscovering them in `AGENTS.md` (#287).
  - The quiz, classic and ai admin panels share one implementation of each
    flow instead of three copies (#278) — the refactor the module-shaped bugs
    fixed later in this release all landed once because of.
  - `architecture.md`'s flow diagrams are animated SVGs (#276).
  - An ai solve submitted through the in-box form logs its activity row, which
    only the API path was doing (#255).
  - Five documentation corrections against the code: the CI job count, the
    admin panel's real tab shell, ai's archive-bundle status, the srh caveat
    the live Lua suites closed, the CodeRabbit pre-merge check modes, and the
    three `event.yaml` keys the example omitted (#307-#311).

- **`GET /health` says which build is running.** "Did my fix reach the box?"
  had no answer from outside the container. `fly status` counts deploys, not
  commits, and needs Fly credentials; the alternative was re-testing the bug
  and inferring — which is how issue #312 sat fixed on `main` and still broken
  in production, with nothing to poll that would have said so. The endpoint is
  public, unauthenticated and liveness-only: `status`, the release `version`,
  the `revision` the image was built from, and `builtAt`. The last two are the
  ones that matter — `version` only moves on a release, so it cannot detect a
  deploy of an unreleased commit, and `builtAt` separates two deploys of the
  same commit, which a redeploy after a config change produces. Both are baked
  from build args that `deploy/fly/deploy.sh` and `scripts/dev-stack` fill in;
  a build that passes neither reports `"unknown"` and `null` rather than
  failing, because a health endpoint that can 500 is not a health endpoint.
  `deploy.sh` reports `unknown` from a dirty tree on purpose — including for
  untracked files, since the build context is the working tree and an
  untracked file is baked in just as surely as a modified one, so the sha
  would not describe the image. Nothing here touches Redis: a dependency check
  would report the app unhealthy when the app is fine, which is backwards for
  something a restart policy acts on, and that answer already exists on the
  admin Overview behind the organizer gate. The values are validated rather
  than echoed — only a hex sha and a parseable instant get through, because
  they arrive from a deploy shell and land in a world-readable body — and a
  test pins the response to exactly four fields, since the real risk to a
  public health endpoint is not that it breaks but that it quietly grows.
- **The FAQ no longer promises that case never matters.** Asked "Does case or
  extra spacing matter?", it answered "No. Matching trims leading and trailing
  whitespace and ignores case" — flatly, with no exception. A classic
  challenge can be marked case-sensitive, in which case `flagComparisonForm`
  compares the flag verbatim and the board badges the card `CASE-SENSITIVE`,
  so a contestant who read the FAQ, typed the flag in whatever casing came
  naturally and was told "Not quite." had been misled by the site itself —
  and spent the challenge's cooldown finding out. Every other string carrying
  this claim already qualifies it; the registry comment beside them says the
  qualifier is mandatory, and notes that stating it unconditionally shipped
  once before, in v0.3.0. The FAQ answer now names the exception and points at
  the card, and the classic-only FAQ test asserts the **answer** rather than
  only that the question rendered — which is how the wrong one survived.
- **Secure Development has no hints, and the app stops implying otherwise.**
  Two changes in this window, and the second reversed the first's premise, so
  they are recorded as one arc.

  With hints switched on, no 💡 ever appeared on a target's challenge rows and
  the banner stated, as fact, that "no challenge is offering one yet". It could
  not know that: `getHintAvailability` hand-rolled Upstash's path-style
  `GET /hkeys/<key>` so the read could ride Next's ISR cache, and **srh does
  not serve that route** — it answers `404 SRH: Endpoint not found`, and srh is
  what every deployment of this kit runs in front of Redis. The read failed on
  every render, the `catch` turned it into `{}`, and "the read failed" became
  "there are no hints". That transport bug was real and is fixed (#313): the
  read went through `upstashPipeline`, which srh does serve, and a per-command
  error now throws so the fail direction applies rather than being reported
  positionally and ignored.

  Fixing it revealed there had never been a **producer**. Nothing in this kit
  writes a `hints:<app>` field — not the scorer (which has no concept of a
  hint, despite three comments here calling those hashes "scorer-owned"), not
  the admin panel (Secure Development's tab has no hint field), not the
  rubrics. So a working read could only ever come back empty while
  `/challenges` reported that to contestants as news, and the Hints tab told
  organizers each module "holds the hint text on its own tab" — true of Classic
  and AI, false there, sending them to a tab with no such field.

  So Secure Development is out of the availability read (#334):
  `getHintAvailability` returns `{}` and reads nothing, `/challenges` shows no
  hint banner and no 💡, and the Hints tab names Secure Development alongside
  quiz as having none. It is kept as a function returning the same shape, so
  reviving it is one edit if secure-development hint text ever gains an author
  — the three candidate designs are recorded in #334.

  **Classic and AI hints are unaffected throughout.** Both are authored through
  their own admin tabs into `ctf:classic:hints` / `ctf:ai:hints`, both read
  through `upstashPipeline`, and the four hint settings, the pricing, the
  gates, the penalty column and the reveal machinery all keep working for them.

- **Classic and AI now tell contestants that a hint costs points.** Secure
  Development's rules and terms have always said "Revealing a hint deducts
  points from your total"; classic's and ai's never did, though all three sell
  hints through the same gate and the same four settings. On a classic-only or
  ai-only event the price of a hint reached a contestant only from the reveal
  button itself. Both modules' `rules` and `terms` scoring copy now carry the
  sentence, mirroring secure-development's two variants. Quiz is deliberately
  untouched — it sells no hints, so the sentence would be a lie there — and a
  registry-level test now asserts exactly that split.
- **A category can be renamed, and its challenges come with it.** Categories
  could be added and removed but never renamed, and removal is refused while
  any challenge still files under one — so fixing a typo in a category ten
  challenges already used meant editing all ten and then deleting the old
  name. Each chip on the Classic and AI tabs now has a **Rename** control that
  edits the name in place and rewrites every challenge in that category in the
  same operation. Renaming onto a name another category already holds is
  refused rather than merged (merging is a different, lossier request);
  changing only the capitalisation of the same category is a rename, not a
  clash. The rename travels as its own request shape rather than through the
  category array — replacing the whole list is precisely what cannot express a
  rename, since a renamed entry is indistinguishable from one removed plus one
  added, and that is how the challenges lost their association with it. The
  challenges are written first and the list last, so an interrupted rename is
  finished by simply running the same rename again, and no challenge
  disappears from the panel while one is half-applied.

- **The number beside a challenge is where it actually sits, and a team's
  slug is never retyped.** Each module list printed the row's stored `order`
  field, which is not a position in anything on screen: on a board seeded per
  category it repeats — four rows read `#1`, four read `#2` — under a sentence
  promising contestants see them in that order. The list now numbers rows
  itself, from where they sit in the group being displayed, so the numbering
  restarts per category exactly as the reader's eye does; the stored field is
  untouched and still drives the real ordering. On **Support**, the contestant
  card knew the team's slug and the team actions below still made you type it,
  which is how the commonest ticket on that tab started; the card now offers a
  control that fills the field and puts the cursor in it. Disband and Transfer
  keep their confirmations where they are — a card whose subject is a person
  is not the place for a second trigger on a team-wide action. That card's
  `joined` timestamp also now says **UTC**, which the line directly beneath it
  had been saying all along.
- **Nothing in the admin panel destroys work without asking.** Opening a
  different question or challenge — or clicking Add — replaced a half-written
  draft in silence: the module forms sit *below* the list, so every list
  control stays live while you write, and text typed into one prompt vanished
  the moment Edit was clicked on the next row. All three panels now ask before
  discarding, through one guard in the shared editor hook; a form with nothing
  typed into it still opens straight away, and a save in flight is left alone.
  On the **Admins** tab, removing a colleague fired immediately on the click,
  with no gate at all, while removing *yourself* used `window.confirm` — the
  one native dialog in a panel where every other destructive action has a
  focus-managed, styled one. Both now go through that dialog, each with the
  consequence stated, and neither asks you to type a phrase: losing panel
  access is recoverable by any other admin, and reserving type-to-confirm for
  what genuinely cannot be undone is what keeps organizers reading it.
- **The admin panel calls things by the names an organizer uses.** Insights'
  Hardest-first table and its CSV named every challenge by generated id
  (`case-probe-control-xf1ob0`), never by title — unreadable out loud at a
  closing ceremony, and the quiz and challenge lists two tabs away had shown
  titles all along. Both now carry the **title** (a quiz question's prompt, a
  challenge's title) with the id kept beside it, since the id is what a support
  question and a store key name; a challenge deleted since it was solved keeps
  its metrics and falls back to its id, and a catalogue read that fails costs
  the labels, never the numbers. Elsewhere in the panel one thing had four
  names: a classic solve was a "flag solve" in Activity under a tab called
  Classic CTF, an ai solve was "ai solve", and Insights said "Sec-dev" and
  printed raw module ids in a column headed Module — all of them now use the
  module's own name, pinned to the registry by a test. The AI **Send test**
  verdicts (`no-team`, `wrong-mode`, `paused`, …) were raw strings whose
  decoder ring lived only in `docs/operations.md`; each now carries a sentence
  saying what it means, and the three that are *not* integration faults say so
  first. And an event with no Secure Development no longer opens its admin page
  with "Sync not running." forever — there are no forks to poll, so the section
  is simply absent, while an event that does serve the module still gets the
  warning, now saying what it costs.
- **The Event tab stops understating what its three biggest controls do.**
  **Freeze scoring** said only "Pause new submissions from being scored", so
  the one thing an organizer has to relay to a room — *your PR score is real,
  the board is on hold* — was nowhere on the switch. It now says which
  submissions are refused, that fork Actions keep judging and commenting and
  that those scores land on unfreeze, and it quotes the sentence contestants
  actually read ("Scoring is paused right now. Try again later.") so a help
  desk recognises it. Overview's **Scoring** switch is the same setting and now
  shares that copy from one module instead of a drifting duplicate.
  **Master reset** listed what it destroys and never what it keeps, which is
  most of an organizer's evening: it now says authored questions, challenges,
  flags, hints, categories and every setting survive, that the AI launch key is
  rotated, and it explains the poll-mode caveat instead of assuming the reader
  knows their `SCORE_INGEST`. The **Event archive** moves out of the red Danger
  zone into its own section with a visible disclosure arrow — Export writes
  nothing and is what you run *before* something risky, and painting it like a
  wipe taught the opposite — and its description says "Classic, Quiz and AI",
  which is what the bundle has always carried.
- **Four admin editor bugs that each cost an organizer a save.** Renaming a
  quiz choice's id left the old id in the answer key: the panel said the
  question was saveable and the store answered 400 (#280). A title or prompt
  whose first word ran past the 48-character confirmation cut could end in
  half an emoji — a phrase no keyboard can type, so that item could not be
  deleted at all (#281). The classic and ai forms opened with the cursor
  nowhere and the quiz form opened it in a choice-id box rather than the
  prompt (#282). And a file the browser could not read was dropped in
  silence, leaving the textarea unchanged with no explanation — on the
  quiz/classic importers and on the event archive alike (#284).
- **Every admin destination has its own URL.** `/admin/overview`,
  `/admin/activity`, `/admin/insights`, `/admin/support`, `/admin/event`,
  `/admin/hints`, `/admin/admins`, and one per enabled module
  (`/admin/quiz`, `/admin/ai`, …). The sidebar links to those paths, so a
  link is safe to bookmark, paste into a runbook, or read out over a call —
  and switching tabs now updates the address bar (`pushState`, no page load),
  with Back walking the destinations, so the URL always names the screen in
  front of you. Previously the panel lived at `/admin` alone: every tab click
  was intercepted client-side, and the address bar kept saying `/admin`
  whatever was on screen. The older `/admin?tab=<id>` form still works and
  still means the same thing, both shapes render the same shell — one gate,
  one set of reads — and an unrecognised tab in either form still falls back
  to **Overview** rather than 404ing.
- **Every AI endpoint now demonstrates itself.** The panel shipped a
  ready-to-run curl for one route — `/api/ai/event`, on each challenge's own
  row — and left the other two as a URL and nothing else: an organizer could
  copy `/api/ai/submit` and still not know whether it wanted a header, what
  came back, or what a wrong flag looks like next to a refusal. Each of the
  three endpoint URLs now carries a collapsed demo answering **send /
  receive / expect**: a runnable request, the `200` it returns, and the
  refusals worth designing for (a wrong flag and a cooldown for Submit;
  `invalid-signature`, `stale-request` and `replay` for Event; an expired
  token and the 120/min budget for State). **State** is marked *read-only* —
  the one route of the three that writes nothing, so it can be tried against
  a live event with no consequence. Every value is a placeholder; the real
  signing key and the one-click dry run stay on the per-challenge row, and a
  test asserts no key- or token-shaped string reaches the demos.

- **The AI panel says what the external site has to do, and the token
  handshake has a diagram.** The panel handed an organizer the endpoint URLs,
  a per-challenge signing key and a Send test button, then told them to
  "stand up the external challenge site against the integration contract" —
  fine for whoever writes that site, no help to the organizer standing
  between them and it. A new **Wiring the external site** drawer, collapsed
  above the challenge list, gives the handshake in five steps (take the token
  from `{token}`, verify it with the public launch key, re-read State for
  live progress, report the solve signed over
  `"<timestamp>.<raw body>"` within ±300s, expect one award per `jti`) and
  sets the two keys side by side — the **launch key** is public, one per
  event, and fetched; the **signing key** is secret, one per challenge, and
  pasted — because conflating them produces a signature failure that looks
  exactly like a wrong key. The AI module's setup checklist now names those
  four external-side requirements instead of deferring all of them to a link.
  `docs/ai-module.md` opens with a new animated diagram of the whole
  handshake, and the operations guide's AI section carries it too, above a
  checklist of what an operator configures on the far end. No store, key or
  API change; no secret is rendered by the new drawer.
- **The profile and the leaderboard show progress the same way, and a module's
  ceiling adds up.** `/profile`'s Secure Development header read
  "6 / 321 patched  8 / 0 pts" — earned 8, available 0 — above target rows
  whose own ceilings summed to 668: the lambda source returned a hardcoded
  `maxPoints: 0` for a profile while computing a real one per target. It now
  sums its targets', as the mock source always has. Every level of both
  screens — module, target, and a module with no targets — is one shared row
  (`components/progress/`): its bar measures points (what the board ranks on,
  and the only measure that means the same thing at each level), with a
  minimum visible fill so early progress is not a dot on a grey line; its
  count carries each module's own word (`patched` / `answered` / `solved` /
  `cleared`, and `flags` as classic's verb), so a team card can no longer read
  "3 answered · 3 solved · 3 solved" for two different modules; and its points
  sit in a fixed right-aligned column, ending the run-together
  "1 / 38 patched2 / 141 pts". An expanded target groups its challenges by
  OWASP category with the most winnable group first, sinks the done rows, and
  collapses them behind a **Show patched (n)** toggle past ten rows. The
  profile gains one line of genuinely new information — how many points are
  still on the board and which module holds most of them — and an expanded
  leaderboard team renders that same tree read-only, replacing a chip row that
  gave points with no denominator and a target list that gave counts with no
  points; a team's hint spend is no longer shown to rivals, so its total is
  labelled `net pts`. No store, key or API change.
- **Module screens are content screens (admin redesign, PR 3 of 3).** Each
  module's admin screen opens with a sticky header — its name and an
  **Enabled** switch, the same control as Event's Modules row — and a setup
  status line ("Setup complete · 4 categories · 12 challenges") that opens
  into the checklist only while a verifiable step is still to do; steps done
  outside the panel are no longer repeated, and the safe / not-safe mid-event
  lists move into their own drawer. One compact **Settings** card holds the
  title, blurb, the module's knobs and a link to Hints. Categories are a row
  of inline chips (move left/right, remove on hover or focus). Challenge lists
  are grouped by category with a count per heading, and each row keeps Edit
  on the row with Move up / Move down / Delete in a **⋯** menu; the AI board
  renders through the same list with its integration disclosure under each
  row. Danger red is reserved for what cannot be undone: Delete and Remove
  are neutral until their confirmation, Rotate is amber, and a **solved** or
  **would-award** Send test is green. The admin's type floor rises: nothing
  under 12 px, explanatory text at 14 px, dense tables and eyebrows keep
  12 px. Stored keys, API routes and validation are unchanged.
- **The admin's live views refresh themselves, and every switch says whether
  it saved (admin redesign, PR 2 of 3).** Overview, Activity and Insights
  load when opened — never on page load, so reaching Support still costs no
  Redis read for the O(contestants) metrics fold — and, while the event
  phase is live, refresh every 15 s (Insights every 30 s), each with an
  "updated Ns ago · refreshes every 15 s" stamp that turns into
  "auto-refresh paused while the event is not live" before scoring opens or
  after a freeze; a hidden browser tab never polls, and Activity's timed
  refresh re-reads as many rows as were paged in rather than snapping back
  to page one. The Refresh buttons become secondary and share the timer's
  code path. A new `AdminSwitch` replaces every native checkbox in the panel
  (module switches, Freeze scoring, Team registration, Overview's Scoring and
  Registration, Hints enabled) with a real `role="switch"` that reports
  "Saving… / Saved / <the refusal>" beside the row, through the same status
  line the numeric fields use — the numeric fields, in turn, lose the native
  spinner that clipped five-figure values. The settings audit line ("last
  changed by …") no longer appears under Activity or Insights, and the
  Insights sparkline gets a time axis. Stored keys, API routes and validation
  are unchanged.
- **The admin panel has a sidebar, an Overview, and a compact header (admin
  redesign, PR 1 of 3).** The nine flat tabs are now a left sidebar in three
  groups — Run (Overview, Activity, Insights, Support), Content (one per
  enabled module), Setup (Event, Hints, Admins) — collapsing to a drawer on
  narrow screens. Deep links stay `?tab=<id>`; an unknown id falls back to
  the new **Overview** instead of Event. Overview answers "is scoring on, how
  many teams, is anything stuck" in one screen: phase and time remaining,
  Scoring and Registration as switches, the four funnel figures (Stuck first
  when non-zero), the sync health line folded in from the old Status card,
  the five most recent activity rows, and a setup-status line per module —
  read-only apart from the two switches, and a snapshot for now (the 15 s
  refresh is PR 2). The header is one row (`Admin · event · phase · until
  date`) reusing the public phase strip's vocabulary; the "Organizer / Admin"
  block and the outer Controls frame are gone. The hint policy moved out of
  Event onto its own **Hints** destination — stored keys and validation
  unchanged, as with its earlier moves. Every existing tab renders unchanged
  inside the new shell.
- **Every fail-direction gate in the pause/schedule contract is now pinned by
  a test (#232).** `hint-store.ts` `revealHint` documents and pins fail-CLOSED
  on a settings-read error (never charge on uncertainty); `team-store.ts`
  `isRegistrationClosed` now catches a transport failure the same way it
  already tolerated a per-command error, failing OPEN on both (a Redis blip
  must not itself block registration — the join/create Lua script still
  validates every real invariant atomically) — matching
  `resolveTeamMaxMembers`'s existing reasoning right above it. A new shared
  differential corpus, `test/fixtures/window-corpus.json`, is run verbatim by
  all three `outsideWindow` readers (`apps/web`, `scorer`, `sync`) so a
  `<`→`<=` flip at the exact scheduled-window boundary in any one of them
  fails CI even if that reader's own hand-written cases miss it.
- **Every numeric setting says whether it saved.** The nine numeric knobs and
  the four schedule fields now report beside the field: "Saving…" while the
  write is in flight, "Saved" for a moment after, or the reason it was refused
  — junk, a fraction, a negative or a blanked field snaps back to the stored
  value *with* that reason, and a server rejection is rewritten through the
  field's label ("Hint cost must be a whole number between 0 and 100,000.")
  instead of landing as `hintCost must be an integer in [0, 100000]` under
  the whole panel while the rejected text stayed in the box (admin UX audit
  F2). The refusal is announced (`role="alert"`) and tied to its input
  (`aria-invalid`, `aria-describedby`). One shared component,
  `components/admin-number-field.tsx`, replaces the hand-written pair on
  every tab; stored keys and server validation are unchanged.
- **The AI tab is a list again.** The three module-wide endpoint URLs render
  once above the challenge list instead of inside every row, and each row's
  integration panel (signing key, test curl, Send test) is collapsed until
  opened — three challenges had made the tab 2,253 px tall, 542 px a row
  (F5). A flag-only row's summary says the panel is not needed for it.

- **Hint policy moved to the Event tab.** The four hint knobs (enabled, cost,
  solves required, unlock after) govern Secure Development, Classic and AI
  hints alike, but rendered only on the Secure Development tab — so a
  classic-only or ai-only event sold hints at the default price with no switch
  anywhere in the panel (admin UX audit F1). They now sit in a **Hints**
  section on Event, under the schedule, and the unlock-after help names the
  **Scoring opens** field instead of pointing "below" at a tab that no longer
  held it (F6). Secure Development keeps its re-run cooldown. Stored keys and
  server-side validation are unchanged.
- **The blurb help tells the truth.** The module-identity blurb's help text
  said it was "not shown on any page"; it is the lede under the title on the
  quiz, flags and AI boards and those pages' meta description. The help now
  says so (admin UX audit F3).
- **Support shows AI progress.** The contestant lookup reads the AI solves,
  attempts and points alongside quiz and classic, the card shows them, the
  attempts total includes them, and the reset-progress confirm names "classic
  and AI solves" and sums all three modules' points — the total the reset
  actually removes (F4). "Sec-dev solves" is spelled out as Secure Development.
- **Every module tab opens with a setup checklist.** A new registry contract,
  `ModuleDef.setup` (module contract §5.9): what contestants experience, the
  minimum to make the module playable in dependency order with each step
  marked in-panel or outside, what is safe to change mid-event, and a link to
  the module's operations guide. Rendered by one shared component ahead of the
  identity editor; where the panel holds the count (questions, challenges,
  categories) the step shows it live, and says "Checking…" until it does.

- **`pnpm lint` is green and CI runs it.** The app's lint had sat red (4
  errors, 5 warnings) with nothing running it — hygiene audit T1. Each
  finding is fixed in the code rather than excused: the three
  `set-state-in-effect` errors by parking the nav dropdown's focus request in
  a ref and moving the admin panels' mount-time fetch to a module-level
  function whose result the effect applies in a callback; the render-time
  `Date.now()` in the Event tab's schedule readout by stamping "now" in the
  handlers that apply settings; the rest by deleting the dead imports, the
  dead `hasSecureDev`, and a `next/image` mock nothing under its subject
  rendered. No `eslint-disable` added, no rule downgraded. The `app` CI job
  now runs `corepack pnpm lint` right after install, and AGENTS.md,
  CONTRIBUTING and the README's command lines carry the same step. Dead code
  the audit proved dead goes with it: the never-wired `score-check.tsx` (and
  the `check-land` keyframe only it used), the unused `tsx` devDependency,
  the whole-catalogue totals in `apps.ts`, the dead re-exports in `ai-keys`
  and `admin-store`, the exported-but-in-file-only `toCatalogChallenge`,
  `enabledModuleRoutes` (the proxy gates the registry's full route list on
  purpose — see the comment on `GATED_ROUTES`), and the single-team
  `getTeamQuizTotals` wrapper whose only caller was its test. All internal to
  `apps/web`; no behaviour changes.
- **The profile page names the team hash through `teamKey`, and the judge's
  network comments say what the network is.** `profile/page.tsx` still
  open-coded `ctf:team:<slug>` twice — the reader ADR 48 moved the builders
  into `team-keys.ts` for — behind a comment excusing it; it now imports
  `teamKey` like every other reader, and a source-scan test keeps the literal
  from coming back. `scorer/entrypoint.sh` and `scorer/entrypoints/webgoat.sh`
  described `$NETWORK` as `--internal`; it is a plain `docker network create`
  bridge (as `docs/scorer.md` already said) on which the app under test
  publishes no host ports. Comments only — no `docker network
  create` line changed.
- **Every live Redis suite runs in CI now, not just the grading Lua.** The
  `hint-store` and `team-store` `.upstash` suites had rotted (#235): the
  reveal path grew an anti-burner gate that refused every purchase the suite
  made (it seeded a hint but no solve), and a populated team's captain can no
  longer simply leave. Both are repaired against the current rules — the hint
  suite seeds its policy through `updateAdminSettings` and earns the gate
  with a solve, asserting on the way that the refusal charges nothing; the
  team suite asserts the captain refusal is a no-op, then transfers and
  leaves — and each still goes red when the store it covers is mutated by
  one line. The three older suites gate through `live-redis.ts` like the Lua
  ones, so `CTF_LUA_SUITES_REQUIRED=1` covers them too, and the CI step runs
  every `*.upstash.test.ts` file (`vitest run upstash
  --no-file-parallelism`, serial because two suites share
  `ctf:admin:settings`). No runtime behaviour changes.
- **Four HIGH Dependabot alerts in the app lockfile cleared.** `browserslist`
  (two advisories), `js-yaml` and `brace-expansion` — all dev/build-side
  transitives of `next` and `eslint-config-next` — re-resolved to patched
  versions. `browserslist` needed an `overrides:` floor in
  `apps/web/pnpm-workspace.yaml` because pnpm would not move a package that
  is also a peer of `update-browserslist-db`; the comment there says when to
  drop it. pnpm is now pinned for corepack via `packageManager`
  (`pnpm@11.25.0`, the version CI was already resolving), so the settings
  file's semantics no longer depend on whichever pnpm corepack fetched that
  day. No runtime behaviour changes.
- **Store `catch` blocks log a redacted label, never the exception object,
  and a bulk import refuses to write after a failed read.** The classic and
  quiz stores logged the raw caught value at six sites, three of them the
  `catch` around the grading call whose arguments are the submitted flag or
  answer — hardening, not a reported leak: no error shape reachable today
  carries them, but a driver that attached its failed request would have put
  the event's flags in the log. The ai store's `errorLabel` (#241) is now a
  shared `lib/error-label.ts` used by all three (#244). Classic's and quiz's
  `importBundle` also inspected neither reply of their membership read, so a
  transient `GET ctf:classic:categories` failure became an empty category
  list that the write pipeline then made permanent; both now throw before
  any write, as the ai store already did (#261).
- **Docs reconciled with the code the hygiene audit compared them against.**
  The review guideline's public-surface list names all five unauthenticated
  `/api` routes (it said three), the same-origin carve-out and rate-limit
  lists include the ai module's routes, and the team-required boundary names
  `/api/ai/submit`; CONTRIBUTING counts ten CI jobs and four modules and
  lists `acceptance-ai-only.sh`; the README's copy-pasteable scorer test line
  runs `acceptance-scorer.sh` from the repo root, where it lives; the
  pre-event gate's scope is stated once and correctly (`apps/web/.env.example`
  said the module APIs were not behind it — they are). Two shipped planning
  files (`docs/DOCS-PLAN.md`, `docs/DOCS-CHANGELOG.md`) and the
  `github.oauth_client_id` key in `event.yaml.example`, which no reader ever
  read, are removed.
- **The grading Lua is executed by tests now, against a real Redis.** Classic's
  `SUBMIT_SCRIPT`, quiz's `GRADE_SCRIPT` and ai's `AWARD_SCRIPT` — the
  scripts that decide points — had never been run by any test; the mocked
  suites pinned only the arguments handed to them. Three
  `*.lua.upstash.test.ts` suites now run the real scripts against redis +
  srh (skipped locally without the env, required in CI), and each of the
  six one-line Lua mutations the August review found survivable now fails a
  test. The three script constants are exported for that purpose; nothing
  else about them changed.
- **The event archive now carries the AI catalogue** (#250, #155's ai half).
  Export writes an `ai` section — challenges with their mode, launch URL
  template, flag, hint, categories and per-challenge signing key — and
  import clears and replaces the AI board like the classic and quiz ones, so
  an archived event no longer loses its AI challenges and an external site
  configured against a signing key keeps working after a restore. The
  module's launch keypair is deliberately not in a bundle and an import
  leaves the box's own pair alone. Bundles exported before this change
  still import unchanged (the section is optional); a bundle with an `ai`
  section imports into an older box only after removing it.
- **`ctf-setup.sh --dry-run` is dry again, and `--out` is honoured
  everywhere.** The wizard's org step probed the org with `gh api` and ran a
  full `doctor` sweep even under `--dry-run`, and step 1 probed `gh auth
  status` / `docker compose version`; all are narrated instead. `secrets`
  writes its env file owner-only (`0600`) regardless of the caller's umask.
  `org` read `SCORE_IMAGE` from a hardcoded `.env` even when `--out` named
  another file. A value-taking flag left without a value now fails with the
  script's own message rather than bash's "unbound variable".
- **Acceptance scripts fail loudly, not silently.** The bare `grep -q`
  assertions in `acceptance-app.sh` and `acceptance-quiz-only.sh` died under
  `set -e` with no output; each now names what was missing.
  `acceptance-patched.sh`'s "no challenges found" guard was unreachable for
  the same reason. `scripts/dev-stack` (no `.sh` suffix) is now in CI's
  shellcheck list.
- **Redis reads that fail now say so, everywhere.** `sync`'s pipeline client
  used to swallow a per-command error reply (`WRONGTYPE`, `NOAUTH`, an
  unsupported command) as `undefined`, which its callers read as "not paused",
  "no reset" and "status written" without a log line; it now throws like the
  scorer's client, so every caller's documented fail-open direction still
  applies but is visible. The scorer's own pause read logged nothing on
  failure; it does now.
- **A hung Redis proxy can no longer stall the poller or a score POST.** All
  three Upstash/SRH pipeline clients (`apps/web`, `scorer`, `sync`) abort a
  round trip after 10 s instead of waiting forever.
- **Numeric knobs are validated instead of silently misbehaving.** A
  non-numeric `POLL_INTERVAL_MS` used to poll GitHub in a tight loop
  (`setTimeout(NaN)` fires immediately — and so does any value past
  `setTimeout`'s 2^31−1 ms cap, so the accepted range is now 1 to
  1 789 569 705 ms) and a non-numeric or blank scorer `PORT` bound a random
  port (`PORT` must now be an integer 0–65535; the default stays 4000).
  Both refuse to start with a clear message; a running event is unaffected
  unless it already carried an invalid value, which never worked. An
  installation token whose `expires_at` is missing, unparseable or already
  past is rejected instead of being re-minted on every call.

## v0.4.0 — 2026-09-01

A playable Classic CTF, an event you can carry somewhere else, and a
front end that tells the truth.

- **Classic CTF** became a board rather than a form: a category-grouped tile
  grid with a dedicated page per challenge (#208), and **paid hints** sold
  through the same gate, price and penalty machinery as secure-development
  (#190). The hint penalty nets the FINAL total as the scoring pipeline's
  last stage, so a hint bought against one module can never be discounted by
  another module's points.
- **Event archive**: export a whole event — catalogues, teams, solves,
  settings — to a JSON bundle and import it back (#155). An event is now
  portable between boxes, and a finished one can be kept without keeping its
  infrastructure.
- **Teams first.** Team setup is the first step after sign-in (#219), rather
  than something a contestant discovers after their first solve banks into no
  team total.
- **Admin activity log**: login timestamps plus a filterable event stream on
  a new Activity tab (#213) — the mid-event question "did anyone sign in
  yet?" answered without a Redis console.
- **Visual identity**: the original navy/blue terminal look enhanced rather
  than replaced, with progress displays that read at a glance (#207).
- **Accessibility and resilience**: per-route loading states, error
  boundaries that keep a failure inside the segment that caused it, a skip
  link, focus handling that survives a control being replaced, and mobile
  fixes (#240).
- **A contestant-facing copy/UX truth pass** (#200, tiers 1–4): honest
  claims, state-aware affordances, an effective-state readout, and every
  module accounted for on the leaderboard and profile.
- **Audit and correctness fixes**: quiz freeze reads fail open like classic
  (#215); hint penalties and roster rows match case-insensitively (#216);
  signing out of a session-gated page redirects home (#214); classic carries
  `caseSensitive` back out of the store, so a case-sensitive challenge stays
  badged and exports correctly (#196); a challenge page's 404 now attaches to
  the right boundary and says which of its two causes fired (#208
  follow-ups).
- **Sign-in and navigation fixes**: post-signin redirects are relative rather
  than derived from `request.url`, fixing a localhost bounce (#227); the
  avatar menu survives session revalidation (#228); the user menu closes
  reliably and its links work in Brave (#223).
- **Documentation overhaul** (#218): README rewritten (status above the fold,
  a fair comparison, a working no-GitHub quickstart), stale-doc drift fixed
  across the set, ADR and section anchors made renderer-stable, a new
  troubleshooting runbook and glossary, and an explanation of how Insights
  computes each figure (#198). The landing copy's false "each app is an OWASP
  project" claim is corrected and the baked "OWASP CTF area" strings now
  follow `event.name`; the OWASP-CTF default branding is kept.
- **Review and CI**: a tuned CodeRabbit configuration carrying this repo's
  own invariants as pre-merge checks (#220, #225, #236), with the
  breaking-change documentation check demoted to a warning after it blocked a
  PR on a stale snapshot of its own description (#242); cross-area CI
  path-filter edges closed so a touched area can no longer skip its jobs
  (#236); every fork-repo-name reader pinned to `setup/targets.tsv` (#199);
  a reference patch for Security Shepherd's `Challenge-10-IDOR-2` (#221).
- **Dependencies**: Redis 8-alpine, the Next.js group, and
  `github/codeql-action` v4.

No breaking changes: no `event.yaml` key, `ctf:*` Redis key, scorer payload
or `ctf-setup.sh` flag changed shape. An event running v0.3.0 upgrades by
redeploying — which also moves Redis from 7-alpine to 8-alpine. Redis 8 reads
a 7 AOF dataset, and the compose file keeps it on the named `redis-data`
volume, so scores survive the container being replaced. Pause the event from
`/admin` before redeploying a live one, and do not bring the stack down with
`-v` — that removes the volume, which is the one action here that loses data.

## v0.3.0 — 2026-08-23

Three modules, runtime admin controls, zero vacuous passes.

- **Quiz** and **Classic CTF** shipped as full modules — authored from
  `/admin` (single and bulk JSON-bundle authoring), graded in the app,
  each able to run an event alone with no scorer or GitHub org.
- The admin panel became the runtime control plane: grant/revoke admins,
  switch modules on and off mid-event, set the team cap, scoring cooldown,
  scheduled scoring and registration windows, per-module titles — all
  without a rebuild. Support actions (reset/delete a contestant, take over
  a team) and engagement metrics (Insights) landed alongside.
- Teams: required to score, one-click solo play, shareable `/join/<code>`
  links.
- Security hardening: Redis authenticated and cut off from the app tier,
  same-origin assertions on mutating routes, rate limits on join/reveal,
  HTTPS enforced for production events.
- The vacuous-pass war: a sweep that points every rubric at an
  up-but-useless stub reached **0 of 321** and became a CI gate.
- Deploys: the whole stack as one Fly machine running the repo's own
  compose file; workflow version-stamping with a per-fork `upgrade` path;
  `doctor` verifies the package Read grant by observation.

## v0.2.0 — 2026-08-16

Guided wizard, AWS deploy, verifying doctor.

- `ctf-setup.sh` became a resumable guided wizard that prompts for every
  value inline and does each automatable step.
- Single-shot AWS deploy: a Terraform module for one ephemeral EC2 box.
- `doctor` grew into the per-fork provisioning status matrix.

## v0.1.0 — 2026-08-15

First tagged release: the full offline-tested kit — compose stack, poll
pipeline, six vendored target rubrics.

- **Security (critical):** closed the score-comment forge — the scoring
  workflow could be made to post a contestant's own forged
  `<!-- ctf-score: -->` marker as `github-actions[bot]`. The judge's report
  now lives outside the PR checkout (`CTF_OUT_DIR`) and is posted only when
  the scorer step succeeded.
- Hardening: baseline security headers in both Caddyfiles; the srh proxy
  image pinned by digest.
