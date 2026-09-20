---
title: Hosting
---

[← Docs home](index.md)

# Hosting

Everything you need to stand the kit up: prerequisites,
[how scores reach the box](#how-scores-reach-the-box), the GitHub
OAuth app contestants sign in with, and how event config reaches the app. For the happy-path command sequence see the
[README Quickstart](https://github.com/dcotelo/owasp-ctf#quickstart); for
running the event once it is up see [docs/operations.md](operations.md).

## Quickstart: zero to a scored event

**The fastest path is the wizard** — run `ctf-setup.sh` with no subcommand and
it walks the whole sequence below. It **asks for each value inline** — your box
URL, the event org, the admin logins, whether you run **Secure Development**,
and the App/OAuth credentials — showing the instructions and GitHub URL for
each, and writing `.env` for you as you answer. There is no config file to
edit between steps: `.env` is the whole bootstrap plane, and everything else
(the event's name and dates, **which modules run**, which Secure Development
targets) is a runtime `/admin` setting. It does every automatable step,
guides + verifies each UI-only one, and resumes if you stop:

```sh
./setup/ctf-setup.sh            # guided, prompts for values, resumable
```

Every discrete step is also its own subcommand — `check`, `secrets`, `org`,
`render`, `upgrade`, `teardown`, `doctor`, `app-manifest`, `app-config`,
`oauth-app`, `oauth-config` — with the global flags `--dry-run` (print
mutating commands instead of running them) and `--out <path>` (default
`.env`, the file every subcommand reads and `secrets` writes). The numbered
sequence below names each one where it's used; `teardown` is covered in
[operations.md](operations.md#running-an-event).

![The guided setup wizard in a terminal: an ASCII banner, then numbered steps — a resumed run, where the secrets, event config and scorer image already in place are ticked off and the wizard continues from the first step still to do](assets/wizard.jpg)

<sup>The wizard on a resumed run: every step already done is ticked and
skipped, and it continues from the first one still to do. On a first run each
of those values is asked for inline, with the GitHub page it comes from.</sup>

**Step 3, "Event basics", is the whole of what the wizard writes.** Three
keys into `.env`, in this order:

- **`GITHUB_ORG`** — the disposable per-event org. Blank is allowed for an
  event that runs no forked content.
- **`ADMIN_LOGINS`** — comma-separated GitHub logins allowed into `/admin`.
  It defaults to the login running the wizard (`gh api user`), so Enter
  accepts. **An answer that names no usable login is refused**, not written.
  The app parses this string and drops every entry that is not shaped like a
  GitHub login, so `,`, `" , "` and `alice@example.com` all reach it as an
  empty allowlist — indistinguishable from unset, and `/admin` then forbids
  *everyone*. How loudly depends on what you got wrong: a non-empty entry that
  fails the login format makes `envAdmins` log ONE warning naming the *count*
  of dropped entries and nothing else (never the entries — one might be a
  pasted secret), once per process, at `admin-auth.ts`'s module load;
  separator-only or whitespace-only input drops nothing and logs nothing at
  all. Either way the panel is fail-closed and you find out when somebody
  tries to open it. Give it at least one real login; the wizard and
  `deploy/fly/deploy.sh` both refuse the value outright rather than let it
  deploy.
- **`SCORE_IMAGE`**, from one question — *"Run Secure Development (fork the
  six targets and score patch PRs)?"*. Yes writes the scorer image reference
  (your existing one, else `ghcr.io/<org>/score:latest`); no writes it empty.
  **Non-empty is the switch**: it is what says this event runs Secure
  Development at all. Saying yes with no org is refused, since there would be
  nothing to fork into.

The wizard does **not** ask how scores reach the box: there is one transport
and nothing selects it (see [how scores reach the box](#how-scores-reach-the-box)).
The `SCORE_INGEST` key that used to answer that question is gone — the wizard
writes no such line and rewrites none, because nothing reads it. A line an
upgraded `.env` still carries is inert; `doctor` points at one whose value is
anything other than `poll`, since that value describes a transport the box no
longer has, and says to delete it. `EVENT_URL` is asked once: at step 2 when the wizard
creates `.env`, or at step 3 when an existing file has no value for it.

**Secure Development decides which later steps run.** With `SCORE_IMAGE` set,
steps 4–7 do the scorer image, the `sync` GitHub App, and the org: forks,
scoring workflows and the package-grant checklist. With it empty each of
those prints `⏭  not needed` and the run goes straight to the bring-up — no
scorer image to build, no App to install, no org to create, and a `docker
compose --profile app` command with no `secdev` profile. Step 6, the
sign-in OAuth app, always runs: every event needs sign-in. With no event org
it points you at GitHub's personal new-OAuth-App page instead of the org's.

The wizard never asks which targets to run: `ctf-setup.sh org` forks and
provisions all six of `setup/targets.tsv` for every event that runs Secure
Development, and which of the six contestants actually see is chosen
afterward from `/admin` → Secure Development → Targets, live, with no
rebuild — see [docs/operations.md](operations.md#targets).

**Everything else is a runtime setting, so the wizard does not ask for it.**
Which modules run, the event's name, tagline, location, contact and Discord
invite, the scoring window and dates, hint policy, team caps, the quiz's
attempt and cooldown knobs: all of them live in `ctf:admin:settings` and are
changed from `/admin` while the event is up (config v2, #386). There is no
config file to write or re-bake, and the only "module" question at setup time
is the Secure Development one above, because that module is the only one with
containers and forks to provision.

A resumed run re-reads `.env` and ticks off what is answered rather than
re-asking it, and says which way the Secure Development switch is set — plus,
when it is off, that setting `SCORE_IMAGE` is how you turn it on. The one
exception is a hand-rolled `.env` with no `SCORE_IMAGE` line at all: that
question has never been put, so the wizard asks step 3 again rather than
assuming an answer.

**The wizard closes by offering an optional fly.io deploy** (issue #371).
After step 9 has verified the box, it asks *"Deploy to fly.io now?"* —
**default no**, so a run that only wants the local stack ends exactly as it
did before. Say yes and it:

1. runs `deploy/fly/deploy.sh init --from .env`, which asks which Fly region
   to run in and writes `.env.fly`;
2. asks for the public hostname and writes it as `EVENT_URL` **in `.env.fly`
   only** — `.env` keeps the compose box's URL, because one event served from
   a box and from Fly has two hostnames (ADR 43);
3. prints the OAuth callback that hostname needs
   (`https://<hostname>/api/auth/callback/github`). Step 6 registered the
   callback for `.env`'s URL, and GitHub matches the callback host exactly, so
   the Fly deployment needs either that OAuth app repointed at it or a second
   OAuth app of its own, whose client id/secret go in `.env.fly`;
4. previews the deploy with `deploy.sh --dry-run` and asks for confirmation
   before running the real one;
5. hands off `fly certs add <hostname> --app <app>` when the hostname is a
   custom domain rather than `*.fly.dev`, and `fly ips list` for the case
   where a deploy reports success but the box is unreachable.

The step skips itself, saying why, whenever it cannot work: no `flyctl` on
`PATH` or no Fly session (it prints the install or `fly auth login`
instruction and moves on), or an app-only event (the Fly machine runs the
scorer and poller too, so `deploy.sh` requires `SCORE_IMAGE`).
A failed or abandoned deploy is never fatal: everything the nine
steps wrote to `.env` stays, and the step names the command to re-run. Under
`--dry-run` it is narrated and calls nothing. The module itself, and what runs
on the machine, is [docs/fly.md](fly.md).

The rest of this section is the same sequence as explicit commands, for when
you'd rather drive it yourself or script it. Each step is either a
`ctf-setup.sh` command or a **UI-only** step GitHub forces you through by hand
(marked below); `ctf-setup.sh` never mints credentials or creates orgs for you.

```sh
# 0. Verify tooling: gh auth, docker, docker compose v2, openssl.
./setup/ctf-setup.sh check

# 1. Clone the repo and work from its root.
git clone https://github.com/dcotelo/owasp-ctf && cd owasp-ctf

# 2. Generate .env — BETTER_AUTH_SECRET, SRH_TOKEN, SCORER_TOKEN, REDIS_PASSWORD,
#    EVENT_URL, and empty App/OAuth/SCORE_IMAGE fields to fill later.
./setup/ctf-setup.sh secrets

# 3. Build + push the scorer image, then set SCORE_IMAGE in .env by hand.
#    Pin linux/amd64 — GitHub runners are amd64; an arm64 image (the default on
#    Apple Silicon) fails scoring with "no matching manifest for linux/amd64".
docker login ghcr.io   # token with write:packages
docker buildx build --platform linux/amd64 -t ghcr.io/<your-org>/score:latest --push scorer/
#    MANUAL: edit SCORE_IMAGE=ghcr.io/<your-org>/score:latest in .env
#    (the wizard builds + pins amd64 for you at step 4)

# 4. Fill in the two bootstrap identities in .env, by hand or with the wizard.
#    MANUAL edit: GITHUB_ORG=<your event org>, ADMIN_LOGINS=<your login>.
#    Both are read at RUNTIME with no baked default: an empty ADMIN_LOGINS
#    403s everyone at /admin, and an empty GITHUB_ORG leaves the poller
#    refusing to start. The event's name and dates, which modules run and
#    which Secure Development targets run are all /admin settings — see
#    step 10 below.

# 5. Create the disposable GitHub org — UI-ONLY, ctf-setup never creates it:
#    https://github.com/account/organizations/new
```

```sh
# 6. Sync GitHub App (poll auth). Opens a pre-filled creation form:
./setup/ctf-setup.sh app-manifest
#    UI-ONLY: Create App → Generate a private key (.pem) → note the App ID →
#    Install App on the event org. Then wire the key + App ID into .env:
./setup/ctf-setup.sh app-config --app-id <id> --pem ~/Downloads/<app>.private-key.pem
#    Add --installation-id <n> to pin the install; otherwise sync
#    auto-discovers it at runtime.

# 7. Sign-in OAuth app (separate from the App above). Opens the page and
#    prints the exact field values:
./setup/ctf-setup.sh oauth-app
#    UI-ONLY: fill the fields with callback <EVENT_URL>/api/auth/callback/github
#    → Register → Generate a client secret → copy Client ID + secret. Then:
./setup/ctf-setup.sh oauth-config --client-id <client id>
#    The secret is read from a hidden prompt — never on the command line.

# 8. Provision the event org. Dry-run first, then for real:
./setup/ctf-setup.sh org --dry-run
./setup/ctf-setup.sh org
#    org forks the targets, creates + protects the `ctf` branch, COMMITS
#    ctf-score.yml to each fork, disables inherited workflows, and mirrors
#    SCORE_IMAGE into the org's GHCR. Finish the UI-ONLY steps it prints:
#      (a) detach each fork from its fork network (Settings → Leave fork
#          network);
#      (b) keep ghcr.io/<org>/score PRIVATE and grant each fork Read under the
#          package's Manage Actions access.
#    (There is no secrets step for scoring — the score comment is the whole
#     transport. doctor reports any leftover LEADERBOARD_URL/LEADERBOARD_TOKEN
#     org secret as a credential to delete.)
#    Then verify provisioning:
./setup/ctf-setup.sh doctor
```

```sh
# 9. Bring the containers up. Everything the containers need is in .env —
#    there is no config file to bake in. The profiles follow SCORE_IMAGE —
#    see "Which profiles do I need?" below; this is the secure-development
#    line-up.
docker compose --profile secdev --profile app up -d --build

# 10. Verify: watch the poller heartbeat, open the app, sign in, hit /admin.
docker compose logs -f sync
#     Open $EVENT_URL, sign in with GitHub, confirm /admin loads for an admin login.
```

## Prerequisites

Every event needs:

- Docker with Compose v2 (`docker compose version` must work).
- [`gh` CLI](https://cli.github.com), authenticated (`gh auth login`) —
  `ctf-setup.sh check` requires it whatever the module mix.
- `openssl` — `ctf-setup.sh check` requires it (used for secret generation).

Only an event that runs **Secure Development** (`SCORE_IMAGE` set in `.env`)
also needs:

- A GitHub org for the event — one free org per event. It becomes
  `GITHUB_ORG`: the org the forks live in and the poller reads.
- `docker login ghcr.io` with a `write:packages` token. The `org` subcommand
  ends with `docker push ghcr.io/<org>/score:latest`, so it needs write access
  to your own org's packages.
- A scorer image named by `SCORE_IMAGE`. Empty means this event does not run
  Secure Development: `ctf-setup org` says so and skips every
  fork/mirror/poll step (exit 0 — an app-only event provisions nothing on
  GitHub and needs no org at all). Set it and the same command provisions all
  six targets of `setup/targets.tsv`; `/admin` then picks the subset
  contestants see.
  <br>Compose is the one place that does *not* treat empty as "no scorer": the
  `scorer` service falls back to the private `ghcr.io/owasp-ctf/score:latest`,
  so selecting `--profile secdev` with no `SCORE_IMAGE` of your own fails the
  pull rather than starting anything. Your own image is what makes that
  profile usable.

Build your own scorer from the engine in `scorer/` — that is the
self-contained path and it needs no upstream access:

```sh
docker buildx build --platform linux/amd64 -t ghcr.io/<your-org>/score:latest --push scorer/
```

(`--platform linux/amd64` is required — GitHub runners are amd64, and
`ctf-setup org`'s mirror step refuses a non-amd64 image.)

The upstream image `ghcr.io/owasp-ctf/score` is private with no formal access
process; if the OWASP-CTF maintainers grant you access, point `SCORE_IMAGE` at
it instead. Either way `ctf-setup org` mirrors whatever `SCORE_IMAGE` names
into your event org so the forks' Actions can pull it. Authoring a rubric and
building the image is covered in [docs/scorer.md](scorer.md).

## Fork setup and the contest flow

Each target is a specific **upstream** app pinned to a source ref — that pin is
the source of truth (there is no middle-man fork). The scorer judges a fork of it
with the vendored rubric, and the *scoring baseline* image is the stock, unpatched
build that [`stock-scores-zero`](operations.md#verifying-it-works) proves scores
`0 / N`:

> The per-target upstream repo and pinned ref below are sourced from
> [`setup/targets.tsv`](https://github.com/OWASP/owasp-ctf-in-a-box/blob/main/setup/targets.tsv),
> which `ctf-setup org` reads to fork each target. Keep this table in sync with that file.

| Target | Upstream repo | Source ref | Scoring baseline (pinned image) |
|---|---|---|---|
| `juice-shop` | `juice-shop/juice-shop` | tag `v20.0.0` | `bkimminich/juice-shop:v20.0.0` |
| `webgoat` | `WebGoat/WebGoat` | tag `v2025.3` | `webgoat/webgoat:v2025.3` |
| `vulnerableapp` | `SasanLabs/VulnerableApp` | tag `2.1.37` (commit `bad68b1`) | `sasanlabs/owasp-vulnerableapp:2.1.37` |
| `securityshepherd` | `OWASP/SecurityShepherd` | commit `662771b` | self-build (no stock image) |
| `dvwa` | `digininja/DVWA` | commit `d45ba3c` | `ghcr.io/digininja/dvwa@sha256:091498ce…` |
| `vampi` | `erev0s/VAmPI` | commit `f16052d` | `erev0s/vampi@sha256:0a5a224b…` |

`ctf-setup.sh org` forks each target into your event org, commits the scoring
workflow (`.github/workflows/ctf-score.yml`) to each fork's `ctf` branch, and
mirrors your `SCORE_IMAGE` into the org's GHCR. (The separate `render`
subcommand writes the workflows to `dist/workflows/` for offline inspection
without committing.) It automates the whole per-fork setup, is idempotent (safe to
re-run — each step is skipped once already satisfied), and leaves only three
GitHub-UI-only steps for you to finish by hand. Run `ctf-setup.sh doctor`
afterward: it prints a **status matrix** (one row per target, one column per
step) so the whole org's provisioning is scannable at a glance, then reports
each fork's **scoring-workflow version** (see
[Upgrading the scoring workflow](#upgrading-the-scoring-workflow)) and each
fork's **package Read grant**, the one step with no API in either direction.

It also checks the three bootstrap facts that have no other alarm:
**`ADMIN_LOGINS` is non-empty** (empty 403s everyone at `/admin`),
**`GITHUB_ORG` is set and matches the org being inspected** (a warning
instead of a failure when Secure Development is off, since an app-only event
has no org), and **the `sync` GitHub App is installed on the org**, by App
id — failing closed, so a `gh` error without `admin:org` scope reports "not
verified" rather than "installed". See
[docs/operations.md](operations.md#the-org-and-the-bootstrap-keys-ctf-setupsh-doctor).

![ctf-setup.sh doctor status matrix: one row per fork, one column per step](assets/doctor.jpg)

**Automated by `ctf-setup org`** (one pass per target):

1. **Fork** the target from its pinned upstream repo/ref into your event org.
2. **Create and default the `ctf` branch** at that pinned ref (and drop the
   fork's old `master`/`main` default branch).
3. **Protect the `ctf` branch** so a contestant can never merge their patch —
   the PR is *scored, not merged*. It installs a minimal rule requiring one
   approving review:

   ```sh
   gh api -X PUT repos/<org>/<repo>/branches/ctf/protection --input - <<'JSON'
   { "required_status_checks": null, "enforce_admins": false,
     "required_pull_request_reviews": { "required_approving_review_count": 1 },
     "restrictions": null, "allow_force_pushes": false, "allow_deletions": false }
   JSON
   ```

4. **Install the scoring workflow**: renders and commits
   `.github/workflows/ctf-score.yml` on the `ctf` branch from the in-repo
   template.
5. **Disable the fork's inherited/upstream workflows** (everything except
   `ctf-score.yml`), so only the scoring Action runs.
6. **Install the PR template** (`.github/PULL_REQUEST_TEMPLATE.md`) on the
   `ctf` branch.
7. **`vulnerableapp` only** — install the Dockerfile it needs to build.
8. **Mirror `SCORE_IMAGE`** into the org's GHCR (once, after all targets),
   refusing a non-amd64 image so scoring can't fail at runtime — GitHub
   runners are amd64; an arm64-only image (e.g. built on Apple Silicon) makes
   the scoring Action fail with `no matching manifest for linux/amd64`.

**Manual — GitHub UI only, no API to perform them.** GitHub has no endpoint to
*do* these, but `doctor` confirms the first two by API (their result is
queryable) and shows ✅ once done — only the third is a blind reminder:

1. **Create the event org** itself.
2. **Detach each fork from the fork network** (repo Settings → *Leave fork
   network*, UI-only). This makes the event-org repo a standalone root, so
   contestant PRs default to *your* repo (not upstream) and contestants can
   fork it themselves. `doctor` verifies via the repo's `.fork` flag (✅
   detached / ⚠️ still a fork).
3. **Keep the `ghcr.io/<org>/score` package private** and **grant each fork
   Read** under the package's *Manage Actions access* (container visibility is
   UI-only). The rendered workflow logs in to GHCR with the runner
   `GITHUB_TOKEN`, which the Read grant makes sufficient. `doctor` verifies the
   package is private via its `.visibility`.

   The per-fork grant has no read endpoint, so `doctor` verifies it **by
   observation** instead: the rendered workflow pulls the scorer image in its
   own step (`Pull scorer image`), and `doctor` reads each fork's recent
   scoring runs for that step's outcome — ✅ *granted* (a run pulled it),
   ❌ *MISSING* (a run was refused), or ⚠️ *unverified* (no run has reached
   the pull yet). It fails closed: an API error, or anything it cannot read,
   reports unverified, never granted.

   This is the only provisioning step with no API, and it used to be the only
   one whose failure looked like something else — an unpulled image failed
   inside the scorer step and posted "Scoring did not complete" to the
   contestant's PR, so the contestant re-pushed a patch that was never judged
   while the organizer had no reason to look at the package settings. The
   workflow now names the cause in the run's step summary and in the PR
   comment, and says plainly that it is a setup problem rather than a verdict
   on the submission.

   **Already-provisioned forks keep the old workflow** until it is re-applied
   — see [Upgrading the scoring workflow](#upgrading-the-scoring-workflow)
   below. A fork still on the old one has no `Pull scorer image` step, so
   `doctor` reports it as ⚠️ unverified — correctly: it has not been observed
   either way.

   Note that this includes forks that have **scored successfully many times**.
   Under the old workflow the pull happened inside `Run scorer`, where it
   cannot be read back separately, so a working grant is invisible to
   `doctor` until that fork runs the upgraded workflow once. ⚠️ here means *not
   observed*, never *not granted*. Re-triggering any existing PR on an
   upgraded fork (close, reopen) is enough to settle it.

### Upgrading an event that predates the Redis password

Redis runs with `requirepass`, and `docker-compose.yml` reads that password
from `REDIS_PASSWORD` with `:?` — so an `.env` written before this change
**does not start a weaker stack, it does not start at all**:

```
error while interpolating services.srh.environment.SRH_CONNECTION_STRING:
required variable REDIS_PASSWORD is missing a value: set REDIS_PASSWORD in
.env (setup/ctf-setup.sh secrets generates one; see docs/hosting.md)
```

(It names `srh` rather than `redis` only because that is the first place
compose resolves the variable — both services need it.)

That is deliberate. A security control whose variable can go missing and
leave the control silently off is the failure this change exists to remove.
`doctor` flags it before you get there, with a generated value to paste. To
fix it by hand, add one line to `.env` and bring the stack back up:

```sh
echo "REDIS_PASSWORD=$(openssl rand -hex 24)" >> .env
docker compose --profile app up -d                    # SCORE_IMAGE empty
docker compose --profile secdev --profile app up -d   # SCORE_IMAGE set
```

Pick the line that matches your `.env` — the same two-way choice as the
bring-up table above. `secdev` is added **iff `SCORE_IMAGE` is non-empty** (a
quiz-, Jeopardy- or AI-only event has no scorer image to pull, and passing the
profile anyway fails at `up` on the private upstream fallback).

Nothing else changes: no data migration, and the `redis-data` volume is
untouched. Only `redis` itself (its `requirepass`) and `srh` (its connection
string) are given the password, and only `srh` can reach Redis — `app`,
`scorer` and `sync` never see it and sit on a separate compose network with no
route to `redis:6379` at all.

If you drive Redis by hand (`docker compose exec redis redis-cli ...`), that
keeps working unchanged: the service sets `REDISCLI_AUTH`, so `redis-cli`
authenticates itself inside the container.

### Upgrading the scoring workflow

The scoring workflow lives in each fork as a committed file, so a change to
the kit's template does **not** reach an event that is already provisioned.
That matters most for the changes you least want stranded — a security fix to
`ctf-score.yml` would otherwise only reach forks by hand, one at a time.

The rendered workflow carries a version stamp copied from the template:

```
# ctf-workflow-version: 3
```

`doctor` reports every fork's version against the kit's, and names the fix
(sample output — the current template version is whatever the stamp above
says in your checkout):

```
scoring workflow version (template is v3):
  juice-shop         ✅ v3
  dvwa               ❌ v2 — stale (template v3); run: ./setup/ctf-setup.sh upgrade
  webgoat            ❌ pre-versioning — provisioned before workflow stamping; run: ./setup/ctf-setup.sh upgrade
```

Then re-apply it to exactly the forks that are behind:

```sh
./setup/ctf-setup.sh upgrade --dry-run   # see which forks would be touched
./setup/ctf-setup.sh upgrade
```

`upgrade` does the workflow step and nothing else. `org` does it too — its
workflow step compares versions rather than just checking the file exists —
but `org` also re-mirrors the scorer image, which is a multi-minute push you
do not want between you and a security fix.

Two things worth knowing:

- **Open PRs keep their current run.** The new workflow applies from each PR's
  next push (or a manual re-run), so a mid-event upgrade rolls out as
  contestants push rather than all at once.
- **A fork ahead of your checkout is left alone.** `doctor` flags it ⚠️ and
  `upgrade` skips it — that means your kit is behind, not the fork, and
  overwriting would silently revert whatever it is running.

Pre-versioning forks (anything provisioned before the stamp existed) read as
stale and are upgraded the same way.

**The contest flow:** a contestant **forks your event-org repo** into their own
account, patches the vulnerability, and opens a **pull request against
`<event-org>/<repo>:ctf`**. The scoring Action (`pull_request_target`, so a
cross-fork PR gets a writable token to comment) runs the scorer and posts the
score comment; the PR is never merged. Detaching the fork network (manual step
2 above) is what makes this fork-then-PR-back flow work.

## How scores reach the box

A Secure Development score travels one way. The fork's scoring Action judges
the PR and posts the verdict as a comment on it; the `sync` service polls the
event org's target repos for those comments and submits what it finds to the
scorer. A score lands on the leaderboard roughly 30 seconds after the Action
finishes. There is nothing to configure and nothing to choose: push ingest —
the Action POSTing the score straight at a `/score` route on your box — was
removed in v0.6 ([#377](https://github.com/OWASP/owasp-ctf-in-a-box/issues/377),
[ADR 56](decisions.md#adr-56-poll-is-the-score-transport-push-ingest-is-removed)),
along with the `SCORE_INGEST` key that used to select between them. An `.env`
carried over from an earlier release may still carry that line; nothing reads
it, and `ctf-setup.sh doctor` names it when it says anything other than
`poll`.

Two properties come with polling, and they are why it is the only transport.
**Nothing has to reach your box from the internet.** The one Caddyfile has no
`/score` route at all, so there is no inbound scoring surface to protect, and
a box behind NAT, on a laptop or on venue wifi scores exactly like a public
one. **Only the judge's own output counts**: `sync` accepts a score marker
only from a comment authored by `github-actions[bot]`, which is a filter a
contestant cannot spoof from their own fork. The whole pipeline is what
`scripts/smoke.sh` exercises end to end, against a mock GitHub.

All it needs is a GitHub App installed on the event org, so `sync` has a token
to read those repos with — see [Poll auth: GitHub App](#poll-auth-github-app)
below. If your event org still
has `LEADERBOARD_URL` / `LEADERBOARD_TOKEN` Actions secrets from a push-mode
event, delete them: nothing reads them any more, and until they are gone they
are standing credentials readable by every run a contestant's pull request
triggers. `ctf-setup.sh doctor` tells you whether they are still set.

### Which profiles do I need?

Compose profiles follow **`SCORE_IMAGE`**, not your taste: `app` is always on,
and `secdev` carries everything `secure-development` needs — the `scorer`,
which judges PRs against the forked targets, and `sync`, which brings their
scores back. Both services carry `profiles: ["secdev"]`, so they come up
together or not at all. A quiz-only event must not be asked to pull a scorer
image it has no reason to own.

**Profiles and `SCORE_IMAGE` are two separate choices that have to agree, not
one setting picking both.** You choose the profile at `up`: `--profile app`
alone for a quiz/classic/ai-only event, `--profile secdev --profile app` with
Secure Development. That second line needs an *accessible* `SCORE_IMAGE` — the
compose fallback image is private, so bringing `secdev` up without your own
`SCORE_IMAGE` set fails the pull. Separately, the app's
DEFAULT module set (what an organizer sees on first opening `/admin`, and
the outage fallback) follows `SCORE_IMAGE` on its own: Secure Development
alone when it is set, nothing when it is not — Quiz, Jeopardy and AI are
switched on from the panel (#386). Nothing enforces that the two agree, so
keep them in sync yourself: never bring the `secdev` profile up without a
`SCORE_IMAGE`, or the scorer container has nothing to score against.

Nothing is baked into the images any more (#386): `--build` only rebuilds
the code, and every value the containers need — `ADMIN_LOGINS`,
`GITHUB_ORG`, `SCORE_IMAGE` — is read from `.env` when they
start. Pick the command by what that file says:

| Your event | Command |
|---|---|
| Secure Development (`SCORE_IMAGE` set) | `docker compose --profile secdev --profile app up -d --build` |
| No Secure Development (`SCORE_IMAGE` empty) — quiz and/or classic and/or ai | `docker compose --profile app up -d --build` |

Quiz, Jeopardy and AI need no profile of their own: they are app-side modules,
they run inside the `app` container, and an organizer switches them on from
`/admin` at any time without touching compose. `ctf-setup.sh wizard` prints
(and offers to run) the right line for the `.env` you answered into, so you do
not have to pick by hand.

Prefer the cloud over your own machine? [Deploy on AWS](aws.md) ships a
Terraform module for an ECS Fargate stack behind an ALB, over managed
ElastiCache — `terraform apply` up, `terraform destroy` down. It replaced a
single-EC2 deploy, so an existing box upgrades by migration rather than by
`apply`.

### Poll auth: GitHub App

`sync` needs a token to read the event org's target repos, and a GitHub App
is the only supported poll auth: org-scoped, auto-expiring, revocable, and not
tied to a person. Each organizer creates their **own** App from
[`sync/app-manifest.json`](https://github.com/OWASP/owasp-ctf-in-a-box/blob/main/sync/app-manifest.json)
and installs it on their event org — there is no shared, central App, so the
private key stays yours.

`ctf-setup.sh` assists the two error-prone parts; you still click Create and
Install in GitHub's UI (the script cannot mint credentials for you):

```bash
# 1. Open a pre-filled App-creation form against your event org.
ctf-setup.sh app-manifest
#    In the browser: Create the App, "Generate a private key" (downloads a
#    .pem), note the App ID, then "Install App" on the event org.

# 2. Wire the downloaded key + App ID into .env (base64-encodes the PEM).
ctf-setup.sh app-config --app-id <id> --pem ~/Downloads/<app>.private-key.pem
#    Add --installation-id <n> to pin the install; otherwise sync
#    auto-discovers it at runtime.
```

This sets `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` (base64-encoded PEM) and,
optionally, `GITHUB_APP_INSTALLATION_ID` in `.env`. Both `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` are required — `sync` refuses to start without them.
You can also set all three by hand instead of using the helpers.

## GitHub OAuth app

Contestants (and admins) sign in with GitHub, so you need an OAuth app —
separate from the sync GitHub App above. OAuth apps have no manifest/create
API, so this is a guided flow rather than an auto-filled one:

```bash
# 1. Open GitHub's new-OAuth-App page for the event org and print the exact
#    field values to paste (callback = <EVENT_URL>/api/auth/callback/github).
ctf-setup.sh oauth-app
#    In the browser: fill the printed fields, Register, then "Generate a new
#    client secret" and copy the Client ID + secret.

# 2. Wire them into .env. The secret is read from a hidden prompt — never on
#    the command line or in shell history.
ctf-setup.sh oauth-config --client-id <client id>
```

This sets `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env`; the app
reads them at runtime. `EVENT_URL` in `.env` is **the** event URL — Caddy, the app's
auth flow, the HTTPS start-up guard, the CSRF origin check and the leaderboard
link in every fork's score comment all read it, and nothing else carries a
second copy. The deleted config file used to carry a `url:` field beside it;
it was a deployment fact living in an event file, it disagreed silently, and
it is gone ([ADR 43](decisions.md#adr-43-one-url-and-it-lives-in-env-not-eventyaml)).
You can also set both by hand instead of using the helpers, and you may
register the OAuth app on your personal account rather than the org.

> **Use HTTPS for any real event.** Set `EVENT_URL` to `https://<your-domain>`
> (not `http://`) for anything beyond local testing. Caddy auto-provisions TLS
> for a real domain, and the sign-in session cookie is only marked `Secure`
> when the URL is HTTPS — over plain `http://` the session cookie can be sniffed
> on the wire, which for an organizer login means admin takeover. `http://localhost`
> is fine for a local trial only.
>
> **This is enforced, not just advised.** A production start with an
> `http://` `EVENT_URL` pointing at anything other than loopback fails the
> startup check in `apps/web/src/instrumentation.ts`: the `app` container comes
> up but answers `500` to every request, and the first lines of
> `docker compose logs app` name the variable, the value, and the fix. The
> check runs at server start only — `pnpm build` is unaffected, so a build
> machine needs no event config.
>
> If a deployment is deliberately TLS-less (a closed lab, an isolated
> classroom network) set `ALLOW_INSECURE_EVENT_URL=1`. It downgrades the
> refusal to a startup warning that says sessions on that deployment are
> sniffable by design. It is not for TLS terminated upstream — in that setup
> the public URL is still `https://`, so `EVENT_URL` should say `https://` and
> the check passes on its own.

## Monitoring

The box exposes two health endpoints, for two different watchers. Both are
public and unauthenticated (a free uptime tier cannot present a credential),
and both live under the same disclosure rule: nothing in either payload that
`git log` and the tag list do not already tell you.

- **`GET /health`** — liveness plus the build stamp: `{status, version,
  revision, builtAt}`. Answers 200 whenever the Node process is serving
  requests and depends on nothing else. This is what Fly's machine check
  watches (`deploy/fly/fly.toml`, `[[http_service.checks]]`), and it must stay
  that way: a check that failed on a Redis blip would restart the one machine
  over the blip.
- **`GET /health/deep`** — can this box actually score? Probes Redis through
  srh (`PING`) and, when `SCORE_IMAGE` is set, the scorer's own `/healthz`;
  answers **200** when both are up and **503** the moment either is not, with
  each dependency reported as exactly `"ok"` or `"down"` — never the reason,
  host or URL (those go to the server log). It also reports the sync poller's
  last poll time and its age in seconds, for information only: a quiet poller
  never fails the check. A box with no scorer image omits `scorer` and `sync`
  entirely rather than vouching for a service it does not run. Results are
  cached in-process for 10 seconds, so the unauthenticated URL cannot be
  turned into a probe storm.

**Point an external monitor at `/health/deep`.** Any free uptime service
works (UptimeRobot, Better Stack, Healthchecks.io — none of them needs a
header): HTTP monitor on `<EVENT_URL>/health/deep`, every 1–5
minutes, alert on any non-200, with a Discord webhook as the notification
channel since the event already runs on Discord. Optionally match the keyword
`"status":"ok"` so a 200 that somehow carries the wrong body still alerts.
This is the one alarm for the failure this kit is designed to hide from
contestants — every read fails open, so a dead Redis or scorer leaves the site
rendering with nothing scoring — and without it the first person to notice is
a contestant asking why the board stopped moving.

The monitor's poll will also wake a machine that has idle-suspended. During
an event that must not be a factor at all: set `FLY_AUTO_STOP=off` in
`.env.fly` and redeploy before it starts (see
[docs/fly.md](fly.md)); `deploy.sh` prints the same warning.

## Cloudflare in front of the box

The reference deployment's domain is on Cloudflare DNS with the proxy on
("orange cloud"), so every request reaches Fly through Cloudflare's edge — a
`cf-ray` header on any response is how you can tell. That is the only place
a **trustworthy** per-IP control can live: the app never sees a client
address it can rely on (Fly sees Cloudflare's, and the `x-forwarded-for`
value a caller can set is appended to, not replaced), and the app's own
rate limiter is per login, which starts only after sign-in. An
unauthenticated `curl` loop against `/api/*` therefore still costs the box a
session lookup per hit unless the edge stops it.

**One rate-limiting rule, on the Free plan.** Cloudflare's Free plan includes
exactly one rate-limiting rule, counted by IP over a 10-second window with a
Block action. Create it at the **zone** level (pick the domain, then
Security → Security rules → Create rule → Rate limiting rule — not the
account-level WAF page, which is a paid add-on):

| field | value |
|---|---|
| When incoming requests match | URI Path · starts with · `/api/` |
| Same characteristics | IP |
| Rate | 100 requests per 10 seconds |
| Action | Block, 10 seconds |

`/leaderboard` and `?display=1` are **not** under `/api/`, so the projector
board's 30 s refresh and a room full of people reloading the standings are
never counted; sign-in goes through `/api/auth/*`, and no person clicks that
ten times a second. Verified on the reference box with a side-effect-free
probe — `GET` on a deliberately nonexistent path such as
`/api/rate-probe`, which answers 404 and touches no store; never a `POST`
to a submit, answer, hint or gate route, which would spend cooldowns,
attempt caps or hint budgets — from one address: 130 requests in about three
seconds let 115 through and blocked 15 with `429`, the block lifted after
ten seconds, and `/leaderboard` answered 200 throughout.

This is the layer above the app's own controls, not a replacement for them:
per-item cooldowns and the quiz attempt cap stop *guessing* (they run inside
the grading scripts); the per-login limiter stops one account hammering team
join and hint reveal; the pre-event password gate (`POST /api/gate`) has its
own best-effort throttle keyed on the first `x-forwarded-for` value, which a
caller can spoof for a fresh bucket — it slows a casual guesser, and that is
all it claims; Cloudflare stops gross floods before they reach the box.
Issue #438 tracks the per-login buckets still missing on the two submit
routes and an Insights view of throttled logins.

## Configuration

**There is no configuration file.** Since #386 an event is configured in
exactly two places, and the split between them is the whole design: what a box
needs before it can answer its first request lives in `.env`, and everything
an organizer changes while the event runs lives in Redis behind `/admin`.

| Plane | Where | Who writes it | What lives there |
|---|---|---|---|
| **Bootstrap** — facts the containers need at start | `.env` | the wizard, or you, once per deployment | `GITHUB_ORG`, `ADMIN_LOGINS`, `SCORE_IMAGE`, `EVENT_URL`, and the secrets |
| **Runtime** — everything an organizer tunes during the event | the `ctf:admin:settings` hash in Redis | `/admin`, live | which modules run, which Secure Development targets run, the event's identity, the scoring schedule, freeze, hint policy, team caps |

Bootstrap keys are read at container **start**, not at build: changing one is
an `.env` edit plus a restart, never a rebuild. Runtime settings are read on
every request and take effect immediately, with no restart at all. See
[ADR 55](decisions.md#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml)
for why the old baked config file was retired.

### The four bootstrap keys

Everything else in `.env` is a secret or a wiring detail (see
[Environment variables](#environment-variables) for the complete list). These
four are the event's identity to the machine:

| Key | Required | What it drives | Empty or unset means |
|---|---|---|---|
| `ADMIN_LOGINS` | **yes** | Comma-separated GitHub logins (matched case-insensitively) allowed into `/admin`. Read by `lib/bootstrap-env.ts` at start, and parsed by `parseAdminLogins`: entries are trimmed and any that is not shaped like a GitHub login is dropped. So a value of separators only (`,`), whitespace only, or nothing but invalid entries (an email address, say) parses to the SAME empty allowlist as unset. Set at least one valid login and check the parsed list is not empty. | **Nobody is an admin** — `/admin` 403s every login, including yours. This fails CLOSED on purpose; there is no "no allowlist, let everyone in" state. |
| `GITHUB_ORG` | when running Secure Development | The event org contestants fork the target repos under. Drives every fork link the app renders, the policy-page prose, and the repos `sync` polls. | The app renders a plain repo name instead of a broken link, and `sync` refuses to start at all, logging `ctf-sync: GITHUB_ORG is not set`. |
| `SCORE_IMAGE` | when running Secure Development | Your scorer image, built from `scorer/` and pushed somewhere the box and the forks can pull it. | The event does not run Secure Development — see below. |
| `EVENT_URL` | **yes** | **The** event URL: Caddy's TLS host, the auth callback origin, the HTTPS start-up guard, the CSRF origin check, and the leaderboard link in every score comment ([ADR 43](decisions.md#adr-43-one-url-and-it-lives-in-env-not-eventyaml)). | Defaults to `http://localhost`, which is fine only for a local trial. |

**`SCORE_IMAGE` is how a box says whether it runs Secure Development.** It is
not just "which image to pull": it is the one setup-time fact left about that
module, and three things read it as the answer.

1. **The compose profile.** `scripts/dev-stack` and Fly's
   `deploy/fly/render-compose.sh` add `--profile secdev` **iff `SCORE_IMAGE`
   is non-empty** — the one place the question is answered at `up` time, and
   derived rather than a second knob to drift (the lesson of #372/#374).
2. **The default module set.** On a first boot against an empty Redis — and as
   the fail-open answer when the settings read fails — a box with
   `SCORE_IMAGE` set enables `secure-development` and nothing else; a box
   without it enables nothing, and the landing page renders its explicit
   no-boards state pointing at `/admin`.
3. **The admin toggle.** With `SCORE_IMAGE` empty, `/admin`'s Secure
   Development switch is disabled with that reason named — there would be no
   scorer container for it to talk to.

`ctf-setup.sh` reads it the same way: with no `SCORE_IMAGE` it skips every
fork, mirror and poll step instead of failing.

### What `/admin` owns

Everything below is a runtime setting in `ctf:admin:settings`, changed from the
panel while the event is running, and covered in
[docs/operations.md](operations.md#organizer-admin-panel):

- **Which modules run** — Event → Modules. Quiz, Jeopardy and AI are switched on
  and off live; so is Secure Development, whenever `SCORE_IMAGE` is set.
- **Which Secure Development targets run** — Secure Development → Targets. The
  setup script forks and provisions all six; the panel picks the live subset,
  and `sync` re-reads it every tick.
- **The event's identity** — Event → Identity: name (default `OWASP CTF`),
  tagline, location, contact e-mail, Discord invite.
- **The scoring schedule and the freeze** — Event → Schedule: scoring opens,
  scoring closes, and the manual pause.
- **Hints, teams and caps** — the hint switch and prices, the registration
  window, and players per team.
- **Module content** — quiz questions, Jeopardy challenges and flags, AI
  challenges: all authored in the panel, all exportable through the event
  archive.

None of it needs a restart, a rebuild, or an edit on the box.

### Modules: registration is code, enablement is runtime

Four module ids are registered today — `secure-development`, `quiz`, `classic`
and `ai`. **Registration is deliberately static** (ADR 35): a module id exists
because the kit ships code for it — `apps/web/src/lib/modules.ts`'s `ModuleId`
union and its registry are the whole list. There is no config-file namespace to
add one to and no dynamic discovery; see
[docs/modules.md](modules.md) for what a new module has to provide.

**Enablement is entirely runtime.** Every `app` image ships the routes, nav
entries and admin tabs for all four, so switching one on in `/admin` → Event →
Modules takes effect on the next request, and switching it off hides it the
same way. Nothing about which modules run is decided at build time any more,
and nothing about it is decided in `.env` — except that `SCORE_IMAGE` decides
whether Secure Development *can* be switched on at all, because that module is
the only one with containers of its own.

Enabling a module changes the **landing page**, not just the nav: the
platform frame (event name, dates, countdown, CTAs, Discord link, progress
card) stays the same, but each enabled module contributes its own tagline,
hero paragraph, "what to expect" section and steps, so the home page always
describes exactly the modules an event actually runs — a quiz-only event
never advertises forking a target or opening a PR. See
[docs/modules.md §5](modules.md#section-5-ui--presentation-contract) for the `home`
block contract.

**`secure-development` is not required — a single module is enough to run an
event.** `ctf-setup.sh`'s `org`/`render`/`doctor` each skip fork-based
provisioning and report "nothing to provision/check" instead of failing when
no `SCORE_IMAGE` is set, and `sync` is simply never started. A quiz-only event
is therefore a supported event on its own: `/challenges` 404s (that route
doesn't exist without the module that owns it), and `/how-to-play`, `/rules`,
the landing page, the leaderboard, and `/profile` all compose from whatever
modules *are* enabled instead of assuming `secure-development` is one of
them. See [docs/modules.md §5](modules.md#section-5-ui--presentation-contract) for
the UI composition contract and [ADR 55](decisions.md#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml)
for where module registration and enablement live now — the app's registry and
the `/admin` settings, with `SCORE_IMAGE` as the one switch Secure Development
answers to. [ADR 24](decisions.md#adr-24-tolerating-a-missing-module-vs-rejecting-an-unknown-one)
records why an unconfigured module is tolerated while an unknown one is not.

**Boot a quiz-only event with `docker compose --profile app up -d --build`**
— just the `app` profile, and no build-args at all. Secure Development's
profile (`secdev`) carries that module's two services, `sync` and the
`scorer`, and a quiz-only event has no use for either: nothing to poll, and no scorer image to pull
(the compose fallback is the maintainers' private image, so asking for it
fails the bring-up). See the [profiles table](#which-profiles-do-i-need)
above.

If you do pass `--profile secdev` anyway — say you enabled
`secure-development` mid-event and then dropped it again — `sync` polls the
org in `.env`, or refuses to start at all if `GITHUB_ORG` is empty, logging
`ctf-sync: GITHUB_ORG is not set` and exiting non-zero
(`sync/src/index.js`'s `main()`); `docker-compose.yml`'s `sync` service is
`restart: on-failure`, so that refusal repeats in the log until the key is
set. You still need a `SCORE_IMAGE` for the scorer that profile also brings
up.

### Hints and teams have no bootstrap knob

Neither is an `.env` key: team size is the `/admin` Event tab's "players per
team" knob, and **hints have exactly one switch: `/admin`'s hint controls**, a
runtime override stored in Redis (ADR 31). It is live, survives restarts,
and governs everything — whether a hint can be bought, whether the challenges
page offers the button, and whether the leaderboard shows hint penalties. There
is no environment variable and no rebuild involved; see
[docs/operations.md](operations.md#organizer-admin-panel).

The one thing an organizer setting cannot do is turn hints on without
`UPSTASH_REDIS_REST_*` credentials — hint text lives only in Upstash, so
without them there is nothing to reveal. What a
module must provide to
plug in — scoring contract, the score transport, security requirements,
provisioning — is documented in [docs/modules.md](modules.md).

### Changing a setting after the stack is running

| What you changed | What it takes |
|---|---|
| Anything in `/admin` — modules, targets, identity, schedule, hints, teams, content | Nothing. It is live on the next request. |
| `ADMIN_LOGINS`, `GITHUB_ORG`, `EVENT_URL`, a secret | Edit `.env`, then bring the stack back up with the same profiles the table above gives for your event — `--profile app` with no `SCORE_IMAGE`, `--profile secdev --profile app` with one — to recreate the containers with the new environment. No rebuild in any case. |
| `SCORE_IMAGE` (adding or dropping Secure Development's containers) | Edit `.env`, then bring the stack up with the profiles that now match it: `--profile secdev --profile app` once it is set, `--profile app` alone once it is empty. |
| The app's own code (a kit upgrade) | `docker compose --profile app build app`, then `up -d`. |

The contestant app (`apps/web/`, vendored — see
[`apps/web/VENDORED.md`](https://github.com/OWASP/owasp-ctf-in-a-box/blob/main/apps/web/VENDORED.md))
reads **no build-time configuration at all**, and no image in the kit takes a
config build-arg. That is the point of #386: an image is the same image on
every box, and a build that forgot a variable can no longer ship an event with
an empty admin list. Dates come from the scoring schedule (**Scoring opens** /
**Scoring closes**) set in `/admin` → Event, same as name, tagline, location,
contact e-mail and Discord invite — all runtime settings, read on every
request.

### Environment variables

`.env` is what `docker-compose.yml` interpolates; each service then reads its
own environment. A variable reaches a container **only if `docker-compose.yml`
passes it** — setting one that compose does not forward does nothing, silently
(that is why `ALLOW_INSECURE_EVENT_URL` and the gate pair are wired through
explicitly). Rows marked *override* are knobs compose does not forward; reach
them with a `docker-compose.override.yml`, or on Fly through `.env.fly`. Rows
marked *fixed* are values compose sets itself and you do not set at all.

`setup/ctf-setup.sh secrets` generates the required ones (`.env.example` is
the same list, annotated), and `doctor` flags a missing `REDIS_PASSWORD`.

**Compose bring-up** — read by compose at `up`, before any service starts:

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `REDIS_PASSWORD` | `redis`, `srh` | **required** (`:?`) | Redis `requirepass`. Unset *or empty* fails `up` at interpolation rather than starting an open Redis; only `srh` can reach `redis:6379`. |
| `SRH_TOKEN` | `srh`; `app`/`scorer`/`sync` as `UPSTASH_REDIS_REST_TOKEN` | required | Bearer token in front of the Redis REST proxy every service talks to. |
| `SCORE_IMAGE` | `scorer` image; `scripts/dev-stack` and `deploy/fly/render-compose.sh` as the `secdev` switch | `ghcr.io/owasp-ctf/score:latest` (private) | Your scorer image built from `scorer/`. Non-empty is what makes Secure Development *available*: it adds the `secdev` profile, seeds the first-boot default module set, and permits the `/admin` toggle (`enabledModules` still decides what is live). Empty and `ctf-setup org` skips every fork/mirror/poll step instead of failing; non-empty and it provisions all six targets. |
| `EVENT_URL` | `caddy` as `EVENT_HOST`; `app` as `BETTER_AUTH_URL` | `http://localhost` | **The** event URL — TLS host, auth callback origin, HTTPS start-up guard, CSRF origin check. `https://` for any real event. |
| `REDIS_DIR` | `redis` | `/data` | Where the append-only file lives inside the volume. Fly sets `/data/redis` (one volume per machine, see [docs/fly.md](fly.md)). |
| `STATE_PATH` | `sync` | `/state/state.json` | The poller's cursor file. Fly sets `/data/sync/state.json`. |
| `EVENT_HOST`, `SRH_MODE`, `REDISCLI_AUTH` | `caddy`, `srh`, `redis` | *fixed* | Derived by compose: Caddy's host from `EVENT_URL`, `srh`'s config mode (`env`), `redis-cli`'s password from `REDIS_PASSWORD` so `docker compose exec redis redis-cli` authenticates itself. |

**App** (`apps/web`, runtime unless noted):

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | `lib/auth.ts`, `lib/gate.ts` | required | Session-signing secret; also keys the pre-event gate cookie's HMAC. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `lib/auth.ts` | required | The sign-in OAuth app (not the poll GitHub App). |
| `ALLOW_INSECURE_EVENT_URL` | `instrumentation.ts` | unset | `1` downgrades the `http://` non-loopback refusal to a start-up warning. TLS-less closed networks only. |
| `CHALLENGES_GATE_ENABLED`, `CHALLENGES_GATE_PASSWORD` | `lib/gate.ts` | unset | Pre-event shared-password gate over the module pages: `true` plus a password. A half-configured gate stays *open*. |
| `LEADERBOARD_SOURCE` | `lib/leaderboard/source.ts` | *fixed*: `lambda` | `mock` / `lambda` / `upstash`. With `secure-development` disabled the mode is forced to `empty` (no scorer read; the board is built from the module overlays alone); an unknown value falls back to `mock` with a warning. |
| `LEADERBOARD_API_URL` | `lib/challenges.ts`, `lib/leaderboard/lambda.ts` | *fixed*: `http://scorer:4000` | Scorer base URL for the challenge catalogue and the board. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | `lib/upstash.ts`; also `scorer/src/store.js`, `sync/src/redis.js` | *fixed*: `http://srh:80`, `SRH_TOKEN` | Redis-over-REST endpoint. Hints, teams, admin settings and module content live behind it. |
| `TEAM_WRITES_ENABLED` | `lib/team-store.ts` | *fixed*: `"true"` | Enables team create/join writes; off in mock mode. |
| `GITHUB_ORG` | `lib/bootstrap-env.ts` | empty | The GitHub org contestants fork the target repos under; drives fork links and policy-page prose. Empty renders plain repo-name text, never a broken link. |
| `ADMIN_LOGINS` | `lib/bootstrap-env.ts`, `lib/admin-auth.ts` | empty | Comma-separated GitHub logins (case-insensitive) allowed into `/admin`. Empty means nobody — and so does a value that parses to nobody: unparseable entries are dropped, so separators-only, whitespace-only and invalid-only all mean the same 403 for everyone. Changing it needs an env edit and a restart. |

**Sync** (`sync/src/config.js`):

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `GITHUB_ORG` | `sync` | required | The event org whose forked target repos are polled. `sync` refuses to start without it, logging `ctf-sync: GITHUB_ORG is not set` — for the poller a missing org is a misconfiguration, not "nothing to poll". Which targets inside the org are polled is a runtime `/admin` setting `sync` re-reads every tick. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | `sync` | required | The poll GitHub App; the key is base64-encoded PEM. `sync` refuses to start without both. |
| `GITHUB_APP_INSTALLATION_ID` | `sync` | auto-discovered | Pin the installation when the App has more than one. |
| `SCORER_TOKEN` | `sync`; `scorer` as `CTF_SCORE_BEARER_TOKEN` | required | Bearer token `sync` presents to `POST /score`. |
| `SCORER_URL` | `sync` | *fixed*: `http://scorer:4000` | Where scores are submitted. |
| `POLL_INTERVAL_MS` | `sync` | `30000` | *override*. Integer in `1..1789569705` (`floor((2^31-1)/1.2)`, headroom for the +20% jitter); anything else refuses at boot rather than tight-looping. |
| `GITHUB_API_URL` | `sync` | `https://api.github.com` | *override*. `scripts/smoke.sh` points it at `mock-github`. |
| `COMMENT_AUTHOR` | `sync` | `github-actions[bot]` | *override*. The only login whose `<!-- ctf-score -->` markers are ingested as points. |

**Scorer, `score serve`** (`scorer/src/serve.js`, on the box):

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `CTF_SCORE_BEARER_TOKEN` | `serve.js` | *fixed*: `SCORER_TOKEN` | Bearer auth on `POST /score`; falls back to `SCORER_TOKEN`, refuses to start with neither. |
| `PORT` | `serve.js` | `4000` | *override*. Checked lexically, integer `0..65535`; a malformed value refuses rather than binding an ephemeral port. |
| `RUBRIC_DIR` | `rubric.js` (serve and judge) | `/rubric` (image build arg `RUBRIC_DIR=rubric.owasp`) | The rubric baked into the image — see [docs/scorer.md](scorer.md). |
| `UPSTASH_REDIS_REST_URL` | `serve.js`, `store.js` | *fixed*: `http://srh:80` | Redis store when set, in-memory store when unset. |

**Scorer, `score judge`** (`scorer/src/judge.js`, `exec.js`) — runs inside the
fork's Action, so these come from the rendered `ctf-score.yml`, org Actions
secrets/variables, or `scripts/acceptance-scorer.sh`, never from `.env`:

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `CTF_OUT_DIR` | `judge.js`, `entrypoint.sh` | `GITHUB_WORKSPACE` | Where `ctf-score.md` is written. The workflow sets `/ctf-out`, **outside the PR checkout** — the marker in it is trust-authoritative. |
| `CTF_DISCLOSE_TABLE` | `judge.js` | disclose | `0` / `false` / `no` hides the per-challenge table in the PR comment (progress bar and counts always show). An org Actions *variable*. |
| `APP_READY_TRIES`, `APP_READY_DELAY` | `judge.js` | `60`, `5` (seconds) | Readiness probe before judging. A literal `0` skips it — only a bring-up script that already proved the app up should set that (`securityshepherd.sh` does). |
| `CTF_SCORE_SAFETY_MS` | `exec.js` | `30000` | Per-probe kill timeout, ms; values below 1 fall back to the default. |
| `CTF_SCORE_CONCURRENCY` | `exec.js` | per-target default | Overrides the probe pool width (clamped to `1..itemCount`). |
| `CTF_UPSTREAM_DIR` | `judge.js` | `GITHUB_WORKSPACE` | Source tree for the static probes that read the contestant's code instead of HTTP. |

**Target bring-up scripts** (`scorer/entrypoints/*.sh`, sourced by the judge's
`entrypoint.sh`; `TARGET` and `APP_URL` are the required inputs, set by the
workflow):

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `WEBGOAT_JDK_IMAGE` | `webgoat.sh` | `eclipse-temurin:23-jdk-noble` | JDK used to build a fork from source through its own `./mvnw`. |
| `SS_UPSTREAM_REPO`, `SS_UPSTREAM_REF` | `securityshepherd.sh` | `OWASP/SecurityShepherd` @ `662771b…` | Source cloned when the workspace has none. Pinned to a commit, never a branch. |
| `WEBWOLF_URL`, `WEBGOAT_LEAKED_ADMIN_PW`, `WEBGOAT_DESER_PAYLOAD` | exported by `webgoat.sh`, read by the WebGoat rubric's tests | *computed* | Not inputs: the bring-up derives them from the running container and always exports them (an *empty* payload means "patched", an *absent* one would fail two challenges outright). |
| `<TARGET>_UPSTREAM_REPO`, `<TARGET>_UPSTREAM_REF` | `scripts/acceptance-patched.sh` (`JS_`, `DVWA_`, `WEBGOAT_`, `VULNERABLEAPP_`, `VAMPI_`, `SS_`), `scripts/acceptance-target.sh` (`WG_`) | pinned per script | Local acceptance only: which fork and ref to judge as the patched or stock baseline. |
