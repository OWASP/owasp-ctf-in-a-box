import { describe, expect, it } from "vitest";
import { clientIp, trustedClientIpHeader } from "@/lib/client-ip";

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
