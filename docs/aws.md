---
title: Deploy on AWS
---

[← Docs home](index.md)

# Deploy on AWS (ECS Fargate, Terraform)

The kit runs on AWS as a **managed stack**: the app, the Upstash-REST shim and
the secure-development services on **Fargate**, behind an **ALB** with an ACM
certificate, over **ElastiCache for Redis**. `terraform apply` up, `terraform
destroy` down — still the single-shot lifecycle for an ephemeral event, with no
instance to patch.

The module lives at
[`deploy/aws-terraform/`](https://github.com/OWASP/owasp-ctf-in-a-box/tree/main/deploy/aws-terraform);
this page is the walkthrough. It stands up the **runtime** control plane only —
provisioning the GitHub org is a separate one-time step (below).

**This replaced a single EC2 instance running docker-compose.** If you deployed
the earlier module, the upgrade is a move rather than an `apply`: see
[the migration steps](https://github.com/OWASP/owasp-ctf-in-a-box/tree/main/deploy/aws-terraform#migrating-from-the-ec2-box).

## Why ECS now, when one EC2 box was the point

The old module's argument was real and is worth stating before dismantling it:
compose on one host needed no translation to task definitions, scoring needed
no inbound at all, and a replaced box repopulated its leaderboard from the
GitHub PR comments.

What changed the answer is **where the event's data lives**. On the box, Redis
was a container writing an append-only file to an EBS volume: durability was
yours to get right, and a lost volume or a bad fsync was a lost event. That is
the wrong thing to hand-roll for a day people have blocked out. ElastiCache
makes it AWS's problem — snapshots, replication, automatic failover across two
AZs — and once Redis is managed the rest follows almost for free: the ALB gives
native health checks and a task swap without dropping the event, and Fargate
removes the instance.

Two things did **not** change:

- **`srh` stays.** The app, scorer and sync speak only the Upstash REST API and
  never raw Redis, so ElastiCache changed exactly one thing — what `srh`
  connects *to*. Everything above it is the same code as compose.
- **The isolation is still in the security groups.** ADR 41 put the boundary
  there rather than in the network topology, and it stays: only the ALB reaches
  the app, only the app and workers reach `srh`, and only `srh` reaches
  ElastiCache. The app has no route to Redis at all.

What it costs is the honest tradeoff, and the module README
[itemises it](https://github.com/OWASP/owasp-ctf-in-a-box/tree/main/deploy/aws-terraform#what-it-costs):
roughly four times the EC2 box at the defaults. Two variables bring it down if
that is too much.

## Prerequisites (once, off the stack)

1. **Provision the org** from your laptop: `./setup/ctf-setup.sh org` (uses your
   `gh` auth + local `docker login ghcr.io`). See the
   [Quickstart](hosting.md#quickstart-zero-to-a-scored-event).
2. **Pick the domain first**, then create the GitHub apps with the OAuth
   callback at `https://<domain>/api/auth/callback/github` (`ctf-setup.sh
   app-manifest`/`app-config` and `oauth-app`/`oauth-config`).
3. **Store the secrets in SSM Parameter Store** as `SecureString`s under a path
   prefix (default `/owasp-ctf`), each encrypted with the event's own KMS
   key (`--key-id alias/<name>-secrets`). Task definitions reference them by
   `valueFrom`, so no secret is ever a plaintext environment variable — the
   generated Redis AUTH token included, which is why the assembled `rediss://`
   connection string is itself a `SecureString` rather than an environment
   entry on the srh task. Because the stack creates that key, this step lands
   between the two applies below rather than before them. The
   `aws ssm put-parameter` list, and why `--key-id` is not optional, are in the
   module
   [README](https://github.com/OWASP/owasp-ctf-in-a-box/tree/main/deploy/aws-terraform#prerequisites-done-once-off-the-stack).

## Deploy

Two things must exist before the rest of the stack can be described: **ECR**,
since the image cannot be named until the registry does, and the **KMS key**
that step 3's secrets are encrypted with. One targeted apply creates both.

```sh
cd deploy/aws-terraform
cp terraform.tfvars.example terraform.tfvars    # edit: domain, github_org, admin_logins
terraform init
terraform apply \
  -target=aws_ecr_repository.main \
  -target=aws_kms_alias.secrets                 # the registry and the secrets key
#   ... now store the secrets (step 3), with --key-id ...
./deploy.sh                                     # build, push
terraform apply                                 # the rest of the stack
```

Afterwards a redeploy is one command:

```sh
./deploy.sh --apply
```

Terraform creates the VPC (two AZs; a public tier for the ALB and tasks, a
private tier for ElastiCache alone), the five security groups above, the
ElastiCache replication group with in-transit encryption and an AUTH token it
generates for you, the ALB with its ACM certificate, the ECR repository, and the
Fargate services for whichever modules this event runs — a quiz-only event
brings up no scorer and no poller, the same rule as the compose profiles.

**`deploy.sh` builds and pushes the image; Terraform cannot.** The app takes no
build-time configuration at all (config v2, #386): `github_org` and
`admin_logins` are two Terraform variables, set in `terraform.tfvars` — this
path's equivalent of the wizard's `.env` — and mirrored into the app's
task-definition environment the same way `scorer_image` is. Change either and
`terraform apply` rolls it out; nothing has to be rebuilt or repushed.
`admin_logins` must name at least one login, and `github_org` is required
whenever `enable_secure_development` is true: `sync` exits at startup without
one, and the app would build fork links with no org to point them at. Both are
refused at plan time, not at apply.

The image tag is content-addressed to the git revision, and ECR is set to
immutable tags, so re-running with nothing changed reports "already there" and
skips the build instead of failing. A dirty `apps/web` tree gets
`<revision>-dirty-<digest>`, where the digest is taken over the uncommitted
build context: change the tracked diff, or the set or contents of the
untracked, non-ignored **build-input** files under `apps/web` — `node_modules`
and `.next` are excluded, along with anything else your git ignore rules
exclude — and the tag changes with it. That is what keeps a work-in-progress
deploy off the tag an earlier one already pushed, which on an immutable
registry would have redeployed the earlier image.
`./deploy.sh --dry-run` prints every command and runs none of them.

Watch a rollout:

```sh
aws ecs describe-services --cluster <cluster_name> --services app
aws logs tail /ecs/<name>/app --follow
```

Both names come from the `terraform output`.

## Tear down

```sh
terraform destroy
```

## Notes

- **Which build is live?** `GET https://<domain>/health` returns the running
  revision and build time. That is also what the ALB health-checks — liveness
  only, no Redis, deliberately. A probe that read Redis would deregister every
  app task during a blip, and replacing tasks cannot fix Redis; the app's own
  reads fail open for the same reason.
- **HTTPS is not optional.** The session cookie is `Secure`, so `domain` is a
  required variable and there is no working HTTP mode to fall back to.
- **Terraform state now holds a secret.** The old module could honestly say it
  did not; this one generates the ElastiCache AUTH token, and a generated
  password is in state by construction. Use an encrypted remote backend with
  restricted access.
- **Durability is snapshots, not AOF** — daily, five retained by default. A
  restore loses up to a day rather than up to a second. For the authored content
  (questions, challenges, flags, hints) the app's own event archive export is
  finer-grained and portable, and is the backup that matters for re-running an
  event.
- **Everything is tagged** (`Project` / `ManagedBy` / `Event`, extend with
  `var.tags`) so the event's resources are easy to filter and tear down.
- **DNS in another account** (the stack in a throwaway account, the zone in your
  main one): leave `route53_zone_id` empty, set `acm_certificate_arn` to a
  certificate in the stack's region, and point your own record at the
  `alb_dns_name` output. Terraform manages the record only when the zone is in
  the same account.
- **Changes to the module are CI-validated, never applied** —
  `.github/workflows/terraform.yml` runs `terraform fmt -check`, `validate` and
  `test` on any change under `deploy/aws-terraform/`. `terraform test` is the
  one that reads **rendered** output: `validate` never looks at it, which is how
  a fundamentally broken bring-up script survived in the EC2 version unnoticed.
  The tests render the container definitions at plan time behind
  `mock_provider` — no AWS credentials, no network — and assert that only `srh`
  may reach ElastiCache, that the cache connection is `rediss://`, that no
  secret is baked in as plaintext, and that scorer and sync appear only for the
  modules the event runs. `deploy.sh` has its own bats suite for the half
  Terraform cannot see.
- Kubernetes is tracked separately (Helm chart,
  [issue #54](https://github.com/OWASP/owasp-ctf-in-a-box/issues/54)).
