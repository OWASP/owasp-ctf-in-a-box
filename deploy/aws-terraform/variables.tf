// Inputs to the ECS deployment. Every variable that can be set to something
// this module cannot honour carries a `validation` block, so the failure lands
// at plan time with a sentence rather than mid-apply with an AWS API error.

variable "region" {
  description = "AWS region for the whole stack."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Name prefix for every resource, and the ECS cluster name."
  type        = string
  default     = "owasp-ctf"

  // 28, not 32. AWS caps both an ALB name and a target group name at 32
  // characters, and this value reaches them as `${var.name}-alb` and
  // `${var.name}-app` (alb.tf) — four characters each. A 29-to-32 character
  // name passed this check and then failed mid-apply, which is precisely what
  // the file header says these blocks exist to prevent.
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,26}[a-z0-9]$", var.name))
    error_message = "name must be 3-28 lowercase alphanumerics or hyphens, not starting or ending with a hyphen. The cap is 28 rather than 32 because this prefixes the ALB (`-alb`) and target group (`-app`) names, which AWS limits to 32."
  }
}

variable "tags" {
  description = "Extra tags merged into the provider's default_tags."
  type        = map(string)
  default     = {}
}

variable "vpc_cidr" {
  description = "CIDR for the event VPC. Needs room for four subnets."
  type        = string
  default     = "10.42.0.0/16"

  validation {
    condition     = can(cidrsubnet(var.vpc_cidr, 4, 3))
    error_message = "vpc_cidr must leave room for at least four subnets four bits narrower (a /16 or /18 is ample)."
  }
}

variable "web_ingress_cidrs" {
  description = "Who may reach the ALB. Default is the public internet; narrow it for a private event."
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = length(var.web_ingress_cidrs) > 0
    error_message = "web_ingress_cidrs cannot be empty — the event would be unreachable."
  }
}

// --- naming and TLS --------------------------------------------------------

variable "domain" {
  description = "Public hostname for the event, e.g. ctf.example.org. Required: the session cookie is Secure, so there is no usable HTTP-only mode."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.domain))
    error_message = "domain must be a hostname such as ctf.example.org."
  }
}

variable "route53_zone_id" {
  description = "Route 53 zone for `domain`, IN THIS ACCOUNT. Set it and Terraform issues the ACM certificate and creates the alias record. Leave it empty and you must supply acm_certificate_arn and create the record yourself."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "Existing ACM certificate for `domain`, in THIS region. Required when route53_zone_id is empty."
  type        = string
  default     = ""

  validation {
    condition     = var.acm_certificate_arn == "" || can(regex("^arn:aws[a-z-]*:acm:", var.acm_certificate_arn))
    error_message = "acm_certificate_arn must be an ACM certificate ARN."
  }

  // The TLS requirement, ENFORCED rather than warned about.
  //
  // alb.tf's `check` block reports the same condition, but a failed `check` is
  // a warning: the apply proceeds, `local.certificate_arn` resolves to "", and
  // `aws_lb_listener.https` is handed an empty `certificate_arn` to fail on —
  // an AWS API error in place of the sentence the check wrote. The check stays
  // (it re-reports the same requirement on later plans, including ones where
  // the certificate has gone away), but the input is now refused up front.
  validation {
    condition     = var.acm_certificate_arn != "" || var.route53_zone_id != ""
    error_message = "Set route53_zone_id (Terraform issues the certificate) or acm_certificate_arn (you already have one). The session cookie is Secure, so there is no HTTP-only mode to fall back to."
  }
}

// --- what this event runs --------------------------------------------------

variable "github_org" {
  description = "The GitHub org the target forks live in. Read by the app and by sync at runtime (config v2, #386) — mirrored into both task definitions like scorer_image. Empty is legal only for an event that does not run Secure Development: the app then falls back to bare repo names. Required whenever enable_secure_development is true."
  type        = string
  default     = ""

  // Tied to enable_secure_development, not to the ingest mode, because the
  // org is what the module IS: `setup/ctf-setup.sh` requires GITHUB_ORG for
  // every non-empty SCORE_IMAGE, poll or push. In poll mode sync/src/config.js
  // throws at startup rather than treating a blank GITHUB_ORG as "nothing to
  // poll"; in push mode nothing throws, and that is the worse failure — the
  // scorer runs, the app renders bare repo names, and /challenges links every
  // contestant at a fork that has no org to live in. Left unset either way it
  // would be a plan-time silence; this turns it into the same plan-time
  // sentence scorer_image/sync_image already get.
  // trimspace, for admin_logins' reason: a value that is not empty is not
  // therefore a GitHub org. `" "` would pass `!= ""`, reach both task
  // definitions as-is, and name a fork path nothing can resolve.
  validation {
    condition     = !var.enable_secure_development || trimspace(var.github_org) != ""
    error_message = "github_org must name a GitHub org when Secure Development is enabled, in either ingest mode — blank or whitespace-only will not do: sync exits at startup without a usable GITHUB_ORG (see sync/src/config.js), and push mode leaves the app with no org to build fork links from."
  }
}

variable "admin_logins" {
  description = "Comma-separated GitHub logins allowed into /admin. REQUIRED — every event needs at least one admin. Read by the app at runtime (config v2, #386) — mirrored into the app task definition like scorer_image."
  type        = string
  default     = ""

  // UNCONDITIONAL, unlike github_org's rule above: there is no event shape
  // that wants an empty admin roster. This string IS the /admin allowlist, so
  // an empty one locks every login out of the panel — including whoever ran
  // the apply, and including the settings page that is the only way to open
  // registration, unpause scoring or archive the event. The lockout shows up
  // as a 403 long after a clean apply, and the only fix is another apply.
  // docs/hosting.md lists ADMIN_LOGINS as required for the same reason.
  //
  // The `default = ""` stays so the refusal is THIS sentence rather than a
  // bare interactive prompt for an unset variable in a non-interactive plan.
  // A non-empty STRING is not a non-empty roster: " , " passes `!= ""` and
  // then splits into nothing but blanks, which is the same lockout with a
  // longer variable. The rule counts actual logins.
  validation {
    condition     = length(compact([for login in split(",", var.admin_logins) : trimspace(login)])) > 0
    error_message = "admin_logins must name at least one GitHub login — a list of blanks (or an empty one) leaves /admin forbidding everyone, including whoever ran the apply."
  }
}

variable "github_client_id" {
  description = "The GitHub OAuth app's client id (public; its secret goes in SSM as GITHUB_CLIENT_SECRET). REQUIRED: the app signs every contestant in with it (apps/web/src/lib/auth.ts)."
  type        = string
  default     = ""

  // A client id is not a secret (GitHub shows it on every authorize URL), so
  // it travels as a plain environment value like github_org. Without it the
  // stack applies cleanly and then no one can sign in.
  validation {
    condition     = trimspace(var.github_client_id) != ""
    error_message = "github_client_id must be the GitHub OAuth app's client id: without it no one can sign in."
  }
}

variable "github_app_id" {
  description = "The numeric id of the GitHub App sync polls with (its private key goes in SSM as GITHUB_APP_PRIVATE_KEY). Required whenever enable_secure_development is true: sync/src/config.js exits at start-up without it."
  type        = string
  default     = ""

  validation {
    condition     = !var.enable_secure_development || trimspace(var.github_app_id) != ""
    error_message = "github_app_id must name the GitHub App sync polls with when Secure Development is enabled: sync exits at start-up without one."
  }

  // An App id is a number. A non-numeric one reached sync as a string it
  // could never authenticate with.
  validation {
    condition     = var.github_app_id == "" || can(regex("^[1-9][0-9]*$", var.github_app_id))
    error_message = "github_app_id must be the App's numeric id (a positive integer), e.g. \"123456\"."
  }
}

variable "github_app_installation_id" {
  description = "The GitHub App's installation id on github_org. Optional: when empty, sync picks the App's installation on github_org itself, and refuses to start polling if the App is not installed there."
  type        = string
  default     = ""

  // Empty is legal (sync finds the installation on github_org); anything else
  // must be a number, or sync refuses to start (sync/src/config.js).
  validation {
    condition     = var.github_app_installation_id == "" || can(regex("^[1-9][0-9]*$", var.github_app_installation_id))
    error_message = "github_app_installation_id must be empty (sync finds the installation on github_org) or a positive integer."
  }
}

variable "enable_secure_development" {
  description = "This event runs the secure-development module (GitHub forks + PR scoring). When false, no scorer and no sync run at all — the compose profiles' behaviour, ported."
  type        = bool
  default     = true
}

// --- images ----------------------------------------------------------------

variable "app_image" {
  description = "Fully qualified app image, e.g. <account>.dkr.ecr.<region>.amazonaws.com/<name>-app:<rev>. Built for linux/amd64 and pushed by deploy.sh — Terraform cannot build images — into the ECR repository this module creates, and written into image.auto.tfvars."
  type        = string
}

variable "scorer_image" {
  description = "The scorer image. deploy.sh MIRRORS the event org's scorer package into this stack's `<name>-scorer` ECR repository and writes the ref into image.auto.tfvars, so you do not set it by hand. Must be that repository in this account and region, or any digest-pinned (@sha256:) image Fargate can pull anonymously. Ignored unless enable_secure_development, and REQUIRED when it is on."
  type        = string
  default     = ""

  // Where the ref may point (#476). The scorer package is private by contract,
  // so `ghcr.io/<org>/score:latest` — what this variable used to be set to —
  // is a CannotPullContainerError on Fargate, and a floating tag would let a
  // re-push swap the rubric under a running event on the next task restart.
  // This stack's own ECR repository (IMMUTABLE tags, and the only one the
  // execution role may pull from) or a digest pin is refused neither.
  validation {
    condition = (
      !var.enable_secure_development ||
      var.scorer_image == "" ||
      var.scorer_image == local.image_placeholder ||
      can(regex("^[^@[:space:]]+@sha256:[0-9a-f]{64}$", var.scorer_image)) ||
      can(regex("^${replace(local.ecr_registry, ".", "\\.")}/${var.name}-scorer:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.scorer_image))
    )
    error_message = "scorer_image must be this stack's <name>-scorer ECR repository in this account and region (deploy.sh mirrors the scorer there and writes the ref into image.auto.tfvars), or a digest-pinned image (...@sha256:<64 hex>). A private or floating-tag ref such as ghcr.io/<org>/score:latest cannot be pulled by Fargate."
  }

  // The empty default is only legal while the module builds no scorer task.
  // With secure-development enabled it is passed straight through as a
  // container image, and ECS rejects a task definition with an empty one — so
  // the default turns into a mid-apply API error rather than a plan-time
  // sentence. Cross-variable validation needs Terraform 1.9; versions.tf
  // already requires 1.10.
  validation {
    condition     = !var.enable_secure_development || var.scorer_image != ""
    error_message = "scorer_image is required when enable_secure_development is true — the scorer task definition names it as its image."
  }
}

variable "sync_image" {
  description = "The sync image. deploy.sh builds ./sync for linux/amd64, pushes it to this stack's `<name>-sync` ECR repository and writes the ref into image.auto.tfvars, so you do not set it by hand. Must be that repository in this account and region, or any digest-pinned (@sha256:) image Fargate can pull anonymously. Ignored unless enable_secure_development, and REQUIRED when it is on."
  type        = string
  default     = ""

  // scorer_image's rule, for sync's repository: sync is published nowhere,
  // so there was never a registry to point this at but one the operator made
  // by hand, outside the stack and outside `terraform destroy` (#476).
  validation {
    condition = (
      !var.enable_secure_development ||
      var.sync_image == "" ||
      var.sync_image == local.image_placeholder ||
      can(regex("^[^@[:space:]]+@sha256:[0-9a-f]{64}$", var.sync_image)) ||
      can(regex("^${replace(local.ecr_registry, ".", "\\.")}/${var.name}-sync:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.sync_image))
    )
    error_message = "sync_image must be this stack's <name>-sync ECR repository in this account and region (deploy.sh builds and pushes sync there and writes the ref into image.auto.tfvars), or a digest-pinned image (...@sha256:<64 hex>)."
  }

  // Same rule as scorer_image's now that poll is the only score transport
  // (#377, ADR 56): a secure-development event always runs the poller, so it
  // always needs this image. It used to be narrower, because push mode had the
  // fork's Action POST to the scorer and ran no poller at all.
  validation {
    condition     = !var.enable_secure_development || var.sync_image != ""
    error_message = "sync_image is required when enable_secure_development is true — that event runs the sync task, which polls each fork for score comments."
  }
}

variable "srh_image" {
  description = "The Upstash-REST shim. Digest-pinned by default: this third-party image sits directly in the score read/write path, exactly as docker-compose.yml pins it."
  type        = string
  default     = "hiett/serverless-redis-http@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150"

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.srh_image))
    error_message = "srh_image must be digest-pinned (...@sha256:<64 hex>) — it is in the scoring path, and a floating tag there is a supply-chain hole (ADR 51)."
  }
}

// --- capacity --------------------------------------------------------------

variable "app_cpu" {
  description = "Fargate CPU units for the app task (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "app_memory" {
  description = "Fargate memory (MiB) for the app task."
  type        = number
  default     = 2048
}

variable "app_desired_count" {
  description = "How many app tasks to run. 2 keeps the event up through a deployment; 1 is cheaper."
  type        = number
  default     = 2

  validation {
    condition     = var.app_desired_count >= 1
    error_message = "app_desired_count must be at least 1."
  }
}

variable "cache_node_type" {
  description = "ElastiCache node type. t4g.micro carries an event of this size comfortably."
  type        = string
  default     = "cache.t4g.micro"
}

variable "cache_replica_count" {
  description = "Read replicas. 1 gives automatic failover across the two AZs; 0 is cheaper and single-AZ."
  type        = number
  default     = 1

  validation {
    condition     = var.cache_replica_count >= 0 && var.cache_replica_count <= 5
    error_message = "cache_replica_count must be between 0 and 5."
  }
}

variable "cache_snapshot_retention_days" {
  description = "Daily ElastiCache snapshots to keep. This is the module's durability story — see README: it is coarser than the EC2 box's AOF, and the event archive is the content-level backup."
  type        = number
  default     = 5

  validation {
    condition     = var.cache_snapshot_retention_days >= 1
    error_message = "cache_snapshot_retention_days must be at least 1: at 0 ElastiCache takes no backups at all, and a node replacement loses the event."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for every service."
  type        = number
  default     = 30
}

// --- secrets ---------------------------------------------------------------

variable "ssm_prefix" {
  description = "SSM Parameter Store prefix holding the event's SecureString secrets. The task execution role is scoped to exactly this prefix."
  type        = string
  default     = "/owasp-ctf"

  validation {
    condition     = can(regex("^/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$", var.ssm_prefix))
    error_message = "ssm_prefix must start with / and not end with one."
  }
}
