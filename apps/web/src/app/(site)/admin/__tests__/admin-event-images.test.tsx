// The Event tab's image rows (#529), rendered statically (no
// @testing-library here — see admin-event-identity.test.tsx). What a static
// render CAN pin: the stored image is previewed from our own route (never a
// URL built from a picked file), the picker offers only the slot's types,
// and "Restore default" exists only when there is something to restore.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EventImageRow } from "../admin-event-images";

const meta = { type: "image/png" as const, bytes: 2048, w: 480, h: 160, etag: "0123456789abcdef" };
const row = (props: Partial<Parameters<typeof EventImageRow>[0]> = {}) =>
  renderToStaticMarkup(
    <EventImageRow slot="logo" stored={null} pending={false} status={null} onPick={() => {}} onRestore={() => {}} {...props} />,
  );

describe("EventImageRow", () => {
  it("previews a stored logo from the versioned route and describes it", () => {
    const html = row({ stored: meta });
    expect(html).toContain('src="/api/event/logo?v=0123456789abcdef"');
    expect(html).toContain("480×160 PNG, 2 KB");
    expect(html).toContain("Replace logo");
    expect(html).toContain("Restore default");
  });

  it("names the built-in default and offers no restore when nothing is stored", () => {
    const html = row();
    expect(html).toContain("Built-in OWASP mark");
    expect(html).toContain("Choose logo");
    expect(html).not.toContain("Restore default");
    expect(html).not.toContain("/api/event/logo");
  });

  it("offers only the slot's own types in the picker", () => {
    expect(row()).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(row({ slot: "icon" })).toContain('accept="image/png"');
  });

  it("disables the picker and the restore button while a save is pending", () => {
    const html = row({ stored: meta, pending: true });
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  it("shows a refusal as an alert", () => {
    const html = row({ slot: "icon", status: { state: "error", message: "The favicon must be square." } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The favicon must be square.");
  });
});
