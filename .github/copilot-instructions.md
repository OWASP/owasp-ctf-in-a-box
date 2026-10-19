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
5. **`upstashPipeline` does not throw per command.** Reading `.result`
   without checking `.error` turns a Redis error into a default.
6. **Three readers of the pause/window rules** (`apps/web`, `scorer`,
   `sync`) change in lockstep.
7. **Logins join case-insensitively.**
8. **A `catch` logs a label, never the caught object.**
9. **Export allowlists, never sweeps.** Destructive paths validate first.
10. **Comments explain the present.** No history ("used to", "added in
    #N"), no narration of the next line.

## Changing code

Conventional Commits, no AI attribution. A change under `apps/`, `sync/`,
`scorer/`, `setup/` or `deploy/` adds a line under `## Unreleased` in
`CHANGELOG.md`. Bash must run on macOS bash 3.2. Run the suites on Node 22.
