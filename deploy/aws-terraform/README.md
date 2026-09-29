# AWS deploy: ECS Fargate + ElastiCache + ALB (Terraform)

Stand the OWASP CTF in a Box control plane up as a **managed AWS stack** for the
duration of an event, then tear it down. `terraform apply` up, `terraform
destroy` down.

**This replaced a single EC2 instance running docker-compose.** If you deployed
an earlier version of this module, read
[Migrating from the EC2 box](#migrating-from-the-ec2-box) before upgrading — it
is a breaking change, not an in-place one.

Full walkthrough: [`docs/aws.md`](../../docs/aws.md).

## What it builds

```
                  internet
                     │  443
              ┌──────▼──────┐
              │  ALB + ACM  │  TLS terminates here
              └──────┬──────┘
                     │  3000
        ┌────────────▼────────────┐
        │  app  (Fargate, N=2)    │────┐
        └─────────────────────────┘    │
        ┌─────────────────────────┐    │ 80
        │  scorer / sync          │────┤   (Upstash REST only)
        │  (secure-development)   │    │
        └─────────────────────────┘    │
                            ┌──────────▼──────────┐
                            │  srh (Fargate)      │  the Upstash-REST shim
                            └──────────┬──────────┘
                                       │ 6379, rediss:// + AUTH
                            ┌──────────▼──────────┐
                            │  ElastiCache Redis  │  private subnets
                            └─────────────────────┘
```

`srh` stays. The app, scorer and sync speak **only** the Upstash REST API and
never raw Redis, so ElastiCache changed exactly one thing: what `srh` connects
*to*. Everything upstream of it is the same code as the compose stack.

**The isolation is in the security groups, not the subnets** — ADR 41's rule,
carried over intact:

| from | to | port |
|---|---|---|
| `web_ingress_cidrs` | ALB | 443 (80 redirects) |
| ALB | app | 3000 |
| app, scorer, sync | srh | 80 |
| app, sync | scorer | 4000 (Secure Development only) |
| srh | ElastiCache | 6379 |

The app security group has **no route to ElastiCache**. The bearer token is not
the only thing standing between a compromised app container and the raw
keyspace; the network is.

Tasks run in **public subnets with a public IP and no permitted inbound**,
because they need egress (pull images, read secrets, and for `sync`, reach
GitHub) and the alternatives cost real money: a NAT gateway is roughly the price
of the entire EC2 instance this module replaces, per AZ, before a byte moves.
`network.tf` argues this at length. ElastiCache is the exception and stays
private — it needs no egress at all.

## What it costs

The honest headline: **this is several times the price of the EC2 box it
replaces.** Rough `us-east-1` on-demand, per month, at the defaults:

| | ~USD/mo |
|---|---|
| ALB | 16 + LCUs |
| app tasks (2 × 1 vCPU / 2 GB) | 72 |
| srh tasks (2 × 0.25 vCPU / 0.5 GB) | 18 |
| ElastiCache `cache.t4g.micro` × 2 (primary + replica) | 24 |
| KMS key for the event's secrets | 1 |
| CloudWatch Logs, ECR storage | a few |
| **total** | **~135–150** |
| *the EC2 box this replaced (t3.medium + EBS)* | *~35* |

Order-of-magnitude only — check the AWS calculator for your region, and note
these are *monthly* figures for a stack you are expected to `destroy` after a
weekend event, where the real bill is hours, not months.

Turn the dials if that is too much: `app_desired_count = 1` (loses zero-downtime
deploys), `cache_replica_count = 0` (loses automatic failover, single-AZ). What
the money buys is managed durability, no instance to patch, and a load balancer
that can replace a task without dropping the event.

## Prerequisites (done once, off the stack)

1. **Provision the GitHub org** from your laptop: `./setup/ctf-setup.sh org`
   (needs your `gh` auth). AWS does not provision the org.
2. **Create the GitHub OAuth app** with the callback at your final domain,
   `https://<domain>/api/auth/callback/github` — so pick the domain first.
3. **Put the secrets in SSM Parameter Store** as `SecureString`s under
   `var.ssm_prefix`. The task execution role may read `<prefix>/*` and nothing
   else; task definitions reference them by `valueFrom`, so no secret is ever a
   plaintext env var in a definition. Note the `--key-id`, and that the key has
   to exist first — this step therefore lands *inside* the deploy sequence
   below, not before it:

   ```sh
   P=/owasp-ctf
   K=alias/owasp-ctf-secrets     # alias/<var.name>-secrets
   aws ssm put-parameter --type SecureString --key-id $K --name $P/BETTER_AUTH_SECRET   --value "$(openssl rand -base64 32)"
   aws ssm put-parameter --type SecureString --key-id $K --name $P/SRH_TOKEN            --value "$(openssl rand -hex 24)"
   aws ssm put-parameter --type SecureString --key-id $K --name $P/GITHUB_CLIENT_SECRET --value "..."
   # Secure Development only: the GitHub App's key (base64 of the .pem, as
   # sync/src/config.js decodes it) and the scorer's bearer token.
   aws ssm put-parameter --type SecureString --key-id $K --name $P/GITHUB_APP_PRIVATE_KEY --value "$(base64 < app.private-key.pem | tr -d '\n')"
   aws ssm put-parameter --type SecureString --key-id $K --name $P/SCORER_TOKEN           --value "$(openssl rand -hex 24)"
   ```

   **`--key-id` is not optional.** The stack creates one customer-managed KMS
   key per event (`kms.tf`) and the execution role's `kms:Decrypt` names *only*
   that key — a grant on `"*"` would let this role decrypt every SecureString
   in the account that delegates to IAM, including another event's. The cost of
   that scoping is that a parameter encrypted under any other key (the account
   default `alias/aws/ssm` included) cannot be read: the task fails to start
   with an `AccessDeniedException` on KMS, which names the key rather than the
   mistake. `terraform output secrets_kms_key_arn` prints it, and the
   post-apply `next_steps` output repeats these commands with it filled in.

   `REDIS_AUTH_TOKEN` and `SRH_CONNECTION_STRING` are **not** in that list:
   Terraform generates both and writes them under `<prefix>/` itself, already
   encrypted with that key, so operators and tasks read them from one place.

## Remote state (required for a real event)

The state holds the generated ElastiCache AUTH token, and it is the only handle
on the stack: lose the laptop that holds a local `terraform.tfstate` mid-event
and there is no redeploy, no rollback and no clean destroy. So a real event
keeps it in S3. The bucket cannot be part of this stack, so create it once, by
hand, in the account the stack runs in:

```sh
B=<your-state-bucket>; R=us-east-1
aws s3api create-bucket --bucket $B --region $R      # outside us-east-1 add: --create-bucket-configuration LocationConstraint=$R
aws s3api put-bucket-versioning --bucket $B --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket $B \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket $B \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
```

Then, in `deploy/aws-terraform`:

```sh
cp backend.tf.example backend.tf     # edit bucket, key and region
terraform init                       # `terraform init -migrate-state` if you already applied locally
```

Limit the bucket to whoever runs the apply: anyone who can read the object can
read the AUTH token. `backend.tf` is gitignored like `terraform.tfvars`, and
`use_lockfile = true` gives S3-native locking, with no DynamoDB table
(Terraform 1.10 or later, which `versions.tf` already requires). CI never sees a
backend: it runs `terraform init -backend=false` and the mocked `terraform
test`.

## Deploy

Two kinds of resource have to exist before the rest of the stack can be
described: **ECR**, because no image can be named until its registry exists,
and the **KMS key**, because the secrets in step 3 above must be encrypted with
it. One targeted apply creates both:

```sh
cd deploy/aws-terraform
cp terraform.tfvars.example terraform.tfvars    # then edit: domain, github_org, admin_logins, github_client_id, github_app_id
cp backend.tf.example backend.tf                # then edit (see Remote state)
terraform init
terraform apply \
  -target=aws_ecr_repository.main \
  -target=aws_kms_alias.secrets                 # the registries and the secrets key
#   ... now run step 3's put-parameter commands, with --key-id ...
docker login ghcr.io                            # Secure Development: the scorer package is private
./deploy.sh --scorer-source ghcr.io/<your-event-org>/score:latest   # build, mirror, push, write image.auto.tfvars
terraform apply                                 # the rest of the stack
```

Targeting the *alias* pulls in the key it points at, and targeting the
repository resource creates every repository this event needs: `app` always,
`scorer` and `sync` on a Secure Development event. The parameters themselves
are not a dependency of the apply — task definitions reference them by
constructed ARN, not by data source — so a missing one surfaces when a task
starts, not at plan time. That is the one sequencing mistake this order exists
to prevent. The image variables in `terraform.tfvars.example` are placeholders
for the bootstrap apply only: a full `terraform apply` while any of them is
still the placeholder is refused at plan time with a sentence naming
`deploy.sh`.

Afterwards a redeploy is one command:

```sh
./deploy.sh --apply        # with SCORE_IMAGE exported, or --scorer-source again
```

### The images

`deploy.sh` publishes every image the stack runs into the stack's own ECR
repositories, and writes their refs into `image.auto.tfvars`; Terraform cannot
build an image, which is why this is a script and not an `apply` (#476):

| Image | How it gets to ECR | Tag |
|---|---|---|
| app | built from the **repo root** with `-f apps/web/Dockerfile` | the git revision |
| sync | built from `./sync` (Secure Development only) | the git revision |
| scorer | **mirrored**: `docker pull --platform linux/amd64` of `--scorer-source`, then tagged and pushed (Secure Development only) | `mirror-<first 12 hex of the source's digest>` |

- **Every image is `linux/amd64`.** Every task definition sets
  `runtime_platform` to `X86_64`, and every build and the mirror pass
  `--platform linux/amd64` (builds also pass `--provenance=false
  --sbom=false`, so each tag is one plain manifest). Without it an Apple
  Silicon laptop pushes arm64 images, and the tasks die with an exec format
  error after a clean apply.
- **The scorer is mirrored, not rebuilt.** The leaderboard's scorer must be the
  same artifact the forks' judge pulls. Its package is private by contract
  (`ctf-setup.sh` keeps it so until launch), and Fargate cannot pull it, so
  `deploy.sh` copies it into this stack's `<name>-scorer` repository.
  `--scorer-source` defaults to `$SCORE_IMAGE`, the event `.env`'s name for the
  same image; `docker login` to its registry first. Its tag comes from the
  source's digest, so a floating `:latest` cannot swap the rubric under a
  running event: an upstream re-push only reaches ECS through a new
  `deploy.sh` run and an apply.
- **`scorer_image` and `sync_image` are validated.** Each must be this stack's
  ECR repository in this account and region, or a digest-pinned
  (`@sha256:`) image. A `ghcr.io/<org>/score:latest` ref, which is what these
  were set to before #476, is refused at plan time.
- **The execution role pulls these repositories and nothing else.** It carries
  a named policy for the app, scorer and sync repositories and the four log
  groups, not the managed `AmazonECSTaskExecutionRolePolicy`, which grants
  both on `"*"`. The one `"*"` left is `ecr:GetAuthorizationToken`, which AWS
  offers no resource-level permission for.
- **A bad deploy rolls back.** Every service has the ECS deployment circuit
  breaker on with rollback, so a revision whose tasks never go healthy (bad
  image, missing secret) returns to the last working one. To roll back by
  hand, put the previous tags in `image.auto.tfvars` (`aws ecr describe-images
  --repository-name <name>-app` lists them) and `terraform apply`.

The app takes no build-time
configuration at all (config v2, #386): `github_org` and `admin_logins` are
plain Terraform variables, mirrored into the app's task-definition environment
the same way `scorer_image` is — `terraform.tfvars` is this path's equivalent
of the wizard's `.env`. Change either and roll it out with `terraform apply`;
nothing needs rebuilding.

The app and sync tags are content-addressed to the git revision, and every ECR
repository is `IMMUTABLE`. Same code gives the same tag, so a re-run reports
"already there" and skips the build rather than failing. A dirty `apps/web` (or
`sync/`) tree is tagged `<revision>-dirty-<digest>`, where the digest is taken
over that directory's uncommitted build context: change the tracked diff, or
the set or contents of the untracked, non-ignored **build-input** files under
it — `node_modules`
and `.next` are excluded, as is anything else the ignore rules exclude — and
the tag changes with it. A symlink counts as its target string, the way
`docker build` sends it. That is what keeps a work-in-progress deploy from
landing on the tag an earlier one already pushed — which, on an immutable
registry, would have redeployed the earlier image. `deploy.sh --dry-run` prints every command and runs none of them.

## Variables

Every input is in `variables.tf` with its own description;
`terraform.tfvars.example` shows each at its default. Four are required:

| Variable | Why it is required |
|---|---|
| `domain` | The session cookie is `Secure`. There is no working HTTP mode. |
| `app_image` | What ECS runs. `deploy.sh` writes it into `image.auto.tfvars`; the example carries a placeholder for the bootstrap apply. |
| `scorer_image`, `sync_image` | Secure Development only. `deploy.sh` writes both into `image.auto.tfvars` (see The images). Each must be this stack's ECR repository in this account and region, or digest-pinned. |
| `github_client_id` | The GitHub OAuth app's client id (public; the secret is `GITHUB_CLIENT_SECRET` in SSM). Without it no one can sign in. |
| `admin_logins` | The `/admin` allowlist. Its `validation` block refuses a roster with no login at plan time — empty, or nothing but separators like `" , "` — because that would forbid everyone, you included, and the only fix is another apply. |

`github_org` and `admin_logins` are read at runtime, not baked into the image.
`github_org` defaults to `""` and is legal empty only for an event that does
not run Secure Development — the app then falls back to bare repo names. With
`enable_secure_development = true` its own `validation` block requires it: sync
exits at startup without one, and the app would have no org to build fork links
from. `github_app_id` follows the same rule: sync authenticates to GitHub as an
App, so a Secure Development event needs its id here and its private key in SSM
(`GITHUB_APP_PRIVATE_KEY`); `github_app_installation_id` is optional.

The scorer gets a Cloud Map name (`scorer.<name>.internal:4000`) and its own
security group, which accepts `:4000` from the app (the leaderboard and the
challenge catalogue) and from sync (`POST /score`) and nothing else. sync stays
outbound only. `stack.tftest.hcl` reads `docker-compose.yml` and fails if any
environment key compose gives the app, the scorer or sync is missing from its
ECS task (#476).

## Tear down

```sh
terraform destroy
```

Every ECR repository (app, and scorer and sync when they exist) is
`force_delete` — a registry that refused to go because it still held images
would leave the teardown half-done, and the whole point of this module is that
`destroy` ends the event. The state bucket is not part of the stack and
survives it; delete it yourself once you no longer need the state.

## Notes and gotchas

- **Terraform state now contains a secret.** The EC2 module could honestly say
  it did not; this one generates the ElastiCache AUTH token, and a generated
  password is in state by construction. A real event keeps it in the encrypted,
  access-restricted S3 backend under Remote state above.
- **srh runs two tasks and tolerates a failover.** srh is the whole data path,
  so a single task was one host retirement from an outage. Both tasks probe the
  same Redis, so the health check allows 8 × 15 s of failures before ECS
  replaces a task: an ElastiCache failover must not get srh killed, since a
  restart cannot fix Redis. A wrong AUTH token or endpoint still fails every
  probe from first boot, so a broken deployment goes unhealthy within about
  2.5 minutes and the circuit breaker rolls it back. sync stays at exactly
  one task.
- **Durability is snapshots, not AOF.** The EC2 box ran Redis with AOF on an
  EBS volume; ElastiCache gives daily snapshots
  (`cache_snapshot_retention_days`, default 5) plus in-memory replication. A
  restore is therefore **coarser-grained** than the old fsync-per-write story:
  you lose up to a day, not up to a second. For event content — questions,
  challenges, flags — use the app's own archive export (Admin → Event → Event
  archive), which is finer-grained, portable, and the backup that actually
  matters for re-running an event.
- **srh does not trust the OS certificate store.** It verifies TLS against
  **CAStore**, an Elixir library whose Mozilla bundle is embedded in the srh
  release, not `/etc/ssl/certs`. Two consequences: ElastiCache verifies fine
  (that bundle carries Amazon Root CA 1–4), and mounting your own CA into the
  container does nothing. If a handshake to the cache ever fails with
  `Unknown CA`, the fix is a newer `srh_image`, not an OS trust store change —
  the trust anchors are frozen at the digest you pinned.
- **`srh_image` is digest-pinned and the module refuses a floating tag.** That
  container sits between the app and every byte of event data; `:latest` there
  is a supply-chain decision, so it has to be made deliberately.
- **`.terraform.lock.hcl` is committed, and Dependabot will narrow it.** The
  providers are the other half of that supply-chain decision: `versions.tf`
  constrains them with `~>`, which floats, so the lock file is what actually
  pins a version *and* a checksum. It is tracked — a dependency lock is not
  state, this is the module's `pnpm-lock.yaml` — and it carries `h1:` hashes
  for the four platforms that run `init` against this module: `linux_amd64`,
  which CI runs, plus `linux_arm64`, `darwin_amd64` and `darwin_arm64`, which
  operators apply from.

  Be precise about what that list buys, because it is easy to overstate. **A
  missing platform `h1:` does not break `terraform init`.** A registry-sourced
  lock also carries `zh:` hashes, which cover every platform, so a writable
  `init` on an unlocked platform validates against those, succeeds, and appends
  the `h1:` itself; `-lockfile=readonly` also succeeds and only warns
  (`Provider lock file not updated`). `init` fails when *no* recorded checksum
  matches the package — a lock carrying `h1:` hashes alone, which is what an
  `init` against a pre-populated plugin cache writes, or a filesystem/network
  mirror serving a package the recorded hashes do not cover.

  What the four-platform list buys is that the checksums are reviewed once,
  here, rather than appended on each operator's first `init` — which otherwise
  leaves everyone with a dirty worktree and a lock diff nobody intended — and
  that a mirror can be verified against official registry checksums, the case
  `terraform providers lock` exists for. Dependabot watches this directory
  (`.github/dependabot.yml`) and re-locks for its own platform only, so
  regenerate the full set on any PR that moves a provider version:

  ```sh
  cd deploy/aws-terraform
  terraform providers lock \
    -platform=linux_amd64 -platform=linux_arm64 \
    -platform=darwin_amd64 -platform=darwin_arm64
  ```
- **State is reconstructible in poll mode.** `sync` re-reads scores from the
  GitHub PR comments, so a replaced task repopulates the leaderboard. The
  poller's cursor lives in Redis, not on disk, so Fargate's ephemeral storage
  costs nothing here — at worst a restarted task re-polls.
- **DNS in another account?** Leave `route53_zone_id` empty, set
  `acm_certificate_arn` to a certificate in this region, and point your own
  record at the `alb_dns_name` output. Terraform manages the record only when
  the zone is in the same account.
- **Everything is tagged** via the provider's `default_tags`
  (`Project`/`ManagedBy`/`Event`), so one filter finds the whole event. Add
  owner/cost-centre/expiry with `var.tags`.
- **CI-validated, never applied.** `.github/workflows/terraform.yml` runs
  `fmt -check`, `validate` and `test`; `stack.tftest.hcl` renders the container
  definitions at plan time with `mock_provider` and asserts on them, because
  `validate` never inspects rendered output — which is how a fundamentally
  broken bring-up script survived in the EC2 version of this module unnoticed.
  `test/aws.bats` covers `deploy.sh`, the part Terraform cannot see. No AWS
  credentials, no network and no apply, in either. One thing is executed for
  real: `test/srh-healthcheck.bats` runs `srh-healthcheck.sh`, the file the srh
  health check is read from, inside the pinned srh image against a real Redis.
  The first check called `GET /ping`, which that srh answers with a 404, and
  every string assertion passed over it (#476). The suite skips without
  docker; `terraform.yml` runs it with `SRH_HEALTHCHECK_REQUIRED=1`, where a
  skip is a failure.

## Migrating from the EC2 box

Breaking. The old module produced one EC2 instance with an Elastic IP and a
Redis AOF volume; this one produces an ECS stack behind an ALB. There is no
in-place upgrade path — an `apply` over the old state would destroy the instance
and build the new stack around a database that never existed.

Do it as a move, not an upgrade:

1. **Export the event** from the running box: Admin → Event → *Event archive →
   Export*. That file carries the authored content — quiz questions and their
   answer key, classic and AI challenges with flags, hints, categories — which
   is what you cannot recreate.
2. **Note what the archive does not carry**: contestant progress and teams. If
   the event is mid-flight, finish it on the old box. This migration is for
   between events.
3. **Stand the new stack up** in a fresh state file, following Deploy above.
   Keep the old one running until the new one answers on a test domain.
4. **Import the archive**: Admin → Event → *Event archive → Import*.
5. **Move DNS** to the ALB, and update the OAuth callback if the domain changed.
6. **`terraform destroy` the old stack** from its own state directory.

Secrets carry over unchanged if you keep the same `ssm_prefix` — except
`REDIS_PASSWORD`, which this module does not use, and `REDIS_AUTH_TOKEN`,
which it creates for you. A Secure Development event also needs
`SCORER_TOKEN` (the scorer and sync share it) and `GITHUB_APP_PRIVATE_KEY`
in SSM; create them as in the prerequisites if the old stack did not have
them. `GITHUB_TOKEN` is no longer read.
