import { describe, expect, it } from "vitest";
import { clientIp } from "@/lib/client-ip";

const h = (v?: string) => new Headers(v === undefined ? {} : { "x-forwarded-for": v });

describe("clientIp", () => {
  it("takes the rightmost entry", () => expect(clientIp(h("1.1.1.1, 2.2.2.2"))).toBe("2.2.2.2"));
  it("trims", () => expect(clientIp(h(" 3.3.3.3 "))).toBe("3.3.3.3"));
  it("is unknown when missing or empty", () => {
    expect(clientIp(h())).toBe("unknown");
    expect(clientIp(h(""))).toBe("unknown");
    expect(clientIp(h(", ,"))).toBe("unknown");
  });
  it("skips trailing empty entries", () => expect(clientIp(h("1.1.1.1, 2.2.2.2,"))).toBe("2.2.2.2"));
});
