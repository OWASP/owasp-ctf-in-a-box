# Changelog

Releases are repo-level annotated tags cut from `main`
([SemVer](https://semver.org/)); GitHub Releases carry the generated
commit-level notes, and this file keeps the human summary. The version is
repo-level — `apps/web/package.json` tracks the current tag; `scorer` and
`sync` deliberately carry no version field.

## Unreleased

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
  closed when it cannot tell which modules are live; `--clean` scans the
  store for the harness's own `load-NNNN` rows and removes exactly those, with
  no catalogue and no `--count`. `scripts/load-test.sh` ships it there, drives
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
