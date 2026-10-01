#!/usr/bin/env bats
#
# EC2 accepts only a-zA-Z0-9. _-:/()#,@[]+=&;{}!$* in a security group's
# description and the same set without `&` in a rule's (under 256 characters
# either way), and checks it only at apply. `terraform validate` and the mocked `terraform test` never call
# EC2, so a `->` in six rule descriptions passed every gate and failed the
# first real apply (#530) — leaving ElastiCache with no ingress, srh unable to
# reach Redis, and the ECS circuit breaker with nothing to roll back to.
#
# This scans the module's own .tf source, so a NEW rule is covered the moment
# it is written, which a hand-listed tftest assertion would not be.
# Every test ends with its decisive assertion (AGENTS.md).

setup() {
  MODULE="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

# kind<TAB>file:line:description for every description inside a security
# group (kind `group`) or security group rule (kind `rule`) resource block,
# in every .tf file under $1. A description that is not a plain string literal
# is reported as `<not a plain string literal>`, which no character set
# accepts — so it fails loudly instead of being skipped unread.
sg_descriptions() {
  for f in "$1"/*.tf; do
    awk -v file="$f" '
      /^resource "aws_security_group"/ { inblock = 1; kind = "group"; next }
      /^resource "aws_vpc_security_group_(ingress|egress)_rule"/ { inblock = 1; kind = "rule"; next }
      /^}/ { inblock = 0 }
      inblock && /^[ \t]*description[ \t]*=/ {
        if ($0 !~ /^[ \t]*description[ \t]*=[ \t]*"/) { print kind "\t" file ":" NR ":<not a plain string literal>"; next }
        line = $0
        sub(/^[ \t]*description[ \t]*=[ \t]*"/, "", line)
        sub(/"[ \t]*(#.*|\/\/.*)?$/, "", line)
        print kind "\t" file ":" NR ":" line
      }
    ' "$f"
  done
}

# The descriptions EC2 would refuse: any character outside its set, or 256+.
# A group description may use `&`; a rule description may not (see the &
# test below for the two sources).
refused() {
  sg_descriptions "$1" | while IFS="$(printf '\t')" read -r kind entry; do
    desc="${entry#*:*:}"
    if [ "$kind" = group ]; then bad='[^][a-zA-Z0-9. _:/()#,@+=&;{}!$*-]'; else bad='[^][a-zA-Z0-9. _:/()#,@+=;{}!$*-]'; fi
    if [ "${#desc}" -ge 256 ] || printf '%s' "$desc" | LC_ALL=C grep -q "$bad"; then
      printf '%s\n' "$entry"
    fi
  done
}

@test "the scan sees every security group and rule description (not vacuous)" {
  # 5 security groups + 14 rule resources in security.tf today; a scanner that
  # stopped matching would otherwise pass the next test with nothing scanned.
  count="$(sg_descriptions "$MODULE" | wc -l | tr -d ' ')"
  [ "$count" -ge 19 ]
}

@test "the scan flags a description EC2 refuses" {
  fixture="$BATS_TEST_TMPDIR/mod"
  mkdir -p "$fixture"
  cat > "$fixture/sg.tf" <<'TF'
resource "aws_vpc_security_group_ingress_rule" "bad" {
  description = "app -> srh"
}
resource "aws_vpc_security_group_ingress_rule" "good" {
  description = "app to srh (Upstash REST)"
}
TF
  out="$(refused "$fixture")"
  [ "$out" = "$fixture/sg.tf:2:app -> srh" ]
}

# PR #533 review: a RULE description is checked without `&`. The live EC2
# error (#530) listed `&` for rules, but the VPC docs leave it out of the rule
# set and keep it only for a GROUP description (CreateSecurityGroup), so a rule
# takes the stricter of the two. Nothing in the module uses it.
@test "the scan refuses & in a rule description but accepts it in a group description" {
  fixture="$BATS_TEST_TMPDIR/mod"
  mkdir -p "$fixture"
  cat > "$fixture/sg.tf" <<'TF'
resource "aws_security_group" "ok" {
  description = "R&D tools"
}
resource "aws_vpc_security_group_ingress_rule" "bad" {
  description = "app & sync to scorer"
}
TF
  out="$(refused "$fixture")"
  [ "$out" = "$fixture/sg.tf:5:app & sync to scorer" ]
}

# PR #533 review: a description that is not a plain string literal would
# otherwise be skipped unread, and the count floor would not notice one rule.
@test "the scan reports a description it cannot read as a literal" {
  fixture="$BATS_TEST_TMPDIR/mod"
  mkdir -p "$fixture"
  cat > "$fixture/sg.tf" <<'TF'
resource "aws_vpc_security_group_ingress_rule" "expr" {
  description = ("app -> srh")
}
TF
  out="$(refused "$fixture")"
  [ "$out" = "$fixture/sg.tf:2:<not a plain string literal>" ]
}

@test "every security group and rule description is one EC2 accepts" {
  out="$(refused "$MODULE")"
  if [ -n "$out" ]; then
    echo "EC2 refuses these descriptions (allowed: a-zA-Z0-9. _-:/()#,@[]+=;{}!\$*, and & in a group's):" >&2
    echo "$out" >&2
  fi
  [ -z "$out" ]
}
