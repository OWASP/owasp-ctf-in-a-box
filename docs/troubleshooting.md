---
title: Troubleshooting
---

[← Docs home](index.md)

# Troubleshooting

For the organizer mid-event, ordered by the symptom you actually see —
diagnosis, then fix. Setting up for the first time? That's
[hosting.md](hosting.md). Verifying before the event? The checks in
[operations.md](operations.md#verifying-it-works) and the
[security checklist](security-checklist.md) catch most of this page before it
happens.

The two commands this page leans on:

```sh
docker compose logs -f sync            # the poller's own account of itself
docker compose exec redis redis-cli HGETALL ctf:admin:settings   # the live overrides
```

(`redis-cli` authenticates itself inside the container via `REDISCLI_AUTH` —
no password on the command line.)

**On AWS (ECS)** there is no `docker compose` and no `redis-cli`. The same
two views are:

```sh
aws logs tail /ecs/<name>/sync --follow          # the poller's own account of itself
aws ecs describe-services --cluster <cluster> --services app srh scorer sync \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount}'
```

and a Redis read goes through srh from an ECS Exec shell in the app
container. The exact command, how to get the shell, and every other ECS
recipe are in the [AWS event-day runbook](aws.md#running-the-event-on-aws).

## `docker compose up` refuses to start: "set REDIS_PASSWORD in .env"

**Symptom.** Compose exits immediately at interpolation with that message.

**Diagnosis.** Deliberate. Redis runs with `requirepass`, and compose reads
the variable with `:?` so a missing or empty value fails the bring-up
instead of quietly starting an unauthenticated Redis.

**Fix.** Add `REDIS_PASSWORD=$(openssl rand -hex 24)` to `.env` (a `.env`
from before the kit required it is the common case), or run
`./setup/ctf-setup.sh secrets` on a fresh checkout. Note the same
interpolation failure inside a script that pipes compose's stderr to
`/dev/null` looks like an empty service list, not an error.

## `/admin` says Forbidden for everyone, including you

**Symptom.** Nobody — including you — can open `/admin`; every account gets
the Forbidden page.

**Diagnosis.** An admin is a kit account that claimed an admin claim code at
`/admin/claim`
([ADR 72](decisions.md#adr-72-admins-are-claimed-with-a-one-time-code-not-named-in-env)).
The Forbidden page names which case you are in:

- **"No organizer has claimed this box yet."** Nobody has claimed. Sign in,
  open `/admin/claim` and enter the code provisioning printed. Lost it?
  Rotate it (**Fix**, below).
- **"ADMIN_CLAIM_CODE_HASH is not set or is not a SHA-256"** as well. The app
  has no usable hash, so nobody can claim with a bootstrap code. A code an
  admin issued would still work, but with nobody claimed there is none. The
  key is missing from `.env`, the app container was not recreated after it
  was set (`docker compose restart` keeps the old environment), or the value
  is the code itself pasted where its hash belongs (64 lowercase hex is a hash; eight groups of
  four is a code). Compose must also pass `ADMIN_CLAIM_CODE_HASH` through to
  the app service's environment — `docker-compose.yml` does, but a customized
  override file that dropped it reproduces this symptom.
- **No notice.** Admins exist, and you are not one of them. Ask an admin to
  issue you a code from the Admins tab. If no admin can sign in any more,
  rotate the bootstrap code (below): it works whether or not admins exist.

`ADMIN_LOGINS` is not read by anything; a line left in `.env` grants nothing.

**Fix.** Rotate the bootstrap code. Each command prints the new code once:

- **Compose box:** `./setup/ctf-setup.sh admin-code`, then recreate the app
  container (`docker compose up -d --no-deps --force-recreate app`) — no
  rebuild, since this is a runtime read, but not a plain
  `docker compose restart` either, which keeps the old environment.
- **Fly:** `./deploy/fly/deploy.sh --skip-build --new-admin-code`.
- **AWS:** `./deploy/aws-terraform/deploy.sh --skip-build --new-admin-code`.

Then claim at `/admin/claim` with the printed code; hyphens and case do not
matter. A code wrongly entered five times locks that account's claims for 15
minutes.

## Only the landing page loads (module pages redirect to `/`)

**Symptom.** Contestants open `/challenges`, `/flags`, `/quiz` or
`/leaderboard` and land back on `/`, which says **Launching soon.** or shows
a countdown; a script calling a submit or answer API gets
`403 { "error": "not-launched" }`. You, signed in as an admin, see every page
normally.

**Diagnosis.** The event is not launched. Since #464 an event is launched
only once its **Scoring opens** time (`scoringStartsAt`) is set and has
passed; until then every module page redirects a non-admin to the landing
page and every module API refuses. Admins pass the lock as a preview, which
is why it looks fine from your own session — check from a private window.
An empty field means *not launched*, not "no start bound", and so does a
value the settings read cannot parse. The lock fails closed, so a Redis
error also shows this symptom — if `/admin` itself is failing, fix that
first ([`NOAUTH`](#services-log-noauth-authentication-required),
[`fetch failed`](#a-service-cant-reach-another-nothing-but-fetch-failed)).

**Fix.** In `/admin` → **Event**, set **Scoring opens** to now to launch
immediately, or leave the scheduled time and wait — the lock lifts on its
own at that instant, no restart. The **Right now:** readout under the
schedule says "scoring is closed (not launched — set a scoring start)" while
the field is empty, and "scoring is frozen (outside its window)" while the
start it holds is still in the future. A leftover
`CHALLENGES_GATE_ENABLED`/`CHALLENGES_GATE_PASSWORD` in `.env` does nothing
any more (the password gate was removed in v0.6) — delete them. See
[Before launch](operations.md#before-launch).

## A board that was on before the upgrade is gone

**Symptom.** After upgrading, Quiz or Jeopardy no longer appears in the
nav or on the landing page, even though nothing about that module changed.

**Diagnosis.** Not a bug and nothing was deleted. Since #386, module
enablement is decided at runtime in `/admin`, not baked into the image —
and on a fresh deployment (or one whose stored settings have never named
this module) only Secure Development starts on, and only when the stack has
a scorer image; Quiz and Jeopardy always start **off**.

**Fix.** `/admin` → Event tab → Modules, and switch it on. The board's
data was never touched — solves, attempts and points come back exactly as
they were.

## A scored PR isn't landing on the leaderboard

Work down this list — each item is a different subsystem:

1. **Is the event frozen, outside the scoring window, or not launched?**
   Check the Event tab (or `HGETALL ctf:admin:settings` — `paused`,
   `scoringStartsAt/EndsAt`). An empty `scoringStartsAt` means the event has
   **not launched** and nothing scores — the usual cause right after an
   upgrade, since a blank start used to mean "always open" (#464). A score
   is judged at the time its PR was judged (ADR 67): one judged while frozen,
   before the launch or after the end **never counts**, not even after you
   unfreeze or set a start — the poller logs it as `refused (paused)` or
   `refused (outside-window)`. A score timed before the last master reset
   never counts either, logged `refused (pre-reset)`. `refused
   (player-deleted)` is a deleted contestant's PR: nothing to do. The contestant has to
   push again once scoring is live. One exception: a freeze set straight on
   the settings hash (`HSET … paused 1`, no recorded `pausedSince`) has an unknown start, so the
   scorer holds the scores it reads during it and judges them once the freeze
   lifts.
2. **Did the fork's Action run and post the score comment?** Open the PR: you
   should see the `github-actions[bot]` comment with the score table. No
   comment → the fork's workflow didn't run or failed; check the fork's
   Actions tab, then `./setup/ctf-setup.sh doctor` for the fork's
   provisioning row (workflow present? version current? image grant
   observed?). `upgrade` re-applies a stale workflow.
3. **Is `sync` actually polling?** `docker compose logs -f sync` (on AWS,
   `aws logs tail /ecs/<name>/sync --follow`). No `sync`
   container at all means the stack came up without `--profile secdev` —
   correct for an event with no `SCORE_IMAGE`, wrong if you expected scoring.
   A container that exits non-zero with `ctf-sync: GITHUB_ORG is not set`
   means the key is missing from `.env`; set it and bring the stack back up.
   A tick that polls **nothing** and records a `lastError` means the poller
   could not read the Secure Development target list from
   `ctf:admin:settings` — it waits rather than guessing, so fix Redis and the
   next tick catches up. A tick log with `dropped` counts names why a comment
   was refused (forged author, unknown target, malformed marker, or a
   rejected release of a held score). A PR author who has not linked GitHub is
   not a drop: the score is **held** (`held` count, listed on the Secure
   Development admin tab) and released on a later tick once the author links
   before Scoring closes; one linked at or after the close shows as
   `unclaimed` and never scores. A link with no recorded time
   (`ctf:link:at`) counts as made after the close whenever `scoringEndsAt`
   is set: if an author you expect to score shows `unclaimed`, have them sign
   in again before the close, which stamps the time (CHANGELOG #741 has the
   one-off command that stamps every link). The `unlinked` tally of earlier
   builds is this `held` count. The poller never logs the login. Sync also
   refuses to start without Redis
   (`ctf-sync: Secure Development needs Redis to attribute PRs to players`).
   A tick that keeps logging `scorer 503` for one player's PRs, with the
   event launched and not frozen, can mean a delete or a GitHub unlink of that player left its
   token on `ctf:score-hold:<player id>` (the scorer's reply body is
   `player scores on hold`, and the app log names the failed lift). For a delete, run it again. With no delete or unlink of the
   player still running, `DEL ctf:score-hold:<player id>` releases their
   scores, but only while the player's account still exists; a deleted
   player's hold is what refuses their PRs. A `scorer 503` whose body reads
   `the login no longer links to this player` is the link moving between
   sync's lookup and the write (an unlink, a delete, delete all accounts);
   the next tick looks the login up again and holds or scores the PR, so one
   such line is not a fault.
4. **Is the score comment authored by `github-actions[bot]`?** Only that
   author is trusted — a comment posted any other way (including by you) is
   dropped by design.
5. **Poll cadence is ~30 s** — a score that lands a minute late in a busy
   tick is normal, not stuck.

## Nothing posts to Discord

**Symptom.** The channel stays quiet while the event runs, or one kind of
announcement posts while another never does. The card's status line and the
app log are the two places that say why.

**Diagnosis.** Four independent gates can each keep a post from leaving.
Work through them in order; the [Discord announcements](operations.md#discord-announcements)
section has the card's full behavior.

1. **No webhook, or the switch for that kind is off.** Announcements are
   opt-in twice: saving a webhook turns nothing on, and each kind has its own
   switch on `/admin` → **Event** → **Discord announcements**. The line
   under the field says "A webhook is configured." or "No webhook
   configured"; check it alongside the relevant switch (First blood, Event
   launch, Scoring paused / resumed, or Remaining-time checks). Turning a
   switch on later does not replay first bloods or a launch that has already
   happened — only a real edge observed after it is armed posts. Paste the
   webhook again and press **Save**, then enable the kind you want.

2. **The event was not launched, or the edge is not eligible.** Launch posts
   only when the observer sees scoring go from not launched to launched; a
   box that starts already launched seeds silently instead of posting a
   retroactive launch. Pause/resume posts only for a live, unclosed event:
   a pause that begins while scoring is already closed is never announced,
   and lifting it later posts nothing. Closing at **Scoring closes** is not
   announced, and Remaining-time checks are silenced while the event is
   unlaunched, paused, or closed. Check the **Right now:** readout under the
   schedule and the **Scoring opens** / **Scoring closes** fields. Set
   **Scoring opens** to now to launch immediately (with the launch switch
   already on), or wait for the next real freeze/unfreeze edge; enabling
   announcements after the fact will not backfill one. First blood is
   solve-triggered rather than schedule-gated, so old solves still do not
   replay.

3. **Discord returned HTTP 429.** The log line is
   `[announce] discord post rate limited: HTTP 429`. The sender prefers
   Discord's `Retry-After` header, falls back to the JSON `retry_after`
   seconds, and defaults to one second when neither is usable. It then parks
   every delivery sweep and **Send test** behind a shared cooldown until that
   instant (concurrent 429s keep the later deadline). The parked entries keep
   their pending/failed status and the 429 does not consume an attempt;
   delivery resumes on the first armed tick after the cooldown expires,
   normally within 30 seconds.
   For a non-429 rejection or a timeout (the POST is capped at five seconds)
   the entry is marked failed and retried on the 30-second ticker, up to
   three failed attempts in total, with no exponential backoff. Delivery is
   at-least-once, not exactly-once: a success whose write is lost can post
   again. Check the log/status line and wait out the retry instant rather
   than repeatedly pressing **Send test**; a persistent non-429 failure means
   check that the webhook is still valid and the channel still accepts it.

4. **Redis is unavailable.** The announcer keeps its config, claims, outbox
   and cooldown in Redis. The fail-closed paths are the config read (a
   failure skips the tick —
   `[announce] config read failed, skipping tick`), a claim or enqueue (a
   failure records nothing), and the webhook-target read (a failure leaves
   queued entries untouched for a later pass). The cooldown read is the
   exception: it fails open to "no cooldown", because a Redis blip must not
   pause delivery; a cooldown-read failure alone does not stop a pass, but
   the config and target reads still have to succeed. With Redis actually
   unavailable those fail, so nothing is posted until it is readable again —
   check `/health/deep` and the app log for `NOAUTH` or `fetch failed`, then
   fix the path to Redis
   ([`NOAUTH`](#services-log-noauth-authentication-required),
   [`fetch failed`](#a-service-cant-reach-another-nothing-but-fetch-failed)).
   Entries already in the outbox are retried after recovery, but events that
   occurred while Redis was down may be lost, and no delivery is guaranteed.

## The fork's Action fails: "no matching manifest for linux/amd64"

**Diagnosis.** The scorer image was built on Apple Silicon without a
platform pin — GitHub's runners are amd64.

**Fix.** Rebuild pinned and push:
`docker buildx build --platform linux/amd64 --provenance=false --sbom=false -t <SCORE_IMAGE> --push scorer/`
(the wizard's own build step already pins this).

## Services log `NOAUTH Authentication required`

**Symptom.** `srh` (or anything behind it) errors with `NOAUTH`; reads and
writes fail.

**Diagnosis.** The password the running containers carry doesn't match the
Redis they're talking to — typically `.env` was edited after the stack came
up (compose does not re-read `.env` into running containers).

**Fix.** `docker compose up -d` again (recreates with current env). On AWS,
srh reads its connection string from the `SRH_CONNECTION_STRING` SSM
parameter when a task starts, so a task started before that parameter
changed still carries the old one. Start fresh srh tasks with
`aws ecs update-service --cluster <cluster> --service srh --force-new-deployment`.
Note an
unauthenticated `PING` answering `NOAUTH` is the *correct* state —
`scripts/smoke.sh` asserts it — the bug is only when the kit's own services
hit it.

## `sync` is crash-looping (or ingestion died mid-event)

**Symptom.** `docker compose ps` shows `sync` restarting; every tick throws.

**Diagnosis.** The poller's cursor lives in Redis at `ctf:sync:state` (a
JSON string). Older builds kept it in `/state/state.json` on the
`sync-state` volume; the first boot of a current build moves that file's
contents into Redis and renames the file to `state.json.migrated`. Current
`sync` validates and **repairs** damaged state field by field (each repair
is logged — look for repair lines before assuming worse). Historically a
bare `{}` — valid JSON, unusable shape — crash-looped the poller for a whole
event, which is exactly why the repair exists.

If the logs instead repeat `cannot load poll state from Redis
(ctf:sync:state) … not polling until it is readable`, sync is not crashing:
it is **holding** on purpose, because starting from an empty cursor would
re-ingest every score comment. Fix srh/Redis (the `fetch failed` and
`NOAUTH` entries in this runbook) and it resumes on its own at the next
retry. The same hold applies on the first boot after an upgrade when the old
`state.json` exists but cannot be read (`cannot read the legacy state file
…`): fix its permissions, or delete it to start from an empty cursor on
purpose. It also holds, after copying the file into Redis, if it cannot move
the file aside (`could not move … aside`), because a leftover file would
re-seed a wiped Redis with a stale cursor: fix the directory's permissions,
or delete the file — its contents are already in Redis.

**Fix.** Read the first error line of `docker compose logs sync`. If state
is beyond repair: `docker compose exec redis redis-cli DEL ctf:sync:state`,
then restart sync. Losing the cursor does not double-count (the scorer's
writes are idempotent on replay) — but the re-read brings back any Secure
Development solves a per-contestant reset removed, and resets `/admin`'s
ingested/dropped counters to 0.

**On AWS** there is no `sync-state` volume and none is needed: the cursor is
in `ctf:sync:state` on ElastiCache, so a new sync task resumes from it, and
holds while srh is unreadable. Read the error
with `aws logs tail /ecs/<name>/sync --since 30m`, and why the task stopped
with `describe-tasks` (see the
[AWS runbook](aws.md#watching-the-stack)). A `GITHUB_ORG is not set` or a
missing App id means a Terraform variable is empty: set `github_org` and
`github_app_id`, then `terraform apply`. Only deleting `ctf:sync:state`
makes sync re-read every score comment, which undoes a per-contestant Secure
Development reset: see the sync drill in the
[AWS runbook](aws.md#failure-drills).

## The monitor says `/health/deep` is 503 (but the site loads fine)

That combination is the check doing its job. Every read in this kit fails
open — a Redis blip must not stop contestants playing — so a dead dependency
leaves the site rendering while nothing scores. `/health/deep` is the one
place that failure is visible from outside. Read the body:

- **`"redis": "down"`** — the app cannot reach Redis through srh. Nothing is
  scoring in any module and admin settings reads are serving defaults. On
  Fly: `fly ssh console --app <app> -C "redis-cli PING"`, then `fly logs`
  for `srh` and `redis`; a `NOAUTH` there is the password mismatch described
  above. On compose: `docker compose ps` and the `srh`/`redis` logs. On
  AWS: `aws logs tail /ecs/<name>/srh`, and `describe-services` for whether
  the srh tasks are running at all. The module runs two, so the stack reads
  as down only when both are. See the srh and failover
  drills in the [AWS runbook](aws.md#failure-drills).
- **`"scorer": "down"`** — Redis is fine but the scorer's `/healthz` did not
  answer. Quiz and Jeopardy keep scoring; Secure Development scores stop
  landing and the board shows stale SD totals. Restart the scorer container
  (on AWS, `aws ecs update-service --cluster <cluster> --service scorer
  --force-new-deployment`, after reading its `stoppedReason`);
  `LEADERBOARD_API_URL` unset on a box with `SCORE_IMAGE` set also reports
  this, since a scorer nothing can reach is as good as down.
- **`"sync.ageSec"` growing while the check is 200** — not a failure of the
  check (the poller is reported, never failed on), but it means no poll has
  completed since that many seconds ago. Scored PR comments are accumulating
  on GitHub; see "`sync` is crash-looping" above. If the machine is
  idle-suspending (`FLY_AUTO_STOP` not `off`), that is the cause.

The body never says *why* — no host, no error text; that is deliberate for a
public URL. The reason is in the server log: `fly logs --app <app>`,
`docker compose logs app`, or on AWS `aws logs tail /ecs/<name>/app`, lines
tagged `[health/deep]`.

**What a dead container actually does on Fly (measured, not assumed).** The
rendered compose file keeps each service's `restart:` line from
`docker-compose.yml`, and `deploy.sh` sets no restart policy of its own, so
the machine runs at Fly's default `on-failure`, ten retries. Killing PID 1 in
the `app` container on the live box (2026-09-16, `fly ssh console --machine
<id> --container app -C "kill 1"`) produced: exit 143 → Fly rescheduled the
container in 200 ms → `next start` ready in 251 ms → **one failed request and
a 5–7 second blackout** from outside, the machine never restarted, Redis,
scorer and poller untouched, the Fly check on `/health` stayed passing. So a
crashing `app` heals itself and needs no runbook. Two things do: a container
that crash-loops **ten times** stays down (the retry ceiling), and a machine
whose HTTP check fails is **not replaced** — Fly's check is a signal, not a
supervisor. Both are what the external monitor on `/health/deep` is for; when
it fires and `fly logs` shows `restart count is 10/10`, `fly machine restart
<id> --app <app>` is the fix.

## An ECS service never settles (AWS)

**Symptom.** `terraform apply` or `./deploy.sh --apply` sits on
`Still modifying...` for a service and eventually times out, or
`describe-services` shows `running` below `desired` while the service's
events repeat `has started 1 tasks` or `is unhealthy`.

**Diagnosis.** ECS is starting tasks that stop again. After a few failures
the deployment circuit breaker rolls the service back to its last working
revision, and the events say so; old tasks keep serving meanwhile, so the
site may look fine. The reason is on the stopped task:

```sh
aws ecs list-tasks --cluster <cluster> --service-name <service> --desired-status STOPPED
aws ecs describe-tasks --cluster <cluster> --tasks <task-arn> \
  --query 'tasks[].{stopped:stoppedReason,containers:containers[].{name:name,exit:exitCode,reason:reason}}'
```

`CannotPullContainerError` means the image is missing or the task cannot
pull it (a private registry, or an image built for the wrong CPU
architecture). An `AccessDeniedException` on KMS or SSM means a secret was
stored under the wrong key or path: every SecureString must use
`--key-id alias/<name>-secrets`. A container that exits or fails its health
check has the reason in `/ecs/<name>/<service>`.

**Fix.** Fix the cause, then `terraform apply` again. For a bad app image,
roll back to the previous tag as described in
[Rolling back a bad deploy](aws.md#rolling-back-a-bad-deploy).

## `aws ecs execute-command` fails: "execute command was not enabled" (AWS)

**Diagnosis.** ECS Exec is off for that service, or the task was started
before it was turned on. A task keeps the setting it started with.

**Fix.** Set `enable_ecs_exec = true` (the default) and `terraform apply`, then start
fresh tasks with `aws ecs update-service --cluster <cluster> --service
<service> --force-new-deployment`. Also check that the Session Manager
plugin for the AWS CLI is installed locally. See
[A shell inside a task](aws.md#a-shell-inside-a-task-ecs-exec).

## A re-scored PR never updates ("it scored once and never again")

**Diagnosis.** The scoring workflow posts **one comment per target and
edits it** (placeholder → result). Current `sync` keys its seen-cache on the
comment's id *and* `updated_at`, so edits re-present; an old checkout keyed
on id alone and permanently burned the comment's id on the placeholder.

**Fix.** Update the kit (the revision-keyed cache is the fix). Re-presenting
an already-counted revision is harmless — the scorer's writes are monotonic.

## A service can't reach another: nothing but `fetch failed`

**Diagnosis.** Every service in `docker-compose.yml` names its network
(`frontend`/`backend`). A service added in an **override file** with no
`networks:` key joins compose's `default` network — a third network nothing
else is on — so DNS for it resolves nowhere. This exact trap once broke the
smoke stack's mock service.

**Fix.** Give the override service an explicit `networks: [frontend]` (or
`backend`, per its role).

## The app returns 500 on every request after start

**Symptom.** Logs say it is refusing to serve because `EVENT_URL` is
`http://` on a non-loopback host.

**Diagnosis.** Deliberate: the session cookie is only `Secure` over HTTPS — serving a
real event over HTTP makes every session (an organizer's included) sniffable.

**Fix.** Set an `https://` `EVENT_URL` (Caddy provisions TLS). Only for a
deliberately TLS-less closed network: `ALLOW_INSECURE_EVENT_URL=1` in
`.env`, which downgrades the refusal to a warning that says exactly what
you gave up.

## Players see "Too many attempts. Try again in N seconds."

**Symptom.** Several people in one room, or behind one NAT or CDN edge, get a
429 on `/sign-in`, or one player does after a few wrong passwords.

**Diagnosis.** The Redis limiter on the auth endpoints. Per client address:
300 account creations and 600 sign-ins per 10 minutes; per address and
username: 10 password attempts per 15 minutes
([budgets](operations.md#account-sign-up-and-sign-in-limits)). The address is
the rightmost `X-Forwarded-For` entry on compose and AWS and `Fly-Client-IP`
on Fly, so behind Cloudflare it is the edge's and everyone sharing that edge
shares the per-address budgets. On Fly, if every player shares one budget
with no CDN in front, check that the app container has
`TRUSTED_CLIENT_IP_HEADER=fly-client-ip` (`deploy/fly/render-compose.sh`
sets it); without it the key is Fly's own app address. The message
carries the wait; `Retry-After` has it too. The limiter fails closed, so a
429 on every attempt with no crowd can also mean Redis is unreachable (see
the `NOAUTH` entry above and `/health/deep`).

**Fix.** Wait out the window. The budgets are constants in
`apps/web/src/lib/rate-limit-store.ts`, not an admin setting; raise them there
only for an event that needs it.

## Players cannot link GitHub: the startup log says the GitHub keys are missing

**Symptom.** The app logs `[startup] Secure Development is on (SCORE_IMAGE is
set) but GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are missing: players cannot
link GitHub, so no PR will score.` and `/profile` and `/challenges` say GitHub
linking is not set up.

**Cause and fix.** Secure Development needs the GitHub OAuth app. Set both
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (see
[Sign-in providers](hosting.md#sign-in-providers)), then recreate the app
container (`docker compose up -d --no-deps --force-recreate app`, or
redeploy on Fly or AWS); a plain restart keeps the old environment. GitHub
counts as configured only with both keys non-blank.

## Sign-in says "That sign-in option is not available."

**Symptom.** A player is refused with `PROVIDER_DISABLED` when starting or
finishing a GitHub sign-in.

**Cause and fix.** An organizer switched GitHub sign-in off in the `/admin`
Event tab's Sign-in section; the callback is gated too, so a sign-in started
before the switch fails at the end. Switch it back on, or have the player use
username and password. `SIGN_IN_SETTINGS_UNREADABLE` ("Sign-in options could
not be loaded") means the switch could not be read from Redis; retry, and see
[`/health/deep`](#the-monitor-says-healthdeep-is-503-but-the-site-loads-fine).

## A player forgot their password

**Symptom.** A player cannot sign in by username and has no other sign-in on
the account.

**Fix.** In `/admin`, open the Support tab, find the player and press **Reset
password**, then **Issue reset code** to confirm. Hand the code over in person; the player enters it at `/reset`
and chooses a new password. A code works once and expires after 15 minutes,
and a new code voids the old one. If `/reset` says the code is invalid, it was
used, expired, replaced, or its issuer lost admin access: issue another. See
[Accounts](operations.md#accounts).

## A GitHub login cannot be linked

**Symptom.** A player's GitHub sign-in or link is refused, or their PRs stay
held, although the GitHub account is theirs.

**Cause and fix.** Deleting a contestant blocks their GitHub login from
linking to any account until the next master reset, so a deleted player's
scores cannot be claimed by a new account. If that login belongs to someone
who should be playing, run the master reset (it clears the block along with
the rest of the event's progress). Before the event that is fine; mid-event
the player needs a different GitHub account. Unlinking a link
that has not scored, from the Support tab, does not block the login. See
[Accounts](operations.md#accounts).

## Still stuck

`./setup/ctf-setup.sh doctor` (the org, fork by fork) ·
`./scripts/smoke.sh` (the whole poll pipeline against fixtures — proves the
kit, isolates your event config) · the sync heartbeat in Redis
(`HGETALL ctf:sync:status`: last poll, ingested/dropped counts, last error,
last drop reason).
