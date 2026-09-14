// Unit tests for the sponsors store (issue #405), focused on the part that
// actually matters most: `upsertSponsor`'s logo validation. The declared MIME
// type and any filename must be completely IGNORED — only the decoded bytes'
// own magic number and structure decide accept/reject, and SVG is refused
// with its own message rather than falling through to the generic one.
//
// The PNG/WebP fixtures below are minimal SYNTHETIC buffers shaped exactly
// like `parsePngDimensions`/`parseWebpDimensions` expect (signature + the one
// header chunk each format's dimensions live in) — they are not real,
// fully-decodable images, only enough bytes for the structural parser this
// file tests.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstashPipeline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline }));

import {
  deleteSponsor,
  getSponsorLogo,
  importBundle,
  listSponsors,
  reorderSponsors,
  SponsorValidationError,
  upsertSponsor,
  type Sponsor,
} from "@/lib/sponsors-store";
import { SPONSORS_BUNDLE_VERSION } from "@/lib/sponsors-io";

const pipelineCalls = (): (string | number)[][][] =>
  mocks.upstashPipeline.mock.calls.map((call) => call[0] as (string | number)[][]);

function pngFixture(w: number, h: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

/** A minimal "VP8 " (lossy) WebP header: RIFF/WEBP/VP8, then a 3-byte frame
 *  tag, the mandatory 3-byte sync code, and width/height as little-endian
 *  14-bit fields. */
function webpLossyFixture(w: number, h: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8 ", 12, "ascii");
  buf.writeUInt32LE(buf.length - 20, 16);
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  buf.writeUInt16LE(w & 0x3fff, 26);
  buf.writeUInt16LE(h & 0x3fff, 28);
  return buf;
}

function toBase64(buf: Buffer): string {
  return buf.toString("base64");
}

const validInput = { id: "acme-ab12cd", name: "Acme", url: "https://acme.example", blurb: "", tier: "gold" as const, order: 0 };

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
});

describe("upsertSponsor — logo validation", () => {
  it("accepts a structurally valid PNG and derives its dimensions/etag", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { result: 1 }]);
    const sponsor = await upsertSponsor(validInput, { data: toBase64(pngFixture(120, 40)) });
    expect(sponsor.logo).toMatchObject({ type: "image/png", w: 120, h: 40 });
    expect(sponsor.logo?.etag).toMatch(/^[0-9a-f]{16}$/);
  });

  it("accepts a structurally valid lossy WebP", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { result: 1 }]);
    const sponsor = await upsertSponsor(validInput, { data: toBase64(webpLossyFixture(64, 64)) });
    expect(sponsor.logo).toMatchObject({ type: "image/webp", w: 64, h: 64 });
  });

  it("rejects an SVG with its own message, regardless of the declared MIME type", async () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await expect(
      upsertSponsor(validInput, { data: toBase64(svg), declaredType: "image/png" }),
    ).rejects.toThrow(/SVG logos are not accepted/);
  });

  it("rejects an SVG declared as image/svg+xml even with no <svg> tag sniffable", async () => {
    // The declared type alone is enough for the friendlier message when the
    // heuristic sniff would otherwise miss it (e.g. an SVG using only a
    // <symbol> root) — it never widens ACCEPTANCE, only which rejection
    // message is shown.
    const notReallyAnImage = Buffer.from("not an image at all");
    await expect(
      upsertSponsor(validInput, { data: toBase64(notReallyAnImage), declaredType: "image/svg+xml" }),
    ).rejects.toThrow(/SVG logos are not accepted/);
  });

  it("ignores the declared MIME type entirely for the accept decision — a PNG's real bytes decide, not a wrong label", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { result: 1 }]);
    const sponsor = await upsertSponsor(validInput, {
      data: toBase64(pngFixture(10, 10)),
      declaredType: "image/svg+xml",
    });
    expect(sponsor.logo?.type).toBe("image/png");
  });

  it("rejects an unrecognized binary format", async () => {
    const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    await expect(upsertSponsor(validInput, { data: toBase64(junk) })).rejects.toThrow(/must be a PNG or WebP/);
  });

  it("rejects a PNG whose IHDR reports a zero dimension", async () => {
    await expect(upsertSponsor(validInput, { data: toBase64(pngFixture(0, 40)) })).rejects.toThrow(
      SponsorValidationError,
    );
  });

  it("rejects a logo over the decoded-byte size cap", async () => {
    const oversized = Buffer.concat([pngFixture(10, 10), Buffer.alloc(70_000)]);
    await expect(upsertSponsor(validInput, { data: toBase64(oversized) })).rejects.toThrow(/at most 65536 bytes/);
  });

  it("rejects invalid base64", async () => {
    await expect(upsertSponsor(validInput, { data: "not-base64-!!!" })).rejects.toThrow(SponsorValidationError);
  });
});

describe("upsertSponsor — field validation", () => {
  it("rejects a non-https url", async () => {
    await expect(upsertSponsor({ ...validInput, url: "http://acme.example" })).rejects.toThrow(/https:/);
  });

  it("rejects a url carrying embedded credentials", async () => {
    await expect(upsertSponsor({ ...validInput, url: "https://user:pass@acme.example" })).rejects.toThrow(
      SponsorValidationError,
    );
  });

  it("rejects a name with a control character", async () => {
    await expect(upsertSponsor({ ...validInput, name: "Acme" })).rejects.toThrow(/control characters/);
  });

  it("rejects an invalid id shape", async () => {
    await expect(upsertSponsor({ ...validInput, id: "not an id!" })).rejects.toThrow(SponsorValidationError);
  });

  it("rejects an unknown tier", async () => {
    // @ts-expect-error deliberately invalid at the runtime boundary
    await expect(upsertSponsor({ ...validInput, tier: "platinum" })).rejects.toThrow(/gold.*silver.*community/);
  });
});

describe("upsertSponsor — logo three-valued semantics", () => {
  it("logo undefined keeps the existing logo untouched", async () => {
    const existing: Sponsor = { ...validInput, name: "Acme", logo: { type: "image/png", bytes: 10, w: 5, h: 5, etag: "a".repeat(16) } };
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(existing) }]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }]);
    const saved = await upsertSponsor(validInput);
    expect(saved.logo).toEqual(existing.logo);
    // Only ONE HSET on the metadata hash — no logo-hash write for "keep".
    const writeCmds = pipelineCalls()[1];
    expect(writeCmds).toHaveLength(1);
  });

  it("logo null clears an existing logo and deletes the blob", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { result: 1 }]);
    const saved = await upsertSponsor(validInput, null);
    expect(saved.logo).toBeNull();
    const [metaCmd, delCmd] = pipelineCalls()[0]!;
    expect(metaCmd[0]).toBe("HSET");
    expect(delCmd).toEqual(["HDEL", "ctf:sponsors:logo", validInput.id]);
  });
});

describe("listSponsors", () => {
  it("throws on a failed read rather than returning an empty list silently", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "WRONGTYPE" }]);
    await expect(listSponsors()).rejects.toThrow(/WRONGTYPE/);
  });

  it("orders sponsors deterministically by order, then name", async () => {
    const b: Sponsor = { id: "b", name: "Beta", url: "https://b.example", blurb: "", tier: "silver", order: 1, logo: null };
    const a: Sponsor = { id: "a", name: "Alpha", url: "https://a.example", blurb: "", tier: "gold", order: 0, logo: null };
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["b", JSON.stringify(b), "a", JSON.stringify(a)] }]);
    const sponsors = await listSponsors();
    expect(sponsors.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("getSponsorLogo", () => {
  it("returns the raw base64 string, or null when absent", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "cGxhaW4=" }]);
    expect(await getSponsorLogo("acme")).toBe("cGxhaW4=");

    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    expect(await getSponsorLogo("acme")).toBeNull();
  });
});

describe("deleteSponsor", () => {
  it("HDELs both hashes in one pipeline", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { result: 1 }]);
    await deleteSponsor("acme");
    expect(pipelineCalls()[0]).toEqual([
      ["HDEL", "ctf:sponsors", "acme"],
      ["HDEL", "ctf:sponsors:logo", "acme"],
    ]);
  });
});

describe("reorderSponsors", () => {
  it("rewrites order to match the given id sequence and skips stale ids", async () => {
    const a: Sponsor = { id: "a", name: "Alpha", url: "https://a.example", blurb: "", tier: "gold", order: 0, logo: null };
    const b: Sponsor = { id: "b", name: "Beta", url: "https://b.example", blurb: "", tier: "silver", order: 1, logo: null };
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["a", JSON.stringify(a), "b", JSON.stringify(b)] }]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { result: 1 }]);
    const sponsors = await reorderSponsors(["b", "a", "gone"]);
    expect(sponsors.map((s) => ({ id: s.id, order: s.order }))).toEqual([
      { id: "b", order: 0 },
      { id: "a", order: 1 },
    ]);
  });
});

describe("importBundle — re-validates logo bytes, never trusts a bundle's claimed metadata", () => {
  it("re-derives dimensions/etag from the actual bytes rather than the bundle's claim", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { result: 1 }]);
    await importBundle({
      version: SPONSORS_BUNDLE_VERSION,
      sponsors: [
        {
          ...validInput,
          logo: { type: "image/png", data: toBase64(pngFixture(30, 20)), bytes: 999, w: 1, h: 1, etag: "f".repeat(16) },
        },
      ],
    });
    const [metaCmd] = pipelineCalls()[0]!;
    const written = JSON.parse(metaCmd[3] as string) as Sponsor;
    // The claimed w:1/h:1/etag in the bundle are ignored — the real PNG's
    // 30x20 and its own sha256-derived etag are what get stored.
    expect(written.logo).toMatchObject({ type: "image/png", w: 30, h: 20 });
    expect(written.logo?.etag).not.toBe("f".repeat(16));
  });

  it("rejects a bundle entry whose logo claims PNG but is actually SVG bytes, before writing anything", async () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await expect(
      importBundle({
        version: SPONSORS_BUNDLE_VERSION,
        sponsors: [
          { ...validInput, logo: { type: "image/png", data: toBase64(svg), bytes: 100, w: 10, h: 10, etag: "0".repeat(16) } },
        ],
      }),
    ).rejects.toThrow(/SVG logos are not accepted/);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});
