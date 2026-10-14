# scorer/entrypoints/securityshepherd.sh
# Security Shepherd bring-up. Sourced by entrypoint.sh.
#
# The heaviest of the six targets, and the only one with no prebuilt stock image:
# `owaspsecurityshepherd/shepherd` does not exist, and the one published image
# (`owasp/security-shepherd`) was last pushed in 2018, years before the release-17
# tree this rubric targets. So there is nothing to pull — the app is BUILT here, from
# a Maven prebuild feeding a THREE-container stack (Tomcat + MariaDB + MongoDB) over
# TLS. Distilled from the upstream reference bring-up
# (.github/actions/ctf-score/entrypoints/score-securityshepherd-challenges.sh).
#
# WHY the source goes through a named VOLUME: the source lands inside THIS container's
# filesystem, but the Maven and image builds run as SIBLING containers on the host
# daemon — a sibling's `-v <path>` mount resolves against the HOST, not against us, so
# it would see nothing. A named volume is the one handoff both sides can reach.
#
# WHY the internet-less $NETWORK is not a problem for the build: only the three app
# containers join $NETWORK (step 4). The Maven and image builds (steps 2-3) run with no
# --network at all, so they land on the daemon's default bridge, which has internet.
#
# CONTAINER NAMES are load-bearing. The WAR bakes jdbc:mariadb://secshep_mariadb:3306
# and connectionHost=secshep_mongo, and the vendored helpers.js `docker exec`s those
# exact names to provision the shared attacker account. So the siblings MUST be
# secshep_mariadb / secshep_mongo / secshep_tomcat. Tomcat ALSO takes the $APP_HOST
# network alias, because it rejects an underscore host ("secshep_tomcat") with HTTP 400
# and $APP_URL has to resolve to something it will serve.
#
# TLS: the bundled self-signed certificate expired in 2019, so chain verification can
# never succeed. Do NOT terminate TLS or re-issue the cert — the rubric's helpers
# disable verification deliberately and several tests assert on TLS-level behaviour.
# NODE_TLS_REJECT_UNAUTHORIZED=0 is therefore needed, but it is deliberately NOT
# exported: entrypoint.sh `exec`s the judge from this same shell, so an export would
# strip certificate verification from every request the judge makes, not just the
# ones aimed at this app. Instead it is set per-command on the two readiness probes below,
# which are the only things here that speak to the expired cert. The exec children do
# not need it either: the vendored tests/helpers.js sets it for itself (all 40 test
# files import that helper). And the judge's own waitForApp is switched off with
# APP_READY_TRIES=0 — see step 5, where readiness is proven far more strongly.

# APP_IMAGE is deliberately UNUSED here, and it is the only bring-up that ignores it: the
# three images are one unit — the WAR, the MariaDB schema and the Mongo seed are all
# outputs of the same Maven run — so a prebuilt Tomcat image paired with freshly built
# siblings would boot against a schema it was never compiled for. Source is the only
# coherent input. `scripts/acceptance-target.sh securityshepherd none` passes an empty
# APP_IMAGE to say exactly that.
SS_UPSTREAM_REPO="${SS_UPSTREAM_REPO:-OWASP/SecurityShepherd}"
# Pinned to a COMMIT, never a branch: `dev` moves, and a silent upstream change would
# score a different app on every run and could quietly inflate the stock score. This SHA
# is dev's HEAD at pin time (release 17), the same one upstream pins. Bump it only
# together with a fresh stock-scores-zero run.
SS_UPSTREAM_REF="${SS_UPSTREAM_REF:-662771bfcc4d1e205b2d682d26edf95dd3c95cf5}"

# Pinned build inputs — the literal upstream .env / docker-compose.yml values. HTTPS_PORT
# is 8443 rather than the 443 default so the TLS connector matches the port $APP_URL uses.
MAVEN_IMAGE="maven:3.9-eclipse-temurin-17@sha256:1a352420f7aba21f5ad08df31bab55f74c013fb491f1ae8ab1dd7ff9ed698584"
DOCKER_CLI_IMAGE="docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c"
# pins: built locally below from the pinned source, never pulled
IMG_TOMCAT="owasp/security-shepherd"
# pins: built locally below from the pinned source, never pulled
IMG_MARIADB="owasp/security-shepherd_mariadb"
# pins: built locally below from the pinned source, never pulled
IMG_MONGO="owasp/security-shepherd_mongo"
SRC_VOL="ss_src"

# Idempotent re-runs.
docker rm -f secshep_tomcat secshep_mariadb secshep_mongo >/dev/null 2>&1 || true
docker volume rm -f "$SRC_VOL" >/dev/null 2>&1 || true

# Registered BEFORE anything is started, so entrypoint.sh's cleanup reaps the whole stack
# even if the bring-up aborts partway through.
BOOTED="secshep_tomcat"
EXTRA_CONTAINERS="secshep_mariadb secshep_mongo"

# 1) Stage the source into the shared volume.
docker volume create "$SRC_VOL" >/dev/null
SRC="${GITHUB_WORKSPACE:-/github/workspace}"
if [ -f "$SRC/pom.xml" ] && [ -f "$SRC/docker-compose.yml" ]; then
  # Patch-to-score: the contestant's checked-out Security Shepherd tree.
  echo "securityshepherd: staging the PR workspace source ($SRC)…"
  tar --exclude=./.git -C "$SRC" -cf - . \
    | docker run --rm -i -v "$SRC_VOL":/src -w /src alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 tar -xf -
else
  echo "securityshepherd: no source in the workspace — cloning $SS_UPSTREAM_REPO@$SS_UPSTREAM_REF…"
  # `git clone -b` cannot take a bare commit SHA, so init + fetch + checkout the exact ref.
  docker run --rm -v "$SRC_VOL":/src --entrypoint sh alpine/git:v2.54.0@sha256:ce84fd6a057b4dc5cf5009da2dd832f1c6d096c1984bf50496cf3c256402264d -c '
    set -e
    cd /src
    git init -q
    git remote add origin "https://github.com/'"$SS_UPSTREAM_REPO"'.git"
    git fetch --depth 1 -q origin "'"$SS_UPSTREAM_REF"'"
    git checkout -q FETCH_HEAD' || { echo "securityshepherd: source checkout failed" >&2; exit 1; }
fi

# 2) Maven build. Not optional and not a caching nicety: all three Dockerfiles `COPY
#    target/…` (the WAR, the MariaDB schema, moduleSchemas.js, the HTTPS keystore), so
#    `docker build` fails outright without these outputs. Pinned toolchain (JDK 17 +
#    Maven 3.9) to match the tree's <release>17</release>, independent of the runner.
#    Output is buffered and replayed only on failure: a green build is ~1500 lines of
#    dependency downloads that bury the scoring log, and the tail on failure is what an
#    organizer actually needs.
echo "securityshepherd: building the WAR (Maven)…"
# pins: MAVEN_IMAGE is digest-pinned where it is set, above
docker run --rm -v "$SRC_VOL":/src -w /src "$MAVEN_IMAGE" \
  mvn -Pdocker clean install -DskipTests -B >/tmp/ss-maven.log 2>&1 || {
  echo "securityshepherd: Maven build FAILED" >&2
  tail -60 /tmp/ss-maven.log >&2
  exit 1
}

# 3) Build the three images from the volume, in a docker-CLI sibling that holds BOTH the
#    source volume and the socket: `docker build` reads the context from the volume and
#    streams it to the host daemon. The three share no layers or outputs (each COPYs a
#    different Maven artifact) and are mostly I/O, so they run concurrently. Each build's
#    output is buffered and replayed only on failure — three interleaved build logs are
#    unreadable, and a green run does not need them.
echo "securityshepherd: building the Tomcat/MariaDB/MongoDB images…"
# pins: DOCKER_CLI_IMAGE is digest-pinned where it is set, above
docker run --rm -v "$SRC_VOL":/src -v /var/run/docker.sock:/var/run/docker.sock -w /src \
  "$DOCKER_CLI_IMAGE" sh -euc '
    docker build -t '"$IMG_MARIADB"' \
      --build-arg DB_VERSION=10.6.11 --build-arg DB_BIND_ADDRESS="*" \
      --build-arg CONTAINER_TOMCAT=secshep_tomcat --build-arg DOCKER_NETWORK_NAME=securityshepherd_default \
      docker/mariadb >/tmp/build-mariadb.log 2>&1 &
    pid_mariadb=$!
    docker build -t '"$IMG_MONGO"' \
      --build-arg MONGODB_VERSION=4.1.13 --build-arg MONGO_BIND_ADDRESS=127.0.0.1 \
      docker/mongo >/tmp/build-mongo.log 2>&1 &
    pid_mongo=$!
    docker build -t '"$IMG_TOMCAT"' \
      --build-arg TOMCAT_DOCKER_VERSION=9.0-jre17-temurin \
      --build-arg DB_USER=root --build-arg DB_PASS=CowSaysMoo \
      --build-arg MARIADB_URI=jdbc:mariadb://secshep_mariadb:3306 \
      --build-arg MONGO_HOST=secshep_mongo --build-arg MONGO_PORT=27017 \
      --build-arg MONGO_CONN_TIMEOUT=1000 --build-arg MONGO_SOCK_TIMEOUT=0 --build-arg MONGO_SVR_TIMEOUT=30000 \
      --build-arg TLS_KEYSTORE_FILE=shepherdKeystore.p12 --build-arg TLS_KEYSTORE_PASS=CowSaysMoo \
      --build-arg ALIAS=tomcat --build-arg HTTPS_PORT=8443 \
      . >/tmp/build-tomcat.log 2>&1 &
    pid_tomcat=$!

    rc=0
    wait $pid_mariadb || { echo "!! mariadb image build FAILED"; tail -40 /tmp/build-mariadb.log; rc=1; }
    wait $pid_mongo   || { echo "!! mongo image build FAILED";   tail -40 /tmp/build-mongo.log;   rc=1; }
    wait $pid_tomcat  || { echo "!! tomcat image build FAILED";  tail -40 /tmp/build-tomcat.log;  rc=1; }
    [ "$rc" -eq 0 ] || exit 1
  ' || { echo "securityshepherd: image build FAILED" >&2; exit 1; }

# The images now carry the artifacts — free the disk.
docker volume rm -f "$SRC_VOL" >/dev/null 2>&1 || true

# 4) Run the three siblings on $NETWORK. MariaDB and Mongo seed themselves from
#    /docker-entrypoint-initdb.d on first boot; no volumes are attached, so every run
#    starts from a known-fresh schema.
echo "securityshepherd: starting the stack…"
# pins: built locally above from the pinned source
docker run -d --name secshep_mariadb --network "$NETWORK" \
  -e MYSQL_ROOT_PASSWORD=CowSaysMoo "$IMG_MARIADB" >/dev/null
# pins: built locally above from the pinned source
docker run -d --name secshep_mongo --network "$NETWORK" "$IMG_MONGO" >/dev/null
# pins: built locally above from the pinned source
docker run -d --name secshep_tomcat --network "$NETWORK" --network-alias "$APP_HOST" \
  "$IMG_TOMCAT" >/dev/null

# The judge must not probe this app itself: its only tool is a plain fetch, which the
# 2019-expired certificate fails, and making that fetch succeed would mean disabling
# certificate verification for the whole judge process, every request it makes
# included. The handshake in step 5 is a strictly stronger readiness
# signal anyway (a completed admin LOGIN, not a 200 from any URL), so hand the judge that
# guarantee instead of a downgraded transport. An app that dies after this point is still
# caught: every exec child then fails to report and the judge aborts rather than
# publishing a zero.
export APP_READY_TRIES=0

# 5) Wait for readiness and bootstrap the admin password.
#
# The readiness signal is a SUCCESSFUL ADMIN LOGIN, not a 200 from /login.jsp: Tomcat
# serves that page within seconds of starting, long before MariaDB has finished seeding,
# so treating it as ready would hand a half-booted app to the judge. Every one of the 40
# test files calls loginShepherd() at TOP LEVEL, before registering a single test — so an
# app whose DB is not up yet produces 40 children that throw before any assertion runs,
# reporting neither ✔ nor ✖. That scores a clean-looking 0/40 with nothing actually
# tested: the vacuous zero this handshake exists to rule out.
#
# The bootstrap itself: stock admin ships with the TEMP password "password", forced to
# reset on first login, while the rubric logs in as admin/SecurityShepherd. So POST /login
# with the temp password to pick up the CSRF token cookie, then POST /passwordChange. The
# whole sequence is retried, because an early failure usually just means the DB is still
# seeding.
echo "securityshepherd: waiting for the app and bootstrapping the admin password…"
NODE_TLS_REJECT_UNAUTHORIZED=0 APP_URL="$APP_URL" node -e '
  const B = process.env.APP_URL;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = (u, o = {}) => fetch(u, { signal: AbortSignal.timeout(8000), ...o });
  const jar = new Map();
  const add = (r) => { for (const h of r.headers.getSetCookie()) { const p = h.split(";")[0], i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
  const ck = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");
  // Shepherd answers a bad login with 302 -> login.jsp and a good one with 302 -> index.jsp,
  // so the redirect target is the only reliable success test; the status alone is not.
  const login = async (pwd) => { jar.clear(); const r = await get(B + "/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "login=admin&pwd=" + encodeURIComponent(pwd) }); add(r); return { status: r.status, loc: r.headers.get("location") || "" }; };
  const ok = (r) => r.status === 302 && r.loc.includes("index.jsp");
  (async () => {
    let served = false;
    for (let i = 0; i < 120; i++) {
      try { if ((await get(B + "/login.jsp")).ok) { served = true; console.log("securityshepherd: Tomcat serving /login.jsp after " + i + " attempt(s)"); break; } } catch {}
      await sleep(2000);
    }
    if (!served) { console.error("securityshepherd: Tomcat never served /login.jsp"); process.exit(2); }

    for (let i = 0; i < 60; i++) {
      // Idempotent: a re-run (or a retry after a partial failure) finds it already set.
      if (ok(await login("SecurityShepherd"))) { console.log("securityshepherd: admin/SecurityShepherd login verified after " + i + " attempt(s)"); process.exit(0); }
      if (ok(await login("password"))) {
        const t = jar.get("token") || "";
        await get(B + "/passwordChange", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: ck() }, body: "currentPassword=password&newPassword=SecurityShepherd&passwordConfirmation=SecurityShepherd&csrfToken=" + t }).catch(() => {});
      }
      await sleep(2000);
    }
    console.error("securityshepherd: admin/SecurityShepherd never reached index.jsp — refusing to hand a half-booted app to the judge");
    process.exit(3);
  })();
' || exit 1

# 6) The build bakes an INCOMPLETE conf/mongo.properties (no DB credentials), so every
#    NoSQL request 500s. helpers.js writes the file too, but it cannot reload a running
#    Tomcat, and the config is read once at startup — so write it here, where the restart
#    that picks it up is guaranteed to happen before scoring starts.
echo "securityshepherd: writing conf/mongo.properties and reloading Tomcat…"
docker exec secshep_tomcat sh -c 'printf "%b" "connectionHost=secshep_mongo\nconnectionPort=27017\ndatabaseName=shepherdGames\ndatabaseUsername=gamer1\ndatabasePassword=\$ecSh3pdb\ndatabaseCollection=gamer\nconnectTimeout=10000\nsocketTimeout=0\nserverSelectionTimeout=30000\npool.connectionsPerHost=10\npool.minConnectionsPerHost=2\n" > /usr/local/tomcat/conf/mongo.properties'
docker restart secshep_tomcat >/dev/null

# Re-verify the login after the reload rather than just waiting for /login.jsp: the same
# vacuous-zero risk applies to a Tomcat that came back up but lost its DB connection.
NODE_TLS_REJECT_UNAUTHORIZED=0 APP_URL="$APP_URL" node -e '
  const B = process.env.APP_URL;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = (u, o = {}) => fetch(u, { signal: AbortSignal.timeout(8000), ...o });
  (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await get(B + "/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "login=admin&pwd=SecurityShepherd" });
        if (r.status === 302 && (r.headers.get("location") || "").includes("index.jsp")) { console.log("securityshepherd: ready — admin logs in after the reload (" + i + " attempt(s))"); process.exit(0); }
      } catch {}
      await sleep(2000);
    }
    console.error("securityshepherd: admin cannot log in after the mongo.properties reload"); process.exit(4);
  })();
' || exit 1
