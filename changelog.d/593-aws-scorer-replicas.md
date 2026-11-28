- **Added: `scorer_desired_count` on the AWS module (#593).** The scorer ran
  one task with no way to change it. Set `scorer_desired_count = 2` to keep
  scoring up while a scorer task is replaced. The default stays 1, so an
  existing stack plans no change, and sync still runs one task, since it is
  the single poller.
