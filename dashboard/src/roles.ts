// Dashboard roles, lowest to highest; each role can do everything the ones before it can

export const ROLES = ['viewer', 'operator', 'admin'] as const
export type Role = (typeof ROLES)[number]
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v)
export const atLeast = (role: Role, min: Role) => ROLES.indexOf(role) >= ROLES.indexOf(min)
