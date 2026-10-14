// Deployment-time check on BETTER_AUTH_URL (which docker-compose sets from
// EVENT_URL). Pure and dependency-free so it can be exhaustively tested
// without a server, a build, or an environment.
//
// WHY THIS EXISTS. better-auth derives the session cookie's `Secure` flag from
// the scheme of its baseURL. Ship an event on `http://ctf.example.org` and
// every session cookie — including an organizer's, whose login is in
// `.env`'s `ADMIN_LOGINS` — travels in cleartext on whatever conference wifi
// the contestants are sharing. This app has no server-side session store: the
// cookie IS the identity, so sniffing one is a full admin takeover, not a
// nuisance. The default in .env.example is `http://localhost`, which is
// correct for a local trial and catastrophic if an organizer edits the host
// and not the scheme — a one-token mistake with no visible symptom.

type UrlVerdict = {
  level: "ok" | "warn" | "fail";
  /** Empty when `ok`. Written to be read in a container log, so it names the
   *  variable, the value, and the fix rather than describing a category. */
  message: string;
};

const OK: UrlVerdict = { level: "ok", message: "" };

/** Hosts where plain HTTP is genuinely fine: the traffic never leaves the
 *  machine. `*.localhost` resolves to loopback per RFC 6761, and some local
 *  setups use it for named vhosts. */
function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "127.0.0.1" || h.startsWith("127.")) return true;
  // URL parsing normalises an IPv6 literal to bracketed lowercase.
  return h === "[::1]";
}

export function checkEventUrl(opts: {
  url: string | undefined;
  nodeEnv: string | undefined;
  /** `ALLOW_INSECURE_EVENT_URL=1` — the deliberate-choice escape hatch. */
  allowInsecure?: boolean;
}): UrlVerdict {
  const { url, nodeEnv, allowInsecure = false } = opts;
  const production = nodeEnv === "production";

  if (!url) {
    // better-auth falls back to inferring its base URL from request headers,
    // which works but makes the cookie policy depend on whatever a proxy
    // happens to forward. Never fatal — a dev server with no .env is the
    // common case — but worth saying in production.
    return production
      ? { level: "warn", message: "BETTER_AUTH_URL is unset; better-auth will infer its base URL from request headers, and the session cookie's Secure flag with it. Set EVENT_URL to your event's https:// address." }
      : OK;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { level: "warn", message: `BETTER_AUTH_URL is not a valid URL (${url}); cannot check whether the session cookie will be Secure.` };
  }

  if (parsed.protocol === "https:") return OK;

  if (parsed.protocol !== "http:") {
    return { level: "warn", message: `BETTER_AUTH_URL has an unexpected scheme (${parsed.protocol}); expected https:// for a real event.` };
  }

  if (isLoopback(parsed.hostname)) return OK;

  const detail =
    `BETTER_AUTH_URL is ${url} — plain HTTP to a non-local host. ` +
    `The session cookie will be sent WITHOUT the Secure flag, so anyone on the network path can capture it, ` +
    `and this app keeps no server-side session store: a captured cookie IS the account, including an organizer's. ` +
    `Set EVENT_URL to an https:// address (the bundled Caddy will get a certificate for a real domain automatically).`;

  // Development is where an organizer legitimately points a LAN address at the
  // box to test from a phone. Say it clearly; do not stop them.
  if (!production) return { level: "warn", message: detail };

  if (allowInsecure) {
    return {
      level: "warn",
      message: `${detail} Continuing because ALLOW_INSECURE_EVENT_URL is set — sessions on this deployment are sniffable by design.`,
    };
  }

  return {
    level: "fail",
    // Deliberately NOT offered as "TLS is terminated upstream": in that setup
    // the public URL is still https://, so EVENT_URL should say https:// and
    // this check passes. The hatch is for a genuinely TLS-less deployment —
    // a closed lab, an isolated classroom network — where the organizer has
    // decided sniffable sessions are acceptable.
    // "Refusing to serve", not "refusing to start": Next catches the throw
    // from the instrumentation hook, keeps the process alive, and answers 500
    // to everything. Verified against Next 16.3.0. Nothing is served either
    // way, but the log line should describe what the operator will actually
    // see (`docker compose ps` shows the container Up).
    message: `${detail} Refusing to serve — every request will return 500 until this is fixed. If this deployment is deliberately TLS-less (a closed lab or classroom network), set ALLOW_INSECURE_EVENT_URL=1.`,
  };
}
