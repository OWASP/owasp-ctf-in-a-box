---
title: Glossary
---

[← Docs home](index.md)

# Glossary

The words this kit uses precisely, for the reader who keeps tripping on one.
Each entry links the doc that owns the full story. If you're trying to *do*
something rather than decode a term, start at the [docs home](index.md)
instead.

**Control plane** — what this kit is: the shared spine every event runs on
(GitHub org, team registration, leaderboard, admin panel, scoring pipeline),
as opposed to the challenge content plugged into it. The boundary is the
[module contract](modules.md).

**Module** — a CTF vertical plugged into the control plane: its own
challenges, scoring logic, and provisioning. Four ids are registered:
`secure-development`, `quiz`, `classic` and `ai`. Any subset runs alone or
together. See [modules.md](modules.md) and, for `ai` specifically, the
external integrator's contract in [docs/ai-module.md](ai-module.md).

**Target** — one deliberately vulnerable app the Secure Development module
scores (Juice Shop, DVWA, WebGoat, Security Shepherd, VulnerableApp, VAmPI).
Each event forks its targets from their own upstreams at pinned versions
(`setup/targets.tsv`); targets are never vendored into this repo.

**Fork** — the event org's copy of a target, which a contestant forks again
and patches. The fork's own GitHub Action is what scores a PR — the box never
runs contestant code.

**Rubric** — the scoring content for one target: what to check and what each
challenge is worth. Two grammars exist — declarative HTTP **probes**
(`<target>.yaml`) and executable `node:test` suites priced by a
**catalogue** (`catalogue.<target>.json`) — and one rubric directory may mix
them. See [scorer.md](scorer.md).

**Probe** — one declarative request/expect check inside a YAML rubric: send
this HTTP request, expect this status/body. The executable grammar replaces
probes with real test code.

**Catalogue** — the priced challenge list for an executable-grammar target:
challenge ids, names, and difficulty (which is the point value).

**Marker** — the machine-readable score comment the fork's Action posts on a
PR: `<!-- ctf-score: {json} -->`. The marker is trust-authoritative — the
poller ingests it only from `github-actions[bot]`-authored comments, and the
workflow writes it only from the judge's own output. See
[architecture.md](architecture.md)'s score data flow.

**Poll** — the score transport, and the only one: the `sync` service pulls
score comments from GitHub every ~30 s, so nothing has to reach the box from
the internet and an event runs behind NAT or on venue wifi. **Push** — the
fork's Action POSTing the score straight at the box — was removed in v0.6
([#377](https://github.com/OWASP/owasp-ctf-in-a-box/issues/377),
[ADR 56](decisions.md#adr-56-poll-is-the-score-transport-push-ingest-is-removed)).
How it fits together: [hosting.md](hosting.md#how-scores-reach-the-box).

**Scorer** — the one score writer in the system: an engine (`scorer/`) with
two modes — **serve** (the leaderboard API and the bearer-authed
`POST /score`) and **judge** (runs a rubric against a target inside the
fork's Action). See [scorer.md](scorer.md).

**Freeze vs scoring window** — two ways scoring stops. **Freeze** is the
manual switch: ingestion holds (queued, never lost), fork Actions keep
running. The **scoring window** (`scoringStartsAt`/`scoringEndsAt`) does the
same on a schedule. Both are evaluated at read time by three independent
readers that must agree. See [operations.md](operations.md) and
[ADR 32](decisions.md#adr-32-scheduled-windows-evaluated-at-read-time-in-three-readers).

**Vacuous pass** — a rubric check that "passes" only because the app wasn't
actually up or useful — it proves nothing and would hand out free points.
The kit's sweep (`scorer/tools/vacuous-sweep.mjs`) points every rubric at a
deliberately useless stub and fails if anything passes. See
[scorer.md](scorer.md).

**Oracle discipline** — the rule that contestant-visible scoring output is
pass/fail and points only, never which assertion failed or how. An
information-rich comment tells a contestant exactly which check to game.
See [modules.md, Section 6](modules.md#section-6-security-requirements-non-negotiable).

**srh** — `hiett/serverless-redis-http`, the Upstash-compatible REST proxy in
front of Redis. It exists so the vendored app's `@upstash/redis` client works
unchanged against local Redis, and it is the only service on both compose
networks — the app tier has no route to `redis:6379` at all.

**The two config planes** — there is no config file (#386,
[ADR 55](decisions.md#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml)).
`.env` is the **bootstrap** plane: the box's secrets plus four keys read once
at container start — `GITHUB_ORG` (the fork org), `ADMIN_LOGINS` (the
bootstrap admins allowlist), `SCORE_IMAGE` (the scorer image, and by its
non-emptiness whether Secure Development is *available* — it adds the compose
profile and seeds the default module set, while `/admin` still decides what is
live), and
`EVENT_URL`, which lives only here so one deployment recipe travels to any
hostname ([ADR 43](decisions.md#adr-43-one-url-and-it-lives-in-env-not-eventyaml)).
`ctf:admin:settings` is the **runtime** plane: everything an organizer
changes during the event, written from `/admin` and re-read on every request
— which modules are enabled (`enabledModules`,
[ADR 52](decisions.md#adr-52-modules-are-switched-at-runtime-secure-development-is-configured-at-setup)),
which Secure Development targets run (`secureDevTargets`, defaulting to all
six), the event's identity, the schedule, hints and team caps. Nothing is
baked into an image, and no toggle needs a rebuild.

The two planes divide *provisioning* from *selection*. With `SCORE_IMAGE`
non-empty, `ctf-setup.sh` forks and provisions all six targets, every time;
with it empty it skips provisioning altogether and there is nothing on GitHub
to select from. `/admin` then owns both live choices: `enabledModules`, and the
`secureDevTargets` subset of those six that contestants actually see.

## The project's names

Eight names orbit "the project"; they are not interchangeable. Only the first
is the brand — **the rest are identifiers and did not change when the project
was renamed**, which is most of the reason this table exists:

| Name | What it is |
|---|---|
| **OWASP CTF in a Box** | The product / brand, as approved by the OWASP Foundation, **and** the default event name every deployment shows until an organizer renames it. The two are deliberately the same string; real events override the event name from `/admin` → Event → Identity (a runtime setting since #386). One consequence to know: since the name is never baked, a misconfigured box does not betray itself by its name — check for an empty `ADMIN_LOGINS` and a 403 on `/admin` instead. The project was called **OWASP CTF** until September 2026; that name is retired, and the earlier `CHANGELOG.md` entries using it are history rather than current usage. |
| `owasp-ctf-in-a-box` | The **repo** (`OWASP/owasp-ctf-in-a-box`) and the docs site (`owasp.github.io/owasp-ctf-in-a-box`). |
| `ctf-in-a-box` | The slug of the project's home page on the Foundation's site, [owasp.org/projects/ctf-in-a-box](https://owasp.org/projects/ctf-in-a-box) — shorter than the repo name, and not derived from it. |
| `owasp-ctf` | The local repo directory, the lowercase image namespace, and the Fly app (`app = "owasp-ctf"` in `deploy/fly/fly.toml`). Deliberately unchanged by the rename: renaming an image namespace breaks every `SCORE_IMAGE` already sitting in someone's `.env`, and renaming a Fly app moves its `*.fly.dev` hostname. |
| `ctf-*` | The lowercase service identifiers, which are also the runtime log prefixes they are pinned to: `ctf-sync` (`sync/package.json`, and the `ctf-sync:` every poller line starts with), `ctf-score-engine` (`scorer/package.json` and `scorer/src/*.js`'s `ctf-score-engine:`), `ctf-setup`, the `ctf:` Redis key namespace and the `CTF_*` environment variables. Deliberately unchanged: these are read out of logs and `redis-cli` by whoever is debugging a live box, and the package name and the log prefix have to keep matching. |
| `OWASP-CTF` | The GitHub **org** the canonical targets are forked into (`GITHUB_ORG` in `.env`). Not the `OWASP` org the kit itself lives in. |
| `ghcr.io/owasp-ctf/score` | The scorer image path. The lowercase `owasp-ctf` here is a registry-namespace convenience, not the `OWASP-CTF` org; override `SCORE_IMAGE` to your own org's GHCR. |
| `dc34-owasp-secure-development-ctf` | The upstream repo the rubrics are vendored from (see `scorer/rubric.owasp/PROVENANCE.md`). |

One further string keeps the old brand on purpose, because it names a thing
that already exists in somebody's GitHub account — renaming the string here
would not rename that: the **GitHub App** the poller runs as, `OWASP CTF sync`
(`sync/app-manifest.json`, and the name `setup/ctf-setup.sh` tells an organizer
to type when the pre-filled manifest form opens blank). An organizer who
installed that App before September 2026 still has it under the old name, and
the manifest has to keep matching what GitHub already holds.

That rationale reaches exactly one string, and nothing else in
`setup/ctf-setup.sh` inherits it. In particular the wizard's banner — both the
ASCII art in `wiz_banner()` and the `… setup wizard` line under it — is a
**logotype**, not a name GitHub stores, so it spells the current brand and
moves whenever the brand moves. So does the OAuth App name the wizard dictates
(`OWASP CTF in a Box (<org>)`): unlike the GitHub App, a fresh OAuth App is
registered per event, so there is nothing already-named to stay compatible
with. The `setup/test/ctf_setup.bats` assertion on the wizard banner is what
keeps the two in step.

This is an OWASP Foundation project; its home page is
[owasp.org/projects/ctf-in-a-box](https://owasp.org/projects/ctf-in-a-box).
OWASP® is a registered trademark of the OWASP Foundation, and OWASP does not
endorse or recommend any product or service.
