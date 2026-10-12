# scripts/lib/dotenv.sh
# shellcheck shell=bash
# The ONE reader of an env file (`.env`, `.env.fly`, `.env.dev-stack`) for
# every shell entry point: setup/ctf-setup.sh, scripts/dev-stack,
# deploy/fly/deploy.sh and deploy/fly/render-compose.sh. Sourced, never
# executed — no shebang on purpose; the `shell=bash` directive above names
# the target shell for the linter.
#
# Why one reader: these scripts read the same file, and two readers that
# disagree about it disagree about the event itself. `SCORE_IMAGE=""` is empty
# to docker compose — no Secure Development — but a bare
# `sed -n "s/^KEY=//p"` hands back the two-character string `""` and calls
# Secure Development ON for an event whose box starts no scorer. The same
# reader misses `export KEY=`, `KEY = value` and `KEY: value` outright, and
# keeps the quotes on `GITHUB_ORG="myorg"`.
#
# The grammar is the subset of docker compose's own .env parser that a value
# here can reach, checked against `docker compose config` on a throwaway file
# rather than guessed, because the box runs compose and its reading is the one
# that decides which containers exist:
#
#   - CRLF line endings are read as LF.
#   - A line whose first non-blank character is `#` is a comment.
#   - A leading `export ` is ignored.
#   - `KEY=value`, `KEY = value` and `KEY: value` are all one assignment.
#   - The value is trimmed at both ends.
#   - Double- or single-quoted: the value is what is between the quotes, and a
#     `#` inside them is data. Anything after the closing quote is ignored.
#     Escapes inside double quotes are NOT interpreted (compose does; no key
#     this kit reads needs them).
#   - Unquoted: a comment starts at the first ` #` (a SPACE, then `#`). A tab
#     before the `#` does not start one, and neither does a `#` at the very
#     start of the value — so `SCORE_IMAGE= # none` is the value `# none` to
#     compose, and therefore here too.
#   - The LAST assignment of a key wins.
#   - An absent key, or an absent file, reads as empty.
#
# The shared corpus that pins all of this is test/fixtures/dotenv-corpus.env,
# run by scripts/test/dotenv.bats.
#
# bash 3.2 (macOS) compatible, BSD and GNU userlands, no jq or python.

# dotenv_value <raw> — one value with compose's semantics. <raw> is everything
# after the `=` (or `:`), untrimmed.
dotenv_value() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  case "$v" in
  '"'*)
    v="${v#\"}"
    v="${v%%\"*}"
    ;;
  "'"*)
    v="${v#\'}"
    v="${v%%\'*}"
    ;;
  *)
    v="${v%% #*}"
    v="${v%"${v##*[![:space:]]}"}"
    ;;
  esac
  printf '%s' "$v"
}

# dotenv_key_ere <key> — an ERE matching any line that assigns <key>, in every
# form dotenv_get reads. For "is there a line for this key at all?" questions:
# a presence test narrower than the reader is how a key ends up assigned twice.
dotenv_key_ere() {
  printf '^[[:space:]]*(export[[:space:]]+)?%s[[:space:]]*[:=]' "$1"
}

# dotenv_get <file> <key> — the value compose would read, or empty. Never
# fails: a missing file is "not set" to every caller, and under `set -euo
# pipefail` a reader that exits nonzero takes the calling script down with it.
dotenv_get() {
  local file="$1" key="$2" raw
  [ -f "$file" ] || return 0
  raw="$(tr -d '\r' <"$file" | sed -n \
    -e "s/^[[:space:]]*export[[:space:]]\{1,\}//" \
    -e "s/^[[:space:]]*${key}[[:space:]]*[:=]//p" | tail -1)" || raw=""
  dotenv_value "$raw"
}

# dotenv_has <file> <key> — true when the file assigns <key> at all, whatever
# the value (`SCORE_IMAGE=` is a decided "no", which is not the same as never
# having been asked).
dotenv_has() {
  [ -f "$1" ] || return 1
  # No `grep -q`: it exits at the first match, and under pipefail the `tr` it
  # leaves writing into a closed pipe can turn a match into a failure.
  tr -d '\r' <"$1" | grep -E "$(dotenv_key_ere "$2")" >/dev/null
}
