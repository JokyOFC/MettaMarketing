export const STAFF_ROLES = ["admin", "manager", "designer", "finance"];

export const ROLE_LABELS = {
  admin: "Administrador",
  manager: "Gestor",
  designer: "Designer/editor",
  finance: "Financeiro",
  client: "Cliente",
};

export const isStaff = (user) => Boolean(user && STAFF_ROLES.includes(user.role));
export const areaOf = (user) => (user?.role === "client" ? "client" : "admin");
export const homeFor = (user) => (areaOf(user) === "client" ? "/painel" : "/admin");
export const roleLabel = (role) => ROLE_LABELS[role] || "";

// Only same-site paths inside the user's own area are accepted as `next`.
export function safeNext(next, user) {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//"))
    return homeFor(user);
  if (/[\\\s]/.test(next)) return homeFor(user);
  const base = homeFor(user);
  return next === base || next.startsWith(`${base}/`) || next.startsWith(`${base}?`)
    ? next
    : base;
}

export function loginPath(location) {
  const next = `${location.pathname}${location.search || ""}`;
  return `/login?next=${encodeURIComponent(next)}`;
}
