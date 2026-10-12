#!/usr/bin/env bash
# ci-changes.sh — map a PR's changed files to the CI areas they must run.
#
# Usage: scripts/ci-changes.sh <changed-files>   one path per line
#        scripts/ci-changes.sh --all              every area true
#
# Prints one `area=true|false` line per area, in a fixed order, for the
# `changes` job in .github/workflows/ci.yml to append to $GITHUB_OUTPUT. That
# job passes --all for anything but a pull_request, so a push to main runs
# every area whatever the merged PR touched.
#
# The matcher reads the list from a FILE, never from a pipe: under
# `pipefail`, `printf "$list" | grep -q` loses the race once the list passes
# the 64 KiB pipe buffer — grep exits on the first match, printf takes
# SIGPIPE, and the pipeline reports failure for a path that matched, which
# skipped the area silently.
#
# Fails closed: a missing or unreadable list is an error (exit 2), never "no
# area touched". An empty list is a real answer (a PR with no file changes).
#
# bash 3.2 compatible; no jq, no python.
set -euo pipefail

AREAS="app scorer sync shell smoke quiz classic ai docs registries"

if [ "$#" -ne 1 ]; then
  echo "ci-changes: usage: $0 <changed-files> | --all" >&2
  exit 2
fi

if [ "$1" = "--all" ]; then
  for area in $AREAS; do echo "$area=true"; done
  exit 0
fi

list="$1"
if [ ! -f "$list" ] || [ ! -r "$list" ]; then
  echo "ci-changes: cannot read the changed-file list '$list' — refusing to report every area untouched" >&2
  exit 2
fi

# Editing the workflow or this script re-runs every area: a change to the
# filter itself is untargeted.
CI='|^\.github/workflows/ci\.yml$|^scripts/ci-changes\.sh$'

# A pattern that matches nothing in the list is "false"; grep's exit 2 (a bad
# regex, an unreadable file) is an error, not "no match".
m() {
  local rc=0
  grep -qE -- "$1" "$list" || rc=$?
  case "$rc" in
    0) echo true ;;
    1) echo false ;;
    *) echo "ci-changes: grep failed (exit $rc) on pattern: $1" >&2; exit 2 ;;
  esac
}

# emit <area> <pattern>. The assignment is what carries m's exit 2 out of the
# command substitution under `set -e`; `echo "x=$(m ...)"` would swallow it
# and print an empty value.
emit() {
  local v
  v="$(m "$2")"
  echo "$1=$v"
}

# app
# - setup/targets.tsv is the ONLY authoritative source of a fork's repo name
#   (ctf-setup.sh forks with --fork-name derived from it); app and sync each
#   keep a copy pinned to it by a differential test, which has to run on the
#   commit that edits the tsv.
# - The shared window corpora are read by the app, scorer AND sync suites, and
#   the secure-dev-targets corpus by the app and sync suites: a corpus-only
#   edit must run every reader.
# - caddy/ is here because security-headers.test.ts pins Caddy's header block
#   to the values next.config.ts sends, and the app job runs `caddy validate`.
# - The vendored rubric catalogues are here because apps-catalogue.test.ts
#   pins apps.ts's static fallback counts to them.
emit app '^apps/web/|^caddy/|^setup/targets\.tsv$|^scripts/acceptance-app\.sh|^test/fixtures/(scoring-)?window-corpus\.json$|^test/fixtures/secure-dev-targets-corpus\.json$|^scorer/rubric\.owasp/[^/]+/tests/challenges/catalogue\.[^/]+\.json$'"$CI"

# scorer
# sync/src/parse.js rides the scorer filter: acceptance-scorer.sh imports the
# REAL parser as the one live cross-check of the marker/grammar contract.
emit scorer '^scorer/|^sync/src/parse\.js$|^scripts/acceptance-scorer\.sh|^test/fixtures/(scoring-)?window-corpus\.json$'"$CI"

# sync — targets.tsv and the corpora for the reasons given under app.
emit sync '^sync/|^setup/targets\.tsv|^test/fixtures/(scoring-)?window-corpus\.json$|^test/fixtures/secure-dev-targets-corpus\.json$'"$CI"

# shell
# - deploy/fly's checks ARE shell: a bats suite plus a shellcheck'd script.
# - scorer/consumer-workflow.example.yml: the bats suite pins its security
#   posture (the unsafe-checkout opt-in, persist-credentials: false).
# - docker-compose.yml: fly.bats renders and asserts on the REAL file, and
#   pins.bats checks every image: line there and in docker-compose.smoke.yml.
# - deploy/aws-terraform's script and bats suite are shell; its .tf files
#   belong to terraform.yml.
# - sync/docker-entrypoint.sh and scorer/entrypoint* are shellcheck'd here.
# - docs/decisions.md, the Makefile, AGENTS.md and CONTRIBUTING.md: the
#   check-docs-drift suite pins the ADR index and the local copies of the
#   shell job's commands. .nvmrc and every workflow: its node-version rule.
# - The audited apps/web/ files: check-comment-policy.bats asserts on them.
emit shell '^scripts/|^setup/|^deploy/fly/|^deploy/aws-terraform/deploy\.sh$|^deploy/aws-terraform/test/|^sync/Dockerfile$|^sync/docker-entrypoint\.sh$|^docker-compose\.yml$|^docker-compose\.smoke\.yml$|^scorer/consumer-workflow\.example\.yml$|^scorer/entrypoint|^docs/decisions\.md$|^Makefile$|^AGENTS\.md$|^CONTRIBUTING\.md$|^\.nvmrc$|^\.github/workflows/|^apps/web/src/lib/classic-store\.ts$|^apps/web/src/lib/admin-store\.ts$|^apps/web/src/lib/modules\.ts$|^apps/web/src/lib/quiz-store\.ts$|^apps/web/src/lib/ai-store\.ts$|^apps/web/src/lib/leaderboard/module-contributions\.ts$|^apps/web/src/app/\(site\)/admin/admin-controls\.tsx$|^apps/web/src/lib/event-store\.ts$|^apps/web/src/lib/metrics-store\.ts$|^apps/web/src/lib/__tests__/admin-store\.seed\.test\.ts$|^apps/web/src/lib/leaderboard/__tests__/module-contributions\.test\.ts$|^apps/web/src/lib/team-store\.ts$|^apps/web/src/app/\(site\)/admin/__tests__/admin-controls\.test\.tsx$|^apps/web/src/lib/admin-ops-store\.ts$|^apps/web/src/lib/demo-seed\.ts$|^apps/web/src/app/\(site\)/admin/use-admin-settings\.ts$|^apps/web/src/app/\(site\)/admin/use-admin-nav\.ts$|^apps/web/src/app/\(site\)/admin/admin-danger-actions\.ts$|^apps/web/src/lib/module-defs/secure-development\.ts$|^apps/web/src/lib/module-defs/quiz\.ts$|^apps/web/src/lib/module-defs/classic\.ts$|^apps/web/src/lib/module-defs/ai\.ts$|^apps/web/src/lib/admin-audit-keys\.ts$|^apps/web/src/lib/module-urls\.ts$|^apps/web/src/lib/redis-decode\.ts$|^apps/web/src/app/\(site\)/admin/use-admin-restamp\.ts$|^apps/web/src/app/\(site\)/admin/admin-changed-at\.tsx$|^scripts/lib/acceptance-lib\.sh$'"$CI"

# smoke
# - sync/: smoke runs the REAL sync service (docker-compose.smoke.yml
#   overrides only its environment) — the one end-to-end proof of the poll
#   pipeline.
# - scorer/ is deliberately absent: the same override file replaces the
#   scorer with test/fixtures/mock-scorer.mjs, so no scorer source change can
#   affect this job.
# - caddy/ is absent too: smoke never brings caddy up.
# - test/fixtures/: docker-compose.smoke.yml builds both mock services from it.
emit smoke '^docker-compose|^scripts/smoke\.sh|^setup/|^sync/|^\.env|^scorer/consumer-workflow|^test/fixtures/'"$CI"

# quiz / classic / ai — each proves compose end to end across the app
# (module gating, its pages, the leaderboard) and sync (the
# refuses-without-GITHUB_ORG contract), plus docker-compose.yml itself.
emit quiz '^apps/web/|^sync/|^docker-compose\.yml$|^scripts/acceptance-quiz-only\.sh$|^scripts/lib/acceptance-lib\.sh$'"$CI"
emit classic '^apps/web/|^sync/|^docker-compose\.yml$|^scripts/acceptance-classic-only\.sh$|^scripts/lib/acceptance-lib\.sh$'"$CI"
emit ai '^apps/web/|^sync/|^docker-compose\.yml$|^scripts/acceptance-ai-only\.sh$|^scripts/lib/acceptance-lib\.sh$'"$CI"

# docs — the Pages site is built from docs/ ALONE (pages.yml sets
# `source: docs`). README.md is in pages.yml's trigger paths but is not part
# of the site, so it is deliberately absent here.
emit docs '^docs/|^\.github/workflows/pages\.yml$'"$CI"

# registries — the three independently-maintained TARGET lists the check
# compares, plus the check script itself. It compares no MODULE list: module
# registration lives in apps/web alone.
emit registries '^(sync/src/config\.js|apps/web/src/lib/apps\.ts|scorer/src/targets\.js|scripts/check-module-registries\.mjs)$'"$CI"

