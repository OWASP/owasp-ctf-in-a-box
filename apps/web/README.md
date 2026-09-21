# apps/web — the contestant app

The web app contestants and organizers use during an OWASP CTF in a Box event: GitHub sign-in, the challenge boards, leaderboard, profile, teams, paid hints and the `/admin` panel. Event name, tagline, dates, location, contact and Discord invite are runtime `/admin` → Event settings, not build-time config; `ADMIN_LOGINS` and `GITHUB_ORG` are `.env` keys read at container start (see [docs/hosting.md](../../docs/hosting.md#environment-variables)) — nothing event-specific is baked into the image.

It was vendored from `OWASP-CTF/ctf-owasp-org` on 2026-08-14; `VENDORED.md` records the delta (Vercel bits stripped, DynamoDB retired, the AWS Lambda replaced by the kit's local scorer). `AGENTS.md` next to this file points at the kit's operating manual, and `DESIGN_SYSTEM.md` is the palette and token authority.

## Status

Shipped and in production use. The kit runs it as the `app` service in `docker-compose.yml`, which injects every runtime variable: `LEADERBOARD_SOURCE=lambda` selects a plain-HTTP adapter (`src/lib/leaderboard/lambda.ts`) pointed at the local scorer (`LEADERBOARD_API_URL=http://scorer:4000`), and teams, hints, admin settings and module state live in Redis through the `UPSTASH_REDIS_REST_*` client, served by SRH. The `mock` leaderboard source and the cookie-backed team mock still exist so the app runs alone with no backend, but the kit never uses them. What exists as of v0.4.0 is in the repo's [CHANGELOG](../../CHANGELOG.md).

## Modules

The app runs four modules; each brings its own page, API routes, admin tab and leaderboard block:

| Module | Page | Scores |
|---|---|---|
| `secure-development` | `/challenges` | Patches to six OWASP training apps (Juice Shop, DVWA, WebGoat, Security Shepherd, VulnerableApp, VAmPI), submitted as GitHub PRs and judged by the kit's scorer |
| `quiz` | `/quiz` | Multiple-choice answers |
| `classic` | `/flags` | Flag submissions on a category tile board |
| `ai` | `/ai` | Externally hosted AI challenges that report back to the box |

Module enablement lives entirely in `/admin`'s Event tab; organizers switch modules **at runtime**, and Redis holds the live set (ADR 52). The module contract is [docs/modules.md](../../docs/modules.md); the per-module operator guides are in [docs/operations.md](../../docs/operations.md). An event with `secure-development` off has no scorer, so `getLeaderboardSourceMode()` (`src/lib/leaderboard/source.ts`) ignores `LEADERBOARD_SOURCE` and builds the board from the module overlays alone.

## Features

- **GitHub sign-in** via [better-auth](https://www.better-auth.com/) — the same account a contestant opens PRs from.
- **Leaderboard** (`/leaderboard`) — public; sign in to highlight your row. Team totals fold individual scores, hint penalties net the final total.
- **Profile** (`/profile`) — requires sign-in; per-module progress plus the team card.
- **Teams** — join by code, create, or leave. Default cap **4 players per team** (`TEAM_MAX_MEMBERS` in `src/lib/team-limits.ts`), changeable from `/admin` (1–100, ADR 45); joins are enforced in one atomic Lua `EVAL`, so the cap cannot be raced. One team per player.
- **Paid hints** — reveal costs **10 points** by default (`HINT_COST` in `src/lib/hint-defaults.ts`), set from `/admin`. Charging is idempotent inside one `EVAL`, keyed by the session login; the scorer's totals are never decremented — the penalty is an overlay (`withHintPenalties`, floored at 0). Hints are on by default and toggled from `/admin`; there is no env var for either.
- **Admin panel** (`/admin`) — module switches, freeze and scheduled scoring window, team cap, hint policy, activity log, insights, event export/import. Admins come from `ADMIN_LOGINS` in `.env`, read at container start (restart, not rebuild, to change).

## Tech stack

Versions are pinned in `package.json`; these are the ones that shape the code.

- [Next.js](https://nextjs.org/) 16 (App Router, TypeScript, `src/proxy.ts` middleware) on React 19
- [better-auth](https://www.better-auth.com/) 1.x — GitHub OAuth, stateless JWE cookie sessions, no database
- [Tailwind CSS](https://tailwindcss.com/) 4 — tokens and patterns in `DESIGN_SYSTEM.md`
- Poppins (headings) + Barlow (body), loaded in `src/app/layout.tsx` per the [OWASP brand guidelines](https://policy.owasp.org/operational/branding)
- [pnpm](https://pnpm.io/) via corepack (`packageManager` pins it), Node 22, [vitest](https://vitest.dev/)

## Iterating on the app alone

Operators never run these — the kit builds and runs the image (see the [hosting Quickstart](../../docs/hosting.md#quickstart-zero-to-a-scored-event); `scripts/dev-stack up` gives a full local stack with a seeded board). For working on the app itself:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm dev            # http://localhost:3000
```

There is no `predev`/`prebuild`/`pretest` generator step — the app reads no build-time config at all. Copy `.env.example` to `.env.local` for what `pnpm dev` reads: `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL=http://localhost:3000` (also sign the gate cookie), and a `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` pair if you need sign-in (callback `<BETTER_AUTH_URL>/api/auth/callback/github`). Everything else is optional and falls back to mocks; `.env.example` documents each variable, and `docker-compose.yml`'s `app` service is the authority for what a real event sets. Every variable, including `ADMIN_LOGINS` and `GITHUB_ORG`, is read at start, so a change means only a container restart, never a rebuild.

## Testing

These match `.github/workflows/ci.yml` and the kit's `AGENTS.md`; run them from `apps/web`.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test           # vitest; the *.upstash suites skip without Redis credentials
corepack pnpm lint
```

The grading Lua scripts (classic `SUBMIT_SCRIPT`, quiz `GRADE_SCRIPT`, ai `AWARD_SCRIPT`) are the scoring authority, and only `src/lib/__tests__/*.lua.upstash.test.ts` execute them for real — the mocked suites pin what the stores hand the scripts, not what they do. The `admin-store`, `hint-store` and `team-store` `.upstash` suites next to them do the same for the settings, reveal and team scripts. Run all six against a real Redis behind SRH (the `docker run` lines are in `ci.yml`'s "Grading Lua" step) with

```sh
UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN=<srh token> \
  CTF_LUA_SUITES_REQUIRED=1 corepack pnpm exec vitest run upstash --no-file-parallelism
```

Serial on purpose: `admin-store` wipes the fixed `ctf:admin:settings` hash that `hint-store` seeds its policy into, so the two cannot share one Redis concurrently.

`CTF_LUA_SUITES_REQUIRED=1` turns a skip into a failure. After a build-affecting change, also run the production build and check `/` was **not** statically prerendered — the module nav resolves through a Redis read that is unreachable at build time, and a prerendered `/` would freeze it:

```sh
BETTER_AUTH_SECRET=ci-dummy BETTER_AUTH_URL=http://localhost:3000 corepack pnpm build
test ! -f .next/server/app/index.html   # must pass
```

## Project structure

```
src/
  proxy.ts                  # Middleware: same-origin check on mutating /api, pre-event gate
  instrumentation.ts        # Startup checks (http:// EVENT_URL refusal)
  app/
    (site)/                 # Pages: challenges, quiz, flags, ai, leaderboard, profile,
                            #   admin, gate, join, how-to-play, rules, faq, privacy, terms
    api/                    # auth, team, hints, quiz, classic, ai, admin, board, gate,
                            #   me, post-signin, public, stats
  components/               # Header/footer, boards, leaderboard, team card, countdown
  lib/
    modules.ts              # Module registry (ids, routes, copy); ALL_MODULE_ROUTES
    resolved-modules.ts     # Runtime enablement + title/blurb overrides from Redis
    auth.ts                 # better-auth config; disabledPaths closes unused endpoints
    admin-store.ts          # ctf:admin:settings — pause, schedule, cap, hint policy
    team-store.ts, hint-store.ts, quiz-store.ts, classic-store.ts, ai-store.ts
    gate.ts, gate-request.ts, gate-store.ts   # Pre-event gate cookie, API check, throttle
    leaderboard/            # Source adapters (mock/lambda/upstash/empty) + overlays
    upstash.ts              # Redis REST client (pipeline + EVAL)
    __tests__/              # vitest, incl. the *.lua.upstash.test.ts grading suites
```

## Things worth knowing before you touch them

**Authentication surface.** better-auth mounts its whole default endpoint set under `src/app/api/auth/[...all]`; the app uses four routes and closes the rest with `disabledPaths` in `src/lib/auth.ts`. `POST /update-user` was the one that mattered — with no database it would re-sign the session cookie with a client-chosen `login`. Do not "harden" `login` to `input: false` (it breaks OAuth profile mapping), remember `disabledPaths` matches literal paths only, and keep `src/lib/__tests__/auth.test.ts` green — it fails when an upgrade adds an endpoint that is neither used nor closed.

**Pre-event challenges gate.** `CHALLENGES_GATE_ENABLED=true` plus `CHALLENGES_GATE_PASSWORD` lock the module pages behind a shared password until the event opens; a flag without a password stays open. Enforcement is in two places on purpose: `src/proxy.ts` redirects page requests for every route in `ALL_MODULE_ROUTES` (`/challenges`, `/quiz`, `/flags`, `/ai` — enabled or not, so the gate does not leak which modules an event runs) to `/gate`, and the module APIs that bank points or return challenge content (`POST /api/quiz/answer`, `/api/classic/submit`, `/api/hints/reveal`, and the ai module's `/ai/[id]` page and server action) each call `requireGatePassed()` (`src/lib/gate-request.ts`) and answer **403 `{ error: "gate" }`** while locked. The proxy never gates `/api/*` itself — that would block the sign-in needed to pass the gate. `POST /api/ai/submit` is exempt: it is authenticated by a launch token that can only be minted from a page that already passed. Verification is server-side (constant-time compare); success sets an HMAC-signed httpOnly cookie for 30 days, signed by `BETTER_AUTH_SECRET` rather than the password. Five failures from one IP lock it for 24 hours (`gate:attempts:<ip>`, 30-day expiry, charged before the compare in one `EVAL`; fails closed if Redis is down) — everyone behind one NAT shares that budget, and the fix during the event is to turn the gate off, not to clear keys. It is a "the board opens at the keynote" curtain, not an authorization boundary: every route still checks session, pause, schedule window and attempt caps on its own (see [Known limitations](../../docs/operations.md#known-limitations)).

**Reach counter.** `POST /api/stats/visit` does `HINCRBY stats:countries <iso2> 1` once per browser session, taking the country from `cf-ipcountry` or `x-geo-country` and validating it as ISO-3166 alpha-2; the body is ignored and no login, IP or timestamp is stored, which is the promise `/privacy` makes. The kit's Caddy does not set or strip that header, so on a bare deployment the tally is spoofable — accepted for an approximate, no-PII counter.

## Branding

OWASP logo and favicon from the official mark at [owasp.org](https://owasp.org); typography per the OWASP brand guidelines above. The theme is the original navy/blue terminal identity — `DESIGN_SYSTEM.md` has the full token set and rationale.
