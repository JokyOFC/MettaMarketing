// Record scope (docs/PLATFORM.md §2). Every route resolves ids through these
// helpers: anything outside the viewer's scope answers 404, never 403, so
// existence is not revealed. 403 is reserved for records the viewer can see
// but cannot act on.
//
//   admin     everything
//   finance   every client and brand (commerce data); no projects/materials
//   manager   clients in staff_client_access and everything below them
//   designer  projects in project_members; brands/clients of those projects
//             (read); materials of those brands, or created/owned by them
//   client    own client_id; materials only when released (rule §2.4)

import { forbidden, notFound, unauthenticated } from "./errors.js";

const scopes = new WeakMap();

const inList = (column, values) =>
  values.length ? { sql: `${column} IN (${values.map(() => "?").join(", ")})`, params: values } : { sql: "0 = 1", params: [] };

function requireUser(req) {
  if (!req?.user) throw unauthenticated();
  return req.user;
}

const db = (req) => req.ctx.db;

// scopeSql helpers accept a request or a bare user row.
function viewer(source) {
  if (source?.user) return source.user;
  if (source?.id && source?.role) return source;
  throw unauthenticated();
}

/**
 * getScope(req) -> { role, userId, all, clientIds: Set|null, projectIds: Set|null,
 *                    brandIds: Set|null, materials: boolean, projects: boolean }
 * null sets mean "not restricted at this level" (e.g. a manager sees every
 * project of the clients in clientIds). Cached per request.
 */
export async function getScope(req) {
  const user = requireUser(req);
  const cached = scopes.get(req);
  if (cached && cached.userId === user.id) return cached;
  let scope;
  switch (user.role) {
    case "admin":
      scope = { all: true, clientIds: null, projectIds: null, brandIds: null, materials: true, projects: true };
      break;
    case "finance":
      scope = { all: true, clientIds: null, projectIds: null, brandIds: null, materials: false, projects: false };
      break;
    case "manager": {
      const rows = await db(req).all("SELECT client_id FROM staff_client_access WHERE user_id = ?", [user.id]);
      scope = {
        all: false,
        clientIds: new Set(rows.map((row) => row.client_id)),
        projectIds: null,
        brandIds: null,
        materials: true,
        projects: true,
      };
      break;
    }
    case "designer": {
      const rows = await db(req).all(
        `SELECT p.id AS project_id, p.brand_id, b.client_id
           FROM project_members pm
           JOIN projects p ON p.id = pm.project_id
           JOIN brands b ON b.id = p.brand_id
          WHERE pm.user_id = ?`,
        [user.id],
      );
      scope = {
        all: false,
        clientIds: new Set(rows.map((row) => row.client_id)),
        projectIds: new Set(rows.map((row) => row.project_id)),
        brandIds: new Set(rows.map((row) => row.brand_id)),
        materials: true,
        projects: true,
      };
      break;
    }
    case "client":
      scope = {
        all: false,
        clientIds: new Set(user.client_id ? [user.client_id] : []),
        projectIds: null,
        brandIds: null,
        materials: true,
        projects: true,
      };
      break;
    default:
      scope = { all: false, clientIds: new Set(), projectIds: new Set(), brandIds: new Set(), materials: false, projects: false };
  }
  scope.role = user.role;
  scope.userId = user.id;
  scopes.set(req, scope);
  return scope;
}

// Drop the cached scope (after changing memberships inside the same request).
export function resetScope(req) {
  scopes.delete(req);
}

const hasClient = (scope, clientId) => scope.all || scope.clientIds?.has(clientId);

// Staff member of a project (any project role).
function isMember(scope, projectId) {
  return Boolean(projectId) && Boolean(scope.projectIds?.has(projectId));
}

// ------------------------------------------------------------------ records

export async function assertClient(req, id) {
  const scope = await getScope(req);
  const row = id ? await db(req).get("SELECT * FROM clients WHERE id = ?", [id]) : null;
  if (!row || !hasClient(scope, row.id)) throw notFound();
  return row;
}

export async function assertBrand(req, id) {
  const scope = await getScope(req);
  const row = id
    ? await db(req).get(
        `SELECT b.*, c.name AS client_name
           FROM brands b JOIN clients c ON c.id = b.client_id
          WHERE b.id = ?`,
        [id],
      )
    : null;
  if (!row || !hasClient(scope, row.client_id)) throw notFound();
  if (scope.role === "designer" && !scope.brandIds.has(row.id)) throw notFound();
  return row;
}

// Returns the project row plus client_id (from its brand).
export async function assertProject(req, id) {
  const scope = await getScope(req);
  if (!scope.projects) throw notFound();
  const row = id
    ? await db(req).get(
        `SELECT p.*, b.client_id AS client_id
           FROM projects p JOIN brands b ON b.id = p.brand_id
          WHERE p.id = ?`,
        [id],
      )
    : null;
  if (!row || !hasClient(scope, row.client_id)) throw notFound();
  if (scope.role === "designer" && !scope.projectIds.has(row.id)) throw notFound();
  return row;
}

const MATERIAL_SQL = `SELECT m.*, b.client_id AS client_id
  FROM materials m JOIN brands b ON b.id = m.brand_id
 WHERE m.id = ?`;

// Client visibility rule (§2.4) on a loaded material row.
export function clientCanSeeMaterial(user, row) {
  return (
    Boolean(row) &&
    user.role === "client" &&
    row.client_id === user.client_id &&
    row.visibility === "released" &&
    !row.archived_at &&
    Boolean(row.released_version_id)
  );
}

function canReadMaterial(req, scope, row) {
  const user = req.user;
  if (!scope.materials) return false;
  if (scope.all) return true;
  if (user.role === "client") return clientCanSeeMaterial(user, row);
  if (user.role === "manager") return scope.clientIds.has(row.client_id);
  if (user.role === "designer")
    return (
      scope.brandIds.has(row.brand_id) ||
      isMember(scope, row.project_id) ||
      row.created_by === user.id ||
      row.owner_id === user.id
    );
  return false;
}

// Scope-level write check (capabilities are checked by the route).
export async function canWriteMaterial(req, row) {
  if (!row || !req?.user) return false;
  const scope = await getScope(req);
  const user = req.user;
  if (!scope.materials || user.role === "client" || user.role === "finance") return false;
  if (scope.all) return true;
  if (user.role === "manager") return scope.clientIds.has(row.client_id);
  if (user.role === "designer")
    return isMember(scope, row.project_id) || row.created_by === user.id || row.owner_id === user.id;
  return false;
}

// Returns the material row plus client_id. { write: true } -> 403 when the
// viewer can see it but cannot change it.
export async function assertMaterial(req, id, { write = false } = {}) {
  const scope = await getScope(req);
  const row = id ? await db(req).get(MATERIAL_SQL, [id]) : null;
  if (!row || !canReadMaterial(req, scope, row)) throw notFound();
  if (write && !await canWriteMaterial(req, row)) throw forbidden();
  return row;
}

// Returns the version row; its material row is on the non-enumerable
// `version.material` property (never serialised by accident).
export async function assertVersion(req, id, { write = false } = {}) {
  requireUser(req);
  const version = id ? await db(req).get("SELECT * FROM material_versions WHERE id = ?", [id]) : null;
  if (!version) throw notFound();
  const material = await assertMaterial(req, version.material_id, { write });
  if (req.user.role === "client" && !version.released_at) throw notFound();
  Object.defineProperty(version, "material", { value: material, enumerable: false });
  return version;
}

const CLIENT_FILE_ROLES = new Set(["original", "final", "cover"]);

// Whether a client may see a file row of a material (role rules). Final
// files attached after the release stay hidden (published = 0) until the
// team delivers them (migration 002).
export function clientCanSeeFile(file, material) {
  if (file.published !== undefined && file.published !== null && Number(file.published) !== 1) return false;
  return CLIENT_FILE_ROLES.has(file.role) || (file.role === "editable" && material.editable_included === 1);
}

/**
 * Download rule for a visible file -> { ok, reason }. Staff with read scope
 * may always download. reason: 'not_downloadable' | 'download_disabled' | 'font_license'.
 */
export function downloadRule(user, file, material) {
  if (user.role !== "client") return { ok: true, reason: null };
  if (file.role === "cover") return { ok: false, reason: "not_downloadable" };
  if (material.download_enabled !== 1) return { ok: false, reason: "download_disabled" };
  if (file.media_kind === "font" && file.font_distributable !== 1) return { ok: false, reason: "font_license" };
  return { ok: true, reason: null };
}

const DOWNLOAD_MESSAGES = {
  not_downloadable: "Este arquivo é apenas uma prévia e não está disponível para download.",
  download_disabled: "O download deste material ainda não foi liberado pela equipe Metta.",
  font_license: "A licença desta fonte não permite a distribuição do arquivo. Use o link oficial de aquisição.",
};

// Returns the file row with non-enumerable `file.version` and `file.material`.
// { download: true } additionally applies the download rule (403 with code
// download_disabled or font_license).
export async function assertFile(req, id, { download = false, write = false } = {}) {
  requireUser(req);
  const file = id ? await db(req).get("SELECT * FROM material_files WHERE id = ?", [id]) : null;
  if (!file) throw notFound();
  const version = await assertVersion(req, file.version_id, { write });
  const material = version.material;
  if (req.user.role === "client" && !clientCanSeeFile(file, material)) throw notFound();
  if (download) {
    const rule = downloadRule(req.user, file, material);
    if (!rule.ok)
      throw forbidden(DOWNLOAD_MESSAGES[rule.reason], rule.reason === "not_downloadable" ? "download_disabled" : rule.reason);
  }
  Object.defineProperty(file, "version", { value: version, enumerable: false });
  Object.defineProperty(file, "material", { value: material, enumerable: false });
  return file;
}

// ------------------------------------------------------------- SQL fragments
// Each helper returns { sql, params } — a boolean expression with positional
// `?` placeholders to AND into a WHERE clause (append params in order).

const MANAGER_CLIENTS = "SELECT client_id FROM staff_client_access WHERE user_id = ?";
const DESIGNER_PROJECTS = "SELECT project_id FROM project_members WHERE user_id = ?";
const DESIGNER_BRANDS = `SELECT p.brand_id FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = ?`;
const DESIGNER_CLIENTS = `SELECT b.client_id FROM project_members pm
  JOIN projects p ON p.id = pm.project_id JOIN brands b ON b.id = p.brand_id WHERE pm.user_id = ?`;

const NONE = Object.freeze({ sql: "0 = 1", params: [] });
const ALL = Object.freeze({ sql: "1 = 1", params: [] });

// Client visibility rule for materials, without the client check.
export function clientMaterialFilter(alias = "m") {
  return `(${alias}.visibility = 'released' AND ${alias}.archived_at IS NULL AND ${alias}.released_version_id IS NOT NULL)`;
}
// Versions a client may see.
export function clientVersionFilter(alias = "v") {
  return `${alias}.released_at IS NOT NULL`;
}
// File roles a client may see (needs the material alias for editable_included).
export function clientFileFilter(fileAlias = "f", materialAlias = "m") {
  return `(${fileAlias}.published = 1 AND (${fileAlias}.role IN ('original', 'final', 'cover') OR (${fileAlias}.role = 'editable' AND ${materialAlias}.editable_included = 1)))`;
}

export const scopeSql = {
  clients(req, alias = "c") {
    const user = viewer(req);
    switch (user.role) {
      case "admin":
      case "finance":
        return { ...ALL };
      case "manager":
        return { sql: `${alias}.id IN (${MANAGER_CLIENTS})`, params: [user.id] };
      case "designer":
        return { sql: `${alias}.id IN (${DESIGNER_CLIENTS})`, params: [user.id] };
      case "client":
        return { sql: `${alias}.id = ?`, params: [user.client_id] };
      default:
        return { ...NONE };
    }
  },

  brands(req, alias = "b") {
    const user = viewer(req);
    switch (user.role) {
      case "admin":
      case "finance":
        return { ...ALL };
      case "manager":
        return { sql: `${alias}.client_id IN (${MANAGER_CLIENTS})`, params: [user.id] };
      case "designer":
        return { sql: `${alias}.id IN (${DESIGNER_BRANDS})`, params: [user.id] };
      case "client":
        return { sql: `${alias}.client_id = ?`, params: [user.client_id] };
      default:
        return { ...NONE };
    }
  },

  projects(req, alias = "p") {
    const user = viewer(req);
    switch (user.role) {
      case "admin":
        return { ...ALL };
      case "manager":
        return {
          sql: `${alias}.brand_id IN (SELECT id FROM brands WHERE client_id IN (${MANAGER_CLIENTS}))`,
          params: [user.id],
        };
      case "designer":
        return { sql: `${alias}.id IN (${DESIGNER_PROJECTS})`, params: [user.id] };
      case "client":
        return { sql: `${alias}.brand_id IN (SELECT id FROM brands WHERE client_id = ?)`, params: [user.client_id] };
      default:
        return { ...NONE };
    }
  },

  // Materials visible to the viewer. brandAlias (optional) must be a join on
  // brands for the same row; without it a subquery resolves the client.
  materials(req, materialAlias = "m", brandAlias = null) {
    const user = viewer(req);
    const m = materialAlias;
    const clientExpr = brandAlias ? `${brandAlias}.client_id` : `(SELECT client_id FROM brands WHERE id = ${m}.brand_id)`;
    switch (user.role) {
      case "admin":
        return { ...ALL };
      case "manager":
        return { sql: `${clientExpr} IN (${MANAGER_CLIENTS})`, params: [user.id] };
      case "designer":
        return {
          sql: `(${m}.brand_id IN (${DESIGNER_BRANDS}) OR ${m}.created_by = ? OR ${m}.owner_id = ?)`,
          params: [user.id, user.id, user.id],
        };
      case "client":
        return { sql: `(${clientExpr} = ? AND ${clientMaterialFilter(m)})`, params: [user.client_id] };
      default:
        return { ...NONE };
    }
  },
};

// Convenience for id lists already loaded in memory.
export { inList };
