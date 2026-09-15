#!/usr/bin/env bats
#
# Checks on the fly.io module. There is no `terraform validate` equivalent for
# fly.toml, and no account to deploy against in CI, so these assert the
# invariants a broken port would violate — the same posture as
# `deploy/aws-terraform/stack.tftest.hcl`, which exists because `validate`
# never inspects rendered output.
#
# The render is exercised FOR REAL (it needs `docker compose`, which the CI
# runner has). That matters: this module's job is to turn docker-compose.yml
# into something flyctl can deploy, and every bug it has had so far lived in
# the OUTPUT, not in the source.
#
# Each assertion is the LAST statement in its test on purpose (AGENTS.md): a
# `[[ ... ]]` or a negated pipeline that is not last does not fail the test.

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  FLY="$REPO/deploy/fly"

  # Strip comments before asserting on structure. These files EXPLAIN the
  # blocks they deliberately omit, so a naive grep for "[[services]]" matches
  # the paragraph saying why there isn't one — a test that fails on its own
  # documentation. This has bitten three times; it is not hypothetical.
  uncommented() { grep -v '^[[:space:]]*#' "$1"; }

  # A complete fixture env so --dry-run reaches the deploy steps. An empty file
  # exits early on the required-value checks, which would make the dry-run
  # tests below pass for the wrong reason.
  #
  # Every secret value here is DISTINCTIVE and at least 8 characters, because
  # the leak tests below grep the rendered output for these exact strings. A
  # short or common value (say "secret") would match incidental text and turn
  # a real check into noise.
  cat > "$BATS_TEST_TMPDIR/env" <<'ENV'
EVENT_URL=https://owasp-ctf.fly.dev
BETTER_AUTH_SECRET=FIXTUREAUTHSECRETzzzzzzzzzzzz
GITHUB_CLIENT_ID=fixture-client-id
GITHUB_CLIENT_SECRET=FIXTURECLIENTSECRETyyyyyyyy
SCORER_TOKEN=FIXTURESCORERTOKENxxxxxxxx
SRH_TOKEN=FIXTURESRHTOKENwwwwwwwwww
REDIS_PASSWORD=FIXTUREREDISPASSvvvvvvvvv
SCORE_IMAGE=ghcr.io/fixture-org/score:latest
FLY_REGION=gru
GITHUB_APP_ID=1
GITHUB_APP_PRIVATE_KEY=RklYVFVSRVBSSVZBVEVLRVl1dXV1dQ==
GITHUB_APP_INSTALLATION_ID=1
GITHUB_ORG=fixture-org
ADMIN_LOGINS=fixture-admin
ENV

  RENDERED="$BATS_TEST_TMPDIR/compose.fly.yml"
  render() {
    "$FLY/render-compose.sh" --env-file "$BATS_TEST_TMPDIR/env" --out "$RENDERED" \
      --app-image reg/app:t --sync-image reg/sync:t --scorer-image reg/scorer:t
    # EVERY render test asserts through this, so it asserts the file exists.
    # A negative check ("no service name is left as a host") passes trivially
    # against a file that was never written — which happened while developing
    # this suite, and read as a pass.
    [ -s "$RENDERED" ]
  }
  # The render shells out to `docker compose`. Skipping is honest when docker
  # is absent (a laptop without it running the rest of the suite); CI has it,
  # so these never silently vanish where it counts.
  need_docker() {
    command -v docker >/dev/null || skip "docker not available"
    docker compose version >/dev/null 2>&1 || skip "docker compose not available"
  }
}

# ---------------------------------------------------------------------------
# fly.toml — one app, one machine.
# ---------------------------------------------------------------------------

@test "fly.toml deploys the rendered compose file, not a Dockerfile" {
  uncommented "$FLY/fly.toml" | grep -qF '[build.compose]'
}

@test "the compose file it names is the one render-compose.sh writes" {
  # flyctl resolves THIS path against the WORKING DIRECTORY, not against the
  # config file's directory — the opposite of `--dockerfile`, which resolves
  # against the config. The two rules are inconsistent inside flyctl, and
  # getting it wrong fails late, after images are pushed and IPs provisioned:
  #
  #   failed to provision seed volumes: failed to read compose file:
  #   open compose.fly.yml: no such file or directory
  #
  # deploy.sh always runs from the repo root, so the rendered file goes there
  # and this stays a bare filename.
  uncommented "$FLY/fly.toml" | grep -qE '^ *file *= *"compose\.fly\.yml"'
}

@test "fly.toml's machine check watches /health, and only /health" {
  # Liveness only (issue #437): /health depends on nothing but the Node
  # process. /health/deep answers 503 when Redis or the scorer is down, which
  # is exactly what a machine restart cannot fix — pointing Fly's check at it
  # would cycle the one machine over a dependency blip. The monitor watches
  # deep; Fly watches liveness.
  # One AND-list, so every clause gates the result (a non-final failed
  # command is errexit-exempt in bats — see AGENTS.md).
  uncommented "$FLY/fly.toml" | grep -qF '[[http_service.checks]]' &&
    uncommented "$FLY/fly.toml" | grep -qE '^ *path *= *"/health"$' &&
    [ -z "$(uncommented "$FLY/fly.toml" | grep -F '/health/deep')" ]
}

@test "deploy.sh renders to the path fly.toml will actually look in" {
  # The pair above and below only agree if deploy.sh writes the file where
  # flyctl reads it. Asserting each half separately is what let them disagree.
  grep -qE '^RENDERED="compose\.fly\.yml"' "$FLY/deploy.sh"
}

@test "the rendered compose file is gitignored" {
  # It is generated on every deploy and derives from .env.fly. Committing it
  # would put a build artefact in review diffs — and .env.fly itself reached
  # this public repo twice already, so nothing downstream of it gets tracked.
  cd "$REPO" && git check-ignore -q compose.fly.yml
}

@test "the rendered filename is not one flyctl auto-detects" {
  # flyctl auto-detects compose.yaml, compose.yml, docker-compose.yaml and
  # docker-compose.yml in the working directory. The rendered file sits at the
  # repo root, right beside the real docker-compose.yml, so its name must not
  # collide with that list — and the repo's own compose file must never be
  # deployed raw, with its ${VAR}s and two build: services intact.
  name="$(grep -E '^ *file *= *"' "$FLY/fly.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')"
  case "$name" in
    compose.yaml|compose.yml|docker-compose.yaml|docker-compose.yml)
      echo "$name collides with flyctl's auto-detected names"; return 1 ;;
  esac
  [ -n "$name" ]
}

@test "public traffic goes to the app container's port, not srh or scorer" {
  # Only ONE container in a machine receives inbound requests, chosen by
  # matching internal_port. 3000 is the app. If this ever said 80 the public
  # would be talking to srh — the datastore's REST API — directly.
  uncommented "$FLY/fly.toml" | grep -qE '^ *internal_port *= *3000'
}

@test "the committed default never auto-stops" {
  # This machine holds redis and the sync poller, not just a web server. A
  # stopped machine is a stopped datastore and a poller that is not polling,
  # and no inbound request arrives to wake it while an event is quiet — score
  # comments pile up on GitHub uncollected.
  #
  # FLY_AUTO_STOP opts out of this per deployment (see the autostop tests
  # below); the value HERE is what an organizer gets without asking.
  uncommented "$FLY/fly.toml" | grep -qE '^ *auto_stop_machines *= *false'
}

@test "exactly ONE volume is declared" {
  # Fly permits no more than one volume per machine, and says so only when the
  # machine is created — after images are pushed and IPs provisioned:
  #
  #   invalid config.mounts, only 1 volume supported
  #
  # redis's append-only file and sync's cursor therefore share this volume
  # under separate directories.
  count="$(grep -v '^[[:space:]]*#' "$FLY/fly.toml" | grep -c 'source = ')"
  [ "$count" = "1" ]
}

@test "redis and sync are pointed at separate directories inside that volume" {
  # Sharing one volume is only safe if the two never collide. Both paths are
  # knobs in docker-compose.yml, defaulting to the local layout, and init
  # writes the Fly values into the env file.
  grep -qF 'REDIS_DIR: ${REDIS_DIR:-/data}' "$REPO/docker-compose.yml"
  grep -qF 'STATE_PATH: ${STATE_PATH:-/state/state.json}' "$REPO/docker-compose.yml"
  mount="$(grep -v '^[[:space:]]*#' "$FLY/fly.toml" | sed -n 's/^ *destination = "\(.*\)".*/\1/p')"
  # Both Fly paths must sit UNDER the mount, or the data is written to the
  # machine's ephemeral overlay and silently lost on the next deploy.
  grep -qF "REDIS_DIR=$mount/" "$FLY/deploy.sh"
  grep -qF "STATE_PATH=$mount/" "$FLY/deploy.sh"
}

@test "sync's entrypoint hands the state dir to node on a root-owned volume" {
  need_docker
  cd "$REPO"
  # Issue #364. sync is `USER node` in spirit — the poller must not run as
  # root — but a fresh Fly volume is root-owned, so state.js's
  # mkdirSync(dirname(STATE_PATH)) failed with EACCES before the first poll
  # whenever STATE_PATH pointed at the volume. The image now starts as root,
  # creates and chowns the directory, and drops to node before exec. This
  # builds the real image and runs it against a volume seeded the way Fly
  # hands one over (root-owned, holding only lost+found), because the
  # ownership semantics are only real on a Linux volume — a bind mount from a
  # macOS host relaxes them and made the redis sibling of this bug invisible.
  img="ctf-sync-entrypoint-test:$$"
  vol="ctf-sync-entrypoint-test-$$"
  docker build -q -t "$img" ./sync >/dev/null
  docker volume create "$vol" >/dev/null
  docker run --rm --entrypoint sh -v "$vol:/data" "$img" \
    -c 'mkdir -m 700 /data/lost+found && chown 0:0 /data /data/lost+found && chmod 755 /data'
  run docker run --rm -v "$vol:/data" -e STATE_PATH=/data/sync/state.json "$img" \
    sh -c 'id -u; stat -c "%u:%g" /data/sync; touch /data/sync/state.json && echo writable'
  docker volume rm -f "$vol" >/dev/null 2>&1 || true
  docker rmi -f "$img" >/dev/null 2>&1 || true
  [ "$status" -eq 0 ]
  # The command ran as node, in a node-owned directory it could write to.
  echo "$output" | grep -qx '1000'
  echo "$output" | grep -qx '1000:1000'
  echo "$output" | grep -qx 'writable'
}

@test "sync's entrypoint never follows a symlink when it chowns" {
  need_docker
  cd "$REPO"
  # CWE-59, found in review. Once the entrypoint has run, everything under
  # dirname(STATE_PATH) is writable by node — so a compromised poller could
  # replace the state file, or the directory itself, with a symlink to a
  # root-owned file and have the NEXT restart chown the target to node. Both
  # shapes are planted here (as root, the way an attacker's write would land
  # on the volume) and the entrypoint runs over them; the targets must still
  # be root's afterwards, and only the link inodes may have changed hands.
  img="ctf-sync-symlink-test:$$"
  vol="ctf-sync-symlink-test-$$"
  docker build -q -t "$img" ./sync >/dev/null
  docker volume create "$vol" >/dev/null
  docker run --rm --entrypoint sh -v "$vol:/data" "$img" -c '
    mkdir -p /data/sync && ln -s /usr/local/bin/docker-entrypoint.sh /data/sync/state.json
    ln -s /usr/local/bin /data/evil'
  # 1. state file is a symlink to the entrypoint script
  run docker run --rm -v "$vol:/data" -e STATE_PATH=/data/sync/state.json "$img" \
    sh -c 'stat -c "script=%u" /usr/local/bin/docker-entrypoint.sh'
  s1="$status"; o1="$output"
  # 2. the state DIRECTORY is a symlink to a root-owned directory
  run docker run --rm -v "$vol:/data" -e STATE_PATH=/data/evil/state.json "$img" \
    sh -c 'stat -c "bindir=%u" /usr/local/bin'
  s2="$status"; o2="$output"
  docker volume rm -f "$vol" >/dev/null 2>&1 || true
  docker rmi -f "$img" >/dev/null 2>&1 || true
  [ "$s1" -eq 0 ]
  [ "$s2" -eq 0 ]
  echo "$o1" | grep -qx 'script=0'
  echo "$o2" | grep -qx 'bindir=0'
}

@test "deploy.sh warns when the env file predates the single-volume knobs" {
  need_docker
  cd "$REPO"
  # The fixture env deliberately has neither knob, like an env file written
  # before init learned to add them — which is how a live deployment ran for
  # weeks with sync's cursor on ephemeral disk (#364). The warning has to name
  # the exact lines to add, so it is asserted on one of them.
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env"
  echo "$output" | grep -qF 'STATE_PATH=/data/sync/state.json'
  # And with both present the warning is gone — a warning that always fires
  # is one nobody reads.
  cp "$BATS_TEST_TMPDIR/env" "$BATS_TEST_TMPDIR/env.knobs"
  printf 'REDIS_DIR=/data/redis\nSTATE_PATH=/data/sync/state.json\n' >> "$BATS_TEST_TMPDIR/env.knobs"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.knobs"
  [ -z "$(echo "$output" | grep -F 'predates the single-volume layout')" ]
}

@test "--profile app alone really excludes sync — secdev is not a no-op" {
  # Naming a service explicitly on `docker compose config` makes compose
  # enable whatever profile it needs on its own, bypassing --profile
  # filtering entirely — so a test that named `sync`/`scorer` here would keep
  # passing even if docker-compose.yml's profile string silently drifted from
  # "secdev" to something else, or if render-compose.sh's derivation broke.
  # `config --services` (no service names) is asked instead, which
  # discriminates on --profile the same way `up` actually would.
  cd "$REPO"
  need_docker
  run env SRH_TOKEN=t SCORER_TOKEN=t BETTER_AUTH_SECRET=t REDIS_PASSWORD=p \
    GITHUB_CLIENT_ID=i GITHUB_CLIENT_SECRET=s SCORE_IMAGE=x \
    docker compose -f docker-compose.yml --profile app config --services
  # The absence check below passes trivially against an ERROR — a compose file
  # that failed to interpolate lists no services at all, which is exactly what
  # "sync is not here" looks like. The exit status and the positive `app` line
  # are what make the negative assertion mean something.
  [ "$status" -eq 0 ]
  echo "$output" | grep -qx 'app'
  [ -z "$(echo "$output" | grep -x 'sync')" ]
}

@test "the local defaults are unchanged by the Fly layout" {
  # The knobs exist for Fly, but a compose stack must keep writing exactly
  # where it always has — otherwise every existing local event silently starts
  # from an empty datastore. The profile test above already proved --profile
  # secdev is what makes sync appear at all, so naming it here is safe.
  cd "$REPO"
  run env SRH_TOKEN=t SCORER_TOKEN=t BETTER_AUTH_SECRET=t REDIS_PASSWORD=p \
    GITHUB_CLIENT_ID=i GITHUB_CLIENT_SECRET=s SCORE_IMAGE=x \
    docker compose -f docker-compose.yml --profile secdev --profile app config redis sync
  echo "$output" | grep -qF 'REDIS_DIR: /data'
  echo "$output" | grep -qF 'STATE_PATH: /state/state.json'
}

@test "fly.toml names no image of its own" {
  # Every image is named in the rendered compose file. A `[build]` image here
  # would be a second, silent source of truth for what actually runs.
  [ -z "$(uncommented "$FLY/fly.toml" | grep -E '^ *image *=')" ]
}

# ---------------------------------------------------------------------------
# The render — what deploy.sh actually hands to flyctl.
#
# THE HEADLINE INVARIANT: no secret values. `docker compose config`
# interpolates every ${VAR}, so the unfiltered output is a file containing the
# whole event's credentials. These check for the VALUES, not the variable
# names, because a name-keyed strip list is exactly the sort of thing that
# goes stale when a service gains a credential.
# ---------------------------------------------------------------------------

@test "render: the file carries the secrets, because nothing else can" {
  need_docker
  render
  # This asserted the OPPOSITE until the first real deploy. The design relied
  # on Fly's documented promise that secrets are "global and available to every
  # container"; they are not. A machine's containers receive only their own
  # ExtraEnv, which comes from this file — so with the values stripped, every
  # container started without credentials while `fly secrets list` showed all
  # fourteen as Deployed.
  grep -qF 'BETTER_AUTH_SECRET: FIXTUREAUTHSECRETzzzzzzzzzzzz' "$RENDERED"
  grep -qF 'SRH_TOKEN: FIXTURESRHTOKENwwwwwwwwww' "$RENDERED"
}

@test "render: each credential reaches ONLY the service that needs it" {
  need_docker
  render
  # The compensation for holding secrets in a file: scoping Fly's global
  # secrets cannot express. Under Fly's model the app container would have
  # received REDIS_PASSWORD and redis would have received GITHUB_CLIENT_SECRET.
  app_env="$(awk '/^  app:/{f=1;next} /^  [a-z]+:/{f=0} f' "$RENDERED")"
  redis_env="$(awk '/^  redis:/{f=1;next} /^  [a-z]+:/{f=0} f' "$RENDERED")"
  # Guard against both blocks coming back empty, which would pass every
  # negative below without testing anything.
  [ -n "$app_env" ] && [ -n "$redis_env" ]
  [ -z "$(echo "$app_env" | grep -F 'REDIS_PASSWORD')" ]
  [ -z "$(echo "$redis_env" | grep -F 'GITHUB_CLIENT_SECRET')" ]
}

@test "render: GITHUB_ORG and ADMIN_LOGINS reach the machine, with no build-time bake" {
  need_docker
  render
  # Config v2 (#386) reads both at runtime — the same channel as every other
  # non-secret value here, docker-compose.yml's own `environment:` entries
  # interpolated by `docker compose config` from ENV_FILE. Neither is a
  # build arg (there is none any more) and neither needs a `fly secrets set`
  # entry, exactly like GITHUB_CLIENT_ID already does not.
  app_env="$(awk '/^  app:/{f=1;next} /^  [a-z]+:/{f=0} f' "$RENDERED")"
  sync_env="$(awk '/^  sync:/{f=1;next} /^  [a-z]+:/{f=0} f' "$RENDERED")"
  [ -n "$app_env" ] && [ -n "$sync_env" ]
  echo "$app_env" | grep -qF 'GITHUB_ORG: fixture-org'
  echo "$app_env" | grep -qF 'ADMIN_LOGINS: fixture-admin'
  echo "$sync_env" | grep -qF 'GITHUB_ORG: fixture-org'
}

@test "render: the output is mode 600" {
  need_docker
  render
  # It holds every credential the event has, next to a repo whose .env.fly
  # reached a PUBLIC remote twice.
  perms="$(ls -l "$RENDERED" | cut -c1-10)"
  [ "$perms" = "-rw-------" ]
}

@test "render: the redis password is not in any command line" {
  need_docker
  render
  # Even with secrets in the file, argv is a different exposure: a password in
  # a container's command is visible to `docker inspect`, to `ps` inside the
  # stack, and in every machine-config dump Fly produces. It travels as an
  # environment variable and is expanded by the container's own shell.
  [ -z "$(grep -F 'requirepass' "$RENDERED" | grep -F 'FIXTUREREDISPASS')" ]
}

@test "render: a URL with userinfo has its host rewritten too" {
  need_docker
  render
  # srh's connection string is `redis://:PASSWORD@redis:6379` — the host
  # follows an `@`, not the `//`. A rewrite anchored only on `//host:` left it
  # pointing at `redis`, which resolves nowhere in a shared namespace: the
  # exact failure this module exists to fix, reintroduced by the renderer and
  # looking identical to the original (srh healthy, unable to connect).
  grep -qE 'SRH_CONNECTION_STRING: redis://:[^@]+@localhost:6379' "$RENDERED"
}

@test "render: no compose-only \$\$ escaping survives" {
  need_docker
  render
  # `$$` means "a literal $" TO COMPOSE, and `docker compose config` re-emits
  # it that way. Fly is not compose: it passes the string through, so `sh -c`
  # would expand `$$` as the shell's PID and redis would come up with a
  # password like "12345REDIS_PASSWORD" — healthy, and impossible to
  # authenticate against.
  [ -z "$(grep -F '$$' "$RENDERED")" ]
}

@test "render: redis still reads its password from the environment" {
  need_docker
  render
  # The counterpart to the two tests above: stripping and unescaping must not
  # have removed the expansion itself.
  grep -qF 'requirepass "$REDIS_PASSWORD"' "$RENDERED"
}

@test "render: redis hands its data dir to the redis user before dropping privileges" {
  need_docker
  render
  # The first deploy of a renamed app had a fresh volume, and redis died on it
  # with "Can't open or create append-only dir appendonlydir: Permission
  # denied": `mkdir -p "$REDIS_DIR"` runs as root, and the image's entrypoint
  # refuses to chown a data dir that holds anything it does not recognise —
  # a fresh Fly volume's root-owned `lost+found` is exactly that. The old app
  # only worked because an earlier image had chowned its volume when that
  # pass was still unconditional. So the command chowns the dir itself, and
  # this pins that it survives the render (the `$$` unescape included).
  # Drop the chown from docker-compose.yml and this fails; it cannot pass on
  # a file that was never written, because render() asserts the file exists.
  grep -qF 'mkdir -p "$REDIS_DIR" && chown redis "$REDIS_DIR" && exec docker-entrypoint.sh redis-server' "$RENDERED"
}

@test "render: every service resolves to loopback, not a service name" {
  need_docker
  render
  # Containers in one machine share a network namespace. There is no DNS
  # between them: `http://srh:80` resolves nowhere. This is also the whole
  # reason the deployment is one machine — srh's Redis client is IPv4-only and
  # Fly's private network is IPv6-only.
  [ -z "$(grep -E '://(srh|scorer|redis|app|sync):' "$RENDERED")" ]
}

@test "render: the REST and scorer URLs are present and point at localhost" {
  need_docker
  render
  # The negative test above passes trivially if the URLs vanished altogether.
  grep -qF 'UPSTASH_REDIS_REST_URL: http://localhost:80' "$RENDERED"
  grep -qF 'SCORER_URL: http://localhost:4000' "$RENDERED"
}

@test "render: caddy is not deployed" {
  need_docker
  render
  # Fly terminates TLS and issues certificates, so caddy has no job there —
  # and it would collide with srh, which also binds port 80 in the shared
  # namespace. Excluded by naming services explicitly in the render, NOT by
  # giving caddy a compose profile: profiling it would make the edge opt-in
  # for every LOCAL bring-up, so one forgotten flag would mean no ingress.
  [ -z "$(grep -E '^  caddy:' "$RENDERED")" ]
}

@test "render: every deployed service names an image" {
  need_docker
  render
  # flyctl requires `image` or `build` per service, and this module builds
  # nothing on Fly. A service that lost its image line fails the deploy with a
  # message that names the file, not the cause.
  services="$(grep -cE '^  [a-z-]+:' "$RENDERED")"
  images="$(grep -cE '^    image: ' "$RENDERED")"
  [ "$services" = "$images" ]
}

@test "render: all five services are present" {
  need_docker
  render
  for svc in app scorer sync srh redis; do
    if ! grep -qE "^  $svc:" "$RENDERED"; then
      echo "missing service: $svc"
      return 1
    fi
  done
  [ "$(grep -cE '^  [a-z-]+:' "$RENDERED")" = "5" ]
}

@test "render: adds secdev (scorer, sync) iff SCORE_IMAGE is non-empty" {
  need_docker
  # SCORE_IMAGE is the ONE key every entry point derives "does this event run
  # Secure Development" from (scripts/dev-stack, docker-compose.yml's scorer
  # comment) — this is render-compose.sh's half of that rule. Fly's deploy.sh
  # always requires SCORE_IMAGE today (R2, config v2 #386), so a real deploy
  # can never reach the empty case; this exercises the renderer directly.
  #
  # Naming scorer/sync explicitly on the `docker compose config` command line
  # would render them regardless of --profile (compose enables whatever
  # profile a named service needs on its own), so the fix has to derive
  # SERVICES alongside PROFILES — this is the test that would catch a
  # regression back to naming them unconditionally.
  sed 's/^SCORE_IMAGE=.*/SCORE_IMAGE=/' "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.noscore"
  out="$BATS_TEST_TMPDIR/noscore.yml"
  "$FLY/render-compose.sh" --env-file "$BATS_TEST_TMPDIR/env.noscore" --out "$out" \
    --app-image reg/app:t --sync-image reg/sync:t --scorer-image reg/scorer:t
  [ -s "$out" ]
  [ -z "$(grep -E '^  (scorer|sync):' "$out")" ]
  [ -n "$(grep -E '^  (app|srh|redis):' "$out")" ]
}

@test "render: a quoted-empty SCORE_IMAGE is empty, the way compose reads it" {
  need_docker
  # `SCORE_IMAGE=""` is a legal .env line and compose parses it as EMPTY. A
  # bare `sed -n 's/^SCORE_IMAGE=//p'` hands back the two-character string
  # `""`, which is non-empty — so the renderer added secdev, and rendered a
  # scorer and a sync, for an app-only event.
  sed 's|^SCORE_IMAGE=.*|SCORE_IMAGE=""|' "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.q"
  out="$BATS_TEST_TMPDIR/quoted-empty.yml"
  "$FLY/render-compose.sh" --env-file "$BATS_TEST_TMPDIR/env.q" --out "$out" \
    --app-image reg/app:t --sync-image reg/sync:t --scorer-image reg/scorer:t
  [ -s "$out" ]
  [ -n "$(grep -E '^  (app|srh|redis):' "$out")" ]
  [ -z "$(grep -E '^  (scorer|sync):' "$out")" ]
}

@test "render: a quoted SCORE_IMAGE still enables secdev" {
  need_docker
  # The complement of the test above: stripping the quotes must not strip the
  # VALUE. A parser that read `SCORE_IMAGE="ghcr.io/..."` as empty would make
  # every quoted-env event app-only, which is the same bug pointing the other
  # way and would pass the test above on its own.
  sed 's|^SCORE_IMAGE=.*|SCORE_IMAGE="ghcr.io/fixture-org/score:latest"|' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.qv"
  out="$BATS_TEST_TMPDIR/quoted-value.yml"
  "$FLY/render-compose.sh" --env-file "$BATS_TEST_TMPDIR/env.qv" --out "$out" \
    --app-image reg/app:t --sync-image reg/sync:t --scorer-image reg/scorer:t
  [ -s "$out" ]
  # Both services, not either: a regression dropping one must not pass.
  grep -qE '^  scorer:' "$out"
  grep -qE '^  sync:' "$out"
}

@test "render: a spaced SCORE_IMAGE assignment still enables secdev" {
  need_docker
  # `SCORE_IMAGE = ghcr.io/...` is legal .env: compose trims whitespace around
  # the key and after the `=`, and reads the value fine. A reader matching only
  # `^SCORE_IMAGE=` saw nothing there and rendered an app-only stack for an
  # event that has a scorer — the renderer and compose disagreeing about one
  # file again, this time in the other direction.
  sed 's|^SCORE_IMAGE=.*|SCORE_IMAGE = ghcr.io/fixture-org/score:latest|' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.spaced"
  out="$BATS_TEST_TMPDIR/spaced.yml"
  "$FLY/render-compose.sh" --env-file "$BATS_TEST_TMPDIR/env.spaced" --out "$out" \
    --app-image reg/app:t --sync-image reg/sync:t --scorer-image reg/scorer:t
  [ -s "$out" ]
  # Both services, not either: a regression dropping one must not pass.
  grep -qE '^  scorer:' "$out"
  grep -qE '^  sync:' "$out"
}

@test "render: no build, networks, volumes or profiles keys survive" {
  need_docker
  render
  # build:    flyctl rejects more than one, and cannot pass build args.
  # volumes:  named volumes are ignored by Fly; bind mounts name host paths
  #           that do not exist on a Fly machine.
  # networks: one machine, one namespace.
  # profiles: flyctl does not implement them, so leaving them would imply a
  #           filter Fly honours when it does not.
  [ -z "$(grep -E '^    (build|networks|volumes|profiles):' "$RENDERED")" ]
}

@test "render: no service is left with an empty environment key" {
  need_docker
  render
  # redis's entire environment is secrets, so stripping them leaves a bare
  # `environment:` — which is YAML null, not an empty mapping. Docker tolerates
  # it; a hand-rolled unmarshal into a map type need not.
  # An `environment:` key is empty exactly when the next line is not indented
  # deeper than it — including when it is the last line of the file.
  empty="$(awk '
    prev == 1 { match($0, /^ */); if (RLENGTH <= 4) print "EMPTY"; prev = 0 }
    /^    environment:[ \t]*$/ { prev = 1; next }
    END { if (prev == 1) print "EMPTY" }
  ' "$RENDERED")"
  [ -z "$empty" ]
}

@test "render: the output is valid compose" {
  need_docker
  render
  # Structural checks above are line-oriented; this one asks Docker whether the
  # document actually parses.
  docker compose -f "$RENDERED" config -q 2>/dev/null
}

@test "render: refuses to run without an image for every service" {
  # Fly builds nothing here, so a missing image is a deploy that fails late
  # with a message about the compose file rather than the flag that was
  # forgotten.
  run "$FLY/render-compose.sh" --env-file "$BATS_TEST_TMPDIR/env" \
    --out "$BATS_TEST_TMPDIR/x.yml" --app-image a --sync-image b
  [ "$status" -ne 0 ]
  echo "$output" | grep -qF -- '--scorer-image is required'
}

@test "render: refuses a missing env file" {
  run "$FLY/render-compose.sh" --env-file "$BATS_TEST_TMPDIR/nope" \
    --out "$BATS_TEST_TMPDIR/x.yml" --app-image a --sync-image b --scorer-image c
  [ "$status" -ne 0 ]
  echo "$output" | grep -qF 'FAIL: no'
}

# ---------------------------------------------------------------------------
# deploy.sh — the dry run is the command people run first, casually.
# ---------------------------------------------------------------------------

@test "dry-run makes no fly calls at all" {
  need_docker
  cd "$REPO"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env"
  [ "$status" -eq 0 ]
  # Every fly invocation goes through fly_run, which prints instead of running.
  # A line that would call fly without that prefix is a real call in a dry run.
  [ -z "$(echo "$output" | grep -E '^fly ')" ]
}

@test "deploy refuses an ADMIN_LOGINS that parses to no admin" {
  need_docker
  cd "$REPO"
  # `require` only ever checked for an empty string, but the app parses this
  # value with parseAdminLogins (apps/web/src/lib/admin-logins.ts): split,
  # trim, drop anything not shaped like a GitHub login. Each of these is
  # non-empty and parses to NOBODY, so it would deploy an event whose /admin
  # 403s everyone — the operator included, with another deploy the only fix.
  #
  # Two groups, because "did the message leak the value?" is only a question
  # you can ask of a distinctive value: a bare "," appears in any English
  # sentence, so grepping the output for it proves nothing either way.
  for bad in "," " , " "bad login!" "alice@example.com" "-alice" "a--b"; do
    sed "s|^ADMIN_LOGINS=.*|ADMIN_LOGINS=$bad|" "$BATS_TEST_TMPDIR/env" \
      > "$BATS_TEST_TMPDIR/env.admins"
    run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.admins"
    if [ "$status" -eq 0 ]; then
      echo "ACCEPTED an unusable ADMIN_LOGINS: [$bad]"
      return 1
    fi
    if ! echo "$output" | grep -qF 'ADMIN_LOGINS'; then
      echo "refused [$bad] without naming ADMIN_LOGINS: $output"
      return 1
    fi
  done

  # The redaction half, checked INSIDE the loop: $output is overwritten by the
  # next `run`, so a leak in an early iteration is gone by the time the test
  # ends. A typo'd roster can hold an email address or a pasted secret, so the
  # refusal names the shape and the count and never the value.
  for bad in "bad login!" "alice@example.com" "-alice" "a--b"; do
    sed "s|^ADMIN_LOGINS=.*|ADMIN_LOGINS=$bad|" "$BATS_TEST_TMPDIR/env" \
      > "$BATS_TEST_TMPDIR/env.admins"
    run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.admins"
    if [ "$status" -eq 0 ]; then
      echo "ACCEPTED an unusable ADMIN_LOGINS: [$bad]"
      return 1
    fi
    if echo "$output" | grep -qF -- "$bad"; then
      echo "refusal leaked the ADMIN_LOGINS value: [$bad]"
      return 1
    fi
  done

  # Decisive and last, per AGENTS.md: a bracket test that gates on the final
  # iteration's output rather than ending the test on a bare loop.
  [ -z "$(echo "$output" | grep -F -- 'a--b')" ]
}

@test "deploy accepts a real ADMIN_LOGINS roster" {
  need_docker
  cd "$REPO"
  # The complement, so the refusal above cannot be satisfied by refusing
  # everything: a plain roster, one padded with spaces and a stray comma, a
  # login with a legal internal hyphen, and an empty entry between two good
  # ones all have to pass.
  for good in "alice,bob" " alice , bob ," "octo-cat" "alice,,bob"; do
    sed "s|^ADMIN_LOGINS=.*|ADMIN_LOGINS=$good|" "$BATS_TEST_TMPDIR/env" \
      > "$BATS_TEST_TMPDIR/env.admins"
    run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.admins"
    if [ "$status" -ne 0 ]; then
      echo "REFUSED a usable ADMIN_LOGINS: [$good] -> $output"
      return 1
    fi
  done
  [ "$status" -eq 0 ]
}

@test "deploy reads a spaced .env assignment, the way compose does" {
  need_docker
  cd "$REPO"
  # The deploy.sh half of the same rule. Every required key goes through
  # env_value, so a spaced assignment used to read as empty and `require`
  # refused a file compose would have deployed happily.
  sed -e 's|^SCORE_IMAGE=|SCORE_IMAGE = |' \
      -e 's|^ADMIN_LOGINS=|ADMIN_LOGINS = |' \
      -e 's|^GITHUB_ORG=|  GITHUB_ORG=|' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.spaced"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.spaced"
  [ "$status" -eq 0 ]
  # Not merely "it did not refuse": the VALUE has to arrive intact, with the
  # padding stripped rather than carried into the image reference.
  echo "$output" | grep -qF 'ghcr.io/fixture-org/score:latest'
}

@test "the /health revision survives dirt outside apps/web" {
  need_docker
  cd "$REPO"
  # Issue #328. The guard checked `git status --porcelain` over the WHOLE repo,
  # but the image is `COPY apps/web/ ./` — so a stray docs file or a .DS_Store
  # blanked the revision on every machine that had one, which is every machine.
  # An `unknown` revision is indistinguishable from "this build predates the
  # stamp", so the field stopped meaning anything.
  probe="docs/__health_scope_probe.md"
  rm -f "$probe"
  echo "untracked, and outside the build context" > "$probe"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env"
  rm -f "$probe"
  [ "$status" -eq 0 ]
  # A real sha, not <none>. Single-bracket `[` so the assertion actually gates.
  [ -n "$(echo "$output" | grep -oE 'APP_BUILD_REV=[0-9a-f]{7,40}')" ]
}

@test "a dirty apps/web still blanks the /health revision" {
  need_docker
  cd "$REPO"
  # The other direction, so the fix above cannot become "never blank it". A
  # modified app tree means the sha does not describe the image, and reporting
  # it would be a confident lie — worse than reporting nothing.
  probe="apps/web/__health_scope_probe.txt"
  rm -f "$probe"
  echo "untracked, and INSIDE the build context" > "$probe"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env"
  rm -f "$probe"
  [ "$status" -eq 0 ]
  [ -n "$(echo "$output" | grep -F 'APP_BUILD_REV=<none>')" ]
}

@test "dry-run redacts every secret value it would set" {
  need_docker
  cd "$REPO"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env"
  # This regressed once for real: an organizer previewed a deploy and watched
  # their GitHub App private key, OAuth client secret and BETTER_AUTH_SECRET
  # scroll past into a terminal, a scrollback buffer, and whatever was
  # capturing the screen.
  for value in FIXTUREAUTHSECRETzzzzzzzzzzzz FIXTURECLIENTSECRETyyyyyyyy \
               FIXTURESCORERTOKENxxxxxxxx FIXTURESRHTOKENwwwwwwwwww \
               FIXTUREREDISPASSvvvvvvvvv RklYVFVSRVBSSVZBVEVLRVl1dXV1dQ==; do
    if echo "$output" | grep -qF -- "$value"; then
      echo "LEAKED in dry-run output: $value"
      return 1
    fi
  done
  echo "$output" | grep -qF 'BETTER_AUTH_SECRET=<redacted>'
}

@test "dry-run still shows WHICH variables get set" {
  need_docker
  cd "$REPO"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env"
  # Redaction that hides the variable NAMES too would defeat the point of
  # previewing: the reason to run this is to check what is configured where.
  echo "$output" | grep -qF 'UPSTASH_REDIS_REST_TOKEN=<redacted>'
}

@test "the srh connection string points at loopback" {
  need_docker
  cd "$REPO"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env"
  # It is redacted in the output (it embeds the password), so this asserts on
  # the rendered file's sibling: the variable is set at all.
  echo "$output" | grep -qF 'SRH_CONNECTION_STRING=<redacted>'
}

@test "a leftover SCORE_INGEST line changes nothing about a deploy (#377)" {
  need_docker
  cd "$REPO"
  # This module refused SCORE_INGEST=push outright (#373): compose routed POST
  # /score to scorer:4000 through caddy, a Fly machine has no caddy, and
  # fly.toml exposes only the app on :3000, so a push deploy had every fork's
  # Action POST into a 404. Push ingest is now removed everywhere (#377), the
  # key is read by nothing, and an `.env.fly` carried over from a push event
  # deploys like any other — the refusal would be a stop with nothing behind it.
  cp "$BATS_TEST_TMPDIR/env" "$BATS_TEST_TMPDIR/env.push"
  echo "SCORE_INGEST=push" >> "$BATS_TEST_TMPDIR/env.push"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.push"
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F 'poll-only')" ]
  echo "$output" | grep -qF '== 5/5 deploy'
}

@test "an env file with no SCORE_INGEST at all deploys the same way" {
  need_docker
  cd "$REPO"
  # The fixture env has never carried the key — the shape every new `.env.fly`
  # has now — and it must reach the same plan as the leftover-line case above.
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env"
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF '== 5/5 deploy'
}

@test "a non-https EVENT_URL is refused" {
  cd "$REPO"
  sed 's|^EVENT_URL=.*|EVENT_URL=http://localhost|' "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.http"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.http"
  [ "$status" -ne 0 ]
  # ADR 39: the app refuses to serve a production event over plain HTTP, so
  # this would deploy an app that answers 500 to everything.
  echo "$output" | grep -qF 'must be your app'
}

@test "an unfilled placeholder EVENT_URL is refused" {
  cd "$REPO"
  sed 's|^EVENT_URL=.*|EVENT_URL=https://<your-app>.fly.dev|' "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.ph"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.ph"
  [ "$status" -ne 0 ]
  # It passes the https:// test, so without this it deploys and fails much
  # later as a redirect_uri mismatch nobody can resolve.
  echo "$output" | grep -qF 'placeholder'
}

@test "a missing REDIS_PASSWORD names REDIS_PASSWORD and nothing else" {
  cd "$REPO"
  grep -v '^REDIS_PASSWORD=' "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.nored"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.nored"
  [ "$status" -ne 0 ]
  # Naming several variables when one is absent sends the reader to check the
  # ones they already set.
  [ -z "$(echo "$output" | grep -F 'SRH_TOKEN and')" ]
}

@test "--skip-build never warns about a stale config — nothing is baked" {
  # Config v2 (#386) removed the event.yaml bake: GITHUB_ORG, ADMIN_LOGINS and
  # everything else are runtime reads that flow through the rendered compose
  # file on every deploy, with or without --skip-build. A warning that used to
  # fire here (the app "bakes" config at build time) would now be simply
  # wrong, so assert it is gone rather than that it fires.
  need_docker
  cd "$REPO"
  run ./deploy/fly/deploy.sh --dry-run --skip-build --env-file "$BATS_TEST_TMPDIR/env"
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -F 'baked')" ]
}

@test "init needs no fly CLI and touches nothing on Fly" {
  cd "$REPO"
  cp "$BATS_TEST_TMPDIR/env" "$BATS_TEST_TMPDIR/env.init"
  run ./deploy/fly/deploy.sh init --dry-run --env-file "$BATS_TEST_TMPDIR/env.init"
  [ "$status" -eq 0 ]
  [ -z "$(echo "$output" | grep -E '^fly ')" ]
}

@test "init rejects a region that is not a Fly region code" {
  cd "$REPO"
  grep -v '^FLY_REGION=' "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.noregion"
  run ./deploy/fly/deploy.sh init --env-file "$BATS_TEST_TMPDIR/env.noregion" --region GRU1
  [ "$status" -ne 0 ]
  echo "$output" | grep -qF 'not a Fly region code'
}

@test "init --refresh carries GITHUB_ORG and ADMIN_LOGINS (#381)" {
  cd "$REPO"
  # An .env.fly holding an OLD org/admin pairing — the shape of a Fly
  # deployment that predates a target-org rename or an admin roster change
  # (exactly the incident in #381).
  sed -e 's/^GITHUB_ORG=.*/GITHUB_ORG=old-org/' \
      -e 's/^ADMIN_LOGINS=.*/ADMIN_LOGINS=old-admin/' \
      "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.fly.stale"
  run ./deploy/fly/deploy.sh init --refresh --region gru \
    --from "$BATS_TEST_TMPDIR/env" --env-file "$BATS_TEST_TMPDIR/env.fly.stale"
  [ "$status" -eq 0 ]
  [ "$(sed -n 's/^GITHUB_ORG=//p' "$BATS_TEST_TMPDIR/env.fly.stale" | tail -1)" = "fixture-org" ]
  [ "$(sed -n 's/^ADMIN_LOGINS=//p' "$BATS_TEST_TMPDIR/env.fly.stale" | tail -1)" = "fixture-admin" ]
}

@test "init --refresh ADDS the config-v2 keys to an env file that lacks them" {
  cd "$REPO"
  # A `.env.fly` written BEFORE config v2 (#386) has no GITHUB_ORG and no
  # ADMIN_LOGINS line at all — which the awk rewrite could only ever replace,
  # never add, while still reporting "updated". Asserts the FILE, not the exit
  # status: the old behaviour exited 0 and left the file unchanged.
  grep -vE '^(GITHUB_ORG|ADMIN_LOGINS)=' "$BATS_TEST_TMPDIR/env" \
    > "$BATS_TEST_TMPDIR/env.fly.prev2"
  run ./deploy/fly/deploy.sh init --refresh --region gru \
    --from "$BATS_TEST_TMPDIR/env" --env-file "$BATS_TEST_TMPDIR/env.fly.prev2"
  [ "$(sed -n 's/^GITHUB_ORG=//p' "$BATS_TEST_TMPDIR/env.fly.prev2" | tail -1)" = "fixture-org" ]
  [ "$(sed -n 's/^ADMIN_LOGINS=//p' "$BATS_TEST_TMPDIR/env.fly.prev2" | tail -1)" = "fixture-admin" ]
}

@test "init --refresh CLEARS a pinned installation id when the source is explicitly blank (#381)" {
  cd "$REPO"
  # An explicitly blank GITHUB_APP_INSTALLATION_ID in .env means "let sync
  # auto-discover the installation". The refresh used to skip every blank
  # source value, so a pinned id belonging to a DELETED App stayed in .env.fly
  # — and sync then logged `GitHub 401 minting installation token` for every
  # target, every poll, forever. This is the one key whose explicit blank is
  # obeyed.
  sed 's/^GITHUB_APP_INSTALLATION_ID=.*/GITHUB_APP_INSTALLATION_ID=/' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/from.blankinst"
  sed 's/^GITHUB_APP_INSTALLATION_ID=.*/GITHUB_APP_INSTALLATION_ID=987654/' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.fly.pinned"
  run ./deploy/fly/deploy.sh init --refresh --region gru \
    --from "$BATS_TEST_TMPDIR/from.blankinst" --env-file "$BATS_TEST_TMPDIR/env.fly.pinned"
  # ONE chain, so no later passing assertion can mask an earlier failing one:
  # the status, what was said, and what the file now holds. The line survives,
  # empty — not deleted, assigned exactly once, and above all not still pinned.
  [ "$status" -eq 0 ] &&
    echo "$output" | grep -qF 'GITHUB_APP_INSTALLATION_ID cleared' &&
    grep -qx 'GITHUB_APP_INSTALLATION_ID=' "$BATS_TEST_TMPDIR/env.fly.pinned" &&
    [ "$(grep -cE '^[[:space:]]*(export[[:space:]]+)?GITHUB_APP_INSTALLATION_ID[[:space:]]*[:=]' "$BATS_TEST_TMPDIR/env.fly.pinned")" = "1" ] &&
    [ -z "$(grep -F '987654' "$BATS_TEST_TMPDIR/env.fly.pinned")" ]
}

@test "init --refresh KEEPS a pinned installation id when the source has no such key (#381)" {
  cd "$REPO"
  # The third state, and the one dotenv_file_value cannot distinguish on its
  # own: it returns "" for "assigned nothing" AND for "never mentioned". Only
  # an EXPLICIT blank assignment clears — a .env that has no
  # GITHUB_APP_INSTALLATION_ID line at all has said nothing about it, so
  # unpinning a working id off the back of that silence would be the same
  # `GitHub 401` outage the clearing rule exists to prevent, arrived at from
  # the other direction.
  grep -v '^GITHUB_APP_INSTALLATION_ID=' "$BATS_TEST_TMPDIR/env" \
    > "$BATS_TEST_TMPDIR/from.noinst"
  sed 's/^GITHUB_APP_INSTALLATION_ID=.*/GITHUB_APP_INSTALLATION_ID=987654/' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.fly.absentinst"
  run ./deploy/fly/deploy.sh init --refresh --region gru \
    --from "$BATS_TEST_TMPDIR/from.noinst" --env-file "$BATS_TEST_TMPDIR/env.fly.absentinst"
  # Names the key, says what WOULD clear it, and leaves the pinned id alone —
  # still exactly one assignment of it.
  [ "$status" -eq 0 ] &&
    echo "$output" | grep -qF 'GITHUB_APP_INSTALLATION_ID missing from' &&
    echo "$output" | grep -qF "explicit 'GITHUB_APP_INSTALLATION_ID=' line there is what clears it" &&
    grep -qx 'GITHUB_APP_INSTALLATION_ID=987654' "$BATS_TEST_TMPDIR/env.fly.absentinst" &&
    [ "$(grep -cE '^[[:space:]]*(export[[:space:]]+)?GITHUB_APP_INSTALLATION_ID[[:space:]]*[:=]' "$BATS_TEST_TMPDIR/env.fly.absentinst")" = "1" ] &&
    [ -z "$(echo "$output" | grep -F 'GITHUB_APP_INSTALLATION_ID cleared')" ]
}

@test "init --refresh does NOT clear ADMIN_LOGINS on a blank source, and warns (#381)" {
  cd "$REPO"
  # The asymmetry, deliberately. Obeying a blank here would lock every
  # organizer out of /admin on a live box, and a blank in .env is far more
  # likely to be "not filled in yet" than "deliberately unset" — so the
  # destination value is kept and the refusal to guess is printed.
  sed -e 's/^ADMIN_LOGINS=.*/ADMIN_LOGINS=/' \
      -e 's/^GITHUB_ORG=.*/GITHUB_ORG=/' \
      -e 's|^SCORE_IMAGE=.*|SCORE_IMAGE=|' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/from.blankadmins"
  sed 's/^ADMIN_LOGINS=.*/ADMIN_LOGINS=live-admin/' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.fly.admins"
  run ./deploy/fly/deploy.sh init --refresh --region gru \
    --from "$BATS_TEST_TMPDIR/from.blankadmins" --env-file "$BATS_TEST_TMPDIR/env.fly.admins"
  # One chain: each key is NAMED (not a generic "some values were skipped"),
  # and each live value is still there — an empty allowlist 403s everyone, an
  # empty org stops sync, an empty SCORE_IMAGE disables Secure Development.
  [ "$status" -eq 0 ] &&
    echo "$output" | grep -qF 'ADMIN_LOGINS blank in' &&
    echo "$output" | grep -qF 'GITHUB_ORG blank in' &&
    echo "$output" | grep -qF 'SCORE_IMAGE blank in' &&
    grep -qx 'GITHUB_ORG=fixture-org' "$BATS_TEST_TMPDIR/env.fly.admins" &&
    grep -qx 'SCORE_IMAGE=ghcr.io/fixture-org/score:latest' "$BATS_TEST_TMPDIR/env.fly.admins" &&
    grep -qx 'ADMIN_LOGINS=live-admin' "$BATS_TEST_TMPDIR/env.fly.admins"
}

@test "init --refresh reads spaced and colon-delimited source assignments (#381)" {
  cd "$REPO"
  # The refresh read its SOURCE with a bare `sed -n "s/^KEY=//p"` while the rest
  # of the module had already learned compose's grammar — so `SCORE_IMAGE = x`,
  # `GITHUB_APP_ID: 4242` and a quoted value in .env were invisible to it and
  # silently left the OLD value in .env.fly.
  sed -e 's|^SCORE_IMAGE=|SCORE_IMAGE = |' \
      -e 's|^GITHUB_APP_ID=|GITHUB_APP_ID: |' \
      -e 's|^GITHUB_ORG=\(.*\)|GITHUB_ORG="\1"|' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/from.forms"
  sed -e 's|^SCORE_IMAGE=.*|SCORE_IMAGE=ghcr.io/old-org/score:old|' \
      -e 's|^GITHUB_APP_ID=.*|GITHUB_APP_ID=1111|' \
      -e 's|^GITHUB_ORG=.*|GITHUB_ORG=old-org|' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.fly.forms"
  run ./deploy/fly/deploy.sh init --refresh --region gru \
    --from "$BATS_TEST_TMPDIR/from.forms" --env-file "$BATS_TEST_TMPDIR/env.fly.forms"
  # One chain: each arrives as the canonical KEY=value, with the padding and
  # the quotes stripped rather than carried into the value, and each replaced
  # its old line rather than joining it.
  [ "$status" -eq 0 ] &&
    grep -qx 'SCORE_IMAGE=ghcr.io/fixture-org/score:latest' "$BATS_TEST_TMPDIR/env.fly.forms" &&
    grep -qx 'GITHUB_ORG=fixture-org' "$BATS_TEST_TMPDIR/env.fly.forms" &&
    grep -qx 'GITHUB_APP_ID=1' "$BATS_TEST_TMPDIR/env.fly.forms" &&
    [ "$(grep -cE '^[[:space:]]*(export[[:space:]]+)?GITHUB_APP_ID[[:space:]]*[:=]' "$BATS_TEST_TMPDIR/env.fly.forms")" = "1" ] &&
    [ -z "$(grep -F 'old-org' "$BATS_TEST_TMPDIR/env.fly.forms")" ]
}

@test "init --refresh REPLACES a spaced destination line instead of duplicating it (#381)" {
  cd "$REPO"
  # `grep -q "^KEY="` decided replace-vs-append, so a `.env.fly` line written
  # as `SCORE_IMAGE = old` got a second `SCORE_IMAGE=new` appended — two
  # assignments of one key, which is the duplicate bug this same issue reports.
  sed -e 's|^SCORE_IMAGE=.*|SCORE_IMAGE = ghcr.io/old-org/score:old|' \
      -e 's|^GITHUB_ORG=.*|  export GITHUB_ORG: old-org|' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.fly.spacedline"
  run ./deploy/fly/deploy.sh init --refresh --region gru \
    --from "$BATS_TEST_TMPDIR/env" --env-file "$BATS_TEST_TMPDIR/env.fly.spacedline"
  # One chain: the canonical line is there, and there is exactly ONE
  # assignment of each key afterwards whatever form the old line took —
  # counted with the same grammar the script reads, `export` prefix included.
  [ "$status" -eq 0 ] &&
    grep -qx 'SCORE_IMAGE=ghcr.io/fixture-org/score:latest' "$BATS_TEST_TMPDIR/env.fly.spacedline" &&
    grep -qx 'GITHUB_ORG=fixture-org' "$BATS_TEST_TMPDIR/env.fly.spacedline" &&
    [ "$(grep -cE '^[[:space:]]*(export[[:space:]]+)?SCORE_IMAGE[[:space:]]*[:=]' "$BATS_TEST_TMPDIR/env.fly.spacedline")" = "1" ] &&
    [ "$(grep -cE '^[[:space:]]*(export[[:space:]]+)?GITHUB_ORG[[:space:]]*[:=]' "$BATS_TEST_TMPDIR/env.fly.spacedline")" = "1" ] &&
    [ -z "$(grep -F 'old-org' "$BATS_TEST_TMPDIR/env.fly.spacedline")" ]
}

@test "a duplicated key warns, and the refresh collapses it to one line (#381)" {
  cd "$REPO"
  # The reported .env.fly defined SCORE_IMAGE twice (and SCORE_INGEST, a key
  # #377 has since removed). Every reader here takes the LAST assignment (so
  # does compose), so an organizer editing the first occurrence changes nothing
  # at all — and the old awk rewrite printed the new value once per matching
  # line, faithfully preserving the duplication.
  sed 's|^SCORE_IMAGE=.*|SCORE_IMAGE=ghcr.io/old-org/score:old|' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.fly.dup"
  printf 'SCORE_IMAGE=ghcr.io/old-org/score:older\nEVENT_URL=https://owasp-ctf.fly.dev\n' \
    >> "$BATS_TEST_TMPDIR/env.fly.dup"
  run ./deploy/fly/deploy.sh init --refresh --region gru \
    --from "$BATS_TEST_TMPDIR/env" --env-file "$BATS_TEST_TMPDIR/env.fly.dup"
  # One chain: the warning names BOTH offenders and says which assignment
  # wins, and SCORE_IMAGE — the refresh-owned one — is collapsed to a single
  # canonical line carrying the new value. EVENT_URL is not refresh-owned (it
  # belongs to this deployment), so it is only warned about; the collapse
  # applies to keys the refresh rewrites.
  [ "$status" -eq 0 ] &&
    echo "$output" | grep -qF 'assigns these keys more than once' &&
    echo "$output" | grep -qF 'SCORE_IMAGE' &&
    echo "$output" | grep -qF 'EVENT_URL' &&
    echo "$output" | grep -qF 'The LAST assignment wins' &&
    grep -qx 'SCORE_IMAGE=ghcr.io/fixture-org/score:latest' "$BATS_TEST_TMPDIR/env.fly.dup" &&
    [ "$(grep -cE '^[[:space:]]*(export[[:space:]]+)?SCORE_IMAGE[[:space:]]*[:=]' "$BATS_TEST_TMPDIR/env.fly.dup")" = "1" ] &&
    [ -z "$(grep -F 'old-org' "$BATS_TEST_TMPDIR/env.fly.dup")" ]
}

@test "a deploy warns that .env.fly's credentials have drifted from .env (#381)" {
  need_docker
  cd "$REPO"
  # The incident: the event org was re-created, `.env` was rewritten with a new
  # OAuth app and a new sync App, `.env.fly` was never refreshed, and a plain
  # deploy shipped the OLD org's credentials in silence. Every sign-in bounced
  # with `?error=application_suspended`, sync logged `GitHub 401 minting
  # installation token` for all six targets every 30s, and nothing in the
  # deploy, /health or `doctor` (which reads `.env`, not `.env.fly`) said why.
  sed -e 's|^GITHUB_APP_ID=.*|GITHUB_APP_ID=DRIFTEDAPPID999|' \
      -e 's|^GITHUB_CLIENT_SECRET=.*|GITHUB_CLIENT_SECRET=DRIFTEDCLIENTSECRET777|' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.fly.drift"
  run ./deploy/fly/deploy.sh --dry-run \
    --env-file "$BATS_TEST_TMPDIR/env.fly.drift" --from "$BATS_TEST_TMPDIR/env"
  # The warning itself names keys only — never a value, for any key. Taken as
  # a block, because GITHUB_APP_ID is not a secret and legitimately appears in
  # the `fly secrets set` preview further down.
  block="$(echo "$output" | awk '/disagree on:/{f=1} f{print} f && /init --refresh/{exit}')"
  # One chain: WARNS rather than refuses (separate OAuth apps per environment
  # are legitimate), names the key and the fix, warns TWICE — once before the
  # multi-minute build and once in the closing summary, because the first copy
  # is thousands of log lines up by the time it matters — and leaks no value,
  # neither the drifted secret anywhere in the output nor the app id inside
  # the warning block.
  [ "$status" -eq 0 ] &&
    echo "$output" | grep -qF 'GITHUB_APP_ID' &&
    echo "$output" | grep -qF 'init --refresh' &&
    [ "$(echo "$output" | grep -cF 'disagree on:')" = "2" ] &&
    echo "$block" | grep -qF 'GITHUB_APP_ID' &&
    [ -z "$(echo "$output" | grep -F 'DRIFTEDCLIENTSECRET777')" ] &&
    [ -z "$(echo "$block" | grep -F 'DRIFTEDAPPID999')" ]
}

@test "no drift warning when the two env files agree (#381)" {
  need_docker
  cd "$REPO"
  # A warning that always fires is one nobody reads.
  run ./deploy/fly/deploy.sh --dry-run \
    --env-file "$BATS_TEST_TMPDIR/env" --from "$BATS_TEST_TMPDIR/env"
  # The silence has to be EARNED: the closing-summary marker proves the deploy
  # ran past both places the warning is printed, rather than exiting early on
  # some unrelated refusal and reading as quiet.
  [ "$status" -eq 0 ] &&
    echo "$output" | grep -qF 'Custom domain instead of' &&
    [ -z "$(echo "$output" | grep -F 'disagree on:')" ]
}

@test "no drift warning, and no failure, when --from does not exist (#381)" {
  need_docker
  cd "$REPO"
  # A deploy from a machine that has no compose `.env` at all is normal, not a
  # problem: the check has nothing to compare against and says nothing, rather
  # than refusing or warning about every key at once.
  run ./deploy/fly/deploy.sh --dry-run \
    --env-file "$BATS_TEST_TMPDIR/env" --from "$BATS_TEST_TMPDIR/no-such-.env"
  # Same earned silence: reaching the closing summary rules out "quiet because
  # it stopped", and the absent path is never named anywhere in the output.
  [ "$status" -eq 0 ] &&
    echo "$output" | grep -qF 'Custom domain instead of' &&
    [ -z "$(echo "$output" | grep -F 'disagree on:')" ] &&
    [ -z "$(echo "$output" | grep -F 'no-such-.env')" ]
}

@test "the drift check runs with --skip-build too (#381)" {
  need_docker
  cd "$REPO"
  # --skip-build is the flag used for exactly the change that drifts: "only a
  # secret moved, redeploy quickly". It must not be the mode that stops looking.
  sed 's|^GITHUB_ORG=.*|GITHUB_ORG=previous-org|' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.fly.driftorg"
  run ./deploy/fly/deploy.sh --dry-run --skip-build \
    --env-file "$BATS_TEST_TMPDIR/env.fly.driftorg" --from "$BATS_TEST_TMPDIR/env"
  # One chain: it still warns, still twice, and the warning itself names the
  # drifted key — matched on the warning line rather than on the output at
  # large, where GITHUB_ORG legitimately appears in the secrets preview. And
  # never the value, not even for a non-secret key.
  [ "$status" -eq 0 ] &&
    [ "$(echo "$output" | grep -cF 'disagree on: GITHUB_ORG')" = "2" ] &&
    [ -z "$(echo "$output" | grep -F 'previous-org')" ]
}

@test "deploy refuses an env file with no ADMIN_LOGINS, naming the key" {
  cd "$REPO"
  # An empty admin allowlist locks EVERYONE out of /admin, including the
  # operator running the deploy, and nothing in a healthy-looking machine says
  # so — the 403 arrives after the deploy, at sign-in.
  grep -v '^ADMIN_LOGINS=' "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.noadmins"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.noadmins"
  [ "$status" -ne 0 ]
  echo "$output" | grep -qF 'ADMIN_LOGINS is empty'
}

@test "deploy refuses an env file with no GITHUB_ORG, naming the key" {
  cd "$REPO"
  # Fly is poll-only, so sync always runs here — and it exits at start-up
  # without an org while the other four containers come up clean.
  grep -v '^GITHUB_ORG=' "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.noorg"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.noorg"
  [ "$status" -ne 0 ]
  echo "$output" | grep -qF 'GITHUB_ORG is empty'
}

@test "init --refresh falls through to the top-up prompts instead of exiting (#381)" {
  cd "$REPO"
  # A stale .env.fly missing the knobs a plain `init` would have added — this
  # is the shape that once ran for weeks with sync's cursor on ephemeral disk
  # (#364), because `--refresh` used to exit right after the credential loop
  # instead of reaching these.
  grep -vE '^(SRH_TOKEN|REDIS_PASSWORD|FLY_REGION|REDIS_DIR|STATE_PATH)=' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.fly.bare"
  run ./deploy/fly/deploy.sh init --refresh \
    --from "$BATS_TEST_TMPDIR/env" --env-file "$BATS_TEST_TMPDIR/env.fly.bare"
  [ "$status" -eq 0 ]
  [ -n "$(sed -n 's/^SRH_TOKEN=//p' "$BATS_TEST_TMPDIR/env.fly.bare" | tail -1)" ]
  [ -n "$(sed -n 's/^REDIS_PASSWORD=//p' "$BATS_TEST_TMPDIR/env.fly.bare" | tail -1)" ]
  grep -qF 'REDIS_DIR=/data/redis' "$BATS_TEST_TMPDIR/env.fly.bare"
}

# ---------------------------------------------------------------------------
# Cross-file agreement.
# ---------------------------------------------------------------------------

@test "deploy.sh and fly.toml agree on the app name" {
  # deploy.sh reads the name out of fly.toml rather than repeating it, so this
  # guards the reader, not a duplicated constant.
  cd "$REPO"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env"
  name="$(grep -E '^app *= *"' "$FLY/fly.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')"
  echo "$output" | grep -qF "== app: $name"
}

@test "sync reads GITHUB_ORG from the environment" {
  # The single-machine deployment has no repo checkout to bind-mount a config
  # file from, which is why config v2 (#386) made the environment the poller's
  # only config plane. Without this the deployed poller has no org to poll.
  #
  # The READ, not the name: config.js's comments name GITHUB_ORG too, so a
  # bare `grep GITHUB_ORG` would still pass with the read deleted.
  grep -qF 'env.GITHUB_ORG' "$REPO/sync/src/config.js"
}

@test "docker-compose.yml passes GITHUB_ORG through to sync" {
  # The render carries whatever compose declares; if the variable is not wired
  # into the SYNC service it cannot reach the deployed poller. Scoped to that
  # service on purpose — `app` declares the same key, so a whole-file grep
  # would pass with sync's line deleted.
  sync_env="$(awk '/^  sync:/{f=1;next} /^[^ ]/{f=0} /^  [a-z]/{if(f)f=0} f' "$REPO/docker-compose.yml")"
  echo "$sync_env" | grep -qF 'GITHUB_ORG: ${GITHUB_ORG:-}'
}

@test "the deploy passes a prebuilt image so flyctl does not try to build one" {
  need_docker
  cd "$REPO"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env"
  # Without this the first real deploy died after every image was already
  # built and pushed: flyctl resolves a machine image before it reads the
  # compose file, and with no [build] section it has nothing to resolve —
  # "app does not have a Dockerfile or buildpacks configured". Zero buildable
  # services is fine to the compose parser; it is `fly deploy` that objects.
  echo "$output" | grep -qE 'fly deploy .*--image registry\.fly\.io/[^ ]+:app'
}

# ---------------------------------------------------------------------------
# FLY_AUTO_STOP — opt-in idle shutdown.
# ---------------------------------------------------------------------------

@test "autostop is off unless asked for" {
  need_docker
  cd "$REPO"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env"
  # The committed fly.toml is deployed as-is, with no rendered override.
  echo "$output" | grep -qF 'fly deploy --config deploy/fly/fly.toml'
}

@test "FLY_AUTO_STOP deploys a rendered config, never editing fly.toml" {
  need_docker
  cd "$REPO"
  cp "$BATS_TEST_TMPDIR/env" "$BATS_TEST_TMPDIR/env.as"
  echo "FLY_AUTO_STOP=suspend" >> "$BATS_TEST_TMPDIR/env.as"
  # Checksummed around the run, NOT compared against git: fly.toml is often
  # legitimately dirty mid-change, and `git diff --quiet` would then fail for a
  # reason that has nothing to do with what this test is about.
  before="$(md5 -q "$FLY/fly.toml" 2>/dev/null || md5sum "$FLY/fly.toml" | cut -d' ' -f1)"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.as"
  after="$(md5 -q "$FLY/fly.toml" 2>/dev/null || md5sum "$FLY/fly.toml" | cut -d' ' -f1)"
  # A deploy that dirties a tracked file is a deploy that gets committed by
  # accident, so the substitution goes to a temporary copy.
  echo "$output" | grep -qF 'fly deploy --config deploy/fly/.fly.autostop.toml'
  [ "$before" = "$after" ]
}

@test "FLY_AUTO_STOP warns that the leaderboard stops advancing" {
  need_docker
  cd "$REPO"
  cp "$BATS_TEST_TMPDIR/env" "$BATS_TEST_TMPDIR/env.as"
  echo "FLY_AUTO_STOP=stop" >> "$BATS_TEST_TMPDIR/env.as"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.as"
  # The machine holds redis and the poller, so this is not the ordinary
  # stateless-web-app tradeoff Fly's docs describe.
  echo "$output" | grep -qF 'leaderboard does not advance'
}

@test "an invalid FLY_AUTO_STOP is refused, not silently ignored" {
  need_docker
  cd "$REPO"
  cp "$BATS_TEST_TMPDIR/env" "$BATS_TEST_TMPDIR/env.as"
  echo "FLY_AUTO_STOP=true" >> "$BATS_TEST_TMPDIR/env.as"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.as"
  [ "$status" -ne 0 ]
  # `true` is the obvious guess and is NOT one of Fly's values.
  echo "$output" | grep -qF 'Use off, stop or suspend'
}

@test "the autostop override drops min_machines_running to 0" {
  # Fly keeps one machine up regardless if the minimum stays at 1, so the
  # setting would look applied and do nothing.
  grep -qF 'min_machines_running = 0' "$FLY/deploy.sh"
}

@test "the autostop override file is gitignored" {
  cd "$REPO" && git check-ignore -q deploy/fly/.fly.autostop.toml
}

# ---------------------------------------------------------------------------
# One URL, in one place.
# ---------------------------------------------------------------------------

@test "ctf-setup reads the URL from the env file, and from nowhere else" {
  # It renders the leaderboard link into every fork's score comment. The URL
  # is a DEPLOYMENT fact (ADR 43): one event is served from a box, from AWS
  # and from fly.io on three hostnames, which is why .env and .env.fly hold
  # different EVENT_URLs for one event. It used to be an `event.url` field in
  # the config file config v2 deleted, and a stale one left sign-in working
  # while contestants got a dead leaderboard link.
  #
  # Asserted on env_url's BODY, not just on the string EVENT_URL appearing
  # somewhere: the whole point is that the one reader resolves it out of the
  # env file.
  body="$(awk '/^env_url\(\) \{/{f=1} f{print} /^}/{if(f)exit}' "$REPO/setup/ctf-setup.sh")"
  [ -n "$body" ] || { echo "env_url() is gone from ctf-setup.sh"; return 1; }
  echo "$body" | grep -qF 'env_val EVENT_URL'
}

@test "the scorer mirror is checked for a linux/amd64 build" {
  # `buildx imagetools create` mirrors faithfully, including a single-arch
  # arm64 image built on an Apple Silicon laptop. Fly machines are amd64, and
  # without this the failure lands at the very END of the deploy, after both
  # images are rebuilt and pushed and the secrets set:
  #
  #   failed to resolve image for container "scorer":
  #   platform not found: linux/amd64
  #
  # app and sync cannot hit it — deploy.sh builds those with an explicit
  # --platform. The scorer is the one image built by hand, elsewhere.
  grep -qF 'linux/amd64' "$FLY/deploy.sh"
  grep -qF 'has no linux/amd64 build' "$FLY/deploy.sh"
}

@test "the scorer rebuild instruction carries the platform flag" {
  # The message has to include the flag, because the command WITHOUT it is the
  # one people naturally type — and is exactly what produced the arm64 image.
  grep -qF 'docker build --platform linux/amd64 -t $SCORE_IMAGE scorer/' "$FLY/deploy.sh"
}

@test "images are pinned by digest, not deployed by tag" {
  # A tag is a moving pointer that Fly resolves when the machine starts. A
  # rebuilt-and-repushed :scorer did not reach a running machine — the registry
  # held the new image, the machine kept serving the old one, and the only
  # symptom was a 404 on a route the new build has. Nothing in the deploy
  # output was wrong, which is what made it expensive to find.
  grep -qF 'pin_digest()' "$FLY/deploy.sh"
  grep -qF '{{.Manifest.Digest}}' "$FLY/deploy.sh"
}

@test "digest pinning falls back to the tag rather than failing the deploy" {
  # An older buildx has no --format. A deploy that still works on a tag beats
  # one that refuses to run.
  grep -qF '*) echo "$ref" ;;' "$FLY/deploy.sh"
}

@test "the platform check distinguishes 'absent' from 'could not look'" {
  # The first version treated a failed inspect as a missing platform and
  # blocked a valid deploy: registry.fly.io returns transient errors, stderr
  # was swallowed, and an empty result read as "no amd64". A check that cannot
  # tell those apart fails exactly when the registry is briefly unwell, which
  # is unrelated to what it guards.
  grep -qF 'could not inspect' "$FLY/deploy.sh"
  # And it must actually retry rather than give up on one bad response.
  grep -qF 'for _ in 1 2; do' "$FLY/deploy.sh"
}

@test "render: a colon-delimited SCORE_IMAGE assignment still enables secdev" {
  need_docker
  # Compose's .env grammar takes `KEY: value` as well as `KEY=value`. A reader
  # that only knew `=` read a colon-delimited SCORE_IMAGE as unset and rendered
  # an app-only stack for an event that has a scorer.
  sed 's|^SCORE_IMAGE=.*|SCORE_IMAGE: ghcr.io/fixture-org/score:latest|' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.colon"
  out="$BATS_TEST_TMPDIR/colon.yml"
  "$FLY/render-compose.sh" --env-file "$BATS_TEST_TMPDIR/env.colon" --out "$out" \
    --app-image reg/app:t --sync-image reg/sync:t --scorer-image reg/scorer:t
  [ -s "$out" ]
  # Both services, not either: a regression dropping one must not pass.
  grep -qE '^  scorer:' "$out"
  grep -qE '^  sync:' "$out"
}

@test "deploy reads a colon-delimited .env assignment, the way compose does" {
  need_docker
  cd "$REPO"
  # The deploy.sh half: `SCORE_IMAGE: ghcr.io/...` used to read as empty and
  # `require` refused a file compose would have deployed. The value itself
  # contains a colon (the image tag), so the delimiter match must stop at the
  # first one after the key and leave the rest intact.
  sed -e 's|^SCORE_IMAGE=|SCORE_IMAGE: |' \
      -e 's|^ADMIN_LOGINS=|ADMIN_LOGINS : |' \
    "$BATS_TEST_TMPDIR/env" > "$BATS_TEST_TMPDIR/env.colon"
  run ./deploy/fly/deploy.sh --dry-run --env-file "$BATS_TEST_TMPDIR/env.colon"
  [ "$status" -eq 0 ]
  echo "$output" | grep -qF 'ghcr.io/fixture-org/score:latest'
}
