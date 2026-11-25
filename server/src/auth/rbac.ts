export const ROLES = ["owner", "admin", "engineer", "security", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  "workspace.view": ["owner", "admin", "engineer", "security", "viewer"],
  "workspace.manage": ["owner", "admin"],
  "workspace.delete": ["owner"],
  "members.manage": ["owner", "admin"],
  "repo.create": ["owner", "admin", "engineer"],
  "repo.delete": ["owner", "admin"],
  "analysis.run": ["owner", "admin", "engineer", "security"],
  "findings.update": ["owner", "admin", "engineer", "security"],
  "investigations.create": ["owner", "admin", "engineer", "security"],
  "reviews.create": ["owner", "admin", "engineer", "security"],
  "tests.run": ["owner", "admin", "engineer"],
  "agents.run": ["owner", "admin", "engineer", "security"],
  "agents.configure": ["owner", "admin"],
  "workflows.edit": ["owner", "admin", "engineer"],
  "workflows.run": ["owner", "admin", "engineer", "security"],
  "approvals.decide": ["owner", "admin", "security"],
  "settings.manage": ["owner", "admin"],
  "secrets.manage": ["owner", "admin"],
  "integrations.manage": ["owner", "admin"],
  "kb.write": ["owner", "admin", "engineer", "security"],
  "reports.create": ["owner", "admin", "engineer", "security"],
  "comments.create": ["owner", "admin", "engineer", "security"],
  "ai.use": ["owner", "admin", "engineer", "security"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[perm] as readonly Role[]).includes(role);
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}
