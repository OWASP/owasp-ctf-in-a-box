import { GITHUB_TIMEOUT_MS } from "./github.js";
import crypto from "node:crypto";

const b64url = (input) => Buffer.from(input).toString("base64url");

// Short-lived GitHub App JWT (RS256), hand-rolled — no jsonwebtoken dependency.
// iat is backdated 60s for clock skew; exp is capped at 10 min per GitHub's limit.
export function mintAppJwt({ appId, privateKey, now = Date.now() }) {
  const iat = Math.floor(now / 1000) - 60;
  const exp = iat + 600;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp, iss: String(appId) }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(privateKey, "base64url");
  return `${signingInput}.${signature}`;
}

const GH_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// With no org and no configured id, a lone installation is unambiguous and
// several are refused rather than guessed between. (With an org, getToken asks
// GitHub for that org's installation directly — see below.)
function pickSoleInstallation(list) {
  const logins = list.map((i) => i?.account?.login ?? "?").join(", ");
  if (list.length > 1) {
    throw new Error(`GitHub App has ${list.length} installations (${logins}); set GITHUB_APP_INSTALLATION_ID to choose one`);
  }
  return list[0].id;
}

// Installation-token provider: mints an App JWT, exchanges it for an
// installation token, caches it, and refreshes when near expiry. Pure/testable
// via injected fetchImpl + now.
export function makeAppAuth({ appId, privateKey, installationId, org, apiUrl = "https://api.github.com" }) {
  let cache = null;      // { token, expiresAt(ms) }
  let instId = installationId;

  async function ghJson(url, opts, what) {
    const res = await opts.fetchImpl(url, {
      method: opts.method,
      headers: { authorization: `Bearer ${opts.jwt}`, ...GH_HEADERS },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} ${what}`);
    return res.json();
  }

  async function getToken(fetchImpl = fetch, now = Date.now()) {
    if (cache && cache.expiresAt - now > REFRESH_SKEW_MS) return cache.token;
    const jwt = mintAppJwt({ appId, privateKey, now });
    if (instId == null && org) {
      // The event org's own installation, asked for directly. An App
      // installed on several orgs used to hand back the FIRST one's token,
      // which polls nothing when that is not the event's org — and the list
      // pages at 30, so a match on a later page was never seen.
      const res = await fetchImpl(`${apiUrl}/orgs/${encodeURIComponent(org)}/installation`, {
        method: "GET",
        headers: { authorization: `Bearer ${jwt}`, ...GH_HEADERS },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      if (res.status === 404) {
        throw new Error(`GitHub App is not installed on ${org}; install it there, or set GITHUB_APP_INSTALLATION_ID`);
      }
      if (!res.ok) throw new Error(`GitHub ${res.status} looking up the installation on ${org}`);
      const inst = await res.json();
      if (!Number.isInteger(inst?.id)) throw new Error(`GitHub returned no installation id for ${org}`);
      instId = inst.id;
    } else if (instId == null) {
      const list = await ghJson(`${apiUrl}/app/installations`, { fetchImpl, jwt, method: "GET" }, "listing app installations");
      if (!Array.isArray(list) || list.length === 0) throw new Error("GitHub App has no installations");
      instId = pickSoleInstallation(list);
    }
    const body = await ghJson(`${apiUrl}/app/installations/${instId}/access_tokens`, { fetchImpl, jwt, method: "POST" }, "minting installation token");
    const expiresAt = typeof body.expires_at === "string" ? new Date(body.expires_at).getTime() : NaN;
    // A missing, unparseable, or already-past expiry would make
    // `expiresAt - now > skew` false forever (NaN, 0 for `null`, or a past
    // instant all fail it), so every call would silently mint a fresh JWT
    // and installation token. That is a broken response; fail the tick and
    // let the next one retry.
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error(`GitHub installation token has an unusable expires_at: ${JSON.stringify(body.expires_at)}`);
    }
    cache = { token: body.token, expiresAt };
    return cache.token;
  }

  return { getToken };
}
