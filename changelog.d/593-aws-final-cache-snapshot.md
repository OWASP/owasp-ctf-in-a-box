- **Fixed: `terraform destroy` on the AWS module leaves a final ElastiCache
  snapshot (#593).** It is named `<name>-redis-final`, holds the whole event
  store (flags, logins and sessions), and is billed until you delete it with
  `aws elasticache delete-snapshot --snapshot-name <name>-redis-final`. A later
  destroy of a stack with the same `name` fails while it still exists; see
  `docs/aws.md` → Tear down. It does not replace the event archive export.
