#!/usr/bin/env bats
#
# EC2 accepts only a-zA-Z0-9. _-:/()#,@[]+=&;{}!$* (under 256 characters) in a
# security group's or a security group rule's description, and checks it only
# at apply. `terraform validate` and the mocked `terraform test` never call
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

# file:line:description for every description inside a security group or
# security group rule resource block, in every .tf file under $1.
sg_descriptions() {
  for f in "$1"/*.tf; do
    awk -v file="$f" '
      /^resource "(aws_security_group|aws_vpc_security_group_ingress_rule|aws_vpc_security_group_egress_rule)"/ { inblock = 1; next }
      /^}/ { inblock = 0 }
      inblock && /^[ \t]*description[ \t]*=[ \t]*"/ {
        line = $0
        sub(/^[ \t]*description[ \t]*=[ \t]*"/, "", line)
        sub(/"[ \t]*(#.*|\/\/.*)?$/, "", line)
        print file ":" NR ":" line
      }
    ' "$f"
  done
}

# The descriptions EC2 would refuse: any character outside its set, or 256+.
refused() {
  sg_descriptions "$1" | while IFS= read -r entry; do
    desc="${entry#*:*:}"
    if [ "${#desc}" -ge 256 ] || printf '%s' "$desc" | LC_ALL=C grep -q '[^][a-zA-Z0-9. _:/()#,@+=&;{}!$*-]'; then
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

@test "every security group and rule description is one EC2 accepts" {
  out="$(refused "$MODULE")"
  if [ -n "$out" ]; then
    echo "EC2 refuses these descriptions (allowed: a-zA-Z0-9. _-:/()#,@[]+=&;{}!\$*):" >&2
    echo "$out" >&2
  fi
  [ -z "$out" ]
}
