#!/usr/bin/env bats
#
# Checks on the AWS ECS module's deploy wrapper.
#
# `terraform validate` and `terraform test` cover the stack itself (see
# stack.tftest.hcl, which renders container definitions at plan time because
# validate never inspects rendered output). Neither can say anything about
# deploy.sh.
#
# Config v2 (#386) removed the app's build-time config entirely: GITHUB_ORG
# and ADMIN_LOGINS are runtime environment reads now (ecs.tf), so deploy.sh
# has no file to require and no config to bake into the image. What used to be
# the config-bake tests below now assert the ABSENCE of that machinery —
# no --config flag, no EVENT_CONFIG_B64 build arg — with a named failure, so a
# regression that reintroduced the bake would fail loudly rather than pass by
# omission.
#
# Nothing here touches AWS. `docker`, `aws` and `terraform` are replaced with
# stubs that record their arguments, which is also how the --dry-run tests
# prove a real call was never made rather than merely assuming it.
#
# Every test ends with its decisive assertion, in single brackets or a
# `grep -q`: AGENTS.md records that a `[[ ]]` or a negated pipeline in the
# middle of a @test does not fail it.

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT="$ROOT/deploy/aws-terraform/deploy.sh"
  STUBS="$BATS_TEST_TMPDIR/stubs"
  CALLS="$BATS_TEST_TMPDIR/calls.log"

  mkdir -p "$STUBS"
  : > "$CALLS"
  for tool in docker aws terraform; do
    printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "$tool" "$CALLS" > "$STUBS/$tool"
    chmod +x "$STUBS/$tool"
  done

  PATH="$STUBS:$PATH"
}

@test "--dry-run makes no docker, aws or terraform call at all" {
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  # The whole point: a preview that shells out is not a preview. An empty log
  # is the assertion, so it has to be the last statement.
  [ ! -s "$CALLS" ]
}

@test "no config file is required — deploy.sh runs with none present" {
  # The old behavior refused to run without event.yaml. Config v2 removed
  # that file from the repo entirely, so the script must not look for one.
  [ ! -f "$ROOT/event.yaml" ]
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
}

@test "--config is no longer accepted" {
  run "$SCRIPT" --dry-run --config /nonexistent/event.yaml
  [ "$status" -ne 0 ]
  echo "$output" | grep -q 'unknown argument'
}

@test "the docker build passes no EVENT_CONFIG_B64 build arg" {
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  # A regression here is silent otherwise: an image built with a stray
  # EVENT_CONFIG_B64 would just be an image with an ignored build arg, not an
  # obvious failure. Assert its absence by name.
  [ -z "$(echo "$output" | grep -F 'EVENT_CONFIG_B64')" ]
}

@test "the tag no longer depends on any config, only the revision" {
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  first="$(echo "$output" | sed -n 's/.*app_image = "\(.*\)".*/\1/p' | tail -1)"
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  second="$(echo "$output" | sed -n 's/.*app_image = "\(.*\)".*/\1/p' | tail -1)"
  # Idempotence: the same inputs (there is only the revision now) must produce
  # the same tag, or "ECR already has it, skipping" could never fire and every
  # deploy would rebuild.
  [ -n "$first" ] && [ "$first" = "$second" ]
}

# A throwaway repository, so the dirty-tree tests can dirty a build-context
# file without touching the checkout the suite is running in. deploy.sh derives
# its ROOT from its own location, so the copy has to sit at the same depth.
fake_repo() {
  local repo="$BATS_TEST_TMPDIR/${1:-repo}"
  mkdir -p "$repo/deploy/aws-terraform" "$repo/apps/web"
  cp "$SCRIPT" "$repo/deploy/aws-terraform/deploy.sh"
  printf 'FROM scratch\n' > "$repo/apps/web/Dockerfile"
  git -C "$repo" init -q
  git -C "$repo" config user.email bats@example.invalid
  git -C "$repo" config user.name bats
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" add apps deploy
  git -C "$repo" commit -qm init --no-gpg-sign
  echo "$repo"
}

# The tag the dry run would hand Terraform.
dry_run_tag() {
  "$1/deploy/aws-terraform/deploy.sh" --dry-run |
    sed -n 's/.*app_image = "\(.*\)".*/\1/p' | tail -1
}

@test "two different dirty apps/web trees do not get the same tag" {
  # The regression: a bare "<rev>-dirty" names every uncommitted state of a
  # commit at once. ECR here is IMMUTABLE, so the second dirty deploy finds the
  # tag already present, skips the build, and ships the FIRST tree's image.
  repo="$(fake_repo)"
  printf 'FROM scratch\nRUN echo one\n' > "$repo/apps/web/Dockerfile"
  first="$(dry_run_tag "$repo")"
  printf 'FROM scratch\nRUN echo two\n' > "$repo/apps/web/Dockerfile"
  second="$(dry_run_tag "$repo")"
  [ -n "$first" ] && [ -n "$second" ] && [ "$first" != "$second" ]
}

@test "an untracked apps/web file changes the tag, and an unchanged tree does not" {
  # Untracked files are build context too: `docker build apps/web` sends them.
  # And the digest has to be reproducible, or "ECR already has it" could never
  # fire and every deploy of an unchanged tree would rebuild.
  repo="$(fake_repo)"
  printf 'export const x = 1\n' > "$repo/apps/web/new-file.ts"
  first="$(dry_run_tag "$repo")"
  again="$(dry_run_tag "$repo")"
  printf 'export const x = 2\n' > "$repo/apps/web/new-file.ts"
  changed="$(dry_run_tag "$repo")"
  [ -n "$first" ] && [ "$first" = "$again" ] && [ "$first" != "$changed" ]
}

@test "one file's contents cannot impersonate a second file's record" {
  # The framing bug, as a tree. Streamed unframed — pathname, then raw bytes —
  # a SINGLE file whose content reads like the next record's header serializes
  # byte-for-byte like TWO files:
  #
  #   a = "untracked:apps/web/b\npayload"   ->  untracked:apps/web/a
  #                                             untracked:apps/web/b
  #                                             payload
  #   a = "" and b = "payload"              ->  (the same three lines)
  #
  # Both trees would take one tag, and on an immutable registry the second
  # deploy would ship the first tree's image. One repo, so HEAD — and therefore
  # the tag's revision half — is identical and only the digest can differ.
  repo="$(fake_repo)"
  printf 'untracked:apps/web/b\npayload' > "$repo/apps/web/a"
  first="$(dry_run_tag "$repo")"
  : > "$repo/apps/web/a"
  printf 'payload' > "$repo/apps/web/b"
  second="$(dry_run_tag "$repo")"
  [ -n "$first" ] && [ -n "$second" ] && [ "$first" != "$second" ]
}

@test "retargeting a dangling symlink changes the tag" {
  # `docker build` sends a symlink as its TARGET STRING, so two different
  # targets are two different build contexts. Hashing anything that is not a
  # regular file as a constant lost that: the link changed, the tag did not.
  repo="$(fake_repo)"
  ln -s target-a "$repo/apps/web/link"
  first="$(dry_run_tag "$repo")"
  rm "$repo/apps/web/link"
  ln -s target-b "$repo/apps/web/link"
  second="$(dry_run_tag "$repo")"
  [ -n "$first" ] && [ -n "$second" ] && [ "$first" != "$second" ]
}

@test "a build-context path containing a newline is still hashed by content" {
  # Read line-at-a-time, git QUOTES this pathname ("apps/web/na\nme"); the
  # quoted string matches nothing on disk, so every edit to the file hashed as
  # the same not-a-file record and the tag never moved. `-z` plus `read -d ''`
  # is the fix, and a literal newline in the name is the only way to test it.
  repo="$(fake_repo)"
  nl_path="$repo/apps/web/na
me"
  printf 'one\n' > "$nl_path"
  first="$(dry_run_tag "$repo")"
  printf 'two\n' > "$nl_path"
  second="$(dry_run_tag "$repo")"
  [ -n "$first" ] && [ -n "$second" ] && [ "$first" != "$second" ]
}

@test "a dirty apps/web tree is tagged apart from the clean commit" {
  repo="$(fake_repo)"
  clean="$(dry_run_tag "$repo")"
  printf 'FROM scratch\nRUN echo dirty\n' > "$repo/apps/web/Dockerfile"
  dirty="$(dry_run_tag "$repo")"
  # Named rather than implied: a dirty image must never be mistaken for the
  # commit's, and the digest must not silently replace the marker.
  [ -n "$clean" ] && [ "$clean" != "$dirty" ] && echo "$dirty" | grep -q -- '-dirty-[0-9a-f]\{8\}$'
}

@test "an empty terraform output is refused rather than used" {
  # `terraform output` can exit 0 and hand back nothing. Taken as valid it
  # builds a tag like ":abc123" and pushes it nowhere in particular — the
  # failure then surfaces as a confusing docker error instead of the missing
  # stack it actually is. The stubs above exit 0 with empty stdout, which is
  # exactly that case.
  run "$SCRIPT"
  [ "$status" -ne 0 ]
  echo "$output" | grep -q 'ecr_app_repository_url'
}

@test "the dry-run registry placeholder cannot be mistaken for a real one" {
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  # A preview that printed a plausible account id would be worse than one that
  # obviously did not consult the stack.
  echo "$output" | grep -q '<account>\.dkr\.ecr\.<region>\.amazonaws\.com'
}

@test "an unknown argument is refused instead of ignored" {
  run "$SCRIPT" --destroy-everything
  [ "$status" -eq 2 ]
  echo "$output" | grep -q 'unknown argument'
}

@test "the build passes the /health build args" {
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  # Without these the deployed box reports revision "unknown" from /health and
  # "did my fix reach it?" has no answer — the gap #327 and #328 closed for the
  # Fly path. Assert both, since passing one and dropping the other still
  # leaves the endpoint half-blind.
  echo "$output" | grep -q 'APP_BUILD_REV=' && echo "$output" | grep -q 'APP_BUILT_AT='
}

# --- a real (stubbed) run: platform, context, and the sync/scorer images ----
#
# #476. The tests above are all --dry-run, which is how the app build's broken
# context (`apps/web` where apps/web/Dockerfile needs the repo root) shipped:
# nothing ever looked at a build invocation that would have run. These stubs
# answer like an applied stack, so deploy.sh takes its real path — and every
# docker/aws/terraform call is still a recorded no-op. They run against
# fake_repo, so the image.auto.tfvars they write lands in a throwaway tree.

ACCT_REGISTRY="123456789012.dkr.ecr.us-east-1.amazonaws.com"
SOURCE_DIGEST="aaaaaaaaaaaabbbbbbbbbbbbccccccccccccddddddddddddeeeeeeeeeeeeffff"

# $1 = 1 for a Secure Development stack, 0 for quiz-only.
# $2 = "fail-sync-output" to make that one terraform read fail.
applied_stack_stubs() {
  local secdev="$1"
  local mode="${2:-}"
  cat > "$STUBS/terraform" <<EOF
#!/bin/sh
echo "terraform \$*" >> "$CALLS"
case "\$*" in
*ecr_app_repository_url*) printf '%s' "$ACCT_REGISTRY/owasp-ctf-app" ;;
*ecr_sync_repository_url*)
  if [ "$mode" = "fail-sync-output" ]; then exit 1; fi
  if [ "$secdev" = "1" ]; then printf '%s' "$ACCT_REGISTRY/owasp-ctf-sync"; fi ;;
*ecr_scorer_repository_url*)
  if [ "$secdev" = "1" ]; then printf '%s' "$ACCT_REGISTRY/owasp-ctf-scorer"; fi ;;
esac
exit 0
EOF
  # describe-images fails: no tag is in ECR yet, so everything is published.
  cat > "$STUBS/aws" <<EOF
#!/bin/sh
echo "aws \$*" >> "$CALLS"
case "\$*" in
*describe-images*) exit 1 ;;
*get-login-password*) echo stub-password ;;
esac
exit 0
EOF
  cat > "$STUBS/docker" <<EOF
#!/bin/sh
echo "docker \$*" >> "$CALLS"
case "\$1" in
login) cat > /dev/null ;;
image) echo "ghcr.io/owasp-ctf-test/score@sha256:$SOURCE_DIGEST" ;;
esac
exit 0
EOF
  chmod +x "$STUBS/terraform" "$STUBS/aws" "$STUBS/docker"
}

@test "the app build targets linux/amd64 with no attestation manifests" {
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  # Fargate runs X86_64 (stack.tftest.hcl asserts that half); an Apple Silicon
  # build without --platform is arm64 and dies with an exec format error.
  echo "$output" | grep 'docker build' | grep 'apps/web/Dockerfile' |
    grep -F -- '--platform linux/amd64 --provenance=false --sbom=false' | grep -q .
}

@test "the app is built from the repo root with apps/web/Dockerfile" {
  repo="$(fake_repo)"
  applied_stack_stubs 0
  run "$repo/deploy/aws-terraform/deploy.sh"
  [ "$status" -eq 0 ]
  build="$(grep '^docker build' "$CALLS" | grep -F -- "--file $repo/apps/web/Dockerfile")"
  echo "build call: $build"
  # The Dockerfile does `COPY apps/web/ ./`, which resolves only from the root:
  # with apps/web as the context the build died with `"/apps/web": not found`.
  # The context is the LAST argument, so it must be the repo root itself.
  [ -n "$build" ] && [ "${build##* }" = "$repo" ]
}

@test "a Secure Development stack builds sync, mirrors the scorer and pushes both" {
  repo="$(fake_repo)"
  applied_stack_stubs 1
  run "$repo/deploy/aws-terraform/deploy.sh" --scorer-source ghcr.io/owasp-ctf-test/score:latest
  echo "$output"
  [ "$status" -eq 0 ]
  sync_tag="$(grep '^docker build' "$CALLS" | grep -F -- "--file $repo/sync/Dockerfile" |
    grep -F -- '--platform linux/amd64 --provenance=false --sbom=false' |
    sed -n "s|.*--tag $ACCT_REGISTRY/owasp-ctf-sync:\([^ ]*\) .*|\1|p")"
  scorer_ref="$ACCT_REGISTRY/owasp-ctf-scorer:mirror-${SOURCE_DIGEST:0:12}"
  echo "sync tag: '$sync_tag'"
  cat "$CALLS"
  [ -n "$sync_tag" ] &&
    grep -qx "docker pull --platform linux/amd64 ghcr.io/owasp-ctf-test/score:latest" "$CALLS" &&
    grep -qx "docker tag ghcr.io/owasp-ctf-test/score:latest $scorer_ref" "$CALLS" &&
    grep -qx "docker push $ACCT_REGISTRY/owasp-ctf-sync:$sync_tag" "$CALLS" &&
    grep -qx "docker push $scorer_ref" "$CALLS"
}

@test "a Secure Development deploy writes all three refs into image.auto.tfvars" {
  repo="$(fake_repo)"
  applied_stack_stubs 1
  run "$repo/deploy/aws-terraform/deploy.sh" --scorer-source ghcr.io/owasp-ctf-test/score:latest
  [ "$status" -eq 0 ]
  vars="$repo/deploy/aws-terraform/image.auto.tfvars"
  cat "$vars"
  grep -q "^app_image = \"$ACCT_REGISTRY/owasp-ctf-app:[^\"]*\"$" "$vars" &&
    grep -q "^sync_image = \"$ACCT_REGISTRY/owasp-ctf-sync:[^\"]*\"$" "$vars" &&
    grep -qx "scorer_image = \"$ACCT_REGISTRY/owasp-ctf-scorer:mirror-${SOURCE_DIGEST:0:12}\"" "$vars"
}

@test "SCORE_IMAGE from the event .env is the default scorer source" {
  repo="$(fake_repo)"
  applied_stack_stubs 1
  SCORE_IMAGE=ghcr.io/owasp-ctf-test/score:v9 run "$repo/deploy/aws-terraform/deploy.sh"
  [ "$status" -eq 0 ]
  grep -qx "docker pull --platform linux/amd64 ghcr.io/owasp-ctf-test/score:v9" "$CALLS"
}

@test "a Secure Development stack with no scorer source is refused before any build" {
  repo="$(fake_repo)"
  applied_stack_stubs 1
  SCORE_IMAGE="" run "$repo/deploy/aws-terraform/deploy.sh"
  echo "$output"
  [ "$status" -ne 0 ]
  [ -z "$(grep '^docker build' "$CALLS")" ]
  echo "$output" | grep -q -- '--scorer-source'
}

@test "a quiz-only stack publishes the app alone and writes only app_image" {
  repo="$(fake_repo)"
  applied_stack_stubs 0
  SCORE_IMAGE="" run "$repo/deploy/aws-terraform/deploy.sh"
  [ "$status" -eq 0 ]
  vars="$repo/deploy/aws-terraform/image.auto.tfvars"
  cat "$vars"
  [ -z "$(grep -E '^docker (pull|tag)' "$CALLS")" ]
  [ -z "$(grep -E '^(sync|scorer)_image' "$vars")" ]
  grep -q '^app_image = ' "$vars"
}

@test "a failed read of the sync repository output is refused, not taken as quiz-only" {
  # Fail-closed: read as "Secure Development is off", this would write an
  # image.auto.tfvars with no scorer or sync image.
  repo="$(fake_repo)"
  applied_stack_stubs 1 fail-sync-output
  run "$repo/deploy/aws-terraform/deploy.sh" --scorer-source ghcr.io/owasp-ctf-test/score:latest
  [ "$status" -ne 0 ]
  [ ! -f "$repo/deploy/aws-terraform/image.auto.tfvars" ]
  echo "$output" | grep -q 'ecr_sync_repository_url'
}

@test "--dry-run with a scorer source still makes no docker, aws or terraform call" {
  run "$SCRIPT" --dry-run --scorer-source ghcr.io/owasp-ctf-test/score:latest
  [ "$status" -eq 0 ]
  echo "$output" | grep -q 'docker pull --platform linux/amd64 ghcr.io/owasp-ctf-test/score:latest'
  [ ! -s "$CALLS" ]
}
