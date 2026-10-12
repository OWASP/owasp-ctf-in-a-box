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

# image_refs <file>... — every redis/srh/caddy image a `docker run` or a
# workflow `image:` names, tagged or not, as `file:line:pinned|unpinned`.
# The image is found by position (the first argument after `docker run` and
# its options), not by matching words: `redis` is also a service name, a
# network alias and a hostname all over these scripts.
image_refs() {
  awk '
    function report(img, ln,   repo) {
      gsub(/["\047]/, "", img)
      repo = img
      sub(/@.*/, "", repo)
      sub(/:[^\/]*$/, "", repo)
      if (repo != "redis" && repo != "hiett/serverless-redis-http" && repo != "caddy") return
      print FILENAME ":" ln ":" (img ~ /@sha256:[0-9a-f]{64}$/ ? "pinned" : "unpinned") ": " img
    }
    FNR == 1 { buf = ""; start = 0 }
    {
      line = $0
      if (buf == "") start = FNR
      if (line ~ /\\[ \t]*$/) { sub(/\\[ \t]*$/, " ", line); buf = buf line; next }
      cmd = buf line
      buf = ""
      if (cmd ~ /^[ \t]*#/) next
      if (cmd ~ /^[ \t]*(-[ \t]+)?image:[ \t]*/) {
        v = cmd
        sub(/^[ \t]*(-[ \t]+)?image:[ \t]*/, "", v)
        sub(/[ \t]+#.*$/, "", v)
        report(v, start)
        next
      }
      i = index(cmd, "docker run ")
      if (i == 0) next
      n = split(substr(cmd, i + 11), tok, /[ \t]+/)
      for (k = 1; k <= n; k++) {
        t = tok[k]
        if (t == "") continue
        if (t ~ /^-/) {
          if (t !~ /=/ && t ~ /^(-e|--env|--env-file|-p|--publish|-v|--volume|--name|--network|--network-alias|--entrypoint|-w|--workdir|-u|--user|--add-host|-l|--label|--mount|--platform|-h|--hostname|--restart|--pull|--cpus|-m|--memory|--health-cmd|--health-interval|--health-retries|--health-timeout|--ulimit|--tmpfs|--cap-add|--cap-drop|--security-opt|--log-driver|--log-opt)$/) k++
          continue
        }
        report(t, start)
        break
      }
    }
  ' "$@"
}
unpinned_images() {
  image_refs "$@" | grep ':unpinned: ' || true
}

@test "the image check flags untagged and tagged references alike, and passes pinned ones" {
  digest="@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  f="$BATS_TEST_TMPDIR/fixture.sh"
  {
    echo 'docker run -d --name r redis'
    echo 'docker run -d --name s hiett/serverless-redis-http'
    echo 'docker run -d --name c caddy:2-alpine'
    echo "docker run -d --name ok1 --network-alias redis redis:8-alpine$digest redis-server"
    echo "docker run -d --name ok2 hiett/serverless-redis-http$digest"
    echo "            image: caddy"
    echo "            image: caddy:2-alpine$digest"
  } > "$f"
  flagged="$(unpinned_images "$f" | cut -d: -f2 | tr '\n' ' ')"
  echo "flagged lines: '$flagged' (want '1 2 3 6 ')"
  [ "$flagged" = "1 2 3 6 " ]
}

@test "every redis, srh and caddy image a script or workflow runs is digest-pinned" {
  refs="$(image_refs "$ROOT"/scripts/*.sh "$ROOT"/scripts/lib/*.sh "$ROOT"/.github/workflows/*.yml)"
  unpinned="$(unpinned_images "$ROOT"/scripts/*.sh "$ROOT"/scripts/lib/*.sh "$ROOT"/.github/workflows/*.yml)"
  if [ -n "$unpinned" ]; then
    echo "UNPINNED image(s):"
    echo "$unpinned"
  fi
  [ -n "$refs" ] || { echo "found no image references at all — the pattern no longer matches"; return 1; }
  [ -z "$unpinned" ]
}
