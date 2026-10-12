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
# image that is built locally or pinned by whoever passes it in.
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
      if (cmd !~ /docker[ \t]+(run|pull|create)([ \t]|$)/ && cmd !~ /^[ \t]*(-[ \t]+)?image:/) next
      if (cmd ~ /(^|[ \t"])[^= \t"]+@sha256:[0-9a-f]{64}/) state = "pinned"
      else if (above ~ /^[ \t]*# pins: [^ \t]/) state = "exempt"
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
  } > "$f"
  flagged="$(unpinned_images "$f" | cut -d: -f2 | tr '\n' ' ')"
  states="$(image_refs "$f" | cut -d: -f2,3 | tr '\n' ' ')"
  echo "all: $states"
  echo "flagged lines: '$flagged' (want '1 2 3 4 8 14 16 ')"
  [ "$flagged" = "1 2 3 4 8 14 16 " ]
}

@test "every image a script, workflow or compose file runs is digest-pinned or says why not" {
  set -- "$ROOT"/scripts/*.sh "$ROOT"/scripts/lib/*.sh "$ROOT"/.github/workflows/*.yml "$ROOT"/docker-compose*.yml
  refs="$(image_refs "$@")"
  unpinned="$(unpinned_images "$@")"
  if [ -n "$unpinned" ]; then
    echo "UNPINNED image(s) — add @sha256:<digest>, or a '# pins: <reason>' line directly above:"
    echo "$unpinned"
  fi
  [ -n "$refs" ] || { echo "found no image references at all — the pattern no longer matches"; return 1; }
  [ -z "$unpinned" ]
}
