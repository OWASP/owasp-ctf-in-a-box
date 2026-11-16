# scripts/lib/claim-code.sh
# shellcheck shell=bash
# The one admin claim-code helper (ADR 72), sourced by every provisioning
# path: setup/ctf-setup.sh, scripts/dev-stack, deploy/fly/deploy.sh and
# deploy/aws-terraform/deploy.sh. Sourced, never executed — no shebang on
# purpose.
#
# A code is 128 random bits shown as 32 lowercase hex in eight groups of four.
# Only its SHA-256 is ever written anywhere (ADMIN_CLAIM_CODE_HASH); the code
# is printed exactly once, by claim_code_announce. Normalization must match
# the app's normalizeClaimCode (apps/web/src/lib/admin-claim.ts): lowercase,
# drop hyphens and whitespace, then exactly 32 hex or nothing. Both suites pin
# the same test vector.
#
# bash 3.2 (macOS) compatible, BSD and GNU userlands, no jq or python.

# claim_code_normalize <code> — the 32-hex form on stdout, or return 1.
claim_code_normalize() {
  local n
  n="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d -- '- \t\r\n')"
  case "$n" in
  *[!0-9a-f]* | "") return 1 ;;
  esac
  [ "${#n}" -eq 32 ] || return 1
  printf '%s\n' "$n"
}

# claim_code_new — a fresh grouped code on stdout. Exits 1, naming openssl,
# when it cannot get random bytes.
claim_code_new() {
  local hex
  hex="$(openssl rand -hex 16 2>/dev/null)" || hex=""
  hex="$(printf '%s' "$hex" | tr '[:upper:]' '[:lower:]')"
  if ! claim_code_normalize "$hex" >/dev/null; then
    echo "claim code: 'openssl rand -hex 16' failed; openssl is required to generate the admin claim code" >&2
    return 1
  fi
  printf '%s\n' "$hex" | sed -E 's/(....)/\1-/g; s/-$//'
}

# claim_code_hash <code> — the lowercase hex SHA-256 of the normalized code.
# `awk '{print $NF}'` takes the digest from both `SHA2-256(stdin)= <hex>`
# (OpenSSL 3+) and a bare `<hex>` / `(stdin)= <hex>` (LibreSSL, older OpenSSL).
claim_code_hash() {
  local n h
  n="$(claim_code_normalize "$1")" || return 1
  h="$(printf '%s' "$n" | openssl dgst -sha256 2>/dev/null | awk '{print $NF}')"
  claim_code_is_hash "$h" || return 1
  printf '%s\n' "$h"
}

# claim_code_is_hash <value> — 0 iff the value is 64 lowercase hex.
claim_code_is_hash() {
  case "$1" in
  *[!0-9a-f]* | "") return 1 ;;
  esac
  [ "${#1}" -eq 64 ]
}

# claim_code_announce <code> <event-url> <recovery-command> — the ONE print of
# a code, to stdout, framed so it stands out in a long setup log.
claim_code_announce() {
  local url="${2%/}"
  echo ""
  echo "=================================================================="
  echo "  Admin claim code:  $1"
  echo ""
  echo "  Open $url/admin/claim, sign in, enter this code. It works once."
  echo "  It is not stored anywhere — save it now."
  echo "  Lost it? Run $3 for a new one."
  echo "=================================================================="
  echo ""
}
