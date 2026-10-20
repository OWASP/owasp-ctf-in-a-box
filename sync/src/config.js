import { makeAppAuth } from "./appAuth.js";

export const TARGETS = ["juice-shop", "dvwa", "webgoat", "securityshepherd", "vulnerableapp", "vampi"];

export const REPO_NAMES = {
  "juice-shop": "juice-shop",
  dvwa: "DVWA",
  webgoat: "WebGoat",
  securityshepherd: "SecurityShepherd",
  vulnerableapp: "VulnerableApp",
  vampi: "VAmPI",
};

// Poll auth: a GitHub App (org-scoped, auto-expiring, revocable installation
// tokens). Returns a uniform async getToken(fetchImpl) seam.
function resolveAuth(env, apiUrl) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("auth: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required (GitHub App)");
  }
  const privateKey = Buffer.from(env.GITHUB_APP_PRIVATE_KEY, "base64").toString("utf8");
  if (!privateKey.includes("PRIVATE KEY")) {
    throw new Error("GITHUB_APP_PRIVATE_KEY must be base64-encoded PEM (a PEM private key)");
  }
  const installationId = env.GITHUB_APP_INSTALLATION_ID ? Number(env.GITHUB_APP_INSTALLATION_ID) : undefined;
  // Number("abc") is NaN, which would mint against /installations/NaN on every
  // tick; refuse it here, where the operator is looking.
  if (installationId !== undefined && !(Number.isInteger(installationId) && installationId > 0)) {
    throw new Error(`GITHUB_APP_INSTALLATION_ID must be a positive integer (got ${JSON.stringify(env.GITHUB_APP_INSTALLATION_ID)})`);
  }
  // The org picks the installation when no id is set (appAuth.js).
  const auth = makeAppAuth({ appId: env.GITHUB_APP_ID, privateKey, installationId, org: (env.GITHUB_ORG ?? "").trim(), apiUrl });
  return { getToken: (fetchImpl) => auth.getToken(fetchImpl) };
}

/** A numeric env knob that must be an integer in [1, max].
 *
 *  `Number("abc")` is NaN and `setTimeout(NaN)` fires immediately, so a
 *  typo'd POLL_INTERVAL_MS would poll GitHub in a tight loop with no error
 *  anywhere. The upper bound matters too: setTimeout caps at 2^31-1 ms and
 *  treats anything larger as 1 ms — the same tight loop from the other side.
 *  Refuse at boot, like every other config mistake. */
function positiveInt(raw, fallback, name, max) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new Error(`${name} must be an integer between 1 and ${max} (got ${JSON.stringify(raw)})`);
  }
  return n;
}

// main() adds up to +20% jitter to the poll interval before sleeping, so the
// largest interval that still lands inside setTimeout's 2^31-1 ms range after
// jitter is floor((2^31 - 1) / 1.2).
const POLL_INTERVAL_MAX_MS = Math.floor((2 ** 31 - 1) / 1.2);

// config-v2 (#386): sync is configured from `.env` alone — the old
// bind-mounted YAML config file is gone. Whether sync runs at all is
// decided by the compose profile (`secdev`),
// not by module presence in a config file: sync no longer decides "am I
// enabled", so a missing/blank GITHUB_ORG is a genuine misconfiguration, not
// "nothing to poll" — it throws, naming the key, rather than returning null.
//
// `env = process.env` is a default PARAMETER, not a read from inside the
// function body: everything below reads only from the `env` argument, so
// loadConfig stays pure over what it's given and testable with a plain
// object.
export function loadConfig(env = process.env) {
  const org = (env.GITHUB_ORG ?? "").trim();
  if (!org) throw new Error("GITHUB_ORG is not set");
  if (!env.SCORER_TOKEN) throw new Error("SCORER_TOKEN env var is required");
  const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com";
  const { getToken } = resolveAuth(env, apiUrl);
  return {
    org,
    getToken,
    apiUrl,
    scorerUrl: env.SCORER_URL ?? "http://scorer:4000",
    scorerToken: env.SCORER_TOKEN,
    pollIntervalMs: positiveInt(env.POLL_INTERVAL_MS, 30000, "POLL_INTERVAL_MS", POLL_INTERVAL_MAX_MS),
    statePath: env.STATE_PATH ?? "/state/state.json",
    commentAuthor: env.COMMENT_AUTHOR ?? "github-actions[bot]",
  };
}
