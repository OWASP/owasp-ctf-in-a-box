// The gate on live suites that sweep real namespaces. Kept out of
// live-redis.ts so its own unit test does not load that harness (which arms
// the CTF_LUA_SUITES_REQUIRED gate and must only be imported by
// *.upstash.test.ts suites, see live-suites-named.test.ts).

const THROWAWAY_HOSTS = new Set(["localhost", "127.0.0.1", "srh"]);

/**
 * Whether a live suite may sweep real namespaces (`ctf:auth:*`, `ctf:link:*`,
 * the master reset). Those suites delete every account on the Redis they are
 * pointed at, so a developer whose `.env.local` names a shared or production
 * Upstash must not run them by accident: they run only against a local or CI
 * srh, or when `CTF_LUA_SUITES_REQUIRED=1`, which CI sets so it never skips
 * them. Use as `describe.skipIf(!liveConfigured || !destructiveLiveRedisAllowed())`.
 */
export function destructiveLiveRedisAllowed(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  if (env.CTF_LUA_SUITES_REQUIRED === "1") return true;
  try {
    return THROWAWAY_HOSTS.has(new URL(env.UPSTASH_REDIS_REST_URL ?? "").hostname.toLowerCase());
  } catch {
    return false;
  }
}
