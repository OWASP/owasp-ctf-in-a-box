import { describe, expect, it } from "vitest";
import { behindCloudflare, clientIp, isCloudflareAddress, trustedClientIpHeader } from "@/lib/client-ip";

const h = (v?: string) => new Headers(v === undefined ? {} : { "x-forwarded-for": v });
const UNSET = {};
const FLY = { TRUSTED_CLIENT_IP_HEADER: "fly-client-ip" };
// Fly's proxy appends the app's own address as the rightmost entry.
const FLY_APP_ADDR = "66.241.124.10";

describe("clientIp with no trusted header (compose, AWS)", () => {
  it("takes the rightmost entry", () => expect(clientIp(h("1.1.1.1, 2.2.2.2"), UNSET)).toBe("2.2.2.2"));
  it("trims", () => expect(clientIp(h(" 3.3.3.3 "), UNSET)).toBe("3.3.3.3"));
  it("is unknown when missing or empty", () => {
    expect(clientIp(h(), UNSET)).toBe("unknown");
    expect(clientIp(h(""), UNSET)).toBe("unknown");
    expect(clientIp(h(", ,"), UNSET)).toBe("unknown");
  });
  it("skips trailing empty entries", () => expect(clientIp(h("1.1.1.1, 2.2.2.2,"), UNSET)).toBe("2.2.2.2"));
  it("treats a blank setting as unset", () =>
    expect(clientIp(h("1.1.1.1, 2.2.2.2"), { TRUSTED_CLIENT_IP_HEADER: "  " })).toBe("2.2.2.2"));
  it("ignores a fly-client-ip header nobody configured", () => {
    const headers = new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2", "fly-client-ip": "9.9.9.9" });
    expect(clientIp(headers, UNSET)).toBe("2.2.2.2");
  });
});

describe("clientIp with TRUSTED_CLIENT_IP_HEADER=fly-client-ip", () => {
  const fly = (client: string, xff: string) => new Headers({ "fly-client-ip": client, "x-forwarded-for": xff });

  it("keys two clients behind the same Fly app address apart", () => {
    const a = clientIp(fly("203.0.113.7", `203.0.113.7, ${FLY_APP_ADDR}`), FLY);
    const b = clientIp(fly("198.51.100.4", `198.51.100.4, ${FLY_APP_ADDR}`), FLY);
    expect([a, b]).toEqual(["203.0.113.7", "198.51.100.4"]);
    // The rightmost rule would have merged them on the app's address.
    expect(clientIp(fly("203.0.113.7", `203.0.113.7, ${FLY_APP_ADDR}`), UNSET)).toBe(FLY_APP_ADDR);
  });

  it("does not move when the client spoofs x-forwarded-for", () => {
    for (const xff of ["6.6.6.6", `6.6.6.6, ${FLY_APP_ADDR}`, "", `${FLY_APP_ADDR}, 6.6.6.6`]) {
      expect(clientIp(fly("203.0.113.7", xff), FLY)).toBe("203.0.113.7");
    }
  });

  it("is unknown when the configured header is missing, never falling back to x-forwarded-for", () => {
    expect(clientIp(h(`203.0.113.7, ${FLY_APP_ADDR}`), FLY)).toBe("unknown");
    expect(clientIp(new Headers({ "fly-client-ip": " , " }), FLY)).toBe("unknown");
  });

  it("trims, takes the first entry of a list, and matches the name case-insensitively", () => {
    expect(clientIp(new Headers({ "fly-client-ip": " 203.0.113.7 " }), FLY)).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "fly-client-ip": "203.0.113.7, 10.0.0.1" }), FLY)).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "Fly-Client-IP": "203.0.113.7" }), { TRUSTED_CLIENT_IP_HEADER: "Fly-Client-IP" })).toBe(
      "203.0.113.7",
    );
  });
});

describe("clientIp with CLIENT_IP_BEHIND_CLOUDFLARE=true", () => {
  // A real Cloudflare edge address (198.41.128.0/17) and one from 2606:4700::/32.
  const EDGE_V4 = "198.41.200.13";
  const EDGE_V6 = "2606:4700:10::ac43:1b0a";
  const CF = { CLIENT_IP_BEHIND_CLOUDFLARE: "true" };
  const CF_FLY = { ...CF, ...FLY };
  const via = (peerXff: string, cf?: string) =>
    new Headers({ "x-forwarded-for": peerXff, ...(cf === undefined ? {} : { "cf-connecting-ip": cf }) });

  it("keys two players behind the same Cloudflare edge apart (compose, AWS)", () => {
    const a = clientIp(via(`203.0.113.7, ${EDGE_V4}`, "203.0.113.7"), CF);
    const b = clientIp(via(`198.51.100.4, ${EDGE_V4}`, "198.51.100.4"), CF);
    expect([a, b]).toEqual(["203.0.113.7", "198.51.100.4"]);
    // Without the setting both share the edge's bucket, the bug in #820.
    expect(clientIp(via(`203.0.113.7, ${EDGE_V4}`, "203.0.113.7"), UNSET)).toBe(EDGE_V4);
  });

  it("reads CF-Connecting-IP behind Fly when Fly-Client-IP is a Cloudflare edge", () => {
    const headers = new Headers({ "fly-client-ip": EDGE_V4, "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": `x, ${FLY_APP_ADDR}` });
    expect(clientIp(headers, CF_FLY)).toBe("203.0.113.7");
  });

  it("accepts an IPv6 edge and an IPv6 client", () => {
    expect(clientIp(via(EDGE_V6, "2001:db8::42"), CF)).toBe("2001:db8::42");
  });

  it("ignores CF-Connecting-IP from a peer outside Cloudflare's ranges, so a direct-to-origin client cannot pick its bucket", () => {
    for (const peer of ["203.0.113.9", "198.41.127.255", "2606:4701::1"]) {
      expect(clientIp(via(peer, "6.6.6.6"), CF)).toBe(peer);
    }
    expect(clientIp(new Headers({ "cf-connecting-ip": "6.6.6.6" }), CF)).toBe("unknown");
    expect(clientIp(new Headers({ "fly-client-ip": "203.0.113.9", "cf-connecting-ip": "6.6.6.6" }), CF_FLY)).toBe("203.0.113.9");
  });

  it("keeps the edge address when CF-Connecting-IP is missing or not a single IP", () => {
    for (const cf of [undefined, "", " , ", "not-an-ip", "203.0.113.7, 10.0.0.1", "999.1.1.1", "1.2.3"]) {
      expect(clientIp(via(EDGE_V4, cf), CF)).toBe(EDGE_V4);
    }
  });

  it("trims CF-Connecting-IP", () => expect(clientIp(via(EDGE_V4, " 203.0.113.7 "), CF)).toBe("203.0.113.7"));

  it("ignores CF-Connecting-IP when the setting is off or blank", () => {
    for (const env of [UNSET, { CLIENT_IP_BEHIND_CLOUDFLARE: "" }, { CLIENT_IP_BEHIND_CLOUDFLARE: "false" }]) {
      expect(clientIp(via(EDGE_V4, "203.0.113.7"), env)).toBe(EDGE_V4);
    }
  });
});

describe("behindCloudflare", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["  ", false],
    ["false", false],
    ["true", true],
    [" TRUE ", true],
  ])("reads %j as %s", (v, want) => expect(behindCloudflare(v === undefined ? {} : { CLIENT_IP_BEHIND_CLOUDFLARE: v })).toBe(want));
  it.each(["yes", "1", "on", "cloudflare"])("throws on %j instead of guessing", (v) => {
    expect(() => behindCloudflare({ CLIENT_IP_BEHIND_CLOUDFLARE: v })).toThrow(/CLIENT_IP_BEHIND_CLOUDFLARE/);
  });
});

describe("isCloudflareAddress", () => {
  it.each([
    ["173.245.48.1", true],
    ["104.16.0.0", true],
    ["104.23.255.255", true],
    ["104.24.0.1", true],
    ["104.28.0.0", false],
    ["198.41.128.0", true],
    ["198.41.255.255", true],
    ["198.42.0.0", false],
    ["2400:cb00::1", true],
    ["2a06:98c0::1", true],
    ["2a06:98c8::1", false],
    ["2001:db8::1", false],
    ["8.8.8.8", false],
    ["not-an-ip", false],
    ["", false],
  ])("%s -> %s", (ip, want) => expect(isCloudflareAddress(ip)).toBe(want));
});

describe("trustedClientIpHeader", () => {
  it("is null when unset or blank", () => {
    expect(trustedClientIpHeader({})).toBeNull();
    expect(trustedClientIpHeader({ TRUSTED_CLIENT_IP_HEADER: "" })).toBeNull();
  });
  it("lowercases a valid name", () => expect(trustedClientIpHeader({ TRUSTED_CLIENT_IP_HEADER: " Fly-Client-IP " })).toBe("fly-client-ip"));
  it.each(["fly client ip", "fly-client-ip:", "x\ny", "ünïcode"])("throws on the invalid name %j instead of reading it as unset", (v) => {
    expect(() => trustedClientIpHeader({ TRUSTED_CLIENT_IP_HEADER: v })).toThrow(/TRUSTED_CLIENT_IP_HEADER/);
    expect(() => clientIp(h("1.1.1.1"), { TRUSTED_CLIENT_IP_HEADER: v })).toThrow(/TRUSTED_CLIENT_IP_HEADER/);
  });
});
