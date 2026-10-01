// The two PUBLIC event image routes (#529). Same contract as the sponsor logo
// route: bytes from our own origin, an ETag that changes when the organizer
// swaps the image, nosniff, 404 when unset and 503 (fail closed) when Redis
// cannot answer — this route's whole job is the bytes.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getEventImagesMeta, getEventImageData } = vi.hoisted(() => ({
  getEventImagesMeta: vi.fn(),
  getEventImageData: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/event-images-store", () => ({ getEventImagesMeta, getEventImageData }));

const logoRoute = await import("@/app/api/event/logo/route");
const iconRoute = await import("@/app/api/event/icon/route");

const bytes = Buffer.from("fake-png-bytes");
const meta = { type: "image/png", bytes: bytes.length, w: 64, h: 64, etag: "0123456789abcdef" };
const req = (headers?: Record<string, string>) => new Request("http://x/api/event/logo", { headers });

beforeEach(() => {
  getEventImagesMeta.mockReset();
  getEventImageData.mockReset();
});

describe.each([
  ["logo", logoRoute.GET],
  ["icon", iconRoute.GET],
] as const)("GET /api/event/%s", (slot, GET) => {
  it("serves the stored bytes with the stored type, the etag and the cache headers", async () => {
    getEventImagesMeta.mockResolvedValue({ [slot]: meta });
    getEventImageData.mockResolvedValue(bytes.toString("base64"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(getEventImageData).toHaveBeenCalledWith(slot);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("etag")).toBe(meta.etag);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=86400");
  });

  it("answers 304 on a matching If-None-Match, without reading the bytes", async () => {
    getEventImagesMeta.mockResolvedValue({ [slot]: meta });
    const res = await GET(req({ "if-none-match": meta.etag }));
    expect(res.status).toBe(304);
    expect(getEventImageData).not.toHaveBeenCalled();
  });

  it("answers 404 when no image is set for this slot", async () => {
    getEventImagesMeta.mockResolvedValue({});
    getEventImageData.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(404);
  });

  it("answers 404 when the metadata exists but the bytes are gone", async () => {
    getEventImagesMeta.mockResolvedValue({ [slot]: meta });
    getEventImageData.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(404);
  });

  it("answers 503 when Redis cannot be read", async () => {
    getEventImagesMeta.mockRejectedValue(new Error("NOAUTH"));
    expect((await GET(req())).status).toBe(503);
  });
});
