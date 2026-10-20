# scorer/entrypoints/dvwa.sh
# DVWA bring-up. Sourced by entrypoint.sh.
#
# Distilled from the upstream reference entrypoint. DVWA needs more than a
# container: a MariaDB sibling, and a schema init that recent DVWA gates behind
# a session cookie plus an anti-CSRF user_token. A successful admin login
# (302 -> index) is the only trustworthy "DB ready" signal — the setup.php POST
# returning 200 is not.
docker rm -f db >/dev/null 2>&1 || true

echo "dvwa: starting MariaDB…"
docker run -d --name db --network "$NETWORK" \
  -e MYSQL_ROOT_PASSWORD=dvwa -e MYSQL_DATABASE=dvwa \
  -e MYSQL_USER=dvwa -e MYSQL_PASSWORD='p@ssw0rd' \
  docker.io/library/mariadb:10@sha256:7db29378d4fdab73f8123bbc2b48905c90d1a4b00cf848b028f1e81e623257f2 >/dev/null
EXTRA_CONTAINERS="db"

if [ -n "${APP_IMAGE:-}" ]; then
  # pins: APP_IMAGE is chosen, and pinned, by whoever passes it in
  docker pull "$APP_IMAGE" >/dev/null
  IMAGE="$APP_IMAGE"
elif [ -f "${GITHUB_WORKSPACE:-/github/workspace}/Dockerfile" ]; then
  docker build -t ctf-app-under-test "${GITHUB_WORKSPACE:-/github/workspace}" >/dev/null
  # pins: built locally from the PR checkout, never pulled
  IMAGE=ctf-app-under-test
else
  echo "dvwa: need APP_IMAGE or a workspace Dockerfile" >&2
  exit 1
fi

echo "dvwa: starting the app…"
# pins: the app under test: APP_IMAGE, or an image built from the PR checkout
docker run -d --rm \
  --network "$NETWORK" \
  --network-alias "$APP_HOST" \
  --name "$APP_CONTAINER" \
  -e DB_SERVER=db -e DB_DATABASE=dvwa -e DB_USER=dvwa -e DB_PASSWORD='p@ssw0rd' \
  -e RECAPTCHA_PRIV_KEY='' -e RECAPTCHA_PUB_KEY='' \
  -e DEFAULT_SECURITY_LEVEL=low \
  "$IMAGE" >/dev/null
BOOTED="$APP_CONTAINER"

echo "dvwa: waiting for the app and initialising its database…"
APP_URL="$APP_URL" node -e '
  const B = process.env.APP_URL;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = (u, o = {}) => fetch(u, { signal: AbortSignal.timeout(8000), ...o });
  const jar = new Map();
  const add = (r) => { for (const h of r.headers.getSetCookie()) { const p = h.split(";")[0], i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
  const ck = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");
  const tok = (h) => { const i = h.indexOf("user_token"); const m = i < 0 ? null : h.slice(i).match(/[a-f0-9]{32}/i); return m ? m[0] : ""; };
  (async () => {
    let up = false;
    for (let i = 0; i < 45; i++) { try { if ((await get(B + "/login.php")).ok) { up = true; break; } } catch {} await sleep(2000); }
    if (!up) { console.error("DVWA never served a healthy /login.php"); process.exit(2); }
    for (let i = 0; i < 30; i++) {
      jar.clear();
      const g = await get(B + "/setup.php"); add(g);
      const t = tok(await g.text());
      await get(B + "/setup.php", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: ck() }, body: "create_db=Create+%2F+Reset+Database&user_token=" + t }).then(add).catch(() => {});
      const lg = await get(B + "/login.php"); add(lg);
      const lt = tok(await lg.text());
      const lp = await get(B + "/login.php", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: ck() }, body: "username=admin&password=password&Login=Login&user_token=" + lt });
      if (lp.status === 302 && (lp.headers.get("location") || "").includes("index")) { console.log("DVWA ready (DB initialised) after " + i + " attempt(s)"); process.exit(0); }
      await sleep(2000);
    }
    console.error("DVWA DB never initialised (admin login keeps failing)"); process.exit(3);
  })();
'
