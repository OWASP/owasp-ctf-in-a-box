#!/usr/bin/env bats

# Config v2 (#386): there is no event.yaml. The bootstrap plane is `.env` —
# GITHUB_ORG (the event org), ADMIN_LOGINS (who may open /admin) and
# SCORE_IMAGE, whose NON-EMPTINESS is how the box says "this event runs
# Secure Development". Everything else an organizer changes — the module set,
# the SD targets, identity, schedule — is a runtime /admin setting.
setup() {
  cd "$BATS_TEST_TMPDIR"
  _env_fixture
  SCRIPT="$BATS_TEST_DIRNAME/../ctf-setup.sh"
}

# The default bootstrap .env: an event that RUNS Secure Development.
_env_fixture() {
  cat > .env <<'EOF'
GITHUB_ORG=test-event-org
ADMIN_LOGINS=organizer
SCORE_IMAGE=ghcr.io/fixture/score:latest
EOF
}

# ...and one that does not: SCORE_IMAGE empty, so every fork/scorer step is
# skipped and only the app comes up.
_env_fixture_no_secdev() {
  cat > .env <<'EOF'
GITHUB_ORG=test-event-org
ADMIN_LOGINS=organizer
SCORE_IMAGE=
EOF
}

@test "org --dry-run plans the full idempotent sequence per target" {
  run env SCORE_IMAGE=ghcr.io/myorg/custom-score:v2 bash "$SCRIPT" org --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF "gh repo fork digininja/DVWA --org test-event-org --fork-name DVWA"
  echo "$output" | grep -qF "create refs/heads/ctf on test-event-org/DVWA from digininja/DVWA@d45ba3c"
  echo "$output" | grep -qF "branch protection on test-event-org/DVWA:ctf"
  echo "$output" | grep -qF ".github/workflows/ctf-score.yml on ctf"
  echo "$output" | grep -qF "disable every workflow on test-event-org/DVWA"
  echo "$output" | grep -qF "docker push ghcr.io/test-event-org/score:latest"
  echo "$output" | grep -qF "docker image inspect --format '{{.Architecture}}' ghcr.io/myorg/custom-score:v2"
  [ -z "$(echo "$output" | grep -F "OWASP-CTF/")" ]
  [ ! -e dist ]  # dry-run writes nothing
}

@test "org: an empty SCORE_IMAGE means no Secure Development — nothing forked, and it says how to enable it" {
  # Config v2 (#386): SCORE_IMAGE is the switch. Empty is not an error any
  # more (an app-only event has no scorer image), but it must not be silent
  # either — an organizer who MEANT to run Secure Development and forgot the
  # image would otherwise read "nothing to do" as "done".
  _env_fixture_no_secdev
  run bash "$SCRIPT" org --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF -- "does not run Secure Development"
  echo "$output" | grep -qF -- "docs/scorer.md"
  # Must plan no mutation at all
  [ -z "$(echo "$output" | grep -F -- "gh repo fork")" ]
  [ -z "$(echo "$output" | grep -F -- "docker pull")" ]
  [[ "$output" != *"ghcr.io/owasp-ctf/score"* ]]
}

# The switch is the value the BOX carries, not one an operator exported: an
# exported SCORE_IMAGE overrides only the image to mirror (a one-off retag),
# because docker compose reads the file to decide which services exist at
# all. An env var that could flip the switch would have `org` forking six
# repos for an event whose stack runs no scorer.
@test "org: an exported SCORE_IMAGE does not turn Secure Development on for an env file that says otherwise" {
  _env_fixture_no_secdev
  run env SCORE_IMAGE=ghcr.io/exported/score:v9 bash "$SCRIPT" org --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F -- "gh repo fork")" ]
  [ -z "$(echo "$output" | grep -F -- "docker pull")" ]
  echo "$output" | grep -qF -- "does not run Secure Development"
}

# A missing env file is not an app-only event. Reading every key as empty
# made `teardown` print "nothing to tear down" and exit 0 on a box whose six
# forks were all still there — the most expensive possible way to be wrong.
@test "teardown refuses a missing env file instead of reading it as 'no Secure Development'" {
  rm -f .env
  run bash "$SCRIPT" teardown --dry-run
  [ -z "$(printf '%s' "$output" | grep -F 'nothing to tear down')" ]
  echo "$output" | grep -qF -- ".env not found"
  [ "$status" -ne 0 ]
}

@test "doctor refuses a missing env file, naming the file" {
  rm -f .env
  run bash "$SCRIPT" doctor
  [ -z "$(printf '%s' "$output" | grep -F 'no provisioned content')" ]
  echo "$output" | grep -qF -- "not found"
  [ "$status" -ne 0 ]
}

@test "org, render and upgrade refuse a missing env file too" {
  rm -f .env
  for c in org render upgrade; do
    run bash "$SCRIPT" "$c" --dry-run
    echo "$c: $output"
    [ "$status" -ne 0 ]
    echo "$output" | grep -qF -- "not found"
  done
  # `check` and `secrets` must NOT gain the guard: one inspects the local
  # toolchain, the other CREATES the file.
  run bash "$SCRIPT" secrets --out .env.guard.test
  [ "$status" -eq 0 ]
}

# docker compose's .env reader ignores a trailing `# comment`, and organizers
# annotate this file. A value read as "myorg  # the disposable one" would be
# forked into as a repo owner of that name and printed as the org doctor
# inspected.
@test "env_val strips a trailing comment and surrounding whitespace" {
  printf 'GITHUB_ORG=test-event-org   # the disposable one\nADMIN_LOGINS= organizer \nSCORE_IMAGE=ghcr.io/fixture/score:latest\n' > .env
  run bash "$SCRIPT" org --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F 'disposable one')" ]
  echo "$output" | grep -qF -- "gh repo fork digininja/DVWA --org test-event-org --fork-name DVWA"
}

@test "org: a missing GITHUB_ORG fails with a clean message naming the key" {
  printf 'ADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\n' > .env
  run bash "$SCRIPT" org --dry-run
  [ "$status" -ne 0 ]
  [ -z "$(echo "$output" | grep -F -- "gh repo fork")" ]
  echo "$output" | grep -qF -- "GITHUB_ORG"
}

@test "render writes per-target workflows with all placeholders substituted" {
  run bash "$SCRIPT" render
  [ "$status" -eq 0 ]
  [ -f dist/workflows/dvwa.ctf-score.yml ]
  [ -f dist/workflows/vampi.ctf-score.yml ]
  grep -q "EVENT_ORG: test-event-org" dist/workflows/dvwa.ctf-score.yml
  grep -q "TARGET: dvwa" dist/workflows/dvwa.ctf-score.yml
  grep -q "APP_URL: http://dvwa:80" dist/workflows/dvwa.ctf-score.yml
  grep -q "APP_URL: http://vampi:5000" dist/workflows/vampi.ctf-score.yml
  # No placeholder survives rendering
  [ -z "$(grep -E "<EVENT_ORG>|<TARGET>|<APP_URL>" dist/workflows/dvwa.ctf-score.yml)" ]
  [ -z "$(grep -E "<EVENT_ORG>|<TARGET>|<APP_URL>" dist/workflows/vampi.ctf-score.yml)" ]
  # The rendered workflow keeps the re-run cap (modules.md section 6.3)
  grep -q "concurrency:" dist/workflows/dvwa.ctf-score.yml
  grep -q "group: ctf-score-dvwa-" dist/workflows/dvwa.ctf-score.yml
  grep -q "COOLDOWN_MINUTES" dist/workflows/dvwa.ctf-score.yml
}

@test "org --dry-run honors SCORE_IMAGE env var for the mirror source" {
  run env SCORE_IMAGE=ghcr.io/myorg/custom-score:v2 bash "$SCRIPT" org --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF -- "docker pull ghcr.io/myorg/custom-score:v2"
  echo "$output" | grep -qF -- "docker tag ghcr.io/myorg/custom-score:v2 ghcr.io/test-event-org/score:latest"
  [[ "$output" != *"docker pull ghcr.io/owasp-ctf/score:latest"* ]]
}

@test "org --dry-run reads SCORE_IMAGE from .env when env var unset" {
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/other/score:pinned\n' > .env
  run env -u SCORE_IMAGE bash "$SCRIPT" org --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF -- "docker pull ghcr.io/other/score:pinned"
  [[ "$output" == *"docker tag ghcr.io/other/score:pinned ghcr.io/test-event-org/score:latest"* ]]
}

@test "secrets generates all required values" {
  run bash "$SCRIPT" secrets --out .env.test
  [ "$status" -eq 0 ]
  for var in BETTER_AUTH_SECRET SRH_TOKEN SCORER_TOKEN REDIS_PASSWORD; do
    grep -qE "^${var}=.{20,}" .env.test
  done
}

# Config v2 (#386): the generated env file is the WHOLE bootstrap plane now,
# so the two keys that used to live in event.yaml have to be in the template
# an organizer edits — an absent key is one nobody knows to fill in, and an
# empty ADMIN_LOGINS locks /admin for everyone (fail closed, by design).
@test "secrets emits the bootstrap keys event.yaml used to carry" {
  run bash "$SCRIPT" secrets --out .env.bootstrap.test
  [ "$status" -eq 0 ]
  grep -qx "GITHUB_ORG=" .env.bootstrap.test
  grep -qx "SCORE_IMAGE=" .env.bootstrap.test
  # Says what empty MEANS, right where it is empty.
  grep -qF "/admin" .env.bootstrap.test
  grep -qx "ADMIN_LOGINS=" .env.bootstrap.test
}

# Its own test, not just another entry in the loop above: docker-compose.yml
# uses `${REDIS_PASSWORD:?...}`, so an .env without this value does not start
# a weaker stack — it does not start at all. A generator that silently stopped
# emitting it would strand every new organizer at the bring-up.
@test "secrets generates a Redis password, without which compose refuses to start" {
  run bash "$SCRIPT" secrets --out .env.redispw.test
  [ "$status" -eq 0 ]
  grep -qE "^REDIS_PASSWORD=[0-9a-f]{32,}$" .env.redispw.test
}

@test "teardown --dry-run plans archive of all six target repos" {
  # Config v2 PR2 (#386): no targets list is read from anywhere — every event
  # provisions, and tears down, all six targets.tsv repos. Which ones RUN is
  # an /admin runtime setting.
  run bash "$SCRIPT" teardown --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF -- "gh repo archive test-event-org/DVWA --yes"
  echo "$output" | grep -qF -- "gh repo archive test-event-org/VAmPI --yes"
  echo "$output" | grep -qF -- "gh repo archive test-event-org/juice-shop --yes"
  echo "$output" | grep -qF -- "gh repo archive test-event-org/WebGoat --yes"
  echo "$output" | grep -qF -- "gh repo archive test-event-org/VulnerableApp --yes"
  [[ "$output" == *"gh repo archive test-event-org/SecurityShepherd --yes"* ]]
}

@test "teardown fails with missing org (MEDIUM fix #3)" {
  printf 'ADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\n' > .env
  run bash "$SCRIPT" teardown --dry-run
  [ "$status" -ne 0 ]
  [ -z "$(printf '%s' "$output" | grep -F 'gh repo archive')" ]
  [[ "$output" == *"GITHUB_ORG"* ]]
}

@test "org: an app-only event (no SCORE_IMAGE) provisions nothing and succeeds" {
  _env_fixture_no_secdev
  run bash "$SCRIPT" org --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(printf '%s' "$output" | grep -F 'gh repo fork')" ]
}

@test "render: an app-only event (no SCORE_IMAGE) writes nothing and succeeds" {
  _env_fixture_no_secdev
  run bash "$SCRIPT" render
  [ "$status" -eq 0 ]
  [ ! -d dist ]
}

@test "teardown: an app-only event (no SCORE_IMAGE) archives nothing and succeeds" {
  _env_fixture_no_secdev
  run bash "$SCRIPT" teardown --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(printf '%s' "$output" | grep -F 'gh repo archive')" ]
}

@test "doctor: an app-only event (no SCORE_IMAGE) reports no provisioned content" {
  _env_fixture_no_secdev
  run bash "$SCRIPT" doctor --dry-run
  [ "$status" -eq 0 ]
  printf '%s' "$output" | grep -qi 'no .*content'
}

@test "doctor: empty targets.tsv fails loudly, naming the file (require_targets guard)" {
  # all_targets() exits 0 with empty output when targets.tsv is missing,
  # unreadable or has no non-comment rows — require_targets() is the guard
  # that turns that into a loud failure instead of a silent no-op (a
  # header-only matrix exiting 0). Run against a COPY of the script so
  # SCRIPT_DIR resolves to a directory with a broken targets.tsv, leaving the
  # real setup/targets.tsv untouched.
  mkdir -p brokentsv
  cp "$SCRIPT" brokentsv/ctf-setup.sh
  : > brokentsv/targets.tsv
  run bash brokentsv/ctf-setup.sh doctor --dry-run
  printf '%s' "$output" | grep -qF 'targets.tsv'
  printf '%s' "$output" | grep -qF 'no targets to provision'
  [ "$status" -ne 0 ]
}

# --- doctor: check (a) ADMIN_LOGINS (issue #382) ----------------------------

@test "doctor check (a): fails and names the key when ADMIN_LOGINS is empty" {
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=\nSCORE_IMAGE=\n' > .env
  run bash "$SCRIPT" doctor --dry-run
  printf '%s' "$output" | grep -qF -- "❌ ADMIN_LOGINS is empty"
  printf '%s' "$output" | grep -qF -- "nobody can open /admin"
  [ "$status" -ne 0 ]
}

@test "doctor check (a): passes when ADMIN_LOGINS is set" {
  _env_fixture_no_secdev
  run bash "$SCRIPT" doctor --dry-run
  printf '%s' "$output" | grep -qF -- "✅ ADMIN_LOGINS: organizer"
}

# --- doctor: check (b) GITHUB_ORG (issue #382) -------------------------------

@test "doctor check (b): fails when GITHUB_ORG is empty and Secure Development is on" {
  printf 'GITHUB_ORG=\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\n' > .env
  run bash "$SCRIPT" doctor --dry-run
  printf '%s' "$output" | grep -qF -- "❌ GITHUB_ORG is empty"
  printf '%s' "$output" | grep -qF -- "Secure Development is on"
  [ "$status" -ne 0 ]
}

@test "doctor check (b): only warns when GITHUB_ORG is empty and Secure Development is off" {
  printf 'GITHUB_ORG=\nADMIN_LOGINS=organizer\nSCORE_IMAGE=\n' > .env
  run bash "$SCRIPT" doctor --dry-run
  [ "$status" -eq 0 ]
  printf '%s' "$output" | grep -qF -- "⚠️  GITHUB_ORG is empty"
  [ -z "$(printf '%s' "$output" | grep -F -- '❌ GITHUB_ORG')" ]
}

@test "doctor check (b): passes when GITHUB_ORG is set" {
  run bash "$SCRIPT" doctor --dry-run
  printf '%s' "$output" | grep -qF -- "✅ GITHUB_ORG: test-event-org"
}

# --- doctor: check (c) sync GitHub App installed on the org (issue #382) ----
#
# `gh api "orgs/$org/installations" --jq '.installations[].app_id'` is the
# read this check makes (R4). ANY gh error — non-zero exit OR a successful
# call with empty output — reports "not verified" and fails closed; it must
# never read as "installed". Runs only when Secure Development is on
# (runs_secdev): an app-only event has no sync poller/pusher needing a token.

# Same shape as write_gh_grant_stub above: a canned gh answering exactly the
# endpoint this check reads and refusing everything else, so a stray call
# elsewhere in doctor surfaces as a loud failure instead of a silent pass.
write_gh_installations_stub() {  # $1 = newline-separated "app_id app_slug" rows (may be empty)
  mkdir -p stubs
  cat > stubs/gh <<EOF
#!/usr/bin/env bash
case "\$*" in
  *"orgs/test-event-org/installations"*"--jq"*)
    printf '%s\n' "$1"
    ;;
  *"packages/container/score"*) echo private ;;
  *) exit 1 ;;
esac
EOF
  chmod +x stubs/gh
}

@test "doctor check (c): passes when GITHUB_APP_ID is among the org's installations" {
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\nGITHUB_APP_ID=42\n' > .env
  write_gh_installations_stub "$(printf '99 other-app\n42 ctf-sync')"
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qF -- "✅ sync App (GITHUB_APP_ID=42) installed on test-event-org"
}

@test "doctor check (c): fails and prints the generic install URL when the App is not installed" {
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\nGITHUB_APP_ID=42\n' > .env
  write_gh_installations_stub "$(printf '99 other-app\n7 another-app')"
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qF -- "❌ sync App (GITHUB_APP_ID=42) not installed on test-event-org"
  printf '%s' "$output" | grep -qF -- "https://github.com/organizations/test-event-org/settings/installations"
  [ "$status" -ne 0 ]
}

@test "doctor check (c): a gh error reports not verified, never installed" {
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\nGITHUB_APP_ID=42\n' > .env
  mkdir -p stubs
  cat > stubs/gh <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"packages/container/score"*) echo private ;;
  *) exit 1 ;;
esac
EOF
  chmod +x stubs/gh
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qF -- "not verified"
  printf '%s' "$output" | grep -qF -- "admin:org scope"
  [ -z "$(printf '%s' "$output" | grep -F -- '✅ sync App')" ]
  [ -z "$(printf '%s' "$output" | grep -F -- 'installed on')" ]
  [ "$status" -ne 0 ]
}

@test "doctor check (c): an empty-but-successful installations list is also not verified, not 'not installed'" {
  # A real empty org (zero installations of anything) is indistinguishable
  # here from a scope error that silently produced no output — R4 says treat
  # both as unverified rather than confidently asserting "not installed".
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\nGITHUB_APP_ID=42\n' > .env
  write_gh_installations_stub ""
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qF -- "not verified"
  [ -z "$(printf '%s' "$output" | grep -F -- 'not installed on')" ]
  [ "$status" -ne 0 ]
}

@test "doctor check (c): fails closed on an empty GITHUB_APP_ID, naming the key, with no gh call" {
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\nGITHUB_APP_ID=\n' > .env
  mkdir -p stubs
  # Any call at all is a failure of this test's premise.
  printf '#!/usr/bin/env bash\necho "gh $*" >> "%s/gh.calls"\nexit 1\n' "$BATS_TEST_TMPDIR" > stubs/gh
  chmod +x stubs/gh
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qF -- "❌ GITHUB_APP_ID is empty"
  [ -z "$(grep -F 'installations' "$BATS_TEST_TMPDIR/gh.calls" 2>/dev/null || true)" ]
  [ "$status" -ne 0 ]
}

@test "doctor check (c): skipped entirely for an app-only event (no Secure Development)" {
  _env_fixture_no_secdev
  run bash "$SCRIPT" doctor --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(printf '%s' "$output" | grep -F -- 'sync App')" ]
  [ -z "$(printf '%s' "$output" | grep -F -- 'GITHUB_APP_ID')" ]
}

@test "doctor check (c) under --dry-run makes no installations call and narrates instead" {
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\nGITHUB_APP_ID=42\n' > .env
  mkdir -p "$BATS_TEST_TMPDIR/stubbin"
  printf '#!/usr/bin/env bash\necho "gh $*" >> "%s/gh.calls"\nexit 1\n' "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/stubbin/gh"
  chmod +x "$BATS_TEST_TMPDIR/stubbin/gh"
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor --dry-run
  printf '%s' "$output" | grep -qF -- "DRY-RUN: would check whether the sync App (GITHUB_APP_ID=42) is installed on test-event-org"
  [ -z "$(grep -F 'installations' "$BATS_TEST_TMPDIR/gh.calls" 2>/dev/null || true)" ]
}

# --- doctor: deprecated push ingest (issue #377) -----------------------------
#
# Push ingest is deprecated and REMOVED in v0.7, so doctor — where an
# organizer looks — names what is left of it. Two independent warnings, both
# ADVISORY (a push event still boots this release, so neither may fail the
# exit code): the `.env` switch itself, and the two org Actions secrets the
# push transport needs, which are read by contestant-triggered runs and have
# nothing left to authorize once an event is off push.
#
# The secrets read is `gh api orgs/<org>/actions/secrets --jq
# '.secrets[].name'`, and it follows check (c)'s fail-closed convention: a
# non-zero exit OR an empty reply from a successful call is "not verified",
# never "absent" — an organizer told their standing credentials are gone when
# the API merely refused to answer is the one wrong thing to say here.

# Same shape as write_gh_installations_stub: a canned gh answering exactly
# this check's endpoint and refusing everything else, so a stray call
# elsewhere surfaces as a loud failure rather than a silent pass.
write_gh_secrets_stub() {  # $1 = newline-separated secret names (may be empty)
  mkdir -p stubs
  cat > stubs/gh <<EOF
#!/usr/bin/env bash
case "\$*" in
  # --paginate is part of the call: the check must see every secret the org
  # has, not gh's first page of 30 (a truncated list reading as "none left"
  # is the fail-open this whole check is about).
  *"--paginate"*"orgs/test-event-org/actions/secrets"*"--jq"*)
    printf '%s\n' "$1"
    ;;
  *"packages/container/score"*) echo private ;;
  *) exit 1 ;;
esac
EOF
  chmod +x stubs/gh
}

@test "doctor names a leftover SCORE_INGEST=push as a key nothing reads any more" {
  # SCORE_IMAGE empty on purpose: this notice is printed BEFORE the
  # Secure-Development early return, so a box that carries the key hears about
  # it even when nothing fork-based is left to inspect.
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=\nSCORE_INGEST=push\n' > .env
  mkdir -p stubs
  printf '#!/usr/bin/env bash\nexit 1\n' > stubs/gh
  chmod +x stubs/gh
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qF -- 'says SCORE_INGEST=push — push ingest is REMOVED (issue #377)'
  printf '%s' "$output" | grep -qF -- 'Delete the line.'
  # Advisory, not a defect: the key is inert now, so an app-only box with every
  # required key set is still healthy.
  [ "$status" -eq 0 ]
}

@test "doctor says nothing about the transport when SCORE_INGEST is poll" {
  # The value every `.env` this wizard ever wrote carries. It agrees with the
  # behaviour exactly, so it must not put a ⚠️ on an upgraded box.
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=\nSCORE_INGEST=poll\n' > .env
  mkdir -p stubs
  printf '#!/usr/bin/env bash\nexit 1\n' > stubs/gh
  chmod +x stubs/gh
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  [ "$status" -eq 0 ]
  [ -z "$(printf '%s' "$output" | grep -F -- 'SCORE_INGEST')" ]
}

@test "doctor names any other SCORE_INGEST value too, and fails on none of them" {
  # Before #377 removed the key, a value that was neither mode expanded into
  # caddy/Caddyfile.<that> and the bring-up failed looking for a file that did
  # not exist — so doctor had to exit non-zero. Compose now mounts a constant
  # Caddyfile.poll, so the same value is inert: naming it is right, failing on
  # it would be a lie about a box that comes up fine.
  printf 'ADMIN_LOGINS=organizer\nGITHUB_ORG=\nSCORE_IMAGE=\nSCORE_INGEST=pussh\n' > .env
  mkdir -p stubs
  printf '#!/usr/bin/env bash\nexit 1\n' > stubs/gh
  chmod +x stubs/gh
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  # No org and no scorer image on purpose: the no-org return sits early in
  # cmd_doctor, and an app-only event is the box most likely to carry a
  # hand-edited .env — a check placed after that return would never run for it.
  printf '%s' "$output" | grep -qF -- 'says SCORE_INGEST=pussh'
  [ -z "$(printf '%s' "$output" | grep -F -- 'Caddyfile.pussh')" ]
  [ "$status" -eq 0 ]
}

@test "doctor names the push-mode org secrets that are still set" {
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\nGITHUB_APP_ID=42\n' > .env
  write_gh_secrets_stub "$(printf 'SOMETHING_ELSE\nLEADERBOARD_URL\nLEADERBOARD_TOKEN')"
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qF -- 'push-mode org secrets still set: LEADERBOARD_URL LEADERBOARD_TOKEN'
  printf '%s' "$output" | grep -qF -- '#377'
  printf '%s' "$output" | grep -qF -- 'https://github.com/organizations/test-event-org/settings/secrets/actions'
}

@test "doctor reports no push-mode leftovers when the org's secret list has none" {
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\nGITHUB_APP_ID=42\n' > .env
  write_gh_secrets_stub "$(printf 'SOMETHING_ELSE\nANOTHER_SECRET')"
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qF -- 'no leftover push-mode org secrets (#377)'
  [ -z "$(printf '%s' "$output" | grep -F -- 'still set')" ]
}

@test "doctor's push-secrets check fails closed on a gh error: not verified, never absent" {
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\nGITHUB_APP_ID=42\n' > .env
  mkdir -p stubs
  cat > stubs/gh <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"packages/container/score"*) echo private ;;
  *) exit 1 ;;
esac
EOF
  chmod +x stubs/gh
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qF -- 'push-mode org secrets (LEADERBOARD_URL, LEADERBOARD_TOKEN) not verified'
  printf '%s' "$output" | grep -qF -- 'admin:org scope'
  [ -z "$(printf '%s' "$output" | grep -F -- 'no leftover push-mode org secrets')" ]
}

@test "doctor's push-secrets check treats an empty-but-successful list as unverified too" {
  # An org with zero secrets of any kind is indistinguishable here from a
  # scope error that produced no output — same reasoning as check (c).
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\nGITHUB_APP_ID=42\n' > .env
  write_gh_secrets_stub ""
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  # The whole phrase, not a bare "not verified": doctor prints that for the
  # sync App too, and this assertion passed against the pre-#377 script on
  # that line alone.
  printf '%s' "$output" | grep -qF -- 'push-mode org secrets (LEADERBOARD_URL, LEADERBOARD_TOKEN) not verified'
  [ -z "$(printf '%s' "$output" | grep -F -- 'no leftover push-mode org secrets')" ]
}

@test "doctor's push-secrets check makes no gh call under --dry-run and narrates instead" {
  printf 'GITHUB_ORG=test-event-org\nADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\nGITHUB_APP_ID=42\n' > .env
  mkdir -p "$BATS_TEST_TMPDIR/stubbin"
  printf '#!/usr/bin/env bash\necho "gh $*" >> "%s/gh.calls"\nexit 1\n' "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/stubbin/gh"
  chmod +x "$BATS_TEST_TMPDIR/stubbin/gh"
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor --dry-run
  printf '%s' "$output" | grep -qF -- 'DRY-RUN: would check test-event-org for the removed push-mode secrets (LEADERBOARD_URL, LEADERBOARD_TOKEN)'
  [ -z "$(grep -F 'actions/secrets' "$BATS_TEST_TMPDIR/gh.calls" 2>/dev/null || true)" ]
}

@test "check succeeds with no .env at all (regression fix)" {
  # `check` inspects the local toolchain only — it must not demand any config
  # file to tell an organizer whether gh/docker/openssl are usable.
  rm -f .env
  mkdir -p stubs
  cat > stubs/gh <<'EOF'
#!/bin/bash
if [[ "$1" == "auth" && "$2" == "status" ]]; then
  echo "logged in"
  exit 0
fi
exit 1
EOF
  cat > stubs/docker <<'EOF'
#!/bin/bash
if [[ "$1" == "compose" && "$2" == "version" ]]; then
  echo "Docker Compose version v2.0"
  exit 0
fi
exit 1
EOF
  cat > stubs/openssl <<'EOF'
#!/bin/bash
exit 0
EOF
  chmod +x stubs/gh stubs/docker stubs/openssl

  # Run check with stubs in PATH (no .env in the directory)
  PATH="$(pwd)/stubs:$PATH" run bash "$SCRIPT" check
  [ "$status" -eq 0 ]
  # Must NOT fail looking for a config file
  [ -z "$(echo "$output" | grep -F -- "not found")" ]
  [[ "$output" == *"OK: prerequisites present"* ]]
}

@test "targets.tsv drives prov_field/prov_repo_name" {
  run bash -c 'source "'"$SCRIPT"'" __selftest 2>/dev/null; prov_field juice-shop 2'
  [ "$status" -eq 0 ]
  [ "$output" = "juice-shop/juice-shop" ]
}

@test "prov_repo_name returns fork name; unknown target fails" {
  run bash -c 'CMD=__selftest source "'"$SCRIPT"'"; prov_repo_name vulnerableapp'
  [ "$status" -eq 0 ]; [ "$output" = "VulnerableApp" ]
  run bash -c 'CMD=__selftest source "'"$SCRIPT"'"; prov_field nope 2'
  [ "$status" -ne 0 ]; [[ "$output" == *"unknown target: nope"* ]]
}

@test "secrets succeeds on a bare box with no config of any kind (regression fix)" {
  rm -f .env
  run bash "$SCRIPT" secrets --out .env.secrets.test
  [ "$status" -eq 0 ]
  # Verify file was created with required variables
  for var in BETTER_AUTH_SECRET SRH_TOKEN SCORER_TOKEN REDIS_PASSWORD; do
    grep -qE "^${var}=.{20,}" .env.secrets.test
  done
}

@test "static artifacts exist with the right shape" {
  [ -f "$BATS_TEST_DIRNAME/../PULL_REQUEST_TEMPLATE.md" ]
  grep -q "SCORED, not merged" "$BATS_TEST_DIRNAME/../PULL_REQUEST_TEMPLATE.md"
  [ -f "$BATS_TEST_DIRNAME/../vulnerableapp.Dockerfile" ]
  grep -q "EXPOSE 9090" "$BATS_TEST_DIRNAME/../vulnerableapp.Dockerfile"
}

make_gh_stub() {  # $1 = "found" | "missing"
  mkdir -p stubs
  cat > stubs/gh <<EOF
#!/usr/bin/env bash
# canned gh for tests. "$1"=found makes api reads succeed.
if [ "\$1" = api ]; then [ "$1" = found ] && exit 0 || exit 1; fi
# 'gh repo fork ...' and others: succeed.
exit 0
EOF
  chmod +x stubs/gh
}

@test "org --dry-run forks from upstream (not OWASP-CTF)" {
  run env SCORE_IMAGE=ghcr.io/myorg/s:v1 bash "$SCRIPT" org --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF "gh repo fork digininja/DVWA --org test-event-org --fork-name DVWA"
  echo "$output" | grep -qF "gh repo fork erev0s/VAmPI --org test-event-org --fork-name VAmPI"
  ! echo "$output" | grep -qF "OWASP-CTF/"
}

@test "ctf-branch + drop-old plan lines render" {
  # Exercise plan_step directly via a sourced self-test.
  run bash -c 'DRY_RUN=1; CMD=__selftest source "'"$SCRIPT"'"; plan_step ctf-branch dvwa test-event-org; plan_step drop-old dvwa test-event-org'
  echo "$output" | grep -qF "create refs/heads/ctf on test-event-org/DVWA from digininja/DVWA@d45ba3c"
  echo "$output" | grep -qF "delete master/main on test-event-org/DVWA"
}

@test "protect plan + check use the ctf branch protection endpoint" {
  run bash -c 'DRY_RUN=1; CMD=__selftest source "'"$SCRIPT"'"; plan_step protect webgoat test-event-org'
  [[ "$output" == *"branch protection on test-event-org/WebGoat:ctf"* ]]
}

@test "workflow + disable-inherited plan lines render" {
  run bash -c 'DRY_RUN=1; CMD=__selftest source "'"$SCRIPT"'"; plan_step workflow dvwa test-event-org; plan_step disable-inherited dvwa test-event-org'
  echo "$output" | grep -qF ".github/workflows/ctf-score.yml on ctf"
  echo "$output" | grep -qF "disable every workflow"
}

@test "check_step disable-inherited fails closed when gh api errors" {
  mkdir -p stubs
  cat > stubs/gh <<'EOF2'
#!/usr/bin/env bash
[ "$1" = api ] && exit 1
exit 0
EOF2
  chmod +x stubs/gh
  # Exercise the real call context (`if check_step …`), where set -e is
  # suppressed and the `|| return 1` in check_step is what forces
  # "not satisfied" — a bare top-level call would abort the subprocess on the
  # stub's failure and pass vacuously regardless of the fix.
  PATH="$(pwd)/stubs:$PATH" run bash -c 'CMD=__selftest source "'"$SCRIPT"'"; if check_step disable-inherited dvwa test-event-org; then echo SATISFIED; else echo NOTSATISFIED; fi'
  [ "$status" -eq 0 ]
  echo "$output" | grep -qx NOTSATISFIED
}

@test "check_step drop-old fails closed when the branch list call errors" {
  mkdir -p stubs
  cat > stubs/gh <<'EOF2'
#!/usr/bin/env bash
[ "$1" = api ] && exit 1
exit 0
EOF2
  chmod +x stubs/gh
  # Same rationale as the disable-inherited test above: exercise via `if
  # check_step …` so the `|| return 1` (not set -e) decides the outcome.
  PATH="$(pwd)/stubs:$PATH" run bash -c 'CMD=__selftest source "'"$SCRIPT"'"; if check_step drop-old dvwa test-event-org; then echo SATISFIED; else echo NOTSATISFIED; fi'
  [ "$status" -eq 0 ]
  echo "$output" | grep -qx NOTSATISFIED
}

@test "doctor table: fork column flips missing->done via stubbed gh" {
  # doctor renders a matrix (row per target, column per step). The fork cell is
  # the first status column, so awk column 2 of the target's row is its fork
  # state. missing gh => ❌ + nonzero exit; found gh => ✅.
  make_gh_stub missing
  PATH="$(pwd)/stubs:$PATH" run bash "$SCRIPT" doctor
  [ "$status" -ne 0 ]
  [ "$(echo "$output" | awk '/^dvwa/{print $2}')" = "❌" ]
  make_gh_stub found
  PATH="$(pwd)/stubs:$PATH" run bash "$SCRIPT" doctor
  [ "$(echo "$output" | awk '/^dvwa/{print $2}')" = "✅" ]
}

@test "pr-template plan + check use the ctf branch contents endpoint" {
  run bash -c 'DRY_RUN=1; CMD=__selftest source "'"$SCRIPT"'"; plan_step pr-template dvwa test-event-org'
  echo "$output" | grep -q "PUT setup/PULL_REQUEST_TEMPLATE.md to test-event-org/DVWA:.github/PULL_REQUEST_TEMPLATE.md on ctf"
}

@test "vapp-dockerfile only plans for vulnerableapp" {
  run bash -c 'DRY_RUN=1; CMD=__selftest source "'"$SCRIPT"'"; plan_step vapp-dockerfile dvwa test-event-org; echo "---"; plan_step vapp-dockerfile vulnerableapp test-event-org'
  echo "$output" | grep -qF -- "---"
  before="${output%%---*}"
  # vulnerableapp must actually get the PUT line (rules out a stub that never emits).
  echo "$output" | grep -q "PUT setup/vulnerableapp.Dockerfile to test-event-org/VulnerableApp:Dockerfile"
  # dvwa: nothing before the separator — this is the decisive, gating check.
  [ -z "$(echo "$before" | grep -o Dockerfile)" ]
}

@test "check_step vapp-dockerfile is satisfied (n/a) for non-vulnerableapp targets" {
  run bash -c 'CMD=__selftest source "'"$SCRIPT"'"; check_step vapp-dockerfile dvwa test-event-org'
  [ "$status" -eq 0 ]
}

@test "app-manifest --dry-run targets the event org's App-creation URL" {
  run bash "$SCRIPT" app-manifest --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF -- "organizations/test-event-org/settings/apps/new"
  # redirect_url is REQUIRED by the create-from-manifest flow
  echo "$output" | grep -qF -- "redirect_url="
  # dry-run must not open a browser or write an HTML form
  [ -z "$(echo "$output" | grep -F "STUB-OPEN")" ]
}

@test "app-config writes the App id + base64 key into .env" {
  printf 'GITHUB_APP_ID=\nGITHUB_APP_PRIVATE_KEY=\nGITHUB_APP_INSTALLATION_ID=\nEVENT_URL=x\n' > .env
  openssl genrsa -out app.pem 2048 2>/dev/null
  run bash "$SCRIPT" app-config --app-id 4242 --pem app.pem --installation-id 7
  [ "$status" -eq 0 ]
  grep -q '^GITHUB_APP_ID=4242$' .env
  grep -q '^GITHUB_APP_INSTALLATION_ID=7$' .env
  # base64 key landed and is non-empty, single-line
  key="$(grep '^GITHUB_APP_PRIVATE_KEY=' .env | cut -d= -f2-)"
  [ -n "$key" ]
  [ "$(grep -c '^GITHUB_APP_ID=' .env)" -eq 1 ]  # no duplicate key line
}

@test "app-config rejects a file that is not a PEM private key" {
  printf 'GITHUB_APP_ID=\nGITHUB_APP_PRIVATE_KEY=\n' > .env
  echo "not a key" > bad.txt
  run bash "$SCRIPT" app-config --app-id 1 --pem bad.txt
  [ "$status" -ne 0 ]
  [[ "$output" == *"not a PEM private key"* ]]
}

@test "app-config requires --app-id and --pem" {
  printf 'GITHUB_APP_ID=\n' > .env
  run bash "$SCRIPT" app-config --pem /dev/null
  [ "$status" -ne 0 ]
  [[ "$output" == *"--app-id is required"* ]]
}

@test "oauth-app --dry-run prints the org OAuth-app URL + callback" {
  run bash "$SCRIPT" oauth-app --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF -- "organizations/test-event-org/settings/applications/new"
  [[ "$output" == *"/api/auth/callback/github"* ]]
}

@test "oauth-config writes client id + secret (secret from stdin, not argv)" {
  printf 'GITHUB_CLIENT_ID=\nGITHUB_CLIENT_SECRET=\nEVENT_URL=http://localhost\n' > .env
  run bash -c 'echo "sup3rs3cret" | bash "'"$SCRIPT"'" oauth-config --client-id Iv1.test'
  [ "$status" -eq 0 ]
  grep -q '^GITHUB_CLIENT_ID=Iv1.test$' .env
  grep -q '^GITHUB_CLIENT_SECRET=sup3rs3cret$' .env
  [ "$(grep -c '^GITHUB_CLIENT_SECRET=' .env)" -eq 1 ]
}

@test "oauth-config requires --client-id" {
  printf 'GITHUB_CLIENT_ID=\n' > .env
  run bash "$SCRIPT" oauth-config
  [ "$status" -ne 0 ]
  [[ "$output" == *"--client-id is required"* ]]
}

# Stub gh/docker/openssl on PATH so the wizard's prerequisite step (cmd_check)
# passes deterministically — CI runners have no `gh auth`, which would otherwise
# make the wizard bail at step 1 before reaching the step under test.
_stub_prereqs() {
  mkdir -p "$BATS_TEST_TMPDIR/stubbin"
  for c in gh docker openssl; do
    printf '#!/bin/sh\nexit 0\n' > "$BATS_TEST_TMPDIR/stubbin/$c"
    chmod +x "$BATS_TEST_TMPDIR/stubbin/$c"
  done
}

# NOT --dry-run: the point is that a bare `ctf-setup.sh` dispatches to the
# wizard rather than printing usage. Every tool is stubbed and CTF_NO_BROWSER
# is set, because this is the one test that walks the REAL wizard — unstubbed,
# it reached GitHub over the network and offered to bring the stack up.
@test "bare invocation runs the wizard (the default), not a usage error" {
  _stub_prereqs
  run env CTF_NO_BROWSER=1 PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT"
  echo "$output" | grep -q "OWASP CTF in a Box setup wizard"
  [ -z "$(echo "$output" | grep -F 'usage: ctf-setup.sh')" ]
}

@test "wizard asks the event basics inline when a bootstrap key is missing, rather than halting" {
  _stub_prereqs
  rm -f .env
  # Nothing to resume from -> the wizard must PROMPT inline (not tell the
  # operator to go edit a file and come back). Under --dry-run every answer
  # is its default and `gh api user` is not called, so the run ends on the
  # empty-admins refusal — what this pins is that the questions are ASKED,
  # in this file, and that the event's identity/modules/schedule are not
  # among them (config v2 #386: those are runtime /admin settings).
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  echo "$output" | grep -q "Answer a few questions to write"
  echo "$output" | grep -q "GitHub org (disposable per-event org)"
  echo "$output" | grep -q "Admin GitHub login(s)"
  [ -z "$(echo "$output" | grep -F 'Event name')" ]
  [ -z "$(echo "$output" | grep -F 'Event start')" ]
  echo "$output" | grep -qF "/admin"
}

# M10 / the app-only event: GITHUB_ORG is required only when Secure
# Development runs (spec section 1), so an event that runs none has no org —
# and must not be re-asked the whole of step 3 on every single re-run.
@test "wizard: an app-only .env with no org is complete, not re-asked" {
  _stub_prereqs
  printf 'ADMIN_LOGINS=organizer\nSCORE_IMAGE=\n' > .env
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F 'Answer a few questions to write')" ]
  echo "$output" | grep -qF "✅ .env (org: <none>, admins: organizer)"
  # …and it says where the off switch is, since a resumed run does not re-ask.
  echo "$output" | grep -qF "Secure Development: off — set SCORE_IMAGE in .env"
}

# `SCORE_IMAGE=` (present, empty) is an answered question — "no Secure
# Development". NO SUCH LINE is a file that was never asked, and resuming
# past it would leave an organizer with no way to turn Secure Development on
# from the wizard at all.
@test "wizard: an .env with no SCORE_IMAGE line at all is re-asked, not resumed past" {
  _stub_prereqs
  printf 'ADMIN_LOGINS=organizer\nGITHUB_ORG=test-event-org\n' > .env
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  echo "$output" | grep -qF 'Answer a few questions to write'
  echo "$output" | grep -qF 'Run Secure Development'
}

@test "wizard: a resumed Secure Development run says the switch is on, and with what" {
  _stub_prereqs
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF "Secure Development: on (SCORE_IMAGE=ghcr.io/fixture/score:latest)"
}

# C1: an app-only event used to DEAD-END here. Step 7 asked GitHub about an
# org that does not exist (GITHUB_ORG is empty), printed "create it, then
# re-run" and exited 0 — so steps 8 (bring-up) and 9 never ran, and the
# organizer was sent to create an org their event has no use for. NOT
# --dry-run, because the exit was in the real path's org probe.
@test "wizard: an app-only event skips the org step and still reaches the bring-up" {
  _stub_prereqs
  # gh is logged in (so step 1 passes) but reports every API call as a
  # failure — the "org does not exist" shape that produced the dead-end.
  printf '#!/bin/sh\n[ "$1" = auth ] && exit 0\nexit 1\n' > "$BATS_TEST_TMPDIR/stubbin/gh"
  chmod +x "$BATS_TEST_TMPDIR/stubbin/gh"
  printf 'GITHUB_ORG=\nADMIN_LOGINS=organizer\nSCORE_IMAGE=\n' > .env
  run env CTF_NO_BROWSER=1 PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F "Still can't see org")" ]
  echo "$output" | grep -qF "7/9  Event org"
  echo "$output" | grep -qF "does not run Secure Development (no org to fork into)"
  echo "$output" | grep -qF "9/9  Verify"
  echo "$output" | grep -qF "8/9  Bring the containers up"
}

# The one value the wizard cannot default on a fresh box: `gh api user` is a
# gh call, and --dry-run makes none (AGENTS.md). An .env with an empty
# ADMIN_LOGINS fails closed in the app — /admin forbids EVERY login
# (admin-auth.ts) — which is silent until an organizer tries to open the
# panel, so the wizard refuses to write one instead of shipping the lockout.
@test "wizard refuses to write an .env with no admin logins" {
  _stub_prereqs
  rm -f .env
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ ! -f .env ]
  echo "$output" | grep -qF "at least one admin login is required"
  echo "$output" | grep -qF "/admin would forbid everyone"
  [ "$status" -ne 0 ]
}

@test "wizard --dry-run walks every step to bring-up without blocking" {
  _stub_prereqs
  # A complete bootstrap .env: every step must narrate and flow through to
  # step 8 instead of exiting early to make the operator edit a file and
  # re-run.
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "2/9  Secrets"
  echo "$output" | grep -q "3/9  Event basics"
  echo "$output" | grep -q "8/9  Bring the containers up"
}

@test "wizard pauses for the UI-only steps and verifies with doctor LAST" {
  _stub_prereqs
  # Issue #370. The order is the point: provisioning (7), then the pause for
  # the fork-detach / package-grant steps, then bring-up (8), and doctor as
  # the closing step (9) — never before the organizer could have done the UI
  # steps it checks. Asserted by line position in the dry-run narration, which
  # names each of the three in turn.
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  pause_at="$(echo "$output" | grep -n 'would pause for the UI-only steps' | head -1 | cut -d: -f1)"
  up_at="$(echo "$output" | grep -n '8/9  Bring the containers up' | head -1 | cut -d: -f1)"
  doctor_at="$(echo "$output" | grep -n "would verify the org with 'ctf-setup.sh doctor'" | head -1 | cut -d: -f1)"
  [ -n "$pause_at" ] && [ -n "$up_at" ] && [ -n "$doctor_at" ]
  [ "$pause_at" -lt "$up_at" ]
  echo "$output" | grep -q '9/9  Verify'
  [ "$up_at" -lt "$doctor_at" ]
}

@test "wizard: an app-only event has no UI-only steps to pause for" {
  _stub_prereqs
  _env_fixture_no_secdev
  # No forks, no package — a pause here would be asking the organizer to
  # confirm work that does not exist. The 9/9 banner still closes the run,
  # but it says there is nothing to verify rather than that it would run
  # doctor (review finding on #376: the dry-run path must not claim a
  # verification the real path would skip).
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -q '9/9  Verify'
  echo "$output" | grep -qF 'nothing provisioned to verify'
  [ -z "$(echo "$output" | grep -F 'would pause for the UI-only steps')" ]
  [ -z "$(echo "$output" | grep -F 'would verify the org')" ]
}

@test "wizard prints app-only compose profiles when SCORE_IMAGE is empty" {
  _stub_prereqs
  _env_fixture_no_secdev
  # An app-only event has no scorer image to pull and nothing to poll, so the
  # bring-up it prints must NOT ask for the score-ingest profiles — those
  # carry secure-development's sync + scorer (docker-compose.yml, ADR 26).
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F -- '--profile secdev')" ]
  [ -z "$(echo "$output" | grep -F -- '--profile push')" ]
  echo "$output" | grep -qF 'docker compose --profile app up -d --build'
}

@test "wizard prints the secdev profiles for a Secure Development event" {
  _stub_prereqs
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'docker compose --profile secdev --profile app up -d --build'
}

@test "a stale SCORE_INGEST=push in .env no longer changes the bring-up" {
  _stub_prereqs
  # Before #377 removed push, step 8 read this value and brought up
  # `--profile push` (the scorer with no poller). The profile is gone, so the
  # only line-up left is the poll one, and a `.env` carried over from a push
  # event gets it — silently, because step 8 is not where an organizer is told
  # about a key: `doctor` names it, once.
  _env_fixture
  printf 'SCORE_INGEST=push\n' >> .env
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F -- '--profile push')" ]
  echo "$output" | grep -qF 'docker compose --profile secdev --profile app up -d --build'
}

# --------------------------------------------------------------------------
# Config v2 (#386): the wizard no longer asks which modules to enable — a
# module is switched on at runtime in /admin, and the only setup-time fact
# left about Secure Development is whether its containers run at all, which
# is SCORE_IMAGE being set.
# --------------------------------------------------------------------------

@test "wizard asks whether to run Secure Development, not which modules" {
  _stub_prereqs
  rm -f .env
  printf 'ADMIN_LOGINS=organizer\nSCORE_IMAGE=ghcr.io/fixture/score:latest\n' > .env
  # The org is missing, so step 3 asks. Under --dry-run the Secure
  # Development question takes its DEFAULT — Y, because this .env carries a
  # SCORE_IMAGE — and the refusal that follows (Secure Development with no
  # org to fork into) is the observable proof of it: with the answer forced
  # to "no", as ask_yn does for every other dry-run prompt, there would be
  # nothing to refuse and the run would exit 0.
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ -z "$(echo "$output" | grep -F 'Modules to start with')" ]
  [ -z "$(echo "$output" | grep -F 'Targets — subset of')" ]
  echo "$output" | grep -qF 'Run Secure Development'
  echo "$output" | grep -qF 'GITHUB_ORG cannot be empty'
  [ "$status" -ne 0 ]
}

# I3: `ask_yn` hard-answers "no" under --dry-run so a rehearsal cannot
# mutate anything, which made the whole rehearsal describe an event with
# Secure Development OFF for a box whose env file has SCORE_IMAGE set — the
# opposite of what the real run does.
@test "wizard --dry-run narrates the Secure Development steps for an .env that has SCORE_IMAGE" {
  _stub_prereqs
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F 'does not run Secure Development')" ]
  echo "$output" | grep -qF '4/9  Scorer image'
  echo "$output" | grep -qF '5/9  Sync GitHub App'
  echo "$output" | grep -qF '7/9  Event org (test-event-org)'
  echo "$output" | grep -qF 'docker compose --profile secdev --profile app up -d --build'
}

@test "wizard: an app-only event is never asked for score ingest" {
  _stub_prereqs
  # Nothing to ingest, so the prompt never appears and the template value in
  # .env is left alone — writing one would suggest a switch that does
  # nothing for this event.
  printf 'ADMIN_LOGINS=organizer\nSCORE_IMAGE=\n' > .env
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F 'SCORE_INGEST=')" ]
  [ -z "$(echo "$output" | grep -F 'Score ingest')" ]
}

@test "valid_ingest is gone with the transport it validated" {
  # It existed to keep a typo out of caddy/Caddyfile.${SCORE_INGEST} (#374).
  # Compose mounts a constant Caddyfile.poll now, so there is no interpolated
  # path to protect and no second mode to tell a typo apart from (#377).
  run bash -c 'CMD=__selftest source "$1"; declare -F valid_ingest' _ "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "wizard: the closing summary names every target Secure Development provisions" {
  # Generated from targets.tsv, not a second hand-maintained list: a target
  # added to the TSV and not to the summary is one no organizer is told about.
  _stub_prereqs
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  local t fails=""
  for t in $(grep -v '^[[:space:]]*#' "$BATS_TEST_DIRNAME/../targets.tsv" | cut -f1); do
    if [ -z "$(echo "$output" | grep -F 'provisions all six from targets.tsv' | grep -F "$t")" ]; then fails="$fails $t"; fi
  done
  echo "missing from the summary:$fails"
  [ -z "$fails" ]
}

@test "wizard: an .env with no SCORE_IMAGE skips the scorer image and poll App steps" {
  _stub_prereqs
  _env_fixture_no_secdev
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F 'build the scorer image')" ]
  [ -z "$(echo "$output" | grep -F 'App-creation form')" ]
  echo "$output" | grep -qF 'does not run Secure Development'
}

@test "wizard: a complete .env is not re-asked, and the summary lists the keys it holds" {
  _stub_prereqs
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F 'Answer a few questions to write')" ]
  echo "$output" | grep -qF "✅ .env (org: test-event-org"
  echo "$output" | grep -qF "GITHUB_ORG"
  echo "$output" | grep -qF "ADMIN_LOGINS"
}

# The closing screen names the KEYS the bootstrap file carries so an organizer
# can check it by hand — never their values, because the same file holds
# BETTER_AUTH_SECRET, SRH_TOKEN, SCORER_TOKEN and REDIS_PASSWORD, and a wizard
# that echoed them would put every secret in a scrollback and a CI log.
@test "wizard's closing summary never echoes a secret from .env" {
  _stub_prereqs
  _env_fixture
  printf 'BETTER_AUTH_SECRET=s3cret-auth-value\nREDIS_PASSWORD=s3cret-redis-value\n' >> .env
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF "GITHUB_ORG"
  [ -z "$(echo "$output" | grep -F 's3cret-auth-value')" ]
  [ -z "$(echo "$output" | grep -F 's3cret-redis-value')" ]
}

@test "wizard --dry-run does not build or push the scorer image" {
  _stub_prereqs
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  # The narration line itself, not just the word "build" — that also matches
  # the `--build` in the compose command this run always prints, so a step 4
  # that said nothing at all would have passed.
  echo "$output" | grep -qF 'DRY-RUN: would check whether ghcr.io/fixture/score:latest is built locally and offer to build it (linux/amd64)'
  # And nothing was actually built or pushed: no docker call was even made
  # (the dedicated zero-calls test pins that), so neither line can appear.
  [ -z "$(echo "$output" | grep -F 'Successfully built')" ]
  [ -z "$(echo "$output" | grep -F 'docker push')" ]
}

# --------------------------------------------------------------------------
# Step 3 (`wiz_event_basics`) is the whole of what the wizard writes now:
# GITHUB_ORG, ADMIN_LOGINS and SCORE_IMAGE. Driven directly with piped
# answers — the alternative is walking the full nine steps through the
# GitHub-App and OAuth prompts to reach one write.
# --------------------------------------------------------------------------

# Answers, in prompt order: org, admin logins, run-Secure-Development?,
# score ingest (only when that was yes), URL.
# `gh` is stubbed to FAIL so the admin default is empty unless .env carries
# one: with a real, logged-in gh on PATH (a developer's laptop) the "who is
# running this?" default would silently answer for the test.
_basics() {
  mkdir -p "$BATS_TEST_TMPDIR/nogh"
  printf '#!/bin/sh\nexit 1\n' > "$BATS_TEST_TMPDIR/nogh/gh"
  chmod +x "$BATS_TEST_TMPDIR/nogh/gh"
  printf '%s\n' "$@" | env PATH="$BATS_TEST_TMPDIR/nogh:$PATH" \
    bash -c 'CMD=__selftest source "$1"; DRY_RUN=0; OUT=.env; wiz_event_basics .env' _ "$SCRIPT"
}

# The same step, rehearsed: every answer is its default and nothing is
# written. The wizard's own --dry-run cannot reach past this step's refusals
# on a half-filled file, so the narration is pinned here.
_basics_dry() {
  env PATH="$BATS_TEST_TMPDIR/nogh:$PATH" \
    bash -c 'CMD=__selftest source "$1"; DRY_RUN=1; OUT=.env; wiz_event_basics .env' _ "$SCRIPT"
}

# Issue #372. The wizard asked "Score ingest (poll | push)" and wrote the
# answer to the event config file only; .env kept the template
# SCORE_INGEST=poll, and step 8 read .env to pick profiles — so "push"
# produced a push label on a poll deployment with no warning. #374 sent the
# answer to .env, which is now the ONLY copy of the switch there is, and
# step 8 still reads it to choose the compose profile.
#
# Issue #377 then removed the QUESTION (step 1) and the KEY itself (step 2):
# poll is the only score transport, compose mounts a constant Caddyfile.poll,
# and nothing reads SCORE_INGEST. What is left to pin is that the wizard
# writes no such key, and does not touch a line an old `.env` still carries.
@test "wiz_event_basics writes no SCORE_INGEST at all any more" {
  : > .env
  run _basics my-event-org alice y ''
  [ "$status" -eq 0 ]
  # The prompt went with #377 step 1; the KEY goes with step 2. This fails
  # against both the pre-#377 script (which asked) and the step-1 one (which
  # wrote poll without asking).
  [ -z "$(echo "$output" | grep -F 'Score ingest')" ]
  grep -qx 'GITHUB_ORG=my-event-org' .env
  [ -z "$(grep -F 'SCORE_INGEST' .env)" ]
}

@test "wiz_event_basics leaves a leftover SCORE_INGEST line exactly as it found it" {
  # Nothing reads the key any more, so rewriting it would be a write with no
  # effect on a file the organizer owns — and deleting a line the wizard did
  # not put there is not the wizard's call. `doctor` is where it is named.
  printf 'SCORE_INGEST=push\n' > .env
  run _basics my-event-org alice y ''
  [ "$status" -eq 0 ]
  grep -qx 'SCORE_INGEST=push' .env
  [ -z "$(grep -F 'SCORE_INGEST=poll' .env)" ]
}

@test "wiz_event_basics never writes SCORE_INGEST for an app-only event" {
  # Nothing ingests scores, so a value here would suggest a switch that does
  # nothing.
  : > .env
  run _basics my-event-org alice n ''
  [ "$status" -eq 0 ]
  [ -z "$(grep -F 'SCORE_INGEST' .env)" ]
}

@test "wiz_event_basics --dry-run narrates every write and performs none" {
  _env_fixture
  printf 'EVENT_URL=https://ctf.example.org\n' >> .env
  run _basics_dry
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'DRY-RUN: would write GITHUB_ORG, ADMIN_LOGINS and SCORE_IMAGE to .env'
  [ -z "$(echo "$output" | grep -F 'SCORE_INGEST')" ]
  # EVENT_URL is written by the same step when the answer is non-empty, so it
  # is narrated by it too — a rehearsal that lists two of three writes is a
  # rehearsal that hides one.
  echo "$output" | grep -qF 'would set EVENT_URL=https://ctf.example.org in .env'
  # The rehearsal must not have touched the file it narrated.
  [ -z "$(grep -F 'SCORE_INGEST' .env)" ]
}

# The same value asked twice in one run reads as a bug in the wizard: step 2
# collects EVENT_URL the moment it creates the file, so step 3 must not ask
# again. (A resumed run, where step 2 only ticks "present", still asks — that
# is the file that exists without the key.)
@test "wiz_event_basics skips the EVENT_URL question when step 2 already asked" {
  : > .env
  mkdir -p "$BATS_TEST_TMPDIR/nogh"
  printf '#!/bin/sh\nexit 1\n' > "$BATS_TEST_TMPDIR/nogh/gh"
  chmod +x "$BATS_TEST_TMPDIR/nogh/gh"
  # $2=1 is what cmd_wizard passes after its own EVENT_URL prompt.
  run env PATH="$BATS_TEST_TMPDIR/nogh:$PATH" bash -c \
    'printf "my-event-org\nalice\nn\n" | { CMD=__selftest source "$1"; DRY_RUN=0; OUT=.env; wiz_event_basics .env 1; }' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F 'Event URL contestants reach')" ]
  grep -qx 'ADMIN_LOGINS=alice' .env
}

@test "wiz_event_basics defaults the admin list to the login running the wizard" {
  # R3 / spec section 8: Enter accepts, so the empty-admins refusal never
  # fires for the common case. `gh api user --jq .login` — gh's own JSON
  # filtering, not a jq dependency (AGENTS.md).
  mkdir -p "$BATS_TEST_TMPDIR/ghlogin"
  printf '#!/bin/sh\n[ "$1" = api ] && echo wizard-runner\nexit 0\n' > "$BATS_TEST_TMPDIR/ghlogin/gh"
  chmod +x "$BATS_TEST_TMPDIR/ghlogin/gh"
  : > .env
  run env PATH="$BATS_TEST_TMPDIR/ghlogin:$PATH" bash -c \
    'printf "my-event-org\n\nn\n\n" | { CMD=__selftest source "$1"; DRY_RUN=0; OUT=.env; wiz_event_basics .env; }' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qx 'ADMIN_LOGINS=wizard-runner' .env
}

@test "wiz_event_basics writes the three bootstrap keys and nothing else new" {
  : > .env
  run _basics my-event-org 'alice' y https://ctf.example.org
  [ "$status" -eq 0 ]
  grep -qx 'GITHUB_ORG=my-event-org' .env
  grep -qx 'ADMIN_LOGINS=alice' .env
  grep -qx 'EVENT_URL=https://ctf.example.org' .env
  # "Run Secure Development? y" with no value yet defaults to the image
  # reference the provisioner already mirrors into the event org.
  grep -qx 'SCORE_IMAGE=ghcr.io/my-event-org/score:latest' .env
}

@test "wiz_event_basics refuses an empty admin list and writes nothing" {
  : > .env
  run _basics my-event-org '' y https://ctf.example.org
  [ -z "$(grep -F 'GITHUB_ORG' .env)" ]
  echo "$output" | grep -qF "at least one admin login is required"
  echo "$output" | grep -qF "/admin would forbid everyone"
  [ "$status" -ne 0 ]
}

@test "wiz_event_basics accepts spaces or commas between logins, writing one list" {
  # The app splits ADMIN_LOGINS on commas only (admin-logins.ts), so an
  # organizer typing "alice bob" at a comma-separated prompt would otherwise
  # get ONE junk login and a panel that forbids them both.
  : > .env
  run _basics my-event-org 'alice, Bob  carol' n ''
  [ "$status" -eq 0 ]
  grep -qx 'ADMIN_LOGINS=alice,Bob,carol' .env
}

@test "wiz_event_basics leaves SCORE_IMAGE empty when Secure Development is declined" {
  # Empty is the answer the rest of the kit reads as "this event runs no
  # Secure Development" — so declining must write the key, empty, not skip it.
  : > .env
  run _basics my-event-org alice n ''
  [ "$status" -eq 0 ]
  grep -qx 'SCORE_IMAGE=' .env
}

@test "wiz_event_basics defaults to the values an existing .env already carries" {
  # Re-running the wizard is the documented recovery path, so every answer
  # must default to what is already there — an Enter-through must not switch
  # the org, drop an admin or turn Secure Development off.
  _env_fixture
  printf 'EVENT_URL=https://ctf.example.org\n' >> .env
  run _basics '' '' '' ''
  [ "$status" -eq 0 ]
  grep -qx 'GITHUB_ORG=test-event-org' .env
  grep -qx 'ADMIN_LOGINS=organizer' .env
  grep -qx 'EVENT_URL=https://ctf.example.org' .env
  grep -qx 'SCORE_IMAGE=ghcr.io/fixture/score:latest' .env
}

@test "wiz_event_basics refuses Secure Development with no org to fork into" {
  # SCORE_IMAGE non-empty means the scorer + sync containers run and every
  # target is forked into GITHUB_ORG. Writing that pair with an empty org
  # would defer the failure to `org` (and, for sync, to a crash loop).
  : > .env
  run _basics '' alice y ''
  echo "$output" | grep -qF "GITHUB_ORG"
  [ "$status" -ne 0 ]
}

@test "wizard builds the scorer image for linux/amd64 (runners are amd64)" {
  # The build MUST pin --platform linux/amd64 or an arm64 image (Apple Silicon
  # default) fails the fork's scoring Action with 'no matching manifest'.
  run grep -F 'docker build --platform linux/amd64 -t "$img"' "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "expand_tilde resolves a leading ~ but leaves absolute paths alone" {
  run bash -c 'CMD=__selftest source "'"$SCRIPT"'"; expand_tilde "~/Downloads/k.pem"'
  [ "$output" = "$HOME/Downloads/k.pem" ]
  run bash -c 'CMD=__selftest source "'"$SCRIPT"'"; expand_tilde "~"'
  [ "$output" = "$HOME" ]
  run bash -c 'CMD=__selftest source "'"$SCRIPT"'"; expand_tilde "/abs/k.pem"'
  [ "$output" = "/abs/k.pem" ]
}

@test "ask_yn honours the default on an empty reply (Y=yes, N=no)" {
  # Output carries the prompt prefix, so match the decision token as a word.
  run bash -c 'CMD=__selftest source "'"$SCRIPT"'"; DRY_RUN=0; printf "\n" | { if ask_yn q Y; then echo DECIDE-YES; else echo DECIDE-NO; fi; }'
  echo "$output" | grep -qw DECIDE-YES
  run bash -c 'CMD=__selftest source "'"$SCRIPT"'"; DRY_RUN=0; printf "\n" | { if ask_yn q; then echo DECIDE-YES; else echo DECIDE-NO; fi; }'
  echo "$output" | grep -qw DECIDE-NO
}

@test "fork_detached / package_private confirm the UI-only steps by API" {
  mkdir -p "$BATS_TEST_TMPDIR/stubs"
  # Stub gh so `.fork` and `.visibility` are read from the flag we pass in.
  cat > "$BATS_TEST_TMPDIR/stubs/gh" <<'EOF2'
#!/usr/bin/env bash
# emit $FORK for a repos/... query, $VIS for a packages/... query
for a in "$@"; do case "$a" in repos/*) echo "${FORK:-}"; exit 0;; orgs/*packages*) echo "${VIS:-}"; exit 0;; esac; done
exit 0
EOF2
  chmod +x "$BATS_TEST_TMPDIR/stubs/gh"
  run env FORK=false PATH="$BATS_TEST_TMPDIR/stubs:$PATH" bash -c 'CMD=__selftest source "'"$SCRIPT"'"; if fork_detached o/r; then echo DETACHED; else echo STILLFORK; fi'
  echo "$output" | grep -qw DETACHED
  run env FORK=true PATH="$BATS_TEST_TMPDIR/stubs:$PATH" bash -c 'CMD=__selftest source "'"$SCRIPT"'"; if fork_detached o/r; then echo DETACHED; else echo STILLFORK; fi'
  echo "$output" | grep -qw STILLFORK
  run env VIS=private PATH="$BATS_TEST_TMPDIR/stubs:$PATH" bash -c 'CMD=__selftest source "'"$SCRIPT"'"; if package_private o; then echo PRIV; else echo NOTPRIV; fi'
  echo "$output" | grep -qw PRIV
  run env VIS=public PATH="$BATS_TEST_TMPDIR/stubs:$PATH" bash -c 'CMD=__selftest source "'"$SCRIPT"'"; if package_private o; then echo PRIV; else echo NOTPRIV; fi'
  echo "$output" | grep -qw NOTPRIV
}

@test "wait_workflows_settled aborts fast (no sleep-loop) when the workflows API errors" {
  # Must NOT sleep-loop on a failing API (that is what keeps the fail-closed
  # disable-inherited check fast); it returns 0 and lets the caller decide.
  # A single sleep cycle is 5s, so anything under that proves it did not loop.
  mkdir -p "$BATS_TEST_TMPDIR/stubs"
  printf '#!/usr/bin/env bash\n[ "$1" = api ] && exit 1\nexit 0\n' > "$BATS_TEST_TMPDIR/stubs/gh"
  chmod +x "$BATS_TEST_TMPDIR/stubs/gh"
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" bash -c 'CMD=__selftest source "'"$SCRIPT"'"; SECONDS=0; wait_workflows_settled o/r; echo "ELAPSED:$SECONDS"'
  local secs; secs="$(echo "$output" | sed -n 's/^ELAPSED://p')"
  [ "${secs:-99}" -lt 5 ]
}

# Regression: `app-manifest` and `oauth-app` open GitHub pages in a browser.
# The --dry-run guards at each call site cover the documented rehearsal path,
# but a REAL invocation from any automated context — a test harness, CI, an
# agent driving the script against a fixture config — used to open actual tabs
# on whoever's machine ran it. That happened, against this very fixture org.
#
# Stub every external tool (including the openers) so nothing can escape the
# test, then assert the no-TTY branch was taken: bats runs with no controlling
# terminal, so `open` must never be reached.
@test "oauth-app does not launch a browser when no terminal is attached" {
  mkdir -p stubs
  printf '#!/bin/sh\necho "STUB-OPEN $*"\n' > stubs/open
  printf '#!/bin/sh\necho "STUB-XDG $*"\n' > stubs/xdg-open
  printf '#!/bin/sh\nexit 0\n' > stubs/gh
  chmod +x stubs/open stubs/xdg-open stubs/gh
  PATH="$(pwd)/stubs:$PATH" run bash "$SCRIPT" oauth-app
  [ -z "$(printf '%s' "$output" | grep -F 'STUB-OPEN')" ]
  printf '%s' "$output" | grep -qF 'open this manually:'
}

@test "CTF_NO_BROWSER suppresses the launch outright" {
  mkdir -p stubs
  printf '#!/bin/sh\necho "STUB-OPEN $*"\n' > stubs/open
  printf '#!/bin/sh\nexit 0\n' > stubs/gh
  chmod +x stubs/open stubs/gh
  PATH="$(pwd)/stubs:$PATH" CTF_NO_BROWSER=1 run bash "$SCRIPT" oauth-app
  printf '%s' "$output" | grep -qF 'open this manually:'
}

# --- doctor: per-fork package Read grant, verified by observation -----------
#
# The grant has no API to read back, but it has an observable consequence: the
# fork's own scoring workflow either pulled the scorer image or was refused.
# These stub `gh` to replay that history. Assertions target the grant block
# only — the provisioning matrix above it has its own tests.

# Writes a `gh` stub that answers the two endpoints `pull_grant_status` reads
# and shrugs at everything else. $1 = the run-step conclusion to report for
# DVWA; VAmPI is always left with no runs at all, so every case below also
# pins the "never ran" arm alongside the one it is really about.
write_gh_grant_stub() {
  mkdir -p stubs
  cat > stubs/gh <<EOF
#!/usr/bin/env bash
case "\$*" in
  *"DVWA/actions/workflows/ctf-score.yml/runs"*) echo 101 ;;
  *"VAmPI/actions/workflows/ctf-score.yml/runs"*) ;;
  *"DVWA/actions/runs/101/jobs"*) echo "$1" ;;
  *"packages/container/score"*) echo private ;;
  *) exit 1 ;;
esac
EOF
  chmod +x stubs/gh
}

@test "doctor reports a package grant as granted when a run pulled the image" {
  write_gh_grant_stub success
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  echo "$output" | grep -qF -- "per-fork package Read grant"
  printf '%s' "$output" | grep -qE '^  dvwa +✅ granted'
}

# The failure this whole feature exists for: without it, a missing grant
# surfaces as "Scoring did not complete" on a contestant's PR.
@test "doctor reports a package grant as MISSING when a run was refused the image" {
  write_gh_grant_stub failure
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qE '^  dvwa +❌ MISSING'
  [ "$status" -ne 0 ]
}

# Fails closed: a fork with no scoring run yet has NOT been verified, and must
# never be reported as granted. VAmPI is in this state in every case above too.
@test "doctor reports an unrun fork as unverified, never as granted" {
  write_gh_grant_stub success
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qE '^  vampi +⚠️  unverified'
  [ -z "$(printf '%s' "$output" | grep -E '^  vampi +✅')" ]
}

# A step that was skipped or cancelled proves nothing about the grant, so it
# must read as unverified rather than as either verdict.
@test "doctor treats a skipped pull step as unverified, not as a verdict" {
  write_gh_grant_stub skipped
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qE '^  dvwa +⚠️  unverified'
}

# An unreachable API is not evidence of a grant. This is the same fail-closed
# rule every check_step follows.
@test "doctor reports unverified when the runs API itself fails" {
  mkdir -p stubs
  cat > stubs/gh <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"packages/container/score"*) echo private ;;
  *) exit 1 ;;
esac
EOF
  chmod +x stubs/gh
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qE '^  dvwa +⚠️  unverified'
  [ -z "$(printf '%s' "$output" | grep -F '✅ granted')" ]
}

# The doctor check and the workflow are coupled by one string: doctor reads
# back the grant by looking for a step named "Pull scorer image" in each
# fork's scoring runs. Renaming the step in the template would silently turn
# every fork's status to "unverified" — a check that quietly stops checking,
# which is worse than no check. Pin the name from both sides.
@test "the rendered workflow's pull step is named exactly what doctor looks for" {
  run bash "$SCRIPT" render
  [ "$status" -eq 0 ]
  grep -qF -e '- name: Pull scorer image' dist/workflows/dvwa.ctf-score.yml
  grep -qF 'name == "Pull scorer image"' "$BATS_TEST_DIRNAME/../ctf-setup.sh"
}

# The whole point of the separate step: a missing grant must fail in a step
# named for it, not implicitly inside `docker run` where it reads as a
# scoring failure on the contestant's patch.
@test "the rendered workflow pulls the scorer image before running it" {
  run bash "$SCRIPT" render
  [ "$status" -eq 0 ]
  pull_line="$(grep -n 'docker pull' dist/workflows/dvwa.ctf-score.yml | head -1 | cut -d: -f1)"
  run_line="$(grep -n 'name: Run scorer' dist/workflows/dvwa.ctf-score.yml | head -1 | cut -d: -f1)"
  [ -n "$pull_line" ]
  [ "$pull_line" -lt "$run_line" ]
}

# --- scoring-workflow versioning (issue #43) --------------------------------
#
# The stamp is what makes a fix to ctf-score.yml reachable on an event that is
# already provisioned. Before it, `org` skipped the workflow step as soon as
# the file existed — at any version — so a security fix could only be
# delivered by hand, one fork at a time.

# The template's current version, read from the template rather than pinned
# here. These tests are about the version MECHANISM — a fork matching the
# template reads current, one behind reads stale — not about which number the
# template happens to be on. Hardcoding it turned every security bump of the
# workflow into a test edit.
template_version() {
  sed -n 's/^# ctf-workflow-version: *\([0-9][0-9]*\).*/\1/p' \
    "$BATS_TEST_DIRNAME/../../scorer/consumer-workflow.example.yml" | head -1
}

@test "the template carries a version stamp and rendering preserves it" {
  grep -qE '^# ctf-workflow-version: [0-9]+$' "$BATS_TEST_DIRNAME/../../scorer/consumer-workflow.example.yml"
  run bash "$SCRIPT" render
  [ "$status" -eq 0 ]
  grep -qE '^# ctf-workflow-version: [0-9]+$' dist/workflows/dvwa.ctf-score.yml
}

@test "upgrade --dry-run plans only the workflow step, never forks or the mirror" {
  v="$(template_version)"
  run bash "$SCRIPT" upgrade --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF -- "render ctf-score.yml v$v (TARGET=dvwa)"
  echo "$output" | grep -qF -- "render ctf-score.yml v$v (TARGET=vampi)"
  # The whole reason this is its own subcommand rather than "re-run org".
  [ -z "$(printf '%s' "$output" | grep -F 'gh repo fork')" ]
  [ -z "$(printf '%s' "$output" | grep -F 'docker push')" ]
  [ -z "$(printf '%s' "$output" | grep -F 'branch protection')" ]
}

@test "upgrade on an app-only event (no SCORE_IMAGE) is a no-op, not an error" {
  _env_fixture_no_secdev
  run bash "$SCRIPT" upgrade --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(printf '%s' "$output" | grep -F 'render ctf-score.yml')" ]
  [[ "$output" == *"does not run Secure Development"* ]]
}

# Writes a `gh` stub serving a committed ctf-score.yml whose version marker is
# $1 (or, for the literal string "none", no file at all).
write_gh_workflow_stub() {
  mkdir -p stubs
  cat > stubs/gh <<EOF
#!/usr/bin/env bash
case "\$*" in
  *"contents/.github/workflows/ctf-score.yml"*)
    [ "$1" = none ] && exit 1
    echo "# CTF scoring workflow"
    [ "$1" = unstamped ] || echo "# ctf-workflow-version: $1"
    echo "name: CTF Patch Score"
    ;;
  *"packages/container/score"*) echo private ;;
  *) exit 1 ;;
esac
EOF
  chmod +x stubs/gh
}

@test "doctor reports a fork on the template's version as current" {
  v="$(template_version)"
  write_gh_workflow_stub "$v"
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  echo "$output" | grep -qF -- "scoring workflow version (template is v$v)"
  printf '%s' "$output" | grep -qE "^  dvwa +✅ v$v"
}

# The state this whole feature exists for: a live event still running an old
# workflow, with no way to find out.
@test "doctor reports an older fork as stale and names the fix" {
  write_gh_workflow_stub 0
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qE '^  dvwa +❌ pre-versioning'
  echo "$output" | grep -qF -- "ctf-setup.sh upgrade"
  [ "$status" -ne 0 ]
}

# Every fork provisioned before this change is in exactly this state: the file
# is there and correct-looking, with no marker at all.
@test "doctor treats a workflow with no marker as stale, not as current" {
  write_gh_workflow_stub unstamped
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qE '^  dvwa +❌ pre-versioning'
  [ -z "$(printf '%s' "$output" | grep -F '✅ v')" ]
}

@test "doctor distinguishes an absent workflow from a stale one" {
  write_gh_workflow_stub none
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qE '^  dvwa +❌ absent'
  [[ "$output" == *"ctf-setup.sh org"* ]]
}

# A fork ahead of this checkout means the kit is behind, not the fork. Never
# clobber it backwards — that would silently REVERT a fix on a live event.
@test "doctor flags a fork ahead of the template without calling it stale" {
  write_gh_workflow_stub 99
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qE '^  dvwa +⚠️  v99'
  echo "$output" | grep -qF -- "AHEAD"
  [ -z "$(printf '%s' "$output" | grep -F 'stale')" ]
}

# Fails closed: an unreadable reply must never read as "up to date", or a
# security fix silently skips that fork.
@test "doctor treats an unreadable workflow read as absent, never as current" {
  mkdir -p stubs
  printf '#!/usr/bin/env bash\nexit 1\n' > stubs/gh
  chmod +x stubs/gh
  run env PATH="$BATS_TEST_TMPDIR/stubs:$PATH" NO_COLOR=1 bash "$SCRIPT" doctor
  printf '%s' "$output" | grep -qE '^  dvwa +❌ absent'
  [ -z "$(printf '%s' "$output" | grep -F '✅ v')" ]
}

# EVENT_URL lives in .env, not in any event file (ADR 43) — a box, an AWS
# stack and a fly.io machine serve one event on three hostnames. ctf-setup
# renders it into every fork's score-comment footer, so an organizer who left
# it unset would otherwise lose that link on every scored PR with nothing to
# explain it.

@test "render warns when EVENT_URL is missing rather than dropping the link silently" {
  run bash "$SCRIPT" render
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'EVENT_URL is not set'
}

@test "render puts the leaderboard link in the workflow when EVENT_URL is set" {
  # The counterpart: the warning above must not be the only outcome, or it
  # would pass just as well against a reader that never works.
  printf 'EVENT_URL=https://ctf.example.org\n' >> .env
  run bash "$SCRIPT" render
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F 'EVENT_URL is not set')" ]
  grep -qF 'https://ctf.example.org/leaderboard' dist/workflows/dvwa.ctf-score.yml
}

# The re-run cooldown became an admin setting (issue #46, ADR 46). The Action
# runs inside a contestant's fork and cannot read the event's Redis, so it
# fetches the live value over plain HTTPS and falls back to the baked one.
# These pin the fallback chain: a scoring run must never fail because a config
# lookup did.

@test "the workflow fetches the live cooldown from the event" {
  grep -qF '/api/public/scoring' "$BATS_TEST_DIRNAME/../../scorer/consumer-workflow.example.yml"
}

@test "the workflow still carries a baked cooldown to fall back to" {
  grep -qE '^      COOLDOWN_MINUTES: "[0-9]+"$' "$BATS_TEST_DIRNAME/../../scorer/consumer-workflow.example.yml"
}

@test "the cooldown fetch is wrapped so a failure cannot fail the run" {
  # try/catch AND a timeout: an event that is down or slow must not hold a
  # scoring run open or abort it.
  wf="$BATS_TEST_DIRNAME/../../scorer/consumer-workflow.example.yml"
  grep -qF 'AbortSignal.timeout' "$wf"
  grep -qF 'using the baked default' "$wf"
}

@test "the cooldown fetch derives its host from LEADERBOARD_LINK, not a new placeholder" {
  # One rendered value cannot drift from itself; a second placeholder could be
  # rendered inconsistently with the first.
  grep -qF "process.env.LEADERBOARD_LINK || ''" "$BATS_TEST_DIRNAME/../../scorer/consumer-workflow.example.yml"
}

@test "a non-numeric or negative reply is ignored in favour of the default" {
  grep -qF 'Number.isFinite(live) && live >= 0' "$BATS_TEST_DIRNAME/../../scorer/consumer-workflow.example.yml"
}

@test "the workflow version was bumped for the live-cooldown change" {
  # `ctf-setup upgrade` re-renders a fork only when the stamp is newer than
  # what the fork carries. Changing the template without bumping it means
  # existing forks silently keep the old workflow — here, keeping a cooldown
  # the organizer can no longer change.
  v="$(sed -n 's/^# ctf-workflow-version: *\([0-9][0-9]*\).*/\1/p' \
      "$BATS_TEST_DIRNAME/../../scorer/consumer-workflow.example.yml" | head -1)"
  [ "$v" -ge 3 ]
}

# `allow-unsafe-pr-checkout` is load-bearing (ADR 43). actions/checkout refuses
# a fork-PR checkout under `pull_request_target` without it, and that is step 3
# of the scoring job — so removing this flag does not harden the workflow, it
# stops EVERY scoring run on EVERY deployment of the kit, before the scorer
# image is even pulled. The flag's name invites exactly that mistake, and
# nothing pinned it until now.

@test "the fork workflow keeps its allow-unsafe-pr-checkout opt-in" {
  grep -qF 'allow-unsafe-pr-checkout: true' "$BATS_TEST_DIRNAME/../../scorer/consumer-workflow.example.yml"
}

@test "the fork workflow still checks out the PR HEAD, not the base" {
  # The opt-in only matters because this checks out contestant code. If the ref
  # ever became the base, the flag would be pointless AND the scorer would be
  # judging the wrong tree — a silent always-passing scorer.
  grep -qF 'ref: ${{ github.event.pull_request.head.sha }}' \
    "$BATS_TEST_DIRNAME/../../scorer/consumer-workflow.example.yml"
}

@test "the fork workflow keeps the job token out of the checked-out tree" {
  # persist-credentials: false is half the reason the pull_request_target
  # analysis in ADR 43 holds. Dropping it leaves a writable token in a tree
  # built from contestant-supplied source.
  grep -qF 'persist-credentials: false' "$BATS_TEST_DIRNAME/../../scorer/consumer-workflow.example.yml"
}

# AGENTS.md: `--dry-run` must make zero gh/docker calls. The wizard's org step
# and its closing doctor sweep used to call `gh api` regardless — invisible in
# the suite because `gh` is stubbed to `exit 0`. This stub records every call.
@test "wizard --dry-run issues no gh or docker calls at all" {
  _stub_prereqs
  for c in gh docker; do
    printf '#!/bin/sh\necho "%s $*" >> "%s/tool.calls"\nexit 0\n' "$c" "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/stubbin/$c"
    chmod +x "$BATS_TEST_TMPDIR/stubbin/$c"
  done
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "7/9  Event org"
  # Not even `gh auth status` or `docker compose version`: dry-run narrates
  # the prerequisite step instead of probing. This boundary is one-sided by
  # nature — dry-run writes no store and renders no page, so there is no
  # "output side" to pair this command-issuance check with.
  [ ! -s "$BATS_TEST_TMPDIR/tool.calls" ]
}

# The other half of the same boundary: an INCOMPLETE env file, so step 3 asks
# its questions. That path reaches for `gh api user --jq .login` to default
# the admin list — the one gh call the wizard makes outside the org steps —
# and it must not run here either. (Its absence is why the run ends on the
# empty-admins refusal, R3.)
@test "wizard --dry-run issues no gh or docker calls with an incomplete env file either" {
  _stub_prereqs
  for c in gh docker; do
    printf '#!/bin/sh\necho "%s $*" >> "%s/tool.calls"\nexit 0\n' "$c" "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/stubbin/$c"
    chmod +x "$BATS_TEST_TMPDIR/stubbin/$c"
  done
  printf 'SCORE_INGEST=poll\n' > .env
  run env PATH="$BATS_TEST_TMPDIR/stubbin:$PATH" bash "$SCRIPT" wizard --dry-run
  echo "$output" | grep -q "Admin GitHub login(s)"
  echo "$output" | grep -qF "at least one admin login is required"
  [ ! -s "$BATS_TEST_TMPDIR/tool.calls" ]
}

@test "org --dry-run --out reads the bootstrap keys from the named env file, not .env" {
  # The whole bootstrap plane moves with --out, not just the secrets: an
  # organizer keeping .env.fly beside .env must be able to provision from
  # either without editing files between runs.
  printf 'GITHUB_ORG=other-event-org\nSCORE_IMAGE=ghcr.io/other/score:pinned\n' > custom.env
  # `env -u`: an inherited SCORE_IMAGE would win before the file is read and
  # let this pass without exercising the --out lookup.
  run env -u SCORE_IMAGE bash "$SCRIPT" org --dry-run --out custom.env
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF "gh repo fork digininja/DVWA --org other-event-org"
  echo "$output" | grep -qF "docker pull ghcr.io/other/score:pinned"
}

@test "a value-taking flag with no value fails with the script's own message" {
  run bash "$SCRIPT" org --dry-run --out
  [ "$status" -eq 2 ]
  echo "$output" | grep -qF -- "--out requires a value"
}

# The generated env file holds BETTER_AUTH_SECRET, SRH_TOKEN, SCORER_TOKEN and
# REDIS_PASSWORD. Under the usual 022 umask a plain redirect creates it 0644,
# readable by every local user; it must be owner-only regardless of umask.
@test "secrets writes the env file owner-only regardless of the caller's umask" {
  rm -f .env
  run bash -c 'umask 022; bash "$0" secrets --out .env.perms.test' "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -f .env.perms.test ]
  [ "$(ls -l .env.perms.test | cut -c1-10)" = "-rw-------" ]
}

# `-f` follows symlinks, so a dangling symlink at the output path passes the
# "already exists" check and a plain redirect then writes the generated
# secrets to wherever the link points. Creation must be exclusive.
@test "secrets refuses a symlinked output path and writes nothing through it" {
  rm -f .env
  mkdir -p "$BATS_TEST_TMPDIR/elsewhere"   # the target is creatable; only the link is dangling
  ln -s "$BATS_TEST_TMPDIR/elsewhere/target.env" .env.link
  run bash "$SCRIPT" secrets --out .env.link
  [ "$status" -ne 0 ]
  [ ! -e "$BATS_TEST_TMPDIR/elsewhere/target.env" ]
}

# --------------------------------------------------------------------------
# The optional fly.io deploy step (issue #371). Driven directly, like
# `wiz_event_basics` above: reaching it through the whole wizard means
# answering the GitHub-App and OAuth prompts first, and what matters here is
# the step's own behaviour. Its CALL SITE — last, after 9/9, and neither
# blocking nor calling anything under --dry-run — is pinned by the two
# walk-through tests at the end of this section.
# --------------------------------------------------------------------------

# flyctl and deploy.sh, stubbed and LOGGED. `fly` records every call and exits
# ${1:-0} (1 is the signed-out shape, which is what `fly auth whoami` returns
# with no session). CTF_FLY_DEPLOY points the step at a stand-in for
# deploy/fly/deploy.sh that mimics `init` by creating the --env-file it is
# told to write: the real script requires a Fly session and renders
# compose.fly.yml into the repo, neither of which belongs in a unit test.
_fly_stubs() {
  mkdir -p "$BATS_TEST_TMPDIR/flybin"
  cat > "$BATS_TEST_TMPDIR/flybin/fly" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$BATS_TEST_TMPDIR/fly.calls"
exit ${1:-0}
EOF
  chmod +x "$BATS_TEST_TMPDIR/flybin/fly"
  cat > "$BATS_TEST_TMPDIR/deploy-stub" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$BATS_TEST_TMPDIR/deploy.calls"
mode=deploy
envf=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    init) mode=init ;;
    --env-file) envf="\$2"; shift ;;
  esac
  shift
done
if [ "\$mode" = init ] && [ -n "\$envf" ]; then
  printf 'SCORE_IMAGE=ghcr.io/fixture/score:latest\nEVENT_URL=https://owasp-ctf.fly.dev\n' > "\$envf"
  chmod 600 "\$envf"
fi
exit \${DEPLOY_STUB_EXIT:-0}
EOF
  chmod +x "$BATS_TEST_TMPDIR/deploy-stub"
}

# The step, with answers piped in prompt order: the offer, then (on yes) the
# public hostname and the confirmation before the real deploy.
_fly_step() {
  printf '%s\n' "$@" | env PATH="$BATS_TEST_TMPDIR/flybin:$PATH" \
    CTF_FLY_DEPLOY="$BATS_TEST_TMPDIR/deploy-stub" \
    bash -c 'CMD=__selftest source "$1"; DRY_RUN=0; OUT=.env; wiz_fly_deploy .env' _ "$SCRIPT"
}

# The same step on a box with NO flyctl. The PATH is standard directories
# only, so a real flyctl on the developer's machine cannot answer for the
# stub — the whole point of the case is that `command -v fly` finds nothing.
_fly_step_no_flyctl() {
  printf '%s\n' "$@" | env PATH="/usr/bin:/bin" \
    CTF_FLY_DEPLOY="$BATS_TEST_TMPDIR/deploy-stub" \
    bash -c 'CMD=__selftest source "$1"; DRY_RUN=0; OUT=.env; wiz_fly_deploy .env' _ "$SCRIPT"
}

@test "the fly.io step is offered, and the default answer declines it" {
  _fly_stubs
  # Enter — the default is NO, so a run that only wants the local box ends
  # exactly as it did before this step existed: no .env.fly, no deploy.
  run _fly_step ''
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'Optional  Deploy to fly.io'
  echo "$output" | grep -qF 'Deploy to fly.io now? [y/N]'
  echo "$output" | grep -qF 'Skipped — nothing above is affected.'
  [ ! -f .env.fly ]
  [ ! -f "$BATS_TEST_TMPDIR/deploy.calls" ]
}

@test "the fly.io step writes the public hostname into .env.fly, never into .env" {
  _fly_stubs
  # .env is the COMPOSE box's file, and it carries the box's own EVENT_URL:
  # one event served from a box and from Fly has two hostnames (ADR 43), so a
  # step that wrote the Fly one here would break the box's own sign-in.
  printf 'EVENT_URL=http://localhost:3000\n' >> .env
  run _fly_step y ctf.example.org n
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'EVENT_URL=https://ctf.example.org in'
  grep -qx 'EVENT_URL=http://localhost:3000' .env
  # …and the Fly file keeps mode 600: it is a copy of every secret the event
  # has, and rewriting a key through mktemp+mv drops the mode `init` set.
  [ "$(ls -l .env.fly | cut -c1-10)" = "-rw-------" ]
  grep -qx 'EVENT_URL=https://ctf.example.org' .env.fly
}

@test "the fly.io step prints the OAuth callback the new hostname needs, naming the box's too" {
  _fly_stubs
  printf 'EVENT_URL=http://localhost:3000\n' >> .env
  run _fly_step y ctf.example.org n
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'https://ctf.example.org/api/auth/callback/github'
  # The wizard's own OAuth step (6/9) registered the callback for .env's URL,
  # which is not this one — an organizer who is not told that discovers it as
  # a redirect_uri mismatch on a deployment that otherwise looks fine.
  echo "$output" | grep -qF "http://localhost:3000, the compose box's URL"
  echo "$output" | grep -qF 'redirect_uri mismatch'
}

@test "the fly.io step previews the deploy and asks before running the real one" {
  _fly_stubs
  run _fly_step y owasp-ctf.fly.dev n
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'Deploy that to fly.io now'
  echo "$output" | grep -qF 'Not deployed.'
  grep -qF -- '--dry-run' "$BATS_TEST_TMPDIR/deploy.calls"
  # The real deploy is that same command WITHOUT --dry-run. Declining must
  # leave the log with nothing in it but the init and the preview.
  [ -z "$(grep -v -- '--dry-run' "$BATS_TEST_TMPDIR/deploy.calls" | grep -v '^init ')" ]
}

@test "the fly.io step runs the deploy once it is confirmed" {
  _fly_stubs
  run _fly_step y owasp-ctf.fly.dev y
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'deployed'
  [ -n "$(grep -v -- '--dry-run' "$BATS_TEST_TMPDIR/deploy.calls" | grep -v '^init ')" ]
}

@test "a custom-domain hostname ends on the fly certs add hand-off" {
  _fly_stubs
  run _fly_step y ctf.example.org n
  [ "$status" -eq 0 ]
  # The app name comes from deploy/fly/fly.toml — the machine, its
  # certificates and its IPs are all named after it.
  echo "$output" | grep -qF 'fly certs add ctf.example.org --app owasp-ctf'
}

@test "a *.fly.dev hostname needs no certificate, and is not offered one" {
  _fly_stubs
  run _fly_step y owasp-ctf.fly.dev n
  [ "$status" -eq 0 ]
  # Fly issues the certificate for its own hostnames; the hand-off here would
  # send an organizer off to do nothing. The unreachable-box note stays: Fly's
  # IP allocation has failed mid-deploy before.
  echo "$output" | grep -qF 'fly ips list --app owasp-ctf'
  [ -z "$(echo "$output" | grep -F 'certs add')" ]
}

@test "a URL pasted instead of a hostname is reduced to the host" {
  _fly_stubs
  run _fly_step y 'https://ctf.example.org/' n
  [ "$status" -eq 0 ]
  grep -qx 'EVENT_URL=https://ctf.example.org' .env.fly
}

@test "a hostname that is not one leaves EVENT_URL as init wrote it" {
  _fly_stubs
  run _fly_step y 'not a hostname' n
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'is not a hostname'
  grep -qx 'EVENT_URL=https://owasp-ctf.fly.dev' .env.fly
  # No deploy on a guess.
  [ -z "$(grep -v '^init ' "$BATS_TEST_TMPDIR/deploy.calls")" ]
}

@test "a hostname with an empty or hyphen-edged label is refused too" {
  # Each of these passes the eye and the old check — LDH characters only, no
  # leading or trailing dot, at least one dot — and none of them can resolve.
  # They would have reached .env.fly as EVENT_URL, and Fly would have served
  # them as BETTER_AUTH_URL and as the OAuth callback host.
  local bad fails=""
  for bad in 'foo..example.org' '-foo.example.org' 'foo-.example.org' \
             'foo.-example.org' 'foo.example.org-'; do
    _fly_stubs
    run _fly_step y "$bad" n
    if [ -z "$(echo "$output" | grep -F 'is not a hostname')" ]; then
      fails="$fails $bad"
    fi
    if [ -n "$(grep -F "EVENT_URL=https://$bad" .env.fly)" ]; then
      fails="$fails $bad(written)"
    fi
    rm -f .env.fly "$BATS_TEST_TMPDIR/deploy.calls"
  done
  # Names the offenders rather than failing on an opaque status, and is the
  # test's LAST statement so a bad result actually fails it (AGENTS.md).
  [ -z "$fails" ] || { echo "accepted:$fails"; false; }
}

@test "a missing flyctl skips the fly.io step with the install instruction" {
  _fly_stubs
  run _fly_step_no_flyctl y
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'no flyctl on PATH'
  echo "$output" | grep -qF 'https://fly.io/docs/flyctl/install/'
  [ ! -f .env.fly ]
  [ ! -f "$BATS_TEST_TMPDIR/deploy.calls" ]
}

@test "an unauthenticated flyctl skips the fly.io step with the login instruction" {
  _fly_stubs 1
  run _fly_step y
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'flyctl is not signed in'
  echo "$output" | grep -qF 'fly auth login'
  [ ! -f .env.fly ]
  [ ! -f "$BATS_TEST_TMPDIR/deploy.calls" ]
}

@test "the fly.io step proceeds for an .env that still carries SCORE_INGEST=push" {
  _fly_stubs
  # It used to refuse: Fly had no route for a fork's Action to POST /score
  # (#373), so a push event could not deploy there. With push removed (#377)
  # the key is inert, every Fly deploy is a poll deploy, and a stale line is
  # no longer a reason to stop.
  printf 'SCORE_INGEST=push\n' >> .env
  run _fly_step y owasp-ctf.fly.dev y
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F 'poll-only')" ]
  [ -f .env.fly ]
  # A real deploy call: a logged line that is neither the `init` nor a
  # `--dry-run` rehearsal, the same shape the confirmed-deploy test pins.
  [ -n "$(grep -v -- '--dry-run' "$BATS_TEST_TMPDIR/deploy.calls" | grep -v '^init ')" ]
}

@test "the fly.io step is not offered for an app-only event" {
  _fly_stubs
  # The Fly machine runs all five containers, scorer included, so deploy.sh
  # requires SCORE_IMAGE — an app-only event has nothing to hand it.
  _env_fixture_no_secdev
  run _fly_step y owasp-ctf.fly.dev y
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'SCORE_IMAGE'
  echo "$output" | grep -qF 'app-only'
  [ ! -f .env.fly ]
  [ ! -f "$BATS_TEST_TMPDIR/deploy.calls" ]
}

@test "a failed deploy.sh init is non-fatal and says what to re-run" {
  _fly_stubs
  # The nine steps' .env work is already done, so a Fly deploy that falls
  # over must not take the run down with it.
  run env DEPLOY_STUB_EXIT=1 PATH="$BATS_TEST_TMPDIR/flybin:$PATH" \
    CTF_FLY_DEPLOY="$BATS_TEST_TMPDIR/deploy-stub" \
    bash -c 'printf "y\n" | { CMD=__selftest source "$1"; DRY_RUN=0; OUT=.env; wiz_fly_deploy .env; }' _ "$SCRIPT"
  echo "$output" | grep -qF "'deploy.sh init' failed"
  echo "$output" | grep -qF 'init --from'
  [ "$status" -eq 0 ]
}

@test "wizard --dry-run narrates the optional fly.io step and calls nothing at all" {
  _stub_prereqs
  _fly_stubs
  run env PATH="$BATS_TEST_TMPDIR/flybin:$BATS_TEST_TMPDIR/stubbin:$PATH" \
    CTF_FLY_DEPLOY="$BATS_TEST_TMPDIR/deploy-stub" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'Optional  Deploy to fly.io'
  echo "$output" | grep -qF "DRY-RUN: would ask 'Deploy to fly.io now?'"
  echo "$output" | grep -qF 'EVENT_URL in .env.fly (never in .env)'
  [ ! -f .env.fly ]
  # Not even the "is flyctl usable" probe: --dry-run narrates this step
  # without calling flyctl, docker or gh at all (AGENTS.md).
  [ ! -f "$BATS_TEST_TMPDIR/deploy.calls" ]
  [ ! -f "$BATS_TEST_TMPDIR/fly.calls" ]
}

@test "the fly.io offer comes LAST, after the 9/9 verify step" {
  _stub_prereqs
  _fly_stubs
  # It is a second deployment of an event the nine steps have already
  # configured, not a tenth thing to do before the box works — so the nine
  # keep their numbering and this follows them.
  run env PATH="$BATS_TEST_TMPDIR/flybin:$BATS_TEST_TMPDIR/stubbin:$PATH" \
    CTF_FLY_DEPLOY="$BATS_TEST_TMPDIR/deploy-stub" bash "$SCRIPT" wizard --dry-run
  [ "$status" -eq 0 ]
  verify_at="$(echo "$output" | grep -n '9/9  Verify' | head -1 | cut -d: -f1)"
  fly_at="$(echo "$output" | grep -n 'Optional  Deploy to fly.io' | head -1 | cut -d: -f1)"
  [ -n "$verify_at" ] && [ -n "$fly_at" ]
  [ "$verify_at" -lt "$fly_at" ]
}
