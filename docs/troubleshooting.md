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

## `/admin` 403s for everyone, including you

**Symptom.** Nobody — including you — can open `/admin`; every listed admin
gets the 403 wall.

**Diagnosis.** `ADMIN_LOGINS` is empty or unset in `.env`, or it is set but
the app was not restarted after you changed it. Since #386 part 4 the app no
longer bakes an admins list at build time — it reads the comma-separated
`ADMIN_LOGINS` env var at runtime, and an empty set (unset, blank, or every
entry failing the GitHub-login shape check) refuses every login, including
one that used to work. (The event's name and the rest of its branding, the
fork org, and which Secure Development targets run are separate runtime
settings — the name and targets default to "OWASP CTF in a Box" / all six
either way, so a stock-looking name or a full target list is not a symptom of this
problem on its own.)

**Fix.** Set `ADMIN_LOGINS` in `.env` to a comma-separated list of GitHub
logins (case doesn't matter — logins join case-insensitively everywhere in
this repo), then restart the app container — no rebuild needed, since this is
a runtime read, not a build arg:

```sh
docker compose --profile secdev --profile app up -d
```

(Quiz/classic/ai-only events: `--profile app` alone.) Compose must also be
passing `ADMIN_LOGINS` through to the app service's environment — it is on
recent `docker-compose.yml`, but a customized override file that dropped it
would reproduce this exact symptom.

## A board that was on before the upgrade is gone

**Symptom.** After upgrading, Quiz, Jeopardy, or AI no longer appears in the
nav or on the landing page, even though nothing about that module changed.

**Diagnosis.** Not a bug and nothing was deleted. Since #386, module
enablement is decided at runtime in `/admin`, not baked into the image —
and on a fresh deployment (or one whose stored settings have never named
this module) only Secure Development starts on, and only when the stack has
a scorer image; Quiz, Jeopardy and AI always start **off**.

**Fix.** `/admin` → Event tab → Modules, and switch it on. The board's
data was never touched — solves, attempts and points come back exactly as
they were.

## A scored PR isn't landing on the leaderboard

Work down this list — each item is a different subsystem:

1. **Is the event frozen or outside the scoring window?** Check the Event tab
   (or `HGETALL ctf:admin:settings` — `paused`, `scoringStartsAt/EndsAt`). A
   freeze **holds** ingestion; the score is queued in the PR comment and
   ingests on the first tick after you unfreeze. Nothing is lost.
2. **Did the fork's Action run and post the score comment?** Open the PR: you
   should see the `github-actions[bot]` comment with the score table. No
   comment → the fork's workflow didn't run or failed; check the fork's
   Actions tab, then `./setup/ctf-setup.sh doctor` for the fork's
   provisioning row (workflow present? version current? image grant
   observed?). `upgrade` re-applies a stale workflow.
3. **Is `sync` actually polling?** `docker compose logs -f sync`. No `sync`
   container at all means the stack came up without `--profile secdev` —
   correct for an event with no `SCORE_IMAGE`, wrong if you expected scoring.
   A container that exits non-zero with `ctf-sync: GITHUB_ORG is not set`
   means the key is missing from `.env`; set it and bring the stack back up.
   A tick that polls **nothing** and records a `lastError` means the poller
   could not read the Secure Development target list from
   `ctf:admin:settings` — it waits rather than guessing, so fix Redis and the
   next tick catches up. A tick log with `dropped` counts names why a comment
   was refused (forged author, unknown target, malformed marker).
4. **Is the score comment authored by `github-actions[bot]`?** Only that
   author is trusted — a comment posted any other way (including by you) is
   dropped by design.
5. **Poll cadence is ~30 s** — a score that lands a minute late in a busy
   tick is normal, not stuck.

## The fork's Action fails: "no matching manifest for linux/amd64"

**Diagnosis.** The scorer image was built on Apple Silicon without a
platform pin — GitHub's runners are amd64.

**Fix.** Rebuild pinned and push:
`docker buildx build --platform linux/amd64 -t <SCORE_IMAGE> --push scorer/`
(the wizard's own build step already pins this).

## Services log `NOAUTH Authentication required`

**Symptom.** `srh` (or anything behind it) errors with `NOAUTH`; reads and
writes fail.

**Diagnosis.** The password the running containers carry doesn't match the
Redis they're talking to — typically `.env` was edited after the stack came
up (compose does not re-read `.env` into running containers).

**Fix.** `docker compose up -d` again (recreates with current env). Note an
unauthenticated `PING` answering `NOAUTH` is the *correct* state —
`scripts/smoke.sh` asserts it — the bug is only when the kit's own services
hit it.

## `sync` is crash-looping (or ingestion died mid-event)

**Symptom.** `docker compose ps` shows `sync` restarting; every tick throws.

**Diagnosis.** The poller's cursor lives in `/state/state.json` on the
`sync-state` volume. Current `sync` validates and **repairs** a damaged
state file field by field (each repair is logged — look for repair lines
before assuming worse). Historically a bare `{}` — valid JSON, unusable
shape — crash-looped the poller for a whole event, which is exactly why the
repair exists.

**Fix.** Read the first error line of `docker compose logs sync`. If state
is beyond repair on an old version: `docker compose down && docker volume rm
<project>_sync-state && docker compose --profile secdev --profile app up -d` —
losing the cursor is safe; the poller re-reads scores from the PR comments
and the scorer's writes are idempotent on replay.

## The monitor says `/health/deep` is 503 (but the site loads fine)

That combination is the check doing its job. Every read in this kit fails
open — a Redis blip must not stop contestants playing — so a dead dependency
leaves the site rendering while nothing scores. `/health/deep` is the one
place that failure is visible from outside. Read the body:

- **`"redis": "down"`** — the app cannot reach Redis through srh. Nothing is
  scoring in any module and admin settings reads are serving defaults. On
  Fly: `fly ssh console --app <app> -C "redis-cli PING"`, then `fly logs`
  for `srh` and `redis`; a `NOAUTH` there is the password mismatch described
  above. On compose: `docker compose ps` and the `srh`/`redis` logs.
- **`"scorer": "down"`** — Redis is fine but the scorer's `/healthz` did not
  answer. Quiz, Jeopardy and AI keep scoring; Secure Development scores stop
  landing and the board shows stale SD totals. Restart the scorer container;
  `LEADERBOARD_API_URL` unset on a box with `SCORE_IMAGE` set also reports
  this, since a scorer nothing can reach is as good as down.
- **`"sync.ageSec"` growing while the check is 200** — not a failure of the
  check (the poller is reported, never failed on), but it means no poll has
  completed since that many seconds ago. Scored PR comments are accumulating
  on GitHub; see "`sync` is crash-looping" above. If the machine is
  idle-suspending (`FLY_AUTO_STOP` not `off`), that is the cause.

The body never says *why* — no host, no error text; that is deliberate for a
public URL. The reason is in the server log: `fly logs --app <app>` or
`docker compose logs app`, lines tagged `[health/deep]`.

**What a dead container actually does on Fly (measured, not assumed).** The
rendered compose file carries no `restart:` — `render-compose.sh` drops it —
so every container inherits the *machine's* policy, which `deploy.sh` leaves
at Fly's default `on-failure`, ten retries. Killing PID 1 in the `app`
container on the live box (2026-09-16, `fly ssh console --machine <id>
--container app -C "kill 1"`) produced: exit 143 → Fly rescheduled the
container in 200 ms → `next start` ready in 251 ms → **one failed request and
a 5–7 second blackout** from outside, the machine never restarted, Redis,
scorer and poller untouched, the Fly check on `/health` stayed passing. So a
crashing `app` heals itself and needs no runbook. Two things do: a container
that crash-loops **ten times** stays down (the retry ceiling), and a machine
whose HTTP check fails is **not replaced** — Fly's check is a signal, not a
supervisor. Both are what the external monitor on `/health/deep` is for; when
it fires and `fly logs` shows `restart count is 10/10`, `fly machine restart
<id> --app <app>` is the fix.

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

**Diagnosis.** Deliberate: sessions are cookie-only and the cookie is only
`Secure` over HTTPS — serving a real event over HTTP makes every session
(an organizer's included) sniffable.

**Fix.** Set an `https://` `EVENT_URL` (Caddy provisions TLS). Only for a
deliberately TLS-less closed network: `ALLOW_INSECURE_EVENT_URL=1` in
`.env`, which downgrades the refusal to a warning that says exactly what
you gave up.

## Still stuck

`./setup/ctf-setup.sh doctor` (the org, fork by fork) ·
`./scripts/smoke.sh` (the whole poll pipeline against fixtures — proves the
kit, isolates your event config) · the sync heartbeat in Redis
(`HGETALL ctf:sync:status`: last poll, ingested/dropped counts, last error,
last drop reason).
