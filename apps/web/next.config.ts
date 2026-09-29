import type { NextConfig } from "next";

/**
 * Baseline security headers, sent on every response the app serves.
 *
 * The app owns them, not the edge in front of it: AWS puts an ALB there and
 * Fly its own proxy, and neither adds any of these, so a header set only in
 * `caddy/Caddyfile.poll` reached compose boxes and nothing else (audit S1).
 * Caddy keeps an identical block as defence in depth; the values must stay
 * the same in both places (`security-headers.test.ts` reads both).
 *
 * - Framing is refused twice over: `X-Frame-Options` for older browsers and
 *   CSP `frame-ancestors` for current ones. The CSP carries that one directive
 *   ONLY. A full policy would have to allow Next's inline bootstrap scripts,
 *   and that is a separate, verified change, not a header to guess at.
 * - HSTS is sent unconditionally. `next.config` headers are compiled at build
 *   time, so they cannot follow the runtime `EVENT_URL`, and they do not need
 *   to: a browser ignores `Strict-Transport-Security` received over plain HTTP
 *   (RFC 6797 §8.1), so `http://localhost` trials are unaffected.
 */
const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: {
    remotePatterns: [{ protocol: "https", hostname: "avatars.githubusercontent.com" }],
  },
  async headers() {
    return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
  },
};

export default nextConfig;
