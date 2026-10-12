#!/usr/bin/env bash
# Render docker-compose.yml into the compose file Fly deploys.
#
# WHY THIS EXISTS, AND WHY IT IS A RENDER RATHER THAN A SECOND FILE.
#
# Fly can deploy a compose file directly (`[build.compose]` in fly.toml), which
# is what lets the hosted event run the SAME services, in the same wiring, as
# `docker compose up` — one source of truth, no hand-maintained cloud twin to
# drift from the real stack.
#
# But flyctl's compose parser is not Docker's. It is a hand-rolled yaml.v3
# unmarshal (`internal/containerconfig/compose.go`), and as of flyctl 0.4.87 it
# does NOT implement:
#
#   * `profiles:`            — every service in the file is deployed
#   * `${VAR}` interpolation — `${SRH_TOKEN}` arrives as that literal string
#   * build `args:`          — irrelevant here anyway: Fly builds nothing (see
#                              deploy.sh's step 2/5), so no image is ever
#                              built through this path
#
# and it rejects a file where more than one service declares `build:`
# ("only one service can specify build"), which docker-compose.yml does twice.
#
# `docker compose config` implements all three, correctly, because it is
# Docker's own parser. So the real compose file goes through Docker first and
# Fly receives the result. Everything Fly cannot do is therefore done by the
# tool that defines the format, not reimplemented here.
#
# WHAT THIS SCRIPT ADDS on top of `docker compose config`:
#
#   1. NOTHING. Specifically: secret values are LEFT IN, and this file is
#      therefore a credential file — mode 600, gitignored, and deleted by
#      deploy.sh once the deploy succeeds.
#
#      They cannot be stripped in favour of `fly secrets`, despite Fly's
#      documentation saying secrets are "global and available to every
#      container". They are not. A machine's containers receive only their own
#      `ExtraEnv`, which comes from this file's `environment:` block; the
#      machine config carries no `secrets` key at all — so stripping would
#      leave every container without its credentials while `fly secrets list`
#      shows all fourteen as `Deployed`: the app answering 500 from
#      better-auth's default-secret error, the scorer refusing to start, and
#      sync refusing to poll with no org or token to poll with.
#
#      The compensation is real, though: per-service scoping that Fly's global
#      secrets cannot express. The app never receives REDIS_PASSWORD, and redis
#      never receives GITHUB_CLIENT_SECRET.
#   2. `build:` becomes `image:`. Images are built and pushed beforehand, so
#      Fly builds nothing — and the images the event runs are the exact ones
#      built from this checkout.
#   3. Service hostnames become localhost. Containers in one Fly machine share
#      a network namespace; there is no DNS between them, and `srh` resolves
#      nowhere. This is also what makes the deployment work at all: srh's Redis
#      client is IPv4-only and Fly's private network is IPv6-only, so reaching
#      redis over loopback is the only arrangement srh can connect through.
#   4. Host bind mounts are dropped. A Fly machine has no repo checkout to bind
#      FROM. Nothing among app, scorer, sync, srh or redis declares one — the
#      only bind mount in docker-compose.yml belongs to caddy, which SERVICES
#      already excludes (Fly terminates TLS itself; see below).
#   5. Named volumes and networks are dropped. Fly ignores both; volumes are
#      declared as `[[mounts]]` in fly.toml, and a single machine has no
#      networks to join.
set -euo pipefail

ENV_FILE=".env.fly"
OUT=""
APP_IMAGE=""
SYNC_IMAGE=""
SCORER_IMAGE=""
# The services that go to Fly. Named explicitly rather than filtered out with
# `--profile` alone: `docker compose config SERVICE...` is how caddy is
# excluded WITHOUT giving it a profile (Fly terminates TLS itself, so caddy has
# no job there, and profiling it would have made the edge opt-in for every
# local bring-up, turning a forgotten flag into an event with no ingress).
#
# Both left empty here on purpose: naming a service explicitly on this command
# line makes `docker compose config` include it REGARDLESS of `--profile`
# (compose enables whatever profile a named service needs on its own) — so
# `scorer`/`sync` cannot be left in SERVICES unconditionally and still be
# excluded by PROFILES omitting `secdev`. Both are DERIVED below from
# SCORE_IMAGE in ENV_FILE together, the same one answer every other entry
# point uses (scripts/dev-stack, docker-compose.yml's scorer comment).
# Passing --services/--profiles explicitly still overrides the derivation.
SERVICES=""
PROFILES=""

usage() {
  cat <<'EOF'
usage: deploy/fly/render-compose.sh --out FILE [--env-file .env.fly]
                                    --app-image REF --sync-image REF
                                    --scorer-image REF
                                    [--services "a b c"]
                                    [--profiles "--profile secdev --profile app"]

Renders docker-compose.yml to a Fly-deployable compose file.

Without --profiles/--services, both are derived from ENV_FILE together:
`app srh redis` and `--profile app` always, plus `scorer sync` and
`--profile secdev` iff SCORE_IMAGE is non-empty there. Fly's own deploy.sh
always requires SCORE_IMAGE (it has no other route to a scorer), so in
practice this always renders secdev too — the derivation lives here so a
future relaxation of that requirement is a one-line change.

THE OUTPUT IS A CREDENTIAL FILE: mode 600, and refused unless gitignored.
Per-container `environment:` is the only channel that reaches a container in a
Fly machine — `fly secrets` does not, whatever the documentation says — so the
values have to travel in it. deploy.sh removes it once the deploy succeeds.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --app-image) APP_IMAGE="$2"; shift 2 ;;
    --sync-image) SYNC_IMAGE="$2"; shift 2 ;;
    --scorer-image) SCORER_IMAGE="$2"; shift 2 ;;
    --services) SERVICES="$2"; shift 2 ;;
    --profiles) PROFILES="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[ -n "$OUT" ] || { echo "FAIL: --out is required" >&2; exit 1; }
for pair in "app:$APP_IMAGE" "sync:$SYNC_IMAGE" "scorer:$SCORER_IMAGE"; do
  if [ -z "${pair#*:}" ]; then
    echo "FAIL: --${pair%%:*}-image is required (Fly builds nothing; every service needs a prebuilt image)" >&2
    exit 1
  fi
done
[ -f "$ENV_FILE" ] || { echo "FAIL: no $ENV_FILE" >&2; exit 1; }
# Resolved against the CALLER's directory, before the cd to the repo root
# below. Without this a perfectly valid `--env-file .env.fly` passes the test
# above and then fails inside docker compose, or — worse — silently resolves to
# a different file that happens to exist at the root.
case "$ENV_FILE" in
  /*) ;;
  *) ENV_FILE="$PWD/$ENV_FILE" ;;
esac
case "$OUT" in
  /*) ;;
  *) OUT="$PWD/$OUT" ;;
esac

# Derive PROFILES and SERVICES from ENV_FILE when the caller did not pass
# --profiles / --services.
#
# `app` runs always; `secdev` (the scorer and sync containers) is added iff
# SCORE_IMAGE is non-empty there — the same rule scripts/dev-stack applies to
# a local bring-up, so "does this event run Secure Development" is answered
# once, from one key, never from a second knob (config v2). Read
# straight out of the file rather than the shell environment: this script has
# no other reason to see SCORE_IMAGE, and the value that matters is the one
# the rendered compose file will actually be built from.
#
# SERVICES has to track the same decision (see the comment above its
# declaration): naming scorer/sync unconditionally would render them even
# with `--profile app` only, since compose enables a named service's profile
# on its own.
#
# The value is read with COMPOSE's .env semantics, not a bare `sed`, because
# the same file is about to be handed to `docker compose --env-file`: to
# compose, `SCORE_IMAGE=""` is empty, while a bare sed hands back the
# two-character string `""` — and this renderer would then add secdev, and
# render a scorer and a sync, for an app-only event.
dotenv_value() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  case "$v" in
  '"'*)
    # Quoted: the value ends at the closing quote, and `#` inside it is data.
    v="${v#\"}"
    v="${v%%\"*}"
    ;;
  "'"*)
    v="${v#\'}"
    v="${v%%\'*}"
    ;;
  *)
    # Unquoted: a comment starts at the first whitespace-preceded `#`.
    case "$v" in
    *[[:space:]]#*) v="${v%%[[:space:]]#*}" ;;
    esac
    v="${v%"${v##*[![:space:]]}"}"
    ;;
  esac
  printf '%s' "$v"
}

env_value() {
  # `KEY = value` is legal too: compose's parser trims whitespace around the
  # key and after the `=`, and hands back `value`. Matching only `KEY=` would
  # make such a line invisible here — deploy.sh would call the key empty and
  # refuse, render-compose.sh would drop secdev — while compose reads it fine.
  # `KEY: value` and a leading `export ` go the same way; all were checked
  # against `docker compose config` rather than guessed. deploy.sh reads the
  # same grammar (there through dotenv_file_value, which takes the file as an
  # argument); the two must agree, since they read the same file.
  dotenv_value "$(sed -n \
    -e "s/^[[:space:]]*export[[:space:]]\{1,\}//" \
    -e "s/^[[:space:]]*$1[[:space:]]*[:=][[:space:]]*//p" \
    "$ENV_FILE" | tail -1)"
}

if [ -z "$PROFILES" ]; then
  PROFILES="--profile app"
  SCORE_IMAGE_VAL="$(env_value SCORE_IMAGE)"
  if [ -n "$SCORE_IMAGE_VAL" ]; then
    PROFILES="$PROFILES --profile secdev"
  fi
fi
if [ -z "$SERVICES" ]; then
  SERVICES="app srh redis"
  case "$PROFILES" in
    *secdev*) SERVICES="$SERVICES scorer sync" ;;
  esac
fi

cd "$(dirname "$0")/../.."

command -v docker >/dev/null || { echo "FAIL: docker is required to render the compose file" >&2; exit 1; }

# shellcheck disable=SC2086
# PROFILES and SERVICES are deliberately word-split: both are lists of
# arguments, not single values.
RAW="$(docker compose --env-file "$ENV_FILE" -f docker-compose.yml $PROFILES config $SERVICES)" || {
  echo "FAIL: 'docker compose config' rejected docker-compose.yml with $ENV_FILE." >&2
  echo "      Every variable it needs must be set there — REDIS_PASSWORD and" >&2
  echo "      SRH_TOKEN especially, which compose marks required with ':?'." >&2
  exit 1
}

printf '%s\n' "$RAW" | awk -v app_image="$APP_IMAGE" \
                           -v sync_image="$SYNC_IMAGE" \
                           -v scorer_image="$SCORER_IMAGE" '
BEGIN {
  # Service names that must become loopback wherever they appear as a host in
  # a URL. Containers in one Fly machine share a netns, so these never resolve.
  svc["srh"] = 1; svc["scorer"] = 1; svc["redis"] = 1; svc["app"] = 1; svc["sync"] = 1
  print "# GENERATED by deploy/fly/render-compose.sh from docker-compose.yml."
  print "# Do not edit: every change belongs in docker-compose.yml, so the local"
  print "# stack and the deployed one cannot diverge. Regenerate with deploy.sh."
  print "#"
  print "#"
  print "# THIS FILE CONTAINS CREDENTIALS. Mode 600, gitignored, and removed once"
  print "# the deploy succeeds. Per-container environment is the ONLY channel that"
  print "# reaches a container in a Fly machine - fly secrets does not, despite"
  print "# what the docs say - so the values have to travel here."
}

# Indentation is the structure: `docker compose config` always emits a
# normalized document (two-space indent, keys sorted), which is what makes a
# line-oriented pass safe here rather than a YAML-parser-in-awk.
{
  line = $0
  match(line, /^ */)
  indent = RLENGTH
}

# --- block skipping -------------------------------------------------------
# When a dropped key opens a block, every following line indented deeper than
# it belongs to that block and goes too.
skip_indent >= 0 {
  if (indent > skip_indent) next
  skip_indent = -1
}

# --- top level ------------------------------------------------------------
indent == 0 {
  section = $0
  sub(/:.*$/, "", section)
  # Fly ignores both, and a single machine has neither. Dropping them keeps the
  # rendered file an honest description of what actually gets deployed.
  if (section == "networks" || section == "volumes") { skip_indent = 0; next }
  print
  next
}

# --- service headers ------------------------------------------------------
# `image:` is INSERTED here, immediately under the service name, rather than
# where compose would have put it: app and sync have no image key at all (they
# are `build:` services locally), and Fly requires every service to name one.
indent == 2 && section == "services" {
  service = $0
  sub(/^ +/, "", service); sub(/:.*$/, "", service)
  print
  if (service == "app")  print "    image: " app_image
  if (service == "sync") print "    image: " sync_image
  in_env = 0
  next
}

# --- per-service keys -----------------------------------------------------
indent == 4 && section == "services" {
  key = $0
  sub(/^ +/, "", key); sub(/:.*$/, "", key)
  in_env = (key == "environment")
  # build:    Fly allows at most one, and cannot pass build args; images are
  #           built and pushed before the deploy instead.
  # volumes:  named volumes are ignored by Fly (they become `[[mounts]]`), and
  #           bind mounts name host paths that do not exist on a Fly machine.
  # networks: one machine, one namespace.
  # profiles: flyctl does not implement them; selection already happened, in
  #           `docker compose config SERVICE...`. Leaving them would suggest
  #           Fly honours a filter it ignores entirely.
  if (key == "build" || key == "volumes" || key == "networks" || key == "profiles") {
    skip_indent = 4
    next
  }
  # The scorer runs a prebuilt image that must be the one the forks judge with,
  # mirrored into the Fly registry, so its image line is replaced, not kept.
  if (key == "image" && service == "scorer") { print "    image: " scorer_image; next }
}

# --- environment values ---------------------------------------------------
# --- environment values ---------------------------------------------------
# LEFT INTACT, INCLUDING SECRETS. Per-container `environment:` is the only
# channel that reaches a container in a Fly machine (see the header). What this
# does buy is scoping: each credential appears only under the service that
# `docker-compose.yml` gives it to.

# --- compose escaping -----------------------------------------------------
# `$$` IS COMPOSE-SPECIFIC AND MUST NOT SURVIVE.
#
# In a compose file `$$` means "a literal $, do not interpolate", and `docker
# compose config` faithfully re-emits it that way because its output is meant
# to be read by compose again. Fly is not compose: it passes the string
# through untouched, so redis would receive
#
#     sh -c "exec redis-server ... --requirepass \"$$REDIS_PASSWORD\""
#
# where `$$` is the SHELL PID. The password would silently become something
# like "12345REDIS_PASSWORD" — redis starts, reports healthy, and every client
# fails to authenticate against a credential nobody can predict.
{ gsub(/\$\$/, "$") }

# --- host rewriting -------------------------------------------------------
# `http://srh:80` -> `http://localhost:80`.
#
# TWO anchors, because a URL authority can carry userinfo. The srh connection
# string is `redis://:PASSWORD@redis:6379`, where the host follows an `@` and
# not the `//` — with only the `//host:` form the match would leave it
# pointing at `redis`, which resolves nowhere in a shared network namespace:
# srh healthy, unable to connect.
#
# Both forms end in `:` so they can only match an authority followed by a port.
# A bare word like `scorer` in a comment, or `app` inside a longer hostname, is
# left alone.
{
  out = ""
  rest = $0
  while (match(rest, /(\/\/|@)[A-Za-z0-9_-]+:/)) {
    lead = substr(rest, RSTART, 1) == "@" ? 1 : 2
    host = substr(rest, RSTART + lead, RLENGTH - lead - 1)
    out = out substr(rest, 1, RSTART + lead - 1)
    out = out ((host in svc) ? "localhost" : host) ":"
    rest = substr(rest, RSTART + RLENGTH)
  }
  print out rest
}
' | awk '
# SECOND PASS: drop `environment:` keys left with nothing under them.
#
# A service whose every environment entry was a secret (redis: REDIS_PASSWORD
# and REDISCLI_AUTH, both stripped) ends up with a bare `environment:` — which
# is YAML null, not an empty mapping. Docker tolerates that; a hand-rolled
# unmarshal into a map type need not, and an empty key carries no information
# either way.
#
# Deferring by one line is enough to decide: the block is empty exactly when
# the next line is not indented deeper than the key.
{
  if (held != "") {
    match($0, /^ */)
    if (RLENGTH > held_indent) print held
    held = ""
  }
  match($0, /^ */)
  if ($0 ~ /^ +environment:[ \t]*$/) { held = $0; held_indent = RLENGTH; next }
  print
}
END { if (held != "") { } }
'  > "$OUT.tmp"

# Mode 600 BEFORE the content lands. `mv` would otherwise leave the file
# world-readable for the moment between rename and chmod, and it holds
# every credential the event has.
: > "$OUT"
chmod 600 "$OUT"
cat "$OUT.tmp" > "$OUT"
rm -f "$OUT.tmp"

# ---------------------------------------------------------------------------
# FAIL-CLOSED CHECK: this file holds credentials, so prove git cannot see it.
#
# The check guards what is true: a credential file exists on disk, beside a
# repo whose .env.fly reached a PUBLIC remote twice. Fly does not supply
# secrets to compose containers (see the header), so the values travel in this
# file and git must not be able to see it.
#
# `git check-ignore` is asked directly rather than trusting that .gitignore
# has the right rule.
# ---------------------------------------------------------------------------
if git -C "$(dirname "$OUT")" rev-parse --git-dir >/dev/null 2>&1; then
  if ! git -C "$(dirname "$OUT")" check-ignore -q "$(basename "$OUT")"; then
    rm -f "$OUT"
    echo "FAIL: $OUT is NOT gitignored, and it contains every credential this" >&2
    echo "      event has. Refusing to leave it on disk." >&2
    echo "      Add it to .gitignore, then re-run." >&2
    exit 1
  fi
fi

echo "   rendered $OUT ($(grep -c '' "$OUT") lines, mode 600 — contains secrets, gitignored)"
