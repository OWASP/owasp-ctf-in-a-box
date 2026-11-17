// destructiveLiveRedisAllowed: the gate on live suites that sweep real
// namespaces (`ctf:auth:*`, `ctf:link:*`). They may run only against a Redis
// that is plainly a throwaway: a local or CI srh, or CI's required run.

import { describe, expect, it } from "vitest";
import { destructiveLiveRedisAllowed } from "./live-redis";

describe("destructiveLiveRedisAllowed", () => {
  it.each(["http://localhost:8079", "http://127.0.0.1:8079", "http://srh:80", "http://LOCALHOST:8079"])(
    "allows a local proxy at %s",
    (url) => {
      expect(destructiveLiveRedisAllowed({ UPSTASH_REDIS_REST_URL: url })).toBe(true);
    },
  );

  it.each(["https://eu1-sweet-cat-12345.upstash.io", "http://redis.example.com", "http://localhost.example.com", "not a url", ""])(
    "refuses %s without the CI flag",
    (url) => {
      expect(destructiveLiveRedisAllowed({ UPSTASH_REDIS_REST_URL: url })).toBe(false);
    },
  );

  it("refuses when no URL is configured", () => {
    expect(destructiveLiveRedisAllowed({})).toBe(false);
  });

  it("allows any host when CTF_LUA_SUITES_REQUIRED=1, so CI never skips it", () => {
    expect(
      destructiveLiveRedisAllowed({ UPSTASH_REDIS_REST_URL: "https://eu1-sweet-cat-12345.upstash.io", CTF_LUA_SUITES_REQUIRED: "1" }),
    ).toBe(true);
  });
});
