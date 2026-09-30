#!/usr/bin/env bats
#
# scripts/load-test.sh removes the seeder it uploaded into the container on
# every exit path, and that cleanup never changes the run's own exit status.
# A stub `fly` records every call and plays the machine; no Fly account is
# used. The decisive assertion is always the test's last statement.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  STUB="$BATS_TEST_TMPDIR/bin"
  CALLS="$BATS_TEST_TMPDIR/fly.calls"
  mkdir -p "$STUB"
  # CLEAN_REPLY is what the seeder "prints" for --clean; empty means it failed.
  cat > "$STUB/fly" <<EOF
#!/bin/sh
echo "\$*" >> "$CALLS"
case "\$*" in
  "machines list"*) echo '[{"id":"m1"}]' ;;
  "ssh sftp put"*) exit 0 ;;
  *"--clean"*) if [ -n "\$CLEAN_REPLY" ]; then echo "\$CLEAN_REPLY"; exit 0; fi; echo "boom"; exit 1 ;;
  *"rm -f /tmp/load-seed-"*) exit \${RM_STATUS:-0} ;;
esac
exit 0
EOF
  chmod +x "$STUB/fly"
}

@test "--clean removes the uploaded seeder from the container" {
  run env PATH="$STUB:$PATH" CLEAN_REPLY='{"mode":"clean","keys":0,"fields":0,"commands":0}' "$REPO_ROOT/scripts/load-test.sh" --app demo --clean
  [ "$status" -eq 0 ]
  grep -q 'container app -C rm -f /tmp/load-seed-.*\.mjs' "$CALLS"
}

@test "a failed --clean still removes the seeder and still fails" {
  run env PATH="$STUB:$PATH" CLEAN_REPLY='' "$REPO_ROOT/scripts/load-test.sh" --app demo --clean
  grep -q 'rm -f /tmp/load-seed-' "$CALLS"
  [ "$status" -eq 1 ]
}

@test "a failing rm does not turn a successful clean into a failure" {
  run env PATH="$STUB:$PATH" RM_STATUS=1 CLEAN_REPLY='{"mode":"clean","keys":0,"fields":0,"commands":0}' "$REPO_ROOT/scripts/load-test.sh" --app demo --clean
  grep -q 'rm -f /tmp/load-seed-' "$CALLS"
  [ "$status" -eq 0 ]
}

@test "nothing is removed when the upload never happened" {
  cat > "$STUB/fly" <<EOF
#!/bin/sh
echo "\$*" >> "$CALLS"
case "\$*" in
  "machines list"*) echo '[{"id":"m1"}]' ;;
  "ssh sftp put"*) exit 1 ;;
esac
exit 0
EOF
  run env PATH="$STUB:$PATH" "$REPO_ROOT/scripts/load-test.sh" --app demo --clean
  [ "$status" -eq 1 ] && [ -z "$(grep -F 'rm -f' "$CALLS")" ]
}
