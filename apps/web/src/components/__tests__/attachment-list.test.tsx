// The contestant-side attachment list (#186): downloads go through the
// visibility-checked route, links are outbound and marked, a missing upload
// is never offered, and no attachments renders nothing at all.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AttachmentList from "@/components/attachment-list";

describe("AttachmentList", () => {
  it("renders nothing when there is nothing to offer", () => {
    expect(renderToStaticMarkup(<AttachmentList items={[]} />)).toBe("");
    expect(
      renderToStaticMarkup(<AttachmentList items={[{ id: "a0123456789abcdef", kind: "upload", name: "x", size: 1, missing: true }]} />),
    ).toBe("");
  });

  it("offers an upload as a download through the attachments route, with its size", () => {
    const html = renderToStaticMarkup(
      <AttachmentList items={[{ id: "a0123456789abcdef", kind: "upload", name: "capture.pcap", size: 2048 }]} />,
    );
    expect(html).toContain('href="/api/attachments/a0123456789abcdef"');
    expect(html).toContain("download");
    expect(html).toContain("capture.pcap");
    expect(html).toContain("2.0 KB");
  });

  it("marks a link as hosted externally and opens it without an opener", () => {
    const html = renderToStaticMarkup(
      <AttachmentList items={[{ id: "a0123456789abcdee", kind: "link", name: "disk.img", url: "https://files.example.org/disk.img" }]} />,
    );
    expect(html).toContain('href="https://files.example.org/disk.img"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(/hosted externally/i);
  });
});
