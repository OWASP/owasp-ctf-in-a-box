"use client";

import { usePathname } from "next/navigation";

// Renders its children everywhere except on the listed routes. For content
// the shared (site) layout renders on every page, where a server layout
// cannot see which page it wraps: usePathname can, and it resolves during
// server rendering too, so the hidden content never flashes. Exact match
// only, and an unreadable path shows the content.
export default function HideOnPaths({ paths, children }: { paths: readonly string[]; children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname !== null && paths.includes(pathname)) return null;
  return <>{children}</>;
}
