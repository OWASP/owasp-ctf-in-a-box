#!/usr/bin/env bash
# Proves what the app reads at BUILD time versus at RUNTIME now that config
# v2 has deleted the event.yaml bake (issue #386 part 4). The app image no
# longer takes an EVENT_CONFIG_B64 build arg at all — everything that used to
# be baked (the admin allowlist, the GitHub fork org, the event's name, which
# Secure Development targets run) is now read at request time, from `.env`
# (ADMIN_LOGINS, GITHUB_ORG) or from /admin settings in Redis (name, targets).
# So a single image is built ONCE, and every scenario below is a different
# runtime `docker run -e ...` against that same image, not a different build.
#
# The event's name and which Secure Development targets run are runtime
# /admin settings (issue #386) and are not baked at all, so a build with no
# Redis behind it must fail open to their spec defaults — the name, and all
# six targets — rather than render nothing, an error, or a name baked from
# this file.
#
# The six `targets.tsv` targets are NOT gated by anything this script passes:
# which Secure Development targets run is an admin-panel setting read from
# Redis at request time, and with no Redis behind this run every one of them
# renders regardless. This script pins that: DVWA and VAmPI AND WebGoat all
# render even though nothing here names any of them. The reverse — that the
# admin-chosen subset actually narrows what renders — is pinned by the
# /challenges page's own vitest suite, not here.
#
# ChallengeGrid (the /challenges app list) is a Client Component, but its
# server parent reads the live target list from Redis (`getEnabledApps`) and
# passes it down as props, so the route renders dynamically (`ƒ /challenges`
# in the build output, not `○`) and Next.js still emits the rendered app
# names into the server HTML response body on every request — no need to
# fall back to grepping the flight/__NEXT_DATA__ payload separately.
set -euo pipefail
cd "$(dirname "$0")/.."

cleanup() {
  docker rm -f web-acceptance web-default web-noscorer >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Waits (up to ~60s) for a container to answer GET / and prints the body.
wait_for_html() {
  local url=$1 deadline=$((SECONDS + 60))
  until curl -sf "$url" 2>/dev/null; do
    [ "$SECONDS" -ge "$deadline" ] && { echo "FAIL: $url never came up"; return 1; }
    sleep 1
  done
}

# A fixed, obviously-synthetic sha, so the /health assertion below is checking
# that THIS build arg arrived rather than that some sha did. `git rev-parse`
# would pass even if the arg were dropped and the route fell back to a value it
# read some other way.
ACCEPTANCE_REV=abcdef123456
# ONE build, no EVENT_CONFIG_B64 — the app image no longer takes it. Every
# scenario below reuses this same image with different runtime env.
docker build -f apps/web/Dockerfile -t ctf-web:acceptance \
  --build-arg APP_BUILD_REV="$ACCEPTANCE_REV" \
  --build-arg APP_BUILT_AT=2026-01-01T00:00:00Z .
docker run -d --name web-acceptance -p 3100:3000 \
  -e BETTER_AUTH_SECRET=acceptance-app-secret-32-characters-min -e BETTER_AUTH_URL=http://localhost:3100 \
  -e SCORE_IMAGE=ghcr.io/example/score:acceptance \
  -e GITHUB_ORG=acceptance-org -e ADMIN_LOGINS=acceptance-admin ctf-web:acceptance

HOME_HTML=$(wait_for_html http://localhost:3100/)
CHALLENGES_HTML=$(wait_for_html http://localhost:3100/challenges)

# A bare `grep -q` under `set -e` fails with no message at all; every positive
# assertion goes through this so a red run says what was missing.
# A here-string rather than a pipe: `grep -q` exits on the first match, and
# under `pipefail` a page larger than the pipe buffer would SIGPIPE the writer
# and turn a genuine match into a false failure.
expect_in() { # haystack needle what
  if ! grep -qF -- "$2" <<< "$1"; then echo "FAIL: $3 (missing: $2)"; exit 1; fi
}

echo "--- identity fails open to the default name (no Redis behind this run)"
# Identity fails OPEN to the spec default when there is no Redis to read
# (issue #386): the title must be the default name, not empty, not an error.
expect_in "$HOME_HTML" "<title>OWASP CTF in a Box</title>" "landing page title is not the default event name without settings"
echo "--- no DC34 branding"
if echo "$HOME_HTML$CHALLENGES_HTML" | grep -qi "DEF CON"; then echo "FAIL: DC34 leaked"; exit 1; fi
echo "--- all six targets render; no Redis behind this run means no admin-chosen subset"
# With no Redis behind this run, the app has no secureDevTargets to read and
# defaults to all six — DVWA and VAmPI AND WebGoat must all render even
# though nothing above named any of them. Which targets actually run is
# chosen in /admin at request time; that subset behaviour is pinned by the
# /challenges page's own vitest suite, not this script.
expect_in "$CHALLENGES_HTML" "DVWA" "target DVWA not rendered"
expect_in "$CHALLENGES_HTML" "VAmPI" "target VAmPI not rendered"
expect_in "$CHALLENGES_HTML" "WebGoat" "target WebGoat not rendered"

echo "--- fork links use GITHUB_ORG, not a hardcoded OWASP-CTF"
expect_in "$CHALLENGES_HTML" "github.com/acceptance-org/DVWA" "fork link does not use GITHUB_ORG"
expect_in "$CHALLENGES_HTML" "github.com/acceptance-org/VAmPI" "fork link does not use GITHUB_ORG"
expect_in "$CHALLENGES_HTML" "github.com/acceptance-org/WebGoat" "fork link does not use GITHUB_ORG"
if echo "$CHALLENGES_HTML" | grep -q "github.com/OWASP-CTF/"; then
  echo "FAIL: custom-org run still links OWASP-CTF forks"; exit 1
fi

echo "--- with a scorer image, secure-development is the only default board"
# "The game" alone is a substring of "The games" and would pass with 0 or
# many boards on the page too — pin the exact singular heading instead.
expect_in "$HOME_HTML" "The game</h2>" "landing page does not present exactly one board"
if grep -qF "No boards are open yet." <<< "$HOME_HTML"; then
  echo "FAIL: landing page shows the no-boards state although a scorer image is set"; exit 1
fi
for route in /quiz /flags /ai; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3100$route")
  if [ "$code" != "404" ]; then echo "FAIL: $route returned $code, want 404 — a content module is on by default"; exit 1; fi
done

echo "--- /admin renders its shell, on both URL shapes"
# Issue #312: every /admin URL 500'd in production for a release while this
# script, `next build`, vitest and CI were all green. The route files called
# resolveAdminTab(), which lived in a `"use client"` module — a client
# REFERENCE, not a callable — so the throw happened at REQUEST time, in a
# place no build step and no unit test can reach.
#
# Asserting on rendered COPY, not on a status code: the app streams the shell
# with HTTP 200 and the failure arrives inside the body, so
# `curl -o /dev/null -w %{http_code} /admin` returns 200 on a fully dead panel.
#
# Signed out is the point. requireAdmin refuses, AdminPanel renders its
# "Forbidden / Organizer access only" wall, and seeing that wall proves the
# whole chain ran: the route file executed, the tab helper was callable, and
# the panel rendered. The bug replaced this wall with the error boundary.
#
# Both shapes, because they are different route files with different bugs to
# hit: /admin is page.tsx, /admin/<tab> is [tab]/page.tsx.
for admin_path in /admin /admin/overview; do
  ADMIN_HTML=$(wait_for_html "http://localhost:3100${admin_path}")
  expect_in "$ADMIN_HTML" "Organizer access only" "${admin_path} did not render the admin shell"
  if grep -qF "That didn't load" <<< "$ADMIN_HTML"; then
    echo "FAIL: ${admin_path} rendered the error boundary (see issue #312)"; exit 1
  fi
done

echo "--- /health reports the build stamp the image was built with"
# Built above with --build-arg APP_BUILD_REV/APP_BUILT_AT, so this proves the
# whole chain: compose arg -> Dockerfile ARG -> runtime ENV -> the route. Each
# link is invisible on its own, and a broken one degrades to "unknown" rather
# than erroring — exactly the silent failure /health exists to rule out.
HEALTH_JSON=$(wait_for_html http://localhost:3100/health)
expect_in "$HEALTH_JSON" '"status":"ok"' "/health did not report ok"
expect_in "$HEALTH_JSON" "\"revision\":\"$ACCEPTANCE_REV\"" "/health did not carry APP_BUILD_REV through the build"
expect_in "$HEALTH_JSON" '"version":"' "/health did not report a version"
# The payload is public and unauthenticated: it must stay a build stamp.
for leak in BETTER_AUTH GITHUB_CLIENT SRH_TOKEN REDIS_PASSWORD UPSTASH; do
  if grep -qF -- "$leak" <<< "$HEALTH_JSON"; then
    echo "FAIL: /health leaked $leak"; exit 1
  fi
done

echo "--- /health/deep reports Redis down on a box that has none, and discloses nothing else"
# web-acceptance runs with no srh/redis at all, which makes this the
# anti-vacuous case for free: the deep check has to answer 503 and NAME
# redis. A 200 here would mean the probe is not probing. It must also stay
# under /health's disclosure rule — two words per dependency, no host, no
# error text — so the same leak loop runs against it.
DEEP_BODY=$(mktemp)
DEEP_CODE=$(curl -s -o "$DEEP_BODY" -w '%{http_code}' http://localhost:3100/health/deep)
DEEP_JSON=$(cat "$DEEP_BODY"); rm -f "$DEEP_BODY"
if [ "$DEEP_CODE" != "503" ]; then echo "FAIL: /health/deep returned $DEEP_CODE with no Redis, want 503"; exit 1; fi
expect_in "$DEEP_JSON" '"status":"degraded"' "/health/deep did not report degraded without Redis"
expect_in "$DEEP_JSON" '"redis":"down"' "/health/deep did not name redis as the failed dependency"
for leak in BETTER_AUTH GITHUB_CLIENT SRH_TOKEN REDIS_PASSWORD UPSTASH http:// ECONNREFUSED; do
  if grep -qF -- "$leak" <<< "$DEEP_JSON"; then
    echo "FAIL: /health/deep leaked $leak"; exit 1
  fi
done

echo "--- without a scorer image, nothing is enabled and the landing page says so"
docker run -d --name web-noscorer -p 3102:3000 \
  -e BETTER_AUTH_SECRET=acceptance-app-secret-32-characters-min -e BETTER_AUTH_URL=http://localhost:3102 ctf-web:acceptance
NOSCORER_HTML=$(wait_for_html http://localhost:3102/)
expect_in "$NOSCORER_HTML" "No boards are open yet." "no-scorer build did not render the no-boards state"
expect_in "$NOSCORER_HTML" "An organizer switches them on in the admin panel." "no-boards state lacks the pointer to /admin"
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3102/challenges)
if [ "$code" != "404" ]; then echo "FAIL: /challenges returned $code without a scorer image, want 404"; exit 1; fi

echo "--- default run (no GITHUB_ORG) is neutral (no DEF CON, name OWASP CTF in a Box)"
# SAME image as web-acceptance — this is a runtime env difference, not a
# rebuild: config v2 has nothing left for a second build to bake.
docker run -d --name web-default -p 3101:3000 \
  -e BETTER_AUTH_SECRET=acceptance-app-secret-32-characters-min -e BETTER_AUTH_URL=http://localhost:3101 \
  -e SCORE_IMAGE=ghcr.io/example/score:acceptance ctf-web:acceptance
DEFAULT_HTML=$(wait_for_html http://localhost:3101/)
DEFAULT_CHALLENGES_HTML=$(wait_for_html http://localhost:3101/challenges)
if echo "$DEFAULT_HTML" | grep -qi "DEF CON"; then echo "FAIL: default run carries DC34"; exit 1; fi
# "OWASP CTF in a Box" alone is vacuous: the landing page's evaluator card hardcodes
# that string in prose regardless of the event's runtime identity. Assert the
# actual title tag, like the identity-fails-open check near the top of this
# script does.
expect_in "$DEFAULT_HTML" "<title>OWASP CTF in a Box</title>" "default run does not carry the neutral name in the page title"

echo "--- with no GITHUB_ORG, /challenges renders bare repo names and no fork link"
# forkUrl(org, id) returns null for an empty org (apps.ts) — no OWASP-CTF
# fallback any more, since there is nothing baked to fall back to. The page
# renders the bare repo name instead of a link.
expect_in "$DEFAULT_CHALLENGES_HTML" "DVWA" "default run's /challenges does not render the DVWA repo name"
if echo "$DEFAULT_CHALLENGES_HTML" | grep -q "acceptance-org"; then
  echo "FAIL: default run's /challenges links acceptance-org even though GITHUB_ORG was not set"; exit 1
fi
# "DVWA" above also matches the challenge card's title text, so it passes
# whether or not a fork link rendered. Assert no fork link at all — for ANY
# org, not just acceptance-org, so a leftover/mistaken org value still fails.
if echo "$DEFAULT_CHALLENGES_HTML" | grep -qE 'github\.com/[^"]+/DVWA'; then
  echo "FAIL: default run's /challenges renders a DVWA fork link even though GITHUB_ORG was not set"; exit 1
fi

echo "ACCEPTANCE PASS"
