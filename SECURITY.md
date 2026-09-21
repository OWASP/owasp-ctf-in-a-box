# Security Policy

## Supported versions

Releases are cut as repo-level tags (`v0.1.0`, `v0.2.0`, `v0.3.0`, …), but
only the latest release and the `main` branch are supported — fixes land on
`main` and ride the next tag; nothing is backported. Please report issues
against the latest commit on `main`.

## Before you run an event

If you are standing this kit up rather than reporting an issue with it, walk
the [organizer security checklist](https://owasp.github.io/owasp-ctf-in-a-box/security-checklist.html)
first. Every item on it is a deployment decision the kit cannot make for you,
and most have no visible symptom when they are wrong.

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** for this repository
rather than opening a public issue:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected component, and steps to reproduce.

This opens a private advisory visible only to maintainers, so the report
stays confidential while a fix is worked out.

Do not report vulnerabilities through public GitHub issues, discussions, or
pull requests.

## What to report here

**OWASP CTF in a Box is a deliberately-vulnerable-by-design *training*
kit.** The target applications it hosts (Juice Shop, DVWA, WebGoat, Security Shepherd,
VulnerableApp, VAmPI, and any future module targets) are **intentionally
vulnerable** — finding and patching their flaws is the point of the exercise.
Please do **not** report vulnerabilities in the target apps themselves here;
those belong with the respective upstream projects.

What we do want reports on is the **kit's own infrastructure** — the code
that operates the event, not the practice targets it hosts:

- `scorer/` — the judge and leaderboard scoring engine
- `sync/` — the poll/push scoring transport
- `apps/web/` — the contestant web app (auth, teams, admin panel)
- `setup/` — `ctf-setup.sh` and event provisioning
- `deploy/` — the optional cloud deploy modules (IAM roles, security groups,
  secrets handling, cloud-init bring-up)
- `patches/` — the reference patches shipped for the targets
- `scripts/`, `.github/workflows/` — CI, smoke tests, and automation

Examples of what's in scope: authentication or authorization bypass in the
web app, a way to forge or replay a score submission, a way to escalate
outside your own team's data, secrets handling issues, or a supply-chain
concern in the kit's own build/CI pipeline.

## Known properties, stated so they are not re-reported

- **Jeopardy-module flags and quiz answer keys are stored in plaintext** in
  Redis (`ctf:classic:flag`, `ctf:quiz:key`) and are **readable by every
  `/admin` user** — the admin edit forms return them verbatim, deliberately,
  so an organizer can fix a typo'd flag mid-event. Contestant-facing code
  paths never read either key. The secrecy boundary is `/admin` membership
  and Redis access, not encryption; organizers should grant admin
  accordingly. A bypass that exposes these keys to a **non-admin** is very
  much in scope.
- **The scorer runs contestant-submitted code** inside sandboxed containers —
  judging submitted code is the product. An escape from that sandbox is in
  scope; the fact that it executes submissions is not.

## Response expectations

We aim to:

- Acknowledge a new report within **5 business days**.
- Provide an initial assessment (confirmed, needs more info, or out of scope)
  within **10 business days**.
- Keep the reporter updated as a fix is developed, and credit them in the
  advisory unless they ask to remain anonymous.

This is a community-maintained project run on a best-effort basis; response
times may vary.
