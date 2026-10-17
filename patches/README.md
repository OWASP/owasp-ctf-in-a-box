# Reference patches — `patches/<target>/`

A **reference patch** is a minimal, real source fix that closes exactly one
challenge's vulnerability in a target app. It is the input to the
**positive-direction** scoring gate (`scripts/acceptance-patched.sh`): proof that a
*correctly patched* contestant fork scores the points it should — the mirror of
`scripts/acceptance-target.sh` (`stock-scores-zero`), which only proves an
*unpatched* app scores nothing.

## Why this exists

The kit scores a contestant by running executable `node:test` challenge suites
against their app. Each suite *exploits* a vulnerability and asserts the exploit
does **not** succeed, so a challenge scores as "patched" only when the vuln is
genuinely closed. Nothing else in the kit proves the *positive* direction — a
scorer that quietly stopped awarding points for a real fix would pass every other
gate. These patches close that gap.

## The convention

```
patches/<target>/<challenge-id>.patch
```

- `<challenge-id>` is the lowercased catalogue key
  (`Challenge-3-SQLi` → `challenge-3-sqli`), the same id the scorer reports and
  stores.
- Each file is a **`git`-format unified diff** rooted at the app source tree. The
  harness applies it with `git apply`.
- A patch fixes the vulnerability in **source**, such that the exploit fails. The
  fix must be **surgical**: it closes its one challenge and leaves the app
  otherwise healthy and still vulnerable everywhere else. A patch that breaks the
  build or boot would *also* stop the exploit — and score the challenge "patched"
  for the wrong reason. The harness rejects that (see below).

## Which source tree each patch targets

The patched gate stages a **pinned source tree** and applies the reference patch to
it. `scripts/acceptance-patched.sh` carries a per-target pin (a commit SHA, never a
branch or tag — either can move and silently score a different app):

- **vampi** stages the upstream `erev0s/VAmPI` at the same commit
  `setup/targets.tsv` pins.
- **The other five** stage an `OWASP-CTF/<target>` repo at the script's own SHA.
  Those trees are not the source a contestant forks: `setup/ctf-setup.sh` forks
  each target from the upstream repo and `ref` in `setup/targets.tsv`. The
  per-challenge fixes are extracted from the private rubric repo's
  `solutions/<target>/patch.diff` and apply to the staged tree, so each minimal
  patch is a strict subset of a fix known to score there.

## How the harness uses them

`scripts/acceptance-patched.sh <target> <challenge-id>`:

1. Builds the scorer image, stages the pinned source, applies the patch
   (`git apply --check` first, so a stale patch fails loudly).
2. Builds the fork from its own root `Dockerfile` — the same path a real
   contestant PR takes — and runs the judge over **every** challenge.
3. Asserts the **positive** result: exactly the patched challenge is solved, its
   points equal the catalogue difficulty (parsed straight from the catalogue JSON,
   independent of the scorer's loader), and the other `N-1` challenges still fail.
   `N` is derived from the catalogue, not hardcoded.

### Anti-vacuous discipline

A *real* positive must be told apart from a broken app that merely stopped being
exploitable. Three signals do that:

- The judge writes `ctf-score.md` **only when every challenge was measured**. If
  the app stops answering mid-run the exec runner aborts and writes nothing (see
  `scorer/src/judge.js`, `run.aborted`) — so the report existing at all proves all
  `N` challenges ran. "1/N with the others unreached" cannot occur.
- Exactly one `✅ Patched` and `N-1` `❌ Not yet`. A `❌` means that challenge's
  exploit *ran and succeeded* — the app is up and still genuinely vulnerable there.
- **Positive control.** The `N-1` failing rows prove the app is live for every
  challenge *except* the patched one — so on their own they cannot tell "vuln
  closed" from "endpoint broke" for the `✅` row (an exploit test that only asserts
  the exploit is absent scores `✅` just as well if the patched route now 500s or
  was gutted to return nothing). So the harness boots the patched app and probes
  the endpoint the patch touched with a **benign, valid** request: it must still
  serve real data. A broken/gutted endpoint FAILS the gate.

The control has three strategies, by target shape:

| Strategy     | Targets                               | How the control boots + probes |
| ------------ | ------------------------------------- | ------------------------------ |
| `standalone` | vampi, juice-shop, webgoat, vulnerableapp | boot the single patched image, probe its endpoint |
| `with-db`    | dvwa                                  | boot the app + a MariaDB sibling, init the DB, log in, probe a benign row |
| `exempt`     | securityshepherd                      | see below |

**securityshepherd is control-exempt.** It runs as a three-container Maven/TLS
stack (Tomcat + MariaDB + Mongo) built by the bring-up with no prebuilt image, so
it cannot be re-booted standalone here. Its anti-vacuous guarantee rests on the two
in-judge signals only (report-exists ⇒ all `N` measured; `N-1` genuinely failed ⇒
app live and vulnerable). The one residual gap — a patched row "scored" by breaking
its own endpoint — is not closed by a standalone probe for this target, and is
called out honestly rather than papered over.

## Coverage — honest status

One challenge per target, enough to prove the mechanism (and, across vampi's and
securityshepherd's two each, that the assertion *discriminates* — patching one
scores that one and not another).
This is **not** full per-challenge coverage; the remaining challenges are follow-on
work, each needing its own patch authored and verified against a real build.

| Target            | Challenge id                          | Pts | File patched (fix) | Control | Build-verified |
| ----------------- | ------------------------------------- | :-: | ------------------ | ------- | -------------- |
| vampi             | `challenge-3-sqli`                    |  2  | `models/user_model.py` — parameterize the username lookup | standalone | ✅ |
| vampi             | `challenge-1-excessive-data-exposure` |  1  | `api_views/users.py` — `/_debug` drops password/admin fields | standalone | ✅ |
| juice-shop        | `challenge-1-password-hash-leak`      |  2  | `routes/currentUser.ts` — allow-list the `?fields=` projection | standalone | ✅ |
| dvwa              | `challenge-7-sql-injection-low`       |  1  | `vulnerabilities/sqli/source/low.php` — cast `id` to int | with-db | ✅ |
| webgoat           | `challenge-23-sql-injection-dml-update` | 2 | `…/sqlinjection/introduction/SqlInjectionLesson8.java` — parameterize attack8 | standalone | ✅ |
| vulnerableapp     | `challenge-33-error-sqli-level-1`     |  1  | `…/sqlInjection/ErrorBasedSQLInjectionVulnerability.java` (Level-1) — parameterize + swallow error; **adds a root `Dockerfile`** (fork ships only `Dockerfile.base`) | standalone | ✅ |
| securityshepherd  | `challenge-23-sqli-1`                  |  1  | `…/servlets/module/challenge/SqlInjection1.java` — `PreparedStatement` | exempt | CI-only |
| securityshepherd  | `challenge-10-idor-2`                  |  2  | `…/servlets/module/challenge/DirectObject2.java` — allow-list the five exposed `userId`s; anything else gets the not-found response without a query | exempt | CI-only |

`Build-verified` = the patched fork was actually built and judged (locally and/or
in CI) and the gate passed. securityshepherd's patches are authored and apply-clean
but its multi-container Maven build is not run outside CI.

## Pinning

Each target's source pin lives in `scripts/acceptance-patched.sh` (overridable via
the `*_UPSTREAM_REF` env vars). Bump a pin only together with a fresh run of the
gate and a re-verification (or regeneration) of that target's patch against the new
tree.
