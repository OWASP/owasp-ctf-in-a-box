# Deploy on fly.io

Run the whole event as **one Fly app, one machine, five containers**, instead
of a box you administer. `deploy/fly/deploy.sh` up, `fly apps destroy` down.

Full walkthrough: [`docs/fly.md`](../../docs/fly.md).
Why it is shaped this way: [ADR 42](../../docs/decisions.md).

## What is in here

| File | Job |
|---|---|
| `fly.toml` | The app: which container serves the public, the volume, the machine size |
| `render-compose.sh` | Turns the repo's `docker-compose.yml` into the compose file Fly deploys |
| `deploy.sh` | `init` (env file) and the deploy: build, push, mirror, render, secrets, deploy |
| `test/fly.bats` | The module's bats suite, run by CI's `shell` job. Nothing is ever deployed |
| `compose.fly.yml` | **Generated**, gitignored. The rendered file Fly actually reads |

## It runs the real compose file

`fly.toml` points at a compose file through `[build.compose]`, and that file is
*rendered* from the repo's `docker-compose.yml` on every deploy. There is no
hand-maintained cloud twin to drift — the same five services, wired the same
way, from one source.

| Compose service | On Fly |
|---|---|
| `app` | container, the only one reachable from the internet (port 3000) |
| `scorer` | container, `http://localhost:4000` |
| `sync` | container, outbound only, one volume |
| `srh` | container, `http://localhost:80` |
| `redis` | container, `127.0.0.1:6379`, one volume |
| `caddy` | **absent** — Fly terminates TLS and issues certificates |

caddy is excluded by naming the deployed services explicitly in the render,
**not** by giving it a compose profile. Profiling it would make the edge
opt-in for every *local* bring-up, so one forgotten flag would mean an event
with no ingress.

## Why one machine and not five apps

**Fly's private network (6PN) is IPv6-only. srh's Redis client is IPv4-only.**

srh is a prebuilt third-party image whose Elixir release bundles redix 1.1.5.
redix supports `socket_opts` — where `:inet6` would go — but srh builds its
connection options from the connection string alone and exposes no knob for
it. A five-app deployment therefore has no way for srh to reach redis, and the
symptom lies: `nc` to `redis.internal:6379` succeeds, redis looks healthy, and
srh repeats `SRH was unable to connect to the Redis server` forever.

Containers inside one machine share a network namespace and reach each other
over `localhost`, on IPv4. That removes the failure rather than working around
it.

Reproducing it takes about a minute and needs no Fly account: create an IPv6
docker network, run redis and srh on it, point srh at the address. Identical
image, redis and password — IPv4 literal works, IPv6 literal does not.

## Why the compose file is rendered, not copied

flyctl's compose parser is **not** Docker's. It is a hand-rolled `yaml.v3`
unmarshal (`internal/containerconfig/compose.go`), and as of flyctl 0.4.87 it
implements none of:

- `profiles:` — every service in the file is deployed
- `${VAR}` interpolation — `${SRH_TOKEN}` arrives as that literal string
- build `args:` — so no image can be handed build-time configuration

and it rejects a file where more than one service declares `build:`
(`only one service can specify build`), which `docker-compose.yml` does twice.

`docker compose config` implements all of them correctly, because it *is*
Docker's parser. So the real file goes through Docker first and Fly receives
the result. On top of that the render:

1. **Keeps secret values, and guards the file instead.** Per-container
   `environment:` is the only channel that reaches a container in a Fly
   machine — `fly secrets` does not, despite Fly's docs saying secrets are
   "global and available to every container". So the output is a credential
   file: mode 600, deleted once the deploy succeeds, and a fail-closed check
   asks `git check-ignore` directly and deletes it if the answer is no. The
   compensation is scoping Fly cannot express: the app never receives
   REDIS_PASSWORD, redis never receives GITHUB_CLIENT_SECRET.
2. **Unescapes `$$`.** To compose it means a literal `$`; Fly passes it
   through untouched, so `sh -c` would expand it as the shell's PID and redis
   would come up with a password like `12345REDIS_PASSWORD` — healthy, and
   impossible to authenticate against.
3. **Rewrites service names to `localhost`.** No DNS exists between containers
   in one namespace. Both URL forms are rewritten — `//host:` and the
   userinfo form `//user:pass@host:`, which srh's connection string uses and
   which an earlier version missed.
4. **Drops** bind mounts, named volumes, networks and profiles — none of which
   mean anything on a Fly machine.

Never edit `compose.fly.yml`. Every change belongs in `docker-compose.yml`.

## Flags `deploy.sh` takes

`deploy.sh [init] [flags]`; `init` prepares the env file, no subcommand
deploys. `-h`/`--help` prints the same list.

| Flag | Applies to | What it does |
|---|---|---|
| `--dry-run` | both | Print every `fly` command, run none; secret values redacted |
| `--env-file <path>` | both | The Fly env file `init` writes and a deploy reads. Default `.env.fly` |
| `--from <path>` | both | The compose `.env` copied (or `--refresh`ed) from; on a deploy, the file the credential-drift check compares against. Default `.env` |
| `--region <code>` | `init` only | Write `FLY_REGION` without prompting; three lowercase letters, validated; ignored if the env file already has one |
| `--refresh` | `init` only | Re-copy the external-system credentials from `--from` — including `GITHUB_ORG` and `ADMIN_LOGINS` — overwriting; leaves `EVENT_URL`, `FLY_REGION`, `SRH_TOKEN`, `REDIS_PASSWORD`, then falls through to the top-up prompts. An **explicitly blank** source value clears only `GITHUB_APP_INSTALLATION_ID`; for every other key, and for any key **absent** from `--from` altogether, it keeps the destination value and says so |
| `--skip-build` | deploy only | Reuse the images already in Fly's registry; safe for a config change, since the app image bakes nothing but its health-check build stamp. NOT safe after changing `SCORE_IMAGE`: the skip path reuses the `SCORER_IMAGE` already in the registry and never mirrors the new one, so deploy once without the flag first |

`--region` and `--refresh` are parsed on a deploy too, and ignored. `--from`
is not: a deploy compares `.env.fly` against it (see the guards below).

**`FLY_REGION`** lives in the env file. `init` sets it once — existing value
kept, else `--region`, else a prompt defaulting to `fly.toml`'s
`primary_region` (`iad`), else that default with no tty. A deploy reads it
(falling back to `primary_region` when the line is absent or empty) and passes it
to `fly volumes create --region` and `fly deploy --primary-region`.

## Guards `deploy.sh` carries

Each of these caught a real mistake:

- non-https `EVENT_URL` refused (the app refuses to serve production over
  plain HTTP — ADR 39)
- `<placeholder>` left in `EVENT_URL` refused
- `EVENT_URL` host vs app name → **warns**, never fails; a custom domain is
  legitimate
- secret values redacted in `--dry-run`, which makes no `fly` calls at all
- env file chmod 600 even when it already existed
- a missing variable is named individually, not as a list
- `--skip-build` is safe for a configuration change: since config v2 (#386)
  the app image bakes nothing but its health-check build stamp, and
  `GITHUB_ORG`/`ADMIN_LOGINS` reach the machine as runtime environment — with
  one exception, `SCORE_IMAGE`, whose mirror step is skipped along with the
  builds, so the machine keeps running the `SCORER_IMAGE` already in Fly's
  registry (or is handed a tag Fly has never seen). Change that key and deploy
  once WITHOUT `--skip-build`
- images built `--platform linux/amd64`; an arm64 image deploys cleanly and
  then dies with an exec format error
- **credential drift between `.env.fly` and `--from` → warns**, before the
  build and again in the closing summary, naming every external-system key
  that differs and **never a value**. It warns rather than refuses because
  per-environment OAuth apps are legitimate. A re-created event org whose
  `.env` was rewritten and whose `.env.fly` was not deployed the old
  credentials in silence: every sign-in bounced with
  `?error=application_suspended` and `sync` logged a GitHub 401 on every poll
  (#381)
- **a key assigned twice in the env file → warns**, naming it and saying the
  last assignment wins (a live `.env.fly` had `SCORE_IMAGE`
  twice, so editing the first line changed nothing); `init --refresh` collapses
  the duplicates of any key it rewrites
- `init --refresh` obeys an **explicitly blank** source value for
  `GITHUB_APP_INSTALLATION_ID` only — that blank means "auto-discover the
  installation" — and keeps the deployed value for every other key, since
  clearing `ADMIN_LOGINS`, `GITHUB_ORG` or `SCORE_IMAGE` would break a live
  event. A key **absent** from `--from` keeps the deployed value for every key
  including the installation id: only an explicit assignment clears, so
  refreshing from a partial `.env` cannot unpin an id nobody mentioned

## Two things this deployment cannot give you

Both were already true of the five-app version. See ADR 42.

- **No `frontend`/`backend` network split** (ADR 41). One machine, one network
  namespace — every container can reach `redis:6379`, and binding to
  `127.0.0.1` would not help because loopback is shared too. `requirepass` is
  the whole control here, which is why `REDIS_PASSWORD` is mandatory.
- **No per-service secret scoping.** Fly's secrets are global to the machine.
