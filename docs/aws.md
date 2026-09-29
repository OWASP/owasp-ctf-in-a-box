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
  the app, only the app, sync and the scorer reach `srh`, only the app and
  sync reach the scorer (`:4000`), and only `srh` reaches ElastiCache. The app has no
  route to Redis at all.

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

4. **Create the remote-state bucket.** Required for a real event: the state
   holds the generated Redis AUTH token, and it is the only handle on the
   stack, so it cannot live only on one laptop. Create a versioned, encrypted,
   private S3 bucket once, then `cp backend.tf.example backend.tf` and edit it.
   The module
   [README](https://github.com/OWASP/owasp-ctf-in-a-box/tree/main/deploy/aws-terraform#remote-state-required-for-a-real-event)
   has the commands. CI never uses a backend.

## Deploy

Two things must exist before the rest of the stack can be described: **ECR**,
since no image can be named until its registry does, and the **KMS key** that
step 3's secrets are encrypted with. One targeted apply creates both, including
the `scorer` and `sync` repositories on a Secure Development event.

```sh
cd deploy/aws-terraform
cp terraform.tfvars.example terraform.tfvars    # edit: domain, github_org, admin_logins, github_client_id, github_app_id
cp backend.tf.example backend.tf                # edit: your state bucket (step 4)
terraform init
terraform apply \
  -target=aws_ecr_repository.main \
  -target=aws_kms_alias.secrets                 # the registries and the secrets key
#   ... now store the secrets (step 3), with --key-id ...
docker login ghcr.io                            # Secure Development: the scorer package is private
./deploy.sh --scorer-source ghcr.io/<your-event-org>/score:latest   # build, mirror, push
terraform apply                                 # the rest of the stack
```

The image variables in `terraform.tfvars.example` are placeholders for that
bootstrap apply only. A full `terraform apply` while one is still the
placeholder is refused at plan time with a sentence naming `deploy.sh`.

Afterwards a redeploy is one command:

```sh
./deploy.sh --apply        # with SCORE_IMAGE exported, or --scorer-source again
```

**`deploy.sh` publishes every image the stack runs** into the stack's own ECR
repositories and writes their refs into `image.auto.tfvars` (#476). It builds
the app from the repo root with `-f apps/web/Dockerfile`, and sync from
`./sync`. It **mirrors** the scorer: it pulls `--scorer-source` (default
`$SCORE_IMAGE`, the event `.env`'s value), then tags and pushes it. Fargate
cannot pull the scorer package itself, because the package is private until
launch, and sync is published nowhere. Everything is built or pulled for
`linux/amd64`, the architecture every task definition declares. An Apple
Silicon laptop otherwise pushes arm64 images, and the tasks die with an exec
format error. The mirror's tag comes from the source's digest, so an upstream
re-push of `:latest` cannot swap the rubric mid-event. `scorer_image` and
`sync_image` are refused at plan time unless they name this stack's ECR
repository or are digest-pinned. The execution role may pull those
repositories and nothing else.

Terraform creates the VPC (two AZs; a public tier for the ALB and tasks, a
private tier for ElastiCache alone), the security groups above (five, plus
the scorer's own on a Secure Development event), the
ElastiCache replication group with in-transit encryption and an AUTH token it
generates for you, the ALB with its ACM certificate, the ECR repositories, and the
Fargate services for whichever modules this event runs — a quiz-only event
brings up no scorer and no poller, the same rule as the compose profiles.

**Terraform cannot build an image; `deploy.sh` does.** The app takes no
build-time configuration at all (config v2, #386): `github_org` and
`admin_logins` are two Terraform variables, set in `terraform.tfvars` — this
path's equivalent of the wizard's `.env` — and mirrored into the app's
task-definition environment the same way `scorer_image` is. Change either and
`terraform apply` rolls it out; nothing has to be rebuilt or repushed.
`admin_logins` must name at least one login and `github_client_id` must be the
OAuth app's client id (without it no one can sign in). `github_org` and
`github_app_id` are required whenever `enable_secure_development` is true:
`sync` authenticates as a GitHub App and exits at startup without either. All
of these are refused at plan time, not at apply. The Secure Development
secrets in SSM are the App's private key (`GITHUB_APP_PRIVATE_KEY`, base64 of
the `.pem`) and the scorer's bearer token (`SCORER_TOKEN`), which the scorer
and sync share.

The app and sync tags are content-addressed to the git revision, and ECR is set to
immutable tags, so re-running with nothing changed reports "already there" and
skips the build instead of failing. A dirty `apps/web` (or `sync/`) tree gets
`<revision>-dirty-<digest>`, where the digest is taken over the uncommitted
build context: change the tracked diff, or the set or contents of the
untracked, non-ignored **build-input** files under that directory — `node_modules`
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

**A bad deploy rolls itself back.** Every service has the ECS deployment
circuit breaker on with rollback. A revision whose tasks never go healthy
(a bad image, a missing secret, the wrong architecture) returns to the last
working one, instead of being relaunched until `terraform apply` times out. To
roll back by hand, put the previous tags in `image.auto.tfvars` and run
`terraform apply`. `aws ecr describe-images --repository-name <name>-app` lists
them.

**srh runs two tasks** and its health check tolerates two minutes of failures.
srh is the whole data path, and during an ElastiCache failover both tasks'
probes fail together, so ECS must not replace them over an outage a restart
cannot fix. A wrong AUTH token still fails every probe from first boot, so a
broken deployment goes unhealthy within about 2.5 minutes and rolls back.

## Running the event on AWS

The event-day runbook for this stack. [docs/operations.md](operations.md) is
the runbook for the event itself (the admin panel, the modules, launch day),
and it applies here unchanged. This section covers only what is different
on ECS: where the logs are, how to get a shell, what each failure looks
like, and how to roll back and tear down. Symptom-first recipes are in
[docs/troubleshooting.md](troubleshooting.md).

**Not yet verified on a live stack.** This module has not been applied end
to end yet. The rehearsal tracked in
[#476](https://github.com/OWASP/owasp-ctf-in-a-box/issues/476) runs every
drill below against a throwaway stack, and it is where this runbook gets
corrected. Run that rehearsal before you rely on AWS for a real event.

Every command below uses these names:

| Placeholder | Where it comes from |
|---|---|
| `<cluster>` | `terraform output -raw cluster_name` (the `name` variable) |
| `<name>` | the `name` variable in `terraform.tfvars` (default `owasp-ctf`) |
| `<domain>` | the `domain` variable; `terraform output -raw event_url` |
| services | `app`, `srh`, and on a Secure Development event `scorer` and `sync` (`terraform output services_running`) |
| log groups | `/ecs/<name>/<service>`, one per service |
| ElastiCache | replication group `<name>-redis` |
| target group | `<name>-app` |

### Before the event

- **Point the external monitor at `https://<domain>/health/deep`**, as
  [docs/hosting.md](hosting.md#monitoring) describes. It is the one check
  that sees a dead dependency, because every read in the app fails open.
  The ALB checks only `/health`, which is liveness and never reads Redis.
- **There is no per-IP rate limit in front of the ALB.** The Fly box gets
  one from the Cloudflare rule in
  [docs/hosting.md](hosting.md#cloudflare-in-front-of-the-box). This module
  creates no WAF, so on AWS only the app's own per-login limits apply. To
  get the same protection, put the domain behind Cloudflare with that rule.
  Using an ACM certificate with Cloudflare's Full (strict) mode works.
- **Dispatch both heavy scoring gates on the release commit** (see
  [The offline gates](operations.md#the-offline-gates)).
- **Run the load pass** described in [Load testing on AWS](#load-testing-on-aws).

### Watching the stack

The state of every service in one table:

```sh
aws ecs describe-services --cluster <cluster> --services app srh scorer sync \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount,rollout:deployments[0].rolloutState}' \
  --output table
```

Drop `scorer sync` on an event without Secure Development. `running` equal
to `desired` and `COMPLETED` on every row means the stack is settled.

A service's recent events. These show a task that failed its health check,
a task that could not pull its image, or a deployment that is still waiting:

```sh
aws ecs describe-services --cluster <cluster> --services app \
  --query 'services[0].events[:10].[createdAt,message]' --output text
```

Why a task stopped. Check this first whenever a service keeps replacing
tasks:

```sh
aws ecs list-tasks --cluster <cluster> --service-name app --desired-status STOPPED
aws ecs describe-tasks --cluster <cluster> --tasks <task-arn> \
  --query 'tasks[].{stopped:stoppedReason,containers:containers[].{name:name,exit:exitCode,reason:reason,health:healthStatus}}'
```

The logs, per service:

```sh
aws logs tail /ecs/<name>/app --follow --since 10m
aws logs tail /ecs/<name>/sync --follow           # the poller's own account of itself
```

Whether the ALB sees healthy app tasks:

```sh
aws elbv2 describe-target-health --target-group-arn \
  "$(aws elbv2 describe-target-groups --names <name>-app --query 'TargetGroups[0].TargetGroupArn' --output text)"
```

Container Insights is on for the cluster, so CPU and memory per service are
in CloudWatch under **Container Insights → ECS**. For the cache, watch the
ElastiCache metrics `EngineCPUUtilization` and `DatabaseMemoryUsagePercentage`.

### A shell inside a task (ECS Exec)

ECS Exec gives you a shell in a running container. It is the only way into
the private side of the stack: srh accepts connections only from the app,
the scorer and sync, and the cache accepts them only from srh. You need the
AWS CLI's
[Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
installed locally. ECS Exec is on by default (`enable_ecs_exec`); a stack
applied with `enable_ecs_exec = false` answers `execute command was not
enabled`.

```sh
TASK="$(aws ecs list-tasks --cluster <cluster> --service-name app --query 'taskArns[0]' --output text)"
aws ecs execute-command --cluster <cluster> --task "$TASK" --container app \
  --interactive --command "/bin/sh"
```

The container name is the service name (`app`, `srh`, `scorer`, `sync`).
Inside the app container there is no `redis-cli`, and the app has no route
to Redis by design. To run a Redis command, send it through srh with the
URL and token the container already holds. This is the AWS equivalent of
the `redis-cli HGETALL ctf:admin:settings` line in
[docs/troubleshooting.md](troubleshooting.md):

```sh
node -e 'fetch(process.env.UPSTASH_REDIS_REST_URL,{method:"POST",headers:{authorization:"Bearer "+process.env.UPSTASH_REDIS_REST_TOKEN,"content-type":"application/json"},body:JSON.stringify(process.argv.slice(1))}).then(r=>r.text()).then(console.log)' \
  HGETALL ctf:admin:settings
```

Replace `HGETALL ctf:admin:settings` with any other command, for example
`HGETALL ctf:sync:status` for the poller's heartbeat. Treat anything that
writes as break-glass: it bypasses the admin panel's validation and its
audit log.

### Freezing scoring

Freeze from `/admin` → **Event** → **Freeze scoring**, exactly as on any
other box. See the **Freeze** entry in
[the admin panel section](operations.md#organizer-admin-panel). It stops
ingestion and the scorer's writes, and nothing is lost: judged PRs wait in
their comments until you unfreeze.

If `/admin` itself is unreachable, set the same field from an ECS Exec shell
in the app container, with the `node -e` line above and these arguments:

```text
HSET ctf:admin:settings paused 1     # freeze
HDEL ctf:admin:settings paused       # unfreeze: absent means not paused, never "0"
```

The app, the scorer and sync all read that field on their next check, so no
restart is needed.

### Failure drills

What each failure looks like, and what to do. The rehearsal in #476 runs
each one and records how long it takes.

**An app task dies.** The ALB stops sending traffic to it and serves from
the other task (`app_desired_count` defaults to 2). ECS starts a
replacement without any action from you. The operator sees one target go
`unhealthy` or `draining` in `describe-target-health`, and a `stopped` event
on the `app` service. Players see nothing, or one failed request. Do
nothing unless the replacement also stops. Then read its `stoppedReason`
(above) and the `/ecs/<name>/app` log.

**srh restarts.** srh is the whole data path: every page, submission and
grading script goes through it. The module runs **two** srh tasks behind the
same Cloud Map name, so losing one leaves the other serving. If both are down,
nothing reads or writes: pages still render, because reads fail open, but
nothing scores in any module, `/health/deep` answers 503 with
`"redis": "down"`, and your monitor fires. ECS replaces a failed task by
itself.
Expect the outage to last as long as a Fargate task start: the network
interface, the image pull and the health check's start period. Nothing is
lost. A quiz or flag submission made during the outage gets an error, and
the contestant can submit again once srh is back. Secure Development scores
wait in the PR comments until sync reaches srh again. If the replacement keeps failing, read its
`stoppedReason` and the `/ecs/<name>/srh` log. A `WRONGPASS` or `NOAUTH`
there means the connection string does not match the cache: see
[docs/troubleshooting.md](troubleshooting.md#services-log-noauth-authentication-required).

**ElastiCache fails over.** With `cache_replica_count` at 1 or more (the
default), ElastiCache promotes the replica on its own. During the switch,
writes fail, and `/health/deep` may report `"redis": "down"`. srh connects
through the primary endpoint, whose DNS name moves to the new primary. Do
nothing but watch `/health/deep` return to `"redis": "ok"`. Then confirm
that a **write** works, for example answer a quiz question in a test
account: a demoted node still answers `PING`. If srh's health check fails
for long enough during the switch, ECS replaces srh too, which adds a task
start to the outage. To rehearse this, run the failover on purpose. A plain
reboot does not exercise it:

```sh
aws elasticache test-failover --replication-group-id <name>-redis --node-group-id 0001
```

With `cache_replica_count = 0` there is no replica, so there is no failover
either. A lost node is then an outage that lasts until ElastiCache replaces
it.

**sync restarts.** A restart can come from a deploy, a crash or AWS retiring
the host. The module runs one poller and stops the old task before it starts
the new one. sync keeps its cursor, seen cache and `/admin` counters in
Redis (`ctf:sync:state`, ADR 64), not on the task's disk, so a new sync task
resumes where the old one stopped:

- The heartbeat on `/admin` (**ingested**, **dropped**, the last drop
  reason) carries over.
- A per-contestant Secure Development reset stays reset: the new task does
  not re-read the comments the old one already ingested.
- If Redis (through srh) is unreadable when the task starts, sync **holds**
  and retries instead of starting from an empty cursor. The log repeats
  `cannot load poll state from Redis (ctf:sync:state)`, and `sync.ageSec` in
  `/health/deep` keeps climbing until srh answers again. Fix srh first (see
  "srh restarts" above); sync then resumes on its own.

Only deleting `ctf:sync:state` makes sync re-read every score comment from
the start. That is safe for totals, because the scorer writes each solve with
`HSETNX`, but it undoes any per-contestant reset and zeroes the counters.

To restart sync yourself, for example after you fix its configuration:

```sh
aws ecs update-service --cluster <cluster> --service sync --force-new-deployment
```

Then watch `sync.ageSec` in `/health/deep` drop back under a minute.

### Rolling back a bad deploy

`./deploy.sh --apply` pushes a new, content-tagged app image and runs
`terraform apply`. ECS starts the new tasks before it stops the old ones, so
old tasks keep serving while new ones fail their health check. Every service
has the deployment circuit breaker on with rollback, so a revision whose tasks
never go healthy is rolled back to the last working one, and the service
events say so. `terraform apply` then reports the failed deployment rather
than waiting out its timeout.

1. Read why the new tasks stop (`describe-tasks` above). A wrong image
   architecture, a secret the tasks cannot decrypt, or an app that exits at
   start each show up there.
2. Find the previous image tag. ECR tags are immutable and name the git
   revision:

   ```sh
   aws ecr describe-images --repository-name <name>-app \
     --query 'sort_by(imageDetails,&imagePushedAt)[].imageTags' --output text
   ```

3. Put that tag back in `deploy/aws-terraform/image.auto.tfvars`, the file
   `deploy.sh` writes:

   ```hcl
   app_image = "<ecr_app_repository_url>:<previous-tag>"
   ```

4. `terraform apply`. The previous task definition rolls out the same way
   the bad one did.

A change to `admin_logins`, `github_org` or any other variable rolls back
the same way: set the old value and `terraform apply`.

### Load testing on AWS

`scripts/load-test.sh`, described in
[docs/operations.md](operations.md#the-box-under-load-scriptsload-testsh),
**cannot run against this stack as it is.** It is written for Fly:

- It finds the machine with `fly machines list` and requires `--app`.
- It uploads `scripts/load-seed.mjs` into the app container with
  `fly ssh sftp`, because the seeder is not in the app image. It runs the
  seed, `--clean` and `--break-lock` with `fly ssh console`. ECS Exec opens
  a shell but has no file upload, so there is no equivalent way to get the
  seeder into an app task.
- It samples memory with `fly ssh console … cat /proc/meminfo`, and a run
  with no memory sample fails by design.

What is missing is an ECS mode for the harness: finding a task with
`aws ecs list-tasks`, getting the seeder into it, and reading memory from
Container Insights. Until that exists, run the same pass by hand:

1. **Data.** `/admin` → **Seed demo data** gives a small board. Without the
   seeder there is no way to put 200 synthetic contestants on the board, so
   this pass measures a smaller board than the Fly harness does. Say so in
   the result.
2. **Traffic.** Run the harness's own two phases, one after the other, from
   your laptop against the ALB domain:

   ```sh
   npx --yes autocannon -d 60 -R 10 -c 10 https://<domain>/leaderboard
   npx --yes autocannon -d 60 -R 2 -c 10 "https://<domain>/leaderboard?display=1"
   ```

3. **The bar.** The same as the harness: `/leaderboard` p97.5 under 1.5 s,
   `?display=1` under 1 s, zero 5xx, zero errors and zero timeouts. Read CPU
   and memory from Container Insights while it runs, for srh as well as the
   app, because srh's 0.25 vCPU is the smallest size in the stack. Also read
   `EngineCPUUtilization` on the cache.
4. **Clean up** with a **Master reset** before registration opens. It
   removes the seeded demo data along with everything else.

## Tear down

`terraform destroy` deletes the cache and its automatic snapshots with it.
The module takes no final snapshot, so export everything you want to keep
**first**:

1. `/admin` → **Event** → **Event archive** → **Export**. It carries the
   authored content and settings, not contestant progress (see
   [Archiving and replaying an event](operations.md#archiving-and-replaying-an-event)).
2. Save the final standings: the `/leaderboard` page, and on a Secure
   Development event the scorer's `/leaderboard` JSON, from an ECS Exec
   shell in the app container: `wget -qO- "$LEADERBOARD_API_URL/leaderboard"`.
3. Run `./setup/ctf-setup.sh teardown` for the org, as on any other box.

Then:

```sh
terraform destroy
```

Afterwards, check for leftovers:

```sh
aws resourcegroupstaggingapi get-resources --tag-filters Key=Event,Values=<name>
aws ssm describe-parameters --parameter-filters Key=Name,Option=BeginsWith,Values=<ssm_prefix>
aws logs describe-log-groups --log-group-name-prefix /ecs/<name>
```

The KMS key stays listed in `PendingDeletion` for its deletion window,
which is expected. **Delete the SSM parameters you created by hand**
(`BETTER_AUTH_SECRET`, `GITHUB_CLIENT_SECRET`, `SRH_TOKEN`, and on a Secure
Development event `GITHUB_APP_PRIVATE_KEY` and `SCORER_TOKEN`). Terraform
does not manage them and they carry no `Event` tag, so the tag query above
passes while they still exist:

```sh
aws ssm delete-parameters --names <ssm_prefix>/BETTER_AUTH_SECRET <ssm_prefix>/GITHUB_CLIENT_SECRET \
  <ssm_prefix>/SRH_TOKEN <ssm_prefix>/GITHUB_APP_PRIVATE_KEY <ssm_prefix>/SCORER_TOKEN
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
  password is in state by construction. Keep it in the encrypted,
  access-restricted S3 backend from Prerequisites step 4.
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
  modules the event runs. One run reads `docker-compose.yml` and fails if an
  environment key compose gives the app, the scorer or sync is missing from
  its ECS task: that gap once left this stack with no sign-in and no scoring
  (#476). `deploy.sh` has its own bats suite for the half
  Terraform cannot see.
- Kubernetes is tracked separately (Helm chart,
  [issue #54](https://github.com/OWASP/owasp-ctf-in-a-box/issues/54)).
