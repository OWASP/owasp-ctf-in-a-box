import "server-only";
import { cache } from "react";
import type { Metadata } from "next";
import { getEventImagesMeta } from "@/lib/event-images-store";
import { errorLabel } from "@/lib/error-label";
import { eventImageUrl, type EventImagesMeta } from "@/lib/event-images-keys";

/**
 * The event images as the PAGES read them (#529): once per request
 * (react.cache — the layout's metadata and the landing page share the read),
 * and failing OPEN to "none stored", which renders the built-in OWASP mark
 * and favicon. Branding must never take a page down; the image routes
 * themselves fail closed instead (event-image-response.ts).
 */
export const getEventImages = cache(async (): Promise<EventImagesMeta> => {
  try {
    return await getEventImagesMeta();
  } catch (err) {
    console.error("[event-images] read failed; rendering the built-in images:", errorLabel(err));
    return {};
  }
});

/** The built-in icons, served from public/. They used to be Next.js
 *  file-convention icons under src/app/, but those always win over
 *  `metadata.icons`, so a stored icon could never replace them there. */
export const DEFAULT_ICONS: NonNullable<Metadata["icons"]> = {
  icon: [
    { url: "/favicon.ico", sizes: "any" },
    { url: "/icon.png", type: "image/png" },
  ],
};

export function iconsMetadata(images: EventImagesMeta): NonNullable<Metadata["icons"]> {
  const icon = images.icon;
  if (!icon) return DEFAULT_ICONS;
  return { icon: [{ url: eventImageUrl("icon", icon), type: icon.type, sizes: `${icon.w}x${icon.h}` }] };
}
