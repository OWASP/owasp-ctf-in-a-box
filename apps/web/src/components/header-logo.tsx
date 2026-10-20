"use client";

// The event logo in a page header (ADR 66). A client component only for its
// onError: a failed load (the image route's 503, unreadable bytes) hides the
// element so the header never shows a broken-image icon and the title stays,
// the same rule display-board.tsx applies to the projector's logo. Callers
// render it with `key={src}`, so a replaced logo (a new etag in the URL)
// remounts and is shown again instead of staying hidden.
//
// A native <img>, as on every other logo surface: next/image would re-fetch
// our own image route through its optimizer.
export default function HeaderLogo({ src, w, h, alt }: { src: string; w: number; h: number; alt: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      onError={(e) => {
        e.currentTarget.hidden = true;
      }}
      src={src}
      alt={alt}
      width={w}
      height={h}
      decoding="async"
      className="h-12 w-auto max-w-[7rem] shrink-0 object-contain sm:h-16 sm:max-w-[10rem]"
    />
  );
}
