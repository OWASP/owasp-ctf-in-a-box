// The Event tab's image pickers (#529): the client-side checks that refuse an
// obvious mistake before the round trip. The SERVER decides from the decoded
// bytes (event-images-store.ts); these only have to agree with it, so each
// limit is read from event-images-keys.ts rather than restated.
import { describe, expect, it } from "vitest";
import {
  canStart,
  checkPickedDimensions,
  checkPickedFile,
  describeStoredImage,
  imagesReducer,
  INITIAL_IMAGES_STATE,
  isPending,
  prepareUpload,
} from "../event-images-model";
import { EVENT_ICON_MAX_BYTES, EVENT_LOGO_MAX_BYTES } from "@/lib/event-images-keys";

describe("checkPickedFile", () => {
  it("accepts a logo in any of the three raster types, up to its cap", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(checkPickedFile("logo", { type, size: EVENT_LOGO_MAX_BYTES })).toBeNull();
    }
  });

  it("refuses an SVG with the reason", () => {
    expect(checkPickedFile("logo", { type: "image/svg+xml", size: 100 })).toMatch(/SVG/);
  });

  it("refuses a file over the slot's cap", () => {
    expect(checkPickedFile("logo", { type: "image/png", size: EVENT_LOGO_MAX_BYTES + 1 })).toMatch(/128 KB/);
    expect(checkPickedFile("icon", { type: "image/png", size: EVENT_ICON_MAX_BYTES + 1 })).toMatch(/32 KB/);
  });

  it("refuses a non-PNG favicon", () => {
    expect(checkPickedFile("icon", { type: "image/jpeg", size: 100 })).toMatch(/PNG/);
  });

  it("refuses an empty file", () => {
    expect(checkPickedFile("icon", { type: "image/png", size: 0 })).toMatch(/empty/);
  });
});

describe("checkPickedDimensions", () => {
  it("wants a square favicon between 32 and 512 pixels", () => {
    expect(checkPickedDimensions("icon", 64, 64)).toBeNull();
    expect(checkPickedDimensions("icon", 64, 32)).toMatch(/square/);
    expect(checkPickedDimensions("icon", 16, 16)).toMatch(/32.*512/);
    expect(checkPickedDimensions("icon", 1024, 1024)).toMatch(/32.*512/);
  });

  it("takes a logo of any shape up to 4096 pixels a side", () => {
    expect(checkPickedDimensions("logo", 1200, 300)).toBeNull();
    expect(checkPickedDimensions("logo", 5000, 300)).toMatch(/4096/);
  });
});

describe("describeStoredImage", () => {
  it("names the size, the type and the weight", () => {
    expect(describeStoredImage({ type: "image/png", bytes: 2048, w: 480, h: 160, etag: "0123456789abcdef" })).toBe("480×160 PNG, 2 KB");
    expect(describeStoredImage({ type: "image/jpeg", bytes: 512, w: 10, h: 10, etag: "0123456789abcdef" })).toBe("10×10 JPEG, 1 KB");
  });
});

describe("prepareUpload", () => {
  const png = { type: "image/png", size: 1000 };
  const decodeAs = (w: number, h: number) => async () => ({ w, h });

  it("passes a file every client check accepts", async () => {
    await expect(prepareUpload("icon", png, decodeAs(64, 64))).resolves.toBeNull();
  });

  it("refuses on type or size without decoding the file", async () => {
    let decoded = false;
    const decode = async () => {
      decoded = true;
      return { w: 64, h: 64 };
    };
    await expect(prepareUpload("icon", { type: "image/jpeg", size: 1000 }, decode)).resolves.toMatch(/PNG/);
    expect(decoded).toBe(false);
  });

  it("refuses a file that does not decode, and one with the wrong shape", async () => {
    await expect(prepareUpload("icon", png, async () => null)).resolves.toMatch(/does not open/);
    await expect(prepareUpload("icon", png, decodeAs(64, 32))).resolves.toMatch(/square/);
  });
});

// The section's state (PR #532 review): each slot has its own in-flight
// guard, taken before any async validation, and nothing is editable until
// the first read of the stored images has landed.
describe("imagesReducer", () => {
  const meta = { type: "image/png" as const, bytes: 24, w: 64, h: 64, etag: "0123456789abcdef" };
  const loaded = imagesReducer(INITIAL_IMAGES_STATE, { type: "loaded", images: {} });

  it("keeps both rows pending until the first read lands", () => {
    expect(isPending(INITIAL_IMAGES_STATE, "logo")).toBe(true);
    expect(isPending(INITIAL_IMAGES_STATE, "icon")).toBe(true);
    expect(isPending(loaded, "logo")).toBe(false);
  });

  it("keeps both rows pending when the first read fails", () => {
    const failed = imagesReducer(INITIAL_IMAGES_STATE, { type: "load-failed", message: "NOAUTH" });
    expect(isPending(failed, "logo")).toBe(true);
    expect(failed.loadError).toBe("NOAUTH");
  });

  it("refuses to start an operation before the first read lands", () => {
    expect(canStart(INITIAL_IMAGES_STATE, "logo")).toBe(false);
  });

  it("guards each slot on its own: a favicon upload leaves a pending logo upload pending", () => {
    let s = imagesReducer(loaded, { type: "start", slot: "logo" });
    expect(canStart(s, "logo")).toBe(false);
    expect(canStart(s, "icon")).toBe(true);
    s = imagesReducer(s, { type: "start", slot: "icon" });
    s = imagesReducer(s, { type: "finish", slot: "icon", image: meta });
    expect(isPending(s, "logo")).toBe(true);
    expect(canStart(s, "logo")).toBe(false);
    expect(isPending(s, "icon")).toBe(false);
    expect(s.images.icon).toEqual(meta);
  });

  it("finishing a restore clears the slot; a failed operation keeps what was stored", () => {
    let s = imagesReducer(imagesReducer(loaded, { type: "finish", slot: "logo", image: meta }), { type: "start", slot: "logo" });
    expect(imagesReducer(s, { type: "finish", slot: "logo", image: null }).images.logo).toBeUndefined();
    s = imagesReducer(s, { type: "fail", slot: "logo" });
    expect(s.images.logo).toEqual(meta);
    expect(isPending(s, "logo")).toBe(false);
  });
});
