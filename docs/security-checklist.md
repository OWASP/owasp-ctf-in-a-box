---
title: Security checklist
---

[← Docs home](index.md)

# Organizer security checklist

One page to walk before an event. Everything here is a **deployment**
decision — the kit cannot make any of these calls for you, and most of them
have no visible symptom when they are wrong.

Read it alongside [SECURITY.md](https://github.com/dcotelo/owasp-ctf/blob/main/SECURITY.md),
which covers what to report and the one trust boundary that is deliberate:
the scorer builds and runs contestant-submitted code, because judging
submitted code is the product.

## The short version

| # | Check | If you get it wrong |
|---|---|---|
| 1 | `EVENT_URL` is `https://` | Organizer session cookie sniffable → admin takeover |
| 2 | `BETTER_AUTH_SECRET` is the generated one | Session cookies forgeable → any identity |
| 3 | `REDIS_PASSWORD` is set and unique | Compose refuses to start (fails closed) |
| 4 | Org's scorer image private, forks granted Read | Scoring fails on every PR; a private rubric leaks |
| 5 | Sync GitHub App is private and least-privilege | Third parties can install your event's App |
| 6 | No leftover `LEADERBOARD_URL` / `LEADERBOARD_TOKEN` org secrets | A score-writing token sits in org secrets that contestant-triggered runs can read |
| 7 | `admins:` lists only real organizers | `/admin` can freeze scoring and wipe the event |
| 8 | Treat `better-auth` bumps as security changes | The login-identity denylist can regress |

---

## 1. `EVENT_URL` must be HTTPS

The session cookie is only marked `Secure` over HTTPS, and this app keeps
**no server-side session store** — the cookie *is* the identity. Sniffing an
organizer's cookie on the venue wifi is a full admin takeover, not a
nuisance.

**This one is enforced.** A production start with an `http://` `EVENT_URL`
pointing at anything other than loopback refuses to serve: the container
comes up and answers `500` to everything, with the reason in the first lines
of `docker compose logs app`. `http://localhost` is for local trials and
stays allowed.

If a deployment is deliberately TLS-less — a closed lab, an isolated
classroom network — set `ALLOW_INSECURE_EVENT_URL=1` to downgrade the refusal
to a warning. It is **not** for TLS terminated upstream: there the public URL
is still `https://`, so `EVENT_URL` should say `https://` and the check passes
on its own.

> **What the kit cannot see:** if you front the box with a plain-HTTP proxy
> while `EVENT_URL` says `https://`, cookies are sniffable and nothing in the
> app can detect it. Terminate TLS at the edge that contestants actually
> reach.

## 2. Use the generated `BETTER_AUTH_SECRET`

Sessions are stateless JWE cookies; their integrity rests entirely on this
value. `./setup/ctf-setup.sh secrets` generates one. Do not hand-set a short
or memorable value, and do not reuse one across events — a leaked secret from
a past event forges identities in the current one.

Rotating it invalidates every live session, which is the correct response to
a suspected leak mid-event.

## 3. `REDIS_PASSWORD` is required

Redis runs with `requirepass`, and compose reads the variable with `:?` — so
a missing value **fails the bring-up** rather than starting an
unauthenticated instance. Nothing to remember to switch on.

Two things follow that are worth knowing rather than acting on:

- Only `srh` is given the password, and only `srh` can reach Redis. `app`,
  `scorer` and `sync` sit on a separate compose network with no route to
  `redis:6379` at all, so a compromised app container cannot side-step the
  bearer token.
- An event provisioned before this change needs one line added to `.env` —
  see [Hosting → Upgrading an event that predates the Redis password](hosting.md#upgrading-an-event-that-predates-the-redis-password).
  `doctor` flags it with a generated value to paste.

This protects against a compromised *service*. It is no defence against
someone with shell on the box, who can read `.env`.

## 4. Keep the org's scorer image private, and grant each fork Read

Keep `ghcr.io/<org>/score` **private** and grant each fork Read under the
package's *Manage Actions access* — the grant flow is what the provisioning
assumes, and it is what makes scoring work at all.

On secrecy, know which case you are in: the **stock rubric ships public**
([ADR 18](decisions.md#adr-18-exec-probe-rubrics-for-all-six-targets-the-rubric-ships-public)),
so for a stock event the private package protects the grant flow, not a
secret. If you baked your **own private rubric**, the package's privacy is
its only shield — and access control is the actual defence:
reverse-engineering a rubric out of a pulled image is assumed possible; the
goal is to limit who can pull it.

**This is the one manual step with no API**, and it fails as a `docker pull`
error inside a scoring run, which reads like a scoring bug rather than a
missing grant. If a target has never been scored, its grant is unverified.
Score one PR per target before the event.

## 5. Keep the sync GitHub App private and least-privilege

The App needs only **issues, pull requests and metadata: read**. Keep it
private to the event org — a public App can be installed by anyone, and its
installation is what mints tokens against your event's repos.

The App's private key lives in `.env` as `GITHUB_APP_PRIVATE_KEY`. Treat that
file as the event's secret store: it also holds the OAuth client secret and
the scorer bearer token.

## 6. Delete any leftover leaderboard org secrets

Scoring has **zero inbound surface**, and that is a property of the kit rather
than a setting to get right: the one Caddyfile has no `/score` route at all,
so the box needs no public URL for scoring. The poller reaches out to GitHub;
nothing reaches in.

What is worth checking is what an earlier event may have left behind in the
org. Push ingest — the fork's Action POSTing the score straight at the box —
was removed in v0.6 ([#377](https://github.com/dcotelo/owasp-ctf/issues/377),
[ADR 56](decisions.md#adr-56-poll-is-the-score-transport-push-ingest-is-removed)),
and it needed `LEADERBOARD_URL`/`LEADERBOARD_TOKEN` as **org** Actions
secrets. Org secrets are readable by the `pull_request_target` runs a
*contestant's* pull request triggers, so a leftover `LEADERBOARD_TOKEN` is a
score-writing credential exposed to a workflow contestants set off at will —
and nothing reads it any more, so there is no cost to removing it.
`ctf-setup.sh doctor` reports whether either is still set. Keep rotating
`SCORER_TOKEN` between events regardless: it is the bearer `sync` presents to
the one writer.

## 7. Audit `ADMIN_LOGINS` before you open registration

Anyone named in `.env`'s `ADMIN_LOGINS` — and anyone granted admin from the
panel's Admins tab — can freeze scoring, rewrite module settings, seed demo
data, and **wipe the event**. Matching is case-insensitive on the GitHub
login.

Three failure modes worth checking for explicitly:

- **An empty or unset `ADMIN_LOGINS` locks everyone out**, including you:
  the check fails closed, so `/admin` 403s for every login. It is read at
  container start, so a fix is an `.env` edit plus a restart, never a
  rebuild. See [Hosting](hosting.md).
- A leftover login from a previous event still has full control — check the
  env list *and* the panel's runtime grants, which survive in Redis across
  restarts.
- **A bootstrap admin cannot be revoked from the panel**, by design (it is
  the lock-out recovery path). Removing one means editing `.env`.

## 8. Treat `better-auth` upgrades as security changes

`apps/web/src/lib/auth.ts` closes a long list of default endpoints — most
importantly `/update-user`, which would otherwise let any signed-in
contestant rewrite their own `login` and spend another player's points.
`disabledPaths` is a **denylist**, so a new auth plugin can introduce new
endpoints it does not cover.

`src/lib/__tests__/auth.test.ts` fails when that happens. Keep it a required
check, and read its failure as "a new endpoint appeared", not "the test is
stale".

## What this kit deliberately does *not* protect

Stated plainly so it is not mistaken for an oversight:

- **The target apps are intentionally vulnerable.** Finding and patching
  their flaws is the exercise. Do not report them as kit vulnerabilities.
- **The scorer builds and runs contestant-submitted code.** It holds
  `docker.sock` to boot the app as a sibling container. That boundary is
  inherent to judging submitted code and predates every flag discussed here
  — see [ADR 37](decisions.md#adr-37-opting-in-to-the-guarded-fork-pr-checkout).
- **Contestants can see each other's scores.** The leaderboard is the point.
- **Jeopardy flags and quiz answer keys are stored in plaintext** (Redis:
  `ctf:classic:flag`, `ctf:quiz:key`) and are readable by every `/admin`
  user — the admin edit forms return them verbatim, deliberately, so an
  organizer can fix a typo'd flag mid-event. `/admin` access (and Redis
  access) is the actual secrecy boundary; decide who gets admin
  accordingly. Contestant-facing paths never touch either key. See
  [Operations → Jeopardy](operations.md#jeopardy).

## The operational half

Security aside, the checks that save an event, in the order to run them:

**The week before:**

- [ ] `./scripts/smoke.sh` passes on the box (proves the kit end to end,
  offline).
- [ ] Secure Development only: **score one real PR per target** — it is the
  only way to observe the image grant (check 4) and the fork's workflow
  version (`./setup/ctf-setup.sh doctor` for both).
- [ ] Rehearse with `scripts/dev-stack up`, then master-reset. The reset
  keeps your authored quiz questions and classic challenges; **export both
  bundles anyway** (each module's admin tab) — the export is the
  disaster-recovery path, and it contains every answer in plaintext, so
  treat the file like `/admin` access.
- [ ] Sign in as each organizer and confirm `/admin` loads — this catches a
  misspelled `ADMIN_LOGINS` entry and a container still running the previous
  value in one step.

**The morning of:**

- [ ] Set the scoring and registration windows (or plan to flip the freeze
  by hand) — the password gate, if you use it, is a curtain, not a lock.
- [ ] Confirm hint knobs (cost, minimum solves, unlock delay) are what you
  announced.
- [ ] Running Secure Development: `docker compose logs -f sync` shows a clean
  tick.

**During:** [operations.md](operations.md) is the panel guide;
[troubleshooting.md](troubleshooting.md) is the symptom-first runbook —
skim its headings now so you know what it covers before you need it at
9pm.
