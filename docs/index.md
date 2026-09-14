---
title: OWASP CTF
---

# OWASP CTF

**A self-hosted control plane for security-learning events** — run at a
university, a high school, an OWASP chapter, a meetup, from one box and one
free GitHub org.

![Walkthrough of the contestant leaderboard: sweeping the score-over-time graph to read every team's score at that instant, then expanding the leading team to its members, its per-module totals and its per-target breakdown](assets/demo.gif)

<sup>The real contestant app with seeded demo players. Hover the graph to read
every team's score at that moment; expand a team for its roster, what each
module contributed, and its per-target breakdown.</sup>

OWASP CTF is a control plane, not a single game. It gives an event its
shared spine — a GitHub org, team registration, a live leaderboard, an
organizer admin panel, and the scoring pipeline that feeds it — and **modules**
plug challenge content into that spine. Four modules ship today — **OWASP
Secure Development**, **Quiz**, **Jeopardy** and **AI** — and any
subset can
run alone or together; the box is built to host further modules on the same
spine. The [module contract](modules.md) is the boundary between platform and
module.

The **Secure Development** module teaches defence rather than attack: a
contestant forks a deliberately vulnerable app, finds the flaw, **patches** it,
and opens a pull request. The pipeline scores the patch and the score lands
on a **team** leaderboard. **Quiz**, **Jeopardy** and **AI** need none of that
machinery — no forks, no GitHub org, no scoring pipeline. They are graded
inside the app, so an event running only those boots with a single compose
profile. Their organizer guides are
[Quiz](operations.md#quiz), [Jeopardy](operations.md#jeopardy) and
[AI](operations.md#ai) — AI additionally has its own external integrator
contract, [ai-module.md](ai-module.md).

Until now, running one meant standing up Vercel, Upstash, Lambda and DynamoDB,
holding the cloud bill, and having access to a private scoring image. This kit
removes all of that: everything runs from Docker Compose on a machine you
already have, plus one free GitHub org for the forks. The rubrics for all six
targets ship inside the box, so there is no private image to request and no
scoring code to write.

## What you get

**The platform** (control plane, module-independent):

| Feature | What it means for you |
|---|---|
| **Team scoring** | Per-team standings, self-registration, captains and join codes; shared flags dedupe so they count once. |
| **Live leaderboard + graph** | A ranked team leaderboard with a CTFd-style score-over-time graph from real per-solve timestamps. |
| **Organizer admin panel** | `/admin`, allowlisted: freeze the leaderboard, schedule scoring and registration windows, toggle hints, set the team cap and score cooldown, grant admin to others, author each module's content, reset between rehearsals. |
| **Live-event support** | Act on one contestant or one team without wiping the event: reset progress, delete a contestant, take over a captainless team. Every action audited with actor and target. |
| **Engagement metrics** | Participation funnel, solves over time, per-challenge difficulty and hint usage — folded out of data the box already stores, with no telemetry from contestants' forks. |
| **Scoring pipeline** | GitHub-Actions-fed poll transport, one audited score writer — for modules graded outside the app. Quiz, Jeopardy and AI bank points directly and never touch it. |
| **Zero inbound surface** | Scores arrive by outbound polling, so nothing has to reach your box from the internet. |
| **One box, no cloud** | Docker Compose plus one free GitHub org. Nothing billed, nothing phones home. |

**The Secure Development module** (graded through GitHub):

| Feature | What it means for you |
|---|---|
| **Patch-to-score scoring** | Contestants patch the vuln and open a PR; the pipeline scores it. Stock scores 0, a correct patch earns its points. |
| **6 targets, 321 challenges** | Juice Shop, DVWA, WebGoat, Security Shepherd, VulnerableApp, VAmPI — rubrics ship in the box. |

**The Quiz module** (graded in the app):

| Feature | What it means for you |
|---|---|
| **Instant grading, no GitHub** | Single/multi-select questions marked on submit, all-or-nothing on multi-select. No forks, no org, no pipeline. |
| **Authored from `/admin`** | Prompt, choices, answers, points, order — plus an attempt cap and retry cooldown. Live on the next request. |
| **Bulk authoring** | Author one at a time, or import and export the whole bank as one JSON bundle — the same format the Jeopardy board uses. |

**The Jeopardy module** (graded in the app):

| Feature | What it means for you |
|---|---|
| **Flags, checked instantly** | Organizer-authored challenges in categories with per-challenge points. Submissions are normalised, so stray whitespace never costs a solve — and casing does not either, unless a challenge is explicitly marked case-sensitive, which contestants are told on the card. |
| **Rich descriptions, bulk authoring** | A sanitised Markdown subset for descriptions; author in `/admin` or import/export the whole board as one JSON bundle. |

## A closer look

| Contestant breakdown | Challenge browser |
|---|---|
| ![A contestant's row expanded: per-module totals, then the per-target progress with each challenge's patched or open state](assets/hero.jpg) | ![The challenge browser: one card per vulnerable app, expandable to every challenge with its point value and OWASP category, searchable by challenge, app or OWASP code](assets/challenges.jpg) |

| Jeopardy flag board | Quiz |
|---|---|
| ![The Jeopardy board: challenges grouped by category as compact tiles — title, points, and a green check once solved — each opening the challenge's own page with the description and flag form](assets/flags.jpg) | ![The quiz: single- and multi-select questions, each showing its point value and remaining attempts, graded the moment you submit](assets/quiz.jpg) |

<sup>Captured from the contestant app with seeded demo players. The board ranks
<strong>teams</strong> by default and switches to individual standings; anything
solved by more than one teammate counts <strong>once</strong>, so a team's total
can be less than its members' scores added up. Targets and fork links are
event-config driven; the event name and its branding are admin-panel
settings.</sup>

## What organizers run

One guided command takes you from an empty checkout to a running, scored event —
it asks for each value inline and does every automatable step.

![The ctf-setup.sh guided wizard: ASCII banner and step-by-step prompts](assets/wizard.jpg)

`ctf-setup.sh doctor` then verifies the whole org at a glance — one row per fork,
one column per provisioning step, confirming even the UI-only steps it can read
back by API.

![ctf-setup.sh doctor status matrix: one row per fork, one column per step](assets/doctor.jpg)

## Targets (Secure Development module)

The module's content is a set of vulnerable targets. Every event that
provisions Secure Development provisions all six; pick any subset for
contestants to actually see from `/admin` → Secure Development → Targets —
nine challenges for a two-hour club session, all 321 for a semester.

| Target | Challenges | Points |
|---|---:|---:|
| `vulnerableapp` | 110 | 187 |
| `webgoat` | 69 | 137 |
| `dvwa` | 55 | 108 |
| `securityshepherd` | 40 | 79 |
| `juice-shop` | 38 | 141 |
| `vampi` | 9 | 16 |

Every target's rubric is vendored from the upstream event repo, pinned to a
single commit, and gated: a test that passes against the *unpatched* app would
be a free point for every contestant, so CI scores every rubric against the
stock upstream image and fails if anything scores above zero
(`.github/workflows/stock-scores-zero.yml`, `scripts/acceptance-target.sh`).

## Quickstart

The full, canonical sequence — tooling check, scorer image, the four `.env`
bootstrap keys, the sync GitHub App, the sign-in OAuth app, org provisioning,
and bringing the box up — lives in
[Hosting → Quickstart: zero to a scored event](hosting.md#quickstart-zero-to-a-scored-event).

Scores reach the box by outbound polling, and that is the only transport there
is (push ingest was removed in v0.6, #377). It needs no inbound network
access — nothing has to reach your box from the internet, so a campus network,
a locked-down lab or venue wifi works without a firewall change. Full
prerequisites, OAuth setup and the transport itself are in
[Hosting](hosting.md).

## Teams

Scoring is per team, and **a team is required** — nothing a contestant solves
counts until they are on one. Contestants self-register in the app: create a
team to become its captain and get a join code, join by code, or hit **Play
solo** for a one-click team of one. The join code doubles as a shareable
`/join/<code>` link. Captains manage the roster (rename, remove, transfer,
disband, regenerate the code). The leaderboard ranks teams, each row expanding to its
members with their individual points — and a flag solved by several teammates
counts **once**, so a team's total can be less than its members' scores added
up. Organizers open or close registration from the admin panel. See
[Operations](operations.md#teams).

![An expanded team row on the leaderboard: member chips with each player's own points, then one progress row per module showing what it contributed to the total, each opening into its own per-item detail](assets/leaderboard-team.jpg)

<sup>A team row, expanded: who's on it, what each module contributed, and a
row per module that opens into its own detail — the whole total accounted for
in one place.</sup>

## Organizer admin panel

Anyone named in `.env`'s `ADMIN_LOGINS` can sign in and reach `/admin` — and
from there **grant admin to anyone else**, without a restart. The panel is
tabbed: **Event** (freeze, registration, the scoring and registration
schedules, players per team, the score cooldown, demo seed, master reset),
**Admins**, **Support**, **Activity**, **Insights**, then one tab per enabled
module for its own knobs and its title/blurb.

The **freeze** switch pauses ingestion, not fork Actions — PRs keep getting
judged, nothing is lost, it is only queued until you resume.

**Support** acts on one contestant or one team mid-event: look someone up,
reset their progress, delete them, or take over a team whose captain has
vanished. It exists because the master reset used to be the only destructive
control, so a single stuck contestant meant choosing between doing nothing and
wiping the event.

**Activity** is the live event log — sign-ins, solves, and team changes,
newest first, filterable by type and login. Entries name the challenge or
team involved, never a flag or an answer, and only the most recent few
thousand are kept.

**Insights** reports engagement — participation funnel, solves over time, a
hardest-first challenge table with solve rate and time-to-solve, and hint
usage — computed entirely from data the box already stores. Nothing is
collected from contestants' forks.

Every change is recorded in a capped audit log. See
[Operations](operations.md#organizer-admin-panel) for the full picture.

## Learn more

Pick the doc for what you're doing right now:

**Standing the kit up**

- [Hosting](hosting.md) — the guided wizard, prerequisites, how scores reach
  the box, the GitHub OAuth app, and event config.
- [Deploy on AWS](aws.md) — single-shot Terraform deploy onto ECS Fargate with
  ElastiCache behind an ALB (`apply` up, `destroy` down).
- [Deploy on fly.io](fly.md) — the whole stack as one Fly machine, running the
  repo's own `docker-compose.yml`, no box to administer (`deploy.sh` up,
  `fly apps destroy` down).
- [Security checklist](security-checklist.md) — the one-page pre-event walk:
  HTTPS, secrets, the private scorer image and its per-fork grant, the org
  secrets an earlier event may have left behind, and the admins list.

**Running an event**

- [Operations](operations.md) — teams, the admin panel, live-event support,
  verifying the kit, the local dev-stack, and teardown. It also carries the
  three app-side modules' organizer guides: [Quiz](operations.md#quiz),
  [Jeopardy](operations.md#jeopardy) and [AI](operations.md#ai).
- [Troubleshooting](troubleshooting.md) — the mid-event runbook: symptom,
  diagnosis, fix.

**Under the hood**

- [Architecture](architecture.md) — what runs where, how a score gets from a
  contestant's PR to the leaderboard.
- [Module contract](modules.md) — what a CTF vertical must satisfy to plug in.
- [AI module](ai-module.md) — the external integrator's contract for the `ai`
  module: launch tokens, verifying them, and reporting a solve back.
- [Scorer](scorer.md) — both rubric grammars, building your own scorer image,
  and wiring the self-contained scoring workflow.
- [Decisions](decisions.md) — numbered ADRs for why the kit is built the way
  it is.
- [Reviewing](reviewing.md) — the review guideline: the invariants a PR
  review here must verify, and the deliberate decisions not to re-flag.
- [Glossary](glossary.md) — the terms an outsider trips on (target, module,
  rubric, marker, the poll transport, …) and the project's six names.

## Status

The kit is complete, tested offline and running live: the smoke test
(`scripts/smoke.sh`) exercises the whole poll pipeline end to end, every
target's rubric is gated against the unpatched app, the full live-GitHub
scoring path ships in-kit, and a hosted instance runs continuously from the
Compose file this repo ships — an end-to-end pass over it is where a batch of
real defects were found and fixed. What it still awaits is a first real event:
a cohort of contestants driving real PRs through real GitHub, at once. The
known limits, stated in the open, are in
[Status and upstream dependencies](operations.md#status-and-upstream-dependencies).

---

[Source on GitHub](https://github.com/dcotelo/owasp-ctf) ·
[OWASP-CTF/dc34-owasp-secure-development-ctf](https://github.com/OWASP-CTF/dc34-owasp-secure-development-ctf)
(underlying spec and target apps)
