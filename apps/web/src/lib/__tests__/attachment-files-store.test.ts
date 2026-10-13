// The server half of upload bytes in a file: the export that reads them, the
// sha256/size check, the event-cap check, and the fill after a classic bundle
// import. Every refusal must land before anything is written — the stores
// are mocked, so "nothing written" is "importBundle and fillMissingUpload
// never called".

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  listAllAttachments: vi.fn(),
  readUploadBytes: vi.fn(),
  listAttachments: vi.fn(),
  fillMissingUpload: vi.fn(),
  storedAttachmentBytes: vi.fn(),
}));
const classic = vi.hoisted(() => ({ importBundle: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/attachments-store", () => files);
vi.mock("@/lib/classic-store", () => classic);

import { ATTACHMENTS_EVENT_MAX_BYTES } from "@/lib/attachments-keys";
import { AttachmentFilesError, exportAttachmentFiles, importClassicBundle } from "@/lib/attachment-files-store";
import type { ClassicBundle } from "@/lib/classic-io";

const bytes = Buffer.from("pcap-bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
const ID = "web-one-ab12cd";

function bundleWith(fileBytes = bytes.toString("base64"), size = bytes.length): ClassicBundle {
  return {
    version: 3,
    categories: ["Web"],
    challenges: [
      { id: ID, title: "One", category: "Web", description: "", points: 1, order: 0, flag: "f", attachments: [{ name: "cap.pcap", size, sha256: sha }] },
    ],
    attachmentFiles: [{ item: ID, sha256: sha, bytes: fileBytes }],
  };
}

beforeEach(() => {
  for (const f of [...Object.values(files), ...Object.values(classic)]) f.mockReset();
  files.storedAttachmentBytes.mockResolvedValue(0);
  files.listAttachments.mockResolvedValue([]);
  classic.importBundle.mockResolvedValue({ created: 1, updated: 0, categories: 1 });
});

describe("exportAttachmentFiles", () => {
  it("returns every stored upload's bytes, and none for a missing one or a link", async () => {
    files.listAllAttachments.mockResolvedValueOnce(
      new Map([[ID, [
        { id: "a1", kind: "upload", name: "cap.pcap", size: bytes.length, sha256: sha, chunks: 1 },
        { id: "a2", kind: "upload", name: "gone", size: 3, sha256: "cd".repeat(32), missing: true },
        { id: "a3", kind: "link", name: "l", url: "https://e.org" },
      ]]]),
    );
    files.readUploadBytes.mockResolvedValueOnce(new Uint8Array(bytes));
    expect(await exportAttachmentFiles()).toEqual([{ item: ID, sha256: sha, bytes: bytes.toString("base64") }]);
    expect(files.readUploadBytes).toHaveBeenCalledTimes(1);
  });
});

describe("importClassicBundle", () => {
  it("imports a bundle without files exactly as importBundle does, touching no file", async () => {
    const bundle = bundleWith();
    delete bundle.attachmentFiles;
    expect(await importClassicBundle(bundle)).toEqual({ created: 1, updated: 0, categories: 1 });
    expect(classic.importBundle).toHaveBeenCalledWith(bundle);
    expect(files.storedAttachmentBytes).not.toHaveBeenCalled();
    expect(files.fillMissingUpload).not.toHaveBeenCalled();
  });

  it("fills the upload the import recorded as missing, after the import, and counts it", async () => {
    files.listAttachments.mockResolvedValue([{ id: "a9", kind: "upload", name: "cap.pcap", size: bytes.length, sha256: sha, missing: true }]);
    const summary = await importClassicBundle(bundleWith());
    expect(files.fillMissingUpload).toHaveBeenCalledWith("a9", new Uint8Array(bytes));
    expect(files.fillMissingUpload.mock.invocationCallOrder[0]).toBeGreaterThan(classic.importBundle.mock.invocationCallOrder[0]);
    expect(summary).toEqual({ created: 1, updated: 0, categories: 1, files: 1 });
  });

  it("skips a file the box already holds with the same sha256", async () => {
    files.listAttachments.mockResolvedValue([{ id: "a1", kind: "upload", name: "cap.pcap", size: bytes.length, sha256: sha, chunks: 1 }]);
    const summary = await importClassicBundle(bundleWith());
    expect(files.fillMissingUpload).not.toHaveBeenCalled();
    expect(summary).toEqual({ created: 1, updated: 0, categories: 1, files: 0 });
  });

  // An import error names the position and the rule, never the submitted
  // values: no hash and no byte count reaches the response.
  it("refuses bytes that do not hash to their sha256 before anything is written", async () => {
    const tampered = Buffer.from("tampered!!");
    const err = await importClassicBundle(bundleWith(tampered.toString("base64"))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentFilesError);
    const message = (err as Error).message;
    expect(message).toMatch(/^attachmentFiles\[0\]: .*sha256/);
    expect(message).not.toContain(sha);
    expect(message).not.toContain(createHash("sha256").update(tampered).digest("hex"));
    expect(classic.importBundle).not.toHaveBeenCalled();
    expect(files.fillMissingUpload).not.toHaveBeenCalled();
  });

  it("refuses bytes whose length differs from the upload's recorded size before anything is written", async () => {
    const err = await importClassicBundle(bundleWith(undefined, bytes.length + 1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentFilesError);
    const message = (err as Error).message;
    expect(message).toMatch(/^attachmentFiles\[0\]: .*size/);
    expect(message.replace("attachmentFiles[0]", "")).not.toMatch(/\d/);
    expect(classic.importBundle).not.toHaveBeenCalled();
  });

  it("refuses a bundle that would push the event past the cap, naming the cap and the usage, before anything is written", async () => {
    files.storedAttachmentBytes.mockResolvedValue(ATTACHMENTS_EVENT_MAX_BYTES - 4);
    const err = await importClassicBundle(bundleWith()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentFilesError);
    expect((err as Error).message).toMatch(/50\.0 MB/);
    expect((err as Error).message).toMatch(/are stored/);
    expect(classic.importBundle).not.toHaveBeenCalled();
    expect(files.fillMissingUpload).not.toHaveBeenCalled();
  });

  it("does not count a file the box already holds against the cap", async () => {
    files.storedAttachmentBytes.mockResolvedValue(ATTACHMENTS_EVENT_MAX_BYTES - 4);
    files.listAttachments.mockResolvedValue([{ id: "a1", kind: "upload", name: "cap.pcap", size: bytes.length, sha256: sha, chunks: 1 }]);
    await expect(importClassicBundle(bundleWith())).resolves.toMatchObject({ files: 0 });
    expect(classic.importBundle).toHaveBeenCalledTimes(1);
  });
});
