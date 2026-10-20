# Copilot instructions

Read `AGENTS.md` (build, test, CI and repo conventions) and
`docs/reviewing.md` (what a review must verify, and what not to flag) before
reviewing or changing code here. They are the authority; this file is the
short version, kept short because Copilot code review reads only the start
of it.

## Reviewing a pull request

Verify claims against the code, not the PR description, and cite
`file:line`. Every finding names a concrete failure scenario (inputs or
state, then the wrong output). Prefer the smallest fix. Do not restate the
diff or praise it.

The invariants this repo has been burned by (detail in `docs/reviewing.md`,
Section 1):

1. **Secrecy boundary.** No contestant-reachable path may read a quiz answer
   key, a classic flag or unpurchased hint text. Four layers pin it (store,
   route, view-model, markup); weakening one is a finding.
2. **Lua decides scores.** `SUBMIT_SCRIPT`, `GRADE_SCRIPT` and
   `AWARD_SCRIPT` are the authority; moving a guard out of the script into
   JS is a regression. A script change needs a `*.lua.upstash.test.ts`
   change.
3. **Fail direction is chosen per gate.** A diff that flips fail-open to
   fail-closed (or back) without a test and a reason is a bug.
4. **Tests must be able to fail.** Watch for vacuous passes: a check that
   "the exploit was blocked" while the target was down or unseeded.
5. **Score-comment trust chain.** The `ctf-score` marker comes only from
   the judge's output in `CTF_OUT_DIR`, never the PR checkout, and is
   posted only when the scorer step succeeded.
6. **Three-reader lockstep.** The pause and window rules in `apps/web`,
   `scorer` and `sync` change together, or the diff says why not.
7. **Allowlist, never sweep.** Exports and log lines enumerate known
   fields; a `SCAN ctf:*`, a spread or a denylist is a finding.
8. **Destructive paths validate first, then destroy.** A destructive UI
   control needs a confirmation the test proves gates the call.
9. **Presence is not discoverability.** A shipped feature's test asserts
   its link, nav item or button exists.
10. **No build-time config.** No `process.env` read reaches a client
    component, and `/` is never statically prerendered.
11. **The public surface is a named list.** A new `/api` route without a
    session or verified launch token needs its own stated case.
12. **`requireAdmin` gates per-contestant data.** A self-service read takes
    the caller from a verified token or session, never from the request.
13. **A `catch` logs a label, never the caught object** (`errorLabel(err)`).
    Validation errors name the position and rule, never the submitted value.

Also from `AGENTS.md`:

- **`upstashPipeline` does not throw per command.** Reading `.result`
  without checking `.error` turns a Redis error into a default.
- **Logins join case-insensitively.**
- **Comments explain the present.** No history ("used to", "added in
  #N"), no narration of the next line.

## Changing code

Conventional Commits, no AI attribution. A change under `apps/`, `sync/`,
`scorer/`, `setup/` or `deploy/` adds a line under `## Unreleased` in
`CHANGELOG.md`. Bash must run on macOS bash 3.2. Run the suites on Node 22.
