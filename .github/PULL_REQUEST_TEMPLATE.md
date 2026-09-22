<!-- This template is for contributing to the kit itself
     (platform code, scorer, sync, setup, docs). If you're a contestant
     submitting a patch to a target app during an event, you want
     setup/PULL_REQUEST_TEMPLATE.md in the event fork instead — this one
     is not it. -->

## Summary

<!-- What does this PR change, and why? -->

## Type

- [ ] feat
- [ ] fix
- [ ] docs
- [ ] test
- [ ] chore
- [ ] ci

## Service(s) touched

- [ ] apps/web
- [ ] scorer
- [ ] sync
- [ ] setup
- [ ] docs

## Test evidence

<!-- List the commands you ran locally and their outcome, e.g.: -->
<!-- cd scorer && npm ci && npm test -->
<!-- ./scripts/acceptance-scorer.sh -->

## Checklist

- [ ] CI is green.
- [ ] My tests can FAIL: I can name the single-token mutation of this change
      that each new/changed test would catch. (A test satisfiable whether or
      not the code works is this repo's recurring failure mode — see
      [docs/reviewing.md](../docs/reviewing.md), invariant 4.)
- [ ] I checked [docs/reviewing.md](../docs/reviewing.md) for the invariants
      this PR touches (secrecy boundary, Lua authority, fail direction,
      destructive-path ordering, three-reader lockstep) — and didn't
      re-litigate anything in its "what not to flag" list.
- [ ] Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`,
      `test:`, `chore:`, `ci:`, ...).
- [ ] No AI attribution in commits or this PR (no "Generated with", no
      `Co-authored-by:` trailers for an AI tool/agent).
- [ ] Docs updated if this changes user-facing behavior or commands.
- [ ] **Breaking changes declared**: if this changes a published contract
      (an `.env` key, a `ctf:*` Redis key name or value shape, scorer
      HTTP payloads, a `ctf-setup.sh` subcommand/flag), the summary above
      says so explicitly and includes an upgrade note for a running event.
      Write "None" if there are none — the breaking-change pre-merge check
      blocks on an undeclared one.
