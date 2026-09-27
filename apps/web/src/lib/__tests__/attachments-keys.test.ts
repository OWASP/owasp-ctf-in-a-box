import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ID_RE,
  contentDisposition,
  newAttachmentId,
  sanitizeFilename,
  splitChunks,
} from "@/lib/attachments-keys";

describe("sanitizeFilename (#186)", () => {
  it("keeps only the last path segment and drops control characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\temp\\cap.pcap")).toBe("cap.pcap");
    expect(sanitizeFilename("a\r\nSet-Cookie: x.txt")).toBe("aSet-Cookie: x.txt");
  });
  it("falls back to 'file' for an empty result and caps the length", () => {
    expect(sanitizeFilename("../")).toBe("file");
    expect(sanitizeFilename("   ")).toBe("file");
    expect(sanitizeFilename("x".repeat(300) + ".bin").length).toBe(200);
  });
});

describe("contentDisposition", () => {
  it("is always an attachment, with an ASCII fallback and an RFC 5987 name", () => {
    const h = contentDisposition('ré"su;mé.pdf');
    expect(h.startsWith("attachment; ")).toBe(true);
    expect(h).toContain(`filename="r__su_m_.pdf"`);
    expect(h).toContain("filename*=UTF-8''r%C3%A9%22su%3Bm%C3%A9.pdf");
    expect(h).not.toMatch(/[\r\n]/);
  });
});

describe("newAttachmentId", () => {
  it("is random and matches the id grammar", () => {
    const a = newAttachmentId();
    expect(a).toMatch(ATTACHMENT_ID_RE);
    expect(newAttachmentId()).not.toBe(a);
  });
});

describe("splitChunks", () => {
  it("splits at the chunk size and loses nothing", () => {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 5).map((_, i) => i % 251);
    const chunks = splitChunks(bytes);
    expect(chunks.map((c) => c.length)).toEqual([1024 * 1024, 1024 * 1024, 5]);
    expect(Buffer.concat(chunks).equals(Buffer.from(bytes))).toBe(true);
    expect(splitChunks(new Uint8Array(0))).toEqual([]);
  });
});
