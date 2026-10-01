// ADR 41, ported from compose networks to security groups.
//
// The compose stack puts `app` on `frontend`, `redis` on `backend`, and only
// `srh` on both — which is what stops the internet-facing app from reaching
// `redis:6379` at all. Subnets cannot express that here (every task shares the
// public tier), so the boundary moves to security groups, and it has to be
// exactly as strict:
//
//     internet   -> alb        :443/:80
//     alb        -> app        :3000
//     app        -> srh        :80
//     scorer     -> srh        :80
//     sync       -> srh        :80
//     app        -> scorer     :4000   (leaderboard, challenge catalogue)
//     sync       -> scorer     :4000   (POST /score)
//     srh        -> elasticache:6379
//
// and nothing else. In particular THE APP HAS NO PATH TO ELASTICACHE. That is
// the property ADR 41 exists for: the app speaks Upstash-REST to srh and never
// raw Redis, so the bearer token is not the only thing standing between a
// compromised app container and the whole keyspace — the network is.
//
// Every rule is its own `aws_vpc_security_group_*_rule` resource rather than an
// inline block, so a rule can be read, diffed and asserted individually — and
// so `terraform test` can name one.

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "Public entry point: the leaderboard and GitHub sign-in"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-alb" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "app" {
  name_prefix = "${var.name}-app-"
  description = "The contestant web app. Reachable only from the ALB."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-app" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "srh" {
  name_prefix = "${var.name}-srh-"
  description = "Upstash-REST shim. The ONLY thing that may reach ElastiCache."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-srh" }

  lifecycle {
    create_before_destroy = true
  }
}

// The scorer has its own group rather than sharing sync's: it takes inbound
// on :4000 from the app and from sync, and a rule on a shared group would let
// the scorer reach sync too. sync stays outbound only.
resource "aws_security_group" "scorer" {
  count = local.run_scorer ? 1 : 0

  name_prefix = "${var.name}-scorer-"
  description = "The scorer. Reachable on :4000 from the app and sync only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-scorer" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "worker" {
  name_prefix = "${var.name}-worker-"
  description = "sync. Outbound only; nothing may reach it."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-worker" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "cache" {
  name_prefix = "${var.name}-cache-"
  description = "ElastiCache. Reachable from srh alone."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-cache" }

  lifecycle {
    create_before_destroy = true
  }
}

// --- ingress ---------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count = length(var.web_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS (leaderboard + sign-in)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.web_ingress_cidrs[count.index]
}

// Port 80 exists to redirect to 443, never to serve. See alb.tf's listener.
resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  count = length(var.web_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTP (redirect to HTTPS only)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = var.web_ingress_cidrs[count.index]
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "The app answers the ALB, and nothing else"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_ingress_rule" "srh_from_app" {
  security_group_id            = aws_security_group.srh.id
  description                  = "app to srh (Upstash REST)"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_ingress_rule" "srh_from_worker" {
  security_group_id            = aws_security_group.srh.id
  description                  = "sync to srh (Upstash REST)"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.worker.id
}

resource "aws_vpc_security_group_ingress_rule" "srh_from_scorer" {
  count = local.run_scorer ? 1 : 0

  security_group_id            = aws_security_group.srh.id
  description                  = "scorer to srh (Upstash REST)"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.scorer[0].id
}

resource "aws_vpc_security_group_ingress_rule" "scorer_from_app" {
  count = local.run_scorer ? 1 : 0

  security_group_id            = aws_security_group.scorer[0].id
  description                  = "app to scorer (leaderboard, challenge catalogue)"
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_ingress_rule" "scorer_from_sync" {
  count = local.run_scorer ? 1 : 0

  security_group_id            = aws_security_group.scorer[0].id
  description                  = "sync to scorer (POST /score)"
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
  referenced_security_group_id = aws_security_group.worker.id
}

// THE rule ADR 41 is about. Its source is srh's security group and nothing
// else — not the app's, not the workers', not a CIDR.
resource "aws_vpc_security_group_ingress_rule" "cache_from_srh" {
  security_group_id            = aws_security_group.cache.id
  description                  = "srh to ElastiCache. The only path to Redis."
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.srh.id
}

// --- egress ----------------------------------------------------------------
//
// Egress is open for the ALB and the task groups: they pull images from ECR,
// read secrets, write logs, and `sync` talks to GitHub. Narrowing that to
// prefix lists is possible and is not attempted here — it would have to be
// re-derived every time AWS changes a range, and the inbound rules above are
// what the security of this stack actually rests on.
//
// ElastiCache gets NO egress rule at all: it answers connections and initiates
// none.

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  description       = "To the app targets"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "ECR, Secrets Manager, logs, srh"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "srh_all" {
  security_group_id = aws_security_group.srh.id
  description       = "ECR, logs, ElastiCache"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "scorer_all" {
  count = local.run_scorer ? 1 : 0

  security_group_id = aws_security_group.scorer[0].id
  description       = "ECR, SSM, logs, srh"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "worker_all" {
  security_group_id = aws_security_group.worker.id
  description       = "ECR, SSM, logs, srh, the scorer, GitHub"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
