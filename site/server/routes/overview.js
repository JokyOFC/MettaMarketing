// Overviews (docs/API.md "Visão geral, relatórios e histórico").
//   GET /api/admin/overview   staff: real counts and lists inside the caller's
//                             scope; each block is null when the role cannot see it.
//   GET /api/portal/overview  client: their brands only (optional ?brandId).

import { Router } from "express";
import { assertBrand, clientMaterialFilter, scopeSql } from "../lib/access.js";
import { requireAuth, requireCap, requireStaff } from "../lib/auth.js";
import { can } from "../lib/permissions.js";
import { parseJson } from "../lib/serialize.js";
import { parse, z } from "../lib/validate.js";
import { MATERIAL_SELECT, serializeMaterials } from "../services/materials.js";
import { ACTIVITY_COLUMNS, ACTIVITY_FROM, HISTORY_FROM, activityScope, historyScope, serializeActivities } from "./activity.js";
import { addDaysToDate, localToday } from "./reports.js";

const HORIZON_DAYS = 14;
const RECENT_ACTIVITY_LIMIT = 8;
// Orders still owed (routes/commerce.js OPEN): awaiting payment or failed.
const OPEN_ORDER_SQL = "'pending_payment', 'failed'";
const DESIGNER_PROJECTS = "SELECT project_id FROM project_members WHERE user_id = ?";

// Materials the viewer is responsible for. Designers read their brands'
// whole library, but their pendencies are their projects and own materials.
function workScope(req) {
  const user = req.user;
  if (user.role === "designer")
    return {
      sql: `(m.project_id IN (${DESIGNER_PROJECTS}) OR m.owner_id = ? OR m.created_by = ?)`,
      params: [user.id, user.id, user.id],
    };
  return scopeSql.materials(req, "m", "b");
}

const count = async (db, sql, params) => (await db.get(sql, params)).n;
const person = (id, name, role) => (id ? { id, name: name ?? "Usuário removido", role: role ?? null } : null);

// A released version the client approved, or that needs no approval, is the
// finished deliverable (e.g. originals delivered with the release).
const ART_DONE = "(m.visibility = 'released' AND m.approval_status IN ('approved', 'none'))";
// Date that matters for each material: its deadline; posts without one use
// their planned publication date (post_details.planned_date).
const TARGET_DATE = "COALESCE(m.due_date, pd.planned_date)";

/**
 * Work due up to `horizon` (overdue included) that still needs someone:
 * - materials and posts until they are delivered, or released and approved
 *   / without approval — still listed while drafting, in internal review,
 *   awaiting the client's decision or with changes requested. Posts count
 *   by deadline or, without one, by planned publication date, and leave the
 *   list once published (publishing itself is tracked in Conteúdo);
 * - projects with a deadline that are not delivered.
 */
async function upcomingDeliveries(req, today, horizon) {
  const db = req.ctx.db;
  const scope = workScope(req);
  const materialRows = await db.all(
    `SELECT m.id, m.kind, m.title, m.due_date, m.visibility, m.approval_status, ${TARGET_DATE} AS target_date,
            pd.planned_date, pd.planned_time, pd.publication_status,
            b.id AS brand_id, b.name AS brand_name, cl.id AS client_id, cl.name AS client_name,
            p.id AS project_id, p.name AS project_name, o.id AS owner_id, o.name AS owner_name, o.role AS owner_role
       FROM materials m
       JOIN brands b ON b.id = m.brand_id
       JOIN clients cl ON cl.id = b.client_id
       LEFT JOIN post_details pd ON pd.material_id = m.id AND m.kind = 'post'
       LEFT JOIN projects p ON p.id = m.project_id
       LEFT JOIN users o ON o.id = m.owner_id
      WHERE m.delivered_at IS NULL AND m.archived_at IS NULL AND ${scope.sql}
        AND ${TARGET_DATE} IS NOT NULL AND ${TARGET_DATE} <= ?
        AND NOT ${ART_DONE}
        AND IFNULL(pd.publication_status, '') <> 'published'
      ORDER BY target_date, m.title COLLATE utf8mb4_0900_ai_ci`,
    [...scope.params, horizon],
  );
  const projectScope = scopeSql.projects(req, "p");
  const projectRows = await db.all(
    `SELECT p.id, p.name, p.status, p.due_date, b.id AS brand_id, b.name AS brand_name, cl.id AS client_id, cl.name AS client_name,
            (SELECT u.id FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = p.id
              ORDER BY pm.role = 'lead' DESC, pm.added_at LIMIT 1) AS owner_id
       FROM projects p
       JOIN brands b ON b.id = p.brand_id
       JOIN clients cl ON cl.id = b.client_id
      WHERE p.due_date IS NOT NULL AND p.due_date <= ? AND p.delivered_at IS NULL
        AND p.status NOT IN ('delivered', 'archived') AND ${projectScope.sql}
      ORDER BY p.due_date, p.name COLLATE utf8mb4_0900_ai_ci`,
    [horizon, ...projectScope.params],
  );
  const owners = new Map();
  for (const row of projectRows)
    if (row.owner_id && !owners.has(row.owner_id))
      owners.set(row.owner_id, await db.get("SELECT id, name, role FROM users WHERE id = ?", [row.owner_id]));

  const items = [
    ...materialRows.map((row) => {
      const isPost = row.kind === "post";
      // which date dueDate is: the deadline or the planned publication
      const dateKind = isPost && !row.due_date ? "planned" : "due";
      return {
        type: isPost ? "post" : "material",
        id: row.id,
        kind: row.kind,
        title: row.title,
        dueDate: row.target_date,
        dateKind,
        overdue: row.target_date < today,
        status: {
          visibility: row.visibility,
          approval: row.approval_status,
          ...(isPost ? { publication: row.publication_status ?? "not_scheduled" } : {}),
        },
        post: isPost ? { plannedDate: row.planned_date ?? null, plannedTime: row.planned_time ?? null } : null,
        client: { id: row.client_id, name: row.client_name },
        brand: { id: row.brand_id, name: row.brand_name },
        project: row.project_id ? { id: row.project_id, name: row.project_name } : null,
        owner: person(row.owner_id, row.owner_name, row.owner_role),
        link: isPost && can(req.user, "content.view") ? `/admin/conteudo/${row.id}` : `/admin/biblioteca/${row.id}`,
      };
    }),
    ...projectRows.map((row) => {
      const owner = row.owner_id ? owners.get(row.owner_id) : null;
      return {
        type: "project",
        id: row.id,
        kind: null,
        title: row.name,
        dueDate: row.due_date,
        dateKind: "due",
        overdue: row.due_date < today,
        status: { project: row.status },
        post: null,
        client: { id: row.client_id, name: row.client_name },
        brand: { id: row.brand_id, name: row.brand_name },
        project: { id: row.id, name: row.name },
        owner: owner ? person(owner.id, owner.name, owner.role) : null,
        link: `/admin/projetos/${row.id}`,
      };
    }),
  ].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (a.type === b.type ? 0 : a.type === "project" ? -1 : 1) || a.title.localeCompare(b.title, "pt-BR"));

  const upcoming = items.filter((item) => !item.overdue);
  const overdue = items.filter((item) => item.overdue);
  return {
    count: upcoming.length,
    overdueCount: overdue.length,
    // overdue first (they need attention), then the next 14 days
    items: [...overdue.slice(0, 6), ...upcoming].slice(0, 12),
  };
}

async function myTasks(req, today) {
  const db = req.ctx.db;
  const rows = await db.all(
    `SELECT t.id, t.title, t.status, t.due_date, t.material_id, p.id AS project_id, p.name AS project_name,
            b.id AS brand_id, b.name AS brand_name, cl.id AS client_id, cl.name AS client_name
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       JOIN brands b ON b.id = p.brand_id
       JOIN clients cl ON cl.id = b.client_id
      WHERE t.assignee_id = ? AND t.status <> 'done'
      ORDER BY t.due_date IS NULL, t.due_date, t.sort_order, t.created_at`,
    [req.user.id],
  );
  return {
    total: rows.length,
    items: rows.slice(0, 12).map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      dueDate: row.due_date ?? null,
      overdue: Boolean(row.due_date && row.due_date < today),
      materialId: row.material_id ?? null,
      project: { id: row.project_id, name: row.project_name },
      brand: { id: row.brand_id, name: row.brand_name },
      client: { id: row.client_id, name: row.client_name },
      link: `/admin/projetos/${row.project_id}`,
    })),
  };
}

async function adminOverview(req) {
  const db = req.ctx.db;
  const user = req.user;
  const today = localToday();
  const horizon = addDaysToDate(today, HORIZON_DAYS);
  const seesMaterials = can(user, "materials.view");
  const out = {
    today,
    horizonDays: HORIZON_DAYS,
    role: user.role,
    projectsInProgress: null,
    upcomingDeliveries: null,
    upcomingCount: null,
    overdueCount: null,
    pendingApprovals: null,
    changesRequested: null,
    awaitingRelease: null,
    briefingsAwaiting: null,
    paymentsPending: null,
    paymentsPendingCents: null,
    paymentsFailed: null,
    activeSubscriptions: null,
    activeSubscriptionsCents: null,
    recentActivity: null,
    myTasks: null,
    myTasksTotal: null,
  };

  if (can(user, "projects.view")) {
    const scope = scopeSql.projects(req, "p");
    out.projectsInProgress = await count(db, `SELECT COUNT(*) AS n FROM projects p WHERE p.status = 'in_progress' AND ${scope.sql}`, scope.params);
  }
  if (seesMaterials || can(user, "projects.view")) {
    const deliveries = await upcomingDeliveries(req, today, horizon);
    out.upcomingDeliveries = deliveries.items;
    out.upcomingCount = deliveries.count;
    out.overdueCount = deliveries.overdueCount;
  }
  if (seesMaterials) {
    const scope = workScope(req);
    const approvals = await db.get(
      `SELECT SUM(m.approval_status = 'pending') AS pending, SUM(m.approval_status = 'changes_requested') AS changes
         FROM materials m JOIN brands b ON b.id = m.brand_id
        WHERE m.visibility = 'released' AND m.archived_at IS NULL AND ${scope.sql}`,
      scope.params,
    );
    out.pendingApprovals = approvals.pending ?? 0;
    out.changesRequested = approvals.changes ?? 0;
    if (can(user, "materials.release"))
      out.awaitingRelease = await count(
        db,
        `SELECT COUNT(*) AS n FROM materials m JOIN brands b ON b.id = m.brand_id
           LEFT JOIN material_versions cv ON cv.id = m.current_version_id
          WHERE m.archived_at IS NULL AND (m.visibility = 'internal_review' OR cv.status = 'internal_review') AND ${scope.sql}`,
        scope.params,
      );
  }
  if (can(user, "briefings.view")) {
    const scope = scopeSql.brands(req, "b");
    out.briefingsAwaiting = await count(
      db,
      `SELECT COUNT(*) AS n FROM briefings bf JOIN brands b ON b.id = bf.brand_id
        WHERE bf.status IN ('awaiting_client', 'in_progress') AND ${scope.sql}`,
      scope.params,
    );
  }
  if (can(user, "finance.view")) {
    const scope = scopeSql.clients(req, "cl");
    // Open = still owed: awaiting payment or rejected by Mercado Pago (the
    // client can try again), the same set commerce treats as receivable.
    const orders = await db.get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(o.amount_cents), 0) AS cents, COALESCE(SUM(o.status = 'failed'), 0) AS failed
         FROM orders o JOIN clients cl ON cl.id = o.client_id
        WHERE o.status IN (${OPEN_ORDER_SQL}) AND ${scope.sql}`,
      scope.params,
    );
    const subs = await db.get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(s.amount_cents), 0) AS cents FROM subscriptions s JOIN clients cl ON cl.id = s.client_id
        WHERE s.status = 'active' AND ${scope.sql}`,
      scope.params,
    );
    out.paymentsPending = orders.n;
    out.paymentsPendingCents = orders.cents;
    out.paymentsFailed = orders.failed;
    out.activeSubscriptions = subs.n;
    out.activeSubscriptionsCents = subs.cents;
  }
  if (can(user, "activity.view")) {
    // Same source as the Histórico; of the downloads, only the clients' ones
    // (the team's own downloads are working noise here, still in the history).
    const scope = historyScope(req);
    const rows = await db.all(
      `SELECT ${ACTIVITY_COLUMNS} ${HISTORY_FROM} WHERE ${scope.sql} AND (a.src = 'log' OR a.actor_role = 'client')
        ORDER BY a.created_at DESC, a.id DESC LIMIT ${RECENT_ACTIVITY_LIMIT}`,
      scope.params,
    );
    out.recentActivity = await serializeActivities(req, rows);
  }
  if (can(user, "tasks.manage") || user.role === "designer") {
    const tasks = await myTasks(req, today);
    out.myTasks = tasks.items;
    out.myTasksTotal = tasks.total;
  }
  return out;
}

// ------------------------------------------------------------------ portal

const portalQuery = z.object({
  brandId: z.preprocess((value) => (value === "" ? undefined : value), z.string().max(64).optional()),
});

function answered(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return String(value).trim() !== "";
}

async function portalOverview(req, brandId) {
  const db = req.ctx.db;
  const user = req.user;
  const today = localToday();
  const brands = (await db
    .all("SELECT id, name, slug, client_id FROM brands WHERE client_id = ? AND status = 'active' ORDER BY name COLLATE utf8mb4_0900_ai_ci", [user.client_id]))
    .map((row) => ({ id: row.id, name: row.name, slug: row.slug, clientId: row.client_id }));

  // Materials the client can see (released, not archived), optionally one brand.
  const base = [`b.client_id = ?`, clientMaterialFilter("m")];
  const baseParams = [user.client_id];
  if (brandId) {
    base.push("m.brand_id = ?");
    baseParams.push(brandId);
  }
  const RELEASED_AT = "(SELECT released_at FROM material_versions WHERE id = m.released_version_id)";
  const materials = async (extra, order, limit, extraParams = []) =>
    await serializeMaterials(
      req,
      await db.all(`${MATERIAL_SELECT} WHERE ${[...base, ...extra].join(" AND ")} ORDER BY ${order} LIMIT ?`, [...baseParams, ...extraParams, limit]),
    );
  const countWhere = async (extra, extraParams = []) =>
    await count(
      db,
      `SELECT COUNT(*) AS n FROM materials m JOIN brands b ON b.id = m.brand_id LEFT JOIN post_details pd ON pd.material_id = m.id
        WHERE ${[...base, ...extra].join(" AND ")}`,
      [...baseParams, ...extraParams],
    );

  const pendingApprovals = await materials(["m.approval_status = 'pending'"], `${RELEASED_AT} DESC, m.id`, 8);
  const recentReleases = await materials(["m.approval_status <> 'pending'"], `${RELEASED_AT} DESC, m.id`, 8);
  const upcoming = await materials(["m.kind = 'post'", "pd.planned_date >= ?"], "pd.planned_date, pd.planned_time, m.id", 6, [today]);

  const briefingWhere = ["b.client_id = ?", "bf.status IN ('awaiting_client', 'in_progress')"];
  const briefingParams = [user.client_id];
  if (brandId) {
    briefingWhere.push("bf.brand_id = ?");
    briefingParams.push(brandId);
  }
  const briefingRows = await db.all(
    `SELECT bf.id, bf.title, bf.status, bf.due_date, bf.sent_at, bf.questions, bf.answers, bf.updated_at, b.id AS brand_id, b.name AS brand_name
       FROM briefings bf JOIN brands b ON b.id = bf.brand_id
      WHERE ${briefingWhere.join(" AND ")}
      ORDER BY bf.due_date IS NULL, bf.due_date, bf.sent_at DESC`,
    briefingParams,
  );
  const briefingsToFill = briefingRows.map((row) => {
    const questions = parseJson(row.questions, []);
    const answers = parseJson(row.answers, {});
    const list = Array.isArray(questions) ? questions : [];
    const isAnswered = (question) => answered(answers?.[question?.id]);
    const required = list.filter((question) => question?.required);
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      dueDate: row.due_date ?? null,
      overdue: Boolean(row.due_date && row.due_date < today),
      sentAt: row.sent_at ?? null,
      brand: { id: row.brand_id, name: row.brand_name },
      questionCount: list.length,
      answeredCount: list.filter(isAnswered).length,
      requiredCount: required.length,
      requiredAnswered: required.filter(isAnswered).length,
    };
  });

  // Open orders: awaiting payment or rejected (still owed, "Tentar de novo").
  const billing = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents, MIN(due_date) AS next_due,
            COALESCE(SUM(status = 'failed'), 0) AS failed, COALESCE(SUM(CASE WHEN status = 'failed' THEN amount_cents END), 0) AS failed_cents
       FROM orders WHERE client_id = ? AND status IN (${OPEN_ORDER_SQL})`,
    [user.client_id],
  );

  const scope = activityScope(req);
  const activityWhere = [scope.sql];
  const activityParams = [...scope.params];
  if (brandId) {
    activityWhere.push("(a.brand_id = ? OR a.brand_id IS NULL)");
    activityParams.push(brandId);
  }
  const activityRows = await db.all(
    `SELECT ${ACTIVITY_COLUMNS} ${ACTIVITY_FROM} WHERE ${activityWhere.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT 8`,
    activityParams,
  );

  return {
    today,
    brands,
    brand: brandId ? (brands.find((brand) => brand.id === brandId) ?? null) : null,
    pendingApprovals,
    recentReleases,
    briefingsToFill: briefingsToFill.slice(0, 6),
    upcoming,
    billing: {
      pendingOrders: billing.n,
      pendingAmountCents: billing.cents,
      nextDueDate: billing.next_due ?? null,
      failedOrders: billing.failed,
      failedAmountCents: billing.failed_cents,
    },
    // Contracts waiting for this client's signature (AssinaVelox).
    contracts: {
      awaitingSignature: (await db.get(
        "SELECT COUNT(*) AS n FROM contracts WHERE client_id = ? AND status = 'sent' AND COALESCE(client_status, 'pending') IN ('pending', 'notified', 'viewed')",
        [user.client_id],
      )).n,
    },
    recentActivity: await serializeActivities(req, activityRows),
    totals: {
      released: await countWhere([]),
      pendingApprovals: await countWhere(["m.approval_status = 'pending'"]),
      changesRequested: await countWhere(["m.approval_status = 'changes_requested'"]),
      approved: await countWhere(["m.approval_status = 'approved'"]),
      briefingsToFill: briefingsToFill.length,
      upcoming: await countWhere(["m.kind = 'post'", "pd.planned_date >= ?"], [today]),
      activity: await count(db, `SELECT COUNT(*) AS n FROM activity_log a WHERE ${scope.sql}`, scope.params),
    },
  };
}

export default function overviewRoutes() {
  const router = Router();

  router.get("/api/admin/overview", requireAuth, requireStaff, async (req, res) => {
    res.json(await adminOverview(req));
  });

  router.get("/api/portal/overview", requireAuth, requireCap("portal.access"), async (req, res) => {
    const { brandId } = parse(portalQuery, req.query);
    if (brandId) await assertBrand(req, brandId);
    res.json(await portalOverview(req, brandId ?? null));
  });

  return router;
}
