// Shared harness for the `*.lua.upstash.test.ts` suites: the grading Lua
// scripts run against a REAL Redis behind the SRH proxy, because that is the
// only place their semantics — the already-solved polarity, the cap and
// cooldown comparisons, which hash each counter is keyed into, what happens
// on a first-ever submission with no attempts row — can be observed. Every
// mocked grade test pins what the store HANDS the script; these pin what the
// script DOES with it.
//
// Credentials come from the environment, falling back to .env.local locally
// (the same convention as the other `.upstash` suites). Locally the suites
// skip when nothing is configured. In CI the `app` job brings up redis + srh
// and sets CTF_LUA_SUITES_REQUIRED=1, which turns "not configured" from a
// silent skip into a failure — a gate that quietly skips is not a gate.
//
// Isolation: every key a suite touches is derived from `liveKey()`, so the
// three suites share one Redis with each other and with the older `.upstash`
// suites without ever reading or writing the same hash.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

for (const file of [path.resolve(process.cwd(), ".env.local")]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key.startsWith("UPSTASH_REDIS_REST_") && !process.env[key]) process.env[key] = value;
  }
}

export const liveConfigured = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

if (process.env.CTF_LUA_SUITES_REQUIRED && !liveConfigured) {
  throw new Error(
    "CTF_LUA_SUITES_REQUIRED is set but UPSTASH_REDIS_REST_URL/TOKEN are not — the Lua suites would skip, and CI must not pass on a skip",
  );
}

/** Run-unique, so parallel workers and repeated runs never share a key. */
export const RUN = `${Date.now().toString(36)}-${process.pid.toString(36)}`;

/** A key under this run's namespace: `vt:<run>:<suite>:<name>`. */
export function liveKey(suite: string, name: string): string {
  return `vt:${RUN}:${suite}:${name}`;
}

let counter = 0;
/** A fresh id per test, so no test depends on what an earlier one wrote. */
export function freshId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** The exact JSON the scripts write for an attempts row — pinned here so a
 *  test names the whole row, not a substring of it. */
export function attemptsRow(attempts: number, firstAt: string, lastAt: string, lastAtMs: number): string {
  return `{"attempts":${attempts},"firstAt":"${firstAt}","lastAt":"${lastAt}","lastAtMs":${lastAtMs}}`;
}
