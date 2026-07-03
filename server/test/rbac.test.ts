/**
 * The C4 authorization policy (`ConfigRbacPolicy`): the pure allow/deny decision the
 * CommandGateway consults. Fail-closed on unknown roles; `deny` wins over `allow`;
 * `"*"` is the wildcard in either list.
 */
import { describe, expect, it } from "vitest";
import { ConfigRbacPolicy, DEFAULT_RBAC_CONFIG } from "../src/command/rbac";

describe("ConfigRbacPolicy", () => {
  it("exposes the configured defaultRole", () => {
    expect(new ConfigRbacPolicy(DEFAULT_RBAC_CONFIG).defaultRole).toBe("operator");
  });

  it("the default operator role may invoke every verb (wildcard allow)", () => {
    const p = new ConfigRbacPolicy(DEFAULT_RBAC_CONFIG);
    for (const verb of ["ping", "reload-config", "get-configuration", "restart-pipeline"]) {
      expect(p.can("operator", verb)).toBe(true);
    }
  });

  it("the default viewer role is read-only (the two non-mutating built-ins)", () => {
    const p = new ConfigRbacPolicy(DEFAULT_RBAC_CONFIG);
    expect(p.can("viewer", "ping")).toBe(true);
    expect(p.can("viewer", "get-configuration")).toBe(true);
    expect(p.can("viewer", "reload-config")).toBe(false);
    expect(p.can("viewer", "restart-pipeline")).toBe(false);
  });

  it("fails closed for an unknown role (denies everything)", () => {
    const p = new ConfigRbacPolicy(DEFAULT_RBAC_CONFIG);
    expect(p.can("nobody", "ping")).toBe(false);
    expect(p.can("", "ping")).toBe(false);
  });

  it("deny wins over allow (even a wildcard allow)", () => {
    const p = new ConfigRbacPolicy({
      defaultRole: "restricted",
      roles: { restricted: { allow: ["*"], deny: ["reload-config"] } },
    });
    expect(p.can("restricted", "ping")).toBe(true);
    expect(p.can("restricted", "reload-config")).toBe(false);
  });

  it("a wildcard deny blocks everything for that role", () => {
    const p = new ConfigRbacPolicy({
      defaultRole: "muted",
      roles: { muted: { allow: ["*"], deny: ["*"] } },
    });
    expect(p.can("muted", "ping")).toBe(false);
  });

  it("an empty allow list allows nothing", () => {
    const p = new ConfigRbacPolicy({ defaultRole: "empty", roles: { empty: { allow: [], deny: [] } } });
    expect(p.can("empty", "ping")).toBe(false);
  });
});
