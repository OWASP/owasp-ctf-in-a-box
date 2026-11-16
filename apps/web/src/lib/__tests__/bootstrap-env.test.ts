import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { adminClaimCodeHash, getGithubOrg } from "@/lib/bootstrap-env";

const VECTOR_HASH = "3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getGithubOrg", () => {
  it("trims the configured org", () => {
    expect(getGithubOrg({ GITHUB_ORG: "  org " })).toBe("org");
  });

  it("is '' when unset — R2: may be empty, no baked default", () => {
    expect(getGithubOrg({})).toBe("");
  });
});

describe("adminClaimCodeHash", () => {
  it("returns a valid hash trimmed and lowercased, without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(adminClaimCodeHash({ ADMIN_CLAIM_CODE_HASH: ` ${VECTOR_HASH.toUpperCase()} ` })).toBe(VECTOR_HASH);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is '' when unset or blank, without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(adminClaimCodeHash({})).toBe("");
    expect(adminClaimCodeHash({ ADMIN_CLAIM_CODE_HASH: "  " })).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a pasted code or a short value as unset, warning without the value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(adminClaimCodeHash({ ADMIN_CLAIM_CODE_HASH: "0123-4567-89ab-cdef-0123-4567-89ab-cdef" })).toBe("");
    expect(adminClaimCodeHash({ ADMIN_CLAIM_CODE_HASH: VECTOR_HASH.slice(1) })).toBe("");
    const text = warn.mock.calls.flat().join(" ");
    expect(text).toContain("ADMIN_CLAIM_CODE_HASH");
    expect(text).toContain("not a 64-hex SHA-256");
    expect(text).not.toContain("0123-4567");
    expect(text).not.toContain(VECTOR_HASH.slice(1, 20));
  });
});
