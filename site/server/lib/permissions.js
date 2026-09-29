// Role -> capabilities (docs/PLATFORM.md §2). Capabilities gate actions; the
// data scope of each record is enforced separately by lib/access.js.

export const CAPABILITIES = [
  "clients.view",
  "clients.create",
  "clients.edit",
  "brands.edit",
  "team.view",
  "team.manage",
  "categories.manage",
  "settings.manage",
  "services.view",
  "services.manage",
  "orders.view",
  "orders.manage",
  "finance.view",
  "projects.view",
  "projects.manage",
  "tasks.manage",
  "materials.view",
  "materials.upload",
  "materials.edit",
  "materials.release",
  "materials.archive",
  "content.view",
  "content.manage",
  "content.publication",
  "approvals.view",
  "comments.internal",
  "briefings.view",
  "briefings.manage",
  "reports.view",
  "reports.finance",
  "activity.view",
  "portal.access",
];

export const ROLES = ["admin", "manager", "designer", "finance", "client"];
export const STAFF_ROLES = ["admin", "manager", "designer", "finance"];

export const ROLE_LABELS = {
  admin: "Administrador",
  manager: "Gestor",
  designer: "Designer/editor",
  finance: "Financeiro",
  client: "Cliente",
};

const ROLE_CAPS = {
  // Everything that belongs to the team. portal.access marks the client
  // portal and is never given to staff.
  admin: CAPABILITIES.filter((cap) => cap !== "portal.access"),
  manager: [
    "clients.view",
    "brands.edit",
    "team.view",
    "services.view",
    "projects.view",
    "projects.manage",
    "tasks.manage",
    "materials.view",
    "materials.upload",
    "materials.edit",
    "materials.release",
    "materials.archive",
    "content.view",
    "content.manage",
    "content.publication",
    "approvals.view",
    "comments.internal",
    "briefings.view",
    "briefings.manage",
    "reports.view",
    "activity.view",
  ],
  designer: [
    "clients.view",
    "projects.view",
    "tasks.manage",
    "materials.view",
    "materials.upload",
    "materials.edit",
    "content.view",
    "content.manage",
    "comments.internal",
    "briefings.view",
    "activity.view",
  ],
  finance: [
    "clients.view",
    "services.view",
    "services.manage",
    "orders.view",
    "orders.manage",
    "finance.view",
    "reports.finance",
  ],
  client: ["portal.access"],
};

const CAP_SETS = Object.fromEntries(
  Object.entries(ROLE_CAPS).map(([role, caps]) => [role, new Set(caps)]),
);

export function capabilitiesFor(role) {
  return [...(ROLE_CAPS[role] ?? [])];
}

export function can(user, cap) {
  if (!user || (user.status && user.status !== "active")) return false;
  return CAP_SETS[user.role]?.has(cap) ?? false;
}

export const isStaffRole = (role) => STAFF_ROLES.includes(role);
