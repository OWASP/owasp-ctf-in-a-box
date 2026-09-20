---
title: Deploy on fly.io
---

[← Docs home](index.md)

# Deploy on fly.io

Stand the whole event up on [fly.io](https://fly.io) with one command. The
deployment is **one Fly app running one machine**, with every container of the
compose stack inside it — `app`, `scorer`, `sync`, `srh` and `redis`.

It runs the repo's real `docker-compose.yml`. Not a cloud-shaped copy of it:
the compose file Fly deploys is *rendered* from that file on every deploy, so
what runs at the event is what you exercised locally.

- [Prerequisites](#prerequisites)
- [Deploy](#deploy)
- [What actually runs](#what-actually-runs)
- [Why one machine](#why-one-machine)
- [The two things that bite](#the-two-things-that-bite)
- [Secrets](#secrets)
- [The rendered compose file](#the-rendered-compose-file)
- [Security differences from compose](#security-differences-from-compose)
- [Cost and shape](#cost-and-shape)
- [Tear down](#tear-down)
- [CI](#ci)
- [Who can read the secrets](#who-can-read-the-secrets)
- [Images are pinned by digest](#images-are-pinned-by-digest)

## Prerequisites

| Thing | Why |
| --- | --- |
| A Fly account and `flyctl` | [install](https://fly.io/docs/flyctl/install/), then `fly auth login` |
| Docker | Images are built here and pushed to Fly's registry; the render shells out to `docker compose` |
| A `.env` from `ctf-setup.sh secrets` | `init` copies it and tops it up — including `GITHUB_ORG` and `ADMIN_LOGINS`, both runtime reads (config v2, #386), not a build-time bake |
| A GitHub OAuth app | Its callback must match the deployed hostname exactly |
| Access to a `SCORE_IMAGE` | Mirrored into Fly's registry so the forks and the leaderboard judge with the same artifact |

**One public port is all a Fly machine needs.** Scores arrive by outbound
polling — `sync` reads GitHub and submits over the machine's internal network
— so `fly.toml` exposes only the app on port 3000 and nothing has to reach in.
That fit was the argument for keeping Fly poll-only rather than giving it a
`/score` route (issue #373, closed), and the question settled itself when push
ingest was removed in v0.6
([#377](https://github.com/OWASP/owasp-ctf-in-a-box/issues/377)). A `SCORE_INGEST`
line left over in `.env` or `.env.fly` is inert: nothing here reads it, and
`deploy.sh` has nothing left to refuse.

## Deploy

```sh
# 1. Prepare the Fly env file. Touches nothing on Fly, needs no CLI.
#    Asks which region to run in.
./deploy/fly/deploy.sh init

# 2. Preview. Makes NO fly calls, and redacts every secret value.
./deploy/fly/deploy.sh --dry-run

# 3. Go.
./deploy/fly/deploy.sh
```

`init` writes `.env.fly` (mode 600, gitignored) from `.env`, rewrites
`EVENT_URL` to your app's Fly hostname, and generates `SRH_TOKEN` and
`REDIS_PASSWORD` if they are absent. Every other key in `.env` — including
`GITHUB_ORG` and `ADMIN_LOGINS` — comes along on that first copy. It never
overwrites an existing file — it tops one up, so re-running is safe.

After rotating anything at GitHub, changing the target org, or editing the
admin roster, re-sync from `.env`:

```sh
./deploy/fly/deploy.sh init --refresh   # then deploy again
```

`--refresh` re-copies `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`,
`SCORE_IMAGE`, `GITHUB_ORG` and `ADMIN_LOGINS` from `.env`, overwriting what
is in `.env.fly` — and **adding** any of them the file does not carry yet,
which is what a `.env.fly` written before configuration v2 looks like for
`GITHUB_ORG` and `ADMIN_LOGINS`. It then falls through to the same top-up
`init` always does
(`SRH_TOKEN`, the region, `REDIS_PASSWORD`, the single-volume knobs), so a
`--refresh` on an old file never leaves it half-prepared (issue #381).
`EVENT_URL`, `FLY_REGION`, `SRH_TOKEN` and `REDIS_PASSWORD` are left alone —
they belong to this deployment, not the compose stack `.env` describes.

Each value is read from `.env` in every form `docker compose` accepts —
`KEY=value`, `KEY = value`, `KEY: value`, a quoted value, a leading
`export ` — and written back as a canonical `KEY=value` line, replacing the
existing assignment whatever form *it* took rather than appending a second one.
Which blank assignments it obeys, why a key absent from `.env` is left alone,
and what it does about a key assigned twice, are below.

A deploy refuses outright — naming the key — if `GITHUB_ORG` or
`ADMIN_LOGINS` is empty in `.env.fly`. Neither fails loudly on the machine:
an empty allowlist deploys an event whose `/admin` forbids everyone (you
included), and without an org `sync` exits at start-up while the other four
containers look healthy.

Changed only a secret or a runtime setting, and want to skip the image
rebuild?

```sh
./deploy/fly/deploy.sh --skip-build
```

Nothing is baked into the app image but the `/health` build stamp, so
`--skip-build` never risks a stale *config*: `GITHUB_ORG`, `ADMIN_LOGINS` and
everything else reach the machine through the rendered compose file on every
deploy.

**It is safe only while `SCORE_IMAGE` is unchanged.** `--skip-build` skips the
mirror step as well as the builds, and mirroring is how the scorer image
`SCORE_IMAGE` names gets into Fly's registry. Point `SCORE_IMAGE` at a new
image and then deploy with `--skip-build` and the machine either keeps running
the *previous* scorer or is handed a tag Fly does not have. After changing
`SCORE_IMAGE`, run a normal `./deploy/fly/deploy.sh` once.

### An explicitly blank value in `.env` clears one key, and only one

**`GITHUB_APP_INSTALLATION_ID` is the exception: an explicitly blank
`GITHUB_APP_INSTALLATION_ID=` line in `.env` clears it in `.env.fly`.** An
empty installation id tells `sync` to discover the installation itself, so
once the sync App has been re-created a *pinned* id left behind here is not
stale-but-working — it is a permanent `GitHub 401 minting installation token`
on every poll.

**Every other refreshed key keeps its `.env.fly` value when `.env` assigns it
an explicitly blank value, and says so.** A refresh cannot tell "deliberately
unset" from "not filled in yet", and obeying the blank would be destructive on
a live box: an empty `ADMIN_LOGINS` locks every organizer out of `/admin`, an
empty `GITHUB_ORG` stops `sync` from starting, an empty `SCORE_IMAGE` disables
Secure Development. The refresh prints a line naming the key it declined to
clear.

**A key that is ABSENT from `.env` is a third case, and it keeps the
`.env.fly` value for every key — the installation id included.** Only an
explicit assignment clears; a `.env` with no line for a key at all has said
nothing about it, so the refresh names it, keeps what is deployed, and moves
on. That is what makes refreshing from a partial `.env` safe.

### Duplicate keys are warned about, not tolerated silently

`init` and a deploy both check the env file for a key assigned more than once
and name the offenders. **The last assignment wins** — here, in the renderer
and in `docker compose` — so an organizer editing the first occurrence of a
duplicated `SCORE_IMAGE` changes nothing at all, which is exactly how one live
`.env.fly` ended up deploying a scorer nobody had selected (issue #381).
`--refresh` collapses the duplicates of any key it rewrites into one line;
duplicates of keys it does not own have to be deleted by hand.

### A deploy tells you when `.env.fly` has drifted from `.env`

Before the build, and again in the closing summary, a deploy compares the
external-system keys in `.env.fly` against `--from` (default `.env`) and
names every one that differs:

```text
WARNING: .env.fly and .env disagree on: GITHUB_APP_ID ADMIN_LOGINS
```

It compares `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `SCORE_IMAGE`,
`GITHUB_ORG` and `ADMIN_LOGINS`, and it **never prints a value** — only the
key names, the same rule `--dry-run`'s redaction follows. A missing `--from`
file is not an error and prints nothing; the check runs in every mode,
`--skip-build` included.

**It warns, it does not refuse.** Separate OAuth apps per environment — one
for `localhost`, one for the public box — are a legitimate setup, so a
refusal would break a working deployment over a difference its owner chose.
The reason it exists at all: an event org was re-created, `.env` was rewritten
with a new OAuth app and a new sync App, `.env.fly` was never refreshed, and a
plain deploy shipped the old org's credentials in silence. Every sign-in
bounced with `?error=application_suspended`, `sync` logged a GitHub 401 for
all six targets every 30 seconds, and nothing in the deploy, in `/health` or
in `doctor` — which reads `.env`, not `.env.fly` — pointed at the cause. If
the drift is not deliberate, the warning names the fix:
`./deploy/fly/deploy.sh init --refresh --from .env`.

### Every flag

`deploy.sh [init] [flags]` — `init` prepares the env file and touches nothing
on Fly; without it the script deploys. `-h`/`--help` prints the same list.

| Flag | Applies to | What it does |
|---|---|---|
| `--dry-run` | both | Prints every `fly` command it would run and makes **none** of them; secret values are redacted from the output. `init --dry-run` says what it *would* write and ask |
| `--env-file <path>` | both | The Fly env file — `init` writes it, a deploy reads it. Default `.env.fly` |
| `--from <path>` | both | The compose `.env` that `init` copies from (and `--refresh` re-copies from); on a deploy, the file the drift check compares `.env.fly` against. Default `.env`; a missing one is not an error on a deploy |
| `--region <code>` | `init` only | Sets `FLY_REGION` in the env file without prompting — for a scripted or CI run with no tty. Must be a three-lowercase-letter Fly code (`gru`, `iad`, …); ignored when the env file already carries one |
| `--refresh` | `init` only | Re-copies the values that must match an **external** system (GitHub OAuth, the sync App, the scorer image, the fork org and its admin allowlist — `GITHUB_ORG`, `ADMIN_LOGINS`) from `--from`, overwriting what is there, then falls through to the same top-up a plain `init` does for anything still missing (issue #381). `EVENT_URL`, `FLY_REGION`, `SRH_TOKEN` and `REDIS_PASSWORD` are left alone — they belong to this deployment |
| `--skip-build` | deploy only | Reuses the app, sync and scorer images already in Fly's registry instead of building, pushing and mirroring. Turns a multi-minute rebuild into a redeploy when only a secret or a runtime setting changed — nothing but the `/health` build stamp is baked into the app image, so there is no config to miss |

`--region` and `--refresh` are accepted on a deploy for symmetry but have no
effect there. `--from` does: it names the file the drift check compares
`.env.fly` against.

**`FLY_REGION`** is a line in the env file, not a flag, and it is the one place
the region lives. `init` fills it in exactly once: an existing value is kept;
otherwise `--region` wins, then an interactive prompt whose default is
`fly.toml`'s `primary_region` (`iad`), and with no tty that default is taken
silently. A deploy reads `FLY_REGION` from the env file — falling back to
`primary_region` when the line is missing or empty — and passes it to both
`fly volumes create --region` and `fly deploy --primary-region`, so the volumes
and the machine always land in the same place. To move an event, change the
line and recreate the volumes; `fly.toml` on its own is only the default.

### Finish by hand

`setup/ctf-setup.sh wizard` can walk this whole sequence for you — its last
step offers the Fly deploy (`init --from .env`, the public hostname into
`.env.fly`, a previewed deploy, then `fly certs add` for a custom domain),
defaults to no, and is skipped on an app-only event because the Fly module
runs the scorer and poller too (issue #371). Either way the two steps below
are yours: the wizard prints the callback URL, it cannot register it.

1. **OAuth callback** must be exactly `https://<host>/api/auth/callback/github`,
   where `<host>` is whatever `EVENT_URL` in `.env.fly` names — `<app>.fly.dev`
   by default, or your own domain if you deployed behind one. Sign-in fails
   with a `redirect_uri` mismatch otherwise, and the mismatch names the host
   it expected. A GitHub OAuth App holds **one** callback URL, so an event
   served from both a compose box and Fly needs either that app repointed at
   whichever host contestants use, or a second OAuth App whose client id and
   secret go in `.env.fly` (leaving `.env`'s pair for the box).
2. **Check `/admin` loads** for a login listed in `ADMIN_LOGINS` in
   `.env.fly`. A 403 there almost always means that login is missing (or
   misspelled — logins join case-insensitively, but the list itself must
   still contain it): fix `.env.fly` and redeploy.

## What actually runs

One machine, five containers, sharing one network namespace:

| Container | Port | Reached at | Public? |
| --- | --- | --- | --- |
| `app` | 3000 | — | **yes**, via Fly's proxy |
| `scorer` | 4000 | `http://localhost:4000` | no |
| `srh` | 80 | `http://localhost:80` | no |
| `redis` | 6379 | `127.0.0.1:6379` | no |
| `sync` | — | outbound only | no |

Only one container receives inbound traffic, chosen by matching
`internal_port` in `fly.toml`. It is 3000, which is the app.

`caddy` is absent — Fly terminates TLS and issues certificates. It is left out
by naming the deployed services explicitly, *not* by giving caddy a compose
profile, so nothing about a local bring-up changes.

## Why one machine

Because the alternative does not work.

**Fly's private network (6PN) is IPv6-only. srh's Redis client is IPv4-only.**
srh is a prebuilt third-party image whose Elixir release bundles redix 1.1.5;
redix supports `socket_opts` — where `:inet6` would go — but srh builds its
options from the connection string alone and offers no knob for it.

An earlier version of this module deployed five Fly apps and could never get
srh to reach redis. The symptom is a liar: `nc` to `redis.internal:6379`
succeeds, redis looks healthy, and srh repeats `SRH was unable to connect to
the Redis server` forever.

Containers inside one machine reach each other over `localhost`, on IPv4. That
removes the problem instead of routing around it — and it is cheaper.

Full reasoning, and the alternatives that lost, in
[ADR 42](decisions.md#adr-42-one-fly-machine-running-the-real-compose-file-not-five-fly-apps).

## The two things that bite

### 1. Images are built here, not by Fly

Fly builds nothing. Its compose parser cannot pass build args, and refuses a
file where more than one service declares `build:` — `docker-compose.yml` does
so twice.

So `deploy.sh` builds `app` and `sync` locally, pushes them to
`registry.fly.io`, and mirrors the scorer image across. **Everything is built
`--platform linux/amd64`**: Fly machines are amd64, and an image built on
Apple Silicon without it fails at start with an exec format error, after a
deploy that looked fine.

The scorer is **mirrored, not rebuilt**. Fly cannot pull from a private
third-party registry and has no flag for credentials, so the image is copied
into Fly's own registry with `docker buildx imagetools create`, which
preserves the digest. The scorer serving your leaderboard must be the same
artifact the forks pull to judge PRs, or the totals disagree.

### 2. One volume, region-pinned, shared by two services

**A Fly machine permits exactly one volume** — `invalid config.mounts, only 1
volume supported`, reported only when the machine is created, after images are
pushed and IPs provisioned.

`redis`'s append-only file and `sync`'s cursor therefore share it, under
separate directories:

| | Local (compose) | Fly |
| --- | --- | --- |
| `REDIS_DIR` | `/data` | `/data/redis` |
| `STATE_PATH` | `/state/state.json` | `/data/sync/state.json` |

Both are knobs in `docker-compose.yml` defaulting to the local layout, with
`.env.fly` setting the Fly values — so nothing about a compose stack changes,
and you can see where your data lives rather than having a renderer decide it.

The directories are created by the services themselves, because a fresh Fly
volume is root-owned and neither redis (uid 999) nor sync (uid 1000) could
write to it: redis's command `chown`s `REDIS_DIR` before the image's
entrypoint drops privileges, and sync's entrypoint creates and `chown`s
`dirname(STATE_PATH)` as root, then drops to `node` before starting the
poller. An `.env.fly` written before `init` learned to add the two knobs
still deploys, but `deploy.sh` warns and names the two lines to add — without
them sync's cursor sits on the machine's ephemeral disk.

Compose's named volumes are **ignored** by Fly in a compose file; the mount is
declared as `[[mounts]]` in `fly.toml`.

`init` asks which region to run in (or takes `--region`) and writes it to
`.env.fly` as `FLY_REGION`, and that one answer drives the volume and the
deploy. Changing it later means destroying and recreating the volume, so pick
the one nearest your contestants.

Losing the sync cursor is not fatal but is noisy: the poller re-reads every
comment in every fork from scratch.

## Secrets

**Credentials travel in the rendered compose file**, which is therefore a
secret file: mode 600, gitignored, and deleted as soon as the deploy finishes.
The dry run redacts every value it prints — it shows which variables get set,
not what they are — and keeps the rendered file so you can review it.

This is not the arrangement the module was built with. Fly's documentation says
secrets set with `fly secrets` are "global and available to every container";
they are not. A machine's containers receive only their own environment, which
comes from the compose file. With the values stripped, every container started
without credentials while `fly secrets list` reported all fourteen as
`Deployed` — the app answering 500 from better-auth's default-secret error, the
scorer refusing to start, and sync refusing to poll with no org or token to
poll with.

`deploy.sh` still sets `fly secrets` as well, so nothing regresses if Fly
changes this.

**The upside is real scoping**, which Fly's global secrets could not give:
each credential appears only under the service `docker-compose.yml` grants it
to. The `app` container never receives `REDIS_PASSWORD`; `redis` never receives
`GITHUB_CLIENT_SECRET`.

`.env.fly` is gitignored, mode 600, and separate from `.env` on purpose: a
compose stack and a Fly deployment need different `EVENT_URL`s, and one file
cannot hold both.

## The rendered compose file

`deploy/fly/render-compose.sh` turns `docker-compose.yml` into
`compose.fly.yml` at the repo root (generated, gitignored, mode 600). Read it
after a dry run — it is exactly what Fly will deploy. It **does** hold
credentials, which is why a real deploy removes it when it finishes.

The render exists because **flyctl's compose parser is not Docker's**. It is a
hand-rolled `yaml.v3` unmarshal, and as of flyctl 0.4.87 it implements neither
`profiles:`, nor `${VAR}` interpolation, nor build `args:`. `docker compose
config` implements all three correctly, so the real file goes through Docker
first.

On top of that, the render:

- **keeps secret values, and refuses to write them anywhere git can see** —
  a fail-closed check asks `git check-ignore` directly and deletes the file if
  the answer is no
- **unescapes compose-only `$$`** — to compose it means a literal `$`, but Fly
  passes it straight through, and `sh -c` would expand `$$` as the shell's PID
- **rewrites service names to `localhost`** — there is no DNS between
  containers in one namespace, including hosts that follow userinfo, as in
  `redis://:PASSWORD@redis:6379`
- **drops** bind mounts, named volumes, networks and profiles

Never edit the rendered file. Every change belongs in `docker-compose.yml`,
which is the point of rendering it.

## Security differences from compose

Two properties the local stack has do **not** survive on Fly. Neither is new
to this module — the five-app version had already lost them — but they are
worth knowing before you run a public event.

**No `frontend`/`backend` network split.** [ADR 41](decisions.md) cuts the app
tier off from `redis:6379` so a compromised app cannot bypass srh's bearer
token. One machine has one network namespace, so that route is open, and
binding redis to `127.0.0.1` would not help because containers share loopback.
**`requirepass` is the whole control on Fly**, which is why `REDIS_PASSWORD`
is mandatory rather than optional.

**No per-service secret scoping**, as above.

What does hold: no inbound scoring surface at all, TLS from Fly, srh
never public, and the datastore reachable from nothing outside the machine.

## Cost and shape

One machine — `shared-cpu-2x`, 2 GB — plus one 1 GB volume. Sized for five
containers with Next.js as the heavy one; the scorer only *serves* here, since
judging runs on GitHub's runners.

### Autostop

The machine **does not stop when idle**, by default. Autostop suits a stateless
web app an inbound request can wake; this one also holds redis and the sync
poller. While it is stopped the leaderboard does not advance — contestants' PRs
are still scored by GitHub Actions, but the comments pile up uncollected until
someone loads a page and wakes the machine.

That is wrong *during* an event and reasonable *between* them. A kit left
standing for a chapter that runs a CTF twice a year is paying for idle time,
so it is a knob in `.env.fly`:

```sh
FLY_AUTO_STOP=off       # default: always running
FLY_AUTO_STOP=stop      # stopped when idle, cold start on the next request
FLY_AUTO_STOP=suspend   # memory snapshotted and restored, much faster wake
```

`deploy.sh` warns on every deploy where it is not `off`, and refuses a value
that is not one of the three (`true` is the obvious guess and is not one of
them). It never edits `fly.toml`: the substitution goes to a temporary copy,
with `min_machines_running` dropped to 0 — leave that at 1 and Fly keeps a
machine up regardless, so the setting looks applied and does nothing.

**Turn it off before an event starts.**

## Tear down

```sh
fly apps destroy owasp-ctf
```

That takes the volume with it. Export anything you want to keep first.

## CI

`.github/workflows/ci.yml`'s `shell` job shellchecks both scripts and runs
`bats deploy/fly/test/` — 56 assertions covering `fly.toml`'s invariants, the
render's output (no secret values, no `$$`, every service on loopback with an
image, no leftover build/networks/volumes/profiles keys), and `deploy.sh`'s
guards. The render runs for real; nothing is ever deployed, and no Fly account
is involved.

## Who can read the secrets

Credentials reach the containers through the rendered compose file's
`environment:` blocks, because that is the only channel Fly gives a
compose-defined container. They therefore end up in the **machine
configuration**, and anyone who can reach the app on Fly can read them:

```sh
fly machines list --app <app> --json     # prints every container's env
fly ssh console --app <app> -C env
```

That is not unique to this module — `fly secrets` values are also readable from
inside the machine by anyone who can `fly ssh console` — but the machine config
makes them readable without a shell, and it is easy to paste one of those dumps
into a terminal, a screen share or an issue. Treat `fly machines list --json`
output as secret material.

The compensation is that each credential is scoped to the one service that
needs it: the app container never receives `REDIS_PASSWORD`, and `redis` never
receives `GITHUB_CLIENT_SECRET`. Fly's own global secrets cannot express that.

## Images are pinned by digest

`deploy.sh` resolves each image to its digest after pushing, so the rendered
compose names the exact artifact that was just built.

A tag is a moving pointer that Fly resolves when the machine starts, and a
rebuilt-and-repushed `:scorer` did **not** reach a running machine: the registry
held the new image, the machine kept serving the old one, and the only symptom
was a `404` on a route the new build has and the old one does not. Nothing in
the deploy output was wrong.

It also makes a deploy reproducible — redeploying the same file later brings up
the same bytes, not whatever the tag points at by then.
