- **Changed: `docs/aws.md` says what to do when a `terraform plan` on the AWS module removes a
  security group from the cache (#593).** A group attached to the replication
  group by hand shows up as drift. `docs/aws.md` → "A plan removes a security
  group from the cache" says how to check that srh keeps its path to Redis
  before applying, and `stack.tftest.hcl` now checks that the cache sits only in
  the module's own security group (ADR 41).
