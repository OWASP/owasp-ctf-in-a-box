// The event images store (#529): the hero logo and the favicon. What matters
// most is the same thing as for sponsor logos — only the decoded bytes decide
// accept/reject — plus the per-slot rules (the icon is a square PNG) and the
// fail-fast import: every image in an archive is validated before any write.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstashPipeline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline }));

import {
  clearEventImage,
  EventImageValidationError,
  exportEventImages,
  getEventImageData,
  getEventImagesMeta,
  importEventImages,
  setEventImage,
  validateEventImagesBundle,
} from "@/lib/event-images-store";
import { EVENT_IMAGES_DATA_KEY, EVENT_IMAGES_KEY, EVENT_ICON_MAX_BYTES, EVENT_LOGO_MAX_BYTES } from "@/lib/event-images-keys";
import { b64, jpegFixture, pngFixture, webpLossyFixture } from "./image-fixtures";

const calls = (): (string | number)[][][] => mocks.upstashPipeline.mock.calls.map((c) => c[0] as (string | number)[][]);
const ok2 = [{ result: 1 }, { result: 1 }];

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
});

async function rejection(p: Promise<unknown>): Promise<EventImageValidationError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EventImageValidationError);
  return err as EventImageValidationError;
}

describe("setEventImage — logo", () => {
  it.each([
    ["PNG", pngFixture(400, 120), "image/png"],
    ["JPEG", jpegFixture(400, 120), "image/jpeg"],
    ["WebP", webpLossyFixture(400, 120), "image/webp"],
  ])("accepts a %s and writes metadata and bytes in one pipeline", async (_n, buf, type) => {
    mocks.upstashPipeline.mockResolvedValueOnce(ok2);
    const meta = await setEventImage("logo", { data: b64(buf) });
    expect(meta).toMatchObject({ type, w: 400, h: 120, bytes: buf.length });
    expect(meta.etag).toMatch(/^[0-9a-f]{16}$/);
    const [cmds] = calls();
    expect(cmds).toEqual([
      ["HSET", EVENT_IMAGES_KEY, "logo", JSON.stringify(meta)],
      ["HSET", EVENT_IMAGES_DATA_KEY, "logo", b64(buf)],
    ]);
  });

  it("refuses a logo over the cap, counted on the decoded bytes", async () => {
    await rejection(setEventImage("logo", { data: b64(pngFixture(10, 10, EVENT_LOGO_MAX_BYTES + 1)) }));
    mocks.upstashPipeline.mockResolvedValueOnce(ok2);
    await expect(setEventImage("logo", { data: b64(pngFixture(10, 10, EVENT_LOGO_MAX_BYTES)) })).resolves.toBeTruthy();
    expect(calls()).toHaveLength(1);
  });

  it("refuses an SVG with its own message, whatever it claims to be", async () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const err = await rejection(setEventImage("logo", { data: b64(svg), declaredType: "image/png" }));
    expect(err.message).toMatch(/SVG/);
    expect(calls()).toHaveLength(0);
  });

  it("ignores the declared type: bytes that are not an image are refused even when called a PNG", async () => {
    const err = await rejection(setEventImage("logo", { data: b64(Buffer.from("not an image at all")), declaredType: "image/png" }));
    expect(err.message).toMatch(/PNG, JPEG or WebP/);
  });

  it("refuses non-canonical base64 and an empty upload", async () => {
    expect((await rejection(setEventImage("logo", { data: "@@@@" }))).message).toMatch(/base64/);
    expect((await rejection(setEventImage("logo", { data: "" }))).message).toMatch(/empty/);
  });

  it("refuses a malformed PNG header", async () => {
    const bad = pngFixture(10, 10);
    bad.writeUInt32BE(12, 8);
    expect((await rejection(setEventImage("logo", { data: b64(bad) }))).message).toMatch(/valid PNG/);
  });
});

describe("setEventImage — icon", () => {
  it("accepts a square PNG between 32 and 512 pixels", async () => {
    for (const side of [32, 512]) {
      mocks.upstashPipeline.mockResolvedValueOnce(ok2);
      await expect(setEventImage("icon", { data: b64(pngFixture(side, side)) })).resolves.toMatchObject({ w: side, h: side });
    }
  });

  it.each([
    ["not square", pngFixture(64, 32), /square/],
    ["too small", pngFixture(16, 16), /32.*512/],
    ["too large", pngFixture(513, 513), /32.*512/],
    ["a JPEG", jpegFixture(64, 64), /PNG/],
    ["a WebP", webpLossyFixture(64, 64), /PNG/],
  ])("refuses an icon that is %s", async (_n, buf, msg) => {
    const err = await rejection(setEventImage("icon", { data: b64(buf) }));
    expect(err.message).toMatch(msg);
    expect(err.slot).toBe("icon");
    expect(calls()).toHaveLength(0);
  });

  it("refuses an icon over its own (smaller) cap", async () => {
    await rejection(setEventImage("icon", { data: b64(pngFixture(64, 64, EVENT_ICON_MAX_BYTES + 1)) }));
  });
});

describe("clearEventImage", () => {
  it("removes the metadata and the bytes together", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(ok2);
    await clearEventImage("icon");
    expect(calls()[0]).toEqual([
      ["HDEL", EVENT_IMAGES_KEY, "icon"],
      ["HDEL", EVENT_IMAGES_DATA_KEY, "icon"],
    ]);
  });

  it("throws when the write fails", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }, { result: 1 }]);
    await expect(clearEventImage("logo")).rejects.toThrow(/NOAUTH/);
  });
});

describe("getEventImagesMeta / getEventImageData", () => {
  const meta = { type: "image/png", bytes: 24, w: 64, h: 64, etag: "0123456789abcdef" };

  it("reads only the metadata hash and keeps well-formed rows for known slots", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: ["icon", JSON.stringify(meta), "logo", "{not json", "banner", JSON.stringify(meta)] },
    ]);
    await expect(getEventImagesMeta()).resolves.toEqual({ icon: meta });
    expect(calls()[0]).toEqual([["HGETALL", EVENT_IMAGES_KEY]]);
  });

  it("drops a row whose type is not one of the three rasters", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["logo", JSON.stringify({ ...meta, type: "image/svg+xml" })] }]);
    await expect(getEventImagesMeta()).resolves.toEqual({});
  });

  it("throws on a read error instead of reading as no images", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "WRONGTYPE" }]);
    await expect(getEventImagesMeta()).rejects.toThrow(/WRONGTYPE/);
  });

  it("reads one slot's bytes with a single HGET", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "AAAA" }]);
    await expect(getEventImageData("logo")).resolves.toBe("AAAA");
    expect(calls()[0]).toEqual([["HGET", EVENT_IMAGES_DATA_KEY, "logo"]]);
  });

  it("returns null for a slot with no bytes, and throws on a read error", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    await expect(getEventImageData("icon")).resolves.toBeNull();
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    await expect(getEventImageData("icon")).rejects.toThrow(/NOAUTH/);
  });
});

describe("archive export / import", () => {
  it("exports null when no image is stored", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [] }]);
    await expect(exportEventImages()).resolves.toBeNull();
  });

  it("exports each stored slot's bytes", async () => {
    const logo = b64(pngFixture(100, 40));
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["logo", logo, "junk", "AAAA"] }]);
    await expect(exportEventImages()).resolves.toEqual({ logo: { data: logo } });
  });

  it("validateEventImagesBundle throws on the first bad image without touching Redis", () => {
    expect(() =>
      validateEventImagesBundle({ logo: { data: b64(pngFixture(100, 40)) }, icon: { data: b64(jpegFixture(64, 64)) } }),
    ).toThrow(EventImageValidationError);
    expect(calls()).toHaveLength(0);
  });

  it("imports every slot in one pipeline, after validating all of them", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }]);
    const logo = b64(pngFixture(100, 40));
    const icon = b64(pngFixture(64, 64));
    const out = await importEventImages({ logo: { data: logo }, icon: { data: icon } });
    expect(Object.keys(out).sort()).toEqual(["icon", "logo"]);
    const [cmds] = calls();
    expect(cmds).toHaveLength(4);
    expect(cmds).toContainEqual(["HSET", EVENT_IMAGES_DATA_KEY, "logo", logo]);
    expect(cmds).toContainEqual(["HSET", EVENT_IMAGES_DATA_KEY, "icon", icon]);
  });

  it("writes nothing when one image in the bundle is bad", async () => {
    await expect(
      importEventImages({ logo: { data: b64(pngFixture(100, 40)) }, icon: { data: b64(pngFixture(64, 32)) } }),
    ).rejects.toThrow(EventImageValidationError);
    expect(calls()).toHaveLength(0);
  });
});
