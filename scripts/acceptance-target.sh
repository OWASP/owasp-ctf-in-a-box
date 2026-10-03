#!/usr/bin/env bash
# Stock-scores-zero gate (docs/modules.md §6.4) against a REAL target.
#
# Boots the stock, unpatched upstream image and scores the vendored rubric
# against it. Every challenge MUST fail: a vendored test that passes here is a
# free point for every contestant, which is the exact failure the golden rule
# ("assert the fix, not the exploit") exists to prevent.
#
# Usage: scripts/acceptance-target.sh <target> <stock-image>
#
# <stock-image> may be the literal `none`, meaning "score this target from SOURCE, not
# from a published image". `none` becomes an empty APP_IMAGE, which keeps the
# two-argument contract intact and states the intent at the call site instead of
# overloading a missing argument. Two targets use it, for different reasons:
#
#   * securityshepherd — has no published stock image at all
#     (`owaspsecurityshepherd/shepherd` does not exist, and `owasp/security-shepherd`
#     was last pushed in 2018, years before the release-17 tree the rubric targets),
#     which is why upstream's own six-target CI matrix leaves that row's app-image
#     empty. Its bring-up clones the pinned upstream source itself.
#   * webgoat — HAS a stock image (and the matrix gates that row too), but its
#     bring-up ALSO builds a contestant's fork from source, and that path deserves a
#     gate of its own. Here the source is staged into the WORKSPACE rather than left
#     to the bring-up, precisely so the run takes the same branch a contestant's PR
#     takes: workspace Dockerfile present -> Maven -> image. See the
#     acc_stage_source call below (helper in scripts/lib/acceptance-lib.sh).
#
# A target whose bring-up can do neither still fails loudly on the empty APP_IMAGE,
# exactly as it does today.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/acceptance-lib.sh

TARGET="${1:?usage: $0 <target> <stock-image|none>}"
STOCK_IMAGE="${2:?usage: $0 <target> <stock-image|none>}"
if [ "$STOCK_IMAGE" = "none" ]; then STOCK_IMAGE=""; fi

IMG="ctf-score:acceptance-$TARGET"
NET="ctf-acceptance-$TARGET"
TMP="$(mktemp -d)"
WS="$TMP/workspace"
mkdir -p "$WS"

# entrypoint.sh already reaps the containers its bring-up started (BOOTED plus
# EXTRA_CONTAINERS) on its own EXIT. This is the belt-and-braces for the case where
# the scorer container itself dies hard and never runs that trap — so it names every
# sibling any bring-up can start: dvwa's `db`, and securityshepherd's three (plus the
# source volumes the securityshepherd and webgoat Maven handoffs create, which would
# otherwise leak a GB of disk apiece).
cleanup() {
  docker rm -f "ctf-app-$TARGET" db secshep_tomcat secshep_mariadb secshep_mongo >/dev/null 2>&1 || true
  docker volume rm -f ss_src webgoat_src >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

acc_build_scorer "$IMG"

docker network create --internal "$NET" >/dev/null 2>&1 || true

# The per-target URL facts (hardcoded listen port, servlet context path,
# non-http scheme) live in acc_url_for in scripts/lib/acceptance-lib.sh — one
# table shared by both scoring gates, whose doc comment carries the full
# rationale (VAmPI's :5000, VulnerableApp's /VulnerableApp context path,
# securityshepherd's https on :8443) and the lockstep note for
# setup/ctf-setup.sh's app_url_for().
acc_url_for "$TARGET"

# Pinned upstream source for the targets whose SOURCE path this gate exercises (see
# the `none` note in the header). Pinned to a COMMIT, never a branch and never a bare
# tag: a branch moves, and a tag can be re-pointed — either would silently score a
# different app on some later run and could quietly inflate the stock score. This SHA
# is what `WebGoat/WebGoat`'s v2025.3 tag points at, the same release as the prebuilt
# `webgoat/webgoat:v2025.3` the other matrix row runs (pom.xml at this commit reads
# <version>2025.3</version>), so both rows score the same app by two different routes.
# Bump it only together with the image pin, and with a fresh run of both rows.
# `securityshepherd` needs no entry here: its own bring-up clones its pin
# (SS_UPSTREAM_REF) because its build has no workspace-Dockerfile branch to take.
WG_UPSTREAM_REPO="${WG_UPSTREAM_REPO:-WebGoat/WebGoat}"
WG_UPSTREAM_REF="${WG_UPSTREAM_REF:-c3ed45a733377bc7313b93f57ff518254d81380f}"

# `none` on a target that HAS a published image means "prove the source path".
# acc_stage_source stages the pinned tree into the WORKSPACE — not into the
# bring-up — so the bring-up sees exactly what a contestant's PR checkout looks
# like (a fork tree with a root Dockerfile) and takes exactly the branch that
# PR would take. It asserts the Dockerfile precondition loudly too: without
# that file the bring-up falls through to "need APP_IMAGE or a workspace
# Dockerfile" and the gate would look like a packaging bug.
if [ -z "$STOCK_IMAGE" ] && [ "$TARGET" = "webgoat" ]; then
  acc_stage_source "$WS" "$WG_UPSTREAM_REPO" "$WG_UPSTREAM_REF"
fi

acc_write_event "$TMP/event.json"

echo "Scoring STOCK $TARGET — expecting every challenge to FAIL…"
APP_IMAGE="$STOCK_IMAGE" acc_run_judge

REPORT="$WS/ctf-score.md"
[ -f "$REPORT" ] || { echo "FAIL: no ctf-score.md produced"; exit 1; }

SCORE="$(acc_score_counts "$REPORT")"
SOLVED="${SCORE% *}"
TOTAL="${SCORE#* }"

echo "stock $TARGET scored $SOLVED / $TOTAL"

if [ "$SOLVED" != "0" ]; then
  echo
  echo "FAIL: $SOLVED challenge(s) passed against the STOCK app."
  echo "Those tests assert the exploit rather than the fix, or the stock image is"
  echo "already hardened. Offending challenges:"
  grep -F "✅ Patched" "$REPORT" || true
  exit 1
fi

[ "$TOTAL" -gt 0 ] || { echo "FAIL: rubric scored 0 challenges total — is it wired up?"; exit 1; }

echo "PASS: stock $TARGET scores 0 / $TOTAL"
