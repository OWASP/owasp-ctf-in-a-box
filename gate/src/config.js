import { makeAppAuth } from "../../sync/src/appAuth.js";

// Reuses sync's App-auth primitive (App JWT -> installation token, cached)
// rather than keeping a second copy of a security-sensitive signer. That makes
// sync/src/appAuth.js a shared input: a change to it must re-run the gate suite
// too (scripts/ci-changes.sh routes it into both the sync and gate areas).
export function loadConfig(env = process.env, apiUrl = "https://api.github.com") {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required");
  }
  const privateKey = Buffer.from(env.GITHUB_APP_PRIVATE_KEY, "base64").toString("utf8");
  if (!privateKey.includes("PRIVATE KEY")) {
    throw new Error("GITHUB_APP_PRIVATE_KEY must be base64-encoded PEM (a PEM private key)");
  }
  let installationId;
  if (env.GITHUB_APP_INSTALLATION_ID) {
    installationId = Number(env.GITHUB_APP_INSTALLATION_ID);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new Error(`GITHUB_APP_INSTALLATION_ID must be a positive integer (got ${JSON.stringify(env.GITHUB_APP_INSTALLATION_ID)})`);
    }
  }
  if (!env.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required");
  }
  return {
    appId: env.GITHUB_APP_ID,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    apiUrl,
    auth: makeAppAuth({ appId: env.GITHUB_APP_ID, privateKey, installationId, apiUrl }),
  };
}
