import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pipeline } = vi.hoisted(() => ({
  pipeline: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/upstash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/upstash")>()),
  upstashPipeline: pipeline,
}));

import {
  checkRedisCompatibility,
  CURRENT_SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  V1_FINGERPRINT_PATTERNS,
} from "@/lib/redis-compatibility";

beforeEach(() => {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
});

afterEach(() => {
  pipeline.mockReset();
  vi.unstubAllEnvs();
});

function emptyScan() {
  return { result: ["0", []] };
}

function freshRedis() {
  pipeline.mockImplementation(async (commands: string[][]) => {
    const [command, ...args] = commands[0];

    if (command === "GET") return [{ result: null }];
    if (command === "SCAN") return [emptyScan()];
    if (command === "SET") return [{ result: "OK" }];

    throw new Error(`Unexpected Redis command: ${command} ${args.join(" ")}`);
  });
}

describe("Redis schema compatibility", () => {
  it("skips compatibility checking when Redis is not configured", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    await expect(checkRedisCompatibility()).resolves.toBeUndefined();

    expect(pipeline).not.toHaveBeenCalled();
  });

  it("uses the expected persistent schema marker", () => {
    expect(SCHEMA_VERSION_KEY).toBe("ctf:meta:schema-version");
    expect(CURRENT_SCHEMA_VERSION).toBe("2");
  });

  it("keeps its v1 fingerprints aligned with the shared fixture", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const fixture = JSON.parse(
      await readFile(
        resolve(process.cwd(), "../../test/fixtures/v1-fingerprints.json"),
        "utf8",
      ),
    );

    expect(V1_FINGERPRINT_PATTERNS).toEqual(fixture.patterns);
  });

  it("initializes a fresh Redis database after checking every fingerprint", async () => {
    freshRedis();

    await expect(checkRedisCompatibility()).resolves.toBeUndefined();

    const scans = pipeline.mock.calls.filter(
      ([commands]) => commands[0][0] === "SCAN",
    );
    expect(scans).toHaveLength(V1_FINGERPRINT_PATTERNS.length);

    expect(pipeline).toHaveBeenLastCalledWith([
      ["SET", SCHEMA_VERSION_KEY, "2", "NX"],
    ]);
  });

  it("continues scanning when Redis returns another page", async () => {
    let scanCount = 0;

    pipeline.mockImplementation(async (commands: string[][]) => {
      const [command, ...args] = commands[0];

      if (command === "GET") return [{ result: null }];
      if (command === "SCAN") {
        scanCount++;
        if (scanCount === 1) return [{ result: ["42", []] }];
        return [{ result: ["0", []] }];
      }
      if (command === "SET") return [{ result: "OK" }];

      throw new Error(`Unexpected Redis command: ${command} ${args.join(" ")}`);
    });

    await expect(checkRedisCompatibility()).resolves.toBeUndefined();

    const scans = pipeline.mock.calls
      .filter(([commands]) => commands[0][0] === "SCAN")
      .map(([commands]) => commands[0]);

    expect(scans[0][1]).toBe("0");
    expect(scans[1][1]).toBe("42");
    expect(scans[0][3]).toBe(scans[1][3]);
    expect(scans).toHaveLength(V1_FINGERPRINT_PATTERNS.length + 1);
  });

  it("skips fingerprint scanning when schema version 2 already exists", async () => {
    pipeline.mockResolvedValueOnce([{ result: "2" }]);

    await expect(checkRedisCompatibility()).resolves.toBeUndefined();

    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("refuses startup when a v1 fingerprint is found", async () => {
    pipeline
      .mockResolvedValueOnce([{ result: null }])
      .mockResolvedValueOnce([
        { result: ["0", ["ctf:user:legacy-player"]] },
      ]);

    const error = await checkRedisCompatibility().catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("Incompatible Redis data detected (matching fingerprint: ctf:solves:*). Export required data, perform a master reset on v1, then deploy v2.");
    expect(error.message).not.toContain("ctf:user:legacy-player");
  });

  it("fails closed when the schema marker has an unexpected type", async () => {
    pipeline.mockResolvedValueOnce([{ result: { version: "2" } }]);

    await expect(checkRedisCompatibility()).rejects.toThrow(
      /schema marker has an unexpected value/,
    );

    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("refuses an unsupported schema version", async () => {
    pipeline.mockResolvedValueOnce([{ result: "3" }]);

    await expect(checkRedisCompatibility()).rejects.toThrow(
      /schema version 3 is not supported/,
    );

    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("fails closed when reading the schema marker fails", async () => {
    pipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);

    await expect(checkRedisCompatibility()).rejects.toThrow(/NOAUTH/);
  });

  it("fails closed when a fingerprint scan fails", async () => {
    pipeline
      .mockResolvedValueOnce([{ result: null }])
      .mockResolvedValueOnce([{ error: "SCAN failed" }]);

    await expect(checkRedisCompatibility()).rejects.toThrow(/SCAN failed/);
  });

  it("recognizes another process initializing the marker concurrently", async () => {
    freshRedis();

    pipeline.mockImplementation(async (commands: string[][]) => {
      const command = commands[0][0];

      if (command === "GET") {
        return pipeline.mock.calls.filter(
          ([previous]) => previous[0][0] === "GET",
        ).length === 1
          ? [{ result: null }]
          : [{ result: "2" }];
      }

      if (command === "SCAN") return [emptyScan()];
      if (command === "SET") return [{ result: null }];

      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(checkRedisCompatibility()).resolves.toBeUndefined();
  });
});
