# scripts/lib/redact.sh
# shellcheck shell=bash
# The ONE dry-run redactor for the deploy scripts (deploy/fly/deploy.sh and
# deploy/aws-terraform/deploy.sh). Sourced, never executed — no shebang on
# purpose; the `shell=bash` directive above names the target shell for the
# linter.
#
# A dry run is the command people run FIRST, casually, precisely because they
# believe it is inert — into a terminal, a scrollback buffer, a CI log or a
# screen share. Printing a credential is the last thing it should do. Two
# deploy scripts with two redactors is how one of them ends up knowing fewer
# secret shapes than the other, so both print through this file.
#
# Two rules, applied to every argument:
#
#   1. `NAME=value` where NAME looks like a secret has its VALUE replaced, so
#      the preview still shows WHICH variables get set — the point of
#      previewing — without showing what they are. NAME is matched
#      case-insensitively against:
#        *SECRET*  *TOKEN*  *PASSWORD*  *PASSWD*  *PRIVATE_KEY*
#        *CONNECTION_STRING*  (a redis:// or postgres:// URL embeds a password)
#        *_KEY  *APIKEY*  *API_KEY*  *CREDENTIAL*
#        *AUTH  (BASIC_AUTH, PROXY_AUTH — a suffix only, so BETTER_AUTH_URL,
#                which is a public URL, stays readable)
#   2. URL userinfo anywhere in an argument is masked: `scheme://user:pass@host`
#      becomes `scheme://***@host`, whatever the variable is called, because a
#      URL that carries credentials is a secret even under a harmless name.
#
# bash 3.2 (macOS) compatible, BSD and GNU userlands, no jq or python.

# redact_userinfo <string> — mask every `scheme://userinfo@` in it. The
# userinfo match is greedy up to the last `@` before the path, so a password
# holding a literal `@` is masked whole rather than leaking its tail.
redact_userinfo() {
  case "$1" in
  *://*@*)
    printf '%s' "$1" |
      sed -E 's|([A-Za-z][A-Za-z0-9+.-]*://)[^/?#[:space:]]*@|\1***@|g'
    ;;
  *) printf '%s' "$1" ;;
  esac
}

# redact_arg <arg> — one argument, printable.
redact_arg() {
  local name upper
  case "$1" in
  *=*)
    name="${1%%=*}"
    upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
    case "$upper" in
    *SECRET* | *TOKEN* | *PASSWORD* | *PASSWD* | *PRIVATE_KEY* | \
      *CONNECTION_STRING* | *_KEY | *APIKEY* | *API_KEY* | *CREDENTIAL* | *AUTH)
      printf '%s=<redacted>' "$name"
      return 0
      ;;
    esac
    ;;
  esac
  redact_userinfo "$1"
}

# redact_args <arg>... — every argument, space-joined on one line.
redact_args() {
  local out="" arg
  for arg in "$@"; do
    out="$out $(redact_arg "$arg")"
  done
  printf '%s\n' "${out# }"
}
