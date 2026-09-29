// History (docs/API.md "Visão geral, relatórios e histórico").
//   GET /api/activity          staff with activity.view: every row in scope
//                              (admin all, manager their clients, designer
//                              their projects/materials/own actions), with data.
//                              Downloads (download_events) are listed too, as
//                              actions download.file / download.zip (entity
//                              type 'download'); a download is never an approval.
//   GET /api/activity/facets   filter options that exist in that scope.
//   GET /api/portal/activity   client: only visibility 'client' rows of their client
//                              (downloads never appear here).
// Also exports activityScope(), the history source and serializeActivities()
// for the overviews.

import { Router } from "express";
import { assertBrand, assertClient, assertMaterial, assertProject, clientCanSeeMaterial, scopeSql } from "../lib/access.js";
import { logActivity } from "../lib/audit.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { can } from "../lib/permissions.js";
import { isStaff, serializeActivity } from "../lib/serialize.js";
import { paginate, parse, queryList, schemas, z } from "../lib/validate.js";
import { addDaysToDate, formatLocalDateTime, localDayStartIso, localToday, sendCsv } from "./reports.js";
import { validation } from "../lib/errors.js";

const MANAGER_CLIENTS = "SELECT client_id FROM staff_client_access WHERE user_id = ?";
const DESIGNER_PROJECTS = "SELECT project_id FROM project_members WHERE user_id = ?";

export const ACTIVITY_FROM = `FROM activity_log a
  LEFT JOIN users u ON u.id = a.actor_id
  LEFT JOIN clients cl ON cl.id = a.client_id
  LEFT JOIN brands br ON br.id = a.brand_id`;
export const ACTIVITY_COLUMNS = "a.*, u.name AS actor_name, cl.name AS client_name, br.name AS brand_name";

/**
 * activity_log rows the viewer may read, as { sql, params } for alias `a`.
 * admin: all · manager: rows of their clients · designer: rows of their
 * projects, of materials in those projects or owned/created by them, and
 * their own actions · client: visibility 'client' rows of their client.
 */
export function activityScope(req, alias = "a") {
  const user = req.user;
  switch (user?.role) {
    case "admin":
      return { sql: "1 = 1", params: [] };
    case "manager":
      return { sql: `${alias}.client_id IN (${MANAGER_CLIENTS})`, params: [user.id] };
    case "designer":
      return {
        sql: `(${alias}.project_id IN (${DESIGNER_PROJECTS})
          OR ${alias}.material_id IN (SELECT id FROM materials WHERE project_id IN (${DESIGNER_PROJECTS}) OR owner_id = ? OR created_by = ?)
          OR ${alias}.actor_id = ?)`,
        params: [user.id, user.id, user.id, user.id, user.id],
      };
    case "client":
      return { sql: `(${alias}.client_id = ? AND ${alias}.visibility = 'client')`, params: [user.client_id] };
    default:
      return { sql: "0 = 1", params: [] };
  }
}

// ---------------------------------------------------------- history source

// The staff history reads activity_log and download_events as one source
// (alias `a`, same columns as activity_log plus the dl_* download details),
// so both share filters, order, pagination, facets and the CSV.
// A ZIP's materials come from zip_jobs.entries, exactly like the material
// history (routes/materials.js); a ZIP that holds a single material is
// attributed to it (material_id), a multi-material ZIP only through entries.
const zipEntries = (zip) => `json_each(CASE WHEN json_valid(${zip}.entries) THEN ${zip}.entries ELSE '[]' END)`;
const ZIP_MATERIALS = (zipIdSql) =>
  `SELECT json_extract(je.value, '$.m') AS mid FROM zip_jobs zj, ${zipEntries("zj")} je WHERE zj.id = ${zipIdSql}`;

const LOG_ROWS = `SELECT 'log' AS src, l.id, l.actor_id, l.actor_role, l.action, l.entity_type, l.entity_id,
    l.client_id, l.brand_id, l.project_id, l.material_id, l.summary, l.data, l.visibility, l.created_at,
    NULL AS dl_kind, NULL AS dl_scope, NULL AS dl_file_id, NULL AS dl_zip_id, NULL AS dl_file_name,
    NULL AS dl_version, NULL AS dl_zip_label, NULL AS dl_zip_files, NULL AS dl_materials
  FROM activity_log l`;

// "<Nome> baixou “logo.svg” de “Logo principal” (versão 2)." /
// "<Nome> baixou o pacote ZIP “Kit de marca · Aurora”." — starts with the
// person's name like every other summary, and is what ?q= searches.
const DOWNLOAD_SUMMARY = `du.name || ' baixou ' ||
    CASE WHEN d.kind = 'zip'
      THEN CASE WHEN z.label IS NOT NULL AND z.label <> '' THEN 'o pacote ZIP “' || z.label || '”' ELSE 'um pacote ZIP' END
      ELSE CASE WHEN f.display_name IS NOT NULL THEN '“' || f.display_name || '”' ELSE 'um arquivo' END
           || COALESCE(' de “' || dm.title || '”', '')
    END || COALESCE(' (versão ' || dv.number || ')', '') || '.'`;

const DOWNLOAD_ROWS = `SELECT 'download' AS src, d.id, d.user_id AS actor_id, du.role AS actor_role,
    CASE d.kind WHEN 'zip' THEN 'download.zip' ELSE 'download.file' END AS action,
    'download' AS entity_type, d.id AS entity_id,
    COALESCE(d.client_id, CASE WHEN du.role = 'client' THEN du.client_id END) AS client_id,
    d.brand_id,
    COALESCE(dm.project_id, CASE WHEN json_valid(z.scope) THEN json_extract(z.scope, '$.projectId') END) AS project_id,
    d.mat_id AS material_id,
    ${DOWNLOAD_SUMMARY} AS summary,
    NULL AS data, 'internal' AS visibility, d.created_at,
    d.kind AS dl_kind, d.scope AS dl_scope, d.file_id AS dl_file_id, d.zip_job_id AS dl_zip_id,
    f.display_name AS dl_file_name, dv.number AS dl_version, z.label AS dl_zip_label, z.file_count AS dl_zip_files,
    d.mat_count AS dl_materials
  FROM (
    SELECT de.*,
      CASE WHEN de.material_id IS NOT NULL THEN de.material_id
           WHEN de.zip_job_id IS NOT NULL THEN (
             SELECT CASE WHEN COUNT(DISTINCT zm.mid) = 1 THEN MIN(zm.mid) END FROM (${ZIP_MATERIALS("de.zip_job_id")}) zm)
      END AS mat_id,
      CASE WHEN de.zip_job_id IS NOT NULL THEN (SELECT COUNT(DISTINCT zm.mid) FROM (${ZIP_MATERIALS("de.zip_job_id")}) zm) END AS mat_count
    FROM download_events de
  ) d
  JOIN users du ON du.id = d.user_id
  LEFT JOIN materials dm ON dm.id = d.mat_id
  LEFT JOIN material_files f ON f.id = d.file_id
  LEFT JOIN material_versions dv ON dv.id = d.version_id
  LEFT JOIN zip_jobs z ON z.id = d.zip_job_id`;

export const HISTORY_SOURCE = `(${LOG_ROWS} UNION ALL ${DOWNLOAD_ROWS})`;
export const HISTORY_FROM = `FROM ${HISTORY_SOURCE} a
  LEFT JOIN users u ON u.id = a.actor_id
  LEFT JOIN clients cl ON cl.id = a.client_id
  LEFT JOIN brands br ON br.id = a.brand_id`;

// A download row whose ZIP holds a material of `materialsSql` (a list or subquery).
const zipHolds = (materialsSql) =>
  `(a.dl_zip_id IS NOT NULL AND EXISTS (SELECT 1 FROM (${ZIP_MATERIALS("a.dl_zip_id")}) zh WHERE zh.mid IN (${materialsSql})))`;

/**
 * Rows of HISTORY_SOURCE (alias `a`) the viewer may read: activityScope()
 * plus, for designers, ZIPs that hold materials of their projects or their
 * own materials. Downloads are 'internal', so clients never match them.
 */
export function historyScope(req) {
  const base = activityScope(req);
  const user = req.user;
  if (user?.role !== "designer") return base;
  return {
    sql: `(${base.sql} OR ${zipHolds(`SELECT id FROM materials WHERE project_id IN (${DESIGNER_PROJECTS}) OR owner_id = ? OR created_by = ?`)})`,
    params: [...base.params, user.id, user.id, user.id],
  };
}

// download_events.scope: 'file' for single files, the ZIP job's scope JSON otherwise.
function downloadScopeType(scope) {
  if (!scope || scope === "file") return scope ?? null;
  try {
    return JSON.parse(scope)?.type ?? null;
  } catch {
    return String(scope);
  }
}

const SCOPE_LABEL = {
  file: "Arquivo individual",
  selection: "Seleção de arquivos",
  category: "Categoria inteira",
  brand_kit: "Kit de marca",
  carousel: "Carrossel completo",
  project: "Pacote final do projeto",
  kit: "Kit de entrega",
};
export const DOWNLOAD_NOTE = "Download — não equivale a aprovação.";

// What a download row records (shown under "Detalhes" in the history).
function downloadData(row) {
  const type = downloadScopeType(row.dl_scope);
  const zip = row.dl_kind === "zip";
  const data = { scope: SCOPE_LABEL[type] ?? (zip ? "Pacote ZIP" : "Arquivo") };
  if (zip) {
    data.package = row.dl_zip_label ?? null;
    if (row.dl_zip_files !== null && row.dl_zip_files !== undefined) data.files = Number(row.dl_zip_files);
    if (row.dl_materials !== null && row.dl_materials !== undefined) data.materials = Number(row.dl_materials);
    data.zipJobId = row.dl_zip_id ?? null;
  } else {
    data.file = row.dl_file_name ?? null;
    if (row.dl_version !== null && row.dl_version !== undefined) data.version = Number(row.dl_version);
    data.fileId = row.dl_file_id ?? null;
  }
  data.approval = false;
  return data;
}

// ------------------------------------------------------------------ links

const materialIdOf = (row) => row.material_id || (row.entity_type === "material" ? row.entity_id : null);

function staffLink(user, row, material) {
  if (material) {
    if (material.kind === "post" && can(user, "content.view")) return { to: `/admin/conteudo/${material.id}`, label: "Abrir publicação" };
    if (can(user, "materials.view")) return { to: `/admin/biblioteca/${material.id}`, label: "Abrir material" };
  }
  const id = row.entity_id;
  switch (row.entity_type) {
    case "download": {
      const type = downloadScopeType(row.dl_scope);
      if (type === "brand_kit" && row.brand_id && can(user, "materials.view")) return { to: `/admin/marcas/${row.brand_id}`, label: "Abrir identidade" };
      if (type === "kit" && can(user, "materials.view")) return { to: "/admin/kits", label: "Abrir kits" };
      break;
    }
    case "project":
      if (id && can(user, "projects.view")) return { to: `/admin/projetos/${id}`, label: "Abrir projeto" };
      break;
    case "task":
      if (row.project_id && can(user, "projects.view")) return { to: `/admin/projetos/${row.project_id}`, label: "Abrir projeto" };
      break;
    case "briefing":
      if (id && can(user, "briefings.view")) return { to: `/admin/briefings/${id}`, label: "Abrir briefing" };
      break;
    case "client":
      if (id && can(user, "clients.view")) return { to: `/admin/clientes/${id}`, label: "Abrir cliente" };
      break;
    case "brand":
      if (row.client_id && can(user, "clients.view")) return { to: `/admin/clientes/${row.client_id}`, label: "Abrir cliente" };
      break;
    case "color":
    case "font":
    case "identity":
      if (row.brand_id && can(user, "materials.view")) return { to: `/admin/marcas/${row.brand_id}`, label: "Abrir identidade" };
      break;
    case "kit":
      if (can(user, "materials.view")) return { to: "/admin/kits", label: "Abrir kits" };
      break;
    case "release":
      if (can(user, "materials.view")) return { to: "/admin/biblioteca", label: "Abrir biblioteca" };
      break;
    case "campaign":
    case "post":
      if (can(user, "content.view")) return { to: "/admin/conteudo", label: "Abrir conteúdo" };
      break;
    case "order":
    case "subscription":
    case "payment":
      if (can(user, "orders.view")) return { to: "/admin/pedidos", label: "Abrir pedidos" };
      break;
    case "service":
      if (can(user, "services.view")) return { to: "/admin/planos", label: "Abrir planos" };
      break;
    case "user":
      if (row.actor_role === "client" || (row.client_id && row.visibility === "client")) {
        if (row.client_id && can(user, "clients.view")) return { to: `/admin/clientes/${row.client_id}`, label: "Abrir cliente" };
      } else if (can(user, "team.view")) return { to: "/admin/equipe", label: "Abrir equipe" };
      break;
    case "category":
    case "setting":
    case "settings":
      if (can(user, "settings.manage") || can(user, "categories.manage")) return { to: "/admin/configuracoes", label: "Abrir configurações" };
      break;
    case "report":
      if (can(user, "reports.view") || can(user, "reports.finance")) return { to: "/admin/relatorios", label: "Abrir relatórios" };
      break;
    default:
      break;
  }
  if (row.project_id && can(user, "projects.view")) return { to: `/admin/projetos/${row.project_id}`, label: "Abrir projeto" };
  return null;
}

function clientLink(row, material) {
  // a material the client can no longer open (archived, withdrawn) gets no link
  if (!material && materialIdOf(row)) return null;
  if (material)
    return material.kind === "post"
      ? { to: `/painel/conteudo/${material.id}`, label: "Ver publicação" }
      : { to: `/painel/arquivos?material=${encodeURIComponent(material.id)}`, label: "Ver material" };
  switch (row.entity_type) {
    case "briefing":
      return row.entity_id ? { to: `/painel/briefings/${row.entity_id}`, label: "Abrir briefing" } : null;
    case "order":
    case "payment":
    case "subscription":
      return { to: "/painel/financeiro", label: "Ver financeiro" };
    case "project":
      return { to: "/painel/projetos", label: "Ver projetos" };
    case "kit":
    case "release":
      return { to: "/painel/arquivos", label: "Ver arquivos" };
    case "brand":
    case "color":
    case "font":
    case "identity":
      return { to: "/painel/marca", label: "Ver minha marca" };
    default:
      return null;
  }
}

/**
 * Activity[] with two extras: material {id, title, kind} (only when the
 * viewer can still open it) and link/linkLabel (an app path the viewer can
 * open, or null). Rows must come from ACTIVITY_COLUMNS/ACTIVITY_FROM.
 */
export function serializeActivities(req, rows) {
  const db = req.ctx.db;
  const staff = isStaff(req);
  const ids = [...new Set(rows.map(materialIdOf).filter(Boolean))];
  const materials = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    for (const row of db.all(
      `SELECT m.id, m.title, m.kind, m.visibility, m.archived_at, m.released_version_id, b.client_id
         FROM materials m JOIN brands b ON b.id = m.brand_id WHERE m.id IN (${chunk.map(() => "?").join(", ")})`,
      chunk,
    ))
      materials.set(row.id, row);
  }
  return rows.map((row) => {
    const item = serializeActivity(req, row);
    const found = materials.get(materialIdOf(row));
    const material = found && (staff || clientCanSeeMaterial(req.user, found)) ? found : null;
    item.material = material ? { id: material.id, title: material.title, kind: material.kind } : null;
    if (!staff) item.materialId = material ? material.id : null;
    const link = staff ? staffLink(req.user, row, material) : clientLink(row, material);
    item.link = link?.to ?? null;
    item.linkLabel = link?.label ?? null;
    // Downloads only ever reach staff (they are 'internal' rows).
    if (row.src === "download" && staff) {
      item.data = downloadData(row);
      item.isApproval = false;
      item.note = DOWNLOAD_NOTE;
    }
    return item;
  });
}

// ---------------------------------------------------------------- filters

const opt = (schema) => z.preprocess((value) => (value === "" || value === null ? undefined : value), schema.optional());
const idParam = opt(z.string().max(64));
const listParam = opt(z.union([z.string().max(2000), z.array(z.string().max(120)).max(50)]));

const activityQuery = z.object({
  clientId: idParam,
  brandId: idParam,
  projectId: idParam,
  materialId: idParam,
  actorId: idParam,
  action: listParam,
  entityType: listParam,
  visibility: opt(z.enum(["client", "internal"])),
  q: opt(z.string().trim().max(120)),
  from: opt(schemas.date),
  to: opt(schemas.date),
  format: opt(z.enum(["json", "csv"])),
});

const escapeLike = (text) => String(text).replace(/[\\%_]/g, (c) => `\\${c}`);

// action accepts exact names ("material.created") and prefixes ("material.*").
function actionFilter(values) {
  const parts = [];
  const params = [];
  for (const value of values.slice(0, 40)) {
    if (value.endsWith(".*")) {
      parts.push("a.action LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(value.slice(0, -2))}.%`);
    } else {
      parts.push("a.action = ?");
      params.push(value);
    }
  }
  return parts.length ? { sql: `(${parts.join(" OR ")})`, params } : null;
}

function dateFilters(q, where, params) {
  if (q.from && q.to && q.from > q.to) throw validation({ from: "A data inicial precisa ser anterior à data final." });
  if (q.from) {
    where.push("a.created_at >= ?");
    params.push(localDayStartIso(q.from));
  }
  if (q.to) {
    where.push("a.created_at < ?");
    params.push(localDayStartIso(addDaysToDate(q.to, 1)));
  }
}

function staffWhere(req, q) {
  const scope = historyScope(req);
  const where = [scope.sql];
  const params = [...scope.params];
  const add = (sql, ...values) => {
    where.push(sql);
    params.push(...values);
  };
  if (q.clientId) {
    assertClient(req, q.clientId);
    add("a.client_id = ?", q.clientId);
  }
  if (q.brandId) {
    assertBrand(req, q.brandId);
    add("a.brand_id = ?", q.brandId);
  }
  if (q.projectId) {
    assertProject(req, q.projectId);
    add(`(a.project_id = ? OR ${zipHolds("SELECT id FROM materials WHERE project_id = ?")})`, q.projectId, q.projectId);
  }
  if (q.materialId) {
    assertMaterial(req, q.materialId);
    add(`(a.material_id = ? OR (a.entity_type = 'material' AND a.entity_id = ?) OR ${zipHolds("?")})`, q.materialId, q.materialId, q.materialId);
  }
  if (q.actorId) add("a.actor_id = ?", q.actorId);
  const actions = actionFilter(queryList(q.action));
  if (actions) add(actions.sql, ...actions.params);
  const types = queryList(q.entityType).slice(0, 40);
  if (types.length) add(`a.entity_type IN (${types.map(() => "?").join(", ")})`, ...types);
  if (q.visibility) add("a.visibility = ?", q.visibility);
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    add(
      "(a.summary LIKE ? ESCAPE '\\' OR IFNULL(u.name, '') LIKE ? ESCAPE '\\' OR IFNULL(cl.name, '') LIKE ? ESCAPE '\\' OR IFNULL(br.name, '') LIKE ? ESCAPE '\\')",
      like,
      like,
      like,
      like,
    );
  }
  dateFilters(q, where, params);
  return { sql: where.join(" AND "), params };
}

const VISIBILITY_LABEL = { client: "Visível ao cliente", internal: "Interno" };
const ROLE_LABEL = { admin: "Administrador", manager: "Gestor", designer: "Designer/editor", finance: "Financeiro", client: "Cliente" };
const CSV_LIMIT = 20000;

// -------------------------------------------------------------- handlers

export default function activityRoutes() {
  const router = Router();

  router.get("/api/activity", requireAuth, requireCap("activity.view"), (req, res) => {
    const db = req.ctx.db;
    const q = parse(activityQuery, req.query);
    const { sql, params } = staffWhere(req, q);

    if (q.format === "csv") {
      const rows = db.all(`SELECT ${ACTIVITY_COLUMNS} ${HISTORY_FROM} WHERE ${sql} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`, [
        ...params,
        CSV_LIMIT,
      ]);
      logActivity(req, {
        action: "activity.exported",
        entityType: "report",
        entityId: "activity",
        clientId: q.clientId ?? null,
        brandId: q.brandId ?? null,
        summary: `${req.user.name} exportou ${rows.length} registro${rows.length === 1 ? "" : "s"} do histórico em CSV.`,
        data: { filters: Object.fromEntries(Object.entries(q).filter(([key, value]) => key !== "format" && value !== undefined)), rows: rows.length },
      });
      const stamp = localToday();
      return sendCsv(
        res,
        `metta-historico-${stamp}.csv`,
        ["Data", "Pessoa", "Perfil", "Ação", "Resumo", "Cliente", "Marca", "Tipo de registro", "Identificador", "Visibilidade"],
        rows.map((row) => [
          formatLocalDateTime(row.created_at),
          row.actor_id ? (row.actor_name ?? "Usuário removido") : "Sistema",
          ROLE_LABEL[row.actor_role] ?? "",
          row.action,
          row.src === "download" ? `${row.summary} ${DOWNLOAD_NOTE}` : row.summary,
          row.client_name ?? "",
          row.brand_name ?? "",
          row.entity_type,
          row.entity_id ?? "",
          VISIBILITY_LABEL[row.visibility] ?? row.visibility,
        ]),
      );
    }

    const { page, pageSize, limit, offset } = paginate(req.query, { defaultSize: 50, max: 200 });
    const total = db.get(`SELECT COUNT(*) AS n ${HISTORY_FROM} WHERE ${sql}`, params).n;
    const rows = db.all(`SELECT ${ACTIVITY_COLUMNS} ${HISTORY_FROM} WHERE ${sql} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    res.json({ items: serializeActivities(req, rows), total, page, pageSize, hasMore: offset + rows.length < total });
  });

  // What exists in the viewer's history, so filters never offer empty choices.
  router.get("/api/activity/facets", requireAuth, requireCap("activity.view"), (req, res) => {
    const db = req.ctx.db;
    const scope = historyScope(req);
    const clients = scopeSql.clients(req, "c");
    const brands = scopeSql.brands(req, "b");
    const projects = scopeSql.projects(req, "p");
    res.json({
      actions: db
        .all(`SELECT a.action, COUNT(*) AS n FROM ${HISTORY_SOURCE} a WHERE ${scope.sql} GROUP BY a.action ORDER BY a.action`, scope.params)
        .map((row) => ({ action: row.action, count: row.n })),
      entityTypes: db
        .all(`SELECT a.entity_type, COUNT(*) AS n FROM ${HISTORY_SOURCE} a WHERE ${scope.sql} GROUP BY a.entity_type ORDER BY a.entity_type`, scope.params)
        .map((row) => ({ entityType: row.entity_type, count: row.n })),
      actors: db
        .all(
          `SELECT u.id, u.name, u.role, COUNT(*) AS n FROM ${HISTORY_SOURCE} a JOIN users u ON u.id = a.actor_id
            WHERE ${scope.sql} GROUP BY u.id ORDER BY u.name COLLATE NOCASE LIMIT 500`,
          scope.params,
        )
        .map((row) => ({ id: row.id, name: row.name, role: row.role, count: row.n })),
      clients: db
        .all(`SELECT c.id, c.name FROM clients c WHERE ${clients.sql} ORDER BY c.name COLLATE NOCASE`, clients.params)
        .map((row) => ({ id: row.id, name: row.name })),
      brands: db
        .all(`SELECT b.id, b.name, b.client_id FROM brands b WHERE ${brands.sql} ORDER BY b.name COLLATE NOCASE`, brands.params)
        .map((row) => ({ id: row.id, name: row.name, clientId: row.client_id })),
      projects: db
        .all(
          `SELECT p.id, p.name, p.brand_id, p.status FROM projects p WHERE ${projects.sql}
            ORDER BY p.status = 'archived', p.name COLLATE NOCASE LIMIT 1000`,
          projects.params,
        )
        .map((row) => ({ id: row.id, name: row.name, brandId: row.brand_id, status: row.status })),
    });
  });

  // Client timeline: only rows marked visible to the client, of their own account.
  const portalQuery = z.object({
    brandId: idParam,
    entityType: listParam,
    from: opt(schemas.date),
    to: opt(schemas.date),
  });
  router.get("/api/portal/activity", requireAuth, requireCap("portal.access"), (req, res) => {
    const db = req.ctx.db;
    const q = parse(portalQuery, req.query);
    const scope = activityScope(req);
    const where = [scope.sql];
    const params = [...scope.params];
    if (q.brandId) {
      assertBrand(req, q.brandId);
      where.push("(a.brand_id = ? OR a.brand_id IS NULL)");
      params.push(q.brandId);
    }
    const types = queryList(q.entityType).slice(0, 40);
    if (types.length) {
      where.push(`a.entity_type IN (${types.map(() => "?").join(", ")})`);
      params.push(...types);
    }
    dateFilters(q, where, params);
    const { page, pageSize, limit, offset } = paginate(req.query, { defaultSize: 30, max: 100 });
    const whereSql = where.join(" AND ");
    const total = db.get(`SELECT COUNT(*) AS n ${ACTIVITY_FROM} WHERE ${whereSql}`, params).n;
    const rows = db.all(`SELECT ${ACTIVITY_COLUMNS} ${ACTIVITY_FROM} WHERE ${whereSql} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    res.json({ items: serializeActivities(req, rows), total, page, pageSize, hasMore: offset + rows.length < total });
  });

  return router;
}
