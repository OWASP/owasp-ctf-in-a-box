// The landing hero's single primary action: a link. A signed-out visitor's
// "sign in" goes to /sign-in carrying the destination as `next`, so someone
// who clicked "Sign in and play" lands on the board after signing in, not back
// on the marketing page (brief: "never lose someone's intended action"). The
// sign-in page routes through the post-signin step, so a teamless contestant
// meets the team card first.

import Link from "next/link";
import { signInHref } from "@/lib/post-signin";

const PRIMARY =
  "inline-flex items-center gap-2 rounded-md bg-[#2563eb] px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#1d4ed8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";

export default function HeroCta({
  label,
  href,
  signIn = false,
  callbackURL = "/profile",
}: {
  label: string;
  href?: string;
  signIn?: boolean;
  callbackURL?: string;
}) {
  return (
    <Link href={signIn ? signInHref(callbackURL) : (href ?? "/")} className={PRIMARY}>
      {label}
    </Link>
  );
}
