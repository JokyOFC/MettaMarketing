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

// Online purchase started by a "Comprar" button of the site.
const PURCHASE_PATH = /^\/painel\/contratar\/([a-z0-9-]{1,64})\/?$/;
export const purchaseSlug = (path) => (typeof path === "string" ? (path.match(PURCHASE_PATH)?.[1] ?? null) : null);

// Visitors who come to buy usually have no account yet: they start at /cadastro.
export function signupPath(location) {
  return `/cadastro?next=${encodeURIComponent(`${location.pathname}${location.search || ""}`)}`;
}

// Keeps the destination when switching between /login and /cadastro.
export const withNext = (path, next) => (next ? `${path}?next=${encodeURIComponent(next)}` : path);
