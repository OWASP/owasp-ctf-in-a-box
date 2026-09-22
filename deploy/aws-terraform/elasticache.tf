// Managed Redis, replacing the compose stack's `redis:8-alpine` container and
// its AOF volume.
//
// IN-TRANSIT ENCRYPTION IS ON, and that is a checked decision rather than a
// default. srh — the Upstash-REST shim every service talks to — turns TLS on by
// detecting the `rediss://` scheme on its connection string, and verifies the
// hostname while doing it (`lib/srh/redis/client_worker.ex`):
//
//     enable_ssl = String.starts_with?(connection_string, "rediss://")
//     socket_opts = [customize_hostname_check: [
//       match_fun: :public_key.pkix_verify_hostname_match_fun(:https)]]
//     Redix.start_link(connection_string, ssl: enable_ssl, socket_opts: socket_opts)
//
// Two consequences this module has to honour, and does:
//   1. srh must be handed the ElastiCache PRIMARY ENDPOINT HOSTNAME, never an
//      address — hostname verification is on, and a certificate does not match
//      an IP. See `local.redis_url` in ecs.tf.
//   2. AUTH rides in the URI userinfo, parsed by Redix rather than by srh.
//
// DURABILITY is snapshots, not the AOF-on-a-volume the EC2 box had. That is a
// real change in kind: a restore is coarser-grained and to a daily boundary.
// The event archive (export/import on the admin Event tab) is the
// content-level backup and the one an organizer should rely on before anything
// risky; these snapshots are the floor under a node failure.

resource "aws_elasticache_subnet_group" "main" {
  name        = "${var.name}-cache"
  subnet_ids  = aws_subnet.private[*].id
  description = "Private subnets for the event's Redis"
}

resource "aws_elasticache_parameter_group" "main" {
  name   = "${var.name}-cache"
  family = "redis7"

  // The kit's grading paths are Lua scripts run through EVAL, and the event's
  // data IS the keyspace — there is no backing store to fall back to. So a
  // full cache must fail loudly on write rather than silently evicting the
  // solves it is holding.
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

// The AUTH token, generated here rather than asked of the operator so a deploy
// cannot proceed with a weak or reused one.
//
// IT LANDS IN TERRAFORM STATE. There is no way around that for a value
// Terraform must supply at create time, and the module does not pretend
// otherwise: the README requires an encrypted remote backend with restricted
// access. The token is also written to SSM below, so operators and tasks read
// it from one place rather than out of state.
resource "random_password" "cache_auth" {
  length = 64

  // ElastiCache rejects several punctuation characters in an AUTH token, and
  // the token is interpolated into a URI, where reserved characters would need
  // escaping. Alphanumerics sidestep both, and at 64 characters the entropy is
  // far beyond what either constraint costs.
  special = false
}

resource "aws_ssm_parameter" "cache_auth" {
  name        = "${var.ssm_prefix}/REDIS_AUTH_TOKEN"
  description = "ElastiCache AUTH token for ${var.name}"
  type        = "SecureString"
  value       = random_password.cache_auth.result

  // The event's own key, not the account default — see kms.tf for why the
  // execution role's grant cannot be scoped otherwise.
  key_id = aws_kms_key.secrets.arn
}

locals {
  // `rediss://` is load-bearing: srh turns TLS on by detecting this scheme
  // (see the file header). The PRIMARY ENDPOINT HOSTNAME is equally so —
  // hostname verification is enabled, and a certificate does not match an
  // address.
  redis_url = "rediss://:${random_password.cache_auth.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
}

// The assembled connection string, stored so srh receives it BY REFERENCE.
//
// It embeds the AUTH token, so putting it in a task definition's `environment`
// publishes that token to anyone holding `ecs:DescribeTaskDefinition` — which
// is what this module did until CodeRabbit caught it on PR #354, in direct
// contradiction of the invariant ecs.tf's own comment claims. srh reads the
// connection string only from its environment, with no file-based
// indirection, so `secrets[].valueFrom` is the mechanism: the ECS agent
// resolves this parameter and sets the variable inside the task, leaving the
// task definition holding nothing but an ARN.
//
// The token still lands in Terraform state (see above) — a separate cost, and
// one ADR 54 accepts on the record rather than papering over. What this
// removes is the second copy, in the place with the broadest read access.
resource "aws_ssm_parameter" "redis_url" {
  name        = "${var.ssm_prefix}/SRH_CONNECTION_STRING"
  description = "rediss:// URL with AUTH for srh (${var.name}). Read by reference, never inlined into a task definition."
  type        = "SecureString"
  value       = local.redis_url
  key_id      = aws_kms_key.secrets.arn
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.name}-redis"
  description          = "OWASP CTF in a Box event store for ${var.name}"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.cache_node_type
  port           = 6379

  parameter_group_name = aws_elasticache_parameter_group.main.name
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.cache.id]

  // One primary plus `cache_replica_count` replicas. Failover needs at least
  // one replica, so the two settings travel together rather than being
  // independently settable into a combination that cannot fail over.
  num_cache_clusters         = 1 + var.cache_replica_count
  automatic_failover_enabled = var.cache_replica_count > 0
  multi_az_enabled           = var.cache_replica_count > 0

  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  auth_token                 = random_password.cache_auth.result

  snapshot_retention_limit = var.cache_snapshot_retention_days
  snapshot_window          = "03:00-04:00"
  maintenance_window       = "sun:04:30-sun:05:30"

  apply_immediately = true

  // Rotating the token is a deliberate act with a blast radius — every service
  // reconnects — so it is not something to trigger by editing a variable.
  lifecycle {
    ignore_changes = [auth_token]
  }
}
