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
| srh task | 9 |
| ElastiCache `cache.t4g.micro` × 2 (primary + replica) | 24 |
| KMS key for the event's secrets | 1 |
| CloudWatch Logs, ECR storage | a few |
| **total** | **~125–140** |
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
   aws ssm put-parameter --type SecureString --key-id $K --name $P/GITHUB_TOKEN         --value "..."   # secure-development only
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

## Deploy

Two resources have to exist before the rest of the stack can be described:
**ECR**, because the image cannot be named until the registry exists, and the
**KMS key**, because the secrets in step 3 above must be encrypted with it.
Both are created by one targeted apply:

```sh
cd deploy/aws-terraform
cp terraform.tfvars.example terraform.tfvars    # then edit: domain, github_org, admin_logins
terraform init
terraform apply \
  -target=aws_ecr_repository.main \
  -target=aws_kms_alias.secrets                 # the registry and the secrets key
#   ... now run step 3's put-parameter commands, with --key-id ...
./deploy.sh                                     # build, push
terraform apply                                 # the rest of the stack
```

Targeting the *alias* pulls in the key it points at, so both arrive in one
step. The parameters themselves are not a dependency of the apply — task
definitions reference them by constructed ARN, not by data source — so a
missing one surfaces when a task starts, not at plan time. That is the one
sequencing mistake this order exists to prevent.

Afterwards a redeploy is one command:

```sh
./deploy.sh --apply
```

`deploy.sh` builds and pushes the image; Terraform cannot build one, which is
why this is a script and not an `apply`. The app takes no build-time
configuration at all (config v2, #386): `github_org` and `admin_logins` are
plain Terraform variables, mirrored into the app's task-definition environment
the same way `scorer_image` is — `terraform.tfvars` is this path's equivalent
of the wizard's `.env`. Change either and roll it out with `terraform apply`;
nothing needs rebuilding.

The tag is content-addressed to the git revision, and the ECR repository is
`IMMUTABLE`. Same code gives the same tag, so a re-run reports "already there"
and skips the build rather than failing. A dirty `apps/web` tree is tagged
`<revision>-dirty-<digest>`, where the digest is taken over the uncommitted
build context: change the tracked diff, or the set or contents of the
untracked, non-ignored **build-input** files under `apps/web` — `node_modules`
and `.next` are excluded, as is anything else the ignore rules exclude — and
the tag changes with it. A symlink counts as its target string, the way
`docker build` sends it. That is what keeps a work-in-progress deploy from
landing on the tag an earlier one already pushed — which, on an immutable
registry, would have redeployed the earlier image. `deploy.sh --dry-run` prints every command and runs none of them.

## Variables

Every input is in `variables.tf` with its own description;
`terraform.tfvars.example` shows each at its default. Three are required:

| Variable | Why it is required |
|---|---|
| `domain` | The session cookie is `Secure`. There is no working HTTP mode. |
| `app_image` | What ECS runs. `deploy.sh` writes it into `image.auto.tfvars`; the example carries a placeholder for the bootstrap apply. |
| `admin_logins` | The `/admin` allowlist. Its `validation` block refuses a roster with no login at plan time — empty, or nothing but separators like `" , "` — because that would forbid everyone, you included, and the only fix is another apply. |

`github_org` and `admin_logins` are read at runtime, not baked into the image.
`github_org` defaults to `""` and is legal empty only for an event that does
not run Secure Development — the app then falls back to bare repo names. With
`enable_secure_development = true` its own `validation` block requires it: sync
exits at startup without one, and the app would have no org to build fork links
from.

## Tear down

```sh
terraform destroy
```

The ECR repository is `force_delete` — a registry that refused to go because it
still held images would leave the teardown half-done, and the whole point of
this module is that `destroy` ends the event.

## Notes and gotchas

- **Terraform state now contains a secret.** The EC2 module could honestly say
  it did not; this one generates the ElastiCache AUTH token, and a generated
  password is in state by construction. Use an encrypted remote backend with
  restricted access for anything real.
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
  pins a version *and* a checksum. It is tracked (a dependency lock is not
  state — this is the module's `pnpm-lock.yaml`), and it carries hashes for
  four platforms: `linux_amd64`, which CI runs, plus `linux_arm64`,
  `darwin_amd64` and `darwin_arm64`, which operators apply from. **A platform
  with no recorded hash fails `terraform init` there**, which is the trap:
  Dependabot watches this directory (`.github/dependabot.yml`) and its provider
  bumps re-lock for its own platform only, quietly dropping the other three. So
  on any PR that changes a provider version, regenerate the full set before
  merging:

  ```sh
  cd deploy/aws-terraform
  terraform providers lock \
    -platform=linux_amd64 -platform=linux_arm64 \
    -platform=darwin_amd64 -platform=darwin_arm64
  ```

  CI will not catch a narrowed lock — `ubuntu-latest` is the one platform such
  a bump keeps working.
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
  credentials, no network and no apply, in either.

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
`REDIS_PASSWORD` and `SCORER_TOKEN`, which this module does not use, and
`REDIS_AUTH_TOKEN`, which it creates for you.
