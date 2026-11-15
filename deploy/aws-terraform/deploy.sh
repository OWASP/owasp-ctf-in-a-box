#!/usr/bin/env bash
#
# Publish every image this stack runs into its own ECR repositories, and hand
# Terraform the refs:
#
#   app     built from this checkout (repo-root context, apps/web/Dockerfile)
#   sync    built from ./sync                        — Secure Development only
#   scorer  MIRRORED from the event org's package    — Secure Development only
#
# All three for linux/amd64, which is what Fargate runs here (#476). Fargate
# can pull none of the kit's images from anywhere else: sync is published
# nowhere, and the scorer package is private by contract.
#
# Terraform cannot build an image, so a deploy is always two steps: this
# script builds and pushes; `terraform apply` (or `--apply` below) rolls it
# out. Config v2 (#386) removed the app's build-time config entirely — it
# reads GITHUB_ORG from its environment and ADMIN_CLAIM_CODE_HASH from SSM at
# runtime (ecs.tf's app container definition), so this script has nothing
# left to bake and no file to require.
#
# It also sets the admin claim code (ADR 72). Terraform owns the parameter
# <ssm_prefix>/ADMIN_CLAIM_CODE_HASH (an SSM SecureString holding a
# placeholder the app reads as unset); this script writes the real hash into
# it once the stack exists — when it still holds the placeholder, or under
# --new-admin-code. The code is printed once and never sent to AWS.
#
# Every tag is CONTENT-ADDRESSED: the app and sync to the revision that built
# them, the scorer to its source's registry digest. ECR here is `IMMUTABLE`
# (registry.tf says why), so re-pushing a tag is an error rather than an
# overwrite — and with a content-addressed tag that error only ever means
# "nothing changed", which this script reports and skips instead of failing.
# Same input, same tag, every time.
#
# The refs reach Terraform through `image.auto.tfvars`, which Terraform loads
# on its own and .gitignore excludes. `terraform.tfvars` stays yours: this
# script never edits it.
#
# --dry-run prints every docker/aws/terraform command and runs NONE of them,
# with secret values redacted — deploy/fly/deploy.sh printed them in full once,
# into whatever log or screen share happened to be capturing it.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

DRY_RUN=""
SKIP_BUILD=""
APPLY=""
NEW_ADMIN_CODE=""
# SCORE_IMAGE is the one name this kit has for "the scorer image".
# --scorer-source overrides the shell; an unset or empty shell value falls back to
# the repo-root .env only when the stack needs a scorer.
SCORER_SOURCE="${SCORE_IMAGE:-}"

usage() {
  cat <<'EOT'
usage: deploy/aws-terraform/deploy.sh [--dry-run] [--skip-build] [--apply]
                                      [--scorer-source <image>] [--new-admin-code]

Builds the app (and, on a Secure Development stack, sync) for linux/amd64,
mirrors the scorer, pushes all of them to the ECR repositories this module
created, and writes the resulting refs to image.auto.tfvars.

--scorer-source  the scorer image to mirror, e.g.
                 ghcr.io/<your-event-org>/score:latest. Defaults to exported
                 non-empty SCORE_IMAGE, then SCORE_IMAGE in the repo-root
                 .env when unset or empty. Required when the stack runs Secure
                 Development; ignored otherwise. The package is private: log
                 docker in to its registry first.
--apply          also runs `terraform apply` once the images are pushed.
                 Without it the script stops after writing image.auto.tfvars
                 and prints the command to run.
--skip-build     reuses the app and sync images already in ECR for this
                 revision. Refused when a tag is not there yet — there would be
                 nothing to deploy. The scorer is still pulled: its tag comes
                 from the source's digest.
--new-admin-code writes a new admin claim code's hash to SSM
                 (<ssm_prefix>/ADMIN_CLAIM_CODE_HASH), prints the code once,
                 and forces a new app deployment so the running task reads it.
                 The lock-out recovery path; combine with --skip-build. Without
                 it the hash is created only when the parameter is absent.
--dry-run        prints every command and makes none of them. Secrets redacted.

Requires the bootstrap apply (docs/aws.md): the ECR URLs and region come from
`terraform output`, so the script never duplicates configuration that already
lives in state.
EOT
}

while [ $# -gt 0 ]; do
  case "$1" in
  --dry-run)
    DRY_RUN=1
    shift
    ;;
  --skip-build)
    SKIP_BUILD=1
    shift
    ;;
  --apply)
    APPLY=1
    shift
    ;;
  --new-admin-code)
    NEW_ADMIN_CODE=1
    shift
    ;;
  --scorer-source)
    if [ $# -lt 2 ] || [ -z "$2" ]; then
      echo "--scorer-source needs an image reference" >&2
      exit 2
    fi
    SCORER_SOURCE="$2"
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "unknown argument: $1" >&2
    usage >&2
    exit 2
    ;;
  esac
done

# External calls go through `run` or stay in the non-dry-run branch below.
# Anything that looks like a secret is redacted in the printed form: a dry run
# exists to be pasted into a terminal or a review. The rules live in
# scripts/lib/redact.sh, shared with deploy/fly/deploy.sh so the two deploy
# paths cannot disagree about what a secret looks like.
# shellcheck source=scripts/lib/redact.sh
. "$ROOT/scripts/lib/redact.sh"
# shellcheck source=scripts/lib/dotenv.sh
. "$ROOT/scripts/lib/dotenv.sh"
# shellcheck source=scripts/lib/claim-code.sh
. "$ROOT/scripts/lib/claim-code.sh"

run() {
  if [ -n "$DRY_RUN" ]; then
    echo "   DRY-RUN: $(redact_args "$@")"
    return 0
  fi
  "$@"
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "FAIL: $1 is not installed, and this script needs it to $2." >&2
    exit 1
  fi
}

need docker "build, mirror and push the images"
need aws "log in to ECR and read the stack's outputs"
need terraform "read the stack's outputs"

# Content address: the revision that built it. Two images from one commit are
# identical now that the app takes no build-time config, so the revision alone
# names the image.
#
# A DIRTY context (apps/web for the app, sync/ for sync) needs more than a
# "-dirty" marker. These ECR repositories are IMMUTABLE, so the "is that tag
# already there?" lookup below skips the build whenever the tag exists — and a
# bare `<rev>-dirty` names every uncommitted state of that commit at once. The
# second dirty deploy would then ship the FIRST one's image, silently. So the
# tag carries a short digest of the build context's changes: the tracked diff
# under that directory plus every untracked file in it. Same working tree,
# same digest; a changed one gets its own tag.
#
# The digest input is FRAMED, which is the whole of its correctness. Streaming
# a pathname and then its raw bytes is ambiguous: one file whose content reads
# like the next record's header serializes exactly like two files, and the two
# trees would share a tag. So nothing variable-length is ever concatenated —
# every record is fixed-shape fields (a hex hash, a kind, or a pathname, none
# of which can contain one) separated by NUL, which cannot occur in any.
context_digest() {
  local dir="$1"
  {
    # The tracked diff enters as ONE field: its own hash, not its bytes.
    printf 'diff\0%s\0' \
      "$(git -C "$ROOT" diff HEAD -- "$dir" | git -C "$ROOT" hash-object --stdin)"
    # `-z` + `read -d ''`, not line-at-a-time: without it git QUOTES a pathname
    # containing a newline ("apps/web/na\nme"), the quoted string matches
    # nothing on disk, and every later edit to that file hashes as the same
    # not-a-file record. NUL is the one byte a pathname cannot hold, so it is
    # the only safe delimiter — and `-z` suppresses the quoting outright,
    # which is why core.quotePath is no longer set here.
    #
    # node_modules/ and .next/ are gitignored, so --exclude-standard already
    # drops them; naming them too keeps the context stable for anyone whose
    # local ignore rules differ, and they are build OUTPUT, not build input.
    git -C "$ROOT" ls-files -z --others --exclude-standard -- "$dir" |
      while IFS= read -r -d '' rel; do
        case "$rel" in
        "$dir"/node_modules/* | "$dir"/.next/*) continue ;;
        esac
        # The path AND the kind AND the content: an identical file added under
        # a different name is a different build context, and so is a path that
        # stopped being a regular file without changing its bytes.
        #
        # -L before -f, because -f follows the link: a symlink is hashed by its
        # TARGET STRING, which is what `docker build` puts in the context and
        # what the old `-` lost — retargeting a dangling link changed the build
        # and not the tag. `other` (a fifo, a socket) keeps the record shape
        # with nothing to hash.
        if [ -L "$ROOT/$rel" ]; then
          kind="symlink"
          hash="$(readlink "$ROOT/$rel" | git -C "$ROOT" hash-object --stdin)"
        elif [ -f "$ROOT/$rel" ]; then
          kind="file"
          hash="$(git -C "$ROOT" hash-object --no-filters -- "$ROOT/$rel")"
        else
          kind="other"
          hash="-"
        fi
        printf 'untracked\0%s\0%s\0%s\0' "$rel" "$kind" "$hash"
      done
  } | git -C "$ROOT" hash-object --stdin
}

# The content-addressed tag for a build context directory (relative to ROOT):
# the revision, plus a digest of the uncommitted changes when that directory is
# dirty. Scoped per directory, for the reason deploy/fly/deploy.sh gives: an
# image built from `sync/` is not described by dirt in `apps/web/`, and a
# dirty context gets its own tag so it is never mistaken for the commit.
revision_tag() {
  local dir="$1"
  local rev=""
  local digest=""
  if rev="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null)"; then
    if [ -n "$(git -C "$ROOT" status --porcelain -- "$dir" 2>/dev/null)" ]; then
      digest="$(context_digest "$dir")"
      rev="${rev}-dirty-${digest:0:8}"
    fi
  else
    rev="nogit"
  fi
  echo "$rev"
}

REV="$(revision_tag apps/web)"
TAG="$REV"
SYNC_TAG="$(revision_tag sync)"

# --- where it goes -----------------------------------------------------------
#
# From state, not from a second copy of the same settings. A wrapper that asked
# for region and repository again would be one more thing to keep in step.
# --dry-run reads nothing either: the point of a preview is to work BEFORE the
# stack exists, and "makes none of them" is a property worth being able to test
# rather than approximately true. So the placeholder is obviously a placeholder
# — a preview that printed a plausible-looking account id would be worse than
# one that cannot be mistaken for the real thing.
#
# The sync and scorer repositories exist exactly when the stack runs Secure
# Development (registry.tf), and their outputs are "" otherwise — which is how
# this script learns whether to publish them without a flag of its own. A dry
# run cannot ask, so it previews the module default: Secure Development on.
if [ -n "$DRY_RUN" ]; then
  PLACEHOLDER_REGISTRY="<account>.dkr.ecr.<region>.amazonaws.com/${TF_NAME:-owasp-ctf}"
  REPO_URL="${PLACEHOLDER_REGISTRY}-app"
  SYNC_REPO_URL="${PLACEHOLDER_REGISTRY}-sync"
  SCORER_REPO_URL="${PLACEHOLDER_REGISTRY}-scorer"
  echo "   (dry run: the real registry comes from terraform output; Secure Development assumed on)"
else
  # Fail closed: an unavailable credential check stops deployment before reading Terraform state.
  if ! aws sts get-caller-identity >/dev/null; then
    echo "FAIL: AWS credential check failed." >&2
    echo "      If your SSO session expired, run aws sso login --profile <profile>." >&2
    exit 1
  fi
  if ! REPO_URL="$(terraform -chdir="$HERE" output -raw ecr_app_repository_url 2>/dev/null)" ||
    [ -z "$REPO_URL" ]; then
    # Emptiness is checked separately from the exit status. `terraform output`
    # can succeed and hand back nothing, and an empty repository URL would
    # build a tag like ":abc123" and push it nowhere in particular — the
    # failure would surface as a confusing docker error rather than as the
    # missing stack it is.
    echo "FAIL: could not read a non-empty 'ecr_app_repository_url' from" >&2
    echo "      terraform output. This script deploys INTO an applied stack:" >&2
    echo "      run the bootstrap apply in deploy/aws-terraform first (docs/aws.md)," >&2
    echo "      then re-run." >&2
    exit 1
  fi
  # A failed read is NOT "Secure Development is off". Failing open here would
  # write an image.auto.tfvars with no scorer or sync image, and the next
  # apply would be refused by the variables' own validation at best.
  if ! SYNC_REPO_URL="$(terraform -chdir="$HERE" output -raw ecr_sync_repository_url 2>/dev/null)" ||
    ! SCORER_REPO_URL="$(terraform -chdir="$HERE" output -raw ecr_scorer_repository_url 2>/dev/null)"; then
    echo "FAIL: could not read 'ecr_sync_repository_url' / 'ecr_scorer_repository_url'" >&2
    echo "      from terraform output. Re-run the bootstrap apply (docs/aws.md): a" >&2
    echo "      stack applied before #476 has no sync or scorer repository yet." >&2
    exit 1
  fi
  if { [ -n "$SYNC_REPO_URL" ] || [ -n "$SCORER_REPO_URL" ]; } &&
    { [ -z "$SYNC_REPO_URL" ] || [ -z "$SCORER_REPO_URL" ]; }; then
    echo "FAIL: terraform output names only one of the sync and scorer repositories." >&2
    echo "      registry.tf creates both or neither; re-run the bootstrap apply." >&2
    exit 1
  fi
fi

SECDEV=""
if [ -n "$SCORER_REPO_URL" ]; then
  SECDEV=1
fi

# Terraform owns module availability; a quiz-only deploy ignores scorer config.
if [ -n "$SECDEV" ] && [ -z "$SCORER_SOURCE" ]; then
  SCORER_SOURCE="$(dotenv_get "$ROOT/.env" SCORE_IMAGE)" || exit 1
fi

if [ -n "$SECDEV" ] && [ -z "$SCORER_SOURCE" ]; then
  if [ -n "$DRY_RUN" ]; then
    SCORER_SOURCE="<scorer-source>"
  else
    echo "FAIL: this stack runs Secure Development, so the scorer image has to be" >&2
    echo "      mirrored into its ECR repository, and nothing names the source." >&2
    echo "      Pass --scorer-source <image>, export SCORE_IMAGE, or set it in" >&2
    echo "      the repo-root .env (an unset or empty export falls back to it), e.g." >&2
    echo "      ghcr.io/<your-event-org>/score:latest. Log docker in to that" >&2
    echo "      registry first: the package is private." >&2
    exit 1
  fi
fi

REGION="${REPO_URL#*.dkr.ecr.}"
REGION="${REGION%%.amazonaws.com/*}"
REGISTRY="${REPO_URL%%/*}"
IMAGE="${REPO_URL}:${TAG}"
SYNC_IMAGE=""
if [ -n "$SECDEV" ]; then
  SYNC_IMAGE="${SYNC_REPO_URL}:${SYNC_TAG}"
fi

echo "=> app image  $IMAGE"
echo "   revision   $REV"
if [ -n "$SECDEV" ]; then
  echo "=> sync image $SYNC_IMAGE"
  echo "=> scorer     mirrored from $SCORER_SOURCE"
fi

# --- helpers -----------------------------------------------------------------

# `--query`/`--output text` rather than jq: AGENTS.md keeps jq off the
# provisioning path, and this is the aws CLI's own filtering, the same way
# `gh api --jq` is the gh CLI's. A dry run never asks, so it previews the
# build.
# Returns 0 when the tag is in ECR and 1 when ECR says it is not
# (ImageNotFoundException). Any OTHER failure — access denied, a throttle, no
# network, a missing repository — is an unknown registry state: it stops the
# deploy rather than being read as "absent" and rebuilding or re-pushing over
# it (fail closed; #507 review).
in_ecr() {
  local repo_url="$1"
  local tag="$2"
  local err
  if [ -n "$DRY_RUN" ]; then
    return 1
  fi
  if err="$(aws ecr describe-images --region "$REGION" \
    --repository-name "${repo_url##*/}" \
    --image-ids "imageTag=$tag" \
    --query 'imageDetails[0].imageDigest' --output text 2>&1 >/dev/null)"; then
    return 0
  fi
  case "$err" in
    *ImageNotFoundException*) return 1 ;;
  esac
  echo "FAIL: could not read ECR for ${repo_url##*/}:$tag — refusing to guess whether it is there:" >&2
  echo "      $err" >&2
  exit 1
}

# Once per run, and only when something is actually pushed.
LOGGED_IN=""
ecr_login() {
  if [ -n "$LOGGED_IN" ]; then
    return 0
  fi
  # Piped into docker login, never passed as an argument: a --password on a
  # command line is readable by every other process on the host.
  if [ -n "$DRY_RUN" ]; then
    echo "   DRY-RUN: aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REGISTRY"
  else
    aws ecr get-login-password --region "$REGION" |
      docker login --username AWS --password-stdin "$REGISTRY"
  fi
  LOGGED_IN=1
}

# Build one image from this checkout and push it, unless ECR already holds its
# tag.
#
# --platform linux/amd64 is not optional. Fargate runs X86_64 (ecs.tf sets
# runtime_platform on every task definition and stack.tftest.hcl asserts it),
# and an image built on an Apple Silicon laptop without it is arm64: the task
# dies with an exec format error, or the pull finds no matching platform, after
# a successful-looking deploy (#476). --provenance=false --sbom=false keep the
# push to ONE plain manifest, the same as deploy/fly/deploy.sh, so the tag names
# exactly the image that runs.
# The pulled image's RepoDigests entry for the SOURCE repository, not entry 0:
# after the first push the local image also carries an ECR digest (#507
# review), and a --platform pull+push makes a different manifest there. The
# entry must START with the repository (a prefix match, not a substring, so a
# mirror whose name ends in it does not count), and the tag is dropped only
# when the last path component has one — with no tag, the last colon is a
# registry port's.
source_repo_digest() {
  local source="$1" repo digests entry
  repo="$source"
  case "${repo##*/}" in
  *:*) repo="${repo%:*}" ;;
  esac
  digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$source" 2>/dev/null)" || return 1
  while IFS= read -r entry; do
    case "$entry" in
    "$repo@sha256:"*)
      printf '%s\n' "$entry"
      return 0
      ;;
    esac
  done <<EOF
$digests
EOF
  return 1
}

publish_build() {
  local label="$1"
  local image="$2"
  local tag="$3"
  shift 3
  if in_ecr "${image%:*}" "$tag"; then
    echo "   ECR already has $label $tag — same revision. Skipping build."
    return 0
  fi
  if [ -n "$SKIP_BUILD" ]; then
    if [ -n "$DRY_RUN" ]; then
      echo "   --skip-build: assuming $label $tag is present"
      return 0
    fi
    echo "FAIL: --skip-build, but $label $tag is not in ECR yet — nothing to deploy." >&2
    echo "      That tag is derived from this revision, so the image for it has" >&2
    echo "      never been built. Drop --skip-build." >&2
    exit 1
  fi
  echo "=> building $label"
  run docker build --platform linux/amd64 --provenance=false --sbom=false --tag "$image" "$@"
  echo "=> pushing $label"
  ecr_login
  run docker push "$image"
}

# --- app ---------------------------------------------------------------------
#
# The build context is the REPO ROOT, not apps/web: apps/web/Dockerfile says
# so on its first line and does `COPY apps/web/ ./`, which only resolves from
# the root — exactly how docker-compose.yml and deploy/fly/deploy.sh build it.
# With apps/web as the context the build died at that COPY with
# `"/apps/web": not found`, on every run since the module landed (#476); the
# dry-run-only tests never executed it. The TAG still digests apps/web alone
# (revision_tag above): the root context carries the rest of the repo, but
# the Dockerfile's one COPY means only apps/web reaches the image, and the
# root .dockerignore keeps node_modules, .next and .env out of the context.
publish_build app "$IMAGE" "$TAG" \
  --file "$ROOT/apps/web/Dockerfile" \
  --build-arg "APP_BUILD_REV=$REV" \
  --build-arg "APP_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$ROOT"

# --- sync and the scorer (Secure Development only) ---------------------------
#
# Fargate has nowhere else to pull them from (#476). sync is not published
# anywhere — compose builds it from ./sync — so it is built here like the app.
# The scorer is the event org's PRIVATE package (setup/ctf-setup.sh keeps it
# private until launch), and an anonymous Fargate pull of it is a
# CannotPullContainerError. So it is MIRRORED, not rebuilt: the leaderboard
# scorer must be the same artifact the forks' judge pulls, byte for byte.
#
# The mirror's tag is content-addressed to the SOURCE's digest, so a floating
# source tag (`:latest`) cannot swap the rubric under a running event: a new
# upstream push is a new tag, which only reaches ECS through a new
# image.auto.tfvars and an apply. It is pulled even under --skip-build, because
# the digest — and therefore the tag — is only known once it is.
SCORER_IMAGE=""
if [ -n "$SECDEV" ]; then
  publish_build sync "$SYNC_IMAGE" "$SYNC_TAG" \
    --file "$ROOT/sync/Dockerfile" \
    "$ROOT/sync"

  echo "=> mirroring the scorer"
  run docker pull --platform linux/amd64 "$SCORER_SOURCE"
  case "$SCORER_SOURCE" in
  *@sha256:*)
    SOURCE_DIGEST="${SCORER_SOURCE##*@sha256:}"
    ;;
  *)
    if [ -n "$DRY_RUN" ]; then
      SOURCE_DIGEST="<source-digest>"
    elif ! SOURCE_DIGEST="$(source_repo_digest "$SCORER_SOURCE")" ||
      [ -z "$SOURCE_DIGEST" ] || [ "${SOURCE_DIGEST#*@sha256:}" = "$SOURCE_DIGEST" ]; then
      echo "FAIL: pulled $SCORER_SOURCE but could not read its registry digest," >&2
      echo "      which the mirror's tag is derived from." >&2
      exit 1
    else
      SOURCE_DIGEST="${SOURCE_DIGEST##*@sha256:}"
    fi
    ;;
  esac
  if [ -n "$DRY_RUN" ] && [ "$SOURCE_DIGEST" = "<source-digest>" ]; then
    SCORER_TAG="mirror-<source-digest>"
  else
    SCORER_TAG="mirror-${SOURCE_DIGEST:0:12}"
  fi
  SCORER_IMAGE="${SCORER_REPO_URL}:${SCORER_TAG}"
  echo "   scorer image $SCORER_IMAGE"
  if in_ecr "$SCORER_REPO_URL" "$SCORER_TAG"; then
    echo "   ECR already has scorer $SCORER_TAG — same source digest. Skipping push."
  else
    run docker tag "$SCORER_SOURCE" "$SCORER_IMAGE"
    ecr_login
    run docker push "$SCORER_IMAGE"
  fi
fi

# --- hand it to Terraform ----------------------------------------------------
#
# A generated auto-loaded file, not an edit to terraform.tfvars. Terraform picks
# up *.auto.tfvars on its own (after terraform.tfvars, so these values win),
# .gitignore excludes it, and your own tfvars is never rewritten by a deploy.
VARS_FILE="$HERE/image.auto.tfvars"
VARS="app_image = \"$IMAGE\""
if [ -n "$SECDEV" ]; then
  VARS="$VARS
sync_image = \"$SYNC_IMAGE\"
scorer_image = \"$SCORER_IMAGE\""
fi
if [ -n "$DRY_RUN" ]; then
  echo "   DRY-RUN: write image.auto.tfvars with:"
  printf '%s\n' "$VARS" | sed 's/^/     /'
else
  {
    echo "# Written by deploy/aws-terraform/deploy.sh — do not edit by hand."
    echo "# Terraform loads *.auto.tfvars automatically; .gitignore excludes this file."
    printf '%s\n' "$VARS"
  } > "$VARS_FILE"
  echo "=> wrote image.auto.tfvars"
fi

if [ -n "$APPLY" ]; then
  echo "=> applying"
  run terraform -chdir="$HERE" apply -input=false
else
  echo
  echo "Images are in ECR and image.auto.tfvars names them. To roll them out:"
  echo "   terraform -chdir=deploy/aws-terraform apply"
fi

# --- the admin claim code (ADR 72) -------------------------------------------
#
# Last, after the images and any apply, because it needs the stack: the
# parameter and the app service are both Terraform's. Terraform creates the
# parameter holding a placeholder, so its VERSION says what is in it without a
# decrypting read: 1 is the placeholder (write the code), anything higher is a
# hash already written (leave it, unless --new-admin-code). A failed check
# stops here rather than being read as "placeholder", which would replace a
# live code nobody asked to rotate.
CLAIM_NEXT_STEP="./deploy/aws-terraform/deploy.sh --skip-build --new-admin-code"
claim_not_ready() {
  if [ -n "$NEW_ADMIN_CODE" ]; then
    echo "FAIL: $1, so there is nowhere to write the admin claim code yet." >&2
    echo "      Run terraform -chdir=deploy/aws-terraform apply, then: $CLAIM_NEXT_STEP" >&2
    exit 1
  fi
  echo
  echo "Admin claim code: not set yet — $1. After terraform apply, run:"
  echo "   $CLAIM_NEXT_STEP"
  echo "   It prints the code once; then sign in and enter it at /admin/claim."
}

if [ -n "$DRY_RUN" ]; then
  SSM_PREFIX="<ssm_prefix>"
  KMS_KEY="<secrets_kms_key_arn>"
  CLUSTER="<cluster_name>"
  CLAIM_URL="<event_url>"
  CLAIM_PARAM="$SSM_PREFIX/ADMIN_CLAIM_CODE_HASH"
  echo "=> admin claim code"
  if [ -n "$NEW_ADMIN_CODE" ]; then
    run aws ssm put-parameter --region "$REGION" --type SecureString --key-id "$KMS_KEY" \
      --name "$CLAIM_PARAM" --value "<new hash>" --overwrite
    run aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services app
    run aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service app --force-new-deployment
  else
    echo "   DRY-RUN: would read the version of $CLAIM_PARAM (metadata only) and write the code if it still holds Terraform's placeholder"
  fi
elif ! SSM_PREFIX="$(terraform -chdir="$HERE" output -raw ssm_prefix 2>/dev/null)" || [ -z "$SSM_PREFIX" ] ||
  ! KMS_KEY="$(terraform -chdir="$HERE" output -raw secrets_kms_key_arn 2>/dev/null)" || [ -z "$KMS_KEY" ] ||
  ! CLUSTER="$(terraform -chdir="$HERE" output -raw cluster_name 2>/dev/null)" || [ -z "$CLUSTER" ]; then
  claim_not_ready "the stack has not been applied since the claim-code parameter was added (no ssm_prefix, secrets_kms_key_arn or cluster_name output)"
else
  CLAIM_URL="$(terraform -chdir="$HERE" output -raw event_url 2>/dev/null)" || CLAIM_URL=""
  CLAIM_PARAM="$SSM_PREFIX/ADMIN_CLAIM_CODE_HASH"
  if ! claim_version="$(aws ssm describe-parameters --region "$REGION" \
    --parameter-filters "Key=Name,Values=$CLAIM_PARAM" \
    --query 'Parameters[0].Version' --output text)"; then
    claim_version="unreadable"
  fi
  write_claim=""
  case "$claim_version" in
  None | "") claim_not_ready "$CLAIM_PARAM does not exist (this stack was applied before it was added)" ;;
  1) write_claim=1 ;;
  *[!0-9]*)
    echo "FAIL: could not read the version of $CLAIM_PARAM (ADMIN_CLAIM_CODE_HASH);" >&2
    echo "      refusing to guess whether it holds a code. Check the region and your" >&2
    echo "      credentials, then re-run." >&2
    exit 1
    ;;
  *)
    if [ -n "$NEW_ADMIN_CODE" ]; then
      write_claim=1
    else
      echo "=> admin claim code: already set in $CLAIM_PARAM"
    fi
    ;;
  esac

  if [ -n "$write_claim" ]; then
    echo "=> admin claim code"
    claim_code="$(claim_code_new)" || exit 1
    claim_hash="$(claim_code_hash "$claim_code")" || exit 1
    if ! aws ssm put-parameter --region "$REGION" --type SecureString --key-id "$KMS_KEY" \
      --name "$CLAIM_PARAM" --value "$claim_hash" --overwrite >/dev/null; then
      echo "FAIL: could not write $CLAIM_PARAM. Nothing changed; the current code still works." >&2
      exit 1
    fi
    # ECS resolves a task's secrets only when the task starts, so the new hash
    # reaches a RUNNING app only through a new deployment. A service that does
    # not exist yet needs none: its first deployment reads the value. A failed
    # check is not "absent".
    roll_cmd="aws ecs update-service --region $REGION --cluster $CLUSTER --service app --force-new-deployment"
    # shellcheck disable=SC2016 # the backticks are a JMESPath literal, not a shell expansion
    if ! app_active="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services app \
      --query 'length(services[?status==`ACTIVE`])' --output text)"; then
      app_active="unreadable"
    fi
    case "$app_active" in
    0)
      claim_code_announce "$claim_code" "${CLAIM_URL:-https://<domain>}" "$CLAIM_NEXT_STEP"
      echo "   The app service does not exist yet; its first deployment reads this code."
      ;;
    *[!0-9]* | "")
      echo "FAIL: the new code is in $CLAIM_PARAM but not live yet: could not check" >&2
      echo "      the app service. Finish it with:" >&2
      echo "        $roll_cmd" >&2
      echo "      or re-run $CLAIM_NEXT_STEP for a fresh code." >&2
      exit 1
      ;;
    *)
      if ! aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service app --force-new-deployment >/dev/null; then
        echo "FAIL: the new code is in $CLAIM_PARAM but not live yet: the app could" >&2
        echo "      not be redeployed. Finish it with:" >&2
        echo "        $roll_cmd" >&2
        echo "      or re-run $CLAIM_NEXT_STEP for a fresh code." >&2
        exit 1
      fi
      claim_code_announce "$claim_code" "${CLAIM_URL:-https://<domain>}" "$CLAIM_NEXT_STEP"
      echo "   It is live once the new app deployment finishes (a minute or two)."
      ;;
    esac
  fi
fi
