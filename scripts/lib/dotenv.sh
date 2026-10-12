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
#   - Unquoted: a comment starts at the first ` #` (a SPACE, then `#`). A tab
#     before the `#` does not start one, and neither does a `#` at the very
#     start of the value — so `SCORE_IMAGE= # none` is the value `# none` to
#     compose, and therefore here too.
#   - The LAST assignment of a key wins, an empty one included.
#   - An absent key, or an absent file, reads as empty.
#
# What compose reads and this reader does not is REFUSED, never guessed: the
# reader prints nothing, names the key and the file (never the value) on
# stderr, and returns 1. Guessing is how a script and the box disagree —
# an empty SCORE_IMAGE turns Secure Development OFF, the literal text of an
# expression turns it ON. Refused:
#
#   - An unterminated quote. Compose continues a double-quoted value onto
#     the following lines; this reader reads one line per assignment.
#   - Interpolation outside single quotes: `$NAME`, `${...}` and the `$$`
#     escape. Compose resolves them from the shell environment; this reader
#     does not. A `$` compose leaves alone (`pa$5word`, `a$`, `a $ b`, and
#     anything in single quotes) is read literally, as compose reads it.
#   - A backslash inside double quotes, where compose interprets escapes
#     (`\n`, `\"`, `\$`), and `\'` inside single quotes, which compose reads
#     as an escaped quote. Any other backslash in single quotes, and every
#     unquoted one, is literal to both.
#   - A file that exists but cannot be read (permissions, a directory). An
#     ABSENT file is still "not set".
#
# The shared corpora that pin all of this are test/fixtures/dotenv-corpus.env
# (read) and test/fixtures/dotenv-corpus-rejected.env (refused), run by
# scripts/test/dotenv.bats, which also diffs the reader against `docker
# compose config` over every generated combination of key form, value form,
# line ending and duplicate: each must read as compose reads it, or be refused.
#
# bash 3.2 (macOS) compatible, BSD and GNU userlands, no jq or python.

# dotenv_value <raw> — one value with compose's semantics. <raw> is everything
# after the `=` (or `:`), untrimmed. Prints the value and returns 0, or prints
# nothing and returns why it refused: 2 an unterminated quote, 3
# interpolation, 4 a backslash escape inside double quotes.
dotenv_value() {
  local v="$1" rest
  v="${v#"${v%%[![:space:]]*}"}"
  case "$v" in
  '"'*)
    rest="${v#\"}"
    case "$rest" in *'"'*) ;; *) return 2 ;; esac
    v="${rest%%\"*}"
    case "$v" in *\\*) return 4 ;; esac
    dotenv_interpolates "$v" && return 3
    ;;
  "'"*)
    rest="${v#\'}"
    # Compose reads `\'` as an escaped quote inside single quotes, and every
    # other backslash there literally. Decoding the one and not the other is
    # a second parser to keep in step, so the escape is refused.
    case "$rest" in *"\\'"*) return 4 ;; esac
    case "$rest" in *"'"*) ;; *) return 2 ;; esac
    v="${rest%%\'*}"
    ;;
  *)
    v="${v%% #*}"
    v="${v%"${v##*[![:space:]]}"}"
    dotenv_interpolates "$v" && return 3
    ;;
  esac
  printf '%s' "$v"
}

# dotenv_interpolates <value> — true when compose would rewrite a `$` in it:
# `$$` (its escape for a literal `$`), `${`, or `$` before a letter or `_`.
dotenv_interpolates() {
  # shellcheck disable=SC2016 # literal `$` patterns, not expansions
  case "$1" in
  *'$$'* | *'${'* | *'$'[A-Za-z_]*) return 0 ;;
  esac
  return 1
}

# dotenv_key_ere <key> — an ERE matching any line that assigns <key>, in every
# form dotenv_get reads. For "is there a line for this key at all?" questions:
# a presence test narrower than the reader is how a key ends up assigned twice.
dotenv_key_ere() {
  printf '^[[:space:]]*(export[[:space:]]+)?%s[[:space:]]*[:=]' "$1"
}

# dotenv_readable <file> — 0 when the file is absent or readable; otherwise a
# message on stderr and 1. /dev/null is readable, and reads as empty.
dotenv_readable() {
  [ -e "$1" ] || return 0
  if [ -d "$1" ] || [ ! -r "$1" ]; then
    echo "dotenv: $1 exists but cannot be read; fix its permissions or point at the right file" >&2
    return 1
  fi
}

# dotenv_get <file> <key> — the value compose would read, or empty when the
# file or the key is absent. Anything it cannot read the way compose does is
# refused (see the header): nothing on stdout, the reason on stderr, return 1.
# A caller must not read that as empty — `v="$(dotenv_get ...)" || exit 1`.
dotenv_get() {
  local file="$1" key="$2" raw rc=0
  [ -e "$file" ] || return 0
  dotenv_readable "$file" || return 1
  # Each assignment is printed behind a `=` marker and the LAST one is kept
  # inside the pipeline: `$(...)` strips trailing newlines, so selecting it
  # afterwards would let an empty last assignment fall through to an earlier
  # value. No marker means the key is absent.
  if ! raw="$(tr -d '\r' <"$file" | sed -n \
    -e "s/^[[:space:]]*export[[:space:]]\{1,\}//" \
    -e "s/^[[:space:]]*${key}[[:space:]]*[:=]/=/p" | tail -1)"; then
    echo "dotenv: $file could not be read" >&2
    return 1
  fi
  [ -n "$raw" ] || return 0
  raw="${raw#=}"
  dotenv_value "$raw" || rc=$?
  case "$rc" in
  0) return 0 ;;
  2) echo "dotenv: $file: $key has an unterminated quote; close it on the same line" >&2 ;;
  3) echo "dotenv: $file: $key uses interpolation this reader does not resolve; set the literal value (single-quote it to keep a literal \$)" >&2 ;;
  *) echo "dotenv: $file: $key uses a backslash escape (inside double quotes, or before a quote in single quotes), which this reader does not interpret; set the literal value" >&2 ;;
  esac
  return 1
}

# dotenv_check <file> <key>... — 0 when every key reads cleanly (an absent
# file included), else 1 after dotenv_get's message for the first that does
# not. For a script to run once, up front, in its own shell, where `exit`
# stops the script: a refusal inside `$(...)` only stops the subshell.
dotenv_check() {
  local file="$1" key
  shift
  for key in "$@"; do
    dotenv_get "$file" "$key" >/dev/null || return 1
  done
}

# dotenv_has <file> <key> — true when the file assigns <key> at all, whatever
# the value (`SCORE_IMAGE=` is a decided "no", which is not the same as never
# having been asked). An unreadable file is 2, with a message: neither "yes"
# nor "no".
dotenv_has() {
  [ -e "$1" ] || return 1
  dotenv_readable "$1" || return 2
  # No `grep -q`: it exits at the first match, and under pipefail the `tr` it
  # leaves writing into a closed pipe can turn a match into a failure.
  tr -d '\r' <"$1" | grep -E "$(dotenv_key_ere "$2")" >/dev/null
}
