---
title: Decisions
---

[← Docs home](index.md)

# Decisions

Numbered architecture decision records for OWASP CTF. Each entry is
Context / Decision / Consequences. For how these decisions fit together as
a running system, see [docs/architecture.md](architecture.md). For the
contract a new CTF module must satisfy, see
[docs/modules.md](modules.md). For operator-facing instructions, see
[docs/operations.md](operations.md). Superseded or amended entries say so in
their **Status** line; the record itself is never rewritten.

**Index:**

- [ADR 1 — Keep the GitHub fork/PR/Action flow — it is the pedagogy](#adr-1-keep-the-github-forkpraction-flow--it-is-the-pedagogy)
- [ADR 2 — Single docker-compose box; no Kubernetes in v1](#adr-2-single-docker-compose-box-no-kubernetes-in-v1)
- [ADR 3 — Score transport: poll by default, push optional](#adr-3-score-transport-poll-by-default-push-optional)
- [ADR 4 — SRH as the Upstash-REST proxy in front of local Redis](#adr-4-srh-as-the-upstash-rest-proxy-in-front-of-local-redis)
- [ADR 5 — Single score writer: monotonic writes, at-least-once delivery](#adr-5-single-score-writer-monotonic-writes-at-least-once-delivery)
- [ADR 6 — Poller trust model: author filter before parsing, grammar as key guard](#adr-6-poller-trust-model-author-filter-before-parsing-grammar-as-key-guard)
- [ADR 7 — Oracle discipline: pass/fail and points only, never diagnostics](#adr-7-oracle-discipline-passfail-and-points-only-never-diagnostics)
- [ADR 8 — Private scorer image and per-event mirror; access control over obfuscation](#adr-8-private-scorer-image-and-per-event-mirror-access-control-over-obfuscation)
- [ADR 9 — Per-event disposable GitHub orgs; base-repo workflow isolation](#adr-9-per-event-disposable-github-orgs-base-repo-workflow-isolation)
- [ADR 10 — `event.yaml`'s module namespace; deliberate, not dynamic, registration](#adr-10-eventyamls-module-namespace-deliberate-not-dynamic-registration)
- [ADR 11 — Vendor the contestant app into `apps/web/`; upstream stays read-only](#adr-11-vendor-the-contestant-app-into-appsweb-upstream-stays-read-only)
- [ADR 12 — Build-time config generation over runtime config](#adr-12-build-time-config-generation-over-runtime-config)
- [ADR 13 — Closed `AppId` union; config selects a subset; unknown values fail the build](#adr-13-closed-appid-union-config-selects-a-subset-unknown-values-fail-the-build)
- [ADR 14 — Neutral defaults; no DEF CON 34 in the platform](#adr-14-neutral-defaults-no-def-con-34-in-the-platform)
- [ADR 15 — Timezone-independent date display](#adr-15-timezone-independent-date-display)
- [ADR 16 — Cursor rollback on partial batch failure in the sync poller](#adr-16-cursor-rollback-on-partial-batch-failure-in-the-sync-poller)
- [ADR 17 — Public scorer engine, private rubric](#adr-17-public-scorer-engine-private-rubric)
- [ADR 18 — Exec-probe rubrics for all six targets; the rubric ships public](#adr-18-exec-probe-rubrics-for-all-six-targets-the-rubric-ships-public)
- [ADR 19 — Organizer admin panel: runtime override layer](#adr-19-organizer-admin-panel-runtime-override-layer)
- [ADR 20 — Landing-page frame is code; module content is contributed, not organizer-authored](#adr-20-landing-page-frame-is-code-module-content-is-contributed-not-organizer-authored)
- [ADR 21 — Module identity resolution makes every page dynamic](#adr-21-module-identity-resolution-makes-every-page-dynamic)
- [ADR 22 — Resolved modules are identity-only, deliberately](#adr-22-resolved-modules-are-identity-only-deliberately)
- [ADR 23 — `/how-to-play` gets its own registry field, not a reuse of `home.steps`](#adr-23-how-to-play-gets-its-own-registry-field-not-a-reuse-of-homesteps)
- [ADR 24 — Tolerating a missing module vs rejecting an unknown one](#adr-24-tolerating-a-missing-module-vs-rejecting-an-unknown-one)
- [ADR 25 — Building a leaderboard with no scoring backend](#adr-25-building-a-leaderboard-with-no-scoring-backend)
- [ADR 26 — Compose profiles follow the enabled modules](#adr-26-compose-profiles-follow-the-enabled-modules)
- [ADR 27 — Two flag hashes rather than one](#adr-27-two-flag-hashes-rather-than-one)
- [ADR 28 — A hand-rolled Markdown renderer rather than a library](#adr-28-a-hand-rolled-markdown-renderer-rather-than-a-library)
- [ADR 29 — No attempt cap on flag submission](#adr-29-no-attempt-cap-on-flag-submission)
- [ADR 30 — One shared team-dedupe fold](#adr-30-one-shared-team-dedupe-fold)
- [ADR 31 — One hint switch: capability split from policy](#adr-31-one-hint-switch-capability-split-from-policy)
- [ADR 32 — Scheduled windows, evaluated at read time in three readers](#adr-32-scheduled-windows-evaluated-at-read-time-in-three-readers)
- [ADR 33 — Classic CTF: static exact-match flags, stored recoverably](#adr-33-classic-ctf-static-exact-match-flags-stored-recoverably)
- [ADR 34 — Classic bulk import/export as a versioned, self-contained bundle](#adr-34-classic-bulk-importexport-as-a-versioned-self-contained-bundle)
- [ADR 35 — Module composition: the contract a fourth module must satisfy](#adr-35-module-composition-the-contract-a-fourth-module-must-satisfy)
- [ADR 36 — Quiz adopts classic's bundle format rather than inventing a second one](#adr-36-quiz-adopts-classics-bundle-format-rather-than-inventing-a-second-one)
- [ADR 37 — Opting in to the guarded fork-PR checkout](#adr-37-opting-in-to-the-guarded-fork-pr-checkout)
- [ADR 38 — Counting the poller's silent drops, and refusing to count the routine ones](#adr-38-counting-the-pollers-silent-drops-and-refusing-to-count-the-routine-ones)
- [ADR 39 — Enforcing HTTPS for the event URL at server start, not at build or per request](#adr-39-enforcing-https-for-the-event-url-at-server-start-not-at-build-or-per-request)
- [ADR 40 — CSRF assertion in the proxy, rate limits keyed on the login](#adr-40-csrf-assertion-in-the-proxy-rate-limits-keyed-on-the-login)
- [ADR 41 — Authenticating Redis and cutting the app tier off from it](#adr-41-authenticating-redis-and-cutting-the-app-tier-off-from-it)
- [ADR 42 — One Fly machine running the real compose file, not five Fly apps](#adr-42-one-fly-machine-running-the-real-compose-file-not-five-fly-apps)
- [ADR 43 — One URL, and it lives in `.env`, not `event.yaml`](#adr-43-one-url-and-it-lives-in-env-not-eventyaml)
- [ADR 44 — Runtime admin grants, with the baked list as the recovery path](#adr-44-runtime-admin-grants-with-the-baked-list-as-the-recovery-path)
- [ADR 45 — The team-member cap is an admin override, not a constant or a config key](#adr-45-the-team-member-cap-is-an-admin-override-not-a-constant-or-a-config-key)
- [ADR 46 — The fork's Action pulls the scoring cooldown; the box does not push it](#adr-46-the-forks-action-pulls-the-scoring-cooldown-the-box-does-not-push-it)
- [ADR 47 — A team is required to score, enforced at the route and signposted at the page](#adr-47-a-team-is-required-to-score-enforced-at-the-route-and-signposted-at-the-page)
- [ADR 48 — Per-contestant support actions, and why they refuse some things](#adr-48-per-contestant-support-actions-and-why-they-refuse-some-things)
- [ADR 49 — `firstTeamAt` records the funnel's conversion moment; `joinedAt` does not](#adr-49-firstteamat-records-the-funnels-conversion-moment-joinedat-does-not)
- [ADR 50 — Metrics are computed from stored data; forks report nothing](#adr-50-metrics-are-computed-from-stored-data-forks-report-nothing)
- [ADR 51 — Base images are digest-pinned, and dependabot is what keeps the pin honest](#adr-51-base-images-are-digest-pinned-and-dependabot-is-what-keeps-the-pin-honest)
- [ADR 52 — Modules are switched at runtime; Secure Development is configured at setup](#adr-52-modules-are-switched-at-runtime-secure-development-is-configured-at-setup)
- [ADR 53 — ai launch tokens are asymmetric; event signatures stay symmetric](#adr-53-ai-launch-tokens-are-asymmetric-event-signatures-stay-symmetric)
- [ADR 55 — Configuration v2: `.env` bootstrap, `/admin` runtime, no event.yaml](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml)
- [ADR 56 — Poll is the score transport; push ingest is removed](#adr-56-poll-is-the-score-transport-push-ingest-is-removed)

## ADR 1. Keep the GitHub fork/PR/Action flow — it is the pedagogy

**Status.** Accepted.

**Context.** The contestant loop could be simplified to "submit a diff" or
"paste a patch" through the app itself, cutting out GitHub entirely.

**Decision.** Keep the full fork → patch → PR → Action-scores-the-PR flow
(as the original README put it: "fork target app → find + patch the vuln →
PR back → GitHub Actions scores the patch"). The app never accepts code; scoring only
happens through a real GitHub Actions run against a real PR.

**Consequences.** Contestants practice the actual workflow a security
engineer uses to ship a fix (fork, branch, PR, CI feedback), not a
CTF-specific submission form. This is why `pull_request_target` isolation
(decision 9) and oracle discipline (decision 7) matter as much as they do —
the trust boundary is a real CI system, not a sandboxed judge the kit
fully controls. It also means the kit depends on GitHub Actions being
available and configured correctly per target, which is what
`setup/ctf-setup.sh org` exists to automate.

## ADR 2. Single docker-compose box; no Kubernetes in v1

**Status.** Accepted.

**Context.** A CTF event could run on a cluster for scale/HA.

**Decision.** Ship one `docker-compose.yml` (`caddy`, `app`, `scorer`,
`srh`, `redis`, `sync`) meant to run on a single box — a chapter
organizer's laptop or a small VM, not a cluster.

**Consequences.** Setup is `docker compose ... up -d`; no cluster,
ingress controller, or orchestration knowledge required (README: "one box,
one free org, no cloud bill, no telemetry"). State lives in named Docker
volumes (`caddy-data`, `redis-data`, `sync-state`), so a box reboot doesn't
lose scores. The tradeoff is no horizontal scaling or built-in HA — a
single-chapter-sized event is the target load, not a multi-thousand-person
conference CTF.

## ADR 3. Score transport: poll by default, push optional

**Status.** Superseded 2026-09-12 by [ADR 56](#adr-56-poll-is-the-score-transport-push-ingest-is-removed) — poll is *the* transport now: push ingest is removed in v0.6. Half of this entry's reasoning had already gone with [ADR 55](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml): there is no `event.yaml` and no `score_ingest` field, so `SCORE_INGEST` in `.env` is the only declaration left and the "nothing syncs the two" caveat below no longer describes anything. What survives is the poll half — the `sync` service reading score comments with a GitHub App installation token, and `caddy/Caddyfile.poll` having no `/score` route. The body below is kept as the record of the decision as it stood.

**Context.** The scoring Action needs to get a result from the event org
back to the organizer's box, which may or may not have a public URL.

**Decision.** Default to `poll` (`sync` service reads score comments from
GitHub with a GitHub App installation token — org-scoped and auto-expiring);
support `push` (the Action POSTs
directly to `${scorerUrl}/score` with a bearer token) as an opt-in via
`SCORE_INGEST=push` in `.env`.

**Consequences.** Poll mode needs nothing but outbound HTTPS — works
behind NAT, on a laptop, anywhere (`caddy/Caddyfile.poll` has no `/score`
route). Push mode needs a public URL for the box plus org Actions secrets
(`LEADERBOARD_URL`/`LEADERBOARD_TOKEN`) and gets near-instant results
instead of poll's ~30s cadence. `event.yaml`'s
`modules.secure-development.score_ingest` field only documents the
organizer's intent — the operative switch is the `SCORE_INGEST` env var in
`.env`, and nothing syncs the two
([How scores reach the box](hosting.md#how-scores-reach-the-box)). Both modes
authenticate against the
in-repo scorer's bearer-authed `POST /score`, and push mode's
`LEADERBOARD_URL`/`LEADERBOARD_TOKEN` org secrets are read by the kit's own
scoring workflow — the two upstream dependencies this entry originally
carried landed in-kit instead
([Status](operations.md#status-and-upstream-dependencies)).

## ADR 4. SRH as the Upstash-REST proxy in front of local Redis

**Status.** Accepted.

**Context.** The app's leaderboard/team/hint stores use an
`@upstash/redis`-style REST client, which expects Upstash's hosted REST
API, not a raw Redis TCP connection.

**Decision.** Run `hiett/serverless-redis-http` (`srh`) as a local
Upstash-REST-compatible proxy in front of `redis:8-alpine`, so the app's
Redis client code runs unchanged in self-hosted mode
(`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` point at `srh`
instead of a hosted endpoint).

**Consequences.** No fork of the app's data-access layer for self-hosting.
The cost is a compatibility ceiling: `srh` implements only the
POST-command-array subset of Upstash's REST API — no path-style `GET
/get/<key>` shortcut, for example (`scripts/smoke.sh` asserts the working
subset directly against `srh`). Any future Redis usage in the app must
stay within what `srh` actually supports; this is called out as an open
verification item in `docs/operations.md`'s "Status and upstream dependencies".

## ADR 5. Single score writer: monotonic writes, at-least-once delivery

**Status.** Accepted.

**Context.** Two independent paths can produce a score for the same
solve — poll's `sync` service and push mode's direct Action POST — and
network failures mean a submission might be retried.

**Decision.** Both paths write through exactly one endpoint, `POST /score`
on `scorer` (`sync/src/submit.js`; `docs/modules.md §2.1`: "there is no
second write path"). The receiving end (`scorer`) is required to treat
writes as monotonic and idempotent on replay; senders may deliver
at-least-once.

**Consequences.** `sync`'s poller leans on this directly: on a submit
failure it un-marks the comment as seen and retries next tick
(`sync/src/index.js`, `tick()`: `rs.seen = rs.seen.filter((k) => k !==
seenKey(c.id, c.updated_at));` — the seen list is keyed on comment
revision, `id@updated_at`, not bare id, since
[#131](https://github.com/dcotelo/owasp-ctf/issues/131)), which means
the same comment can be submitted more than once. That's fine because a replay of an already-applied score
is required to be a no-op on the scorer side, not a double-count. A module
implementer MUST NOT invent a second write path (`docs/modules.md §2.1`).

## ADR 6. Poller trust model: author filter before parsing, grammar as key guard

**Status.** Accepted.

**Context.** Anyone can post a PR comment. The poller must not treat an
attacker-authored comment as a legitimate score, and any value it forwards
becomes a Redis key on the scorer side.

**Decision.** Two independent checks, in order: `sync/src/github.js`
filters fetched comments to `cfg.commentAuthor` (default
`github-actions[bot]`) *before* any JSON parsing happens; then
`sync/src/parse.js` validates the `author` field inside the parsed payload
against the GitHub-login grammar
(`/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/`,
`GITHUB_LOGIN`) before returning a payload.

**Consequences.** A forged comment from an untrusted login never reaches
`JSON.parse`, regardless of what it contains — `scripts/smoke.sh` proves
this with a `mallory`-authored comment carrying a valid `ctf-score` block
that never appears on the leaderboard. The grammar check exists
independently because `author` becomes a Redis key segment downstream on
the scorer; even a comment from the trusted author must carry a
well-formed login before that string is trusted as a key. Any new
transport a module adds must reproduce both checks, not just one
(`docs/modules.md §3.2`: "trust here is entirely the GitHub-authenticated
comment author, not anything in the payload"). The filter itself is
proven today (`scripts/smoke.sh`'s forged-comment case); what it feeds —
the in-repo scorer's bearer-authed `POST /score` — is proven offline by the
same smoke run, and awaits a first real live event
([Status](operations.md#status-and-upstream-dependencies)).

## ADR 7. Oracle discipline: pass/fail and points only, never diagnostics

**Status.** Accepted.

**Context.** A scoring Action's output is visible to the contestant who
triggered it (as a PR comment) and, in push mode, is the payload sent
off-box. Verbose failure output — assertion messages, exploit payloads,
failing test names — would leak information about the rubric.

**Decision.** Contestant-visible scoring output MUST be pass/fail plus
points only (`docs/modules.md §6.2`). Verbose diagnostics stay in the
private workflow log, visible to org admins only.

**Consequences.** This is treated as the cheapest real defense of the
scorer's secrecy — cheaper and more effective than trying to keep the
image itself unreadable (see decision 8). Any new module's scoring
workflow inherits this requirement; it is not something `secure-development`
does uniquely.

## ADR 8. Private scorer image and per-event mirror; access control over obfuscation

**Status.** Accepted, premise since inverted: ADRs 17–18 made the stock rubric public, so the private image described here is now the optional private-rubric path, not the default.

**Context.** The scorer image bakes in the challenge rubric. If it leaked
publicly, contestants could read exactly what's being checked for.

**Decision.** Keep `ghcr.io/owasp-ctf/score` private upstream, and have
`setup/ctf-setup.sh org` mirror it into each event org's own private GHCR
package (`docker pull` → `docker tag` → `docker push
ghcr.io/$org/score:latest`), rather than granting every forked repo's
Actions direct read access to the upstream package.

**Consequences.** Forked repos' Actions pull the image with their own
`GITHUB_TOKEN` against the *event org's* package, never against
credentials that reach the upstream org. The organizer must keep the
mirrored package private and grant each target repo read access
explicitly (`ctf-setup.sh org`'s printed manual steps: "Keep package
`ghcr.io/$org/score` PRIVATE," "Manage Actions access → add each target
repo with Read"). This is explicitly access control, not obfuscation:
reverse-engineering a rubric out of a pulled image is assumed possible in
principle: the goal is limiting who can pull it at all, not making the
image itself unreadable — which pairs with oracle discipline (decision 7)
as the actual leak-prevention layer.

## ADR 9. Per-event disposable GitHub orgs; base-repo workflow isolation

**Status.** Accepted.

**Context.** Running a CTF against live GitHub repos means untrusted
contestant code exists as real PR branches, and something must run
Actions that need real secrets (a `GITHUB_TOKEN` to pull the private
scorer image) without ever handing those secrets to that untrusted code.

**Decision.** Each event provisions its own disposable GitHub org
(`setup/ctf-setup.sh org` forks each target into it; `teardown` archives
them afterward and prints a reminder to uninstall the GitHub App and delete
the org secrets by hand — it does not do those two itself). Scoring workflows use the `pull_request_target` trigger,
which runs in the base (org) repo's context — where secrets live — while
the untrusted PR code under test executes sandboxed, with no access to
that context.

**Consequences.** Contestant code never sees the organizer's tokens or org
secrets, regardless of what a malicious PR contains. Everything
provisioned for an event (forked repos, mirrored image, installed
workflow) lives entirely inside the disposable org, so teardown — `cmd_teardown`
archives the repos; the organizer then uninstalls the GitHub App and deletes
the org secrets, as the README's teardown step says — fully retires the event
with no lingering access (`docs/modules.md §7`: "everything a module provisions
for an event MUST be archivable or revocable after the event"). `cmd_org` now
commits the scoring workflow (`ctf-score.yml`) to each fork's `ctf` branch and
disables the forks' inherited workflows automatically.

## ADR 10. `event.yaml`'s module namespace; deliberate, not dynamic, registration

**Status.** Superseded 2026-09-11 by [ADR 55](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml) — `event.yaml` is deleted, so the module namespace this ADR governs no longer exists. What survives is the half it was really about: registration stays **deliberate and static** (the `ModuleId` registry in `apps/web/src/lib/modules.ts`, plus the duplicated target lists `scripts/check-module-registries.mjs` compares), and enablement is a runtime `/admin` setting. Previously: accepted; amended by [ADR 24](#adr-24-tolerating-a-missing-module-vs-rejecting-an-unknown-one) and [ADR 31](#adr-31-one-hint-switch-capability-split-from-policy). The body below is kept as the record of the decision as it stood.

> **Amended by [#24](#adr-24-tolerating-a-missing-module-vs-rejecting-an-unknown-one).**
> This decision describes **two** enumerations to extend for a new module. There
> are now **three**: `setup/ctf-setup.sh`'s `KNOWN_MODULES` joined them when
> provisioning learned to skip a module set with no `secure-development`. The
> reasoning below is unchanged — only the count is. See
> [#32](#adr-32-scheduled-windows-evaluated-at-read-time-in-three-readers) for the
> other place this kit duplicates a rule across independent readers on purpose.

**Context.** The kit is meant to eventually support more than one CTF
vertical (forensics, API security, cloud, …) alongside
`secure-development`, which is still the only *scored* one.

**Decision.** Platform-level config (`event`, `github`, `teams`, `hints`,
`admins`) sits at the top level of `event.yaml`
(**amended** — `hints` and `teams` are gone; both were declared here and never
read, see [#31](#adr-31-one-hint-switch-capability-split-from-policy));
everything vertical-specific
lives under a kebab-case key in `modules:` (`modules.secure-development`).
Enablement is presence — a module is on because its key is there, off because
it isn't; there is no `enabled:` flag. The config loader
(`sync/src/config.js`) and the app's generator
(`apps/web/scripts/generate-event-config.mjs`) both enumerate known module
keys explicitly and throw/fail the build on anything else — no
dynamic/plugin-style loading in v1.

**Consequences.** An organizer who writes `modules.forensics: {...}` today
gets a loud startup failure (`event.yaml: unknown module: forensics (known
modules: secure-development, quiz, classic, ai)`), not a silently ignored block.
Adding a real second module is a code change, not a config-only addition, but
the two enumerations play different roles and both must be extended:

- `apps/web/scripts/generate-event-config.mjs`'s `MODULE_VALIDATORS` — the
  ids the app will *render*, each with its own config validator. Paired with
  `apps/web/src/lib/modules.ts`'s `REGISTRY`, which supplies display name,
  description, and optional nav entry.
- `sync/src/config.js`'s `KNOWN_MODULES` — the ids the poll service will
  *tolerate* in the same file. Both services mount the same `event.yaml`, so
  an id the app accepts and `sync` rejects crash-loops the poller and silently
  freezes the leaderboard; the lists must stay in step. Tolerating an id is
  not serving it: `sync` scores exactly one module, named by the separate
  `MODULE` literal, and still requires `modules.secure-development` to exist.

`setup/ctf-setup.sh`'s `yaml_targets` needs **no** change for a new module: it
is scoped to the `secure-development:` block by construction (it is a
one-line wrapper over the ADR 24 modules reader —
`_yaml_modules targets secure-development`) and provisions that module's
forks only. A module that needs its own provisioning adds its own
step rather than widening this one. `docs/modules.md` is explicit that the
single-scored-module state is a v1 constraint, not a permanent architectural
stance.

*Amended 2026-09-11 by [#386](https://github.com/dcotelo/owasp-ctf/issues/386): `yaml_targets` no longer exists — config v2 PR 2 deleted target extraction from `ctf-setup.sh`'s reader entirely and replaced it with `all_targets()`, which forks all six `targets.tsv` targets unconditionally, regardless of `event.yaml`. Which of the six an event actually **serves** is a runtime `/admin` → Secure Development → Targets setting now (`secureDevTargets` in `ctf:admin:settings`), not a module config-block field. The two-enumeration reasoning above is otherwise unchanged.*

## ADR 11. Vendor the contestant app into `apps/web/`; upstream stays read-only

**Status.** Accepted.

**Context.** The contestant app (`OWASP-CTF/ctf-owasp-org`) previously
lived as an upstream image pulled at build/deploy time. Making it
event-generic (name, dates, enabled targets) required changes upstream
doesn't currently accept — the upstream repo is read-only for this
project.

**Decision.** Copy the app's source into `apps/web/` in this repo (see
`apps/web/VENDORED.md` for upstream commit/date/reason), build it from
local source (`apps/web/Dockerfile`, context = repo root), and drop
upstream's `.git/`, `.github/`, and `node_modules/` in the process.

**Consequences.** The kit can ship event-config and module-driven UI
without waiting on upstream write access, at the cost of a source fork
that will diverge from upstream over time. `VENDORED.md` records
provenance (exact upstream commit, date, reason) and states the intent to
offer the delta back as a single PR once upstream write access opens —
this is a deliberate, tracked fork, not an untracked copy-paste.

## ADR 12. Build-time config generation over runtime config

**Status.** Superseded 2026-09-11 by [ADR 55](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml) — nothing is generated at build time any more. The generator, the build-arg and the generated module are deleted; the last three fields this ADR still claimed (dates, the fork org and the admins allowlist) became the scoring schedule in `ctf:admin:settings`, `GITHUB_ORG` in `.env`, and `ADMIN_LOGINS` in `.env` respectively. The body below is kept as the record of the decision as it stood, including its earlier amendments.

**Context.** Event identity (name, dates, targets, branding) needs to
reach the app somehow. A runtime option (read `event.yaml` on every
request, or on server start) was available instead of baking it into the
build.

**Decision.** Generate a typed TS module
(`src/lib/event-config.generated.ts`, gitignored) from `event.yaml` (or
`EVENT_*` env vars, or neutral defaults) as a `prebuild`/`predev`/`pretest`
npm hook (`apps/web/scripts/generate-event-config.mjs`), and have the app's
static `metadata` exports and page content read the event's dates, targets,
fork org and admins allowlist from it at build time (see the 2026-09-10
amendment below for the event's identity fields, which no longer take this
path).

*Amended 2026-09-10 by [#386](https://github.com/dcotelo/owasp-ctf/issues/386): `lib/site.ts`'s `getSite()` reads the event's name, tagline, location, contact e-mail and Discord invite from `ctf:admin:settings` at request time instead, failing open to the spec defaults ("OWASP CTF" / empty) when Redis has none stored. The generated module still carries those same field names (nothing reads them there any more) and still carries dates, the enabled-target subset, the fork org and the admins allowlist, which remain build-time as this decision describes.*

*Amended 2026-09-11 by [#386](https://github.com/dcotelo/owasp-ctf/issues/386) (config v2 PR 2): the enabled-target subset is no longer part of this bake either. `generate-event-config.mjs` still emits a `targets` field, but it is always `[]` now — `secure-development.targets` is not read from `event.yaml` or any `EVENT_*` env var as an authoritative source any more. Which of the six targets an event serves is `lib/enabled-apps.ts`'s job instead: a per-request filter reading `secureDevTargets` from `ctf:admin:settings`, defaulting to all six, exactly parallel to how identity moved to `getSite()` above. Only dates, the fork org and the admins allowlist are still generated at build time.*

**Consequences.** For the fields that remain build-time — dates, targets,
fork org and admins — static generation and `metadata` exports keep working
exactly as the vendored app already used them: no runtime config-fetch code
path, no risk of a slow or failing config read blocking a page render. The
event's identity fields no longer share that property — `getSite()` is
exactly the runtime config-fetch path this decision originally avoided,
scoped to those fields only (see the amendment above). The tradeoff for
what remains baked is unchanged: changing `event.yaml` requires an image
rebuild (`docker compose --profile app build app`), not just a restart or a
config hot-reload; `docs/hosting.md` calls this out directly under
[Changing a setting after the stack is running](hosting.md#changing-a-setting-after-the-stack-is-running)
so it isn't a surprise.

## ADR 13. Closed `AppId` union; config selects a subset; unknown values fail the build

**Status.** Accepted; amended 2026-09-11 by [ADR 55](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml) — *selection* moved to runtime and the config file that used to do the selecting is gone, but **this ADR still stands**: the closed six-member `AppId` union is unchanged, it is still the type every reader and the catalogue share, and an unknown target id still fails. What changed is only where a subset is chosen — `secureDevTargets` in `ctf:admin:settings`, validated against that same union by `secure-dev-targets.ts`, rather than a build-time reader.

**Context.** The target catalogue (`juice-shop`, `dvwa`, `webgoat`,
`securityshepherd`, `vulnerableapp`, `vampi`) is fixed for
`secure-development` in v1; an organizer's `event.yaml` should only be able
to pick a subset of it, never introduce a new one by typo or intent.

**Decision.** `src/lib/apps.ts`'s `AppId` type is a closed six-member
union. `generate-event-config.mjs`'s `validateTargets` rejects any target
not in that set (and rejects an empty targets list), calling `fail()`
(non-zero exit) rather than silently dropping the bad value — mirroring
`sync/src/config.js`'s identical `TARGETS` check.

**Consequences.** A typo'd target name in `event.yaml` (e.g. `dvwaa`)
fails the app's build loudly, at the same point it would fail `sync`'s
config load — one contract, enforced twice, in the two places that read
`event.yaml`. `enabledApps` in `apps.ts` is then a simple filter: catalogue
∩ config, so nav, challenge list, and leaderboard columns for a disabled
target vanish with no per-page conditional logic.

*Amended 2026-09-11 by [#386](https://github.com/dcotelo/owasp-ctf/issues/386): `event.yaml` no longer selects the subset, and neither `generate-event-config.mjs` nor `sync/src/config.js` validates a target name against the union any more — `secure-development.targets` is accepted in any shape (absent, empty, a scalar, an unknown id) and ignored by both. The closed `AppId` union itself is untouched (still the same six ids, still the type every reader and the catalogue share); what moved is where a subset is CHOSEN — `ctf:admin:settings`'s `secureDevTargets`, validated by `apps/web/src/lib/secure-dev-targets.ts`'s `normalizeSecureDevTargets`/`checkSecureDevTargets` against that same union, not by a build-time reader. `apps.ts`'s `enabledApps` filter is gone with it: `src/lib/enabled-apps.ts`'s `getEnabledApps` does catalogue ∩ live-set instead, resolved per request (or per sync tick) from Redis rather than once at build time.*

## ADR 14. Neutral defaults; no DEF CON 34 in the platform

**Status.** Accepted.

**Context.** The vendored app's source (from `OWASP-CTF/ctf-owasp-org`)
carried event-specific branding, copy, and links from the DEF CON 34 event
it was built for.

**Decision.** A zero-config build (no `EVENT_CONFIG`, no `EVENT_*` env
vars) produces a neutral "OWASP CTF" site: `DEFAULTS` in
`generate-event-config.mjs` sets `name: "OWASP CTF"`, empty
theme/dates/location, `ctfStartsAt: null`, and all six targets enabled.
DEF CON-specific fields and copy are removed, not defaulted to empty.

**Consequences.** `scripts/acceptance-app.sh` asserts this as a regression
guard: the default build must contain neither "DEF CON" (case-insensitive)
nor leftover DC34 branding, and must show "OWASP CTF." The platform is
event-agnostic by construction — DC34 was one event that happened to be
the app's original deployment, and its specifics are not baked in as
"the" default anywhere in the generator or the catalogue.

## ADR 15. Timezone-independent date display

**Status.** Accepted.

**Context.** `event.yaml`'s `event.start`/`event.end` are ISO 8601
timestamps with an explicit offset (e.g.
`2026-10-01T09:00:00-03:00`). The app is built on whatever machine (and
whatever `TZ`) runs `docker build` — which has nothing to do with the
event's own timezone — and the displayed date range must not depend on
that build machine's local time.

**Decision.** `displayDates()` in `generate-event-config.mjs` parses the
wall-clock date textually straight out of the ISO string (`iso.slice(0,
10).split("-")`) rather than constructing a `Date` and reading local
fields, and formats month names via `Intl.DateTimeFormat` pinned to
`timeZone: "UTC"` at `Date.UTC(y, m - 1, d, 12)` (noon UTC, to stay clear
of any date-boundary rounding).

**Consequences.** The rendered date text is identical no matter what `TZ`
the build container runs under — `generate-event-config.test.ts` asserts
this explicitly with `TZ=UTC` and `TZ=Pacific/Auckland` runs producing the
same `"dates"` string for the same input. Getting this wrong would mean
the exact same `event.yaml` renders a different (and wrong, by one day in
either direction) date depending on which CI runner or organizer laptop
happened to build the image.

## ADR 16. Cursor rollback on partial batch failure in the sync poller

**Status.** Accepted.

**Context.** Each poll tick fetches a batch of comments and may need to
submit several scores to `scorer`. Some submissions in a batch can succeed
while a later one in the same batch fails (network blip, `scorer`
temporarily down); the poller's `since`/`etag` cursor determines what gets
re-fetched next tick.

**Decision.** On any submit failure within a tick, `sync/src/index.js`'s
`tick()` records the failing comment's `updated_at` as `stopAt`, then
advances the cursor's `since` to `stopAt` (not to the batch's latest
timestamp) and resets `etag` to `null` whenever any failure occurred:

```js
rs.since = stopAt ?? result.cursor.since;
rs.etag = stopAt ? null : result.cursor.etag;
```

**Consequences.** The next tick re-fetches starting from the first
failure, which means already-successfully-submitted comments earlier in
that same batch get re-fetched and re-parsed too — not just the failed
one. That's an accepted redundancy: `markSeen`'s per-repo `seen` list
(capped at 500 `id@updated_at` revision keys — `SEEN_CAP` in
`sync/src/state.js`) prevents most of that overlap from being resubmitted,
and any resubmission that does slip through relies on `scorer`'s
monotonic/idempotent write guarantee (decision 5) to be a safe no-op. The
alternative — advancing the cursor past the whole batch regardless of a
mid-batch failure — would guarantee the failed comment's score is silently
dropped. Retry semantics were chosen over cursor precision.

## ADR 17. Public scorer engine, private rubric

**Status.** Superseded by [ADR 18](#adr-18-exec-probe-rubrics-for-all-six-targets-the-rubric-ships-public) — the rubric now ships public.

**Context.** The upstream scorer image (`ghcr.io/owasp-ctf/score`) is
private with no formal access process — you have to ask the maintainers
directly, and during this kit's development it emerged that the upstream
team is not reachable on demand. That left the kit's scoring path
documented but not runnable by a self-hosted organizer. Meanwhile the
threat model doesn't actually require secrecy of scoring *logic*: the
targets are open source and their vulnerabilities/solutions are already
public (Juice Shop ships an official solutions guide) — this is an
educational CTF. What privacy buys is scoring integrity during the event:
a contestant who can read the exact probes can craft a patch that
satisfies the probe string without fixing the vulnerability
(check-gaming).

**Decision.** Split the scorer into a public engine and a private rubric.
The engine (`scorer/` — serve + judge modes, probe grammar, entrypoint)
and an instructive example rubric (`scorer/rubric.example/`) live in this
repo, public. Organizers bake their own private rubric at image-build time
(`--build-arg RUBRIC_DIR=rubric` after copying it to the gitignored
`scorer/rubric/`) and keep only the built image private during the event —
publishing the rubric afterward as teaching material is encouraged. A
self-contained consumer workflow (`scorer/consumer-workflow.example.yml`)
replaces the dependency on upstream `score-action`: it runs the mirrored
image and posts the comment itself via `github-script`. Authoring and
operation are documented in `docs/scorer.md`.

**Consequences.** The kit is fully self-sufficient — an organizer with a
rubric can run a real event with zero upstream access, scoped precisely:
the only upstream repos touched are the public target projects themselves
(`gh repo fork OWASP-CTF/<target>` — public OSS, no special access).
`setup/ctf-setup.sh org` renders the consumer workflow locally from the
in-repo template and mirrors an organizer-supplied `SCORE_IMAGE` (no
upstream image default), never reading the private upstream scorer repos.
`scripts/acceptance-scorer.sh` proves the whole loop offline. The official
OWASP rubric remains upstream-gated; this decision routes around the
access problem, it doesn't solve it. The comment marker
(`<!-- ctf-score: {...} -->`) now carries the JSON contract end-to-end
between components this repo owns on both sides (judge writes it, sync
parses it), so the contract is pinned by tests rather than by observation
of upstream behavior. The score-action output regexes (title line, `**N /
M** challenges patched`, `not-recorded` marker) are deliberately preserved
verbatim, so an upstream event could adopt this engine later without
touching its existing tooling.

## ADR 18. Exec-probe rubrics for all six targets; the rubric ships public

**Status.** Accepted.

**Context.** Decision 17 split the scorer into a public engine and a
private rubric, and shipped one instructive example (`juice-shop.yaml`,
three declarative probes). Meanwhile the kit advertised six targets:
`sync/src/config.js`'s `TARGETS` enum accepts all six and the contestant
app renders counts for all six, but enabling any target other than Juice
Shop produced `400 unknown target`.

The rubrics already existed. `OWASP-CTF/dc34-owasp-secure-development-ctf`
holds 321 authored, pass-on-patch challenges across all six targets — but
as executable `node:test` suites, not declarative probes. They need
authenticated sessions (all 40 Security Shepherd challenges, all 19 DVWA
category files), multi-request sequences, structural JSON assertions
(110 VulnerableApp challenges), and timing comparisons (VAmPI's ReDoS
challenge). None of that fits `status` / `bodyIncludes` / `bodyMissing`.

**Decision.** Promote exec-probes from documented follow-up to shipped
feature (`scorer/src/exec.js`), and vendor the upstream rubric into
`scorer/rubric.owasp/`, baked by default. The declarative grammar stays
supported and `rubric.example/juice-shop.yaml` stays as its tutorial; a
rubric directory may mix both shapes, though defining one target twice is
an error. Upstream is treated as **read-only**: `scripts/vendor-rubric.sh`
clones at a pinned SHA recorded in `PROVENANCE.md` and has no push path.

The rubric ships **public**, reversing decision 17's posture. This CTF is
educational, all six targets are open source, and their solutions are
already published. The check-gaming exposure decision 17 guarded against
is accepted as a trade-off rather than treated as a blocker.

**Consequences.** All six targets score out of the box; `event.yaml` can
name any subset.

*Amended 2026-09-11 by [#386](https://github.com/dcotelo/owasp-ctf/issues/386): `event.yaml` no longer names the subset — config v2 PR 2 made `modules.secure-development.targets` inert in every reader. Provisioning (`ctf-setup.sh org`) forks all six unconditionally, and which of the six an event actually serves is a runtime `/admin` → Secure Development → Targets setting instead, defaulting to all six. What this decision settles is unaffected: all six targets score `0 / N` unpatched, and the rubric ships public.*

Points come from `catalogue.<target>.json`'s `difficulty`
rather than a YAML `points:` field, so the price list has one source.
Challenge ids are the catalogue key lowercased — the keys are CamelCase
and all 321 fail `RUBRIC_ID`, while lowercasing collides on none.

The kit now runs untrusted-adjacent code in the judge: exec children are
`node --test` processes spawned inside the scorer container. They were
already running contestant-patched application code as a sibling
container, so this widens the existing boundary rather than crossing a
new one, but it is a real change to what the judge executes. Name it
precisely: those children inherit the scorer's mounted
`/var/run/docker.sock` and actively use it — Security Shepherd's vendored
helpers `docker exec` the MariaDB and Tomcat containers by name to
provision the shared attacker account — so a rubric test file reaches the
host daemon, not just the app under test. What holds that boundary is the
vendoring discipline rather than a sandbox: upstream is read-only,
`scripts/vendor-rubric.sh` clones a pinned SHA and has no push path, and
`PROVENANCE.md` records exactly which commit was copied.

Oracle discipline (decision 7) is unaffected — `ctf-score.md` still
carries challenge name, points, and ✅/❌ only. Test output, assertion
text, and file names never reach the contestant-visible comment.

Check-gaming is now mitigated by rubric *shape* rather than secrecy:
exec probes assert timing and response structure, which a patch cannot
satisfy without changing real behaviour the way a `bodyMissing` substring
can be.

All six targets now genuinely score `0 / N` against their unpatched
upstream image, verified by `scripts/acceptance-target.sh`: vampi 9,
vulnerableapp 110, juice-shop 38, dvwa 55, webgoat 69, securityshepherd 40
— 321 challenges, 668 points across the six.

A known scoring-fidelity gap shipped with this. Security Shepherd's vendored
`extractSolutionKey` helper accepted any 32-128 character hex run found in
the response. At least one challenge (`Challenge-10-IDOR-2`) echoes the
attacker-supplied identifier — itself pure hex — back into the page
precisely when a *correct* patch blocks the lookup, so the helper read a
"solution key" out of noise and the challenge scored as unpatched however
good the fix. The bias ran toward "not patched," so the stock-scores-zero
gate was unaffected and no contestant gained a free point; the cost was
under-crediting a correct patch. **Since fixed in the vendored copy**
(#101): the bare fallback now requires 64–128 hex and real keys match with
their surrounding context, leaving only the matcher's stated residual (an
"isn't correct"-phrased refusal still reads as a solve — same safe bias).
The vendored-read-only discipline bent for that fix and #108's vacuous-pass
work — a fact `scorer/rubric.owasp/PROVENANCE.md` should record. Current
state lives in `docs/operations.md`'s "Status and upstream dependencies";
keep the two consistent.

## ADR 19. Organizer admin panel: runtime override layer

**Status.** Accepted; the v1 read-path limitation noted below was resolved by [ADR 31](#adr-31-one-hint-switch-capability-split-from-policy), and scheduled windows arrived with [ADR 32](#adr-32-scheduled-windows-evaluated-at-read-time-in-three-readers).

**Context.** Everything up to this point is either build-time config
(`event.yaml`, decision 12) or a one-shot event of no return (a score
write). An organizer running a live event needs something in between: a
way to see the pipeline is healthy, and a way to intervene — hold
ingestion during an incident, or adjust hints — without a rebuild or a
restart, and without giving up the kit's no-cloud, single-box posture.

**Decision.** Add a small runtime-override layer living in the same Redis
the rest of the kit already uses: `ctf:admin:settings` (a hash — at this
entry's writing `paused`, `hintsEnabled`, `hintCost`, plus
`updatedBy`/`updatedAt`; later decisions grew it to the full knob set
inventoried in [architecture.md](architecture.md)'s settings table) and
`ctf:admin:audit` (a capped list of every change, written atomically with
the change via one Lua script — a setting can never land without its
audit line). Every reader applies **override-else-default** precedence:
an explicit value in `ctf:admin:settings` wins, an absent field falls
through to the default (`hint-store.ts`'s `resolveHintConfig`:
`s.hintsEnabled ?? HINT_DEFAULT_ENABLED`) — `??`, not `||`, so an explicit
`false`/`0` override is honored rather than treated as "unset." Access is
gated by `event.yaml`'s existing `admins` allowlist (case-insensitive
GitHub login match, `apps/web/src/lib/admin-auth.ts`), the same list
`event.yaml.example` already asked organizers to fill in — no new secret,
no new identity system.

The headline control, **freeze, means freeze ingestion — not stop
execution.** Pausing never touches fork Actions or GitHub: contestants'
PRs keep getting judged and commented on exactly as before. In poll mode,
`sync`'s `tick()` checks the pause flag before the fetch/parse/submit loop
(after the master-reset epoch, which must be honoured even while paused —
[ADR 48](#adr-48-per-contestant-support-actions-and-why-they-refuse-some-things)'s
rider explains why) and skips the whole
loop while paused, leaving the per-repo cursor and ETag
untouched — a queued score is deferred, never lost, and ingests normally
on the next tick after the organizer clears the flag. In push mode,
`scorer`'s `POST /score` returns `503` while paused, so a contestant's
Action retries rather than having its submission silently dropped. Both
readers fail open on a Redis error (a transient Redis blip must not freeze
a live event by accident), and `scripts/smoke.sh`'s freeze stage proves
the poll-mode path directly against Redis (the app isn't in the smoke
profile, but `sync` reads the identical key either way).

**v1 scope boundary.** Shipped: status visibility (poller heartbeat, last
error, leaderboard freshness) and flow control (freeze/unfreeze, hint
enable/cost). Deliberately deferred, each for a reason: **score
adjustments** (no manual point-editing UI — the single-writer model,
decision 5, is a load-bearing invariant, and a manual override path would
be a second writer in disguise); **player removal** (no ban/disqualify
control — the kit has no notion of a removable "player" independent of a
GitHub identity, and forging that model is a larger feature than a v1
admin panel warrants); **GitHub-workflow control** (no start/stop/rerun of
Actions from the panel — that is GitHub's surface, not this kit's, and
reaching into it would mean the panel holding GitHub credentials with
write scope beyond what anything else in the kit needs).

**Known limitation, accepted rather than fixed in v1 — since RESOLVED by
[#31](#adr-31-one-hint-switch-capability-split-from-policy), which routed the
three read paths below through `resolveHintConfig` and retired the env var
entirely. The paragraph is kept as the record of what v1 shipped: the hint
toggle was only live at the reveal boundary.** `resolveHintConfig()` (and therefore
`revealHint`, called by the `/api/hints` reveal route) resolves the
`hintsEnabled`/`hintCost` override live, so a flip takes effect on the very
next reveal attempt. But `getViewerHints`, `getHintPenalties`, and
`getHintAvailability` — which drive the challenges-page hint button, the
hint-notice banner, and the leaderboard's hint-penalty display — all still
gate on the module-level `HINTS_ENABLED` constant, resolved once from the
build-time env var. An organizer flipping hints mid-event changes whether
a hint **can be bought** instantly; it does not instantly change whether
the UI **offers** the button, or whether the read-time penalty display
reflects it. Making those three call sites live too is future work, not a
bug fix — it is out of scope for this decision because it touches
statically-rendered page output and cached leaderboard reads, not just a
single write path.

**Consequences.** The admin panel adds no new infrastructure — no new
service, no new dependency, same Redis, same `srh` proxy, same allowlist
identity source as everything else in the kit. The trade-off is the
limitation above: v1 ships a toggle whose effect is real but partial, and
that partiality must stay documented (README, this entry, and
`docs/architecture.md`'s "Organizer admin panel" section) rather than
implied to be complete.

## ADR 20. Landing-page frame is code; module content is contributed, not organizer-authored

**Status.** Accepted; amended by [#386](https://github.com/dcotelo/owasp-ctf/issues/386): the event name (and tagline, location, contact e-mail, Discord invite) is a runtime `/admin` setting now, not baked — the frame's dates/countdown, logo, and the module `home` content stay exactly as this decision describes.

**Context.** The landing page hardcoded `secure-development`'s own pitch — a
tagline, a hero paragraph, four "how it works" steps, a "please use AI"
section — as if it were the platform's own copy, the same problem decision
14 solved for event branding, but for a module's sales pitch instead of the
event's name. Composing the page from whatever modules an event actually
enables meant deciding, up front, who authors what.

**Decision.** The platform frame stays code, unconditionally: `app/page.tsx`
owns the logo, event name, dates, countdown, its own CTAs (how to
play/leaderboard/Discord), and the progress-tracking card, none of it
organizer-editable at runtime. Each enabled module instead contributes its
own landing-page content — tagline, hero paragraph, a "what to expect"
heading/lede, numbered steps, an optional CTA, an optional extra section —
through a `home` block on its registry entry (`src/lib/modules.ts`), read at
request time and rendered inside that frame. Rejected: making the platform's
own hero copy admin-editable, e.g. a rich-text or Markdown field an organizer
could set per event. That needs a real sanitisation story for
organizer-authored markup reaching every contestant's browser, in exchange
for a rebranding need that's already covered — the event name (decisions 12
and 14) handles what the event is called, and the per-module title/blurb
override (`docs/modules.md §5.1`) handles what each module is called. There
was no remaining gap to justify taking on HTML sanitisation for.

*Amended 2026-09-10 by [#386](https://github.com/dcotelo/owasp-ctf/issues/386): the event name, tagline, location, contact e-mail and Discord invite are runtime `/admin` → Event → Identity settings, not part of this build-time frame — each is validated server-side (length caps, `https://` for Discord) rather than needing HTML sanitisation, the same reasoning this decision already applied to reject a rich-text field.*

**Consequences.** An event's homepage always looks and functions like the
kit — frame, countdown, nav, CTAs — and only the module-specific pitch
changes with which modules are enabled: a quiz-only event's landing page
never mentions forking a repo or opening a PR, and a two-module event gets
two "what to expect" sections with no per-page conditional logic added for
it. Because `home` carries no organizer-editable field, there is nothing on
this page that needs HTML sanitisation, unlike the rejected alternative
would have required.

## ADR 21. Module identity resolution makes every page dynamic

**Status.** Accepted.

**Context.** An organizer's title/blurb override for a module (decision 19's
runtime-override layer, extended to module naming) has to show up in the
nav, the leaderboard, the module's own page header, its admin tab label, and
its landing-page section heading. The root layout that renders the nav had
no Request-time API of its own (no `cookies`/`headers` call), so Next
happily prerendered it at **build** time — against an Upstash that is
deliberately unreachable during the Docker build (see `apps/web/Dockerfile`)
— and baked that one-shot, fail-open fallback (registry defaults) into the
static HTML for every route that didn't otherwise opt out of prerendering.
An organizer's rename would then only ever appear on the handful of routes
that already had their own Request-time API (`/admin`, `/leaderboard`,
`/profile`, `/gate`); everywhere else the nav was silently and permanently
wrong, with no error raised anywhere to say so.

**Decision.** `getResolvedModules()` (`src/lib/resolved-modules.ts`) calls
`await connection()` before its settings read. This has no effect on the
data returned; its only job is to tell Next this function needs Request-time
information, which forces the root layout — and therefore every route under
it — to render dynamically, per request, instead of being statically
prerendered at build time. Rejected alternative: wrap the header/nav in
`<Suspense>` so the rest of the shell could stay a static, prerendered shell
around a dynamically-streamed nav. Declined because a `Suspense` fallback
has to render *something* while the real per-request read resolves, and the
only sensible fallback is the registry-default nav — so a contestant loading
the page right after a rename would see the *old* module name for a moment,
then have it swapped out from under them. That is a worse failure mode than
uniformly dynamic rendering, which never shows a wrong name at all. CI
carries a regression gate for this class of bug (`.github/workflows/ci.yml`,
after the app build): it fails if `apps/web/.next/server/app/index.html`
exists, since a unit test cannot detect a prerendering regression — only the
build output can.

**Consequences.** Every page under the root layout is dynamically rendered
per request now; there is no static shell for the nav. That is the accepted
cost of the fix: it is what makes an organizer's rename live on the very
next request everywhere, matching the override-else-default precedence the
rest of the runtime-override layer already promises (decision 19).
`getResolvedModules()` is wrapped in React's `cache()` so the settings read
is deduped within one request — the root layout's nav and a page's own
`generateMetadata`/body can all call it and only the first pays for the
Redis round trip — and it still fails open on a settings-read error,
rendering the registry-default nav rather than an empty one.

## ADR 22. Resolved modules are identity-only, deliberately

**Status.** Accepted.

**Context.** A resolved module (registry defaults merged with the
organizer's title/blurb override) is handed to both server code and Client
Components — the admin panel's tab shell, the leaderboard. Two fields on the
underlying `ModuleDef` don't survive that trip safely: `displayName` and
`description` are exactly the registry defaults that `title`/`blurb` exist to
replace, and the registry's copy blocks — `home`'s `intro`/`steps`,
`guide`'s `steps`/`example`, and `rules` itself — are **functions** — React's
flight serializer throws "Functions cannot be passed directly to Client
Components" the instant a function-valued prop crosses into one.

**Decision.** `ResolvedModule` (`src/lib/modules.ts`) is defined as
`Omit<ModuleDef, "displayName" | "description" | "home" | "guide" | "rules" |
"faq" | "terms" | "routeCard"> & { title: string; blurb: string }` — every
problem field is dropped from the object as well as the type, not merely
shadowed by its replacement. Server code that needs a module's page content
goes through separate, server-only accessors — one per dropped copy block,
`getModuleHome(id)` through `getModuleRouteCard(id)`
(`src/lib/resolved-modules.ts`) — which return the raw
copy blocks, functions included, straight off the registry, never off a
`ResolvedModule`; callers must be Server Components, calling `intro()`/
`steps()`/`example()` there and passing only the resulting plain data
downward.

**Consequences.** Reading `.displayName`/`.description` off a resolved
module — silently rendering the registry default instead of the organizer's
override — is a compile error, not a property access that quietly returns
`undefined`. And no resolved module can ever carry a function value across
the RSC boundary, so a future module defining `home` cannot accidentally 500
`/admin` or `/leaderboard` by having its copy blocks attached to the same
object those pages already pass to Client Components. The omissions are
guarded by tests (`modules-resolve.test.ts`), which assert a resolved module
has no `displayName`/`description`/`home`/`guide`/`rules` key at all, and
scan it recursively for any function value — including a compile-time
assertion on the type itself — not just that today's consumers happen not to
read them.

## ADR 23. `/how-to-play` gets its own registry field, not a reuse of `home.steps`

**Status.** Accepted.

**Context.** Decision 20 composed the landing page from each module's `home`
block. `/how-to-play` and `/rules` had the same defect and worse: ~29
references to patching, forks and pull requests, with no module awareness at
all, so a quiz-only event handed contestants a step-by-step guide to a game
it was not running. The open question was where that page's copy should come
from — reuse `ModuleHome.steps`, or give the guide its own registry field.

**Decision.** Its own field, `guide` (`ModuleGuide`), plus a `rules` field
for `/rules`. The two step lists are not the same copy at different lengths:
`home.steps` is four short cards that *pitch* the event ("Patch it and open a
PR. Fix the vulnerability in your fork…"), while the guide's six *instruct*
a contestant through their first submission, and the guide additionally
carries a loop callout, a callout above the steps, a seven-step worked
example with code blocks, "good to know" caveats and a scoring paragraph that
have no landing-page counterpart. Reusing `home.steps` would therefore have
had to either change what the landing page says or change what the guide
says. The constraint that *is* enforced is the one that matters: no string is
written twice — a given sentence lives in `home` or in `guide`, never both,
so there is exactly one place to edit it. Rejected: a single merged copy
block for both pages (it would have to grow a "which page is this for?"
discriminator on every field), and leaving the guide in the page behind
`isModuleEnabled` gates (that keeps module copy in platform code, which is
what decision 20 exists to stop).

**Consequences.** A quiz-only event's `/how-to-play` and `/rules` describe
the quiz, and a secure-development event's read exactly as they did before
the split — verified by rendering both pages before and after the change and
diffing the HTML byte for byte. The guarantee is held by suites that assert
ABSENCE against a deliberately enumerated secure-development vocabulary
(`app/(site)/__tests__/secure-dev-terms.ts`), narrowing a term rather than
dropping it when it risks a false positive — the previous round's list
checked "pull request", "fork" and "Browse targets" but not "patched", which
was the one string that had actually leaked, and dropping "target" over
`target="_blank"` left prose about targets sailing through until it came back
as a bounded pattern. The list is self-verifying: a companion test renders
the pages that ARE supposed to carry this vocabulary and fails if any term
matches nothing, so a term cannot rot into decoration while the absence
assertions keep passing. Copy stays plain data rather
than JSX (`Copy`/`CopySegment` covers the emphasis and links a sentence needs
inline), so the registry remains importable either side of the server
boundary, and the new fields are stripped from `ResolvedModule` for the
reason decision 22 gives.

## ADR 24. Tolerating a missing module vs rejecting an unknown one

**Status.** Superseded 2026-09-11 by [ADR 55](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml) — both readers this ADR is about are gone with `event.yaml`: `sync` no longer parses a module block at all (`loadConfig` reads `.env`, and the only module question left for it is whether it was started), `ctf-setup.sh` reads the same `.env` keys, and the `KNOWN_MODULES` list each carried is deleted. Module registration now lives in the app's `ModuleId` registry (`apps/web/src/lib/modules.ts`) with the duplicated target lists `scripts/check-module-registries.mjs` compares, and enablement is a runtime `/admin` setting. What survives is the distinction itself, applied one layer up: an unconfigured module is a legitimate event shape, an unrecognized module id is still refused. The body below is kept as the record of the decision as it stood.

**Context.** Two independent readers parse the same `event.yaml` for module
keys and share no code: `sync/src/config.js` (JS, the poller) and
`setup/ctf-setup.sh` (bash, provisioning) — AGENTS.md's lockstep rule
requires them to agree in behaviour anyway. Before this decision, `sync`'s
`loadConfig` treated an absent `modules.secure-development` block exactly
like an unknown module key: both threw, crash-looping the poller on a
quiz-only `event.yaml` the app itself was happy to build and run. The two
situations are not the same failure. A module this build knows about but
that isn't configured for this event is a legitimate config choice — nothing
for `sync` to poll. A module key this build has never heard of is a typo or
a vertical that was never wired into this reader — the deliberate-
registration model in [docs/modules.md §1.2](modules.md#section-1-module-identity--registration)
means a new vertical is always a code change, never config alone, so an
unrecognized key can't mean "a module I haven't heard of, ignore it."

**Decision.** Tolerate a missing `secure-development` block; keep rejecting
an unknown key, in both readers, and keep an absent `modules:` block itself
an error in both. In `sync/src/config.js`, `loadConfig` returns `null` when
`modules.secure-development` is absent — `if (!mod) return null;` — while an
unknown key or a missing `modules:` object still throws. `sync/src/index.js`'s
`main()` treats `null` as "nothing to do": it logs `ctf-sync: no polled
module enabled, nothing to do` and returns (exit 0) before touching
`loadState`/`makeRedis`/the poll loop. `setup/ctf-setup.sh` mirrors the same
split with its own `KNOWN_MODULES` list and `check_known_modules`/
`has_module`/`yaml_has_modules_block` helpers: a present `modules:` block
that simply lacks `secure-development` is fine (`cmd_org`/`cmd_render`/
`cmd_doctor` each check `has_module secure-development` and skip their
fork-based work with an informational message instead of erroring), while an
absent `modules:` block or an unrecognized key is a hard error — the same
two checks `sync/src/config.js`'s `loadConfig` makes.

`check_known_modules` is called only by `org`, `render`, `doctor` and
`upgrade` — the four commands that actually consume module keys —
deliberately not by
`teardown`, `app-manifest`, or `oauth-app`. `teardown` is the recovery path
for an event whose config may now be wrong in some way; gating it on config
validity would strand an organizer who typo'd a module name with already-
forked repos they can no longer tear down through the tool. `app-manifest`/
`oauth-app` open GitHub UI flows with no functional dependency on module keys
at all.

The compose `restart:` policy for `sync` changed from `unless-stopped` to
`on-failure` alongside this, because `unless-stopped` restarts a container
regardless of its exit code: a clean `exit 0` from the new "nothing to do"
path would have been indistinguishable from a crash and looped forever.
`on-failure` only restarts on a genuine nonzero exit.

**Consequences.** A quiz-only `event.yaml` (`modules: { quiz: {} }`, no
`secure-development` block at all) boots on `--profile app` alone (ADR 26)
and runs `sync` to a single clean exit if `--profile poll` is passed anyway,
and `ctf-setup.sh org`/`render`/`doctor`
report "nothing to provision/check" instead of failing. An organizer who
typos a module name, or omits `modules:` entirely, still gets a loud failure
in both readers — and can still run `teardown` to recover already-forked
repos regardless of what's currently wrong with `event.yaml`.
`scripts/acceptance-quiz-only.sh` is the CI gate proving the `sync` half end
to end, including that the restart-policy change holds (it samples
`RestartCount` after the exit, not just the exit code once). The two readers
still share no code — a third module key is still a by-hand addition to both
`KNOWN_MODULES` lists, same as before this decision.

**Agreement is now tested, not asserted.** "Two readers must behave the
same" broke twice on its own: first when `sync` threw on a missing module,
then when `ctf-setup.sh`'s hand-rolled reader — which only understood
2-space block indentation — returned zero keys for the flow style
(`modules: { quiz: {} }`) these very docs print, so `org`/`render`/`doctor`
exited 0 having provisioned nothing while `sync` was perfectly happy. Two
rules fell out of that. First, the bash reader FAILS CLOSED: it parses block
style at any indent, flow style, quoted keys, comments and CRLF, and it
*errors* on anything it cannot confidently parse rather than reporting "no
modules" — a silently empty result is indistinguishable from a legitimately
quiz-only event, which is what made the bug invisible. `has_module` aborts
rather than answering "absent" on a parse failure, because every caller
spells it `if ! has_module …; then <skip everything>`. Second,
`setup/test/corpus/` is a shared corpus of `event.yaml` shapes (block at 2/4/8
spaces, flow on one line and across several, quoted keys, tabs, a bare
`modules:`, an absent one, unknown keys, merge keys, sequences where mappings
belong, targets as flow *and* block sequences). Each fixture records its
verdict in its filename; `setup/test/module_readers.bats` runs the corpus
through the bash reader and `sync/test/module-readers.differential.test.js`
runs the same files through `sync`'s, so agreeing with the corpus is agreeing
with each other. The corpus immediately found one live divergence — `modules:
[]` was accepted by `sync` (`typeof [] === "object"`) and rejected by bash —
now closed with an `Array.isArray` guard. A second one turned up later, in
the dangerous direction: YAML forbids repeated mapping keys, so both JS
readers throw on `quiz: {}` twice over (or on a second top-level `modules:`
block) while the bash reader took first-wins and provisioned whatever the
first copy said — `ctf-setup.sh org` exiting 0 having forked nothing, with the
failure surfacing at app build much later. The bash reader rejects both
shapes now, with four fixtures pinning it. One asymmetry is left open
deliberately: `modules: *alias` is rejected by bash (it resolves no anchors)
and accepted by the JS readers. That points the safe way — the strict reader
is the one that fails, loudly, at provisioning time.

The third reader, `apps/web/scripts/generate-event-config.mjs`, is not in that
corpus (it runs under the app's own vitest suite, at image-build time rather
than boot time) and it is deliberately one notch stricter: a *present but
empty* `modules: {}` fails its build ("at least one module is required")
while `sync` and `ctf-setup.sh` treat it as a valid config with nothing
enabled. That asymmetry is safe in the direction it points — the strict
reader fails loudly at build time, it does not silently provision less — but
it is the known gap to close if the corpus is ever extended to all three.

*Amended 2026-09-11 by [#386](https://github.com/dcotelo/owasp-ctf/issues/386) (config v2 PR 2): the corpus WAS extended to all three, and the reader lineup changed shape on the way. `apps/web/scripts/__tests__/generate-event-config.test.ts` now runs this same corpus through the app's reader, in its own differential suite, with a `KNOWN_DIVERGENCES` set for exactly the one asymmetry this paragraph names (the empty-`modules:` case) — so "not in that corpus" is no longer true. `sync/test/module-readers.differential.test.js`, on the other hand, is GONE: it existed to pin that `sync`'s reader extracted the same `secure-development.targets` list as bash's, and once neither reader treated that key as authoritative any more there was nothing left for it to differentially assert (`sync`'s module-KEY accept/reject logic is unchanged and still agrees with the other two, just no longer proven against this corpus by name). Net effect: two test files, not three, still cover three readers.*

## ADR 25. Building a leaderboard with no scoring backend

**Status.** Accepted.

**Context.** `secure-development` disabled means there is no scorer, no
lambda, and no Upstash scoring data for this event at all — every
`LEADERBOARD_SOURCE` value names a backend that was never deployed. Before
this decision, `getLeaderboardSource` still tried to honor that env var
(falling back to the mock source on a bad value), and the board itself was
built only from rows the source supplied — a contestant with quiz points but
no scored submission had nothing to attach them to, because there was no
"attach points to a row" step that could run before a row existed. A
quiz-only event is exactly this case for every contestant, all the time: no
row for anyone, ever, on the scored path.

**Decision.** Two changes, working together. First,
`getLeaderboardSourceMode` (`src/lib/leaderboard/source.ts`) checks
`isModuleEnabled("secure-development")` *before* the env var and,
deliberately not overridably by it, resolves straight to a new `"empty"`
mode — `emptySource` (`src/lib/leaderboard/empty.ts`) returns no entries, no
teams, and every capability `false`. This is deliberately not the mock
source: placeholder data on a board that also carries real quiz points would
be indistinguishable from a contestant's actual standing. Second,
`withModuleContributions` (`src/lib/leaderboard/module-contributions.ts`)
now creates a row for any login that holds quiz points and has no entry from
the source — the board's login set becomes the union of the source's logins
and the logins holding module points, matched case-insensitively. A created
row has every scorer-supplied field (`patched`/`failed`/`total`/`apps`)
genuinely zero, because there is no scoring entry behind it to report. Team
rows get the same treatment one step later: `withTeamStandings` synthesises
membership-only rows (from live team records) when the source has no team
concept, and now calls `withTeamQuizPoints` on them so a quiz-only event's
default board — teams, whenever teams exist — doesn't open on every team
tied at zero while the individual view shows real points.

**Quiz points are ADDED, secure-development points are ATTRIBUTED, and that
verb difference is preserved everywhere in this decision.** `entry.points`
already holds `secure-development`'s score when that module is enabled (the
scorer computed it), so attributing it into a `ModuleProgress` block reports
an existing figure; adding it again would double-count. The quiz never
submits through `scorer`'s `POST /score` — the app holds no writer token for
that endpoint — so its points exist nowhere else, and must be added onto
whatever total the row already has (`0` for a created row) rather than
attributed from it. A created row therefore has nothing to double-count in
the first place: its only points are the ones just added. Team quiz totals
are deduped by *question*, not summed per member — `getTeamQuizTotalsBatch`
reads every member's answer hash directly and unions the question ids, so a
question three teammates all answered correctly still counts once, the same
rule already used for shared secure-development flags.

**Consequences.** A quiz-only event has a real, populated leaderboard from
first launch: a contestant who has answered nothing has no row (same as
today, on any event), and a contestant with quiz points has a row the moment
they earn any, with no scored submission required. `LEADERBOARD_SOURCE` is
inert while `secure-development` is disabled — pointing it at `lambda` or
`upstash` on a quiz-only event does nothing, by design, because there is no
backend there to point at. `scripts/acceptance-quiz-only.sh` proves the
individual-row half of this against a real built app and a real Redis; the
team half is covered at the unit level
(`src/lib/leaderboard/__tests__/team-standings-quiz-only.test.ts`). The
empty source's `getUser` also returns `null` unconditionally, which
`/profile` already handles as "no scored profile" for any unscored login —
so the page renders the module blocks it can build on its own rather than
gaining a second code path for "no backend at all."

## ADR 26. Compose profiles follow the enabled modules

**Status.** Superseded 2026-09-11 by [ADR 55](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml) — the profile is named `secdev` now, not `poll`, and it follows **`SCORE_IMAGE`** rather than a module list in a config file: whoever brings the stack up adds `--profile secdev` iff `SCORE_IMAGE` is non-empty, which `scripts/dev-stack` and `deploy/fly/render-compose.sh` do for you. Every conclusion below survives the rename unchanged — `scorer` carries `["secdev", "push"]` because both ingest modes need it while `sync` carries `["secdev"]` alone (push mode has the fork POST to the scorer, so there is no poller to run), no Secure Development service gets the profile-less treatment, and `app` never declares a `depends_on` on a profiled service. The body below is kept as the record of the decision as it stood.

**Context.** `docker-compose.yml` put `sync` behind `profiles: ["poll"]` but
left `scorer` in the default (profile-less) set, and `app` carried
`depends_on: [srh, scorer]`. Both of those quietly assume every event scores
PRs. On a quiz-only event they are false, and expensively so: `docker compose
--profile poll --profile app up -d` — the command docs/hosting.md called
"safe to run as-is on a quiz-only event" — resolved to `redis srh scorer app
caddy sync` and tried to pull `ghcr.io/owasp-ctf/score:latest`, the
maintainers' PRIVATE image, which a quiz-only organizer has no access to and
no reason to want. The documented boot command for the branch's headline
feature could not be run.

**Decision.** Profiles express MODULE membership. `app` (the contestant app)
is always on. `poll` and `push` — the two `SCORE_INGEST` modes — carry
everything `secure-development` needs, which is `sync` *and* the `scorer`; the
scorer is as much a part of that module as the poller is, since it exists to
judge PRs against forked targets. So `scorer` gains `profiles: ["poll",
"push"]`, and `app` loses `scorer` from its `depends_on` (it reads the scorer
lazily over HTTP per request, and `depends_on` never waited for readiness
anyway — it only ever expressed start order, at the cost of dragging the
scorer into every `up`).

The alternative was a distinct `scored` profile. Rejected: it would have
added a third flag to the primary, well-worn command in every doc, script and
deploy module, and forgetting it fails SILENTLY at runtime (an app with no
scorer behind it) rather than loudly at bring-up. Putting the scorer in the
ingest profiles instead leaves the poll-mode command byte-identical — which is
what almost every organizer runs — and confines the change to the new,
documented quiz-only path.

**Consequences.** `--profile poll --profile app` is unchanged (`redis srh
scorer app caddy sync`); push mode now needs `--profile push` where the
scorer used to arrive by default; a quiz-only event boots with `--profile app`
alone. `ctf-setup.sh wizard` prints and runs the line-up that matches the
`event.yaml` it just configured, so the organizer never picks by hand.
`scripts/dev-stack` and `scripts/smoke.sh` name their services explicitly
(and compose auto-enables a profile for an explicitly targeted service), so
both are unaffected. `scripts/acceptance-quiz-only.sh` gained the structural
assertion that catches this class of bug directly: the documented quiz-only
line-up must contain no `scorer` and no `sync`, and the scored line-up must
still contain both — a check the rest of that gate structurally could not
make, since it builds the app by hand and brings `sync` up with `--no-deps`.

## ADR 27. Two flag hashes rather than one

**Status.** Accepted.

**Context.** The classic module's admin authoring surface needs to prefill
an existing challenge's flag when an organizer opens it for editing — the
same reasoning `quiz`'s answer-key prefill already established: an edit form
that starts blank forces a retype from memory, and a mistake there silently
redefines what counts as solved for every contestant, with no diff and no
warning. Grading, meanwhile, needs a value it can compare a submission
against cheaply and exactly. A single hash can't serve both needs well.
Storing only the flag AS AUTHORED means grading has to normalize it (trim,
case-fold, Unicode-normalize) on every submission — cheap, but it also means
the *comparison* target is derived at read time, one more place the
authoring and submission recipes could quietly diverge. Storing only the
*normalized* form solves grading cleanly but throws away the organizer's
original casing/whitespace, so the edit form can only ever show a
canonicalized flag, not what was actually typed.

**Decision.** Store both, as two separate hashes keyed by challenge id:
`ctf:classic:flag` (the flag AS AUTHORED, trimmed but otherwise verbatim —
read by exactly one function, `listChallengesForAdmin`, itself reachable
only from the `requireAdmin`-gated `GET /api/admin/classic`) and
`ctf:classic:flagnorm` (`normalizeFlag(flag)` — trim, Unicode NFC-normalize,
lowercase — the ONLY value grading's Lua script ever reads or compares
against). `upsertChallenge` writes the challenge record and both flag hashes
in one Upstash pipeline call, so all three can never observably disagree —
a challenge can never be live with a `flagnorm` belonging to a previous
version of its flag. `listChallenges`, the one list function a
contestant-facing route or the leaderboard may call, issues no command
against either flag hash, and its `Challenge` return type has no field that
could carry one even by accident — the split is a type boundary, not a
habit callers have to remember.

**Consequences.** The admin edit form always shows exactly what an organizer
typed, so a typo fix is a diff against real text instead of a blind
retype-and-hope. Grading never normalizes at submission time — it reads an
already-normalized value straight off `flagnorm` and compares whole strings
with Lua's `==`, so there is nothing for the grading path to get subtly
wrong on a given submission. The cost is genuinely small: one extra hash
field per challenge, written together with the other two so there is no
window where they could disagree, and deleted together in
`deleteChallenge`. The two hashes are deliberately readable by different
functions (`listChallengesForAdmin` for `flag`, the grading script alone for
`flagnorm`) rather than merged into one record type, which is what makes
"the contestant path never touches a flag" a property the compiler can
check rather than a discipline every future call site has to maintain by
hand.

## ADR 28. A hand-rolled Markdown renderer rather than a library

**Status.** Accepted.

**Context.** A classic challenge's description is organizer-authored content
that needs a little formatting — bold, italics, inline code, lists, a code
block, an occasional link — rendered for every contestant who opens the
board. Every mainstream Markdown library (`marked`, `markdown-it`,
`remark`-to-HTML) produces an HTML *string*, which then has to be either
rendered with `dangerouslySetInnerHTML` or run through a sanitizer
(DOMPurify and similar) before it can be. Either choice makes an
organizer-authored field — admin-gated, but authored by potentially many
organizers across many events, and the one place on this platform closest
to "arbitrary rich text from a semi-trusted party" — a standing injection
surface: a sanitizer allowlist can regress with a library upgrade, and a
`dangerouslySetInnerHTML` call is one `git blame` away from being copied
somewhere it shouldn't be.

**Decision.** `apps/web/src/lib/markdown.ts` hand-parses a small, fixed
subset directly into a typed node tree — `MdBlock`/`MdInline` unions for
paragraphs, fenced code blocks, ordered/unordered lists, strong/em/inline
code/links — and never into an HTML string at any stage. Two passes:
`parseMarkdown` splits input into blocks (fenced code, lists, paragraphs,
each capped by `MARKDOWN_MAX`), and `parseInline` runs a small ordered
pattern set within a block (code wins over emphasis, so `` `**x**` ``
renders literally). Links go through `safeHref`, an explicit allowlist of
exactly three schemes (`http:`, `https:`, `mailto:`) — control characters
and whitespace are stripped from the raw target BEFORE parsing (closing
`java\nscript:`/`java\tscript:`-style browser-normalization bypasses a check
on the parsed URL alone would miss) and scheme-relative `//host` is rejected
outright, since `new URL` cannot parse it standalone and it would otherwise
inherit the page's own scheme. `components/markdown.tsx` renders the node
tree into React elements directly — `dangerouslySetInnerHTML` is never
called anywhere in this pipeline, so injected markup is structurally
impossible to render, not merely filtered out by a sanitizer that has to
keep being right.

**Consequences.** The supported subset is deliberately small: no headings,
no images, no tables, no raw HTML passthrough of any kind — a real
capability gap next to a full Markdown library, and `<` is just a character
here with no special handling anywhere in the pipeline. That gap is the
trade for the injection surface it closes: a future feature that genuinely
needs raw HTML needs a new design, not a hole poked in this one (the
module's own header comment says so in as many words). The admin panel's
live preview renders through this exact same parser/renderer pair a
contestant's board uses — never a second implementation — so what an
organizer sees while authoring is never a preview of something different
from what ships.

## ADR 29. No attempt cap on flag submission

**Status.** Accepted.

**Context.** The quiz module enforces two retry-gate knobs together: a
maximum attempt count per question and a cooldown between attempts, because
a quiz question's answer space is small and enumerable (a handful of
labelled choices) — without a cap, exhausting every combination is a
realistic brute-force path. Classic's answer space is categorically
different: a flag is an arbitrary string with no enumerable option set, so
the brute-force risk a cap defends against for quiz simply doesn't apply the
same way here. A cap would instead mostly punish a contestant legitimately
iterating on a real hunch, or retrying immediately after noticing a typo —
friction with no matching security benefit, since the normalization
(decision noted in the architecture doc) already forgives case and
whitespace variance, the two mistakes an attempt cap might otherwise seem to
guard against.

**Decision.** `evaluateGate`/`SUBMIT_SCRIPT` enforce exactly one throttle:
`classicCooldownSec`, organizer-configurable, default `5`, capped at `3600`
(`CLASSIC_COOLDOWN_SEC_MAX` in `admin-store.ts`) — `0` disables it entirely.
There is no attempt-count field anywhere in the gate; the only refusal
reasons `submitFlag` can return are paused/scheduled, already-solved,
cooldown, or an unverifiable lookup (`"unavailable"`, fail-closed) — never a
spent allowance. The cooldown is expressed in **seconds**, not minutes,
deliberately unlike every neighbouring retry-gate setting on this platform
(`quizRetryAfterMin`, `hintsUnlockAfterMin`): the job here is blunting a
scripted brute-force loop hammering the endpoint, a sub-minute-timescale
problem, not rationing a contestant's genuine tries the way quiz's cap does.
The Lua script, not the JS pre-check, is the authority: it re-reads the
cooldown against the attempts row at script-execution time, so a burst of
near-simultaneous submissions can't collectively outrun a cooldown the
pre-check alone would have let through.

**Consequences.** A contestant can retry a classic challenge as many times
as they like, gated only by how long they're willing to wait between tries
— an organizer who wants a harder anti-brute-force posture has one lever
(raise the cooldown, up to the one-hour cap) rather than two. This is judged
adequate specifically because the flag space is arbitrary text: even a slow
scripted guesser gains nothing meaningful within the cap's lifetime, unlike
quiz's small enumerable option space, where a cap is load-bearing. If a
future need arises for a genuine per-challenge attempt limit, it is a new
knob, not an extension of the cooldown — the two solve different problems
and conflating them would blur which knob to reach for.

## ADR 30. One shared team-dedupe fold

**Status.** Accepted.

**Context.** Both `quiz` and `classic` need a team's total to be the
**union** of what its members individually banked — never the sum, which
double-counts any item two teammates both hold, the same double-counting
mistake naive summation would make with a shared secure-development flag.
Both stores also happen to bank a contestant's earned items in the identical
shape: a per-login hash keyed by item id, valued `{points, at}` (`at` the
solve/answer timestamp). Before `classic` existed, this union-fold logic —
parse each member's hash reply, dedupe by item id keeping the earliest
record on a tie, sum the deduped points, track the latest timestamp for
"last activity" — lived once, inside `quiz-store.ts`, written for quiz
alone.

**Decision.** Extract the fold into `apps/web/src/lib/leaderboard/team-fold.ts`'s
`foldTeamItems`, a pure function over Upstash pipeline replies with no
dependency on either store — deliberately not `server-only`, so both
`quiz-store.ts` and `classic-store.ts` can call it and its own tests can
exercise it directly. Both stores' team-total functions
(`getTeamQuizTotalsBatch`/`getTeamClassicTotalsBatch`) call the identical
function and rename only the returned `completed` count to their own noun
(`answered` for quiz, `solved` for classic) — the SHAPE is shared, the
vocabulary is not. The dedupe key is the hash field name (question id or
challenge id); the record kept for a key more than one member holds is the
EARLIEST one, so a later re-solve by a teammate, or a since-changed item
price recorded on someone else's row, never changes what the team already
earned; `lastAt` is the LATEST timestamp in the deduped set, for the "last
activity" column.

**Consequences.** One rule, one set of tests
(`leaderboard/__tests__/team-fold.test.ts`) governs tie-breaking and
timestamp handling for every module that ever needs a team-item dedupe,
instead of two copies that could silently diverge on either. A third
capture-style module (one that banks `{points, at}` per item per login)
gets correct team dedupe for free by calling `foldTeamItems` rather than
re-deriving the rule; a module whose progress doesn't fit that shape simply
doesn't use it, the same way `secure-development`'s per-target flags don't.
The shared function's vocabulary (`completed`, `Earned`) is intentionally
generic — each caller still translates it into its own domain language
(`ClassicTotal`/`QuizTotal`) at the boundary, so nothing downstream of
either store has to know the fold is shared.

## ADR 31. One hint switch: capability split from policy

**Status.** Accepted.

**Context.** Hints had three things that looked like a switch, and none of
them worked the way an organizer would expect.

`event.yaml`'s `hints: { enabled: true }` was read by nobody — its own
comment called it a v1 placeholder. `HINTS_ENABLED` was documented in
`.env.example`, in the app README and in the hosting guide as the way to ship
an event with hints off, but `docker-compose.yml` never forwarded it to the
`app` service and the Dockerfile declared no build arg for it, so on the
composed stack the container never saw it. And `/admin`'s toggle — the one
switch that did reach the running app — governed only whether a hint could be
**bought**: `getViewerHints`, `getHintPenalties` and `getHintAvailability`
read a module-level env constant instead, so turning hints off left the hint
buttons on the challenges page and the penalty column on the leaderboard.
That last split is the limitation [#19](#adr-19-organizer-admin-panel-runtime-override-layer)
recorded and deferred.

The obvious repair — forward the env var through compose — would have made a
documented knob work while leaving three switches for one concept, and left
the split-brain untouched.

**Decision.** `/admin` is the only hint switch. `HINTS_ENABLED` is retired.

The env read splits into two things that were always distinct:

- **Capability** — `HINTS_AVAILABLE`, true when `UPSTASH_REDIS_REST_*` are
  set. Hint text lives only in Upstash, so without credentials there is
  nothing to reveal and no organizer setting can change that. Read paths test
  it first purely to skip a settings read they already know the answer to.
- **Policy** — `hintsEnabled` in `ctf:admin:settings`, falling back to
  `HINT_DEFAULT_ENABLED` (a constant in `hint-defaults.ts`, not an env var)
  when the organizer has never touched the toggle.

`resolveHintConfig()` combines them, and **every** hint read path now goes
through it, so the toggle cannot be true for one surface and false for
another. `HINT_COST` already worked exactly this way — a hardcoded default
with an admin override and no env var; hints-enabled was the odd one out.

`HINT_DEFAULT_ENABLED` lives in its own dependency-free module because
`hint-store.ts` is `server-only` and the admin toggle is a Client Component.
It has to render the same default the server resolves or it misreports the
state — which was a real bug: the toggle rendered `?? false`, showing "off"
on a fresh event while hints were live.

**Alternatives rejected.** *Forward the env var through compose* — makes a
vestigial knob work rather than asking whether it should exist, and needs a
container recreate to change something an organizer flips at event time.
*Keep the env var as a boot default under the admin override* — this was the
shipped intent (`hintsEnabled` is deliberately three-state, absent meaning
"use the env default"), but it never functioned: the override always writes
`"1"` or `"0"` and never `HDEL`s, so after one toggle there was no route back
to the default and the third state was unreachable in practice.

**Consequences.** One switch, one place to look, and the three-state encoding
collapses to a plain override with a code default — absent still means
"organizer has not chosen", now falling back to a constant rather than an
env var, so no stored data changes and no migration is needed.

The env var's only unique capability is gone: an organizer can no longer ship
an event with hints off without opening `/admin`. That window is pre-event,
with no contestants on the box, and the trade buys a switch that cannot
disagree with itself.

Anyone running the app outside compose (bare `next start`) who set
`HINTS_ENABLED=false` loses that; it never worked under the supported
deployment, so the blast radius is narrow. Turning hints off does not forgive
spend — `ctf:hints:spent` is untouched, so re-enabling restores the penalties
rather than wiping them.

**Amendment.** The decision retired `HINTS_ENABLED` but left `event.yaml`'s
`hints:` block in place, and the wizard kept writing it. That was the third
switch surviving the cull: a UI/UX pass on 2026-08-20 found an event whose
config read `hints: { enabled: false }` while `/challenges` advertised "HINTS
ARE LIVE" and `/admin` showed the toggle on. An earlier fix had changed the
emitted value from `false` to `true` so the key would at least agree with the
running app, but a key that cannot change the answer misleads whichever value
it carries.

So the key is now gone rather than merely truthful: `setup/ctf-setup.sh` no
longer emits it, and `generate-event-config.mjs` warns (never fails) when a
config still carries one, naming `/admin` as where the setting lives. This
also removes `hints` from the platform-level list in
[#10](#adr-10-eventyamls-module-namespace-deliberate-not-dynamic-registration),
which had it as top-level schema. Existing configs keep building.

`teams:` went the same way in the same change, for the same reason and with
the same mechanism. It too was declared platform-level in #10 and read by
nobody, so `teams: { enabled: false, max_size: 6 }` got team play anyway,
capped at 4. It is arguably the worse of the two: `max_size` is a *number*,
which reads even more like configuration than a boolean does. Teams are always
available; `/admin` opens and closes registration, and the cap is
`TEAM_MAX_MEMBERS` in `team-limits.ts` (an `/admin` override since
[ADR 45](#adr-45-the-team-member-cap-is-an-admin-override-not-a-constant-or-a-config-key)).

Deliberately not replaced by a build-time capability. Solo play already works
and is the default — teams are opt-in per contestant — so a `teams.enabled`
flag would only hide a UI that costs nothing to leave up, at the price of the
second switch this ADR exists to remove. Making the *cap* organizer-settable
is a real request and is tracked separately; if it lands it belongs in
`/admin` on the `HINT_COST` pattern named above — a constant default with an
override and no config key — not back in `event.yaml`.

## ADR 32. Scheduled windows, evaluated at read time in three readers

**Status.** Accepted.

**Context.** [#19](#adr-19-organizer-admin-panel-runtime-override-layer) gave
organizers a manual freeze. Manual is not enough for a real event: an
organizer should be able to say "scoring opens at the keynote and closes at
17:00" and then stop watching the clock. The same is true of the team-forming
window.

The kit has no scheduler. There is no cron on the box, no job runner, and
adding one would mean a new always-on component whose failure mode is silent —
a missed tick leaves scoring open past its end.

**Decision.** Windows are **instants stored in `ctf:admin:settings`**
(`scoringStartsAt`/`scoringEndsAt`, `registrationStartsAt`/`registrationEndsAt`,
normalised to ISO-UTC on write) and **evaluated at read time**, by whoever is
about to act:

```
effectivePaused(s)          = s.paused || outsideWindow(now, scoringStartsAt, scoringEndsAt)
effectiveRegistrationOpen(s)= s.teamRegistrationOpen && !outsideWindow(now, registrationStartsAt, registrationEndsAt)
```

Read-time evaluation means there is nothing to miss. A window that has closed
is closed on the next request, whether or not anything ran at the boundary,
and a box that was powered off over the window boundary behaves correctly the
moment it comes back.

The manual flag and the schedule are **ORed** for the freeze and **ANDed** for
registration, which reads oddly until you say it aloud: the freeze is "stop
if I said so *or* if we are outside the window", registration is "open only if
I said so *and* we are inside the window". Both are the conservative reading
of the organizer's two inputs.

**Three readers, and they must change together.** `outsideWindow` is
implemented independently in `apps/web/src/lib/schedule-window.ts`
(re-exported through `admin-store.ts`),
`scorer/src/store.js` and `sync/src/redis.js` — three languages-worth of
runtime with no shared package between them — plus `team-store.ts` for the
registration half. Each carries a comment saying so.

Duplication was chosen over a shared package because the alternative is worse
here: the scorer and sync are standalone Node services with their own
`package.json`, so sharing would mean publishing a package or vendoring a
build step into two services that currently have neither, to share about
fifteen lines of date comparison. The cost is a real lockstep obligation,
which is why it is written down in `AGENTS.md` as well as in each file.

**Freeze reads fail OPEN.** If Redis is unreachable, `scorer/src/store.js` and
`sync/src/redis.js` both return "not paused" rather than "paused". A Redis
blip during an event must not silently discard real submissions; the failure
mode of guessing wrong in the other direction is contestants losing work they
have already done. This is deliberately the opposite of the hint gate and the
quiz attempt lookup, which fail CLOSED — those guard a spend, and the safe
answer when you cannot tell is to refuse.

**Consequences.** Enforcement lands on writes rather than on a timer, so a
"closed" window still lets contestants browse — it stops scoring, not reading,
which matches what the freeze already did.

Nothing reconciles the three implementations automatically. A change to one
that misses the others produces an event where the app believes scoring is
closed while the poller keeps ingesting, and the only signal is behavioural.
The corpus tests that pin the `modules:` readers have no equivalent here.

## ADR 33. Classic CTF: static exact-match flags, stored recoverably

**Status.** Accepted.

**Context.** The `classic` module is the jeopardy format: a board of
organizer-authored challenges, each hiding a string, graded the instant a
contestant submits it. That is a different scoring shape from both existing
modules — `secure-development` judges a patch through a rubric,
`quiz` compares against an enumerable answer set.

**Decision — the solve mechanic is a static, exact-match string.** No
per-contestant flags, no regex, no scripted validators. Static means an
organizer can write a challenge without writing code, and a flag can be
verified by eye; exact-match means grading is a comparison rather than an
evaluation, so there is nothing to sandbox and no way for authored content to
become executable.

**Matching is normalised on both sides** (`normalizeFlag`: trim, NFC, then
lowercase). Copy-paste from a terminal picks up trailing whitespace,
Unicode-normalisation differences are invisible on screen, and case is not the
skill being tested. A contestant who found the flag should not lose it to any
of those.

*Amended (issue #193):* the lowercasing — and ONLY the lowercasing — is now a
per-challenge choice. It stays off by default, because the reasoning above is
still right for almost every flag. But it made a whole class of answer
inexpressible: a recovered password, a base64 string, a case-sensitive hash,
anything where `AbC` and `abc` are different facts. Such a challenge could be
authored, and the board would then accept the wrong-cased answer as correct.

Trim and NFC apply in both modes and are not negotiable: a trailing space a
contestant cannot see is not a wrong answer, and two spellings that render
identically must still compare equal. Neither of those is what
"case-sensitive" is asking for.

The mode is stored on the PUBLIC challenge record and shown on the card, which
is the part that makes it fair — a contestant who submits the right characters
and is told "Not quite" would otherwise have no way to work out why, and
knowing that case matters gives away nothing about the answer. It also keeps
Lua out of the decision: both comparison forms are computed in JS and passed
in, and the script only chooses between them, so `string.lower`'s ASCII-only
behaviour still never touches a flag.

**Flags are stored recoverably, in plaintext, not as a digest.** This is the
decision most likely to look wrong at a glance, so the reasoning matters. A
digest would let the organizer verify a submission without holding the
original — but the organizer *authored* the flag, and needs to keep reading it
back: to check it against the challenge text, to fix a typo, to export a board
and reuse it next term, and to answer "is this contestant's near-miss actually
correct?" A hash makes all of that impossible while defending against an
attacker who, by construction, already has admin access to the box.

The real exposure is a *contestant* reading flags, and that is handled by the
read boundary rather than by the storage format: `listChallenges` issues a
single `HGETALL` against the public hash and never touches the flag hash at
all, while `listChallengesForAdmin` reads both behind `requireAdmin`. That
split, and the second normalised hash it needs, is
[#27](#adr-27-two-flag-hashes-rather-than-one).

**Categories and per-challenge points are first-class**, stored as their own
ordered list (`ctf:classic:categories`) rather than derived from the
challenges. An organizer sets board layout before authoring content, and an
empty category must be able to exist while its challenges are being written.

**Points are capped** (`CLASSIC_POINTS_MAX`), and the cap's real reason is not
game balance: the challenge record is serialised with `JSON.stringify`, at
`>= 1e21` JavaScript emits exponential form (`1e+21`), and `SUBMIT_SCRIPT`'s
anchored Lua pattern `'"points":(%-?%d+)[,}]'` cannot read that. Without a cap
an organizer could author a challenge that silently fails to grade. The cap is
far below the breaking point, so the constraint never surfaces — but it is the
constraint, and it lives in a source comment where a future refactor of the
Lua would not think to look.

**Consequences.** An organizer can put a flag in a screenshot, an email or a
slide and it still matches. Flags are as secret as `/admin` is — the export
bundle is the complete answer key in one file, which `docs/operations.md`
states outright.

The Lua-pattern coupling means the points cap and `SUBMIT_SCRIPT` are a pair:
changing how the record is serialised, or how the script parses it, invalidates
the other.

## ADR 34. Classic bulk import/export as a versioned, self-contained bundle

**Status.** Accepted.

**Context.** [#33](#adr-33-classic-ctf-static-exact-match-flags-stored-recoverably)
gives organizers a board to author one challenge at a time. A real board is
twenty to forty challenges, often carried between terms or drafted offline by
someone who is not the person running the box.

**Decision.** The whole board round-trips as one JSON bundle — `version`,
`categories`, `challenges` — imported by paste or upload and exported from the
admin page.

**Import is upsert-by-id and never deletes.** A challenge already on the board
but absent from the file is left alone. A truncated or mistyped file therefore
cannot destroy authored work mid-event, which is the failure that actually
matters: the organizer is usually importing *during* setup, with contestants
already registered. The cost, stated in the panel and the docs, is that you
cannot prune a board by importing a shorter file — deletion stays an explicit
per-challenge action.

**Ids round-trip**, which is what makes an export a usable backup: re-importing
updates the same challenges rather than duplicating them, and because solves
reference ids, existing contestant progress stays attached.

**Categories are unioned, never replaced.** Replacing would silently drop or
reorder categories belonging to challenges the imported file never mentioned —
breaking part of a board the organizer was not editing.

**The parser is deliberately client-safe** (`classic-io.ts` imports nothing
server-only, no Redis), so the admin page can validate before submitting and
show every error at once. That creates an obligation the file states in its own
header: it must mirror `upsertChallenge`'s rules field for field, or the two
authoring paths disagree about what is valid. The asymmetry that is safe is
import being *stricter* — it can only refuse a challenge the form would have
taken, never admit one the form would reject.

**The server re-parses the raw text** rather than trusting a client-parsed
object, so a client bug cannot write something the single-challenge form would
have rejected. The payload carries text, not a bundle.

**Bundles are versioned** (`CLASSIC_BUNDLE_VERSION`), and a mismatch is a hard
refusal rather than a best-effort read. A board is a term's work; silently
misreading an old export is worse than refusing it.

**Consequences.** Two bundle builders exist — one server-side, one in the admin
page, which already holds the data and would otherwise re-fetch it. They can
only drift through an *optional* added field; a new required field breaks both
at compile time.

Version 1 has no migration path yet. The first bump has to add one, and the
refusal above is what makes that safe to defer.

## ADR 35. Module composition: the contract a fourth module must satisfy

**Status.** Accepted.

**Context.** [#25](#adr-25-building-a-leaderboard-with-no-scoring-backend)
introduced created rows and the ADDED-vs-ATTRIBUTED distinction, as a
consequence of making a quiz-only board work at all.
`classic` then needed the identical treatment, and the next module will too.
What was missing was the *general* rule, stated once, in a place a module
author reads before writing code.

**Decision.** `withModuleContributions` is the single composition point, and
every module joins the board through it under three rules.

**Points are ADDED or ATTRIBUTED, never both, and the choice follows where
grading happens.** `secure-development` is graded outside the app, so its
points already sit inside the row the scorer produced — they are *attributed*
to the module for display. `quiz` and `classic` are graded in the app, so the
scorer has never seen them — they are *added* on top. The two verbs are not
interchangeable in either direction: attributing an app-side module shows zero,
adding `secure-development`'s double counts. Both failures are silent, and both
look like a scoring dispute rather than a bug.

**The board's population is a union, not the source's list.** A contestant who
has only answered quiz questions exists in no scorer row, so the entry set is
the union of source logins and module-point holders, matched
case-insensitively because GitHub logins are while stored fields keep whatever
casing the PR author used. A module that scores app-side *creates* leaderboard
rows; it does not merely annotate them.

**Progress detail is a closed union with a compile-time exhaustiveness check.**
Each module contributes a `detail` variant, and `module-detail.tsx` closes the
switch with an assignment to `never`. A fourth module that adds a variant
without a render branch fails the build rather than rendering nothing — a
deliberately loud failure, because a missing branch is invisible in a passing
test suite and shows up as an empty expander at the event.

**Consequences.** A new module touches more than its own files, and the set is
knowable: the registry, the three `event.yaml` readers
([#10](#adr-10-eventyamls-module-namespace-deliberate-not-dynamic-registration), plus the third that
[#24](#adr-24-tolerating-a-missing-module-vs-rejecting-an-unknown-one) added), the
proxy's route matcher, the contribution overlay, and the detail renderer.
`docs/modules.md` §9 is the checklist; this ADR is why the checklist has the
entries it does.

The exhaustiveness check is the only one of the three rules enforced by the
compiler. Picking the wrong verb, or forgetting the union, both typecheck
cleanly — they are caught by tests that assert a module-only contestant appears
on the board at all, which is why those tests exist and why they assert on a
named login rather than on a row count.

## ADR 36. Quiz adopts classic's bundle format rather than inventing a second one

**Status.** Accepted.

**Context.** [#34](#adr-34-classic-bulk-importexport-as-a-versioned-self-contained-bundle)
gave classic a bulk path. Quiz — the older module — never got one, so seeding a
50-question bank meant 50 round trips through a form while an equivalent flag
board pasted in as one file. That asymmetry existed for no reason beyond
arrival order.

**Decision.** Quiz gets the identical shape, deliberately: a versioned,
self-contained JSON bundle, imported by paste or upload and exported from the
Quiz tab; `quiz-io.ts` mirrors `classic-io.ts` structurally, and every rule ADR
34 settled carries over unchanged — upsert-by-id and never delete, ids
round-trip so an export is a usable backup, a client-safe parser that must
mirror the single-question form field for field, the server re-parsing raw text
rather than trusting a client-parsed object, and a hard refusal on a version
mismatch.

Copying the format was the point. An organizer running both modules should
learn one file shape and one set of guarantees, and a reviewer comparing the
two validators should be able to read them side by side. The alternative — a
quiz-shaped format justified by quiz's own field list — would have bought
nothing and cost a second thing to keep honest.

**Two rules are quiz-specific**, because the quiz's content differs from
classic's in exactly two ways:

- **No categories.** The quiz has no such concept, so there is no union rule
  and no category-membership check, and `QuizImportSummary` carries only
  `created`/`updated`.
- **Duplicate choice ids within one question are rejected.** This has no
  single-question equivalent, and does not need one: the admin form *generates*
  choice ids and so cannot produce a collision. Only a hand-written file can.
  Two choices sharing an id make the radio group ambiguous and leave `correct`
  unable to name one of them — an unanswerable question that nothing
  downstream reports. This is the same class of bundle-only rule as classic's
  duplicate-category rejection: stricter than the form, which is the safe
  direction (see ADR 34).

**The retry-gate settings are NOT in the bundle.** `quizMaxAttempts` and
`quizRetryAfterMin` are event policy, not content; they are live-editable in
`/admin` and shared by every question. Folding them in would mean importing a
question set mid-event could silently re-open or shut a retry gate an organizer
had already tuned, with no undo and no visible cause. Classic excludes
`classicCooldownSec` on the same argument, so this is the format's rule rather
than a quiz exception. The admin panel states it beside the import control, so
an organizer is not left to infer it.

**Consequences.** `QUIZ_POINTS_MAX` moved from `quiz-store.ts` (`server-only`)
to `quiz-keys.ts`, re-exported so every existing import still resolves to the
same value — the browser-side validator has to check a pasted bundle against
the very bound the store enforces. `QUIZ_ID_RE` moved for that same reason
earlier; `classic-keys.ts` already holds `CLASSIC_POINTS_MAX` for it.

The same two-builders caveat ADR 34 records applies here: one bundle builder
server-side (`exportBundle`), one in the admin page (`exportBundleFrom`, which
already holds the data). They can only drift through an *optional* added
field — a new required field breaks both at compile time.

## ADR 37. Opting in to the guarded fork-PR checkout

**Status.** Accepted.

**Context.** `actions/checkout` began refusing to check out a fork's pull
request from a `pull_request_target` workflow:

> Refusing to check out fork pull request code from a 'pull_request_target'
> workflow. […] To opt in, review the risks […] and set
> 'allow-unsafe-pr-checkout: true'.

That is step 3 of `ctf-score.yml`, so **every scoring run on every deployment
of this kit failed at it** — before the scorer image was even pulled. Both
targets exercised on the test org (DVWA, WebGoat) failed identically and in
seconds. The guard arrived through the floating `@v4` tag, so it reached
already-provisioned events with no change on their side.

**Decision.** Set `allow-unsafe-pr-checkout: true`, and bump the workflow
version stamp so the
[workflow upgrade path](hosting.md#upgrading-the-scoring-workflow) carries it
to live forks.

The flag's name describes the class of risk, not this workflow's posture. The
danger `pull_request_target` creates is *executing* a fork's code in a job
holding the base repo's token and secrets. This job does not. Every `run:`
step in it is `docker login`, `docker pull`, `docker network create`, or
`docker run`: the checkout is a build **context**, mounted into the scorer
container, and the contestant's app is built and booted inside that container
on an internal network. No install script, build script, or test runner from
the PR executes on the runner host, and `persist-credentials: false` keeps the
job's token out of the checked-out tree.

**What the flag does not change.** The scorer container holds `docker.sock` so
it can boot the app as a sibling, and it necessarily BUILDS contestant-supplied
source. That trust boundary is inherent to judging submitted code, is recorded
in the architecture doc's security model, and predates this flag by the whole
life of the project. This restores behaviour the kit already had; it grants
nothing new. The honest summary is that the guard asked a question the kit had
already answered in its own workflow header.

**The alternative was not "be safer", it was "do not score".** Dropping
`pull_request_target` for `pull_request` gives the job a read-only token that
cannot post the score comment — the comment IS the score in poll mode (the
poller ingests it), so the module stops working. Scoring from a
`workflow_run` trigger keeps the comment but adds a second workflow and a
race, for a trust boundary identical to the one above.

**Consequences.** This is the first real exercise of the versioned-workflow
upgrade path, and it is exactly the case that path was built for: a security-
relevant change to a file that lives in forks. Events provisioned before it
report `❌ v1 — stale` in `doctor` and take it with
`./setup/ctf-setup.sh upgrade`. An event that never upgrades scores nothing at
all, which is at least loud.

Pinning `actions/checkout` by SHA would have prevented the surprise and is
worth doing ([#49](https://github.com/dcotelo/owasp-ctf/issues/49) covers
digest-pinning first-party images); it would also have meant not receiving the
guard, so it trades a loud break for a silent divergence from upstream's
current advice.

## ADR 38. Counting the poller's silent drops, and refusing to count the routine ones

**Status.** Accepted.

**Context.** Two scoring bugs were found in one evening by running a single
real PR end to end — the upserted-comment dedupe collision (ADR-adjacent, see
[#130](https://github.com/dcotelo/owasp-ctf/issues/130)/#131) and the
`pull_request_target` checkout guard (ADR 37). They had **nothing in common
technically and everything in common operationally**: the poller consumed a
comment, submitted no score, and wrote nothing down. In `tick()`'s ingest
loop, both silent paths were a bare `continue` sitting above every logged
branch:

```js
if (!markSeen(rs, c.id, c.updated_at)) continue;
const payload = parseScoreComment(c.body, cfg);
if (!payload) continue;
```

Neither bug was findable by tailing the poller. The only visible symptom was a
contestant's PR showing a correct score that the leaderboard did not have —
and only if somebody happened to compare the two.

**Decision.** Every path that consumes a comment and submits nothing now
increments a named per-repo counter, and the two that represent real loss also
increment a cumulative `dropped` in the poller's state, write a `lastDrop`
description, and surface on `/admin` beside `Ingested`.

The taxonomy is the whole decision:

| Bucket | Meaning | Counted as a drop? |
|---|---|---|
| `duplicate` | Revision already handled — `since` is inclusive, so the boundary comment is re-read on most ticks | No |
| `noMarker` | Bot comment with no `ctf-score:` marker — the workflow's own placeholder, other Actions' comments | No |
| `invalid` | Marker **present** and unusable — schema drift, truncation, forgery | **Yes** |
| `rejected` | Scorer returned `4xx`; the comment stays marked seen, so it is never retried | **Yes** |
| `retried` | Submission failed transiently and was un-marked; next tick re-presents it | No — logged, not lost |

**Splitting `invalid` from `noMarker` required a parser change.**
`parseScoreComment` returned `null` for both "ordinary comment" and "claims to
carry a score, and the claim is unreadable", which made a drift between the
workflow's marker format and the poller's grammar look exactly like silence.
`hasScoreMarker()` separates them.

**The refusal to count the routine buckets is load-bearing, not a
simplification.** Duplicates and placeholders occur constantly on a perfectly
healthy event. Folding them into `dropped` would make the figure permanently
nonzero, and a warning that is always lit is one organizers stop reading —
which reproduces the exact failure this counter exists to prevent, while
looking like a fix. The same reasoning governs the log: a per-repo summary
line prints only when something non-routine happened, so a quiet poller stays
quiet and any line it does print means something.

**`dropped`/`lastDrop` are sticky; `lastError` is not.** `lastError` describes
the tick that wrote it and is `HDEL`ed by the next clean tick. A dropped score
is still missing after the poller recovers, so clearing it on recovery would
erase the only pointer to the PR a human has to go re-run.

**Consequences.** The counter's value is in staying at zero. It cannot catch a
*novel* silent path — a future `continue` added without a bucket is invisible
again — so the buckets, not the number, are the thing to maintain: any new
early exit in the ingest loop gets one. Events upgrading from an older poller
read a status hash with no drop fields, which decodes as `0`/`null` rather
than `NaN` (pinned by a test in `admin-store.test.ts`).

## ADR 39. Enforcing HTTPS for the event URL at server start, not at build or per request

**Status.** Accepted.

**Context.** better-auth derives the session cookie's `Secure` flag from the
scheme of its `baseURL`, which docker-compose sets from `EVENT_URL`. The
shipped default is `http://localhost` — correct for a local trial. An
organizer who edits the host and not the scheme (`http://ctf.example.org`)
gets an event that starts normally, signs in normally, and sends every session
cookie in cleartext over the venue's wifi. This app configures no `database`,
so there is no server-side session store: the cookie **is** the identity
(ADR 20). Sniffing an organizer's cookie is therefore admin takeover, not a
nuisance, and the mistake has no visible symptom.

**Decision.** A pure `checkEventUrl()` (`apps/web/src/lib/secure-url.ts`)
classifies the configured URL, and Next's `register()` startup hook
(`src/instrumentation.ts`) acts on the verdict: `https://` and every loopback
spelling pass; `http://` to a real host in production throws; everything else
warns.

**Why the startup hook specifically.** The two obvious homes are both wrong:

- **At import in `lib/auth.ts`** — this also runs during `next build`, which
  sets `NODE_ENV=production`. A deployment warning would become a build
  failure on a machine that has no event config at all, and CI builds with
  dummy values. Verified: with the check in the startup hook, `pnpm build`
  with `BETTER_AUTH_URL=http://a-real-domain.example` completes normally.
- **Per request** — too late. By the first request the cookie policy is
  already settled, and the operator learns from a log line buried under
  traffic instead of a server that would not come up.

**"Refusing to serve", not "refusing to start".** Next 16.3 catches a throw
from the instrumentation hook, prints `Failed to prepare server`, and keeps
the process alive answering `500` to everything — it even logs `✓ Ready`
first. Nothing is served either way, but the message says what the operator
will actually see, because `docker compose ps` will show the container `Up`.

**The escape hatch is deliberately narrow.** `ALLOW_INSECURE_EVENT_URL=1`
downgrades the refusal to a warning that states sessions are sniffable by
design. It exists for a genuinely TLS-less deployment — a closed lab, an
isolated classroom network. It is explicitly **not** the answer for TLS
terminated upstream: there the public URL is still `https://`, so `EVENT_URL`
should say `https://` and the check passes unaided. Offering the hatch for
that case would train organizers to set it in exactly the situation where they
do not need it.

**Consequences.** A malformed or unexpected-scheme URL warns rather than
fails: a config typo is not a security decision the guard can reason about,
and failing shut on it would take an event down for the wrong reason. The
check cannot see past its own process — an organizer who fronts the box with a
plain-HTTP proxy while `EVENT_URL` says `https://` still ships sniffable
cookies, and nothing in the app can detect that. That case belongs to the
organizer hardening checklist ([#44](https://github.com/dcotelo/owasp-ctf/issues/44)).

## ADR 40. CSRF assertion in the proxy, rate limits keyed on the login

**Status.** Accepted.

**Context.** The custom API routes (`/api/admin/*`, `/api/team/*`,
`/api/hints/reveal`, `/api/quiz/answer`, `/api/classic/submit`) authenticate
from the session cookie and had no **explicit** CSRF defence. They were not
exploitable: better-auth's cookie is `SameSite=Lax`, which blocks the
cross-site POST the attack needs. The problem is that the protection was a
dependency's default — one version bump or one config edit away from changing
without anything in this repo mentioning it. Separately, only `/api/gate` and
better-auth's own endpoints were rate-limited, leaving join-code guessing and
hint hammering unbounded.

**Decision, part 1: assert the origin in `proxy.ts`, not in each handler.**
A mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) to `/api/*` whose `Origin`
header is present and does not match `BETTER_AUTH_URL`'s origin gets a `403`.

Per-handler checks were the obvious alternative and are worse in the way that
matters: there were eighteen route files when this was decided (thirty-eight
under `apps/web/src/app/api` at the time of writing), and the failure mode is
the next one forgetting. The proxy runs on `/api/:path*`, so a new route is
covered by existing. The cost is that `config.matcher` must carry a path
pattern alongside the literal module routes, which `proxy.test.ts` had to
learn about explicitly — deliberately, rather than relaxing that test into one
that permits anything.

Two allow-cases are deliberate:

- **No `Origin` header → allow.** Browsers attach `Origin` to every
  credentialed cross-origin request, so its absence means a non-browser
  client, which has no ambient cookie to ride. Refusing would break curl and
  health checks while adding nothing.
- **No configured URL → allow.** With `BETTER_AUTH_URL` unset there is nothing
  to compare against. Deriving the expectation from the request's own `Host`
  would let an attacker satisfy the check by setting it — a gap that is honest
  beats one that looks like enforcement.

`/api/auth/*` is excluded. better-auth runs its own origin policy against its
own `trustedOrigins`, and the OAuth flow involves requests this proxy has no
business adjudicating.

*Amended with ADR 53 (the ai module):* `/api/ai/*` is excluded as well
(`AI_PREFIX` in `src/proxy.ts`). Those routes are called cross-origin by
design — by the external challenge site and by a static token verifier — and
none relies on an ambient cookie: `submit` and `state` authenticate with a
signed launch token, `event` with that token plus an HMAC event signature,
and `launch-key` is intentionally public. So the ambient-credential attack
this assertion exists to stop does not apply to them. Two carve-outs, each with its own reason; a third
needs its own.

**Decision, part 2: rate-limit on the LOGIN, not the IP.** `gate-store.ts`'s
throttle is keyed on the client IP its route (`app/api/gate/route.ts`)
extracts, because the pre-event gate runs before anyone has an identity — and
that route's comment documents that the key is spoofable, since Caddy
*appends* to `x-forwarded-for` rather than replacing it. These two
routes run after `auth.api.getSession()`, so there is a session-backed login
to key on that a caller cannot forge without forging the session itself. Fixed
window (one `INCR` + one `EXPIRE` in a single Lua `EVAL`); the up-to-2×-across-
a-boundary edge is irrelevant at these budgets.

**They fail OPEN, and the gate throttle fails CLOSED.** Not an inconsistency:
`consumeGateAttempt` guards a password compare, where an unmetered guess
defeats the control entirely. These bound abuse of routes that have their own
correctness gates underneath — `joinTeam` validates the code, `revealHint`
charges atomically and idempotently — so a Redis blip must not stop
contestants playing. Same fail-open reasoning as the freeze reads.

**Verification.** The origin refusal was checked against a real built server,
because unit tests cannot establish that Next actually runs the proxy on API
routes in this version: cross-origin `POST /api/team/join` → `403`;
same-origin and no-`Origin` → `401` (i.e. reached the handler's own auth
check); cross-origin `GET` → untouched; a cross-origin `POST` to
`/api/auth/sign-in/social` → answered by better-auth, not by us. The Lua
window script was run against the stack's own Redis, including the case a
JS fake cannot establish: forcing the TTL to 10s mid-window and confirming two
further requests leave it at 10, proving `EXPIRE` is not re-applied per
request (which would make the window never end).

**Consequences.** The origin check cannot help a browser that sends no
`Origin` on a credentialed request — none do today, and if that changed the
`SameSite` cookie is still underneath. The rate limits bound one login, not
one human: a contestant with two accounts gets two budgets, which is
acceptable for what these protect.

## ADR 41. Authenticating Redis and cutting the app tier off from it

**Status.** Accepted.

**Context.** `redis` ran with no `requirepass` on a single flat compose
network. Every service on that network could reach `redis:6379` directly —
including the internet-facing Next.js `app`, which is the one container that
processes untrusted input. An SSRF or RCE there could read or rewrite scores,
teams and `ctf:admin:settings` (clearing the freeze, say) while completely
bypassing the SRH bearer token that is supposed to be the only way in.

This was not a v0.1.0 blocker — no untrusted workload runs on the box network,
since targets are judged in ephemeral GitHub Actions runners — which is why it
was deferred rather than shipped earlier.

**Decision: do both halves, because they fail differently.**

1. **`requirepass`**, with `SRH_CONNECTION_STRING` carrying the credential.
   Protects against anything that reaches the port — including a future
   service added to the backend network without thinking.
2. **Two networks**, `frontend` and `backend`, with **`srh` the only service
   on both**. Protects even if the password leaks, and it is the half that
   actually addresses the stated threat: `app` cannot reach Redis at all.
   `backend` is `internal`, so it has no egress either.

**Compose fails closed on a missing password.** `${REDIS_PASSWORD:?...}`
rather than a default value or `:-`. An empty `--requirepass ""` is treated by
`redis-server` as *no password*, so the natural-looking fallback is exactly
the silent degradation this ADR exists to remove — a control that reads as
present and is off. A shipped default would be worse still: it looks secure
and is public. The cost is that an event provisioned before this change fails
its next `docker compose up` with a message naming the variable and the fix,
which is the ADR 37 trade again — a loud break beats a silent divergence.
`doctor` flags it first, with a generated value to paste.

**`REDISCLI_AUTH` on the redis service, not `-a` at each call site.**
`redis-cli` reads that variable, so `docker compose exec redis redis-cli ...`
keeps working unchanged for organizers debugging by hand, and for `smoke.sh`
and `dev-stack`, which drive Redis exactly that way. Passing `-a` at every
call site would put the password in each command line (visible in `ps`) and
print a warning on every invocation.

**The smoke test asserts both halves, and both assertions were checked
against a control.** This is the class of control that is present in the
compose file and absent in the running stack — a typo in the connection
string, a service left on the wrong network — with everything still working,
because the fallback is "unauthenticated access succeeds". So:

- removing `--requirepass` → `FAIL: redis answered an unauthenticated PING: PONG`
- adding `backend` to `sync`'s networks → `FAIL: an app-tier service can still
  resolve redis — the network split is not in effect`

The first assertion needed a second pass to be trustworthy: `compose exec -e
REDISCLI_AUTH=` did **not** reliably clear the variable (redis-cli still
attempted an AUTH, so the control run failed for the wrong reason).
`sh -c 'unset REDISCLI_AUTH; redis-cli PING'` leaves no doubt about what was
sent.

**Consequences.** Assigning explicit networks makes compose's `default`
network a real trap: a service that declares none joins `default` — a *third*
network isolated from both. That is not hypothetical; it broke the smoke run
immediately, because `mock-github` is defined only in
`docker-compose.smoke.yml` and inherited no network, leaving `sync` unable to
resolve it and nothing but `fetch failed` to go on. **Any service added to any
compose override must name its network.**

The password is not defence against an organizer with shell on the box — they
can read `.env`. It is defence against a compromised *service*, which is the
threat that motivated it.

## ADR 42. One Fly machine running the real compose file, not five Fly apps

**Status.** Accepted. Supersedes the five-app arrangement introduced with
`deploy/fly/`.

**Context.** The Fly module first mirrored `docker-compose.yml` service by
service: one Fly app each for `app`, `scorer`, `sync`, `srh` and `redis`, with
the services reaching each other over Fly's private network. That arrangement
cannot work, and no configuration fixes it.

**Fly's private network (6PN, `<app>.internal`) is IPv6-only. srh's Redis
client is IPv4-only.** srh is a prebuilt third-party image
(`hiett/serverless-redis-http`) whose Elixir release bundles redix 1.1.5.
redix does support `socket_opts` — where `:inet6` would go — but srh builds
its connection options from the connection string alone and exposes no
environment variable for it. Inspecting the release confirms there is no knob.

The symptom is expensive to read: `nc` from srh's machine to
`redis.internal:6379` succeeds, redis logs look perfectly healthy, and srh
repeats `SRH was unable to connect to the Redis server` forever. Flycast (a
private anycast address) fixes *clients reaching srh*; it does nothing for
*srh reaching redis*.

This was chased across live deploys for a day before anyone tried to
reproduce it locally. It takes about a minute: create an IPv6 docker network,
run redis and srh on it, and point srh at the address. With the identical
image, redis and password, an IPv4 literal returns `{"result":"OK"}` and an
IPv6 literal fails. **Reproduce before designing.**

**Decision.** Deploy the event as **one Fly app running one machine with every
container in it**, from a compose file rendered out of the repo's real
`docker-compose.yml`.

Containers inside a machine share a network namespace and reach each other
over `localhost`, on IPv4. That removes the failure rather than working around
it. Fly deploys a compose file directly through `[build.compose]`, so the same
five services run, wired the same way.

**Alternatives rejected.**

*Upstash cloud* (real REST over HTTPS) would drop both `redis` and `srh` and
end the whole IPv6 question. Rejected because it swaps the datastore for a
different implementation, adds a third-party account and a bill to a kit whose
premise is "one box, no cloud bill", and breaks the local-equals-production
story the rest of this document keeps insisting on.

*Co-locating redis inside the srh image* (a two-stage build putting
`redis-server` beside srh, talking over loopback) was built and verified to
work. Rejected because it is a bespoke image that exists nowhere else: the
cloud deployment would run something the organizer never runs locally.

*One Fly app with several process groups* is impossible — every process group
in an app shares ONE image, and five different ones are needed. It would not
have helped anyway, since process groups still talk over 6PN.

**Why the compose file is RENDERED, not written.** flyctl's compose parser is
not Docker's: it is a hand-rolled `yaml.v3` unmarshal
(`internal/containerconfig/compose.go`). As of flyctl 0.4.87 it implements
neither `profiles:`, nor `${VAR}` interpolation, nor build `args:`, and it
rejects a file where more than one service declares `build:` — which
`docker-compose.yml` does twice. `docker compose config` implements all of
them correctly, because it is Docker's own parser, so the real file goes
through Docker first and Fly receives the result.

A hand-maintained second compose file would have avoided the render, at the
cost of two files to keep in step and a CI check to prove they were. Deriving
one from the other makes the drift structurally impossible instead.

`deploy/fly/render-compose.sh` then removes what must not ship:

- **Secret values.** `config` interpolates every `${VAR}`, so its unfiltered
  output is a file containing the whole event's credentials. They are set with
  `fly secrets` instead — which is also what makes stripping them safe, since
  Fly injects secrets into *every* container and the variable names already
  match across services. A fail-closed check greps the result for the values
  themselves, out of the env file, and refuses to leave the file on disk if
  any survived: a strip list keyed on variable *names* is exactly the sort of
  thing that goes stale when a service gains a credential.
- **Compose-only `$$` escaping.** To compose, `$$` means a literal `$`, and
  `config` faithfully re-emits it. Fly is not compose and passes it through,
  so `sh -c` would expand `$$` as the shell's PID and redis would start with a
  password like `12345REDIS_PASSWORD` — healthy, and impossible to
  authenticate against.
- **Service hostnames**, which resolve nowhere in a shared namespace.
- **Bind mounts, named volumes, networks and profiles**, none of which mean
  anything on a Fly machine.

**Consequences.**

**The `frontend`/`backend` split of ADR 41 does not exist on Fly, and cannot.**
One machine has one network namespace, so every container can reach
`redis:6379`. This is not a regression introduced here — 6PN is flat, so the
five-app deployment had already lost it, and `--bind 127.0.0.1` would not help
because containers share loopback too. On Fly, `requirepass` is the whole
control, which is why `REDIS_PASSWORD` is mandatory rather than optional.
Organizers who need the network split have it locally, on compose, where it
is real.

**Secrets cannot be scoped per service.** Fly's secrets are global to the
machine, so the `app` container also receives `REDIS_PASSWORD` and the `redis`
container also receives `GITHUB_CLIENT_SECRET`. That is a platform limit, not
a choice.

**caddy is absent**, as before: Fly terminates TLS and issues certificates. It
is excluded by naming the deployed services explicitly in the render — *not*
by giving caddy a compose profile. Profiling it would have made the edge
opt-in for every local bring-up, turning one forgotten flag into an event with
no ingress, and would have rippled through `ctf-setup.sh`, the acceptance
scripts and eight documents to serve a case only Fly has.

**Two changes reach the local stack**, both improvements on their own terms.
`redis` now reads its password from the environment through `sh -c` rather
than taking it as an argument, so the credential is no longer in the
container's command line, in `docker inspect`, or in `docker compose config`
output. And `sync` accepts `EVENT_CONFIG_B64` — the same variable, in the same
encoding, that the app already takes as a build arg — falling back to the
mounted file when it is absent or empty, because a Fly machine has no repo
checkout to bind-mount `./event.yaml` from.

**Addendum (single volume).** A Fly machine permits exactly **one** volume —
`invalid config.mounts, only 1 volume supported`, and only at machine-creation
time, after every image is pushed and the IPs are provisioned. redis's
append-only file and sync's cursor therefore share one volume under separate
directories. Both paths are knobs in `docker-compose.yml` (`REDIS_DIR`,
`STATE_PATH`) defaulting to exactly what the local stack has always used, with
`.env.fly` supplying the Fly values. The alternative — having the renderer
rewrite the paths — would have put a fact about the deployment somewhere no
organizer would look for it, and made the rendered file differ from the
compose file in a way not explained by either.

`redis-server` does not create `--dir`, so the command `mkdir -p`s it first;
`sync` already creates its state file's parent directory itself.

**Addendum (secrets travel in the rendered file).** The decision above says
secret values are stripped from the rendered compose file and supplied by
`fly secrets`, on the strength of Fly's documented claim that secrets are
"global and available to every container". **That claim is false**, and the
first deploy proved it: `fly secrets list` reported all fourteen as `Deployed`
while every container started without them. The app answered 500 from
better-auth's default-secret error, the scorer refused to start for want of
`SCORER_TOKEN`, and sync fell back to a mounted `event.yaml` that does not
exist on a Fly machine. A machine's containers receive only their own
`ExtraEnv`, which flyctl populates from the compose file's `environment:`
block; the machine config carries no `secrets` key at all.

Per-container `environment:` is therefore the only channel that reaches a
container, and the rendered file has to carry the values. It is treated
accordingly: mode 600 set before the content is written, a fail-closed check
that asks `git check-ignore` directly and deletes the file if the answer is
no, and removal by `deploy.sh` on any exit once a real deploy is done.
`fly secrets` are still set, so nothing regresses if Fly changes this.

The compensation is not nothing. **Per-service scoping, which the decision
above recorded as impossible, is exactly what this gives**: each credential
appears only under the service `docker-compose.yml` grants it to. The `app`
container never receives `REDIS_PASSWORD`; `redis` never receives
`GITHUB_CLIENT_SECRET`. Fly's global secrets would have handed both to both.

One bug came with the change. Rewriting service names to `localhost` was
anchored on `//host:`, which does not match `redis://:PASSWORD@redis:6379` —
the host there follows an `@`. srh was left pointing at `redis`, reproducing
the exact IPv6 failure this ADR exists to eliminate, and looking identical to
it. Both URL forms are rewritten now, with a test for the userinfo one.

## ADR 43. One URL, and it lives in `.env`, not `event.yaml`

**Status.** Accepted, and amended 2026-09-11 by [ADR 55](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml). The decision itself stands and got broader: `EVENT_URL` in `.env` is still the one URL, and it is still there because it is a *deployment* fact. What changed is the other side of the split — `event.yaml` no longer exists, so every statement below about what that file keeps, what a build refuses to find in it, and which line an existing config has to delete is **historical**. The event's identity, modules and targets are `/admin` settings now; the deployment facts (`EVENT_URL` included) stayed in `.env`, which is what ADR 55 calls this ADR the precedent for.

**Context.** The event's URL existed in two authored places at once:
`event.yaml`'s `event.url` and `EVENT_URL` in `.env`. Nothing kept them in
step, and they fed different consumers:

| Value | Read by | Effect when stale |
| --- | --- | --- |
| `EVENT_URL` | `BETTER_AUTH_URL`, the HTTPS start-up guard (ADR 39), the CSRF origin check (ADR 40), Caddy's host, `deploy/fly`'s validation | sign-in breaks loudly |
| `event.url` | `ctf-setup.sh`, which renders the leaderboard link into every fork's score comment | every scored PR points contestants at a dead host, silently |
| `eventConfig.url` (baked into the app from `event.url`) | **nothing at all** | none — it was dead |

The failure mode is the bad one: the copy that breaks loudly and the copy that
breaks silently are different copies. A Fly deployment ran with a correct
`EVENT_URL` and an `event.url` still naming the previous app, so sign-in worked
perfectly while the score comments linked to a host that no longer existed.

**Decision.** `EVENT_URL` is the only URL. `event.url` is removed from
`event.yaml`, from the wizard that wrote it, from the app's generated config
and its type. `ctf-setup.sh` reads `EVENT_URL` out of `.env`. A build that
still finds `event.url` in `event.yaml` **fails**, naming the replacement and
the lines to delete.

**Why `.env` and not `event.yaml`.** The URL is a *deployment* fact, and
`event.yaml` describes the *event*. One `event.yaml` is deployed to a box, to
AWS and to fly.io on three different hostnames — which is precisely why
`deploy/fly/deploy.sh` reads a separate `.env.fly` at the repo root whose own
header says a compose stack
and a Fly deployment "need different EVENT_URLs, and one file cannot hold
both". A single `url:` in the event file could not be right for all of them.

The reverse split — deriving `EVENT_URL` from `event.yaml` — was rejected on
the same ground, and would additionally have put a security-relevant value
(the CSRF origin, the auth callback) behind YAML parsed with `sed` in bash.

**Consequences** (as decided; `event.yaml` was deleted by ADR 55 and this
paragraph is historical from that point on). `event.yaml` keeps its shape as
the human, committable
description of an event: name, dates, modules, targets, admins. Everything
that varies per deployment — URL, secrets, image references, region — lives in
the env file beside them. Existing configs fail one build and need one line
deleted; the message says which.

What outlived the file is the split itself: deployment facts in `.env`, event
facts elsewhere. ADR 55 moved "elsewhere" from a committed YAML file to the
`ctf:admin:settings` hash behind `/admin`, and `EVENT_URL` did not move at all.

Not merging the two files was considered and rejected. `event.yaml` is a
structured contract shared by three readers (the app's generator,
`sync/src/config.js`, `ctf-setup.sh`) with nested per-module configuration, and
the generator's env-only path already demonstrates what flattening it costs:
one module, no per-module settings, targets as a comma-separated string.

## ADR 44. Runtime admin grants, with the baked list as the recovery path

**Status.** Superseded 2026-09-11 by [ADR 55](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml) — there is no baked list any more: the bootstrap set is `ADMIN_LOGINS` in `.env`, read at process start. The decision's substance is unchanged and deliberately preserved: runtime grants stack on top of the bootstrap set, a bootstrap admin can never be revoked from the panel, and `requireAdmin` checks the bootstrap list first without touching Redis and fails closed. Only the cost of changing that set moved, from a rebuild to a restart. Previously: accepted, implementing issue #147.

*Everything below is the decision as it stood, kept for its rationale, and
every mention of `event.yaml`, of a baked list, and of a rebuild is
**historical**. Read `.env`'s `ADMIN_LOGINS` for each of them: that is where
the bootstrap set lives now, the recovery path is "the login in `.env` still
works", and changing it is a restart rather than a rebuild. See
[ADR 55](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml)
for the current configuration model.*

**Context.** `admins` was baked into the app image at build time from
`event.yaml`. Adding a co-organizer meant editing that file, rebuilding the
image and redeploying — minutes on a hosted deployment, and a full
`docker compose build app` on a box. That is the wrong cost for a routine act
during an event, and it made one baked login a single point of failure: if it
could not sign in, nobody could reach `/admin` at all.

**Decision.** `event.yaml`'s `admins` becomes the **bootstrap** set. Further
admins are granted from `/admin` itself, stored in a Redis set
(`ctf:admin:admins`), and effective immediately. An admin is baked ∪ stored.

**A baked admin cannot be revoked through the panel.** That single rule is what
makes the feature safe to hand to a co-organizer: no sequence of clicks, and no
compromised admin session, can lock every organizer out. Recovery is always
"the login in `event.yaml` still works". Revoking one is a rebuild, on purpose.

**The access check fails CLOSED, and that is the opposite of the freeze read.**
`requireAdmin` catches a store failure and returns 403 rather than letting an
empty list read as "not an admin" for the wrong reason. `effectivePaused` in
`admin-store.ts` deliberately fails **open**, so a Redis blip cannot drop live
submissions. Both are correct: one is a safety switch whose failure must not
stop an event, the other an access check whose failure must not grant access.
`admin-auth.ts`'s comment points at `effectivePaused` and spells out the
contrast; the pointer is one-directional — the freeze read carries no comment
back.

The baked check runs **before** Redis is touched, so an organizer listed in
`event.yaml` can still reach the panel while the datastore is down — which is
when they are most likely to need it.

**Consequences.**

The read lives in its own module, `lib/admin-admins.ts`. Putting it in
`admin-store.ts` made `admin-auth.ts` — which is on the authorization path for
every gated route and Server Component — pull in the whole admin surface and,
through it, the module registry. That surfaced first as an unrelated test
blowing up on a mock; the expensive version is an import cycle found later.

`isAdminLogin` is now async, which makes `/flags` and `/quiz` do one extra
Redis read per **signed-in** render to decide whether to offer admin authoring
links. Signed-out renders short-circuit before it, and both pages already batch
several Redis reads, so the marginal cost is one `SMEMBERS` on pages that were
never static for a signed-in viewer.

The header's admin link is rendered by a Client Component, which cannot read
Redis. It keeps the baked check — instant, and correct for the organizer — and
asks `/api/me/admin` only when the baked list says no, and only when the menu
is actually opened. That route discloses one boolean about the caller and no
list at all, which is why it is not itself admin-gated: `requireAdmin` on it
would make it useless for the only question it answers. Menu visibility has
never been the gate (`requireAdmin` is), so a failed check hides a link rather
than granting one.

## ADR 45. The team-member cap is an admin override, not a constant or a config key

**Status.** Accepted. Implements issue #99, and applies ADR 31's rule to a
second setting.

**Context.** `TEAM_MAX_MEMBERS = 4` was hardcoded, so an event could not run
with pairs or teams of six. `event.yaml` once appeared to offer
`teams: { max_size: 4 }`, but nothing read it — a config asking for 6 silently
got 4 — and #98 removed the key rather than wiring it, because putting the cap
back there bakes it at build time.

**Decision.** Follow the `HINT_COST` shape ADR 31 singles out as the one that
got this right: *a hardcoded default with an admin override and no env var*.
`TEAM_MAX_MEMBERS` stays as the default, `ctf:admin:settings` gains a
`teamMaxMembers` override, and every read resolves `override ?? default`
through `resolveTeamMaxMembers()`.

**One resolver, every read path.** ADR 31's core lesson is that the split-brain
came from surfaces reading the constant while the toggle wrote elsewhere. Two
places read this cap — the join transaction and the profile roster — and both
go through the resolver. The Lua script enforces it *inside* the transaction,
so the resolved value is passed as an argument; hardcoding it there again would
reintroduce exactly the split.

**Enforced on join only.** Lowering the cap never evicts anyone: a team already
over the new limit keeps its members and simply cannot take another. The
control says so, because the alternative — silently dropping players mid-event
— is not a behaviour an organizer can undo.

**Zero is rejected.** A stored 0 refuses every join, including into a captain's
own team, while the panel advertises "0 players max". The floor is 1 and the
ceiling 100, both validated at the admin boundary rather than at the point of
use.

**Consequences.**

It **fails open** to the default when the store read throws: a Redis blip must
not make every team look full and wedge registration. That is the opposite of
`requireAdmin`'s fail-closed read (ADR 44), and for the mirrored reason — a
registration outage is worse than being briefly wrong about a team size, while
granting access is worse than denying it.

Both constants moved to `lib/team-limits.ts`, which carries no `server-only`
marker. The admin panel is a Client Component and needs the default as a
placeholder and the ceiling as the field's `max`; importing either store from
it fails the build outright. The stores re-export them, so server callers are
unaffected. Same reasoning as `lib/admin-admins.ts` in ADR 44: what a module
imports is part of its contract.

## ADR 46. The fork's Action pulls the scoring cooldown; the box does not push it

**Status.** Accepted. Implements issue #46.

**Context.** The re-run cooldown was baked into each fork's rendered
`ctf-score.yml` as `COOLDOWN_MINUTES`. Changing it for a running event meant
re-rendering and re-committing every fork's workflow. But the gate is evaluated
by a GitHub Action running **inside a contestant's fork**, which cannot reach
the box's Redis — so a live admin control needs the value to travel there
somehow.

**Alternatives.**

*Write an Actions variable through the GitHub API.* The admin panel would set
`vars.CTF_COOLDOWN_MINUTES` on each fork. Rejected: it requires the sync App to
gain **Actions/Variables write** on every fork — today it holds `Issues: read`
and `Pull requests: read` — and it requires the web tier to hold the App
private key. A compromised app would then have org-wide write. That is exactly
the blast radius ADR 41 exists to keep small, traded for one integer.

*Leave it provision-time.* Honest, but it fails the issue's only real
requirement: changing the cooldown during a running event.

**Decision.** Invert the direction. The box exposes
`GET /api/public/scoring` — unauthenticated, returning `{ cooldownMinutes }` —
and each fork's Action fetches it at the start of a run.

**Why unauthenticated is right here.** Authenticating it would mean putting a
credential into every fork, which is a far larger surface than the thing being
protected. The payload is a number that is already visible in every rendered
workflow file and implied by the score comments themselves. The rule that keeps
it safe is a scoping one: **scoring POLICY belongs in this payload, scoring
MECHANISM does not.** Tokens, rubric internals and who-solved-what stay out,
and a test asserts the response has exactly one key.

**Every failure falls back rather than failing.** The endpoint answers with the
baked default when Redis is unreachable — not a 5xx — so a blip cannot read as
"no cooldown". The Action wraps the fetch in a try/catch with a 5-second
timeout and ignores any non-numeric or negative reply. A scoring run must never
fail because a config lookup did.

**Consequences.**

Forks gain a soft network dependency on the box. It is soft by construction:
unreachable means "use the baked value", which is the behaviour that existed
before this change.

The Action derives the base URL from `LEADERBOARD_LINK` rather than taking a
second placeholder. They are always the same host, and one rendered value
cannot drift from itself.

**The workflow version stamp was bumped to 3.** `ctf-setup upgrade` re-renders
a fork only when the template's stamp is newer than the fork's, so changing the
template without bumping it leaves existing forks on the old workflow —
silently keeping a cooldown the organizer can no longer change. A test now
pins that the stamp is at least 3.

## ADR 47. A team is required to score, enforced at the route and signposted at the page

**Status.** Accepted.

**Context.** The docs said "everyone ends up on a team", and nothing enforced
it. A contestant could sign in, go straight to `/quiz` or `/flags`, and start
banking points while belonging to no team.

That is not a cosmetic gap, because the leaderboard ranks **teams**. A team's
total is the union of its *members'* earned items (`foldTeamTotals`), so points
banked by a login on no team are folded into nothing. The contestant sees their
answers accepted and their own per-login progress climb, and appears on no
scoreboard at all. They find out by checking, usually late.

The invariant was already written down; only the code was missing.

**Decision.** Enforce it in two places, with different jobs.

**The submission routes are the boundary.** `POST /api/quiz/answer` and `POST
/api/classic/submit` — and, since the ai module landed, `POST /api/ai/submit`
— refuse a teamless login with `403 { error: "no-team" }`.
This is what actually holds: a direct POST never renders a page. The check sits
*after* the pre-event gate — before the event opens, "not yet" is the truer
answer than "go make a team" — and *before* the store call, so a refusal can
never follow a write that already happened. It also runs before the request
body is parsed, so a teamless caller cannot use the refusal as an oracle for
whether a flag was correct.

**The page redirect is signposting.** A signed-in contestant with no team who
opens `/quiz` or `/flags` is sent to `/profile#team`. It prevents nobody: it
exists so the rule is learned before the work rather than after it.

**`hasTeam` fails OPEN.** An unreachable store answers "on a team". This is the
same call ADR 31's descendants make for `effectivePaused` and
`resolveTeamMaxMembers`, and the deliberate opposite of `requireAdmin` (ADR
44). The asymmetry is about what being wrong costs: a wrong "yes" here costs
one unattributed score, while a wrong "no" costs every contestant every point
they earn for the length of the outage. Refusing correct flags during a Redis
blip is the worse failure by a wide margin.

**Mock mode is exempt.** With `TEAM_WRITES_ENABLED` unset there is no team
system to be on the wrong side of — `getViewerTeam` falls back to a per-browser
cookie — so enforcing would lock every demo and local dev-stack out of scoring
to protect an invariant that build cannot hold anyway.

**Admins are exempt from the redirect, not from the check.** An organizer opens
a module page to confirm their questions render, which is not playing. An
organizer who actually submits still meets the route gate, because an admin's
points fold into no team either.

**Play solo is a first-class path.** Making a team mandatory without it would
mean the cheapest way to play alone is to invent a team name — a naming
decision imposed on the one person who has explicitly opted out of having
teammates. `POST /api/team/solo` creates a team of one named after the caller's
GitHub login. It is its own route rather than a flag on the create route
because the name is derived from the session and is not an input; a `name`
field that is silently ignored is a field somebody eventually relies on.

The login is only the first candidate. Team names are their own namespace, so
another contestant may already have a team called `octocat`; a collision
retries with a short suffix rather than erroring, because the whole promise of
the path is that it takes one click. A GitHub login also runs to 39 characters
while a team name stops at 32, so the login is clamped — unclamped, this path
would mint names `renameTeam` then refuses.

**Consequences.**

Leaving or disbanding a team mid-event makes a contestant teamless, and they
stop scoring until they are on a team again. That is the invariant working, not
a regression, and the redirect puts them on the team card the moment they open
a module page.

Points banked before joining a team are **not** lost. Because a team's total is
the union of its members' items, a joiner's existing per-login solves are
picked up by the fold automatically — there is no migration step, and none is
needed.

**Secure Development cannot be enforced this way.** Its points arrive from
GitHub through the sync poller, not through an app route, so there is no
submission for the box to refuse. A contestant patching a fork while on no team
still has their score ingested against a login that belongs to no team, where
it contributes to no team total. The gap is documented in
[operations.md](operations.md) rather than papered over; closing it would mean
the poller dropping or parking scores it cannot attribute, which is a larger
decision about ingest semantics than this one.

## ADR 48. Per-contestant support actions, and why they refuse some things

**Status.** Accepted.

**Context.** The only destructive control in the panel was the master reset,
which wipes the whole event. So the answer to "one contestant is wedged, the
room is waiting" was *do nothing* or *wipe everyone*. Every realistic live
ticket — wrong GitHub account, typo'd team name, a captain who left the
building, a "delete my data" request — had no answer an organizer could act on.

**Decision.** A **Support** tab with per-contestant and per-team primitives:
look up, reset progress, delete contestant, remove from team, transfer
captaincy, disband team. Admin-gated, audited, type-to-confirm on the
destructive ones against the specific login or slug rather than a generic word.

**Look up before you act.** Every control stays disabled until a lookup
returns. The failure this tab has to avoid is not a subtle one — it is
resetting the wrong person from a half-remembered username under time
pressure. Showing the score about to be deleted is the guard, and it is also
why the read exists at all: there was previously no way to inspect a single
contestant.

**The read is gated as hard as the writes.** `GET` returns one named
contestant's team, points, attempts and hint spend. That is precisely the read
a non-admin must never have, so it sits behind the same `requireAdmin`.

**Refusals that keep a team administrable.** A captain cannot be deleted or
removed while they hold the team. Rename, remove, regenerate and disband are
all captain-only, so removing the captain leaves a team nobody — including the
organizer — can act on. Transfer or disband first. Symmetrically, captaincy
can only transfer to an existing member, so the override cannot conjure a team
for an outsider.

**Disband deletes nobody's points.** Solves are per login, so a disbanded
team's players keep what they earned and can regroup. Deleting their work
because their team was wrong would turn an admin convenience into a scoring
incident. The join code IS deleted, or the reverse index keeps resolving and
`/join/<code>` renders a card for a team that no longer exists.

**The admin overrides are atomic, not read-modify-write.** They drop the
captain guard that `team-store.ts`'s scripts carry, because an organizer acts
on a team they are not on — but they keep the existence and membership checks
*inside* the script, in the same step as the write. An admin path that raced
with a contestant clicking Leave would be the one unguarded path in the team
surface.

### ADR 48 rider — Secure Development cannot be reset, only deferred

This is the sharp edge, and it is a property of the ingest design rather than
of this feature.

`scorer/src/store.js` writes solves with **HSETNX**, deliberately, so replays
are no-ops. The sync poller re-submits from the PR comments it reads. So
clearing a contestant's `ctf:solves:<target>` fields works right up until that
contestant's PR is scored again — a push, or a workflow re-run — at which point
the same solves are written back.

`resetEvent` has the identical problem and solves it globally: it freezes
scoring and bumps the `resetAt` epoch, which makes sync drop its cursor. There
is no per-login equivalent, and inventing one means a tombstone the ingest path
consults on every score — a new trust-relevant branch in the scoring chain, for
a support convenience.

The options were: skip Secure Development silently, build the tombstone, or
delete and warn. **Delete and warn.** Skipping silently would leave a third of
someone's score behind a button that said it reset them. Deleting is correct
for a data-removal request. And the warning names the operator's actual move —
close the PR, or freeze scoring first. Quiz, classic and ai have no such
issue: those writes originate in the app, so a delete is final.

### ADR 48 rider — The aggregates are not keyed alike

Worth recording because it is invisible and it bit during implementation.
Every per-login counter is a hash keyed by login — except one:

```
ctf:quiz:points          HINCRBY <login>          per LOGIN
ctf:quiz:answered        HINCRBY <login>          per LOGIN
ctf:classic:points       HINCRBY <login>          per LOGIN
ctf:classic:solved       HINCRBY <login>          per LOGIN
ctf:classic:solvecount   HINCRBY <challengeId>    per CHALLENGE
```

`solvecount` answers "how many people solved challenge X". There is no field
for a login to delete, so `HDEL`ing it by login removes nothing and silently
leaves every challenge still counting a contestant whose solves are gone — the
per-challenge stats drift up, permanently, once per reset. It has to be
decremented once per challenge the contestant had solved, which means reading
their solve rows *before* deleting them. A test pins the decrements and asserts
the `HDEL`-by-login never appears.

**Consequences.** `apps/web/src/lib/team-keys.ts` now holds the `ctf:user:*` /
`ctf:team:*` / `ctf:joincode:*` builders that were module-private in
`team-store.ts` — which is why `admin-store.ts`'s reset prefixes and
`profile/page.tsx` had each open-coded the same strings, the latter with a
comment admitting it. Open-coded keys are how two readers of the same data
drift apart.

## ADR 49. `firstTeamAt` records the funnel's conversion moment; `joinedAt` does not

**Status.** Accepted.

**Context.** The engagement funnel ([#169](https://github.com/dcotelo/owasp-ctf/issues/169))
is *signed in → got on a team → first solve*. Solves and answers already carry
timestamps per item per login, so the tail of that funnel was always
derivable. The middle step was not: `ctf:user:<login>` stored a `team` slug and
nothing about **when**, and the member set records no join time either.

**Decision.** Two timestamps on the user hash, with deliberately different
lifetimes.

`joinedAt` is when the contestant joined the team they are on **now**. It is
written on every join and create, and removed alongside `team` by every path
that clears it — leave, captain-remove, disband, and the admin overrides from
ADR 48. It is a fact about the current membership and must not outlive it.

`firstTeamAt` is the first time this login was **ever** on a team. Written with
**HSETNX**, so a second join cannot move it, and no path deletes it short of
deleting the contestant.

**Why not one field.** Reusing `joinedAt` for the funnel would undercount
every contestant who switched teams: their conversion would be reported as
having happened at their *latest* join, which is arbitrarily later than the
moment they actually converted. On an event where teams shuffle early — which
is most events — that skews the one number the funnel exists to produce. A
test pins the HSETNX, and another asserts no team script deletes `firstTeamAt`,
so a script added later cannot quietly become the path that erases it.

**The timestamp is an argument, not `TIME` inside the script.** Lua's clock is
not the app's, and a script that read the server clock would stop being
deterministic to replay.

**What is still not measurable.** *Signed in* has no record at all. better-auth
runs with no database here, so a session leaves no Redis footprint, and
`ctf:user:<login>` is first written when someone joins or creates a team.
Since ADR 47 a signed-in contestant with no team is redirected to team setup,
so the sign-in→team gap is small — but "signed in and never made a team" is
not countable today, and closing it means writing on an authenticated request
path, which is a bigger decision than this one.

## ADR 50. Metrics are computed from stored data; forks report nothing

**Status.** Accepted.

**Context.** Engagement metrics ([#169](https://github.com/dcotelo/owasp-ctf/issues/169))
raised a design question worth settling once: what may a fork tell the box, and
what may the box tell a fork?

A contestant's fork could report far more than Redis knows — pages opened, time
spent on a challenge, the moment someone gave up. That is exactly the data an
engagement metric wants.

**Decision.** Collect none of it. Every figure comes from keys the modules
already maintain, and no fork reports anything.

**Because a fork cannot report credibly.** Authenticating a fork means a
credential that every contestant can read, since it lives in their own
repository. An unauthenticated ingest endpoint is forgeable by every
contestant; a shared authenticated one is forgeable by anyone who opens their
workflow file. There is no arrangement in which contestant-reported engagement
is not attacker-controlled input.

Engagement numbers a participant can inflate are worse than numbers that are
merely incomplete — the incomplete ones are at least honestly incomplete. And
this is the same boundary the score chain already enforces: the score marker
must come from the judge's own output, never from the PR checkout. A telemetry
endpoint would reopen that shape for softer data.

**The public endpoint stays one-directional.** ADR 46's `/api/public/scoring`
is fork-facing, read-only and policy-only. Metrics neither reads from it nor
adds a write counterpart. The rule, stated once: **the box may publish policy
to a fork; a fork may not report facts to the box.** Anything a contestant
could gain by lying about does not travel in either direction.

**What that leaves measurable.** More than expected, because the modules were
already storing timestamps for their own reasons: quiz answers and classic
solves keep `{points, at}` per item per login, Secure Development solves are
timestamped as ingested, attempts are counted per login, and `firstTeamAt`
(ADR 49) anchors the funnel. So the funnel, the difficulty table, solves over
time, and the module split are all folds over existing keys, with no new write
path anywhere.

**And what it does not.** Recorded in the payload itself, not only here,
because a metric whose limits travel separately from it gets quoted without
them:

- team points on this tab SUM each member's totals; the leaderboard folds the
  UNION of their solves, so a challenge two teammates both solved counts once
  there and twice here
- the timeline plots solves, not submissions: attempt rows carry a first and a
  last time, but not one per try
- signing in leaves no record at all (better-auth runs with no database here),
  so the funnel starts at "ever on a team"
- Secure Development has no per-challenge attempt data; its scores arrive
  already judged, so it contributes to participation and points only
- anything earned before the timestamps below existed carries no start time,
  so early-event figures cover fewer contestants than late-event ones

**Two of the original gaps were closed by adding fields, deliberately and
after the reader shipped.** `firstAt` on each attempt row and a purchase time
per hint — see the section below.

### ADR 50 rider — `firstAt` and hint purchase times

`firstAt` lives inside the attempt row's JSON, beside `attempts`/`lastAt`/
`lastAtMs`. That row is REWRITTEN on every submission, so the first attempt's
time survives only by being read back out of the row it is replacing; the Lua
carries it forward and falls back to now when absent. It is written *after*
`attempts` and *before* `lastAtMs`, because the script's existing
`'"lastAtMs":(%d+)[,}]'` pattern relies on `lastAtMs` staying the final field —
inserting anything after it would silently break the cooldown read. A test
pins that ordering.

What it buys: **median seconds from a contestant's first attempt to their
solve**, per challenge. Median rather than mean, because one contestant who
left a tab open overnight would otherwise dominate a figure computed from a
handful of solvers.

Hint purchase times went into a **separate key**, `ctf:hints:at:<login>`,
rather than converting `ctf:user:<login>:hints` from a SET to a hash. That
conversion is a *type change on a key live events already hold*: the first
SADD after deploying would fail WRONGTYPE mid-event, and every SMEMBERS reader
with it. Additive costs one key and needs no migration. It sits under
`ctf:hints:` so the master reset's `ctf:hints:*` prefix already sweeps it and
it cannot become the key a reset leaves behind.

What it buys: splitting hints **bought before the solve** from those bought
after. A hint bought afterwards bought nothing, and counting the two together
turns "hints are used" into a claim that "hints help" — which the data would
not have supported. The comparison keeps the target in the key
(`<target>/<login>/<challengeId>`), because challenge ids are unique within an
app's catalogue but nothing makes them unique across apps.

Both are stamped by the server and neither is ever supplied by a caller, which
is the same rule ADR 49 states for `firstTeamAt` and ADR 50 states for the
fork boundary.

**Admin-only, permanently.** The aggregates are harmless to publish; the
payload is computed from per-contestant rows, so every field added later is one
edit away from carrying a login. Gating the route means that edit cannot become
a disclosure by accident. A public post-event summary should be an explicit
export of chosen aggregates, never this endpoint with its guard removed.

**Cost.** O(contestants) in batched round trips, on demand, uncached, with a
2000-contestant ceiling that reports itself in `caveats` when it truncates —
a silently truncated metric reads as a complete one.

## ADR 51. Base images are digest-pinned, and dependabot is what keeps the pin honest

**Status.** Accepted.

**Context.** The Dockerfiles and compose services named their bases by mutable
tag — `node:22-alpine`, `redis:7-alpine` (since bumped to `redis:8-alpine`,
[#181](https://github.com/dcotelo/owasp-ctf/pull/181)), `caddy:2-alpine`. A tag is a pointer
the publisher can move, so two builds of the same commit could sit on different
underlying images and neither would say so. The third-party SRH image was
digest-pinned in v0.1.0; this finishes the job for the first-party ones
([#49](https://github.com/dcotelo/owasp-ctf/issues/49)).

**Decision.** Every base carries `tag@sha256:<digest>`. The tag stays in front
of the digest: it is inert to the resolver, and it is the only thing that tells
a reader which image they are looking at.

The digests are **OCI image-index** digests, not per-architecture manifest
digests. An index digest resolves to the right image on whatever platform the
build runs on; pinning the arm64 manifest from a developer's Mac would produce
a compose file that cannot run the amd64 box it deploys to, and would fail at
pull time on the event host rather than here.

**The trade this makes, and the half that is easy to skip.** A pin freezes the
base until something moves it. A floating `node:22-alpine` silently picks up
the next 22.x patch, security fixes included; a pinned one never does. Pinning
without an update path does not remove risk, it swaps a supply-chain risk for
an unpatched-CVE one — and the second is quieter, because nothing about a stale
digest looks wrong.

So the pin ships **with** `docker` and `docker-compose` dependabot ecosystems,
which is what turns a frozen digest back into a reviewed one. The three
Dockerfiles share a node base and are grouped into a single PR: ungrouped, one
bump opens three, and landing some of them leaves the services on different
22.x patches — a difference nobody chose and nothing reports.

**Consequences.** Builds are reproducible and a swapped base is detectable.
Bumping a base is now a reviewed commit rather than a side effect of whenever
the layer cache last missed. This is the same reasoning ADR 37 reached from the
other direction: there, floating `actions/checkout@v4` delivered a security
guard the kit had not asked for and broke scoring loudly. Pinning trades a loud
break for a silent divergence — acceptable only because dependabot makes the
divergence visible on a weekly schedule.

**Not pinned:** the throwaway containers in `scripts/acceptance-*.sh`. They are
test scaffolding that exists for the length of one run and ships to nobody, and
pinning them would add three more digests to maintain for no tamper-evidence
anyone benefits from.

## ADR 52. Modules are switched at runtime; Secure Development is configured at setup

**Status.** Superseded 2026-09-11 by [ADR 55](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml), which records the whole config-v2 decision now that `event.yaml` is retired. This ADR's title is no longer true in its second half: Secure Development is switched at runtime like the other three modules, refused only when the deployment has no scorer image, and the only setup-time fact left about it is `SCORE_IMAGE` itself. The seed-and-fallback is the `SCORE_IMAGE`-derived default rather than a baked set, and an empty set is legal. The body below is kept as the record of the decision as it stood.

**Context.** Module *identity* has been runtime since the title/blurb overrides
landed, but module *enablement* was baked: `event.yaml`'s `modules:` compiled
into `event-config.generated.ts` at build time via `EVENT_CONFIG_B64`, and
roughly twenty consumers read it as a module-load constant. An organizer who
wanted to add the quiz mid-event needed a rebuild
([#175](https://github.com/dcotelo/owasp-ctf/issues/175)).

*Superseded 2026-09-10 by [#386](https://github.com/dcotelo/owasp-ctf/issues/386): the fallback is the `SCORE_IMAGE`-derived default now (secure-development alone when a scorer image exists, otherwise nothing), not `event.yaml`.*

**Decision.** The live set lives in `ctf:admin:settings`, and **`event.yaml`
becomes the seed and the outage fallback rather than the truth**. That
inversion is the decision; everything else follows from it.

Resolution fails **OPEN**, to the baked set. A Redis blip must not 404 every
live module at once — the loudest possible failure from the quietest possible
cause. The decoder applies the same rule to a stored set that filters down to
nothing (every id in it since removed from the registry): that reads as "no
override", never as "enable nothing".

**Disabling is a switch, not a delete.** Nothing is written to a module's data
when it is switched off, so re-enabling restores the same answers, solves and
points. An organizer using a toggle to hide a broken board must not discover
they have wiped it.

**The proxy gates the whole registry, enabled or not.** It is middleware, on
every matched request, and `gate.ts` is deliberately confined to `node:crypto`
so `next/headers` can never become reachable from it. A Redis read there would
put a network call on that path and give the gate a dependency that can fail —
in order to protect a module that, if the read failed, would be left open.
Gating the superset needs no read: a disabled module's route 404s at the page
either way, and pre-event the lock screen is what a visitor should see
regardless. It also stops the gate leaking which modules an event runs before
it opens.

*Superseded 2026-09-10 by [#386](https://github.com/dcotelo/owasp-ctf/issues/386): an empty module set is legal now — an organizer may switch every board off, and nothing refuses that write.*

**Refusing the last module.** ADR 24 already refuses a present-but-empty
`modules: {}` at build time. The runtime control refuses the equivalent, so
the same configuration is not legal through one door and illegal through the
other. An event serving nothing is a contestant-facing site with no content
and no explanation.

*Superseded 2026-09-10 by [#386](https://github.com/dcotelo/owasp-ctf/issues/386): Secure Development now toggles at runtime like every other module, refused only when the deployment has no scorer image (`SCORE_IMAGE` unset) — and disabling it is no longer refused.*

**Secure Development is excluded, in both directions.** It is not a flag:

- **Its services are not running.** `scorer` carries `["poll", "push"]` and
  `sync` carries `["poll"]`; an event that never enabled the module boots with
  `--profile app` alone and has no scorer container. The app cannot start one.
- **Its targets are provisioning input**, not configuration — forks, the App
  installation, per-fork workflows, all of it `ctf-setup.sh`'s work, holding a
  GitHub App private key the web tier deliberately does not have (ADR 41).
- **Disabling is refused too**, not only enabling. The scorer would keep
  ingesting scores for a module contestants can no longer see, which is worse
  than either end state.

*Amended 2026-09-11 by [#386](https://github.com/dcotelo/owasp-ctf/issues/386) (config v2 PR 2): the second bullet's "provisioning input" is no longer accurate either — `ctf-setup.sh org` forks all six `targets.tsv` targets unconditionally now, reading nothing from `event.yaml` to decide which. Which of the six an event actually serves to contestants (and which the sync poller reads) is a THIRD thing, alongside module enablement and target provisioning, that moved to a runtime `/admin` → Secure Development → Targets setting (`secureDevTargets`) — see [docs/operations.md](operations.md#targets). The first and third bullets are otherwise unaffected: the module still has no services running when disabled, and disabling is still refused.*

The panel shows its row with the reason on it rather than hiding the control or
leaving one that always errors.

**A switched-off module gets its own 404, because the generic one lies.** The
root 404 says "that page doesn't exist... the link is just wrong or out of
date". That is right for a typo and false for a module an organizer turned off
sixty seconds ago: the link is correct, the page was there, and telling a
contestant otherwise sends them hunting for a better URL mid-event. Each module
route carries its own boundary saying what actually happened — the module is
off, the link is fine, nothing already solved is affected, and it can come
back. `/challenges` differs again: secure-development is never switched off at
runtime, so there the page reports that this event does not run the module, and
promises no return that no organizer could deliver.

**"The last module" counts every LIVE module, not every switchable one.** The
first cut of the panel counted only toggleable ones, and so locked quiz on an
event running secure-development plus quiz — while secure-development sat above
it, enabled and serving. The server would have accepted that change; only the UI
refused. What makes a set legal is that something is live.

**Consequences.** Editing `event.yaml`'s `modules:` mid-event changes nothing
until a rebuild — the same trap the `hints:` and `teams:` keys already hit, so
the file, the example and the wizard's prompt all say "start with" rather than
"enable". Two surfaces stay baked on purpose: the root layout's and
`/how-to-play`'s meta descriptions, where making them live would put a settings
read behind every page's metadata for a `<meta>` tag; and `/gate`'s unlock
destination, where the lock screen is the one page a pre-event crowd hammers
and should make no settings read at all. `/privacy` did become dynamic — its
claims about what is collected have to match what actually is, and
under-disclosure is the wrong direction to be wrong in.

## ADR 53. ai launch tokens are asymmetric; event signatures stay symmetric

**Status.** Accepted.

**Context.** An `ai` challenge is hosted outside the box. Two signatures make
that work: the box mints a per-user **launch token** the contestant carries to
the external site, and the external backend may POST a signed **solve event**
back. The first design gave both jobs one key — the per-challenge
`ctf:ai:signkey` — chosen deliberately so that a backend holding that key could
*verify* the token it had been handed and *sign* its events with the same
secret. One key, both directions, nothing to distribute.

That is a hole, not a trade-off, and it is inherent to a symmetric MAC:
**verify-power is mint-power**. A backend holding a challenge's event key could
mint a launch token naming any `sub`, and a route that took `claims.sub` and
handed it to `awardAiEvent` would award points to a contestant who had never
opened the challenge — or to one who does not play at all. Every key holder is
an organizer's third-party integration, which is exactly the party the design
says identity is withheld from. The module's own threat notes claimed a leaked
key "cannot invent users"; as built, that was backwards.

Found by review on [#241](https://github.com/dcotelo/owasp-ctf/pull/241),
before any route existed to exploit it.

**Decision.** **Split the two by key type, not by key count.**

- **Launch tokens are EdDSA (Ed25519)**, signed with a **module-wide private
  key** the box alone holds, stored as a PEM pair in `ctf:ai:launchkey`. The
  public half is published.
- **Event signatures stay HMAC-SHA256** over the raw request body, keyed by the
  unchanged **per-challenge** `ctf:ai:signkey`.

This keeps what the original choice was *for* and drops what it cost. The reason
symmetric was picked — so an integrator can verify the token — survives and gets
better: a public key is publishable, so a key-holding backend **and a pure
static SPA with no secret at all** can both verify, where before only the former
could. What does not survive is minting: nothing an external party holds
produces a token the box accepts.

Three properties fall out, and each is pinned by a test:

- **`audience` is required**, in the type and at runtime, and a caller that
  omits it gets every token refused rather than any token accepted. One keypair
  now covers the module, so `aud` is the only thing separating a token for
  challenge A from one for challenge B — and these routes are unauthenticated
  and cookie-blind, where a silently-skipped check has no second line of
  defence.
- **The token's `alg` header is never read.** Ed25519 is hard-coded and asserted
  against the *key*, which is not attacker-controlled. Algorithm confusion is
  the precise class of bug this ADR exists to close; re-introducing an `alg`
  switch re-opens it.
- **The old HS256 `signToken`/`verifyToken` are deleted, not deprecated.**
  Leaving a symmetric minting function beside the asymmetric one is how the hole
  comes back at the hands of someone reaching for the nearer import.

**Rejected.**

- **One symmetric key for both** — the status quo, and the hole itself. Its one
  merit (an integrator can verify) is fully preserved by the public key, so
  there is nothing left on its side of the ledger.
- **Two symmetric keys** — a separate box-only HMAC secret for launch tokens.
  It closes the specific attack and is a smaller change. Rejected because it
  forfeits the property that made the original choice attractive: an integrator
  can no longer verify the token at all, since the key that checks it is the key
  that mints it and can never be shared. A static SPA would be left decoding
  unverified claims forever. Ed25519 costs the same round trips and strictly
  dominates.
- **A launch keypair per challenge** — `aud` already scopes a token to one
  challenge, so per-challenge keys add key management without adding a boundary,
  and they multiply the public keys an integrator must fetch by the size of the
  catalogue.
- **A minted-`jti` registry** — record every token the box mints and accept only
  a `jti` that is in it. This closes forgery with no crypto change at all, and
  was rejected on cost and failure direction: it puts a Redis write on every
  challenge-page render and a Redis read on every submission, it needs a TTL
  policy that must outlive the token, and the registry read has to fail
  *closed* — so a Redis blip stops every solve on the module, in exchange for a
  property a signature scheme gives for free and statelessly.
- **JWKS with key rotation** — the shape this grows into, deferred. One key and
  one publishable PEM is enough while there is one box and one module; the `kid`
  is already a public-key thumbprint, so the upgrade is additive.

**Consequences.**

**The box now holds a private key it must not leak, and that key is the module's
crown jewel.** An event signing key lets its holder assert a solve on one
challenge for a player who already holds a box-minted token. The launch private
key mints identity itself: any user, any challenge. It therefore joins the
contestant secrecy boundary alongside `ctf:ai:flag` and `ctf:ai:signkey` — no
contestant-path read names `ctf:ai:launchkey`, the store's public-half reader
exists precisely so a route never has to load the private half, and the
poisoned-record leak tests cover it exactly as they cover the flag.

**The public key is safe to publish, and publishing it is the point.** It is
served unauthenticated. That is not a concession; it is what lets an integrator
verify without the box handing any secret to a browser.

**The threat note is now true rather than aspirational.** A leaked event key
proves the sender and can invent nobody — the sentence the first draft asserted
and the code did not support.

**Minting is atomic and the pair is never silently replaced.** First use writes
with `SET NX` and reads back in the same pipeline, returning the *persisted*
value, so two concurrent mints converge and a losing racer never signs with a
key whose public half the box does not publish. A stored-but-corrupt record
throws rather than being overwritten: minting over it would invalidate every
token already sitting in a contestant's browser, mid-event, with nothing
anywhere saying why. For the same reason `clearAiChallenges` — the archive
import's catalogue wipe — deliberately leaves it alone. It is module identity,
not catalogue content.

**Rotation is a real operation with a real blast radius.** Rotating an event key
breaks one integration until it is redeployed. Rotating the launch keypair
invalidates every live token at once and changes the published public key under
every deployed verifier. The two are not the same button and must not be offered
as though they were.

## ADR 54. The AWS module is ECS + managed Redis; the event's data stopped being ours to lose

**Status.** Accepted. Breaking: replaces the EC2 module in place.

**Context.** The first AWS module was one x86_64 EC2 instance running this
repo's own `docker-compose.yml`, brought up by `user-data`. That was a good
argument and it is worth restating before dismantling it: the app image bakes
`event.yaml` at build time and the scorer is built from source, so `docker
compose up --build` on one host was far less friction than translating build
steps into task definitions; poll mode needs no inbound for scoring; and a
replaced box repopulates its leaderboard from the GitHub PR comments, so the
instance was close to disposable.

One thing in that stack was **not** disposable. Redis was a container writing an
append-only file to an EBS volume. Durability was ours: our fsync policy, our
volume, our restore procedure, and no backups unless the operator built them.
An event is a day people have blocked out — the failure mode is not "the box
died", which poll mode survives, but "the box died and the quiz answers, the
classic flags and every team went with it", which nothing in that design
survived.

**Decision.** Move the data to **ElastiCache for Redis** and let the rest
follow: **Fargate** services, an **ALB + ACM** for TLS, **ECR** for the image,
and SSM SecureStrings referenced by `valueFrom`. Replace the module in place
rather than adding a second AWS path — one AWS deploy, and ECS supersedes the
box.

**What this is not.** It is not a rewrite of the application. The app, scorer
and sync speak **only** the Upstash REST API and never raw Redis, so ElastiCache
changed exactly one thing: what `srh` connects *to*. `srh` stays, its
`SRH_CONNECTION_STRING` points at the primary endpoint instead of a sibling
container, and everything above it is byte-for-byte the code compose runs. That
property is why this was a module change and not a program change.

**The boundary did not move either.** ADR 41 put the app/Redis isolation in
security groups rather than in network topology, and it stays there: the ALB
alone reaches the app, the app and workers alone reach `srh`, `srh` alone
reaches ElastiCache. Tasks therefore sit in **public subnets** with public IPs
and no permitted inbound — because a NAT gateway costs roughly the entire
instance this module replaces, per AZ, before a byte moves, and VPC endpoints
are an hourly charge each for the five you need plus the ones you forget. A
public subnet with no inbound rule is not reachable; the subnet was never what
was protecting anything.

**Alternatives.** *EKS* — a control-plane charge and a Kubernetes upgrade
treadmill for four containers; tracked separately as a Helm chart (issue #54)
for people who already run clusters. *Keeping EC2 and bolting on backups* —
possible, and it keeps the price, but it leaves durability hand-rolled, which is
the one thing this ADR exists to stop. *Adding ECS beside EC2* — two AWS paths
to test, document and keep in step, for a kit whose whole claim is that one
command stands an event up.

**The costs, accepted deliberately.** Roughly four times the EC2 bill at the
defaults, itemised in the module README so the loss of EC2 simplicity is a
conscious purchase rather than a discovery. **Terraform state now contains a
secret** — the generated ElastiCache AUTH token — where the EC2 module could
honestly say it did not, so an encrypted remote backend stops being advice.
**Durability is snapshots, not AOF**: a restore loses up to a day rather than up
to a second, which is why the app's own event-archive export (#155) remains the
finer-grained backup for authored content and is what an organizer should
actually rely on between events. And the image bake moved from the instance into
`deploy.sh`, because Terraform cannot build an image — content-addressed tags
into an immutable repository, so a redeploy with nothing changed is a no-op
rather than an error.

**One customer-managed KMS key per event, and the operator has to use it.**
Review of the module found the execution role holding `kms:Decrypt` on `"*"`,
narrowed only by a `kms:ViaService` condition — which scopes the grant to calls
made through Parameter Store but says nothing about *which* parameters, so it
covered every SecureString in the account that delegates access to IAM,
including another event's. Naming a single key is the fix, and it forces a
choice: the AWS-managed `alias/aws/ssm` key cannot be scoped that way, so the
module creates its own. The consequence is operator-visible rather than
invisible — a hand-created parameter encrypted under any other key fails at
task start with an `AccessDeniedException` naming the key — which is why the
`--key-id` argument is in the `next_steps` output and the bootstrap apply now
targets that key alongside ECR. A dollar a month, and one more step in a
sequence that already had one.

The same review found the generated AUTH token itself published in the srh task
definition, as an `environment` entry holding the assembled `rediss://` URL —
readable by anyone with `ecs:DescribeTaskDefinition`, and in direct
contradiction of the comment above it claiming no secret was ever inlined. It is
now a `SecureString` read through `valueFrom` like every other secret. The
lesson worth keeping is the test's: the suite asserted the token was absent from
the *app* task definition and reasoned that srh legitimately holds it, so the
one place it was actually exposed was the one place nothing checked.

**Verified without an AWS account.** The compatibility question the design hangs
on — whether `srh` speaks TLS + AUTH to a managed cache, and whether `EVAL`
survives the hop — was answered against a Redis configured exactly as
ElastiCache presents itself (TLS-only, AUTH required, no client certs): `PING`,
`SET`/`GET`, `EVAL` and `EVALSHA` all pass, with a wrong token rejected as the
control. `srh` verifies against **CAStore**'s embedded Mozilla bundle rather
than the OS trust store — which carries Amazon's roots, so ElastiCache
verifies, but also means the trust anchors are frozen at the pinned image digest
and mounting a CA into the container does nothing.

## ADR 55. Configuration v2: `.env` bootstrap, `/admin` runtime, no event.yaml

**Status.** Accepted. Supersedes [ADR 10](#adr-10-eventyamls-module-namespace-deliberate-not-dynamic-registration), [ADR 12](#adr-12-build-time-config-generation-over-runtime-config), [ADR 26](#adr-26-compose-profiles-follow-the-enabled-modules), [ADR 44](#adr-44-runtime-admin-grants-with-the-baked-list-as-the-recovery-path) and [ADR 52](#adr-52-modules-are-switched-at-runtime-secure-development-is-configured-at-setup); amends [ADR 13](#adr-13-closed-appid-union-config-selects-a-subset-unknown-values-fail-the-build). Implements issue [#386](https://github.com/dcotelo/owasp-ctf/issues/386); [ADR 43](#adr-43-one-url-and-it-lives-in-env-not-eventyaml) is the precedent.

**Context.** Event configuration lived in three places at once: a committed
`event.yaml` baked into the `app` image through the `EVENT_CONFIG_B64`
build-arg (ADR 12) and read separately by `sync` and `ctf-setup.sh`; `.env`,
for secrets, `EVENT_URL` (ADR 43) and `SCORE_IMAGE`; and the
`ctf:admin:settings` hash, the runtime override layer (ADR 19) that had
already taken over module enablement (ADR 52), the event's identity, and the
Secure Development target list. Three planes, two of which claimed the same
facts.

The 2026-09-10 end-to-end pass on the live box named the cost:

- **A build that forgot the arg shipped a broken event, silently.** No
  `EVENT_CONFIG_B64` meant an empty `admins` list, so `/admin` 403'd for
  everyone — including the organizer — with nothing in any log saying why.
  It had its own entry in `docs/troubleshooting.md`, which is the tell: a
  configuration mechanism whose main documented behaviour is its own failure
  mode.
- **Every branding or module change was a rebuild.** Renaming an event, or
  turning a board on, meant `docker compose build app` and a redeploy, at
  exactly the moment an organizer can least afford one.
- **Two planes disagreed, in public.** `event.yaml` said
  `score_ingest: push` while the stack ran poll; #372/#374 answered with a
  drift *warning* rather than removing the duplicate declaration. The same
  copy-of-a-copy failure one layer up (`.env.fly` drifting from `.env`) broke
  sign-in and sync on the live box (#381).
- **The organizer could not tell which plane won.** "Should we drop module
  enablement on `event.yaml`?" is not a question a well-drawn configuration
  model provokes.

**Decision.** Delete `event.yaml`. Two planes, two owners, no overlap:

| Plane | Where | Owner | Contents |
|---|---|---|---|
| **Bootstrap** — what must be true before the app can answer a request | `.env` | the wizard, or the machine's operator | `GITHUB_ORG`, `ADMIN_LOGINS`, `SCORE_IMAGE`, `EVENT_URL`, and the secrets |
| **Runtime** — everything an organizer changes while the event runs | `ctf:admin:settings` | `/admin`, live | the enabled module set, the Secure Development target list, the event's identity, the scoring schedule and freeze, the hint policy, the team caps, all module content |

Nothing sits between them: no file, and no image that carries a configured
value. Concretely —

- **No image takes a configuration build-arg.** `EVENT_CONFIG_B64`,
  `EVENT_CONFIG`, the `apps/web/Dockerfile` arg,
  `apps/web/scripts/generate-event-config.mjs` and its generated
  `event-config.generated.ts` are all gone, along with `event.yaml` and
  `event.yaml.example`. The app image is the same image on every box.
- **`ADMIN_LOGINS` replaces the baked allowlist**, parsed at process start by
  `lib/bootstrap-env.ts` (a `server-only` module — the list must never reach a
  client bundle) and failing **closed**: empty means nobody is an admin, never
  "no allowlist, let the runtime grants decide".
- **`GITHUB_ORG` replaces `github.org`**, and its two readers deliberately
  disagree: the app degrades gracefully to a bare repo name where a fork link
  would go, while `sync`'s `loadConfig` throws at startup naming the key,
  because for a poller a missing org is a misconfiguration, not "nothing to
  poll".
- **`SCORE_IMAGE` becomes the Secure Development *availability* switch — not
  the live selector.** Non-empty means the module is available to this
  deployment: it is what adds the `secdev` compose profile (so the scorer and
  sync containers exist at all), it seeds the first-boot default module set,
  and it is what permits the `/admin` toggle. Empty means those containers
  never exist, the toggle is refused, and nothing is enabled until an organizer
  switches something on. What is enabled *right now* is always
  `enabledModules` in `ctf:admin:settings`, set from `/admin` — an available
  Secure Development module can be switched off there mid-event without
  touching `.env`, exactly like the other three. Two different questions, and
  keeping them apart is the point: `.env` says what this box *can* run, the
  panel says what it *is* running.
- **Registration stays static code; only *selection* moved.** The `ModuleId`
  registry in `apps/web/src/lib/modules.ts`, the closed `AppId` union in
  `apps.ts`, `sync/src/config.js`'s `TARGETS` and `scorer/src/targets.js` are
  unchanged, and `scripts/check-module-registries.mjs` still fails when the
  three target lists disagree. That is the half of ADR 10 and ADR 13 this
  decision keeps.
- **Provision all six targets, always.** `ctf-setup.sh org` no longer reads a
  subset from anywhere; the panel picks the live one.
- **The wizard writes `.env` and nothing else.** Its yaml writer, its
  `KNOWN_MODULES` mirror, its `--targets` flag and its "which modules" question
  are gone; step 3 is three keys.

**Consequences.**

- **Compose profiles are derived, not declared.** `poll` is renamed `secdev`
  (`scorer` carries `["secdev", "push"]`, `sync` `["secdev"]`), and
  `scripts/dev-stack` and `deploy/fly/render-compose.sh` add `--profile secdev`
  **iff `SCORE_IMAGE` is non-empty**. That is the one place "can this
  deployment provide Secure Development's services" is answered at `up` time,
  and it is derived rather than a second knob — the direct lesson of the
  `score_ingest` drift. It answers availability only: whether the module is
  *running* is `enabledModules` in `ctf:admin:settings`, set from `/admin`,
  which can switch an available module off without touching `.env`.
  ADR 26's conclusion survives verbatim (never give a Secure Development
  service the profile-less treatment; never add a `depends_on` from `app` to a
  profiled service); only the profile's *name* and its *source* changed.
  `push` is untouched here — its deprecation is
  [#377](https://github.com/dcotelo/owasp-ctf/issues/377)'s decision to make.
- **Both deploy paths carry the two keys as runtime environment and bake
  nothing.** Fly's `deploy.sh init --refresh` refreshes `GITHUB_ORG` and
  `ADMIN_LOGINS` alongside the other external credentials (#381), and AWS's
  `event_yaml_b64` variable is replaced by `github_org`/`admin_logins`
  mirrored into the app task definition. An existing Fly box upgrades with
  `init --refresh`, not a rebuild.
- **ADR 44's recovery path is intact, and slightly cheaper.** Runtime grants
  still stack on top of the bootstrap list and still cannot remove an entry
  from it; the list simply comes from the environment now, so revoking a
  bootstrap admin is an `.env` edit and a restart rather than a rebuild. The
  Admins tab's badge says `.env` · restart to change.
- **The `--dry-run` narration is thinner, and that is accepted.** With no
  config file to read, `ctf-setup.sh --dry-run` can no longer narrate an
  event's intended module set before anything exists; it plans against the six
  targets and the three `.env` keys. What it gains is that a dry run can no
  longer describe an event the running box does not actually have.
- **A first boot is emptier.** With Secure Development the only default — and
  nothing at all without `SCORE_IMAGE` — the landing page must render an
  explicit no-boards state pointing at `/admin` rather than an empty grid, and
  the wizard's closing message says which modules are on. The follow-on
  first-run checklist in `/admin` (#386 PR 4) is what replaces the guidance the
  example config file used to give.
- **Identity is read per request.** `getSite()` is exactly the runtime
  config-fetch path ADR 12 set out to avoid; it is one request-cached read of a
  hash the pause check already pays for, and every page is dynamic anyway
  (ADR 21).
- **No compatibility shim, by decision.** There is no detection of the old file
  or the old env var, and no migration. An existing box gains two `.env` keys
  and moves everything else into `/admin`.

**Alternatives rejected.** Keeping `event.yaml` as a *bootstrap-only* file
(name plus admins) was the smallest change, and it keeps the exact failure this
decision exists to remove: a second place to declare a fact, read at a
different time from the place organizers actually edit. Reading `event.yaml` at
runtime instead of baking it would fix the rebuild cost but not the two-planes
problem, and it puts a file mount on the request path — the concern ADR 12 was
right about. Moving the bootstrap keys into Redis as well was rejected because
the admin allowlist cannot be stored behind the thing it guards access to.

## ADR 56. Poll is the score transport; push ingest is removed

**Status.** Accepted 2026-09-12. Supersedes
[ADR 3](#adr-3-score-transport-poll-by-default-push-optional). Implements
issue [#377](https://github.com/dcotelo/owasp-ctf/issues/377). Originally
written as a two-release plan — deprecate in v0.6, remove in v0.7 — and
revised the same day, before v0.6 was cut, to remove push in v0.6 outright.
The revision is recorded under *Alternatives rejected* below, which is where
the two-step plan now sits.

**Context.** ADR 3 made poll the default and push an opt-in, on the reasoning
that a box with a public URL should not have to wait ~30 s for a score. Two
releases of living with both transports say the option costs more than the
latency it buys:

- **Push has never been proven end to end.** No CI job, acceptance script or
  bats case ran `SCORE_INGEST=push`. `scripts/smoke.sh` proves the poll
  pipeline; `scripts/acceptance-scorer.sh` exercised the judge's
  `SCORE_API`/`SCORE_TOKEN` hook against a fake leaderboard, which was the
  scorer's half and not the transport. The Action side was an optional hook in
  `scorer/src/judge.js`, fed by org secrets the wizard never set and `doctor`
  never checked.
- **It is broken on the one hosted path the kit ships.** A Fly machine has no
  caddy and no route for `/score`, so every pushed score would 404 silently;
  `deploy/fly/deploy.sh` refuses `SCORE_INGEST=push` outright (#373, #375).
- **Its configuration surface was the drift this kit keeps paying for.** ADR 3
  itself recorded that the `event.yaml` field and the env var had nothing
  syncing them, and #372 found exactly that live on the first real
  re-provision. [ADR 55](#adr-55-configuration-v2-env-bootstrap-admin-runtime-no-eventyaml)
  already fixed the second declaration by deleting `event.yaml`, leaving
  `SCORE_INGEST` in `.env` as the only copy — but what remains is still two
  Caddyfiles, two compose profiles, a docs table and a wizard question for a
  mode nobody runs.
- **It is the worse security posture.** Poll trusts only
  `github-actions[bot]`-authored comments and needs no inbound machine
  surface at all. Push exposes a public bearer-authed `POST /score` through
  caddy and puts `LEADERBOARD_TOKEN` in org Actions secrets, which are
  readable by `pull_request_target` runs a *contestant's* pull request
  triggers.
- **Its one advantage buys a CTF nothing.** ~30 s versus instant is invisible
  on a leaderboard people look at between patches, and the public URL push
  requires is the same box poll already works on.

**Decision.** Poll is the score transport for `secure-development`, and push
ingest is **removed in v0.6**. Gone with it: `caddy/Caddyfile.push` (compose
mounts a constant `caddy/Caddyfile.poll`), the `push` compose profile and its
bring-up notice service, the `SCORE_INGEST` key itself — from `.env.example`,
the wizard, `scripts/dev-stack`, the Fly deploy script and both AWS task
definitions — the AWS module's `score_ingest` variable, and the judge's
`SCORE_API`/`SCORE_TOKEN` leaderboard POST together with the
`<!-- ctf-score:not-recorded -->` marker that POST was the only writer of.

Two things deliberately outlive the transport, both in `doctor`. A `.env` that
sets `SCORE_INGEST` to anything other than `poll` gets one advisory line
saying the key is removed and is no longer read: whoever wrote `push` there
believed they had a transport, and silence is the one wrong answer. A leftover
`poll` says nothing, because it agrees with what the box now does. And the
org-secrets check stays, reporting `LEADERBOARD_URL`/`LEADERBOARD_TOKEN` as
unused standing credentials to delete — they are readable by runs a
contestant's pull request triggers, and now they authorize nothing at all,
which makes them worth *more* attention after the removal, not less.

**Consequences.** One transport, one trust model: every score reaches the box
as a bot-authored comment the poller filters by author before parsing, and
with push gone the kit's only machine-to-machine *inbound* surface is the `ai`
module's (`/api/ai/event`, `/api/ai/launch-key`, `/api/ai/state`) — the
`secure-development` workflow's remaining call outward is one optional
fail-open `GET /api/public/scoring` for the cooldown value, a read and not a
score path. Poll's ~30 s cadence becomes the floor for score latency, and the
freeze semantics simplify to one behaviour (the cursor holds; there is no
`503`-to-the-Action path to reason about). An organizer who wants faster
ingest has `POLL_INTERVAL_MS`, not a second transport. The cost is a real
capability removed rather than fixed: nobody gets instant scoring back, and an
event already running on push loses it at upgrade. That last cost is the
reason `doctor` names a leftover `SCORE_INGEST` by hand rather than leaving
the change to a CHANGELOG line: the box keeps booting either way, so nothing
else would ever tell its organizer that the transport they configured is not
the one running.

**Alternatives rejected.** *Keep push and prove it* — a CI job, an acceptance
script and a Fly route would make the option honest, and that is exactly the
work nobody has been willing to fund for two releases; an unproven transport
in a scoring path is worse than no transport. *Deprecate in v0.6, remove in v0.7* — this ADR's
own first draft, rejected on the day it was written. It was the careful shape
for a transport people use, and this is not one: nothing the kit writes has
ever set `SCORE_INGEST=push`, so having it takes a hand edit, and a release
that only warns still ships every part of the mechanism — two Caddyfiles, two
profiles, a validated key, a POST hook — for another cycle. The migration a
deprecation release buys is an `.env` line an organizer deletes; `doctor` can
say that in v0.6 as easily as a warning could, and a box whose `.env` still
says `push` comes up exactly as before, now on the transport that works. *Make push the default and drop poll* — the inverse
trade: it needs a public URL, inbound surface and org secrets for every
event, including the laptop-behind-NAT case the kit is built for.

## ADR 57. Sponsors are recognition-only, appear in four fixed surfaces, and
the disclaimer is not configurable

**Context.** An event needs to credit the organizations funding it. The kit
had nowhere to put them, so the fallback was editing branding by hand — which
is how a box stops reading as OWASP and starts reading as a vendor booth. A
sponsor feature has to give real, visible recognition while keeping the
platform's identity intact, and that second half is the design constraint,
not a nice-to-have (issue #405).

**Decision.**

- **Recognition only.** Name, logo, link, a short blurb. Sponsors get no
  sponsored challenges, no prizes wired into scoring, no contestant data, no
  lead capture. Anything beyond recognition is a separate decision and a
  separate issue.
- **Platform feature, not a module.** No `MODULES` entry, no registry churn,
  no module-contract obligations — the module contract is written around
  *challenge* modules, and sponsors score nothing. A sponsor renders if and
  only if the sponsor list is non-empty; an empty list is zero sponsor pixels
  anywhere. The demo seed DOES include three sponsors (`DEMO_SPONSORS` in
  demo-fixture.ts, one per tier) — reversed from this ADR's first draft,
  which kept the demo seed sponsor-free to avoid inventing a fake
  organization. The fixture instead uses obviously-placeholder names against
  the IANA-reserved `.example` TLD and carries no logo (a plain-text name
  everywhere a logo would render), which sidesteps the actual identity risk
  — a real-looking vendor booth — while still showing an evaluator what the
  feature looks like live rather than leaving it invisible on the one box
  most people actually open.
- **Exactly four render sites**, each reading `listSponsors()` and returning
  nothing on an empty list: the landing page's credit strip (grayscale by
  default, color on hover — a credit row, not an ad rail), the shared
  footer's text-only line (no logos, since the footer renders on every page
  load), the dedicated `/sponsors` page (logo, name, blurb, link, grouped by
  tier), and — extending the original four-surface design the same session
  this ADR was written in — the leaderboard's projector display
  (`?display=1`), alongside the OWASP mark, since that is the one screen a
  sponsor's own booth signage points a room at during a live event.
- **Logos stored in Redis, served from our own origin.** `ctf:sponsors` (JSON
  metadata) and `ctf:sponsors:logo` (base64 bytes) are two separate hashes so
  a metadata-only read (every page load) never drags a logo blob along. No
  third-party image fetch from a contestant's browser: that would leak the
  contestant's IP to the sponsor on every page load, against the OWASP
  privacy policy this site defers to. It also means no rebuild to change a
  sponsor (config v2 moved deliberately away from that), and CSP stays
  `img-src 'self'`.
- **Raster only. SVG is rejected at the store boundary**, by decoded-byte
  magic-number sniff — never by the declared MIME type or a filename, both of
  which are attacker-controlled. An SVG served from our own origin executes
  its embedded script the moment someone opens the logo URL directly; nothing
  stops a browser address bar from doing that, so "only ever referenced from
  an `<img>` tag" is not a mitigation. A sponsor always ends up with a PNG or
  WebP.
- **The disclaimer on `/sponsors` is not configurable.** It is hardcoded copy,
  not an admin field: an organizer who could edit it could sell it. It reads
  "OWASP does not endorse sponsors, their products, or their services.
  Sponsors fund this event. They have no influence over challenge content,
  scoring, or results." — the one thing this site says about the
  relationship, on purpose the one thing a runtime setting cannot touch.
- **No `enabled` flag.** Delete is the off switch. A master reset
  (`admin-store.ts`'s `resetEvent`) wipes both sponsor hashes outright, unlike
  a challenge's flag/description — sponsors are scoped to ONE event run
  (last year's sponsors are not implicitly this year's), so there is no
  CONTENT/PROGRESS split to preserve across a reset the way classic/quiz/ai's
  catalogues get one.

**Consequences.** A contestant never sees a sponsor logo fetched from a
sponsor's own infrastructure, and an organizer changes a sponsor mid-event
with no rebuild and no deploy. The cost is that sponsors are genuinely
second-class relative to challenge modules: no bulk-import UI of their own
(a sponsor bundle rides the whole-event archive instead), no drag-reorder
widget in the admin panel (a plain `order` number field), and the projector
display now needs a fourth "sponsors are allowed here" carve-out in the
guardrail test (`sponsor-boundary.test.tsx`) alongside the original three —
a boundary that will need to be re-stated, not just re-derived, the next time
somebody proposes a fifth surface.

**Alternatives rejected.** *A `sponsors:` block in a static config file* —
config v2 (ADR 55) moved this whole kit away from build-time configuration
specifically so a running box never needs a rebuild to change what it shows;
reintroducing one field that way for sponsors alone would undo the point of
that migration for the one piece of content most likely to change mid-season.
*Fetch sponsor logos directly from the sponsor's own CDN* — the obvious
zero-storage option, and the one this ADR exists to rule out: it puts every
contestant's IP address in the sponsor's own access logs on every page load,
which this site's privacy policy does not permit trading away for one field
of an admin form. *Allow SVG logos, sanitized* — a sanitizer is one more
dependency and one more place a bypass shows up later; rejecting SVG outright
at the store boundary needs no library and cannot regress.
