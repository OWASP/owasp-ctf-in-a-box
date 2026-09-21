# Contributing to OWASP CTF in a Box

Thanks for your interest in contributing. This document covers the dev
environment, how to build and test each piece, what CI will hold you to, the
testing conventions this repo deliberately keeps, and the process for getting
a change merged.

## Dev environment

- **Node 22** across the board (`sync`, `scorer`, `apps/web` all pin it in
  CI). `apps/web` uses **pnpm via corepack** (`corepack enable` once); the
  other two are plain npm.
- **Docker with Compose v2** for anything that brings containers up (smoke,
  the acceptance scripts, the dev stack). `openssl` for secret generation.
- `shellcheck` and `bats` for the shell layers.
- The fastest way to see the real app with data on it:

  ```sh
  ./scripts/dev-stack up      # throwaway secrets, local builds, seeded demo board
  ./scripts/dev-stack down
  ```

  It never touches a real `.env`. Sign-in/`/admin` need a real GitHub OAuth
  app on top — `dev-stack up` prints exactly what to add.

## Repo layout

- **`apps/web/`** — the vendored Next.js contestant app (auth, teams,
  leaderboard, admin panel). Managed with `pnpm`.
- **`scorer/`** — the judge + leaderboard scoring engine. Plain Node.js,
  tested with `node:test`.
- **`sync/`** — the poll service that watches for score comments and feeds
  the leaderboard. Plain Node.js, tested with `node:test`.
- **`setup/`** — `ctf-setup.sh` and the event provisioning flow. Bash,
  tested with `bats`.
- **`deploy/`** — optional cloud deploy modules (e.g. `aws-terraform/`, a
  single-shot EC2 box; `fly/`, one Fly machine). CI-validated by its own
  Terraform workflow (fmt + validate + test, never apply) and by the shell
  job's shellcheck/bats coverage of `deploy/fly/`.
- **`patches/`** — reference patches for the target apps, with their own
  [`README.md`](patches/README.md).
- **`scripts/`** — the acceptance, smoke and dev-stack scripts. Bash; the
  `*.sh` ones are linted with `shellcheck` in CI.
- **`docs/`** — the documentation site, published via GitHub Pages.

## Building and testing

Each layer tests independently. These commands match what CI runs (the
agent-facing copy with the full gotcha list is
[`AGENTS.md`](AGENTS.md#buildtestlint)):

```sh
# sync
(cd sync && npm ci && npm test)

# scorer — unit tests, the vacuous-pass gate (points every rubric at a
# useless stub, must report 0), then the offline acceptance loop
(cd scorer && npm ci && npm test)
(cd scorer && node tools/vacuous-sweep.mjs)
./scripts/acceptance-scorer.sh

# app
(cd apps/web && corepack pnpm install --frozen-lockfile && corepack pnpm lint && corepack pnpm test)

# app — the grading Lua (classic, quiz, ai) and the admin, hint and team
# scripts executed against a real Redis. Skips without the two env vars; CI
# brings up redis + srh and requires it (see the "Grading Lua" step in ci.yml
# for the two `docker run` lines). Serial: two suites share ctf:admin:settings.
(cd apps/web && UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN='replace-with-your-srh-token' \
  corepack pnpm exec vitest run upstash --no-file-parallelism)

# app production build — CI also asserts .next/server/app/index.html does
# NOT exist afterwards: `/` must never be statically prerendered
(cd apps/web && BETTER_AUTH_SECRET=dummy-secret-32-characters-minimum \
  BETTER_AUTH_URL=http://localhost corepack pnpm build)
./scripts/acceptance-app.sh

# shell
shellcheck scripts/*.sh scripts/lib/*.sh scripts/dev-stack setup/*.sh scorer/entrypoint.sh \
  deploy/fly/deploy.sh deploy/fly/render-compose.sh
# entrypoint fragments are sourced POSIX sh, never run standalone
shellcheck -s sh --exclude=SC2034 scorer/entrypoints/*.sh
bats setup/test/ && bats deploy/fly/test/

# single-module compose bring-ups
./scripts/acceptance-quiz-only.sh
./scripts/acceptance-classic-only.sh
./scripts/acceptance-ai-only.sh

# the whole poll pipeline, end to end, offline
./scripts/smoke.sh

# the real-target scoring gates — Docker, pulls upstream images, minutes per
# row; the matrix rows in the two heavy workflows are the example invocations
./scripts/acceptance-target.sh <target> <stock-image|none>   # stock app scores 0/N
./scripts/acceptance-patched.sh <target> <challenge-id>       # patched fork scores exactly that one
```

Run the layers your change touches, plus `smoke.sh` for anything that crosses
services. The two real-target gates are for what their workflows' `paths:`
filters name — the filters are the authority, and the two differ slightly.
In summary: rubrics under `scorer/rubric.owasp/`, the judge-path sources in
`scorer/src/`, the scorer Dockerfile, `package.json` and lockfile, the
entrypoints, the gate scripts and `scripts/lib/acceptance-lib.sh`,
`patches/`, and the workflow files themselves.

## What CI runs

`.github/workflows/ci.yml` is a `changes` gate (native `git diff` path
filtering) plus eleven gated jobs — a job for an area your PR doesn't touch is
*skipped*, and a push to `main` runs everything:

| Job | Proves |
|---|---|
| `sync-tests` | Poller parsing, cursors, idempotency, config validation |
| `scorer` | Rubric grammars, judge report format, serve auth, both solve stores; then the offline acceptance loop |
| `vacuous` | No rubric check passes against an up-but-useless stub (0/321) |
| `shell` | shellcheck + bats over `setup/`, `scripts/`, `deploy/fly/` |
| `smoke` | The full poll pipeline against fixture services, including the forged-comment drop and the freeze hold |
| `app` | eslint (`pnpm lint`, zero problems); vitest; the three grading Lua scripts and the admin, hint and team scripts executed against a real Redis behind srh (every `*.upstash.test.ts` suite, run serially; required, not skippable, in CI); the production build; the `/`-never-prerendered assertion; `acceptance-app.sh`'s runtime-config acceptance (one image, three environments) |
| `quiz-only` / `classic-only` / `ai-only` | A single app-side module runs a whole event alone, with no scorer to pull |
| `registries` | The three independently maintained target lists (`sync/src/config.js`, `apps/web/src/lib/apps.ts`, `scorer/src/targets.js`) still agree |
| `docs` | The Jekyll site builds; link/meta checks |

Two heavier workflows (`stock-scores-zero`, `patched-scores-right`) run
`scripts/acceptance-target.sh` and `scripts/acceptance-patched.sh` against
real target containers, one matrix row per target or reference patch, and
are path-scoped to judge-relevant scorer inputs plus `patches/`.
`terraform.yml` validates and *tests* `deploy/aws-terraform` —
`userdata.tftest.hcl` renders the bring-up script at plan time, because
`terraform validate` never inspects rendered template output.

## Testing conventions this repo holds on purpose

- **No testing-library.** UI decisions that need tests live in pure
  functions, which get tested directly; drag handlers and DOM plumbing don't.
- **Differential tests over a shared source of truth.** Several readers parse
  the same input in different languages and share no code, so each is pinned
  to a file both sides can assert against rather than to the other's
  behaviour. The `.env` bootstrap keys are read by `env_val`
  (`setup/ctf-setup.sh`, bash) and by `loadConfig(env)` (`sync/src/config.js`,
  JS) — the same keys, two parsers, and AGENTS.md's lockstep rule applies.
  `setup/targets.tsv` is the only authoritative source of a fork's repo name,
  and both `sync/test/repo-names.differential.test.js` and
  `apps/web/src/lib/__tests__/apps-repo-names.differential.test.ts` parse that
  file and assert their own list against it (`setup/test/ctf_setup.bats` does
  the same from the bash side). The three independently maintained `TARGETS`
  lists — `sync/src/config.js`, `apps/web/src/lib/apps.ts`,
  `scorer/src/targets.js` — are compared by
  `scripts/check-module-registries.mjs`, which fails closed if any parser
  extracts nothing.
- **Anti-vacuous discipline.** A test that "blocks the exploit" against an
  app that wasn't up proves nothing. Assertions must be able to fail:
  acceptance scripts assert on seeded names/logins reaching real rendered
  HTML, and the vacuous sweep exists solely to catch this class.
- **bats: the decisive assertion is the test's LAST statement.** A mid-test
  `[[ ... ]]` or a non-final `! cmd | grep` does not gate the test (errexit
  exemption); CI's shellcheck also flags `A && B || C` (SC2015).
- **Decisions get ADRs.** If your change picks between real alternatives,
  record it in [`docs/decisions.md`](docs/decisions.md) — context, decision,
  consequences, status. Superseding an old ADR means marking the old one's
  Status, never rewriting it.
- **Docs ship with the change.** A behavior change that leaves
  `docs/` describing the old behavior is not done.

## Developer Certificate of Origin (DCO)

This is an OWASP Foundation project, and the
[OWASP Project Policy](https://owasp.org/www-policy/operational/projects)
names the [Developer Certificate of Origin](https://developercertificate.org/)
as the contributor agreement every OWASP project must use. There is no CLA to
sign and no copyright to assign — you sign off each commit instead,
certifying that you wrote the contribution or otherwise have the right to
submit it under this repo's licences.

Sign off as you commit:

```sh
git commit -s -m "fix: whatever you fixed"
```

`-s` appends a trailer built from your `user.name` and `user.email`:

```
Signed-off-by: Your Name <you@example.com>
```

The name and email must be real and must match what git is configured with —
a sign-off is a statement, not a formality.

Forgot it on the last commit:

```sh
git commit --amend -s --no-edit
```

Forgot it across a branch:

```sh
git rebase --signoff origin/main   # then force-push the branch
```

`Signed-off-by:` is required, and is unrelated to the trailers this repo
forbids: no `Generated with`, and no `Co-authored-by:` naming an AI tool or
agent (see [AI-assisted contributions](#ai-assisted-contributions)).

## Pull request flow

1. Branch off `main`.
2. Make your change. Keep commits scoped and use
   [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
   `fix:`, `docs:`, `test:`, `chore:`, `ci:`, ...). Sign off every commit
   (`git commit -s`) — see [DCO](#developer-certificate-of-origin-dco).
3. Run the relevant tests locally (above).
4. Open a pull request against `main`. Fill in the PR template.
5. CI must be green before merge. Only the jobs for areas your PR touches
   run (see `AGENTS.md` for how that gating works); a push to `main` always
   runs everything as a safety net.
6. **CodeRabbit review must pass too.** It reviews every PR automatically;
   resolve every actionable comment before merge — apply the fix, or reply
   with why it doesn't apply and mark the thread resolved. A reasoned
   disagreement is fine; an ignored finding is not.

A PR is ready when all of these are true:

- The commands for the touched area in AGENTS.md were run locally
  (or the PR says why they could not be — e.g. no Docker).
- New tests can fail: the summary names the single-token mutation
  each new/changed test would catch.
- Invariants in docs/reviewing.md that this diff touches were checked.
- Every commit carries a `Signed-off-by:` trailer (`git commit -s`).
- No `Generated with` / AI `Co-authored-by:` trailers.
- Breaking-change box in the PR template is filled in (`None` is fine).
- Latest commit has a CodeRabbit "Review completed" and no open
  actionable thread.

## Proposing a new module

Modules are the kit's extension point — a new CTF vertical (forensics,
api-security, cloud, …) plugs into the same org/teams/leaderboard/admin
spine. Before writing code:

1. Read [`docs/modules.md`](docs/modules.md) — the contract, with the four
   shipped modules as worked examples. Section 9 lists the exact files a new
   module touches.
2. Open an issue describing the module: what a contestant does, how it's
   graded, which transport it uses (in-app like quiz/classic, or
   GitHub-mediated like secure-development), and what infrastructure it
   needs.
3. Expect the contract's non-negotiables to be held: sandboxed execution,
   oracle discipline, a stock-scores-zero guard, and standalone-module
   composition (your module must be able to run an event alone).

## Releases

Versions follow [Semantic Versioning](https://semver.org/), cut as
**repo-level annotated tags** from `main` (`v0.1.0` through `v0.4.0` so
far) with GitHub Releases generated from the Conventional Commit history —
`feat:` implies minor, `fix:`/`docs:`/`chore:` imply patch, a
`BREAKING CHANGE:` footer (or `!` after the type) implies major. The version
is repo-level: `apps/web/package.json` tracks the current tag; `scorer` and
`sync` deliberately carry no version field. [`CHANGELOG.md`](CHANGELOG.md)
summarizes each release.

## AI-assisted contributions

AI- and agent-assisted pull requests are welcome. A few rules apply:

- The **human author is responsible** for the change. You are expected to
  understand, review, and stand behind everything in your PR, whether you
  typed it or an agent did.
- Commits and PRs carry **no AI attribution** — no "Generated with", no
  `Co-authored-by:` trailers for an AI tool or agent. Write commit messages
  as you would for any other change.
- If you're using an agent to help write code in this repo, have it follow
  [`AGENTS.md`](AGENTS.md) — it documents the exact build/test commands and
  the project's real conventions and gotchas (bash compatibility, shellcheck
  rules, bats assertion pitfalls, the stock-scores-zero invariant, and so
  on).

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) applies to all project spaces.
