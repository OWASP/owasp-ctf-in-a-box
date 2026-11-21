import "server-only";

import { assertPipelineOk, parseScanPage, upstashPipeline } from "@/lib/upstash";

export const SCHEMA_VERSION_KEY = "ctf:meta:schema-version";
export const CURRENT_SCHEMA_VERSION = "2";

// Keep aligned with test/fixtures/v1-fingerprints.json.
// This is deliberately independent of RESET_PREFIXES: compatibility
// detection must not depend on the master-reset implementation.
export const V1_FINGERPRINT_PATTERNS = [
  "ctf:solves:*",
  "ctf:team:*",
  "ctf:user:*",
  "ctf:joincode:*",
  "ctf:sd:held:*",
  "ctf:relink:*",
  "ctf:hints:*",
  "ctf:quiz:answers:*",
  "ctf:quiz:attempts:*",
  "ctf:quiz:points",
  "ctf:quiz:answered",
  "ctf:quiz:lastAt",
  "ctf:classic:solves:*",
  "ctf:classic:attempts:*",
  "ctf:classic:points",
  "ctf:classic:solved",
  "ctf:classic:solvecount",
  "ctf:classic:lastAt",
  "ctf:classic:opened:*",
  "ctf:activity:log",
  "ctf:sponsors",
  "ctf:sponsors:logo",
  "ctf:adjustments",
] as const;

async function readSchemaVersion(): Promise<string | null> {
  const [reply] = assertPipelineOk(
    await upstashPipeline([["GET", SCHEMA_VERSION_KEY]]),
    "Redis schema marker read",
  );

  if (reply.result === null) return null;
  if (typeof reply.result !== "string") {
    throw new Error("Redis schema marker has an unexpected value; refusing startup.");
  }

  return reply.result;
}

async function findLegacyFingerprintPattern(): Promise<string | null> {
  for (const pattern of V1_FINGERPRINT_PATTERNS) {
    let cursor = "0";

    do {
      const [reply] = await upstashPipeline([
        ["SCAN", cursor, "MATCH", pattern, "COUNT", 1000],
      ]);
      const [nextCursor, keys] = parseScanPage(reply, `schema compatibility ${pattern}`);
      if (keys.length > 0) return pattern;
      cursor = nextCursor;
    } while (cursor !== "0");
  }

  return null;
}

function refuseLegacyData(pattern: string): never {
  throw new Error(
    `[startup] Legacy v1 Redis data detected (matching fingerprint: ${pattern}). Export any data you need, then perform a master reset before starting this v2 application.`,
  );
}

/**
 * Refuse to run against recognizable v1 event data. An absent marker alone
 * does not prove this is a fresh Redis database: v1 master reset preserves
 * organizer/account data, so recognizable event-data fingerprints are checked.
 *
 * Fails CLOSED: any Redis marker read, fingerprint SCAN, or marker SET error
 * throws and refuses startup. Recognizable legacy data and unsupported schema
 * versions also prevent startup.
 */
export async function checkRedisCompatibility(): Promise<void> {
  const version = await readSchemaVersion();

  if (version === CURRENT_SCHEMA_VERSION) return;
  if (version !== null) {
    throw new Error(
      `[startup] Redis schema version ${version} is not supported; this application requires version ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  const legacyPattern = await findLegacyFingerprintPattern();
  if (legacyPattern) refuseLegacyData(legacyPattern);

  const [setReply] = assertPipelineOk(
    await upstashPipeline([["SET", SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION, "NX"]]),
    "Redis schema marker initialization",
  );

  if (setReply.result === "OK") return;

  // Another process may have initialized the marker after our scan.
  const racedVersion = await readSchemaVersion();
  if (racedVersion === CURRENT_SCHEMA_VERSION) return;

  throw new Error(
    `[startup] Redis schema marker initialization raced with another process, but the resulting version is ${String(racedVersion)}; refusing startup.`,
  );
}
