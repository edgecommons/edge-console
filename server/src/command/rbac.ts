/**
 * RBAC — the console's authorization seam for the C4 command surface (the write path).
 *
 * This is the minimal, DECLARED policy the reconciliation calls for (§2.2 "RBAC" row):
 * a config-driven allow/deny of command verbs per role, evaluated PURELY (no IO) so it
 * is unit-testable and so a denied command never touches the bus. It is deliberately
 * NOT authentication — there is no bearer/mTLS/OIDC verification here. The identity→role
 * decision is the AUTH SEAM, and it lives at the WS transport edge
 * (`ws-server.ts` `onConnection`, where the C2 auth TODO already sits): a future auth
 * plugin resolves the connection's principal from the upgrade request's headers/cert and
 * maps it to one of these roles. Until then every connection is assigned the configured
 * {@link RbacPolicy.defaultRole} (see `resolveRole` in `ws-server.ts`), whose default
 * posture is permissive (the built-ins are allowed) — the seam is real and wired, the
 * enforcement is honest, only the identity source is stubbed.
 *
 * Config shape (`component.global.console.rbac`, reconciliation G12 — no ggcommons schema
 * change, the knobs live in the console's own permissive `component.global` subtree):
 *
 * ```jsonc
 * "console": {
 *   "rbac": {
 *     "defaultRole": "operator",
 *     "roles": {
 *       "operator": { "allow": ["*"] },                         // full control
 *       "viewer":   { "allow": ["ping", "get-configuration"] }  // read-only verbs
 *     }
 *   }
 * }
 * ```
 *
 * Decision rule (fail-closed): an unknown role is denied everything; within a known role
 * `deny` wins over `allow`, and `"*"` is the all-verbs wildcard in either list.
 */

/** A role's verb policy: allow/deny lists (`"*"` = every verb). `deny` wins over `allow`. */
export interface RolePolicy {
  /** Verbs this role may invoke (`["*"]` = all). Empty/absent ⇒ nothing allowed. */
  allow: string[];
  /** Verbs this role may never invoke (wins over `allow`; `["*"]` = block all). */
  deny: string[];
}

/** The parsed `console.rbac` policy: the fallback role + the per-role verb policies. */
export interface RbacConfig {
  /** The role assigned to a connection with no resolved principal (the auth seam's fallback). */
  defaultRole: string;
  /** role name → its verb policy. Must contain {@link RbacConfig.defaultRole}. */
  roles: Record<string, RolePolicy>;
}

/**
 * The default RBAC posture: two roles, `operator` (full control — the permissive default
 * the reconciliation asks for, "allow the built-ins but make it a real seam") and
 * `viewer` (read-only: the two non-mutating built-ins). New deployments get commanding
 * out of the box; locking it down is a config edit, not a code change.
 */
export const DEFAULT_RBAC_CONFIG: RbacConfig = {
  defaultRole: "operator",
  roles: {
    operator: { allow: ["*"], deny: [] },
    viewer: { allow: ["ping", "get-configuration"], deny: [] },
  },
};

/** The authorization decision surface the {@link CommandGateway} consults. */
export interface RbacPolicy {
  /** The role assigned to an unauthenticated connection (the auth seam's fallback). */
  readonly defaultRole: string;
  /** Whether `role` may invoke `verb`. Unknown role ⇒ `false` (fail-closed). */
  can(role: string, verb: string): boolean;
}

function listMatches(list: string[], verb: string): boolean {
  return list.includes("*") || list.includes(verb);
}

/** A pure {@link RbacPolicy} over a parsed {@link RbacConfig}. */
export class ConfigRbacPolicy implements RbacPolicy {
  readonly defaultRole: string;
  private readonly roles: Record<string, RolePolicy>;

  constructor(config: RbacConfig) {
    this.defaultRole = config.defaultRole;
    this.roles = config.roles;
  }

  can(role: string, verb: string): boolean {
    const policy = this.roles[role];
    if (policy === undefined) return false; // fail-closed: an unknown role can do nothing
    if (listMatches(policy.deny, verb)) return false; // deny wins over allow
    return listMatches(policy.allow, verb);
  }
}
