import "server-only";

// What build is actually running, for `/health`.
//
// Three fields, because no one of them answers the question on its own:
//
//   * `version` — the repo-level tag this build was cut from
//     (`apps/web/package.json`, which CONTRIBUTING says tracks the current
//     tag). It only moves on a release, so it CANNOT tell you whether a
//     deploy happened: every commit between v0.4.0 and v0.5.0 reports
//     "0.4.0".
//   * `revision` — the commit. This is the field that answers "did my fix
//     reach the box yet", which is the reason this endpoint exists.
//   * `builtAt` — when the image was built. Distinguishes two deploys of the
//     SAME commit, which is otherwise invisible: a redeploy after a config
//     or secret change rebuilds the image without moving the sha.
//
// `revision` and `builtAt` arrive as build args (see apps/web/Dockerfile) and
// are absent from a plain `next dev` or a `docker build` that doesn't pass
// them. Absent is a first-class answer here — "unknown"/null, never a throw
// and never a 500. A health endpoint that can fail is not a health endpoint.

import { readFileSync } from "node:fs";
import { join } from "node:path";

type AppVersion = {
  /** Repo-level release this build was cut from, or "unknown". */
  version: string;
  /** Short git sha of the build, or "unknown". */
  revision: string;
  /** ISO-8601 build timestamp, or null when the build didn't pass one. */
  builtAt: string | null;
};

const UNKNOWN = "unknown";

/** A sha, or "unknown".
 *
 *  Validated rather than echoed, because this value is world-readable and
 *  arrives from the build environment: `--build-arg APP_BUILD_REV=$(...)` is
 *  whatever the shell produced, and a failed `git rev-parse` in CI would
 *  otherwise put its error text — or a branch name a fork controls — into a
 *  public response body. Only a hex sha gets through. */
export function normalizeRevision(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : UNKNOWN;
}

/** An ISO-8601 instant, or null. Re-serialized from the parsed value rather
 *  than passed through, for the same reason as the sha above. */
export function normalizeBuiltAt(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** The release version from a package.json's raw text, or "unknown".
 *
 *  Separated from the read so the parse failure modes are testable without a
 *  filesystem: this runs on a box an organizer cannot debug, so a truncated
 *  or missing file has to degrade rather than take the endpoint with it. */
export function versionFromPackageJson(raw: string | null): string {
  if (!raw) return UNKNOWN;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/** Read once per process, not per request: the file cannot change under a
 *  running container, and `/health` is the one endpoint that may be polled on
 *  a timer by an uptime check. */
let cached: AppVersion | null = null;

function readPackageJson(): string | null {
  try {
    // `/app/package.json` in the image — the Dockerfile copies the whole app
    // directory, so this is present in production as well as in dev.
    return readFileSync(join(process.cwd(), "package.json"), "utf8");
  } catch {
    return null;
  }
}

export function appVersion(): AppVersion {
  if (cached) return cached;
  cached = {
    version: versionFromPackageJson(readPackageJson()),
    revision: normalizeRevision(process.env.APP_BUILD_REV),
    builtAt: normalizeBuiltAt(process.env.APP_BUILT_AT),
  };
  return cached;
}

/** Test seam: the cache above is module-level, so a suite that stubs the
 *  environment needs a way to make the next call re-read it. */
export function resetAppVersionCache(): void {
  cached = null;
}
