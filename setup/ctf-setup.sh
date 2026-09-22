#!/usr/bin/env bash
# ctf-setup — provision a disposable GitHub org for a self-hosted OWASP CTF in a Box event.
#
# Subcommands (run with NO subcommand, or `wizard`, for the guided setup):
#   wizard    DEFAULT — step-by-step zero-to-scored: inspects state and only
#             prompts for what's missing. Asks for each value inline (the
#             bootstrap keys GITHUB_ORG / ADMIN_LOGINS / SCORE_IMAGE, EVENT_URL,
#             App/OAuth credentials) with instructions + URLs,
#             writing them as you go — no editing files by hand between steps.
#             Guides + verifies each UI-only step. Resumable (safe to re-run).
#             Ends by OFFERING an optional fly.io deploy (default no).
#             Orchestrates the subcommands below.
#   check     verify local prerequisites (gh auth, docker, compose)
#   secrets   generate .env secret values
#   org       fork targets, render scoring workflows from the in-repo template
#             + print install steps, mirror scorer image
#             (idempotent/re-runnable: every step is skipped once its
#             target state is already satisfied, so re-running `org` after
#             a partial run or failure just resumes where it left off)
#   render    (re)render just the per-target scoring workflows into dist/workflows/
#   upgrade   re-commit the rendered scoring workflow to every fork whose
#             committed copy is behind the template's
#             `# ctf-workflow-version:` stamp — how a fix to ctf-score.yml
#             reaches an event that is ALREADY provisioned (`org` does this
#             too, but also re-mirrors the scorer image)
#   teardown  archive event repos after the event
#   doctor    read-only status check: verify a previously-provisioned org
#             matches targets.tsv (no mutation, no --dry-run needed)
#   app-manifest  open a self-submitting form to create the sync GitHub App
#                 from sync/app-manifest.json against the event org (removes
#                 the manual JSON copy-paste; you still click Create/Install)
#   app-config    ingest a downloaded App private key (.pem) + App ID into
#                 .env (--app-id N --pem path [--installation-id N])
#   oauth-app     open GitHub's new-OAuth-App page for the event org and print
#                 the exact field values (signin auth; UI-only, no auto-fill)
#   oauth-config  write the OAuth client id + secret into .env (--client-id ID;
#                 the secret is read from a hidden prompt, never on argv)
#
# Every setting this script reads comes from the env file (.env by default,
# --out elsewhere): GITHUB_ORG names the event org, ADMIN_LOGINS says who may
# open /admin, and SCORE_IMAGE being NON-EMPTY is how a box says "this event
# runs Secure Development" — with it empty there are no forks to provision, no
# scorer to mirror and nothing to poll. Which modules run, and which Secure
# Development targets, are runtime settings in /admin (config v2, #386).
#
# Global flags: --dry-run (print mutating commands), --out <path> (default .env)
set -euo pipefail

# Resolve repo-relative paths from the script's own location, not the cwd.
# BASH_SOURCE (not $0) so this also resolves correctly when the script is
# sourced for its helpers (e.g. `CMD=__selftest source ctf-setup.sh`), where
# $0 is the sourcing shell's own name rather than this file's path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
WORKFLOW_TEMPLATE="$SCRIPT_DIR/../scorer/consumer-workflow.example.yml"

# ANSI colors — only when stdout is a TTY and NO_COLOR is unset (respect the
# NO_COLOR convention + non-interactive/piped output stays plain for logs/CI).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=; C_BOLD=; C_CYAN=; C_GREEN=; C_YELLOW=; C_RED=
fi

PROVENANCE_TSV="$SCRIPT_DIR/targets.tsv"

# target -> provenance column. col: 2=upstream_repo, 3=ref, 4=stock_image.
prov_field() {
  local t="$1" col="$2" line
  line=$(grep -v '^[[:space:]]*#' "$PROVENANCE_TSV" | awk -F'\t' -v t="$t" '$1==t {print; exit}')
  [ -n "$line" ] || { echo "unknown target: $t" >&2; return 1; }
  printf '%s\n' "$line" | cut -f"$col"
}

# The fork's repo name = basename of the upstream repo (owner/Name -> Name).
prov_repo_name() {
  local repo; repo="$(prov_field "$1" 2)" || return 1
  echo "${repo##*/}"
}

# gh api read as a boolean (no output, no failure propagation).
gh_ok() { gh api "$@" >/dev/null 2>&1; }

# A just-created fork isn't instantly queryable — poll briefly.
wait_for_repo() {
  local slug="$1"
  for _ in 1 2 3 4 5; do gh_ok "repos/$slug" && return 0; sleep 2; done
  return 1
}

# GitHub indexes a fresh fork's Actions workflows ASYNCHRONOUSLY, so a read
# right after forking can return a partial (or empty) list — which made
# disable-inherited vacuously report "already done" while inherited workflows
# (ci/lock/stale/pr-compliance — the ones that auto-close contestant PRs) were
# still landing, active. Wait until the workflow count is stable across two
# reads. Best-effort + bounded; aborts immediately if the API errors (the
# caller's own `|| return 1` then decides), so it never sleeps in that case.
wait_workflows_settled() {
  local slug="$1" prev="" cur _
  for _ in 1 2 3 4 5 6; do
    cur="$(gh api "repos/$slug/actions/workflows" --jq '.total_count' 2>/dev/null)" || return 0
    if [ "$cur" = "$prev" ]; then return 0; fi
    prev="$cur"; sleep 5
  done
  return 0
}

# Create/update a file on the fork's ctf branch. $1=org/name $2=repo-path
# $3=local-content-file. Idempotent: fetches the existing sha to update in place.
put_contents_ctf() {
  local slug="$1" path="$2" src="$3" b64 sha msg
  b64="$(base64 < "$src" | tr -d '\n')"
  sha="$(gh api "repos/$slug/contents/$path?ref=ctf" --jq '.sha' 2>/dev/null || true)"
  msg="ctf-setup: add $path"
  if [ -n "$sha" ]; then
    gh api -X PUT "repos/$slug/contents/$path" -f "message=$msg" -f "content=$b64" -f "branch=ctf" -f "sha=$sha" >/dev/null
  else
    gh api -X PUT "repos/$slug/contents/$path" -f "message=$msg" -f "content=$b64" -f "branch=ctf" >/dev/null
  fi
}

STEPS="fork ctf-branch drop-old protect workflow disable-inherited pr-template vapp-dockerfile"

# Read-only verifiers for the three UI-only steps. GitHub exposes no API to
# PERFORM any of them (leaving a fork network, setting package visibility, and
# granting a fork Read on the package are all UI-only), but each has a
# queryable RESULT — so doctor confirms instead of blindly reminding. The
# third has no read endpoint of its own and is verified by observation
# instead; see `pull_grant_status`.
fork_detached() { [ "$(gh api "repos/$1" --jq '.fork' 2>/dev/null)" = "false" ]; }
package_private() { [ "$(gh api "orgs/$1/packages/container/score" --jq '.visibility' 2>/dev/null)" = "private" ]; }

# The per-fork package Read grant has no API to read back — but it has an
# OBSERVABLE consequence, which is nearly as good and a great deal better than
# the bare reminder this replaced: the fork's own scoring workflow either
# pulled the image or was refused. `ctf-score.yml` runs that pull in a step
# named "Pull scorer image" for exactly this reason.
#
# Echoes one of:
#   granted  a run got a successful pull — the grant is in place, observed
#   MISSING  the most recent run that reached the pull step was refused
#   unknown  no run has reached that step yet (a fresh fork, or a workflow
#            rendered before the pull step existed — i.e. still on v1, where
#            the pull happened inside "Run scorer" and cannot be observed
#            separately). `unknown` therefore does NOT mean the grant is
#            missing, and the doctor line must not say it does.
#
# FAILS CLOSED, like every check_step: an API error, an unreadable reply, or
# anything unrecognized reports `unknown`, never `granted`. Reporting a grant
# that was never observed is the one answer that would make this worse than
# the reminder.
#
# Only the newest few runs are inspected: a grant, once given, is not taken
# back, so an old refusal under a recent success is history rather than news —
# hence first-success-wins over first-failure-wins in the loop below.
pull_grant_status() {
  slug="$1"; runs=""; jobs=""; step=""

  runs="$(gh api "repos/$slug/actions/workflows/ctf-score.yml/runs?per_page=5" \
    --jq '.workflow_runs[].id' 2>/dev/null)" || { echo unknown; return 0; }
  [ -n "$runs" ] || { echo unknown; return 0; }

  for run in $runs; do
    jobs="$(gh api "repos/$slug/actions/runs/$run/jobs" \
      --jq '.jobs[].steps[] | select(.name == "Pull scorer image") | .conclusion' 2>/dev/null)" || continue
    for step in $jobs; do
      case "$step" in
        success) echo granted; return 0 ;;
        failure) echo MISSING; return 0 ;;
        *) ;; # skipped/cancelled/null — the step never actually ran
      esac
    done
  done

  echo unknown
}

# --- scoring-workflow versioning ------------------------------------------
#
# The rendered `ctf-score.yml` carries `# ctf-workflow-version: N`, copied
# verbatim from the template. Comparing a fork's number against the
# template's is what makes a fix to the scoring workflow reachable on an
# event that is already provisioned: before this, `org`'s workflow step
# checked only that the file EXISTED, so it skipped every fork that had any
# version of it, and a fix could only be delivered by hand, per fork.

# The template's version. A template with no marker is a bug in this repo,
# not a condition to tolerate — every comparison below depends on it, and a
# silent 0 would make every fork read "up to date" forever.
template_workflow_version() {
  local v
  v="$(sed -n 's/^# ctf-workflow-version: *\([0-9][0-9]*\).*/\1/p' "$WORKFLOW_TEMPLATE" | head -1)"
  [ -n "$v" ] || { echo "BUG: $WORKFLOW_TEMPLATE has no '# ctf-workflow-version: N' marker" >&2; return 1; }
  echo "$v"
}

# One fork's committed version. Echoes:
#   N       the marker's number
#   0       the file is there but carries no marker (provisioned before
#           versioning existed — stale by definition)
#   none    the file is absent, or the read failed
#
# FAILS CLOSED on an unreadable reply: `none` sorts as "not satisfied"
# everywhere it is used, so an API blip can never be mistaken for an
# up-to-date fork and skip a security fix.
fork_workflow_version() {
  local slug="$1" body
  body="$(gh api "repos/$slug/contents/.github/workflows/ctf-score.yml?ref=ctf" \
    -H "Accept: application/vnd.github.raw" 2>/dev/null)" || { echo none; return 0; }
  [ -n "$body" ] || { echo none; return 0; }
  local v
  v="$(printf '%s\n' "$body" | sed -n 's/^# ctf-workflow-version: *\([0-9][0-9]*\).*/\1/p' | head -1)"
  if [ -n "$v" ]; then echo "$v"; else echo 0; fi
}

# jq selecting the IDs of a fork's inherited (to-be-disabled) workflows: real
# .github/workflows/ files only, minus our own ctf-score.yml, that are active.
# The startswith() guard skips GitHub-managed DYNAMIC workflows (e.g.
# dynamic/dependabot/update-graph, dynamic/pages/...) which cannot be disabled
# via the API and never run on / close contestant PRs — counting them would
# make disable-inherited never settle (doctor stuck red, provisioning looping).
INHERITED_JQ='.workflows[] | select(.path | startswith(".github/workflows/")) | select(.path != ".github/workflows/ctf-score.yml") | select(.state=="active") | .id'

plan_step() {
  local id="$1" t="$2" org="$3" name; name="$(prov_repo_name "$t")"
  case "$id" in
    fork) echo "DRY-RUN: gh repo fork $(prov_field "$t" 2) --org $org --fork-name $name --clone=false" ;;
    ctf-branch) echo "DRY-RUN: create refs/heads/ctf on $org/$name from $(prov_field "$t" 2)@$(prov_field "$t" 3); set default_branch=ctf" ;;
    drop-old) echo "DRY-RUN: delete master/main on $org/$name if present and != ctf" ;;
    protect) echo "DRY-RUN: PUT branch protection on $org/$name:ctf (1 approving review, no force-push/deletion)" ;;
    workflow) echo "DRY-RUN: render ctf-score.yml v$(template_workflow_version) (TARGET=$t) and PUT to $org/$name:.github/workflows/ctf-score.yml on ctf" ;;
    disable-inherited) echo "DRY-RUN: disable every workflow on $org/$name except .github/workflows/ctf-score.yml" ;;
    pr-template) echo "DRY-RUN: PUT setup/PULL_REQUEST_TEMPLATE.md to $org/$name:.github/PULL_REQUEST_TEMPLATE.md on ctf" ;;
    vapp-dockerfile)
      if [ "$t" = vulnerableapp ]; then
        echo "DRY-RUN: PUT setup/vulnerableapp.Dockerfile to $org/$name:Dockerfile on ctf"
      fi
      ;;
  esac
}

check_step() {
  local id="$1" t="$2" org="$3" name; name="$(prov_repo_name "$t")"
  case "$id" in
    fork) gh_ok "repos/$org/$name" ;;
    ctf-branch) [ "$(gh api "repos/$org/$name" --jq '.default_branch' 2>/dev/null)" = "ctf" ] ;;
    drop-old)
      local branches
      branches="$(gh api "repos/$org/$name/branches" --jq '.[].name' 2>/dev/null)" || return 1
      ! printf '%s\n' "$branches" | grep -qxE 'master|main'
      ;;
    protect)
      local n
      n="$(gh api "repos/$org/$name/branches/ctf/protection" \
        --jq '.required_pull_request_reviews.required_approving_review_count // 0' 2>/dev/null)" || n=0
      [ "${n:-0}" -ge 1 ]
      ;;
    # Version-aware, not merely present. A fork carrying an OLDER workflow is
    # not "already done": that is exactly the state a security fix has to get
    # past, and treating presence as satisfaction is what stranded fixes on
    # live events. `>=`, not `==`, so a fork somehow ahead of the template
    # (a hand-edit, a downgraded checkout) is left alone rather than
    # clobbered backwards.
    workflow)
      local want have
      want="$(template_workflow_version)" || return 1
      have="$(fork_workflow_version "$org/$name")"
      [ "$have" != none ] || return 1
      [ "$have" -ge "$want" ]
      ;;
    disable-inherited)
      local others
      # Let GitHub finish indexing the fork's workflows before judging, or a
      # fresh fork reads empty and false-passes (the vacuous-zero trap).
      wait_workflows_settled "$org/$name"
      others="$(gh api "repos/$org/$name/actions/workflows" \
        --jq "$INHERITED_JQ" 2>/dev/null)" || return 1
      [ -z "$others" ]
      ;;
    pr-template) gh_ok "repos/$org/$name/contents/.github/PULL_REQUEST_TEMPLATE.md?ref=ctf" ;;
    vapp-dockerfile)
      [ "$t" = vulnerableapp ] || return 0
      gh_ok "repos/$org/$name/contents/Dockerfile?ref=ctf"
      ;;
    *) return 1 ;;
  esac
}

apply_step() {
  local id="$1" t="$2" org="$3" name; name="$(prov_repo_name "$t")"
  case "$id" in
    fork)
      gh repo fork "$(prov_field "$t" 2)" --org "$org" --fork-name "$name" --clone=false
      wait_for_repo "$org/$name" || { echo "fork not queryable yet: $org/$name" >&2; return 1; }
      ;;
    ctf-branch)
      local sha; sha="$(gh api "repos/$(prov_field "$t" 2)/commits/$(prov_field "$t" 3)" --jq '.sha')" \
        || { echo "cannot resolve $(prov_field "$t" 2)@$(prov_field "$t" 3)" >&2; return 1; }
      gh api -X POST "repos/$org/$name/git/refs" -f "ref=refs/heads/ctf" -f "sha=$sha" >/dev/null 2>&1 || true
      gh api -X PATCH "repos/$org/$name" -f "default_branch=ctf" >/dev/null
      ;;
    drop-old)
      local b
      for b in master main; do
        if gh_ok "repos/$org/$name/branches/$b"; then
          gh api -X DELETE "repos/$org/$name/git/refs/heads/$b" >/dev/null 2>&1 || true
        fi
      done
      ;;
    protect)
      gh api -X PUT "repos/$org/$name/branches/ctf/protection" --input - >/dev/null <<'JSON'
{ "required_status_checks": null, "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null, "allow_force_pushes": false, "allow_deletions": false }
JSON
      ;;
    workflow)
      local base_url lb_url="" tmp
      base_url="$(env_url)"; base_url="${base_url%/}"
      case "$base_url" in http://*|https://*) lb_url="$base_url/leaderboard" ;; esac
      tmp="$(mktemp)"
      render_workflow "$org" "$t" "$(app_url_for "$t")" "$lb_url" > "$tmp"
      put_contents_ctf "$org/$name" ".github/workflows/ctf-score.yml" "$tmp" || { rm -f "$tmp"; return 1; }
      rm -f "$tmp"
      ;;
    disable-inherited)
      local id
      for id in $(gh api "repos/$org/$name/actions/workflows" \
        --jq "$INHERITED_JQ" 2>/dev/null); do
        gh api -X PUT "repos/$org/$name/actions/workflows/$id/disable" >/dev/null 2>&1 || true
      done
      ;;
    pr-template)
      put_contents_ctf "$org/$name" ".github/PULL_REQUEST_TEMPLATE.md" "$SCRIPT_DIR/PULL_REQUEST_TEMPLATE.md"
      ;;
    vapp-dockerfile)
      [ "$t" = vulnerableapp ] || return 0
      put_contents_ctf "$org/$name" "Dockerfile" "$SCRIPT_DIR/vulnerableapp.Dockerfile"
      ;;
  esac
}

do_step() {
  local id="$1" t="$2" org="$3"
  if [ "$DRY_RUN" -eq 1 ]; then plan_step "$id" "$t" "$org"; return; fi
  if check_step "$id" "$t" "$org"; then echo "  ✓ $id ($t): already done"; return; fi
  echo "  → $id ($t)"; apply_step "$id" "$t" "$org"
}

# Read-only per-step status. Non-manual missing steps make it exit non-zero so
# CI / the future admin wizard can gate on a clean provision.
cmd_doctor() {
  require_env_file
  local org; org="$(env_val GITHUB_ORG)"
  local rc=0 t id cell name want_v have

  # Check (a) — ADMIN_LOGINS (issue #382). Always checked, regardless of
  # Secure Development: an event with no admins is broken either way, and the
  # failure (every login 403s on /admin) is otherwise silent until someone
  # tries the panel.
  local admins; admins="$(env_val ADMIN_LOGINS)"
  if [ -n "$admins" ]; then
    printf '%s✅ ADMIN_LOGINS: %s%s\n' "$C_GREEN" "$admins" "$C_RESET"
  else
    printf '%s❌ ADMIN_LOGINS is empty — nobody can open /admin; set it in .env and restart the app%s\n' \
      "$C_RED" "$C_RESET"
    rc=1
  fi

  # Check (b) — GITHUB_ORG. This command takes no --org flag, so "the org
  # doctor inspects" IS `env_val GITHUB_ORG`, resolved once into $org above —
  # the two cannot disagree today, only be missing. Whether a missing value
  # is tolerable depends on whether this event runs Secure Development at
  # all: an app-only event has no org to fork into and none is required.
  if [ -n "$org" ]; then
    printf '%s✅ GITHUB_ORG: %s%s\n' "$C_GREEN" "$org" "$C_RESET"
  elif runs_secdev; then
    printf '%s❌ GITHUB_ORG is empty in %s — Secure Development is on (SCORE_IMAGE set) but there is no org to fork into; set it (or run the wizard)%s\n' \
      "$C_RED" "${OUT:-.env}" "$C_RESET"
    rc=1
  else
    printf '%s⚠️  GITHUB_ORG is empty in %s — fine for now: this event does not run Secure Development%s\n' \
      "$C_YELLOW" "${OUT:-.env}" "$C_RESET"
  fi
  echo

  # Redis now requires a password, and docker-compose.yml uses `${REDIS_PASSWORD:?}`
  # — so an .env written before this change does not bring up a weaker stack,
  # it fails to bring up at all. Checked HERE because doctor is where an
  # organizer looks when something is wrong, and compose's own error names a
  # variable without saying where it comes from. Advisory (no `rc=1`): this is
  # a local .env concern, not a provisioning defect, and doctor's exit code
  # gates the org-side steps.
  if [ -f "${OUT:-.env}" ] && ! grep -q "^REDIS_PASSWORD=." "${OUT:-.env}"; then
    printf '%s⚠️  %s has no REDIS_PASSWORD — "docker compose up" will refuse to start.%s\n' \
      "$C_YELLOW" "${OUT:-.env}" "$C_RESET"
    printf '    Add:  REDIS_PASSWORD=%s\n\n' "$(openssl rand -hex 24)"
  fi

  # Push ingest is GONE (issue #377, ADR 56): compose mounts a constant
  # caddy/Caddyfile.poll and nothing reads SCORE_INGEST any more. A `.env`
  # carried over from v0.5 still has the line, so name it once — an organizer
  # who set it to `push` had a transport, and silence here would let them keep
  # believing they have one. Advisory (no `rc=1`), like the REDIS_PASSWORD
  # check above: a stale line is inert, so nothing about the event is broken.
  #
  # This runs BEFORE the no-org return below, and that placement is the point:
  # an app-only event has no GITHUB_ORG, so anything after that return is
  # invisible to exactly the box most likely to carry a hand-edited `.env`.
  # Only a value that is NOT poll is worth a line. Every `.env` this wizard
  # has ever written carries `SCORE_INGEST=poll`, and that line now agrees with
  # the behaviour exactly — warning about it would put a ⚠️ on every upgraded
  # box for a key that describes what the box already does. A `push` (or a
  # typo'd) value is the opposite: it says the box has a transport it no longer
  # has, so it gets named once, here.
  local ingest; ingest="$(env_val SCORE_INGEST)"
  if [ -n "$ingest" ] && [ "$ingest" != poll ]; then
    printf '%s⚠️  %s says SCORE_INGEST=%s — push ingest is REMOVED (issue #377) and the key is no longer read.%s\n' \
      "$C_YELLOW" "${OUT:-.env}" "$ingest" "$C_RESET"
    printf '    Poll is the score transport: the sync poller runs under --profile secdev\n'
    printf '    and caddy always mounts caddy/Caddyfile.poll. Delete the line.\n\n'
  fi
  # Nothing org-scoped left to inspect without an org: SD-on already failed
  # loudly above; SD-off simply has nothing further to check here.
  [ -n "$org" ] || return $rc

  if gh_ok "orgs/$org"; then
    printf '%s✅ org %s%s\n\n' "$C_GREEN" "$org" "$C_RESET"
  else
    printf '%s⚠️  org %s — create it: https://github.com/account/organizations/new%s\n\n' "$C_YELLOW" "$org" "$C_RESET"
  fi


  # No SCORE_IMAGE: this event does not run Secure Development, so there are
  # no forks, no scorer image and nothing in the per-target matrix below to
  # check — an empty table (headers only) would read as a failure rather than
  # the truth, which is that an app-only event has no fork-based content at
  # all. Report that plainly instead and stop.
  if ! runs_secdev; then
    printf '%sℹ️  SCORE_IMAGE is empty in %s — this event does not run Secure Development: no provisioned content to check (nothing forked, nothing to inspect here).%s\n' \
      "$C_CYAN" "${OUT:-.env}" "$C_RESET"
    return $rc
  fi

  # Fails loudly (naming targets.tsv) if it can't produce a target list —
  # every loop below reads targets.tsv through all_targets(), which itself
  # exits 0 with empty output on a missing/unreadable/empty file, so this
  # runs once, up front, before any of them.
  require_targets

  # Secure Development IS on: every event provisions all six targets.tsv
  # targets (config v2 PR2, #386) — which ones actually RUN is chosen at
  # runtime in /admin -> Secure Development.
  # One row per target, one column per provisioning step (+ fork-detach). Each
  # cell: ✅ done · ❌ missing (automatable — fails the exit code) · ⚠️ manual
  # step not yet done (advisory) · – not applicable to this target.
  printf '%s%-18s %-5s %-5s %-5s %-5s %-5s %-5s %-5s %-5s %-5s%s\n' "$C_BOLD" \
    "target" fork ctf old prot wkfl disI pr vapp detch "$C_RESET"
  for t in $(all_targets); do
    name="$(prov_repo_name "$t")"
    printf '%-18s ' "$t"
    for id in $STEPS; do
      if [ "$id" = vapp-dockerfile ] && [ "$t" != vulnerableapp ]; then
        cell="–"
      elif check_step "$id" "$t" "$org"; then
        cell="✅"
      else
        cell="❌"; rc=1
      fi
      # ✅/❌ render ~2 cols, the n/a dash ~1 — pad it one extra to keep columns.
      if [ "$cell" = "–" ]; then printf '%s     ' "$cell"; else printf '%s    ' "$cell"; fi
    done
    if fork_detached "$org/$name"; then cell="✅"; else cell="⚠️"; fi
    printf '%s\n' "$cell"
  done

  echo
  echo "legend: fork=forked ctf=ctf-branch old=drop-old prot=protected wkfl=workflow"
  echo "        disI=disable-inherited pr=pr-template vapp=vapp-dockerfile detch=fork-detached (–=n/a)"
  echo "❌ = automatable step missing (fails exit); ⚠️ = UI-only step to finish by hand"

  # Org-level (not per-target): scorer package.
  echo
  if package_private "$org"; then
    printf '%s✅ scorer package private%s\n' "$C_GREEN" "$C_RESET"
  else
    printf '%s⚠️  scorer package NOT private (or missing) — keep it private: https://github.com/orgs/%s/packages%s\n' "$C_YELLOW" "$org" "$C_RESET"
  fi

  # Org-level (not per-target): push-mode leftovers (issue #377). The two
  # secrets the removed push transport needed are the only org Actions secrets
  # this kit ever asked for, and they are read by runs a CONTESTANT's pull
  # request triggers — so now that push is gone they are standing credentials
  # with nothing left to authorize, which is why this check outlives the
  # transport itself. Advisory, never `rc=1`: their presence is not a
  # provisioning defect, and doctor's exit code gates the steps `org` can fix.
  #
  # FAIL CLOSED, like the sync-App check below: a non-zero `gh` exit (no
  # admin:org scope, network, a revoked token) and an empty reply from an
  # otherwise-successful call are both reported as NOT VERIFIED, never as
  # "absent" — telling an organizer their token-bearing secrets are gone when
  # the API simply refused to answer is the one wrong thing to say here.
  echo
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'DRY-RUN: would check %s for the removed push-mode secrets (LEADERBOARD_URL, LEADERBOARD_TOKEN)\n' "$org"
  else
    local sec_rows sec_found="" sec
    # `--paginate`, because a truncated first page reading as "no leftovers"
    # would be the fail-OPEN this check exists to avoid: gh returns 30 items
    # by default, and the answer here has to be about every secret the org
    # has, not the first page of them.
    if sec_rows="$(gh api --paginate "orgs/$org/actions/secrets" --jq '.secrets[].name' 2>/dev/null)" && [ -n "$sec_rows" ]; then
      for sec in LEADERBOARD_URL LEADERBOARD_TOKEN; do
        if printf '%s\n' "$sec_rows" | grep -qx "$sec"; then sec_found="$sec_found $sec"; fi
      done
      if [ -n "$sec_found" ]; then
        printf '%s⚠️  push-mode org secrets still set:%s — push ingest is REMOVED (#377), so these are unused credentials%s\n' \
          "$C_YELLOW" "$sec_found" "$C_RESET"
        printf '    Nothing reads them any more; delete them: https://github.com/organizations/%s/settings/secrets/actions\n' "$org"
      else
        printf '%s✅ no leftover push-mode org secrets (#377)%s\n' "$C_GREEN" "$C_RESET"
      fi
    else
      printf '%s⚠️  push-mode org secrets (LEADERBOARD_URL, LEADERBOARD_TOKEN) not verified (the token needs admin:org scope) — check by hand: https://github.com/organizations/%s/settings/secrets/actions%s\n' \
        "$C_YELLOW" "$org" "$C_RESET"
    fi
  fi

  # Check (c) — the sync GitHub App (GITHUB_APP_ID) is installed on the org
  # (issue #382). Only meaningful when Secure Development runs at all: an
  # app-only event has no poller/pusher that needs a token, so there is
  # nothing to verify — but we are past the `runs_secdev` early-return above,
  # so it is always true here.
  local sync_app_id; sync_app_id="$(env_val GITHUB_APP_ID)"
  if [ -z "$sync_app_id" ]; then
    printf '%s❌ GITHUB_APP_ID is empty in %s — sync cannot mint tokens without it%s\n' \
      "$C_RED" "${OUT:-.env}" "$C_RESET"
    rc=1
  elif [ "$DRY_RUN" -eq 1 ]; then
    printf 'DRY-RUN: would check whether the sync App (GITHUB_APP_ID=%s) is installed on %s\n' \
      "$sync_app_id" "$org"
  else
    # `gh api ... --jq` fails closed two ways we must not conflate with "not
    # installed": a non-zero exit (missing admin:org scope, network, a
    # revoked token) and empty output from an otherwise-successful call —
    # both are treated as UNVERIFIED, never as "installed", so a broken token
    # never reads as a clean bill of health (R4 / #382).
    local sync_rows sync_found_id="" sync_found_slug=""
    if sync_rows="$(gh api "orgs/$org/installations" \
        --jq '.installations[] | "\(.app_id) \(.app_slug)"' 2>/dev/null)" && [ -n "$sync_rows" ]; then
      sync_found_id="$(printf '%s\n' "$sync_rows" | awk -v id="$sync_app_id" '$1==id{print $1; exit}')"
      sync_found_slug="$(printf '%s\n' "$sync_rows" | awk -v id="$sync_app_id" '$1==id{print $2; exit}')"
      if [ "$sync_found_id" = "$sync_app_id" ]; then
        printf '%s✅ sync App (GITHUB_APP_ID=%s) installed on %s%s\n' \
          "$C_GREEN" "$sync_app_id" "$org" "$C_RESET"
      else
        # Not among the org's current installations, so its slug cannot be
        # known from this same response either — fall back to the generic
        # installations settings page.
        printf '%s❌ sync App (GITHUB_APP_ID=%s) not installed on %s%s\n' \
          "$C_RED" "$sync_app_id" "$org" "$C_RESET"
        if [ -n "$sync_found_slug" ]; then
          printf '    install it: https://github.com/organizations/%s/settings/apps/%s/installations\n' \
            "$org" "$sync_found_slug"
        else
          printf '    install it: https://github.com/organizations/%s/settings/installations\n' "$org"
        fi
        rc=1
      fi
    else
      printf '%s❌ sync App (GITHUB_APP_ID=%s) not verified (gh api orgs/%s/installations failed — the token needs admin:org scope)%s\n' \
        "$C_RED" "$sync_app_id" "$org" "$C_RESET"
      rc=1
    fi
  fi

  # No API exposes the per-fork "Manage Actions access" grants directly, so
  # this is verified by OBSERVATION instead — see `pull_grant_status`. It is
  # the one provisioning step with no API and the one whose failure looks like
  # something else entirely (a scoring failure on a contestant's PR), so
  # leaving it as a bare "confirm this by hand" reminder meant it stayed
  # unverified until an event was already running.
  # Scoring-workflow version per fork. The matrix's `wkfl` cell already goes
  # ❌ when a fork is behind, but ❌ there reads as "missing" — and "present
  # but three versions old" is a different problem with a different fix, so
  # it gets said in those words, with the command that resolves it.
  want_v="$(template_workflow_version)" || want_v=""
  if [ -n "$want_v" ]; then
    echo
    echo "scoring workflow version (template is v$want_v):"
    for t in $(all_targets); do
      name="$(prov_repo_name "$t")"
      case "$(fork_workflow_version "$org/$name")" in
        none)
          printf '  %-18s %s❌ absent%s — no ctf-score.yml on ctf; run: ./setup/ctf-setup.sh org\n' \
            "$t" "$C_RED" "$C_RESET" ;;
        0)
          printf '  %-18s %s❌ pre-versioning%s — provisioned before workflow stamping; run: ./setup/ctf-setup.sh upgrade\n' \
            "$t" "$C_RED" "$C_RESET" ;;
        "$want_v")
          printf '  %-18s %s✅ v%s%s\n' "$t" "$C_GREEN" "$want_v" "$C_RESET" ;;
        *)
          have="$(fork_workflow_version "$org/$name")"
          if [ "$have" -gt "$want_v" ]; then
            printf '  %-18s %s⚠️  v%s%s — AHEAD of this checkout (v%s); update the kit rather than downgrading the fork\n' \
              "$t" "$C_YELLOW" "$have" "$C_RESET" "$want_v"
          else
            printf '  %-18s %s❌ v%s%s — stale (template v%s); run: ./setup/ctf-setup.sh upgrade\n' \
              "$t" "$C_RED" "$have" "$C_RESET" "$want_v"
          fi ;;
      esac
    done
  fi

  echo
  echo "per-fork package Read grant (no API — read back from each fork's own scoring runs):"
  for t in $(all_targets); do
    name="$(prov_repo_name "$t")"
    case "$(pull_grant_status "$org/$name")" in
      granted)
        printf '  %-18s %s✅ granted%s (a scoring run pulled the image)\n' "$t" "$C_GREEN" "$C_RESET" ;;
      MISSING)
        printf '  %-18s %s❌ MISSING%s — a run was refused the image; grant this fork Read under "Manage Actions access"\n' \
          "$t" "$C_RED" "$C_RESET"
        rc=1 ;;
      *)
        # NOT "no run has pulled yet" — that reads as a factual claim about
        # the fork and is routinely false. `pull_grant_status` looks for a
        # step named "Pull scorer image", which only exists from workflow v2
        # onward; under v1 the pull happened inside "Run scorer", so a fork
        # that has scored successfully many times still lands here. Observed
        # on the test org: juice-shop scored 2/141 under v1 and read
        # "no scoring run has pulled yet", which sends an organizer chasing a
        # grant that was never missing. Say what is actually unknown.
        printf '  %-18s %s⚠️  unverified%s — no run has reached the named pull step (needs a scoring run on workflow v2+); confirm by hand, or re-trigger a PR\n' \
          "$t" "$C_YELLOW" "$C_RESET" ;;
    esac
  done
  printf '  package settings: https://github.com/orgs/%s/packages\n' "$org"
  return $rc
}

DRY_RUN=0
OUT=.env
APP_ID=""
PEM=""
INSTALLATION_ID=""
CLIENT_ID=""
# CMD is read from the env first so `CMD=__selftest source ctf-setup.sh` can
# define the helpers above (and below) without parsing flags or dispatching a
# subcommand — the env var wins so sourcing works regardless of $1, while
# `bash ctf-setup.sh <cmd>` (no CMD env var set) still uses positional $1.
CMD="${CMD:-${1:-}}"

if [ "$CMD" != "__selftest" ]; then
  shift || true

  # A value-taking flag at the end of the line would otherwise die under
  # `set -u` with bash's own "unbound variable" instead of a usable message.
  need_value() { [ $# -ge 2 ] || { echo "$1 requires a value" >&2; exit 2; }; }
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --out) need_value "$@"; OUT="$2"; shift ;;
      --app-id) need_value "$@"; APP_ID="$2"; shift ;;
      --pem) need_value "$@"; PEM="$2"; shift ;;
      --installation-id) need_value "$@"; INSTALLATION_ID="$2"; shift ;;
      --client-id) need_value "$@"; CLIENT_ID="$2"; shift ;;
      *) echo "unknown flag: $1" >&2; exit 2 ;;
    esac
    shift
  done
fi

# target key -> default APP_URL for the rendered workflow. Targets self-boot as
# sibling containers on the ctf network, reachable by target name; the ports
# are the targets' STOCK ports — verify each one against your rubric's boot
# strategy (docs/scorer.md, "Booting hard targets") before the event.
#
# scripts/acceptance-target.sh carries its own per-target scheme + URL-suffix
# table (an APP_SCHEME / APP_URL_SUFFIX case) for the same reason — the two are
# intentionally separate (no derivation, no sourcing this script from the gate)
# — a new target's URL needs an entry in BOTH.
app_url_for() {
  case "$1" in
    juice-shop) echo "http://juice-shop:3000" ;;
    dvwa) echo "http://dvwa:80" ;;
    webgoat) echo "http://webgoat:8080/WebGoat" ;;
    # The only HTTPS target: its bring-up builds Security Shepherd from pinned
    # upstream source and Tomcat's TLS connector listens on 8443. The certificate
    # is self-signed and expired in 2019 — deliberately not re-issued (the rubric's
    # helpers disable verification and several tests assert on TLS behaviour), so the
    # bring-up sets NODE_TLS_REJECT_UNAUTHORIZED=0 on its own readiness probes only
    # (never exported, or it would reach the judge's authenticated leaderboard POST).
    # Verified against a real boot by `scripts/acceptance-target.sh securityshepherd none`.
    securityshepherd) echo "https://securityshepherd:8443" ;;
    vulnerableapp) echo "http://vulnerableapp:9090/VulnerableApp" ;;
    vampi) echo "http://vampi:5000" ;;
    *) echo "unknown target: $1" >&2; return 1 ;;
  esac
}

# --- the bootstrap plane: everything this script knows comes from $OUT ------
#
# Read a single value out of the env file (empty if the file or key is
# absent). The file-exists test is load-bearing, not defensive noise: this
# script runs under `set -euo pipefail`, so a `sed` on a missing .env exits 2,
# pipefail promotes that to the pipeline's status, and the command
# substitution takes the whole script down — silently, with no output and exit
# 1. `render` on a machine with no .env did exactly that.
#
# A trailing `# comment` and surrounding whitespace are stripped: organizers
# annotate this file (`GITHUB_ORG=myorg  # the disposable one`), and the value
# this script forks into, or prints as the org it inspected, must be the org
# and not the org plus prose. docker compose's own .env reader does the same.
# A `#` INSIDE the value is only stripped when whitespace precedes it, so a
# token that legitimately contains one survives.
env_val() {
  local out="${OUT:-.env}" v
  [ -f "$out" ] || return 0
  v="$(sed -n "s/^$1=//p" "$out" | tail -1)"
  v="${v%%[[:space:]]#*}"
  # Trim both ends without a subshell per call: bash 3.2-safe extglob-free.
  v="${v#"${v%%[![:space:]]*}"}"
  printf '%s' "${v%"${v##*[![:space:]]}"}"
}

# Is the key PRESENT in the env file, whatever its value? Distinct from
# `env_val` being non-empty, and the difference is load-bearing for
# SCORE_IMAGE: `SCORE_IMAGE=` is an organizer's decided "no Secure
# Development", while no such line at all is a file that has not been asked
# the question yet — one the wizard must ask rather than resume past.
env_has() {
  local out="${OUT:-.env}"
  [ -f "$out" ] || return 1
  grep -q "^$1=" "$out"
}

# Refuse to act on an absent env file, for the commands whose whole input it
# is. Without this, `env_val` reads every key as empty and a missing .env is
# indistinguishable from an event that runs no Secure Development: `teardown`
# would print "nothing to tear down" and exit 0 on a box whose forks are all
# still there. NOT called by `check` (it inspects the local toolchain) or
# `secrets` (it CREATES the file).
require_env_file() {
  [ -f "${OUT:-.env}" ] || {
    echo "${OUT:-.env} not found — run 'ctf-setup.sh secrets' first (or point --out at your env file)" >&2
    exit 1
  }
}

# EVENT_URL, out of the env file — never out of an event config (ADR 43).
#
# It used to be an `event.url` field in the event config file config v2
# deleted, which put a DEPLOYMENT fact in the EVENT file. One event is
# deployed to a box, to AWS and to fly.io on three
# different hostnames — that is why .env and .env.fly hold different
# EVENT_URLs for one event — so a single `url:` could not be right for all of
# them. Worse, it lost silently: EVENT_URL is what BETTER_AUTH_URL, the app's
# HTTPS start-up guard and the CSRF origin check read, so a stale `event.url`
# left sign-in working perfectly while every fork's score comment pointed
# contestants at a dead leaderboard.
env_url() {
  env_val EVENT_URL
}

# The scorer image to mirror/build: an environment variable wins over the env
# file, so a one-off `SCORE_IMAGE=... ctf-setup.sh org` can mirror a different
# image without editing anything.
#
# This is the SOURCE, not the switch. Whether an event runs Secure
# Development at all is `env_val SCORE_IMAGE` — the value the box itself
# carries, the same one docker compose reads to decide which services exist —
# so an exported variable cannot make a command act as if the box were
# configured for Secure Development when its env file says otherwise.
score_image() {
  local v="${SCORE_IMAGE:-}"
  [ -n "$v" ] || v="$(env_val SCORE_IMAGE)"
  printf '%s' "$v"
}

# Does this event run Secure Development? NON-EMPTY SCORE_IMAGE in the env
# file is the whole switch (config v2, #386): its containers only exist when
# an image reference does, so the same value that names the image also says
# whether there is anything to fork, mirror, poll or verify. Empty is not an
# error — an event can run quiz, classic or ai alone, and those are app-side
# only — so every caller says "this event does not run Secure Development"
# rather than just "nothing to do".
runs_secdev() {
  [ -n "$(env_val SCORE_IMAGE)" ]
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "DRY-RUN: $*"; else "$@"; fi
}

# Substitute the three placeholders documented at the top of the workflow
# template. Rendered locally from this repo's own template — no upstream fetch.
render_workflow() {
  local org="$1" target="$2" app_url="$3" leaderboard_url="$4"
  sed -e "s|<EVENT_ORG>|${org}|g" \
      -e "s|<TARGET>|${target}|g" \
      -e "s|<APP_URL>|${app_url}|g" \
      -e "s|<LEADERBOARD_LINK>|${leaderboard_url}|g" \
    "$WORKFLOW_TEMPLATE"
}

# Render one workflow per target into dist/workflows/ (gitignored). Under
# --dry-run nothing is written; the plan is printed instead.
render_workflows() {
  local org="$1"; shift
  [ -f "$WORKFLOW_TEMPLATE" ] || { echo "workflow template missing: $WORKFLOW_TEMPLATE" >&2; exit 1; }
  # Leaderboard URL for the score-comment footer, derived once from EVENT_URL
  # (trailing slash stripped). Empty when EVENT_URL is unset — the workflow
  # only renders the footer link when the value is a real http(s) URL.
  #
  # SAYS SO when it is missing, rather than rendering workflows whose footer
  # link is silently dropped — every scored PR would lose the one link that
  # sends a contestant back to the leaderboard, with nothing to explain it. A
  # warning, not a failure: a link-less footer is a degraded comment, not a
  # broken event.
  local base_url lb_url=""
  base_url="$(env_url)"
  base_url="${base_url%/}"
  case "$base_url" in
    http://*|https://*) lb_url="$base_url/leaderboard" ;;
    *)
      echo "WARNING: EVENT_URL is not set in ${OUT:-.env} (or is not http/https)." >&2
      echo "         The score comments will carry no leaderboard link." >&2 ;;
  esac
  local wfdir="dist/workflows" t app_url dest
  for t in "$@"; do
    app_url="$(app_url_for "$t")" || exit 1
    dest="$wfdir/$t.ctf-score.yml"
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "DRY-RUN: render template (EVENT_ORG=$org TARGET=$t APP_URL=$app_url LEADERBOARD_LINK=${lb_url:-<none>}) -> $dest"
    else
      mkdir -p "$wfdir"
      render_workflow "$org" "$t" "$app_url" "$lb_url" > "$dest"
      echo "   wrote $dest"
    fi
  done
}

# Mirror SCORE_IMAGE into the event org's GHCR, then REFUSE a non-amd64 image
# (GitHub runners are amd64; an arm64-only image fails scoring at run time).
mirror_image() {
  local org="$1" src="$2" dest="ghcr.io/$1/score:latest"
  echo "== mirroring scorer image $src -> $dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN: docker pull $src && docker tag $src $dest && docker push $dest"
    echo "DRY-RUN: docker image inspect --format '{{.Architecture}}' $src  # must be amd64"
    return
  fi
  # If the source is already the dest tag and present locally (the wizard just
  # built it), don't pull — the tag isn't in the registry yet, which is the
  # whole reason we're about to push it. Otherwise pull the named source.
  if [ "$src" = "$dest" ] && docker image inspect "$src" >/dev/null 2>&1; then
    echo "== using locally-built $src (skipping pull)"
  else
    docker pull "$src"
  fi
  # Check the pulled image's own config (always has .Architecture, no
  # manifest-list wrapping to unpack) rather than the registry manifest: a
  # plain `docker build` (the documented path in docs/scorer.md) pushes a
  # single-manifest image with no top-level "architecture" field at all —
  # that only appears inside a multi-manifest index's platform entries.
  local arch
  arch="$(docker image inspect --format '{{.Architecture}}' "$src" 2>/dev/null || true)"
  if [ "$arch" != "amd64" ]; then
    echo "ERROR: $src is $arch, not amd64 — GitHub runners need linux/amd64." >&2
    echo "Rebuild + push amd64:  docker buildx build --platform linux/amd64 -t $dest --push scorer/" >&2
    return 1
  fi
  docker tag "$src" "$dest"
  if ! docker push "$dest"; then
    echo "ERROR: push to $dest failed — is docker logged in to ghcr.io with write:packages?" >&2
    echo "  docker login ghcr.io   (token needs write:packages; e.g. gh auth token after 'gh auth refresh -s write:packages,read:packages')" >&2
    return 1
  fi
}

cmd_check() {
  command -v gh >/dev/null || { echo "gh CLI missing: https://cli.github.com"; exit 1; }
  command -v docker >/dev/null || { echo "docker missing"; exit 1; }
  command -v openssl >/dev/null || { echo "openssl missing"; exit 1; }
  docker compose version >/dev/null || { echo "docker compose v2 missing"; exit 1; }
  gh auth status || { echo "run: gh auth login"; exit 1; }
  echo "OK: prerequisites present"
}

cmd_secrets() {
  local out="${OUT:-.env}"
  # `-e || -L`, not `-f`: `-f` follows symlinks, so a dangling link at $out
  # would pass this check and the redirect below would write the secrets to
  # wherever the link points.
  if [ -e "$out" ] || [ -L "$out" ]; then echo "$out exists; refusing to overwrite" >&2; exit 1; fi
  # Owner-only from the first byte, and created exclusively: `umask 077` so a
  # plain redirect cannot land 0644 under the usual 022 umask, and `noclobber`
  # so bash opens with O_EXCL — which fails on any pre-existing path, symlink
  # included, closing the window between the check above and the write. The
  # subshell keeps both settings from leaking into later wizard writes.
  (
  umask 077
  set -o noclobber
  {
    echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32 | tr -d '\n')"
    echo "SRH_TOKEN=$(openssl rand -hex 24)"
    echo "SCORER_TOKEN=$(openssl rand -hex 24)"
    # Redis's requirepass. Compose refuses to start without it, so this is
    # not optional for a working stack. Only srh ever uses it; no other
    # service is given it, and no other service can reach redis.
    echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
    echo "GITHUB_CLIENT_ID="
    echo "GITHUB_CLIENT_SECRET="
    echo "GITHUB_APP_ID="
    echo "GITHUB_APP_PRIVATE_KEY="
    echo "GITHUB_APP_INSTALLATION_ID="
    echo "EVENT_URL=http://localhost"
    # The two keys the deleted event config file used to carry (config v2,
    # #386). Emitted even though they are empty: a key that is absent is a
    # key nobody knows to fill in, and both fail CLOSED — no org means
    # nothing to poll or fork, and no admin means a /admin nobody can open.
    echo "# GITHUB_ORG: the disposable per-event GitHub org. The app links forks"
    echo "# there, sync polls its repos, and ctf-setup provisions it."
    echo "GITHUB_ORG="
    echo "# ADMIN_LOGINS: comma-separated GitHub logins allowed into /admin."
    echo "# EMPTY LOCKS EVERYONE OUT — /admin forbids every login (fail closed)."
    echo "ADMIN_LOGINS="
    echo "# SCORE_IMAGE: your own scorer image, built from scorer/ (docs/scorer.md),"
    echo "# e.g. ghcr.io/<your-event-org>/score:latest. No default — the upstream"
    echo "# image is private and the kit does not assume access to it. NON-EMPTY"
    echo "# is also how this box says the event runs Secure Development at all."
    echo "SCORE_IMAGE="
  } > "$out"
  )
  echo "wrote $out — fill in GITHUB_ORG, ADMIN_LOGINS, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, SCORE_IMAGE"
}

cmd_org() {
  require_env_file
  # The switch first: with SCORE_IMAGE empty this event does not run Secure
  # Development, so there is nothing fork-based to provision (quiz, classic
  # and ai are scored entirely app-side). Not an error — but not silent
  # either: an organizer who MEANT to run it and left SCORE_IMAGE empty gets
  # told how to turn it on. Asked before the org check so an app-only event
  # needs no GITHUB_ORG at all, and before any gh/docker call so --dry-run
  # stays dry.
  if ! runs_secdev; then
    echo "== SCORE_IMAGE is empty in ${OUT:-.env} — this event does not run Secure Development; nothing to fork."
    echo "   To run it: build your own scorer image (docs/scorer.md), set SCORE_IMAGE in ${OUT:-.env}, and re-run."
    return 0
  fi

  # The image to MIRROR, which an exported SCORE_IMAGE may override for a
  # one-off run. Deliberately NO upstream default — the kit assumes zero
  # upstream access: build your own from scorer/ (docs/scorer.md).
  local src; src="$(score_image)"

  local org; org="$(env_val GITHUB_ORG)"
  [ -n "$org" ] || { echo "${OUT:-.env}: GITHUB_ORG missing — Secure Development forks into an org; set it (or run the wizard)" >&2; exit 1; }

  require_targets
  echo "== provisioning $org (idempotent — re-run safe)"
  local t
  for t in $(all_targets); do
    echo "== $t -> $org/$(prov_repo_name "$t")"
    local id
    for id in $STEPS; do do_step "$id" "$t" "$org"; done
  done

  mirror_image "$org" "$src"

  cat <<EOF
== manual steps (GitHub UI, no API) — run 'ctf-setup doctor' to re-check:
   1. Detach each fork from its fork network (repo Settings -> Leave fork network).
   2. Keep package ghcr.io/$org/score PRIVATE; grant each fork Read under
      the package's "Manage Actions access" — https://github.com/orgs/$org/packages
      Do this for EVERY fork. A fork without it cannot pull the scorer, and
      doctor reports it as unverified until one of its scoring runs proves
      otherwise.
EOF
}

# Just the workflow-render step of cmd_org — for re-rendering after an
# EVENT_URL change (the footer link) or a template fix, without re-running
# forks or the image mirror.
cmd_render() {
  require_env_file
  # No SCORE_IMAGE: nothing fork-based to render a scoring workflow for. Not
  # an error — same reasoning as cmd_org.
  if ! runs_secdev; then
    echo "== SCORE_IMAGE is empty in ${OUT:-.env} — this event does not run Secure Development; no workflows to render."
    return 0
  fi

  local org; org="$(env_val GITHUB_ORG)"
  [ -n "$org" ] || { echo "${OUT:-.env}: GITHUB_ORG missing — the rendered workflow names the event org; set it (or run the wizard)" >&2; exit 1; }

  require_targets
  local targets_arr=()
  local t
  for t in $(all_targets); do targets_arr+=("$t"); done
  render_workflows "$org" "${targets_arr[@]}"
}

# Re-commit the rendered scoring workflow to every fork whose committed copy
# is behind the template. Exists as its own subcommand rather than "just
# re-run org" because `org` also mirrors the scorer image — a multi-minute
# docker push — and an organizer pushing a security fix to a running event
# should not have to choose between waiting for that and skipping the fix.
#
# Idempotent, like every other step: `do_step` re-checks the version and
# reports "already done" for a fork that is current, so this is safe to run
# on a whim and safe to re-run after a partial failure.
cmd_upgrade() {
  require_env_file
  # Same reasoning as cmd_org/cmd_render: an app-only event has no forks, so
  # there is no workflow to upgrade. Not an error.
  if ! runs_secdev; then
    echo "== SCORE_IMAGE is empty in ${OUT:-.env} — this event does not run Secure Development; no forks to upgrade."
    return 0
  fi

  local org; org="$(env_val GITHUB_ORG)"
  [ -n "$org" ] || { echo "${OUT:-.env}: GITHUB_ORG missing — set it (or run the wizard) before upgrading forks" >&2; exit 1; }

  local want; want="$(template_workflow_version)" || exit 1
  require_targets
  echo "== upgrading scoring workflows in $org to v$want (idempotent — re-run safe)"
  local t
  for t in $(all_targets); do
    echo "== $t -> $org/$(prov_repo_name "$t")"
    do_step workflow "$t" "$org"
  done

  # The workflow only re-runs on the NEXT push to an open PR, so an event
  # mid-flight keeps scoring against the old copy until then. Say so rather
  # than letting an organizer assume the fix is live everywhere the moment
  # this returns.
  if [ "$DRY_RUN" -eq 0 ]; then
    echo
    echo "== Done. Open PRs keep using the previously-started run; the new workflow"
    echo "   applies from each PR's next push (or a manual re-run)."
  fi
}

cmd_teardown() {
  require_env_file
  # No SCORE_IMAGE: nothing was ever forked to archive. Not an error — same
  # reasoning as cmd_org/cmd_render/cmd_upgrade.
  if ! runs_secdev; then
    echo "== SCORE_IMAGE is empty in ${OUT:-.env} — this event does not run Secure Development; nothing to tear down."
    return 0
  fi
  local org; org="$(env_val GITHUB_ORG)"
  [ -n "$org" ] || { echo "${OUT:-.env}: GITHUB_ORG missing — set it (or run the wizard) before tearing an org down" >&2; exit 1; }
  require_targets
  local t
  for t in $(all_targets); do
    local r; r="$(prov_repo_name "$t")" || exit 1
    run gh repo archive "$org/$r" --yes
  done
  echo "== uninstall the GitHub App and delete org secrets manually"
}

# Open a URL/file in the default browser, degrading to a printed path.
#
# Only ever opens for an INTERACTIVE run. The --dry-run guards at each call
# site are not enough on their own: they stop the documented rehearsal path,
# but any other automated invocation — a test harness driving a real
# subcommand, a CI step, an agent running the script against a fixture config
# — would still pop real browser tabs on whoever's machine is running it.
# That happened: a run against the bats fixture org opened GitHub's App and
# OAuth creation pages for an org that does not exist.
#
# stdin is the right thing to test, not stdout: the prompts this accompanies
# are unusable without a terminal to answer them, so no-TTY means no human,
# means print the URL and let the caller decide. Set CTF_NO_BROWSER=1 to
# suppress it even when interactive.
open_url() {
  local target="$1"
  if [ -n "${CTF_NO_BROWSER:-}" ] || [ ! -t 0 ]; then
    echo "open this manually: $target"
    return 0
  fi
  if command -v open >/dev/null 2>&1; then
    open "$target"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$target"
  else
    echo "open this manually: $target"
  fi
}

# Set (or replace) KEY=value in an env file. base64 values contain / + =, so
# we drop-and-append rather than sed the value in place.
set_env_var() {
  local file="$1" key="$2" val="$3" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$file"
}

# app-manifest: render a self-submitting HTML form carrying app-manifest.json
# and open it against the event org's App-creation page. Removes the manual
# JSON copy-paste; the organizer still clicks Create/Install in GitHub's UI.
cmd_app_manifest() {
  local org; org="$(env_val GITHUB_ORG)"
  [ -n "$org" ] || { echo "${OUT:-.env}: GITHUB_ORG missing — set it (or run the wizard) first" >&2; exit 1; }
  local manifest="$SCRIPT_DIR/../sync/app-manifest.json"
  [ -f "$manifest" ] || { echo "manifest not found: $manifest" >&2; exit 1; }

  local action="https://github.com/organizations/${org}/settings/apps/new?state=owasp-ctf"
  # The create-from-manifest flow REQUIRES redirect_url. We don't run a callback
  # server (creds are fetched manually from the app page), so point it at the
  # org's Apps settings — after Create, GitHub lands there (with a ?code it
  # ignores) instead of erroring. Injected at render time so the static
  # manifest stays a clean permissions reference.
  local redirect="https://github.com/organizations/${org}/settings/apps"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN: render manifest form (redirect_url=$redirect) -> POST $manifest to $action"
    return 0
  fi

  local manifest_json; manifest_json="$(cat "$manifest")"
  # Insert redirect_url as the first field, right after the opening brace.
  manifest_json="{
  \"redirect_url\": \"${redirect}\",${manifest_json#\{}"

  local html; html="$(mktemp -t ctf-app-manifest).html"
  {
    echo '<!doctype html><meta charset="utf-8"><title>Create the OWASP CTF in a Box GitHub App</title>'
    echo "<form action=\"${action}\" method=\"post\">"
    printf '<input type="hidden" name="manifest" value='"'"'%s'"'"'>' "$(printf '%s' "$manifest_json" | sed "s/'/\&#39;/g")"
    echo '</form><p>Submitting to GitHub…</p><script>document.forms[0].submit()</script>'
  } > "$html"

  echo "== opening GitHub App creation for org '$org' in your browser"
  open_url "$html"
  cat <<EOF
== the form is PRE-FILLED from the manifest. If it opened BLANK (auto-submit
   blocked), enter these values by hand — they are the whole manifest:
     GitHub App name:   OWASP CTF sync   (rename if the name is taken)
     Homepage URL:      https://github.com/OWASP/owasp-ctf-in-a-box
     Webhook:           UNCHECK "Active"  (no webhook — else GitHub demands a URL)
     Repository permissions:  Issues → Read-only
                              Pull requests → Read-only
                              (Metadata → Read-only is added automatically)
     Subscribe to events:     none
     Where can this be installed:  Only on this account (@$org)
== then, in GitHub's UI:
   1. Click "Create GitHub App".
   2. On the app page: "Generate a private key" (downloads a .pem), and note the App ID.
   3. "Install App" -> install it on the '$org' org.
   4. The wizard will prompt for the App ID + .pem path next (or, standalone:
        ctf-setup.sh app-config --app-id <id> --pem <path-to-downloaded.pem>
      add --installation-id <n> to pin it; otherwise sync auto-discovers it).
EOF
}

# app-config: ingest a downloaded App private key + App ID into .env
# (base64-encodes the PEM). Optional --installation-id pins the install;
# without it, sync discovers the installation at runtime.
cmd_app_config() {
  local out="${OUT:-.env}"
  [ -n "$APP_ID" ] || { echo "app-config: --app-id is required" >&2; exit 1; }
  [ -n "$PEM" ] || { echo "app-config: --pem <path> is required" >&2; exit 1; }
  [ -f "$PEM" ] || { echo "app-config: pem not found: $PEM" >&2; exit 1; }
  if ! grep -q 'PRIVATE KEY' "$PEM"; then
    echo "app-config: $PEM is not a PEM private key" >&2; exit 1
  fi
  [ -f "$out" ] || { echo "app-config: $out not found — run 'ctf-setup.sh secrets' first" >&2; exit 1; }

  local key_b64; key_b64="$(base64 < "$PEM" | tr -d '\n')"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN: set GITHUB_APP_ID=$APP_ID, GITHUB_APP_PRIVATE_KEY=<base64 pem> in $out"
    if [ -n "$INSTALLATION_ID" ]; then
      echo "DRY-RUN: set GITHUB_APP_INSTALLATION_ID=$INSTALLATION_ID in $out"
    fi
    return 0
  fi

  set_env_var "$out" GITHUB_APP_ID "$APP_ID"
  set_env_var "$out" GITHUB_APP_PRIVATE_KEY "$key_b64"
  if [ -n "$INSTALLATION_ID" ]; then
    set_env_var "$out" GITHUB_APP_INSTALLATION_ID "$INSTALLATION_ID"
  fi
  echo "wrote GitHub App credentials to $out (App ID $APP_ID, private key base64-encoded)"
}

# The OAuth callback the app registers with GitHub: <EVENT_URL>/api/auth/callback/github.
# EVENT_URL comes from .env (secrets writes it); default to localhost for a local box.
event_url() {
  local u; u="$(env_url)"
  [ -n "$u" ] || u="http://localhost"
  printf '%s' "$u"
}

# oauth-app: open GitHub's new-OAuth-App page for the event org and print the
# exact field values. OAuth Apps have no manifest/create API (UI-only), so
# unlike the GitHub App flow this only opens + guides — it cannot auto-fill.
cmd_oauth_app() {
  local org; org="$(env_val GITHUB_ORG)"
  [ -n "$org" ] || { echo "${OUT:-.env}: GITHUB_ORG missing — set it (or run the wizard) first" >&2; exit 1; }
  local url callback
  url="https://github.com/organizations/${org}/settings/applications/new"
  callback="$(event_url)/api/auth/callback/github"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN: open $url (callback $callback)"
    return 0
  fi
  echo "== opening GitHub's new-OAuth-App page for org '$org' in your browser"
  open_url "$url"
  cat <<EOF
== fill these fields (OAuth App creation is UI-only — copy/paste):
   Application name:            OWASP CTF in a Box ($org)
   Homepage URL:                $(event_url)
   Authorization callback URL:  $callback
   Then: "Register application" -> copy the Client ID -> "Generate a new
   client secret" -> copy it. Then wire them into .env:
        ctf-setup.sh oauth-config --client-id <client id>
   (You may create the OAuth App on your personal account instead of the org.)
EOF
}

# oauth-config: write the OAuth client id + secret into .env. The secret is
# read from a hidden prompt (never on argv / in shell history).
cmd_oauth_config() {
  local out="${OUT:-.env}"
  [ -n "$CLIENT_ID" ] || { echo "oauth-config: --client-id is required" >&2; exit 1; }
  [ -f "$out" ] || { echo "oauth-config: $out not found — run 'ctf-setup.sh secrets' first" >&2; exit 1; }
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN: set GITHUB_CLIENT_ID=$CLIENT_ID + GITHUB_CLIENT_SECRET=<prompted> in $out"
    return 0
  fi
  local secret
  printf 'GitHub OAuth client secret (input hidden): ' >&2
  read -rs secret; echo >&2
  [ -n "$secret" ] || { echo "oauth-config: empty client secret" >&2; exit 1; }
  set_env_var "$out" GITHUB_CLIENT_ID "$CLIENT_ID"
  set_env_var "$out" GITHUB_CLIENT_SECRET "$secret"
  echo "wrote GitHub OAuth credentials to $out (client id $CLIENT_ID)"
}

# --- wizard -----------------------------------------------------------------
wiz_step() { echo; printf '%s── %s%s\n' "$C_BOLD$C_CYAN" "$1" "$C_RESET"; }

# ASCII banner shown at the top of the wizard. It is a LOGOTYPE — it spells the
# project's brand, "OWASP CTF in a Box", so it moves whenever the brand does. It
# names nothing in anyone's GitHub account, unlike the `OWASP CTF sync` App name
# below, which is why that one keeps the pre-September-2026 brand and this one
# does not. Two stacked words rather than one line: the whole name in one run of
# this font is ~128 columns and the wizard has to read on an 80-column terminal.
# The second word is right-aligned under the first, so the block is 54 columns
# wide either way. Quoted heredoc — every backslash below is art, not an escape.
wiz_banner() {
  printf '%s' "$C_CYAN"
  cat <<'BANNER'
  _____        ___    ____  ____     ____ _____ _____
 / _ \ \      / / \  / ___||  _ \   / ___|_   _|  ___|
| | | \ \ /\ / / _ \ \___ \| |_) | | |     | | | |_
| |_| |\ V  V / ___ \ ___) |  __/  | |___  | | |  _|
 \___/  \_/\_/_/   \_\____/|_|      \____| |_| |_|
         ___  _   _        _       ____    ___  __  __
        |_ _|| \ | |      / \     | __ )  / _ \ \ \/ /
         | | |  \| |     / _ \    |  _ \ | | | | \  /
         | | | |\  |    / ___ \   | |_) || |_| | /  \
        |___||_| \_|   /_/   \_\  |____/  \___/ /_/\_\
BANNER
  printf '%s' "$C_RESET"
}

# Yes/No prompt. Returns 0 for yes. $2 is the default when the user just hits
# Enter — "Y" for the happy-path "do it now?" actions, "N" (default) for
# exceptional ones like retries. Under --dry-run it never blocks or mutates: it
# prints the question and answers "no" so the wizard just narrates.
ask_yn() {
  local reply def="${2:-N}" hint
  case "$def" in Y | y) hint="${C_GREEN}[Y/n]${C_RESET}" ;; *) hint="[y/N]" ;; esac
  if [ "$DRY_RUN" -eq 1 ]; then echo "$1 [dry-run: skipped]"; return 1; fi
  printf '%s %s ' "$1" "$hint"
  read -r reply || reply=""
  [ -n "$reply" ] || reply="$def"
  case "$reply" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# Expand a leading ~ / ~/ in a path to $HOME (read -r does not do it — tilde
# expansion is a shell parse-time step, not applied to variable values).
expand_tilde() {
  # The "~" patterns are literal string matches (quoted), not tilde expansions
  # we expect the shell to perform — that is the whole point of this helper.
  # shellcheck disable=SC2088
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${1:2}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Wait for the operator to finish a GitHub-UI step. No-op under --dry-run.
pause_confirm() {
  [ "$DRY_RUN" -eq 1 ] && { echo "$1 [dry-run: skipped]"; return 0; }
  printf '%s ' "$1"
  read -r _ || true
}

# Prompt for a value into the named variable, falling back to a default on an
# empty reply. Under --dry-run it never blocks or reads: it narrates the prompt
# and assigns the default, so the wizard stays non-interactive and side-effect
# free. Uses `printf -v` (bash 3.2 safe) for the indirect assignment.
wiz_ask() {
  local __var="$1" __prompt="$2" __def="${3:-}" __reply
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  %s [%s] (dry-run: default)\n' "$__prompt" "$__def"
    printf -v "$__var" '%s' "$__def"
    return 0
  fi
  if [ -n "$__def" ]; then
    printf '  %s [%s]: ' "$__prompt" "$__def"
  else
    printf '  %s: ' "$__prompt"
  fi
  read -r __reply || __reply=""
  [ -n "$__reply" ] || __reply="$__def"
  printf -v "$__var" '%s' "$__reply"
}

# Normalise a list typed at a prompt into the comma-separated form the app
# parses: "alice, Bob  carol" -> "alice,Bob,carol". Spaces AND commas are both
# separators, because organizers type both — and ADMIN_LOGINS is split on
# commas ONLY (apps/web/src/lib/admin-logins.ts), so "alice bob" left as typed
# would be one junk entry that matches nobody and an /admin that forbids them
# both. Prints nothing for an empty or separators-only answer, which is what
# makes the caller's "at least one admin" refusal fire.
#
# No spaces after the commas: this value is written to an env file that
# docker compose interpolates, where the shape stays a plain single token.
csv_of() {
  local out="" x
  for x in $(printf '%s' "$1" | tr ',' ' '); do
    out="$out${out:+,}$x"
  done
  printf '%s' "$out"
}

# Every target this build can provision, space-separated, read from
# targets.tsv — the same file prov_field/prov_repo_name validate against.
# Deliberately NOT a second hardcoded list: a target added to the TSV and not
# to the wizard's prompt is a target no organizer is ever offered.
all_targets() {
  local out="" t
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    out="$out${out:+ }$t"
  done < <(grep -v '^[[:space:]]*#' "$PROVENANCE_TSV" | cut -f1)
  printf '%s' "$out"
}

# Every command that provisions/inspects targets loops `for t in $(...)` over
# all_targets() — and all_targets() exits 0 with EMPTY output when
# targets.tsv is missing, unreadable or has no non-comment rows. Without this
# guard that turns "the TSV is broken" into a silent no-op: `org` prints its
# banner and forks nothing, `doctor` prints a header-only matrix, both exit 0
# as if there were zero targets to provision rather than a broken input.
#
# Call this as a PLAIN statement before the loop, never as `$(require_targets)`
# in the loop's own `in` list: `exit` inside a command substitution only kills
# that subshell, so `for t in $(require_targets); do` would still exit 0 —
# the loop just runs zero times, silently, which is the exact bug this guards
# against. Called plain, `exit 1` here does what it looks like it does.
require_targets() {
  if [ -z "$(all_targets)" ]; then
    echo "$PROVENANCE_TSV: no targets to provision (file missing, unreadable or empty)" >&2
    exit 1
  fi
}

# Step 3 of the wizard: the whole bootstrap plane, asked and written.
# $1 = the env file; $2 = 1 when step 2 has already asked for EVENT_URL in
# this run, so it is not asked twice. Sets WIZ_SCORE_IMAGE (the SCORE_IMAGE this run settled
# on) for the later steps, which must not re-read the file under --dry-run
# where nothing was written.
#
# Three keys, and only three: GITHUB_ORG, ADMIN_LOGINS and SCORE_IMAGE.
# Everything an organizer used to put in the deleted event config file — the
# event's name and branding, which modules run, which Secure Development
# targets run, the schedule — is a RUNTIME setting in /admin now (config v2,
# #386), so it is neither asked here nor written anywhere on disk.
#
# Its own function, not inline in cmd_wizard, so the suite can drive the
# questions with piped answers instead of walking nine steps to reach one
# write. Every answer defaults to what the file already carries: re-running
# the wizard is the documented recovery path, and an Enter-through must not
# switch the org, drop an admin or turn Secure Development off.
wiz_event_basics() {
  local out="$1" ev_org ev_admins ev_score ev_url adm_default sd_default
  echo "  Answer a few questions to write $out (Enter accepts the [default])."
  echo "  The event's name, the modules that run and the Secure Development"
  echo "  targets are runtime settings — set them in /admin once it is up."

  wiz_ask ev_org "GitHub org (disposable per-event org)" "$(env_val GITHUB_ORG)"

  # The login running the wizard, so Enter accepts and the empty-admins path
  # disappears for the common case. NOT under --dry-run: that makes zero gh
  # calls (AGENTS.md), which is exactly why the refusal below is reachable.
  adm_default="$(env_val ADMIN_LOGINS)"
  if [ -z "$adm_default" ] && [ "$DRY_RUN" -ne 1 ]; then
    adm_default="$(gh api user --jq .login 2>/dev/null || true)"
  fi
  wiz_ask ev_admins "Admin GitHub login(s), comma-separated" "$adm_default"
  ev_admins="$(csv_of "$ev_admins")"
  # Fail CLOSED, and say so, rather than writing the lockout: an empty
  # ADMIN_LOGINS makes /admin forbid EVERY login (admin-auth.ts), which is
  # silent until an organizer tries to open the panel mid-event.
  if [ -z "$ev_admins" ]; then
    echo "  refusing to write $out: at least one admin login is required — /admin would forbid everyone" >&2
    return 1
  fi

  # The one setup-time fact left about Secure Development: whether its
  # containers run at all. SCORE_IMAGE non-empty IS that answer, everywhere
  # (compose profiles, this script's own fork/mirror/poll steps).
  #
  # ask_yn hard-answers "no" under --dry-run so a rehearsal never mutates
  # anything; here that would narrate an event with Secure Development OFF
  # for a box whose env file has SCORE_IMAGE set, and steps 4-7 would
  # describe a run the real wizard would not make. So under --dry-run take
  # the DEFAULT, which is that file's own answer.
  sd_default=N
  if [ -n "$(env_val SCORE_IMAGE)" ]; then sd_default=Y; fi
  local sd_yes=1
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  Run Secure Development (fork the six targets and score patch PRs)? [$sd_default] (dry-run: default)"
    [ "$sd_default" = Y ] || sd_yes=0
  elif ! ask_yn "  Run Secure Development (fork the six targets and score patch PRs)?" "$sd_default"; then
    sd_yes=0
  fi
  ev_score=""
  if [ "$sd_yes" -eq 1 ]; then
    ev_score="$(env_val SCORE_IMAGE)"
    if [ -z "$ev_score" ]; then ev_score="ghcr.io/$ev_org/score:latest"; fi
    if [ -z "$ev_org" ]; then
      echo "  refusing to write $out: Secure Development forks into a GitHub org — GITHUB_ORG cannot be empty" >&2
      return 1
    fi
    echo "  Secure Development provisions all six from targets.tsv: $(all_targets)."
  fi

  # A deployment fact, not an event one (ADR 43): one event is served from a
  # box, from AWS and from fly.io on three hostnames. Step 2 asks when it
  # CREATES the file and tells us so ($2); this covers the file that existed
  # without the key, and never asks the same value twice in one run.
  ev_url=""
  if [ "${2:-0}" -ne 1 ]; then
    wiz_ask ev_url "Event URL contestants reach" "$(env_url)"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  DRY-RUN: would write GITHUB_ORG, ADMIN_LOGINS and SCORE_IMAGE to $out"
    [ -z "$ev_url" ] || echo "  DRY-RUN: would set EVENT_URL=$ev_url in $out"
  else
    set_env_var "$out" GITHUB_ORG "$ev_org"
    set_env_var "$out" ADMIN_LOGINS "$ev_admins"
    set_env_var "$out" SCORE_IMAGE "$ev_score"
    [ -z "$ev_url" ] || set_env_var "$out" EVENT_URL "$ev_url"
    echo "  ✅ wrote GITHUB_ORG, ADMIN_LOGINS and SCORE_IMAGE to $out"
  fi
  WIZ_SCORE_IMAGE="$ev_score"
}

# The optional step after the nine: put this same event on fly.io (issue #371).
#
# The nine steps stand up a LOCAL box — $1 is its bootstrap file and step 8
# brings compose up against it. Fly is a SECOND deployment of the same event,
# on a different hostname, with its own env file: that is why
# `deploy/fly/deploy.sh init` copies $1 to .env.fly and rewrites EVENT_URL
# there rather than sharing one file (ADR 43, and `env_url`'s comment). An
# organizer used to have to discover that whole sequence — init, the hostname,
# the second OAuth callback, the certificate — out of docs/fly.md; this offers
# it inline instead.
#
# Default NO, and non-fatal in EVERY direction. Answering no, having no
# flyctl, or abandoning the deploy half-way must all leave the run exactly as
# the nine steps left it, so every path here returns 0 naming the command to
# re-run and the caller adds `|| true`. Nothing in this step writes to $1: the
# public hostname belongs to the Fly deployment, and writing it into the
# compose box's EVENT_URL would break the box's own sign-in.
#
# Self-contained by design (one function, one call site). CTF_FLY_DEPLOY
# overrides the script it runs — the seam the bats suite drives it through,
# because the real deploy.sh renders compose.fly.yml into the repo and a test
# must not.
wiz_fly_deploy() {
  local from="$1" repo_root deploy fly_toml app from_abs fly_env host local_url valid
  wiz_step "Optional  Deploy to fly.io"

  # --dry-run makes zero flyctl/docker/gh calls (AGENTS.md), so even the "is
  # flyctl installed and signed in" probe is narrated rather than run.
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  DRY-RUN: would ask 'Deploy to fly.io now?' (default no, so a rehearsal declines) and, on yes:"
    echo "  DRY-RUN:   check flyctl is installed and signed in, then run deploy/fly/deploy.sh init --from $from"
    echo "  DRY-RUN:   ask for the public hostname and write it as EVENT_URL in .env.fly (never in $from)"
    echo "  DRY-RUN:   print the OAuth callback that hostname needs, preview the deploy and ask before running it"
    return 0
  fi

  repo_root="$(cd "$SCRIPT_DIR/.." && pwd)"
  deploy="${CTF_FLY_DEPLOY:-$repo_root/deploy/fly/deploy.sh}"
  fly_toml="$repo_root/deploy/fly/fly.toml"

  # Every refusal below names what is missing before it returns: a silent skip
  # here reads as "the kit cannot deploy to Fly" rather than "this box is not
  # ready to".
  if [ ! -f "$from" ]; then
    echo "  ⏭  skipped — no $from to deploy from."
    return 0
  fi
  if [ ! -x "$deploy" ]; then
    echo "  ⏭  skipped — $deploy is missing or not executable (see docs/fly.md)."
    return 0
  fi
  # deploy.sh requires SCORE_IMAGE: the Fly machine runs all five containers,
  # scorer and sync included, so an app-only event has nothing to hand it.
  if ! runs_secdev; then
    echo "  ⏭  skipped — the Fly module deploys the scorer and poller too, so it requires"
    echo "     SCORE_IMAGE, and this event has none (app-only). See docs/fly.md."
    return 0
  fi
  # The app name is fly.toml's, never a second copy: it is what the machine,
  # its certificates and its IPs are all named after.
  app="$(sed -n 's/^[[:space:]]*app[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$fly_toml" 2>/dev/null | tail -1)"
  if [ -z "$app" ]; then
    echo "  ⏭  skipped — cannot read the Fly app name from $fly_toml."
    return 0
  fi
  # flyctl may be absent or signed out. Both are a SKIP with the instruction,
  # never a failure: the nine steps above are done and the wizard must end
  # cleanly (the whole step is optional).
  if ! command -v fly >/dev/null 2>&1; then
    echo "  ⏭  no flyctl on PATH — install it (https://fly.io/docs/flyctl/install/), then run:"
    echo "     $deploy init --from $from"
    return 0
  fi
  if ! fly auth whoami >/dev/null 2>&1; then
    echo "  ⏭  flyctl is not signed in — run 'fly auth login', then:"
    echo "     $deploy init --from $from"
    return 0
  fi

  echo "  One Fly machine runs the same five containers compose does (docs/fly.md)."
  echo "  It is a SEPARATE deployment on its own hostname: its settings go in .env.fly,"
  echo "  and $from stays the compose box's."
  if ! ask_yn "  Deploy to fly.io now?" N; then
    echo "  Skipped — nothing above is affected. Deploy whenever you like:"
    echo "     $deploy init --from $from"
    echo "     $deploy"
    return 0
  fi

  # Absolute, because deploy.sh cd's to the repo root: a relative --from would
  # resolve against THAT directory and quietly read a different .env.
  from_abs="$from"
  case "$from_abs" in
    /*) ;;
    *) from_abs="$(cd "$(dirname "$from")" && pwd)/$(basename "$from")" ;;
  esac
  fly_env="$(dirname "$from_abs")/.env.fly"

  echo
  echo "  1/4  preparing $fly_env (deploy.sh init asks which Fly region to run in)"
  if ! "$deploy" init --from "$from_abs" --env-file "$fly_env"; then
    echo "  ⚠️  'deploy.sh init' failed — nothing was deployed and $from is untouched." >&2
    echo "     Fix the error above, then re-run:" >&2
    echo "     $deploy init --from $from_abs --env-file $fly_env" >&2
    return 0
  fi
  if [ ! -f "$fly_env" ]; then
    echo "  ⚠️  $fly_env was not created, so there is nothing to deploy from." >&2
    echo "     Re-run:  $deploy init --from $from_abs --env-file $fly_env" >&2
    return 0
  fi

  echo
  echo "  2/4  the hostname contestants reach this deployment at. Fly serves every"
  echo "       app at <app>.fly.dev; a custom domain needs a certificate (below)."
  wiz_ask host "Public hostname" "$app.fly.dev"
  # Organizers paste a URL. Take the host out of it rather than writing
  # EVENT_URL=https://https://host/.
  host="${host#http://}"
  host="${host#https://}"
  host="${host%%/*}"
  # This value becomes EVENT_URL in .env.fly, which Fly then serves as
  # BETTER_AUTH_URL and as the OAuth callback host — so a string that cannot
  # be a DNS name has to be caught HERE, before the file is written. Pure
  # glob cases, because the check runs under bash 3.2: no character outside
  # the LDH set, no leading or trailing dot, at least one dot, and no label
  # that is empty (`a..b`) or edged with a hyphen (`-a.b`, `a-.b`, `a.-b`,
  # `a.b-`) — those parse as hostnames to the eye and resolve nowhere.
  valid=0
  case "$host" in
    *[!A-Za-z0-9.-]*) ;;
    .* | *.) ;;
    *..*) ;;
    -* | *-) ;;
    *.-* | *-.*) ;;
    *.*) valid=1 ;;
  esac
  if [ "$valid" -ne 1 ]; then
    echo "  ⚠️  '$host' is not a hostname, so EVENT_URL was left as init wrote it." >&2
    echo "     Set it by hand in $fly_env, then:  $deploy --env-file $fly_env" >&2
    return 0
  fi
  local_url="$(env_url)"
  # Named for the prose below, where an empty EVENT_URL must still read as a
  # sentence rather than "the callback for , the compose box's URL".
  local box_url="$local_url"
  [ -n "$box_url" ] || box_url="the EVENT_URL in $from"
  set_env_var "$fly_env" EVENT_URL "https://$host"
  # set_env_var rewrites the file through mktemp+mv, which drops the mode 600
  # `init` gave it — and this file holds every secret the event has.
  chmod 600 "$fly_env"
  echo "  ✅ EVENT_URL=https://$host in $fly_env"
  echo "     ($from keeps its own EVENT_URL (${local_url:-<unset>}) — that is the compose box's.)"

  echo
  echo "  3/4  OAuth callback this hostname needs:"
  echo "       https://$host/api/auth/callback/github"
  echo "       Step 6 registered the callback for $box_url, the compose box's URL."
  echo "       GitHub matches the callback host exactly, so this deployment needs its own:"
  echo "       either point that OAuth app's callback at the line above (the box's own"
  echo "       sign-in then stops working), or register a SECOND OAuth app for this"
  echo "       hostname and put its client id/secret in $fly_env. Sign-in fails with a"
  echo "       redirect_uri mismatch until one of those is true."
  echo "       https://github.com/settings/developers"

  echo
  echo "  4/4  previewing the deploy — this makes no Fly calls:"
  if ! "$deploy" --dry-run --env-file "$fly_env"; then
    echo "  ⚠️  the preview failed, so nothing was deployed. $fly_env is written —" >&2
    echo "     fix the error above, then:  $deploy --env-file $fly_env" >&2
    return 0
  fi
  echo
  if ask_yn "  Deploy that to fly.io now (builds and pushes images, sets secrets, boots the machine)?" N; then
    if "$deploy" --env-file "$fly_env"; then
      echo "  ✅ deployed"
    else
      # Idempotent by design, like this script: re-running resumes.
      echo "  ⚠️  the deploy failed part-way. It is re-runnable — fix the error above, then:" >&2
      echo "     $deploy --env-file $fly_env" >&2
    fi
  else
    echo "  Not deployed. $fly_env is ready — run it when you are:"
    echo "     $deploy --env-file $fly_env"
  fi

  echo
  echo "  Fly hand-off:"
  echo "    - open https://$host, sign in, and configure the event in /admin"
  case "$host" in
    *.fly.dev) ;;
    *)
      # A custom domain is a first-class setup, but Fly will not serve TLS for
      # it until the certificate exists — and EVENT_URL is already set to it,
      # so a deploy without this is a hostname that answers nothing.
      echo "    - custom domain: it serves nothing until Fly holds a certificate for it —"
      echo "        fly certs add $host --app $app"
      echo "      then point the domain's DNS at the app as 'fly certs show' instructs"
      ;;
  esac
  echo "    - unreachable after a deploy that reported success? Fly's IP allocation has"
  echo "      failed mid-deploy before, so check the app actually has one:"
  echo "        fly ips list --app $app"
  return 0
}

# The default front door: walk a brand-new organizer from zero to a running,
# scored event, doing every automatable step and guiding + verifying each
# UI-only one. Resumable — it inspects state (check/doctor/the env file) and
# only prompts for what's missing, so re-running picks up where you left off.
# The discrete subcommands remain for scripting/CI; the wizard just orchestrates
# them. Stops with instructions whenever it needs you to do something off-box
# (edit a file, click Create in GitHub's UI); complete it and re-run.
cmd_wizard() {
  local out="${OUT:-.env}"
  # The SCORE_IMAGE step 3 settled on, for the later steps to key off when
  # there is nothing written to read it back from (--dry-run).
  WIZ_SCORE_IMAGE=""
  wiz_banner
  printf '%sOWASP CTF in a Box setup wizard%s — walks you to a running, scored event. Safe to re-run — it resumes.\n' "$C_BOLD" "$C_RESET"
  [ "$DRY_RUN" -eq 1 ] && echo "(dry-run: nothing will be changed)"

  # 1. Prerequisites (subshelled so cmd_check's exit doesn't kill the wizard).
  # Under --dry-run this is narrated, not probed: cmd_check runs `gh auth
  # status` and `docker compose version`, and --dry-run makes zero gh/docker
  # calls (AGENTS.md).
  wiz_step "1/9  Prerequisites"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  DRY-RUN: would check for gh, docker, compose, openssl and gh auth"
  elif ( cmd_check ) >/dev/null 2>&1; then
    echo "  ✅ gh, docker, compose, openssl, gh auth"
  else
    cmd_check || true
    echo "  Fix the above, then re-run the wizard."
    exit 1
  fi

  # 2. Secrets (.env).
  #
  # `url_asked` stops step 3 asking for EVENT_URL a second time on a first
  # run: this step already has the answer, and two prompts for one value read
  # as a bug in the wizard.
  wiz_step "2/9  Secrets ($out)"
  local url_asked=0
  if [ -f "$out" ]; then
    echo "  ✅ $out present"
  elif [ "$DRY_RUN" -eq 1 ]; then
    echo "  DRY-RUN: would generate $out via 'secrets' and prompt EVENT_URL"
  else
    cmd_secrets
    local ev_url
    wiz_ask ev_url "Box URL contestants reach (https:// for a real event)" "$(env_val EVENT_URL)"
    set_env_var "$out" EVENT_URL "$ev_url"
    echo "  ✅ EVENT_URL=$ev_url"
    url_asked=1
  fi

  # 3. Event basics — the whole of what this wizard writes.
  #
  # Already answered when there is an admin (the one key every event needs;
  # empty makes /admin forbid everyone), the Secure Development question has
  # been PUT at all (the SCORE_IMAGE line exists, empty or not — `secrets`
  # writes it empty, so only a hand-rolled file lacks it), and, if that
  # answer was yes, an org to fork into. An app-only event legitimately has
  # no GITHUB_ORG, so demanding one here would re-ask it every single run.
  wiz_step "3/9  Event basics ($out)"
  local basics_done=0
  if [ -n "$(env_val ADMIN_LOGINS)" ] && env_has SCORE_IMAGE; then
    if ! runs_secdev || [ -n "$(env_val GITHUB_ORG)" ]; then basics_done=1; fi
  fi
  if [ "$basics_done" -eq 1 ]; then
    # Resumed run: the bootstrap plane is already answered. Print what it
    # turns on (none of it is a secret) and move on — re-asking would risk an
    # Enter-through changing it. Turning Secure Development ON later is an
    # edit to this file, not a re-run, so say where the switch is.
    local have_org; have_org="$(env_val GITHUB_ORG)"
    echo "  ✅ $out (org: ${have_org:-<none>}, admins: $(env_val ADMIN_LOGINS))"
    if runs_secdev; then
      echo "     Secure Development: on (SCORE_IMAGE=$(env_val SCORE_IMAGE))"
    else
      echo "     Secure Development: off — set SCORE_IMAGE in $out (or re-run with SCORE_IMAGE removed) to turn it on"
    fi
    WIZ_SCORE_IMAGE="$(env_val SCORE_IMAGE)"
  elif ! wiz_event_basics "$out" "$url_asked"; then
    echo "  Fix that and re-run the wizard — it resumes." >&2
    exit 1
  fi

  # Everything from here on that touches forks, the scorer image or the poll
  # App belongs to Secure Development, and SCORE_IMAGE is the one fact that
  # says whether this event runs it (config v2, #386). An app-only event has
  # no repos to fork, no image to build and nothing to poll, so those steps
  # are reported as not-applicable rather than asking an organizer for
  # credentials they will never use.
  local secdev=0 provisioned=0
  if [ -n "$WIZ_SCORE_IMAGE" ]; then secdev=1; fi
  local org=""
  org="$(env_val GITHUB_ORG)"

  # 4. Scorer image.
  wiz_step "4/9  Scorer image (SCORE_IMAGE)"
  local img="$WIZ_SCORE_IMAGE"
  if [ "$secdev" -eq 0 ]; then
    echo "  ⏭  not needed — SCORE_IMAGE is empty, so this event does not run Secure Development"
  elif [ "$DRY_RUN" -eq 1 ]; then
    # Zero docker calls under --dry-run (AGENTS.md), so the local-presence
    # probe below is narrated rather than run.
    echo "  DRY-RUN: would check whether $img is built locally and offer to build it (linux/amd64)"
  elif docker image inspect "$img" >/dev/null 2>&1; then
    # Present locally: nothing to build. Say how it reaches the forks anyway
    # — `org` mirrors it into the event org, and that push needs a login.
    echo "  ✅ SCORE_IMAGE=$img (built locally)"
    echo "     Push it before provisioning:  docker login ghcr.io && docker push $img"
  elif ask_yn "  Build the scorer image ($img) now?" Y; then
    # linux/amd64 REQUIRED: GitHub runners are amd64; an arm64 image (the
    # default on Apple Silicon) fails the fork's scoring Action with "no
    # matching manifest for linux/amd64".
    docker build --platform linux/amd64 -t "$img" "$SCRIPT_DIR/../scorer"
    echo "  ✅ built (linux/amd64) $img"
    printf '  %sPush it before provisioning%s — the org step mirrors it and forks pull it:\n' "$C_YELLOW" "$C_RESET"
    echo "     docker login ghcr.io   # once, with a token that has write:packages"
    echo "     docker push $img"
  else
    echo "  Skipped. Build later (amd64) and push:"
    echo "     docker build --platform linux/amd64 -t $img $SCRIPT_DIR/../scorer"
    echo "     docker login ghcr.io && docker push $img"
  fi

  # 5. Sync GitHub App (poll auth).
  wiz_step "5/9  Sync GitHub App (poll auth)"
  if [ "$secdev" -eq 0 ]; then
    echo "  ⏭  not needed — this event does not run Secure Development (nothing to poll)"
  elif [ -n "$(env_val GITHUB_APP_ID)" ] && [ -n "$(env_val GITHUB_APP_PRIVATE_KEY)" ]; then
    echo "  ✅ GitHub App configured"
  elif [ "$DRY_RUN" -eq 1 ]; then
    echo "  DRY-RUN: would open the App-creation form, then prompt App ID + .pem path"
  else
    if ask_yn "  Open the App-creation form now?" Y; then cmd_app_manifest; fi
    pause_confirm "  Press Enter once you've clicked Create, generated the key (.pem), and installed the App…"
    while :; do
      wiz_ask APP_ID          "  App ID" ""
      wiz_ask PEM             "  Path to the downloaded .pem" ""
      PEM="$(expand_tilde "$PEM")"
      wiz_ask INSTALLATION_ID "  Installation ID (optional — Enter to auto-discover)" ""
      if ( cmd_app_config ); then break; fi
      ask_yn "  Re-enter the App ID / .pem path?" || break
    done
  fi

  # 6. Sign-in OAuth app.
  wiz_step "6/9  Sign-in OAuth app"
  if [ -n "$(env_val GITHUB_CLIENT_ID)" ] && [ -n "$(env_val GITHUB_CLIENT_SECRET)" ]; then
    echo "  ✅ OAuth app configured"
  elif [ "$DRY_RUN" -eq 1 ]; then
    echo "  DRY-RUN: would open the OAuth-app page, then prompt Client ID + hidden secret"
  else
    # Every event needs sign-in, Secure Development or not — but `oauth-app`
    # opens the ORG's registration page, and an app-only event has no org. It
    # would exit 1 naming GITHUB_ORG and take the wizard down with it, so
    # point at the personal-account page instead (registering it there is
    # already a documented option).
    if [ -z "$org" ]; then
      echo "  No event org, so register the OAuth app on your own account:"
      echo "    https://github.com/settings/applications/new"
      echo "    Homepage URL:                $(event_url)"
      echo "    Authorization callback URL:  $(event_url)/api/auth/callback/github"
    elif ask_yn "  Open the OAuth-app page now?" Y; then
      cmd_oauth_app
    fi
    pause_confirm "  Press Enter once you've registered the app and generated a client secret…"
    while :; do
      wiz_ask CLIENT_ID "  OAuth Client ID" ""
      if ( cmd_oauth_config ); then break; fi
      ask_yn "  Re-enter the Client ID / secret?" || break
    done
  fi

  # 7. Create + provision the org.
  #
  # The org exists for ONE reason: Secure Development forks into it. An
  # app-only event has no org (GITHUB_ORG is legitimately empty), so this
  # whole step — including the "create it, then re-run" stop, which used to
  # end such a run at step 7 with steps 8 and 9 never reached — is skipped
  # rather than asked.
  wiz_step "7/9  Event org (${org:-<none>})"
  if [ "$secdev" -eq 0 ]; then
    echo "  ⏭  not needed — this event does not run Secure Development (no org to fork into)"
  else
    # --dry-run makes zero gh/docker calls (AGENTS.md), so the existence probe
    # and the closing doctor sweep below are narrated, not run.
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "  DRY-RUN: would check that org $org exists (gh api orgs/$org)"
    elif gh_ok "orgs/$org"; then
      echo "  ✅ org $org exists"
    else
      echo "  Create it (UI-only): https://github.com/account/organizations/new  (name: $org)"
      pause_confirm "  Press Enter once the org exists…"
      if ! gh_ok "orgs/$org"; then
        echo "  Still can't see org $org — create it, then re-run."
        exit 0
      fi
    fi
    if ask_yn "  Provision the org now (fork targets, branches, workflow, image)?" Y; then
      # A failed provisioning is a stop, not a shrug: pausing for UI steps on
      # forks that do not exist, then bringing the stack up against them,
      # would only move the failure somewhere less legible.
      if cmd_org; then
        provisioned=1
      else
        echo "  Provisioning failed — fix the error above, then re-run (the wizard resumes)." >&2
        exit 1
      fi
    else
      echo "  Skipped. Run 'ctf-setup.sh org' (preview with --dry-run) when ready."
    fi
  fi
  # The UI-only steps come NOW, before verification, not after it. doctor used
  # to run right here, the instant provisioning finished, and only then did the
  # wizard say "finish the UI-only steps" — so every first run ended on a
  # table of ⚠️ for steps the organizer had not yet been given the chance to
  # do, and had to re-run doctor by hand to see it clean (issue #370). cmd_org
  # has just printed the checklist; pause on it, bring the stack up, and
  # verify once at the very end (step 9).
  #
  # Only when the forks were actually provisioned in THIS run: with the offer
  # declined there is nothing on GitHub to detach or grant yet, and a pause
  # would ask the organizer to confirm work that does not exist. --dry-run
  # never provisions, so it narrates the path a real run would take when
  # Secure Development is on.
  if [ "$DRY_RUN" -eq 1 ] && [ "$secdev" -eq 1 ]; then
    echo
    echo "  DRY-RUN: would pause for the UI-only steps (fork-network detach, package Read grant)"
  elif [ "$provisioned" -eq 1 ]; then
    echo
    echo "  UI-only steps before verification (GitHub settings, no API):"
    echo "    1. Each fork: Settings -> Leave fork network"
    echo "    2. ghcr.io/$org/score: keep PRIVATE, grant each fork Read (Manage Actions access)"
    pause_confirm "  Press Enter when done (or to continue now — step 9 re-checks, and 'ctf-setup.sh doctor' can re-run anytime)…"
  fi

  # 8. Bring the containers up.
  #
  # Compose profiles follow SCORE_IMAGE: `app` always, plus `secdev` — the
  # scorer AND the poller — only when this event runs Secure Development. An
  # app-only event needs neither: it has nothing to poll and no scorer image
  # to pull, and asking for one would fail the bring-up outright. There is no
  # second branch here any more: push ingest and its profile are REMOVED
  # (#377, ADR 56), so poll is the transport and `secdev` is the only answer.
  #
  # No build-arg: the app reads GITHUB_ORG and ADMIN_LOGINS from the env file
  # at RUN time now (config v2, #386) — nothing is baked into the image, so
  # changing an admin is an edit and a restart, not a rebuild.
  wiz_step "8/9  Bring the containers up"
  local profiles=(--profile app)
  if [ "$secdev" -eq 1 ]; then
    profiles=(--profile secdev "${profiles[@]}")
  fi
  echo "  docker compose ${profiles[*]} up -d --build"
  if ask_yn "  Bring the containers up now?" Y; then
    docker compose "${profiles[@]}" up -d --build
  fi

  # 9. Verify — last, on purpose (issue #370). This is the wizard's closing
  # screen: after the UI-only steps have had their pause and the stack is up,
  # a clean doctor table here means the event is ready, and a ⚠️ names the
  # one thing still to do. --dry-run makes zero gh calls, so it narrates.
  wiz_step "9/9  Verify"
  # secdev first, then dry-run: an app-only dry run must say the same thing
  # the real run would — nothing to verify — not that it would run doctor.
  if [ "$secdev" -eq 0 ]; then
    echo "  ⏭  nothing provisioned to verify — this event does not run Secure Development"
  elif [ "$DRY_RUN" -eq 1 ]; then
    echo "  DRY-RUN: would verify the org with 'ctf-setup.sh doctor'"
  else
    ( cmd_doctor ) || true
  fi

  # Optional, and deliberately NOT a tenth numbered step: the nine above stand
  # up the local box, and this offers to put the same event on fly.io as well
  # (issue #371). Default no, so a run that just wants the box is unchanged.
  # `|| true` because an abandoned or failed Fly deploy must never take the
  # wizard down after its .env work is already done — the function returns 0
  # on every skip itself, and this is the belt to that braces.
  wiz_fly_deploy "$out" || true

  # The closing screen. It names the KEYS the bootstrap file carries, never
  # their values: the same file holds BETTER_AUTH_SECRET, SRH_TOKEN,
  # SCORER_TOKEN and REDIS_PASSWORD, and a wizard that echoed them would put
  # every secret in a scrollback and a CI log.
  echo
  local open_at; open_at="$(env_url)"
  if [ -n "$open_at" ]; then
    echo "== Done. Open $open_at, sign in, and check /admin."
  else
    echo "== Done. Set EVENT_URL in $out, then open it, sign in and check /admin."
  fi
  echo "   $out is the whole bootstrap plane: GITHUB_ORG, ADMIN_LOGINS, SCORE_IMAGE,"
  echo "   EVENT_URL and the secrets. Everything else — which modules run, the event's"
  echo "   name and branding, the schedule, hint policy, caps — is set in /admin."
  echo "   Re-run 'ctf-setup.sh doctor' anytime to re-verify provisioning."
  if [ "$secdev" -eq 1 ]; then
    echo "   Secure Development provisions all six from targets.tsv: $(all_targets)."
    echo "   Choose which ones actually run in /admin -> Secure Development -> Targets."
  fi
}

if [ "$CMD" != "__selftest" ]; then
  case "$CMD" in
    ""|wizard) cmd_wizard ;;
    check) cmd_check ;;
    secrets) cmd_secrets ;;
    org) cmd_org ;;
    render) cmd_render ;;
    upgrade) cmd_upgrade ;;
    teardown) cmd_teardown ;;
    doctor) cmd_doctor ;;
    app-manifest) cmd_app_manifest ;;
    app-config) cmd_app_config ;;
    oauth-app) cmd_oauth_app ;;
    oauth-config) cmd_oauth_config ;;
    *) echo "usage: ctf-setup.sh [wizard|check|secrets|org|render|upgrade|teardown|doctor|app-manifest|app-config|oauth-app|oauth-config] [--dry-run] [--out .env] [--app-id N] [--pem path] [--installation-id N] [--client-id ID]" >&2
       echo "  run with no subcommand (or 'wizard') for the guided step-by-step setup" >&2; exit 2 ;;
  esac
fi
