// Pins the Event tab's Identity section rows against the spec contract in
// lib/event-identity.ts (key order, maxLength, the organizer-facing labels),
// and — using the same Probe technique as
// admin-module-identity.binding.test.tsx — that each row's rendered `name`
// and its `onBlur` commit agree: whatever key the field renders is the exact
// key `apply` is POSTed with, never a hardcoded second copy.
//
// See admin-module-identity.binding.test.tsx for why this needs the Probe
// trick rather than @testing-library or renderToStaticMarkup alone: a static
// render discards event handlers, so nothing built on it can fire a blur.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { EVENT_IDENTITY_ROWS } from "@/app/(site)/admin/admin-event-tab";
import { EVENT_IDENTITY_KEYS, EVENT_IDENTITY_MAX, type EventIdentityKey } from "@/lib/event-identity";
import { IdentityField } from "@/app/(site)/admin/admin-module-identity";

type FieldProps = {
  name: string;
  onBlur: (e: { currentTarget: { value: string } }) => void;
};

function captureIdentityFieldElement(
  patchKey: EventIdentityKey,
  apply: (patch: Record<string, unknown>) => Promise<boolean>,
): ReactElement {
  let captured: ReactElement | null = null;
  function Probe() {
    captured = IdentityField({
      patchKey,
      stored: "",
      placeholder: "",
      maxLength: 80,
      disabled: false,
      multiline: false,
      apply,
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!captured) throw new Error("Probe never captured IdentityField's returned element");
  return captured;
}

describe("Event tab identity rows", () => {
  it("renders one row per identity key, in spec order, with the spec maxLength", () => {
    expect(EVENT_IDENTITY_ROWS.map((r) => r.key)).toEqual([...EVENT_IDENTITY_KEYS]);
    for (const row of EVENT_IDENTITY_ROWS) expect(row.maxLength).toBe(EVENT_IDENTITY_MAX[row.key]);
  });

  it("labels the rows with the organizer-facing copy", () => {
    expect(EVENT_IDENTITY_ROWS.map((r) => r.label)).toEqual([
      "Event name",
      "Tagline",
      "Location",
      "Timezone",
      "Contact e-mail",
      "Discord invite",
      "Logo link",
    ]);
  });

  it("posts each row under its own key with the trimmed value", async () => {
    for (const row of EVENT_IDENTITY_ROWS) {
      const apply = vi.fn(async () => true);
      const el = captureIdentityFieldElement(row.key, apply);
      expect((el.props as FieldProps).name).toBe(row.key);
      (el.props as FieldProps).onBlur({ currentTarget: { value: "  v  " } });
      await Promise.resolve();
      expect(apply).toHaveBeenCalledWith({ [row.key]: "v" });
    }
  });
});
