// The /admin Attachments section of a classic challenge (#186): what an
// organizer sees before touching anything — each file's name, size and
// sha256, the external-link warning, a missing upload flagged for re-upload,
// and a plain note on a challenge not saved yet.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AdminAttachments from "@/components/admin-attachments";

const sha = "0f".repeat(32);

describe("AdminAttachments", () => {
  it("asks for the challenge to be saved first when it has no id yet", () => {
    const html = renderToStaticMarkup(<AdminAttachments itemId={null} />);
    expect(html).toMatch(/Save the challenge first/);
    expect(html).not.toContain('type="file"');
  });

  it("lists each upload with its size and sha256, and each link with the public-URL warning", () => {
    const html = renderToStaticMarkup(
      <AdminAttachments
        itemId="web-one"
        initialItems={[
          { id: "a0123456789abcdef", kind: "upload", name: "capture.pcap", size: 2048, sha256: sha },
          { id: "a0123456789abcdee", kind: "link", name: "disk.img", url: "https://files.example.org/disk.img" },
        ]}
      />,
    );
    expect(html).toContain("capture.pcap");
    expect(html).toContain("2.0 KB");
    expect(html).toContain(sha);
    expect(html).toContain("https://files.example.org/disk.img");
    expect(html).toContain("Publicly reachable by anyone with the URL: not covered by launch or story locks.");
    expect(html).toContain('aria-label="Remove capture.pcap"');
    expect(html).toContain('type="file"');
  });

  it("flags an upload whose bytes are missing, naming its sha256", () => {
    const html = renderToStaticMarkup(
      <AdminAttachments itemId="web-one" initialItems={[{ id: "a0123456789abcdef", kind: "upload", name: "capture.pcap", size: 2048, sha256: sha, missing: true }]} />,
    );
    expect(html).toMatch(/re-upload/i);
    expect(html).toContain(`capture.pcap`);
  });

  it("states the caps", () => {
    expect(renderToStaticMarkup(<AdminAttachments itemId="web-one" initialItems={[]} />)).toMatch(/5\.0 MB.*10 per challenge/);
  });
});
