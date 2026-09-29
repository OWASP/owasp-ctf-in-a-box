// What `terraform validate` cannot see.
//
// The EC2 module had `userdata.tftest.hcl` for exactly this reason, recorded in
// AGENTS.md: validate does NOT inspect rendered template output, so the
// bring-up script needed a test that read it. Fargate has no user-data, and the
// equivalent blind spot is the CONTAINER DEFINITIONS — a JSON blob validate
// treats as an opaque string. Everything that could silently ship wrong lives
// in there: image references, the srh-to-ElastiCache wiring, whether a secret
// is a reference or a value, and whether the health check proves anything.
//
// `command = plan` throughout: these assert what WOULD be created, and need no
// AWS credentials.

// Mocked providers: no credentials, no network, no apply — the same posture
// the EC2 module's user-data test used. Mocks fill in COMPUTED attributes
// only, so everything this file actually asserts (container definitions,
// security group references, the connection string) is the module's own
// configured value, not a mock.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  // `.json` on a mocked policy document is a mock STRING, and the IAM
  // resources parse it — so it has to be real JSON or every plan fails before
  // reaching an assertion.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b"]
    }
  }

  // The certificate's validation options are computed, and the DNS record
  // reads them — without a default the plan cannot resolve the index.
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
      domain_validation_options = [{
        domain_name           = "ctf.example.org"
        resource_record_name  = "_acme.ctf.example.org."
        resource_record_type  = "CNAME"
        resource_record_value = "validation.acm-validations.aws."
      }]
    }
  }

  // Several resources validate that an ARN handed to them looks like one, so
  // the mocked roles need real-shaped values rather than the random ids a bare
  // mock produces.
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock-role"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/mock/0123456789abcdef"
      dns_name = "mock-alb-123456789.us-east-1.elb.amazonaws.com"
      zone_id  = "Z35SXDOTRQ7X7K"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/mock/0123456789abcdef"
    }
  }

  mock_resource "aws_service_discovery_service" {
    defaults = {
      arn = "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-mock"
    }
  }

  // The listener validates that its certificate is a real ARN, so the mocked
  // validation has to hand back one.
  mock_resource "aws_acm_certificate_validation" {
    defaults = {
      certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
    }
  }

  // The one computed value the srh wiring depends on. A realistic ElastiCache
  // endpoint, so the "reach it by hostname" assertion is meaningful.
  mock_resource "aws_elasticache_replication_group" {
    defaults = {
      primary_endpoint_address = "ctf-redis.abc123.ng.0001.use1.cache.amazonaws.com"
    }
  }
}

mock_provider "random" {

  mock_resource "random_password" {
    defaults = {
      result = "MOCKAUTHTOKENvalue0000000000000000000000000000000000000000000000"
    }
  }
}

variables {
  github_client_id = "Iv1.0123456789abcdef"
  github_app_id    = "123456"
  domain           = "ctf.example.org"
  route53_zone_id  = "Z0123456789ABCDEFGHIJ"
  app_image        = "123456789012.dkr.ecr.us-east-1.amazonaws.com/owasp-ctf-app:v1"
  scorer_image     = "123456789012.dkr.ecr.us-east-1.amazonaws.com/owasp-ctf-scorer:mirror-0123456789ab"
  sync_image       = "123456789012.dkr.ecr.us-east-1.amazonaws.com/owasp-ctf-sync:0123456789ab"
  github_org       = "owasp-ctf-test"
  admin_logins     = "octocat,defunkt"
}

// --- the input contracts, each one refused at PLAN time --------------------
//
// These four were added with the validations they exercise (PR #354's
// review). Every one of them was previously a mid-apply AWS API error, which
// is the failure mode variables.tf's header says these blocks exist to
// prevent — and the only way to keep that promise honest is to assert the
// refusal rather than assume it.

run "an_over_long_name_is_refused_before_the_alb_rejects_it" {
  command = plan

  variables {
    // 29 characters: legal under the old 3-32 rule, and fatal once alb.tf
    // appends `-alb` and `-app` against AWS's 32-character cap.
    name = "abcdefghij-abcdefghij-abcdef1"
  }

  expect_failures = [var.name]
}

run "secure_development_without_a_scorer_image_is_refused" {
  command = plan

  variables {
    enable_secure_development = true
    scorer_image              = ""
  }

  expect_failures = [var.scorer_image]
}

run "a_secure_development_event_without_a_sync_image_is_refused" {
  command = plan

  variables {
    enable_secure_development = true
    sync_image                = ""
  }

  expect_failures = [var.sync_image]
}

// github_org's rule follows enable_secure_development: setup/ctf-setup.sh
// requires GITHUB_ORG for every non-empty SCORE_IMAGE, sync exits at startup
// without one (sync/src/config.js), and the app would render fork links with
// no org to build them from.
run "secure_development_without_a_github_org_is_refused" {
  command = plan

  variables {
    enable_secure_development = true
    github_org                = ""
  }

  expect_failures = [var.github_org]
}

// Not empty is not the same as set: `" "` reaches both task definitions
// verbatim and names a fork path nothing resolves. Same shape as the
// admin_logins blank-roster run.
run "a_whitespace_only_github_org_is_refused" {
  command = plan

  variables {
    enable_secure_development = true
    github_org                = " "
  }

  expect_failures = [var.github_org]
}

// The complement: an event WITH an org plans cleanly, so the rule above cannot
// be satisfied by refusing secure-development outright.
run "secure_development_with_a_github_org_is_accepted" {
  command = plan

  variables {
    enable_secure_development = true
    github_org                = "owasp-ctf-test"
  }

  assert {
    condition     = length(aws_ecs_service.scorer) == 1
    error_message = "A secure-development event with an org must run the scorer."
  }
}

// admin_logins' rule is UNCONDITIONAL, which is what separates it from the
// two above: no event shape wants an empty admin roster. The string is the
// /admin allowlist itself, so an empty one is a stack nobody can administer —
// a 403 discovered after a clean apply, fixable only by another apply.
run "an_event_with_no_admin_logins_is_refused" {
  command = plan

  variables {
    admin_logins = ""
  }

  expect_failures = [var.admin_logins]
}

// The same lockout, spelled so that a `!= ""` rule would wave it through: a
// roster of separators splits into nothing but blanks.
run "an_admin_roster_of_blanks_is_refused" {
  command = plan

  variables {
    admin_logins = " , "
  }

  expect_failures = [var.admin_logins]
}

run "an_event_with_no_certificate_source_is_refused" {
  command = plan

  variables {
    route53_zone_id     = ""
    acm_certificate_arn = ""
  }

  // alb.tf's `check` block reports the same condition, but a failed check is
  // a WARNING: the apply would continue and hand the HTTPS listener an empty
  // certificate ARN. This asserts the input is refused outright.
  expect_failures = [var.acm_certificate_arn]
}

// --- module enablement follows the compose profiles -----------------------

run "secure_development_event_runs_scorer_and_sync" {
  command = plan

  variables {
    enable_secure_development = true
  }

  assert {
    condition     = length(aws_ecs_service.scorer) == 1 && length(aws_ecs_service.sync) == 1
    error_message = "A secure-development event runs both the scorer and sync."
  }

  assert {
    condition     = aws_ecs_service.app.desired_count >= 1
    error_message = "The app runs on every event."
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment :
      e.name == "SCORE_IMAGE" && e.value == var.scorer_image
    ])
    error_message = "app container must receive SCORE_IMAGE so the default module set matches the deployment"
  }

  // Config v2 (#386): no build-time bake. GITHUB_ORG and ADMIN_LOGINS are
  // runtime environment reads, mirrored into the task definitions like
  // SCORE_IMAGE above — this is the assertion `terraform validate` cannot
  // make on its own, since it never inspects the rendered container JSON.
  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment :
      e.name == "GITHUB_ORG" && e.value == var.github_org
    ])
    error_message = "app container must receive GITHUB_ORG, or forks resolve to bare repo names."
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment :
      e.name == "ADMIN_LOGINS" && e.value == var.admin_logins
    ])
    error_message = "app container must receive ADMIN_LOGINS, or /admin 403s for everyone."
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.sync[0].container_definitions)[0].environment :
      e.name == "GITHUB_ORG" && e.value == var.github_org
    ])
    error_message = "sync container must receive GITHUB_ORG too — sync/src/config.js refuses to start without one."
  }
}

// Final-review finding #3 (issue #386): the app must never receive a
// SCORE_IMAGE for a board it did not stand a scorer up for, even when a
// scorer_image happens to be configured — enable_secure_development is what
// decides, not whether the variable is set. ecs.tf's ternary is the only
// thing standing between this and the app defaulting secure-development on
// with nothing to score it.
run "app_gets_no_score_image_when_secure_development_is_off" {
  command = plan

  variables {
    enable_secure_development = false
    // Deliberately non-empty, to prove SCORE_IMAGE follows
    // enable_secure_development and not merely "is scorer_image set".
    scorer_image = "ghcr.io/example/scorer:v1"
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment :
      e.name == "SCORE_IMAGE" && e.value == ""
    ])
    error_message = "app container must receive an empty SCORE_IMAGE when secure-development is off, so the deployment default module set never includes a board with no running scorer"
  }
}

// There is no SCORE_INGEST in either task definition any more (#377, ADR 56):
// the key named a transport choice, and with push gone the poller is simply
// always the answer. A stray copy would be a switch an operator could set and
// nothing would read.
run "no_task_definition_carries_a_score_ingest_variable" {
  command = plan

  variables {
    enable_secure_development = true
  }

  assert {
    condition = !anytrue([
      for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment :
      e.name == "SCORE_INGEST"
    ])
    error_message = "the app task definition must not carry SCORE_INGEST"
  }

  assert {
    condition = !anytrue([
      for e in jsondecode(aws_ecs_task_definition.scorer[0].container_definitions)[0].environment :
      e.name == "SCORE_INGEST"
    ])
    error_message = "the scorer task definition must not carry SCORE_INGEST"
  }
}

run "quiz_only_event_runs_neither" {
  command = plan

  variables {
    enable_secure_development = false
    scorer_image              = ""
    sync_image                = ""
  }

  assert {
    condition     = length(aws_ecs_service.scorer) == 0 && length(aws_ecs_service.sync) == 0
    error_message = "An event without secure-development must bring up neither service — it has no forks, and no scorer image to pull."
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment :
      e.name == "SCORE_IMAGE" && e.value == ""
    ])
    error_message = "A quiz-only event must hand the app an empty SCORE_IMAGE — the SD toggle must be refused by default."
  }
}

// --- inputs that would produce a broken stack -----------------------------

run "a_floating_srh_tag_is_refused" {
  command = plan

  variables {
    srh_image = "hiett/serverless-redis-http:latest"
  }

  expect_failures = [var.srh_image]
}

run "snapshots_cannot_be_turned_off" {
  command = plan

  variables {
    cache_snapshot_retention_days = 0
  }

  // At 0 ElastiCache takes no backups at all, and this cache IS the event.
  expect_failures = [var.cache_snapshot_retention_days]
}

// --- the srh <-> ElastiCache wiring ---------------------------------------

// `apply`, not `plan`: the connection string embeds the ElastiCache endpoint
// and the generated token, both computed, and a plan cannot evaluate a
// condition that reads them. Nothing is created — the providers are mocked.
run "srh_talks_tls_to_the_cache_by_hostname" {
  command = apply

  assert {
    // `rediss://` is what turns TLS on inside srh — it detects the scheme
    // rather than taking a flag. A plain `redis://` here would silently
    // downgrade the whole data path to plaintext.
    condition     = startswith(local.redis_url, "rediss://")
    error_message = "srh's connection string must use rediss:// — that scheme is how srh decides to enable TLS at all."
  }

  assert {
    // srh verifies the hostname (pkix_verify_hostname_match_fun(:https)), so
    // the endpoint has to be the name on the certificate, never an address.
    condition     = can(regex("@[a-z0-9.-]+[a-z][a-z0-9.-]*:6379$", local.redis_url))
    error_message = "srh must reach ElastiCache by hostname: hostname verification is on, and a certificate does not match an IP."
  }

  assert {
    condition     = aws_elasticache_replication_group.main.transit_encryption_enabled
    error_message = "In-transit encryption must stay on — srh supports it, so there is no reason to run the data path in the clear."
  }
}

// --- ADR 41: the app has no path to Redis ---------------------------------

run "only_srh_may_reach_elasticache" {
  command = plan

  assert {
    condition     = aws_vpc_security_group_ingress_rule.cache_from_srh.referenced_security_group_id == aws_security_group.srh.id
    error_message = "ElastiCache must accept traffic from srh's security group and nothing else — that is ADR 41's boundary."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.cache_from_srh.referenced_security_group_id != aws_security_group.app.id
    error_message = "The app must never reach Redis directly; it speaks Upstash-REST to srh (ADR 41)."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.app_from_alb.referenced_security_group_id == aws_security_group.alb.id
    error_message = "The app must be reachable only from the ALB."
  }
}

// --- secrets are references, never values ---------------------------------

run "no_secret_is_baked_into_a_task_definition" {
  command = plan

  assert {
    // A task definition is readable by anyone with
    // ecs:DescribeTaskDefinition, so a secret in `environment` is a secret
    // published. Every one must arrive through `secrets[].valueFrom`.
    condition     = alltrue([for s in local.app_secrets : startswith(s.valueFrom, "arn:")])
    error_message = "Every app secret must be an SSM ARN reference, not a literal value."
  }

  assert {
    condition     = alltrue([for s in concat(local.scorer_secrets, local.sync_secrets) : startswith(s.valueFrom, "arn:")])
    error_message = "Every scorer and sync secret must be an SSM ARN reference, not a literal value."
  }

  assert {
    // The AUTH token is the one secret Terraform generates rather than reads,
    // which makes it the one most likely to end up somewhere plain.
    condition     = !strcontains(aws_ecs_task_definition.app.container_definitions, random_password.cache_auth.result)
    error_message = "The Redis AUTH token must never appear in the app task definition."
  }

  assert {
    // srh TOO, which is the half this suite used to miss. The earlier version
    // asserted only the app, reasoning that "the app has no business holding
    // it — only srh does" — and that reasoning is exactly what let the token
    // sit in srh's `environment` in plaintext until PR #354's review. srh
    // needing the value does not mean srh's task definition should publish
    // it: `ecs:DescribeTaskDefinition` reads both alike.
    condition     = !strcontains(aws_ecs_task_definition.srh.container_definitions, random_password.cache_auth.result)
    error_message = "The Redis AUTH token must never appear in the srh task definition either — it arrives through secrets[].valueFrom."
  }

  assert {
    // The positive half of the assertion above. Absence alone could also mean
    // the variable was dropped entirely, which would leave srh unable to
    // connect and this suite still green.
    //
    // Decoded rather than string-matched: under `mock_provider` the parameter
    // ARN is a random placeholder, so asserting the task definition contains
    // the ARN (or the parameter name) tests the mock, not the wiring. What
    // matters structurally is that the variable is in `secrets` and NOT in
    // `environment`.
    // `valueFrom` is checked, not just the name: a secret entry with the right
    // name and an empty reference satisfies "is present" while ECS rejects the
    // task definition outright, so name-only would be a green test for a
    // stack that cannot deploy.
    condition = anytrue([
      for s in jsondecode(aws_ecs_task_definition.srh.container_definitions)[0].secrets :
      s.name == "SRH_CONNECTION_STRING" && try(s.valueFrom != null && s.valueFrom != "", false)
    ])
    error_message = "srh must still receive SRH_CONNECTION_STRING, through a non-empty secrets[].valueFrom."
  }

  assert {
    condition = !anytrue([
      for e in jsondecode(aws_ecs_task_definition.srh.container_definitions)[0].environment :
      e.name == "SRH_CONNECTION_STRING"
    ])
    error_message = "SRH_CONNECTION_STRING must not be an `environment` entry — that publishes the AUTH token to ecs:DescribeTaskDefinition."
  }

  assert {
    condition     = aws_ssm_parameter.cache_auth.type == "SecureString"
    error_message = "The generated AUTH token must be stored as a SecureString."
  }

  assert {
    condition     = aws_ssm_parameter.redis_url.type == "SecureString"
    error_message = "The assembled connection string embeds the AUTH token, so it must be a SecureString, not a String."
  }

  assert {
    // Both generated parameters must use the event's own key, or the scoped
    // kms:Decrypt grant cannot read them and the tasks fail to start.
    condition     = aws_ssm_parameter.cache_auth.key_id == aws_kms_key.secrets.arn && aws_ssm_parameter.redis_url.key_id == aws_kms_key.secrets.arn
    error_message = "Both generated SecureStrings must be encrypted with this event's KMS key."
  }
}

// --- the execution role's decrypt grant names one key ----------------------

run "the_secret_grants_name_resources_never_a_wildcard" {
  command = plan

  assert {
    // `kms:Decrypt` on "*" with only a `kms:ViaService` condition lets this
    // role decrypt every SecureString in the account that delegates to IAM —
    // another event's, another team's. Naming the key is the fix; this is
    // what stops the wildcard coming back.
    //
    // Asserted against the LOCAL, not a data source's rendered json: see the
    // note in iam.tf. The data source's json is provider-computed, so under
    // mock_provider its Statement list is empty and this very assertion
    // passed while proving nothing.
    condition     = alltrue([for s in local.execution_secrets_policy.Statement : !contains(s.Resource, "*")])
    error_message = "No statement in the execution role's secret policy may use a \"*\" resource — kms:Decrypt must name this event's key."
  }

  assert {
    // Non-vacuity guard for the assertion above: it is an `alltrue` over a
    // list, so an empty (or renamed) policy would satisfy it trivially. This
    // pins that the two statements are actually there.
    condition     = length(local.execution_secrets_policy.Statement) == 2
    error_message = "Expected exactly two statements (read parameters, decrypt them) — update these assertions deliberately if that changes."
  }

  assert {
    condition = anytrue([
      for s in local.execution_secrets_policy.Statement :
      contains(s.Action, "kms:Decrypt") && s.Resource == [aws_kms_key.secrets.arn]
    ])
    error_message = "The execution role still needs kms:Decrypt, scoped to this event's key — the grant should be narrowed, not removed."
  }

  assert {
    // The parameter-read grant, pinned to the event's own prefix.
    //
    // The `contains(s.Resource, "*")` assertion above does NOT cover this: it
    // matches an element equal to `"*"`, and a wildcard INSIDE an ARN is a
    // different thing — which this statement legitimately uses, as
    // `…:parameter/<prefix>/*`. So a resource widened to `…:parameter/*`, or
    // to another event's prefix, would pass every other check here. Equality
    // against the intended ARN is what actually pins it.
    condition = anytrue([
      for s in local.execution_secrets_policy.Statement :
      contains(s.Action, "ssm:GetParameters") &&
      s.Resource == ["arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_prefix}/*"]
    ])
    error_message = "ssm:GetParameters must be scoped to this event's parameter prefix, not a wider path."
  }
}

// --- the health check has to prove Redis, not liveness --------------------

run "srh_health_check_issues_a_real_command" {
  command = plan

  // srh's own source: Redix opens the connection lazily, so srh starts green
  // against an unreachable ElastiCache or a wrong AUTH token. A check that
  // only proves the process is up would report a healthy stack whose data
  // path is broken, and the first contestant submission would find out.
  //
  // These assertions pin the RENDERED command to srh-healthcheck.sh, and
  // test/srh-healthcheck.bats executes that file against the pinned srh
  // image. The two halves need each other: this one alone passed for months
  // over a `GET /ping` srh answers with a 404 (#476), because a string check
  // cannot tell a working probe from one that can never succeed.
  assert {
    condition = jsondecode(aws_ecs_task_definition.srh.container_definitions)[0].healthCheck.command == [
      "CMD-SHELL",
      trimspace(file("${path.module}/srh-healthcheck.sh")),
    ]
    error_message = "srh's health check must be exactly srh-healthcheck.sh — the file test/srh-healthcheck.bats executes against a real srh. A command written anywhere else is untested."
  }

  assert {
    // Non-vacuity for the equality above: an empty file would render an
    // empty CMD-SHELL and still "equal" itself.
    condition = alltrue([
      for needle in [
        "--post-data='[\"PING\"]'",
        "grep -q PONG",
        "Authorization: Bearer $SRH_TOKEN",
        "Content-Type: application/json",
      ] : strcontains(jsondecode(aws_ecs_task_definition.srh.container_definitions)[0].healthCheck.command[1], needle)
    ])
    error_message = "srh's health check must POST the Upstash body [\"PING\"] as JSON with the bearer token and require PONG back."
  }

  assert {
    condition     = !strcontains(jsondecode(aws_ecs_task_definition.srh.container_definitions)[0].healthCheck.command[1], "/ping")
    error_message = "srh's health check must not call /ping: the pinned srh returns 404 there whatever the token or the Redis state, so srh would never go healthy (#476)."
  }
}

// --- the app's health check is liveness-only, unlike srh's ----------------

run "the_app_health_check_does_not_depend_on_redis" {
  command = plan

  assert {
    // The opposite of the assertion above, on purpose. srh's job IS to reach
    // Redis, so a probe that proves it did belongs there. The app's job is to
    // serve an event whose pause/schedule reads deliberately fail OPEN, so a
    // Redis blip must not cost it anything — and an unhealthy target here is
    // deregistered and its task replaced, which cannot fix Redis and would
    // take out every task at once.
    //
    // `/` was the original choice and is wrong twice over: the app streams its
    // shell with HTTP 200 and puts render failures in the BODY (#312), so a 200
    // from `/` never proved the page rendered either.
    condition     = aws_lb_target_group.app.health_check[0].path == "/health"
    error_message = "The ALB must health-check /health, not a page that reads Redis: a blip would deregister every app task, and a 200 from a streamed shell does not prove it rendered anyway (#312)."
  }
}

// --- the app reaches Redis only through srh -------------------------------

run "the_app_is_pointed_at_srh_not_at_redis" {
  command = plan

  assert {
    condition     = strcontains(aws_ecs_task_definition.app.container_definitions, local.upstash_url)
    error_message = "The app must be given srh's URL as UPSTASH_REDIS_REST_URL."
  }

  assert {
    condition     = !strcontains(aws_ecs_task_definition.app.container_definitions, "rediss://")
    error_message = "The app must never be handed a raw Redis URL — it speaks Upstash-REST only (ADR 41)."
  }
}

// --- parity with docker-compose.yml (#476) ---------------------------------
//
// The module was written before poll scoring (#377) and before sync moved to
// a GitHub App, and compose was updated for both while these task definitions
// were not: the app lost sign-in (no GITHUB_CLIENT_ID), served the mock board
// (no LEADERBOARD_SOURCE) and refused team writes; sync and the scorer
// refused to start. Nothing here noticed, because every assertion named the
// variables it already knew about.
//
// So the list is read from compose itself. Every environment key compose
// gives app, scorer and sync must reach the matching ECS task as an
// environment entry or a secret — a key added to compose and not here fails
// this run. The exceptions are named, each with its reason.
run "every_compose_variable_reaches_its_ecs_task" {
  command = plan

  variables {
    enable_secure_development = true
  }

  assert {
    condition = length(setsubtract(
      setsubtract(keys(yamldecode(file("../../docker-compose.yml")).services.app.environment), [
        // HTTPS is not optional here (the session cookie is Secure).
        "ALLOW_INSECURE_EVENT_URL",
        // The demo seed is a local-evaluation switch, never an event's.
        "DEMO_MODE",
      ]),
      concat(
        [for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment : e.name],
        [for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].secrets : e.name],
      ),
    )) == 0
    error_message = "Every environment key docker-compose.yml gives the app must reach the ECS app task (environment or secrets)."
  }

  assert {
    condition = length(setsubtract(
      keys(yamldecode(file("../../docker-compose.yml")).services.scorer.environment),
      concat(
        [for e in jsondecode(aws_ecs_task_definition.scorer[0].container_definitions)[0].environment : e.name],
        [for e in jsondecode(aws_ecs_task_definition.scorer[0].container_definitions)[0].secrets : e.name],
      ),
    )) == 0
    error_message = "Every environment key docker-compose.yml gives the scorer must reach the ECS scorer task."
  }

  assert {
    condition = length(setsubtract(
      setsubtract(keys(yamldecode(file("../../docker-compose.yml")).services.sync.environment), [
        // Compose's value is sync's own default; the file lives in the
        // task's ephemeral storage either way.
        "STATE_PATH",
      ]),
      concat(
        [for e in jsondecode(aws_ecs_task_definition.sync[0].container_definitions)[0].environment : e.name],
        [for e in jsondecode(aws_ecs_task_definition.sync[0].container_definitions)[0].secrets : e.name],
      ),
    )) == 0
    error_message = "Every environment key docker-compose.yml gives sync must reach the ECS sync task."
  }
}

run "the_app_signs_in_scores_and_writes_teams" {
  command = plan

  variables {
    enable_secure_development = true
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment :
      e.name == "GITHUB_CLIENT_ID" && e.value == var.github_client_id
    ])
    error_message = "The app needs GITHUB_CLIENT_ID, or GitHub sign-in gets an undefined client id (apps/web/src/lib/auth.ts)."
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment :
      e.name == "LEADERBOARD_SOURCE" && e.value == "lambda"
    ])
    error_message = "LEADERBOARD_SOURCE must be lambda: unset, the board serves mock fixture data (leaderboard/source.ts)."
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment :
      e.name == "LEADERBOARD_API_URL" && e.value == "http://scorer.${aws_service_discovery_private_dns_namespace.main.name}:4000"
    ])
    error_message = "The app reads scores and the challenge catalogue from the scorer by its Cloud Map name."
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment :
      e.name == "TEAM_WRITES_ENABLED" && e.value == "true"
    ])
    error_message = "TEAM_WRITES_ENABLED must be true, or no team can be created or joined (team-store.ts)."
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.sync[0].container_definitions)[0].environment :
      e.name == "SCORER_URL" && e.value == "http://scorer.${aws_service_discovery_private_dns_namespace.main.name}:4000"
    ])
    error_message = "sync submits to the scorer by its Cloud Map name; the compose default http://scorer:4000 does not resolve on ECS."
  }

  assert {
    condition     = length(aws_service_discovery_service.scorer) == 1
    error_message = "The scorer needs a Cloud Map name, as srh has."
  }
}

run "no_task_reads_the_retired_github_token" {
  command = plan

  variables {
    enable_secure_development = true
  }

  assert {
    condition = !anytrue(flatten([
      for td in [aws_ecs_task_definition.app, aws_ecs_task_definition.scorer[0], aws_ecs_task_definition.sync[0]] : [
        for e in concat(jsondecode(td.container_definitions)[0].environment, jsondecode(td.container_definitions)[0].secrets) :
        e.name == "GITHUB_TOKEN"
      ]
    ]))
    error_message = "Nothing reads GITHUB_TOKEN since sync moved to a GitHub App; a stray one is a PAT an operator stores for no reader."
  }
}

// The scorer answers two callers, and only them: sync (POST /score) and the
// app (the leaderboard and the challenge catalogue). It used to share the
// worker group with sync, whose description is "nothing may reach them" —
// a rule on that group would have let the scorer reach sync too.
run "only_the_app_and_sync_may_reach_the_scorer" {
  command = plan

  variables {
    enable_secure_development = true
  }

  assert {
    condition     = aws_ecs_service.scorer[0].network_configuration[0].security_groups == toset([aws_security_group.scorer[0].id])
    error_message = "The scorer runs in its own security group."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.scorer_from_app[0].referenced_security_group_id == aws_security_group.app.id &&
      aws_vpc_security_group_ingress_rule.scorer_from_app[0].from_port == 4000 &&
      aws_vpc_security_group_ingress_rule.scorer_from_app[0].to_port == 4000
    )
    error_message = "The app reaches the scorer on :4000."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.scorer_from_sync[0].referenced_security_group_id == aws_security_group.worker.id &&
      aws_vpc_security_group_ingress_rule.scorer_from_sync[0].from_port == 4000 &&
      aws_vpc_security_group_ingress_rule.scorer_from_sync[0].to_port == 4000
    )
    error_message = "sync reaches the scorer on :4000."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.srh_from_scorer[0].referenced_security_group_id == aws_security_group.scorer[0].id
    error_message = "The scorer still reaches srh from its own group."
  }
}

run "a_blank_github_client_id_is_refused" {
  command = plan

  variables {
    github_client_id = "  "
  }

  expect_failures = [var.github_client_id]
}

run "secure_development_without_a_github_app_id_is_refused" {
  command = plan

  variables {
    enable_secure_development = true
    github_app_id             = ""
  }

  expect_failures = [var.github_app_id]
}

run "a_quiz_only_event_points_the_app_at_no_scorer" {
  command = plan

  variables {
    enable_secure_development = false
  }

  assert {
    condition = !anytrue([
      for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment :
      e.name == "LEADERBOARD_API_URL"
    ])
    error_message = "With no scorer running, the app must not be pointed at one."
  }

  assert {
    condition     = length(aws_service_discovery_service.scorer) == 0 && length(aws_security_group.scorer) == 0
    error_message = "A quiz-only event creates no scorer name and no scorer group."
  }
}

// Review (#479): the App ids are numbers. A non-numeric one reached sync as a
// string that became NaN (sync/src/config.js) — refused at plan time instead.
run "a_non_numeric_github_app_id_is_refused" {
  command = plan

  variables {
    enable_secure_development = true
    github_app_id             = "my-app"
  }

  expect_failures = [var.github_app_id]
}

run "a_non_numeric_installation_id_is_refused" {
  command = plan

  variables {
    github_app_installation_id = "abc"
  }

  expect_failures = [var.github_app_installation_id]
}

run "an_empty_installation_id_is_accepted" {
  command = plan

  variables {
    enable_secure_development  = true
    github_app_installation_id = ""
  }

  assert {
    condition     = length(aws_ecs_task_definition.sync) == 1
    error_message = "An empty installation id is legal: sync picks the installation on github_org."
  }
}


// --- every image has a pullable home, for the CPU the tasks run (#476) -----
//
// The scorer package is private by contract and sync is published nowhere, so
// before #476 a Secure Development stack had no image Fargate could pull for
// either. registry.tf now gives both a repository here, deploy.sh fills them,
// and the execution role may pull exactly those.

run "secure_development_creates_scorer_and_sync_repositories" {
  command = plan

  variables {
    enable_secure_development = true
  }

  assert {
    condition     = toset(keys(aws_ecr_repository.main)) == toset(["app", "scorer", "sync"])
    error_message = "A Secure Development stack needs ECR repositories for the app, the scorer mirror and sync — Fargate has nowhere else to pull the last two from."
  }

  assert {
    // IMMUTABLE for the tag-reuse reason registry.tf gives, and force_delete
    // so `terraform destroy` really ends the event, for every repository.
    condition = alltrue([
      for k, r in aws_ecr_repository.main :
      r.image_tag_mutability == "IMMUTABLE" && r.force_delete == true && r.name == "${var.name}-${k}"
    ])
    error_message = "Every ECR repository must be <name>-<service>, IMMUTABLE, and force_delete so destroy removes it."
  }

  assert {
    condition     = output.ecr_scorer_repository_url != "" && output.ecr_sync_repository_url != ""
    error_message = "deploy.sh learns that the stack runs Secure Development from these outputs being non-empty."
  }
}

run "a_quiz_only_event_creates_only_the_app_repository" {
  command = plan

  variables {
    enable_secure_development = false
    scorer_image              = ""
    sync_image                = ""
  }

  assert {
    condition     = toset(keys(aws_ecr_repository.main)) == toset(["app"])
    error_message = "A quiz-only event runs no scorer and no sync, so it must create no repository for either."
  }

  assert {
    // deploy.sh reads "" as "publish the app only".
    condition     = output.ecr_scorer_repository_url == "" && output.ecr_sync_repository_url == ""
    error_message = "The scorer and sync repository outputs must be empty when Secure Development is off."
  }

  assert {
    condition     = local.execution_pull_policy.Statement[0].Resource == ["arn:aws:ecr:us-east-1:123456789012:repository/owasp-ctf-app"]
    error_message = "A quiz-only event's execution role may pull the app repository and nothing else."
  }
}

run "the_pull_grant_names_the_three_repositories_never_a_wildcard" {
  command = plan

  variables {
    enable_secure_development = true
  }

  assert {
    // Spelled out, not rebuilt from the same locals the policy uses: a
    // comparison of a value with itself proves nothing.
    condition = anytrue([
      for s in local.execution_pull_policy.Statement :
      contains(s.Action, "ecr:BatchGetImage") && s.Resource == [
        "arn:aws:ecr:us-east-1:123456789012:repository/owasp-ctf-app",
        "arn:aws:ecr:us-east-1:123456789012:repository/owasp-ctf-scorer",
        "arn:aws:ecr:us-east-1:123456789012:repository/owasp-ctf-sync",
      ]
    ])
    error_message = "The execution role must be able to pull the app, scorer and sync repositories — named, one ARN each."
  }

  assert {
    // The one "*" allowed, on the one action AWS offers no resource type for.
    // Any other statement with a "*" resource is the managed policy's
    // account-wide grant coming back.
    condition = alltrue([
      for s in local.execution_pull_policy.Statement :
      !contains(s.Resource, "*") || s.Action == ["ecr:GetAuthorizationToken"]
    ])
    error_message = "Only ecr:GetAuthorizationToken (which supports no resource-level permission) may use a \"*\" resource in the execution role's pull policy."
  }

  assert {
    // A wildcard INSIDE an ARN (repository/*, log-group:*) is the same hole
    // spelled differently; the log grant's trailing ":*" is the one legal
    // use, and it follows a named group.
    condition = alltrue(flatten([
      for s in local.execution_pull_policy.Statement : [
        for r in s.Resource :
        r == "*" || can(regex("^arn:aws:ecr:us-east-1:123456789012:repository/owasp-ctf-(app|scorer|sync)$", r)) || can(regex("^arn:aws:logs:us-east-1:123456789012:log-group:/ecs/owasp-ctf/(app|srh|scorer|sync):\\*$", r))
      ]
    ]))
    error_message = "Every resource in the pull policy must name this event's repository or log group."
  }

  assert {
    // Non-vacuity: the alltrue checks above pass over an empty policy.
    condition     = length(local.execution_pull_policy.Statement) == 3 && length(local.execution_pull_policy.Statement[2].Resource) == 4
    error_message = "Expected three statements (pull, auth token, logs), the log grant naming all four log groups."
  }

}

run "a_private_floating_scorer_ref_is_refused" {
  command = plan

  variables {
    enable_secure_development = true
    // What terraform.tfvars.example told operators to set before #476:
    // private on GHCR, and a floating tag.
    scorer_image = "ghcr.io/owasp-ctf-test/score:latest"
  }

  expect_failures = [var.scorer_image]
}

run "an_ecr_ref_in_another_account_is_refused" {
  command = plan

  variables {
    enable_secure_development = true
    sync_image                = "999999999999.dkr.ecr.us-east-1.amazonaws.com/owasp-ctf-sync:0123456789ab"
  }

  expect_failures = [var.sync_image]
}

run "an_ecr_ref_in_another_region_is_refused" {
  command = plan

  variables {
    enable_secure_development = true
    scorer_image              = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/owasp-ctf-scorer:mirror-0123456789ab"
  }

  expect_failures = [var.scorer_image]
}

run "a_digest_pinned_image_is_accepted" {
  command = plan

  variables {
    enable_secure_development = true
    scorer_image              = "ghcr.io/example/score@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    sync_image                = "ghcr.io/example/sync@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.scorer[0].container_definitions)[0].image == var.scorer_image
    error_message = "A digest-pinned scorer image must reach the task definition unchanged."
  }
}

// The bootstrap value: legal for `-target=aws_ecr_repository.main`, which
// plans no task definition, and refused by a precondition on a full plan —
// a sentence at plan time, where it used to be an apply that timed out on a
// CannotPullContainerError.
run "the_placeholder_is_refused_by_a_full_plan" {
  command = plan

  variables {
    enable_secure_development = true
    app_image                 = "PLACEHOLDER-deploy.sh-overwrites-this"
    scorer_image              = "PLACEHOLDER-deploy.sh-overwrites-this"
    sync_image                = "PLACEHOLDER-deploy.sh-overwrites-this"
  }

  expect_failures = [
    aws_ecs_task_definition.app,
    aws_ecs_task_definition.scorer,
    aws_ecs_task_definition.sync,
  ]
}

run "every_task_runs_x86_64_to_match_deploy_sh" {
  command = plan

  variables {
    enable_secure_development = true
  }

  assert {
    // deploy.sh builds and mirrors --platform linux/amd64 (test/aws.bats
    // asserts that half). An ARM64 task, or an arm64 image on X86_64, is an
    // exec format error after a clean apply.
    condition = alltrue([
      for td in concat(
        [aws_ecs_task_definition.srh, aws_ecs_task_definition.app],
        aws_ecs_task_definition.scorer,
        aws_ecs_task_definition.sync,
      ) :
      length(td.runtime_platform) == 1 &&
      td.runtime_platform[0].cpu_architecture == "X86_64" &&
      td.runtime_platform[0].operating_system_family == "LINUX"
    ])
    error_message = "Every task definition must set runtime_platform X86_64/LINUX — the architecture deploy.sh builds for."
  }

  assert {
    // Non-vacuity: the alltrue above passes over an empty list.
    condition     = length(aws_ecs_task_definition.scorer) == 1 && length(aws_ecs_task_definition.sync) == 1
    error_message = "Expected four task definitions on a Secure Development event."
  }
}

// --- a bad deploy rolls back; srh outlives a failover (#476) --------------

run "every_service_rolls_back_a_deployment_that_never_goes_healthy" {
  command = plan

  variables {
    enable_secure_development = true
  }

  assert {
    // Without it ECS relaunches failing tasks forever and `terraform apply`
    // sits on wait_for_steady_state until the provider times out.
    condition = alltrue([
      for s in concat(
        [aws_ecs_service.srh, aws_ecs_service.app],
        aws_ecs_service.scorer,
        aws_ecs_service.sync,
      ) :
      length(s.deployment_circuit_breaker) == 1 &&
      s.deployment_circuit_breaker[0].enable == true &&
      s.deployment_circuit_breaker[0].rollback == true
    ])
    error_message = "Every ECS service must enable the deployment circuit breaker with rollback."
  }

  assert {
    // Non-vacuity for the alltrue above.
    condition     = length(aws_ecs_service.scorer) == 1 && length(aws_ecs_service.sync) == 1
    error_message = "Expected four services on a Secure Development event."
  }
}

run "srh_survives_one_task_loss_and_an_elasticache_failover" {
  command = plan

  assert {
    // srh is the whole data path; one task is one host retirement from an
    // outage.
    condition     = aws_ecs_service.srh.desired_count >= 2
    error_message = "srh must run at least two tasks: it is the entire data path, and it is stateless behind a MULTIVALUE Cloud Map record."
  }

  assert {
    // Both tasks probe the same Redis, so a count alone does not help in a
    // failover: the probe itself has to outlast one, or ECS replaces every
    // srh task over an outage a restart cannot fix.
    condition = (
      jsondecode(aws_ecs_task_definition.srh.container_definitions)[0].healthCheck.retries *
      jsondecode(aws_ecs_task_definition.srh.container_definitions)[0].healthCheck.interval
    ) >= 120
    error_message = "srh's health check must tolerate at least 120 s of failed probes (retries x interval) so an ElastiCache failover does not get srh killed."
  }

  assert {
    // ...and still catch a broken first boot before the provider's 20 minute
    // steady-state wait gives up.
    condition = (
      jsondecode(aws_ecs_task_definition.srh.container_definitions)[0].healthCheck.startPeriod +
      jsondecode(aws_ecs_task_definition.srh.container_definitions)[0].healthCheck.retries *
      jsondecode(aws_ecs_task_definition.srh.container_definitions)[0].healthCheck.interval
    ) <= 300
    error_message = "srh's health check must still mark a task with a wrong AUTH token or endpoint UNHEALTHY within five minutes."
  }
}

run "sync_stays_a_single_poller" {
  command = plan

  variables {
    enable_secure_development = true
  }

  assert {
    // The circuit breaker added alongside must not have changed this: the
    // old task goes before the new one arrives.
    condition = (
      aws_ecs_service.sync[0].desired_count == 1 &&
      aws_ecs_service.sync[0].deployment_maximum_percent == 100 &&
      aws_ecs_service.sync[0].deployment_minimum_healthy_percent == 0
    )
    error_message = "sync must stay exactly one task, with min 0 / max 100 so a deployment never runs two pollers."
  }
}
