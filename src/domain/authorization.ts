export type Role = "OWNER" | "MANAGER" | "ACCOUNTANT" | "CASHIER" | "SUPER_ADMIN";

export interface Principal {
  userId: string;
  clientId: string | null;
  role: Role;
  stationIds: ReadonlySet<string> | null;
}

export interface ResourceScope {
  clientId: string;
  stationId?: string;
}

const clientWideRoles = new Set<Role>(["OWNER", "MANAGER", "ACCOUNTANT"]);

/** Enforce the same client and station boundary for API reads and writes. */
export function canAccess(principal: Principal, resource: ResourceScope): boolean {
  if (principal.role === "SUPER_ADMIN") return true;
  if (!principal.clientId || principal.clientId !== resource.clientId) return false;
  if (!resource.stationId || clientWideRoles.has(principal.role)) return true;
  return principal.stationIds?.has(resource.stationId) ?? false;
}

export function requireAccess(principal: Principal, resource: ResourceScope): void {
  if (!canAccess(principal, resource)) {
    throw new Error("FORBIDDEN_RESOURCE_SCOPE");
  }
}

export function canOverrideCreditLimit(role: Role): boolean {
  return role === "OWNER" || role === "MANAGER";
}
