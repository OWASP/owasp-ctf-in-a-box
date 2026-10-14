#!/usr/bin/env bats
#
# Every third-party action is pinned to a full commit, and every image a test
# harness runs is pinned to a digest. A tag can be moved under us; a pin
# cannot. The tag stays as a trailing comment (`@<sha> # vX.Y.Z`) because that
# comment is what Dependabot reads to keep the pin current.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
}

@test "every workflow 'uses:' is pinned to a 40-character commit with its tag as a comment" {
  unpinned="$(grep -nE '^[[:space:]]*(-[[:space:]]+)?uses:' "$ROOT"/.github/workflows/*.yml \
    | grep -vE 'uses:[[:space:]]+[^@[:space:]]+@[0-9a-f]{40}[[:space:]]+#[[:space:]]*v[0-9]' \
    | grep -vE 'uses:[[:space:]]+\./' || true)"
  total="$(grep -cE '^[[:space:]]*(-[[:space:]]+)?uses:' "$ROOT"/.github/workflows/*.yml | awk -F: '{ n += $NF } END { print n + 0 }')"
  if [ -n "$unpinned" ]; then
    echo "UNPINNED action(s):"
    echo "$unpinned"
  fi
  [ "$total" -gt 0 ] || { echo "found no 'uses:' lines at all — the pattern no longer matches the workflows"; return 1; }
  [ -z "$unpinned" ]
}

# image_refs <file>... — one line per image reference, as
# `file:line:pinned|unpinned|exempt: <text>`. No option or name parsing: an
# image reference is a whole `docker run|pull|create` command (backslash
# continuations joined, so a digest on a later line counts) or an `image:`
# value, and it is pinned when a word of its own (not a KEY=value option, where
# a digest says nothing about the image run) carries @sha256:<64 hex>. The one
# way out is a `# pins: <reason>` comment on the line directly above, for an
# image that is built locally or pinned by whoever passes it in. An `image:`
# whose value is a `${…}` variable (chosen per box, e.g. SCORE_IMAGE) or
# `!reset null` (no image at all) is exempt without a comment.
#
# An image held in a variable is checked where it is SET: an `*IMAGE*=` or
# `IMG*=` assignment whose value (or `${VAR:-default}` default) is a literal,
# bare names included (`alpine` is `alpine:latest`), needs the same digest or
# `# pins:` line. A value that is empty, a number (a flag), or built from a
# variable or argument is the caller's choice and is skipped. The
# `docker run "$VAR"` that uses it then takes a `# pins:` line naming the
# variable, since the check cannot follow it there.
image_refs() {
  awk '
    FNR == 1 { buf = ""; prev = ""; above = "" }
    {
      line = $0
      if (buf == "") { start = FNR; above = prev }
      prev = line
      if (line ~ /\\[ \t]*$/) { sub(/\\[ \t]*$/, " ", line); buf = buf line; next }
      cmd = buf line
      buf = ""
      if (cmd ~ /^[ \t]*#/) next
      if (cmd ~ /^[ \t]*((export|local)[ \t]+)?([A-Z][A-Z0-9_]*)?(IMAGE|IMG)[A-Z0-9_]*=/) {
        v = cmd
        sub(/^[^=]*=/, "", v)
        if (v ~ /^(""|\047\047|[ \t]|$)/) next
        sub(/[ \t]+#.*$/, "", v); gsub(/["\047]/, "", v)
        sub(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-/, "", v)
        if (v ~ /\$/ || v ~ /^[0-9]+$/) next
        if (v ~ /@sha256:[0-9a-f]{64}/) state = "pinned"
        else if (above ~ /^[ \t]*# pins: [^ \t]/) state = "exempt"
        else state = "unpinned"
        sub(/^[ \t]+/, "", cmd)
        print FILENAME ":" start ":" state ": " cmd
        next
      }
      if (cmd !~ /docker[ \t]+(run|pull|create)([ \t]|$)/ && cmd !~ /^[ \t]*(-[ \t]+)?image:/) next
      if (cmd ~ /(^|[ \t"])[^= \t"]+@sha256:[0-9a-f]{64}/) state = "pinned"
      else if (above ~ /^[ \t]*# pins: [^ \t]/) state = "exempt"
      else if (cmd ~ /^[ \t]*(-[ \t]+)?image:[ \t]*(\$\{|!reset[ \t]+null)/) state = "exempt"
      else state = "unpinned"
      sub(/^[ \t]+/, "", cmd)
      print FILENAME ":" start ":" state ": " cmd
    }
  ' "$@"
}
unpinned_images() {
  image_refs "$@" | grep -E '^[^:]+:[0-9]+:unpinned: ' || true
}

@test "the image check needs a digest on every docker run/pull/create and image: line" {
  digest="@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  f="$BATS_TEST_TMPDIR/fixture.sh"
  {
    echo 'docker run -d --device /dev/fuse redis:latest'                 # 1 flagged
    echo 'docker run -d --name r redis'                                   # 2 flagged
    echo 'docker pull docker.io/library/redis:8'                         # 3 flagged
    echo '    image: docker.io/library/redis:8'                           # 4 flagged
    echo 'docker run -d --name ok --network-alias redis \'                # 5 pinned
    echo '  -e A=1 \'
    echo "  redis:8-alpine$digest >/dev/null"
    echo 'docker run -d --name bad --network-alias redis \'               # 8 flagged
    echo '  -e A=1 \'
    echo '  redis:8-alpine >/dev/null'
    echo '# pins: built locally by this script'                           # 11
    echo 'docker run -d "$IMG"'                                           # 12 exempt
    echo '#'                                                              # 13
    echo 'docker create caddy'                                            # 14 flagged
    echo "    image: caddy$digest"                                        # 15 pinned
    echo "docker run -e REF=redis$digest redis:latest"                     # 16 flagged
    echo '    image: ${SCORE_IMAGE:-ghcr.io/x/score:latest}'              # 17 exempt (per-box)
    echo '    image: !reset null'                                         # 18 exempt (no image)
    echo 'MAVEN_IMAGE="maven:3.9-eclipse-temurin-17"'                     # 19 flagged
    echo 'JDK_IMAGE="${X_JDK_IMAGE:-eclipse-temurin:23-jdk-noble}"'       # 20 flagged (the default)
    echo "JDK_IMAGE=\"\${X_JDK_IMAGE:-eclipse-temurin:23-jdk-noble$digest}\"" # 21 pinned
    echo 'STOCK_IMAGE="${2:?usage: $0 <target> <stock-image|none>}"'      # 22 not an image (an argument)
    echo 'CTRL_IMG="ctf-fork-$TARGET-control"'                            # 23 not an image (a local name)
    echo 'IMG_TOMCAT="owasp/security-shepherd"'                           # 24 flagged
    echo '# pins: built locally by this script'                           # 25
    echo 'IMG_MONGO="owasp/security-shepherd_mongo"'                      # 26 exempt
    echo 'CTRL_REUSE_JUDGE_IMAGE=0   # 1 = reuse the judge image: yes/no'  # 27 not an image (a flag)
    echo 'TOOL_IMAGE=alpine'                                              # 28 flagged (bare name = latest)
    echo 'APP_IMAGE="" acc_run_judge'                                     # 29 not an image (empty)
    echo "IMAGE=''"                                                       # 30 not an image (empty)
    echo "IMAGE='alpine'"                                                 # 31 flagged (bare name = latest)
  } > "$f"
  exempt="$(image_refs "$f" | grep -E '^[^:]+:[0-9]+:exempt: ' | cut -d: -f2 | tr '\n' ' ')"
  echo "exempt lines: '$exempt' (want '12 17 18 26 ')"
  [ "$exempt" = "12 17 18 26 " ] || return 1
  flagged="$(unpinned_images "$f" | cut -d: -f2 | tr '\n' ' ')"
  states="$(image_refs "$f" | cut -d: -f2,3 | tr '\n' ' ')"
  echo "all: $states"
  echo "flagged lines: '$flagged' (want '1 2 3 4 8 14 16 19 20 24 28 31 ')"
  [ "$flagged" = "1 2 3 4 8 14 16 19 20 24 28 31 " ] || return 1
  pinned="$(image_refs "$f" | grep -E '^[^:]+:[0-9]+:pinned: ' | cut -d: -f2 | tr '\n' ' ')"
  echo "pinned lines: '$pinned' (want '5 15 21 ')"
  [ "$pinned" = "5 15 21 " ]
}

@test "every image a script, workflow, compose file or judge entrypoint runs is digest-pinned or says why not" {
  set -- "$ROOT"/scripts/*.sh "$ROOT"/scripts/lib/*.sh "$ROOT"/.github/workflows/*.yml "$ROOT"/docker-compose*.yml \
    "$ROOT"/scorer/entrypoint.sh "$ROOT"/scorer/entrypoints/*.sh
  refs="$(image_refs "$@")"
  unpinned="$(unpinned_images "$@")"
  if [ -n "$unpinned" ]; then
    echo "UNPINNED image(s) — add @sha256:<digest>, or a '# pins: <reason>' line directly above:"
    echo "$unpinned"
  fi
  [ -n "$refs" ] || { echo "found no image references at all — the pattern no longer matches"; return 1; }
  [ -z "$unpinned" ]
}
