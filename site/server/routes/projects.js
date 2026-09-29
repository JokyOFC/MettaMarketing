// Projects, members and tasks (staff), plus the client's project list
// (/api/portal/projects). Scope comes from lib/access.js: managers see the
// projects of their clients, designers only the projects they belong to,
// finance none; clients only their own brands and released deliveries.
import { Router } from "express";
import { assertBrand, assertProject, clientMaterialFilter, scopeSql } from "../lib/access.js";
import { ACTIVITY_SELECT, logActivity } from "../lib/audit.js";
import { requireCap } from "../lib/auth.js";
import { forbidden, notFound, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { notify } from "../lib/notify.js";
import { can } from "../lib/permissions.js";
import { bool, serializeActivity, userRef } from "../lib/serialize.js";
import { now } from "../lib/time.js";
import { parse, queryBool, queryList, schemas, z } from "../lib/validate.js";
import { listMaterials } from "../services/materials.js";

export const PROJECT_STATUSES = ["planning", "in_progress", "in_review", "delivered", "paused", "archived"];
export const TASK_STATUSES = ["todo", "doing", "review", "done"];
const MEMBER_ROLES = ["lead", "designer", "editor"];

const PROJECT_LABELS = {
  planning: "Planejamento",
  in_progress: "Em andamento",
  in_review: "Em revisão",
  delivered: "Entregue",
  paused: "Pausado",
  archived: "Arquivado",
};
const TASK_LABELS = { todo: "A fazer", doing: "Em andamento", review: "Em revisão", done: "Concluído" };

const placeholders = (list) => list.map(() => "?").join(", ");
const escapeLike = (text) => String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
const brDate = (value) => (value ? value.split("-").reverse().join("/") : null);

// Runs `... IN (?)` with the list expanded (lists here are small).
function allIn(db, sql, ids, extra = []) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  return db.all(sql.replace("(?)", `(${placeholders(unique)})`), [...unique, ...extra]);
}

// ------------------------------------------------------------------ serialization

const PROJECT_SELECT = `SELECT p.*, b.name AS brand_name, b.slug AS brand_slug, b.client_id AS client_id,
  c.name AS client_name, s.name AS service_name, s.kind AS service_kind
  FROM projects p
  JOIN brands b ON b.id = p.brand_id
  JOIN clients c ON c.id = b.client_id
  LEFT JOIN services s ON s.id = p.service_id`;

function emptyTaskCounts() {
  return { todo: 0, doing: 0, review: 0, done: 0, total: 0 };
}
function emptyMaterialCounts() {
  return { total: 0, draft: 0, internalReview: 0, released: 0, pending: 0, changesRequested: 0, approved: 0 };
}

/** Project[] for staff lists and details (no internal notes). */
export function serializeProjects(req, rows) {
  if (!rows.length) return [];
  const db = req.ctx.db;
  const ids = rows.map((row) => row.id);
  const members = new Map(ids.map((id) => [id, []]));
  for (const row of allIn(
    db,
    `SELECT pm.project_id, pm.role AS member_role, pm.added_at, u.id, u.name, u.role, u.status, u.job_title
       FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id IN (?)
      ORDER BY CASE pm.role WHEN 'lead' THEN 0 ELSE 1 END, pm.added_at, u.name COLLATE NOCASE`,
    ids,
  ))
    members.get(row.project_id).push({
      id: row.id,
      name: row.name,
      role: row.role,
      status: row.status,
      jobTitle: row.job_title ?? null,
      memberRole: row.member_role,
      addedAt: row.added_at,
    });

  const tasks = new Map(ids.map((id) => [id, emptyTaskCounts()]));
  for (const row of allIn(db, "SELECT project_id, status, COUNT(*) AS n FROM tasks WHERE project_id IN (?) GROUP BY project_id, status", ids)) {
    const counts = tasks.get(row.project_id);
    counts[row.status] = row.n;
    counts.total += row.n;
  }

  const materials = new Map(ids.map((id) => [id, emptyMaterialCounts()]));
  for (const row of allIn(
    db,
    `SELECT project_id, visibility, approval_status, COUNT(*) AS n FROM materials
      WHERE archived_at IS NULL AND project_id IN (?) GROUP BY project_id, visibility, approval_status`,
    ids,
  )) {
    const counts = materials.get(row.project_id);
    counts.total += row.n;
    if (row.visibility === "draft") counts.draft += row.n;
    else if (row.visibility === "internal_review") counts.internalReview += row.n;
    else {
      counts.released += row.n;
      if (row.approval_status === "pending") counts.pending += row.n;
      else if (row.approval_status === "changes_requested") counts.changesRequested += row.n;
      else if (row.approval_status === "approved") counts.approved += row.n;
    }
  }

  const kits = new Map(
    allIn(db, "SELECT project_id, COUNT(*) AS n FROM kits WHERE status != 'archived' AND project_id IN (?) GROUP BY project_id", ids).map(
      (row) => [row.project_id, row.n],
    ),
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    status: row.status,
    brand: { id: row.brand_id, name: row.brand_name, slug: row.brand_slug, clientId: row.client_id },
    client: { id: row.client_id, name: row.client_name },
    service: row.service_id ? { id: row.service_id, name: row.service_name ?? null, kind: row.service_kind ?? null } : null,
    startDate: row.start_date ?? null,
    dueDate: row.due_date ?? null,
    deliveredAt: row.delivered_at ?? null,
    includesEditables: bool(row.includes_editables),
    members: members.get(row.id),
    isMember: members.get(row.id).some((member) => member.id === req.user.id),
    taskCounts: tasks.get(row.id),
    materialCounts: materials.get(row.id),
    kitCount: kits.get(row.id) ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * listProjects(req, { brandId, clientId, status, mine, q, archived }) -> Project[]
 * Scoped to the viewer. Archived projects only when asked for (status or archived).
 */
export function listProjects(req, filters = {}) {
  const scope = scopeSql.projects(req, "p");
  const where = [scope.sql];
  const params = [...scope.params];
  if (filters.brandId) {
    where.push("p.brand_id = ?");
    params.push(filters.brandId);
  }
  if (filters.clientId) {
    where.push("b.client_id = ?");
    params.push(filters.clientId);
  }
  const statuses = queryList(filters.status).filter((s) => PROJECT_STATUSES.includes(s));
  if (statuses.length) {
    where.push(`p.status IN (${placeholders(statuses)})`);
    params.push(...statuses);
  } else if (!filters.archived) {
    where.push("p.status != 'archived'");
  }
  if (filters.mine) {
    where.push("p.id IN (SELECT project_id FROM project_members WHERE user_id = ?)");
    params.push(req.user.id);
  }
  const q = typeof filters.q === "string" ? filters.q.trim() : "";
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push("(p.name LIKE ? ESCAPE '\\' OR b.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const rows = req.ctx.db.all(
    `${PROJECT_SELECT} WHERE ${where.join(" AND ")}
      ORDER BY CASE p.status WHEN 'in_review' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'planning' THEN 2
                             WHEN 'paused' THEN 3 WHEN 'delivered' THEN 4 ELSE 5 END,
               p.due_date IS NULL, p.due_date, p.updated_at DESC`,
    params,
  );
  return serializeProjects(req, rows);
}

function loadProject(req, id) {
  const row = assertProject(req, id);
  return req.ctx.db.get(`${PROJECT_SELECT} WHERE p.id = ?`, [row.id]);
}

// Task rows with assignee, material and author names.
const TASK_SELECT = `SELECT t.*, a.name AS assignee_name, a.role AS assignee_role, a.status AS assignee_status,
  m.title AS material_title, m.kind AS material_kind, cb.name AS creator_name, cb.role AS creator_role
  FROM tasks t
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN materials m ON m.id = t.material_id
  LEFT JOIN users cb ON cb.id = t.created_by`;

function serializeTask(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name, role: row.assignee_role, status: row.assignee_status } : null,
    dueDate: row.due_date ?? null,
    sortOrder: row.sort_order,
    material: row.material_id ? { id: row.material_id, title: row.material_title, kind: row.material_kind } : null,
    createdBy: row.created_by ? userRef({ id: row.created_by, name: row.creator_name, role: row.creator_role }) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

function projectTasks(db, projectId) {
  return db
    .all(
      `${TASK_SELECT} WHERE t.project_id = ?
        ORDER BY CASE t.status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 WHEN 'review' THEN 2 ELSE 3 END, t.sort_order, t.created_at`,
      [projectId],
    )
    .map(serializeTask);
}

// ------------------------------------------------------------------ members

// Can this staff user work on a project of the client? -> reason (pt-BR) or null.
function memberProblem(db, user, clientId) {
  if (!user || user.role === "client" || user.role === "finance")
    return "Escolha pessoas da equipe de gestão ou criação.";
  if (user.status === "disabled") return `${user.name} está com o acesso desativado.`;
  if (user.role === "manager") {
    const access = db.get("SELECT 1 AS yes FROM staff_client_access WHERE user_id = ? AND client_id = ?", [user.id, clientId]);
    if (!access) return `${user.name} não tem acesso a este cliente. Um administrador pode liberar em Equipe e permissões.`;
  }
  return null;
}

function resolveMembers(db, clientId, members) {
  const ids = [...new Set(members.map((member) => member.userId))];
  if (ids.length !== members.length) throw validation({ members: "Cada pessoa aparece uma vez na equipe do projeto." });
  const users = new Map(allIn(db, "SELECT id, name, role, status FROM users WHERE id IN (?)", ids).map((u) => [u.id, u]));
  members.forEach((member, index) => {
    const problem = memberProblem(db, users.get(member.userId), clientId);
    if (problem) throw validation({ [`members.${index}.userId`]: problem, members: problem });
  });
  return members.map((member) => ({ ...member, user: users.get(member.userId) }));
}

/**
 * What a notify() call actually reached, so the interface never claims an
 * e-mail that was not sent: in-app notices created, whether SMTP is
 * configured and how many of those people get the e-mail (active users with
 * notify_email = 1, the rule notify() applies; without SMTP the message stays
 * in the outbox as not_configured).
 */
export function noticeReach(req, notificationIds = []) {
  const people = allIn(
    req.ctx.db,
    `SELECT u.status, u.notify_email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.id IN (?)`,
    notificationIds,
  );
  return {
    notified: people.length,
    emailConfigured: Boolean(req.ctx.mailer?.isConfigured?.()),
    emailRecipients: people.filter((u) => u.status === "active" && u.notify_email === 1).length,
  };
}

// Notifies the people added to a project; returns noticeReach().
function notifyAssigned(req, project, userIds) {
  if (!userIds.length) return noticeReach(req, []);
  const ids = notify(req, userIds, {
    type: "project.assigned",
    title: "Novo projeto atribuído",
    body: `${project.name} · ${project.brand_name} (${project.client_name})`,
    link: `/admin/projetos/${project.id}`,
    entityType: "project",
    entityId: project.id,
    email: true,
    emailLines: [
      ["Projeto", project.name],
      ["Marca", project.brand_name],
      ["Cliente", project.client_name],
      project.due_date ? ["Prazo", brDate(project.due_date)] : null,
    ].filter(Boolean),
    actionLabel: "Abrir projeto",
  });
  return noticeReach(req, ids);
}

// Replaces project_members; returns ids added and removed.
function writeMembers(req, projectId, members) {
  const db = req.ctx.db;
  const current = new Map(db.all("SELECT user_id, role FROM project_members WHERE project_id = ?", [projectId]).map((r) => [r.user_id, r.role]));
  const next = new Map(members.map((member) => [member.userId, member.role]));
  const added = [];
  const removed = [];
  const changed = [];
  const at = now();
  for (const [userId] of current) {
    if (!next.has(userId)) {
      db.run("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", [projectId, userId]);
      removed.push(userId);
    }
  }
  for (const [userId, role] of next) {
    if (!current.has(userId)) {
      db.run("INSERT INTO project_members (project_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)", [
        projectId,
        userId,
        role,
        req.user.id,
        at,
      ]);
      added.push(userId);
    } else if (current.get(userId) !== role) {
      db.run("UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?", [role, projectId, userId]);
      changed.push(userId);
    }
  }
  return { added, removed, changed };
}

// ------------------------------------------------------------------ schemas

const idOrNull = z.union([schemas.id, z.null()]).optional();
const memberSchema = z.object({
  userId: schemas.id,
  role: z.enum(MEMBER_ROLES, { error: "Escolha a função no projeto." }).default("designer"),
});
const projectFields = {
  name: schemas.text(160),
  description: schemas.optionalText(5000),
  serviceId: idOrNull,
  status: z.enum(PROJECT_STATUSES, { error: "Escolha um status válido." }).optional(),
  startDate: schemas.optionalDate,
  dueDate: schemas.optionalDate,
  includesEditables: z.boolean().optional(),
  internalNotes: schemas.optionalText(5000),
};
const createSchema = z.object({
  brandId: schemas.id,
  ...projectFields,
  memberIds: z.array(schemas.id).max(50).optional(),
  members: z.array(memberSchema).max(50).optional(),
});
const patchSchema = z
  .object({
    name: projectFields.name.optional(),
    description: projectFields.description,
    serviceId: projectFields.serviceId,
    status: projectFields.status,
    startDate: projectFields.startDate,
    dueDate: projectFields.dueDate,
    includesEditables: projectFields.includesEditables,
    internalNotes: projectFields.internalNotes,
  })
  .strict();
const membersSchema = z.object({ members: z.array(memberSchema).max(50) });
const taskFields = {
  title: schemas.text(200),
  description: schemas.optionalText(5000),
  assigneeId: idOrNull,
  status: z.enum(TASK_STATUSES, { error: "Escolha uma coluna válida." }).optional(),
  dueDate: schemas.optionalDate,
  materialId: idOrNull,
  sortOrder: z.number().int().min(0).max(100000).optional(),
};
const taskCreateSchema = z.object(taskFields);
const taskPatchSchema = z
  .object({
    title: taskFields.title.optional(),
    description: taskFields.description,
    assigneeId: taskFields.assigneeId,
    status: taskFields.status,
    dueDate: taskFields.dueDate,
    materialId: taskFields.materialId,
    sortOrder: taskFields.sortOrder,
  })
  .strict();

function checkDates(startDate, dueDate) {
  if (startDate && dueDate && dueDate < startDate) throw validation({ dueDate: "O prazo não pode ser antes do início." });
}

function assertService(db, serviceId) {
  if (!serviceId) return null;
  const row = db.get("SELECT id, name, includes_editables FROM services WHERE id = ?", [serviceId]);
  if (!row) throw validation({ serviceId: "Este serviço não existe mais." });
  return row;
}

// Can this person be the assignee of a task in the project?
function assertAssignee(db, project, assigneeId) {
  if (!assigneeId) return null;
  const user = db.get("SELECT id, name, role, status FROM users WHERE id = ?", [assigneeId]);
  const member = user && db.get("SELECT 1 AS yes FROM project_members WHERE project_id = ? AND user_id = ?", [project.id, user.id]);
  const problem =
    !user || user.role === "client" || user.role === "finance"
      ? "Escolha alguém da equipe do projeto."
      : user.status === "disabled"
        ? `${user.name} está com o acesso desativado.`
        : member || user.role === "admin"
          ? null
          : user.role === "manager"
            ? memberProblem(db, user, project.client_id)
            : `${user.name} não faz parte deste projeto. Adicione a pessoa à equipe primeiro.`;
  if (problem) throw validation({ assigneeId: problem });
  return user;
}

function assertTaskMaterial(db, project, materialId) {
  if (!materialId) return null;
  const row = db.get("SELECT id, title, brand_id FROM materials WHERE id = ?", [materialId]);
  if (!row || row.brand_id !== project.brand_id) throw validation({ materialId: "Escolha um material da mesma marca do projeto." });
  return row;
}

// Places a task at `index` of its column and renumbers the column.
function placeTask(db, projectId, taskId, status, index) {
  const siblings = db
    .all("SELECT id FROM tasks WHERE project_id = ? AND status = ? AND id != ? ORDER BY sort_order, created_at", [projectId, status, taskId])
    .map((row) => row.id);
  const at = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length));
  siblings.splice(at, 0, taskId);
  siblings.forEach((id, position) => db.run("UPDATE tasks SET sort_order = ? WHERE id = ?", [position, id]));
}

function loadTask(req, id) {
  const task = id ? req.ctx.db.get("SELECT * FROM tasks WHERE id = ?", [id]) : null;
  if (!task) throw notFound();
  const project = loadProject(req, task.project_id);
  return { task, project };
}

function notifyTaskAssignee(req, project, task, assigneeId) {
  if (!assigneeId) return;
  notify(req, [assigneeId], {
    type: "task.assigned",
    title: "Nova tarefa atribuída",
    body: `${task.title} · ${project.name}`,
    link: `/admin/projetos/${project.id}?tarefa=${task.id}`,
    entityType: "task",
    entityId: task.id,
    email: true,
    emailLines: [
      ["Tarefa", task.title],
      ["Projeto", project.name],
      ["Marca", project.brand_name],
      task.due_date ? ["Prazo", brDate(task.due_date)] : null,
    ].filter(Boolean),
    actionLabel: "Abrir tarefa",
  });
}

function projectPermissions(req, project) {
  const user = req.user;
  const member = Boolean(req.ctx.db.get("SELECT 1 AS yes FROM project_members WHERE project_id = ? AND user_id = ?", [project.id, user.id]));
  return {
    canEdit: can(user, "projects.manage"),
    canManageMembers: can(user, "projects.manage"),
    canManageTasks: can(user, "tasks.manage"),
    canDeleteAnyTask: can(user, "projects.manage"),
    canUpload: can(user, "materials.upload") && (user.role !== "designer" || member),
    canRelease: can(user, "materials.release"),
    canViewLibrary: can(user, "materials.view"),
    isMember: member,
  };
}

// ------------------------------------------------------------------ router

export default function projectsRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  router.get("/api/projects", requireCap("projects.view"), (req, res) => {
    const items = listProjects(req, {
      brandId: req.query.brandId,
      clientId: req.query.clientId,
      status: req.query.status,
      mine: queryBool(req.query.mine),
      archived: queryBool(req.query.archived),
      q: req.query.q,
    });
    res.json({ items, total: items.length, permissions: { canCreate: can(req.user, "projects.manage") } });
  });

  // Everything the "Novo projeto" form needs, in the viewer's scope: brands,
  // services and the people who may join the project.
  router.get("/api/projects/options", requireCap("projects.manage"), (req, res) => {
    const scope = scopeSql.brands(req, "b");
    const brands = db
      .all(
        `SELECT b.id, b.name, b.slug, b.client_id, c.name AS client_name FROM brands b JOIN clients c ON c.id = b.client_id
          WHERE b.status = 'active' AND c.status != 'archived' AND ${scope.sql}
          ORDER BY c.name COLLATE NOCASE, b.name COLLATE NOCASE`,
        scope.params,
      )
      .map((row) => ({ id: row.id, name: row.name, slug: row.slug, clientId: row.client_id, client: { id: row.client_id, name: row.client_name } }));
    const services = db
      .all("SELECT id, name, kind, includes_editables, active FROM services ORDER BY active DESC, sort_order, name COLLATE NOCASE")
      .map((row) => ({ id: row.id, name: row.name, kind: row.kind, includesEditables: bool(row.includes_editables), active: bool(row.active) }));
    let clientId = null;
    if (req.query.brandId) clientId = assertBrand(req, String(req.query.brandId)).client_id;
    const staff = db
      .all(
        `SELECT id, name, role, status, job_title FROM users
          WHERE role IN ('admin', 'manager', 'designer') AND status != 'disabled'
          ORDER BY CASE role WHEN 'designer' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, name COLLATE NOCASE`,
      )
      .map((row) => {
        const reason = clientId ? memberProblem(db, row, clientId) : null;
        return { id: row.id, name: row.name, role: row.role, status: row.status, jobTitle: row.job_title ?? null, eligible: !reason, reason };
      });
    res.json({ brands, services, staff });
  });

  router.post("/api/projects", requireCap("projects.manage"), (req, res) => {
    const input = parse(createSchema, req.body);
    const brand = assertBrand(req, input.brandId);
    if (brand.status !== "active") throw validation({ brandId: "Esta marca está arquivada." });
    const service = assertService(db, input.serviceId);
    checkDates(input.startDate, input.dueDate);
    const rawMembers = input.members ?? (input.memberIds ?? []).map((userId) => ({ userId, role: null }));
    const members = resolveMembers(db, brand.client_id, rawMembers).map((member) => ({
      userId: member.userId,
      role: member.role ?? (member.user.role === "designer" ? "designer" : "lead"),
    }));

    const id = newId("prj");
    const at = now();
    const status = input.status ?? "planning";
    let reach;
    db.tx(() => {
      db.run(
        `INSERT INTO projects (id, brand_id, service_id, name, description, status, includes_editables, start_date, due_date,
           delivered_at, internal_notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          brand.id,
          service?.id ?? null,
          input.name,
          input.description ?? null,
          status,
          (input.includesEditables ?? bool(service?.includes_editables)) ? 1 : 0,
          input.startDate ?? null,
          input.dueDate ?? null,
          status === "delivered" ? at : null,
          input.internalNotes ?? null,
          req.user.id,
          at,
          at,
        ],
      );
      const { added } = writeMembers(req, id, members);
      const project = db.get(`${PROJECT_SELECT} WHERE p.id = ?`, [id]);
      logActivity(req, {
        action: "project.created",
        entityType: "project",
        entityId: id,
        projectId: id,
        brandId: brand.id,
        clientId: brand.client_id,
        summary: `Projeto ${input.name} criado para a marca ${brand.name}.`,
        visibility: "client",
        data: { members: members.length, serviceId: service?.id ?? null },
      });
      reach = notifyAssigned(req, project, added);
    });
    const [project] = serializeProjects(req, [db.get(`${PROJECT_SELECT} WHERE p.id = ?`, [id])]);
    res.status(201).json({ project, ...reach });
  });

  router.get("/api/projects/:id", requireCap("projects.view"), (req, res) => {
    const row = loadProject(req, req.params.id);
    const [project] = serializeProjects(req, [row]);
    project.internalNotes = row.internal_notes ?? null;
    project.createdBy = row.created_by ? userRef(db.get("SELECT id, name, role FROM users WHERE id = ?", [row.created_by])) : null;
    const kits = db
      .all(
        `SELECT k.id, k.name, k.kind, k.status, k.released_at, (SELECT COUNT(*) FROM kit_items ki WHERE ki.kit_id = k.id) AS item_count
           FROM kits k WHERE k.project_id = ? AND k.status != 'archived' ORDER BY k.created_at`,
        [row.id],
      )
      .map((kit) => ({ id: kit.id, name: kit.name, kind: kit.kind, status: kit.status, releasedAt: kit.released_at ?? null, itemCount: kit.item_count }));
    const materials = can(req.user, "materials.view")
      ? listMaterials(req, { projectId: row.id, sort: "updated" }, { page: 1, pageSize: 60 })
      : { items: [], total: 0 };
    const activity = db
      .all(`${ACTIVITY_SELECT} WHERE a.project_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 40`, [row.id])
      .map((entry) => serializeActivity(req, entry));
    res.json({
      project,
      tasks: projectTasks(db, row.id),
      kits,
      materials,
      activity,
      permissions: projectPermissions(req, row),
    });
  });

  router.patch("/api/projects/:id", requireCap("projects.manage"), (req, res) => {
    const row = loadProject(req, req.params.id);
    const input = parse(patchSchema, req.body);
    const service = input.serviceId !== undefined ? assertService(db, input.serviceId) : undefined;
    checkDates(input.startDate !== undefined ? input.startDate : row.start_date, input.dueDate !== undefined ? input.dueDate : row.due_date);

    const sets = [];
    const params = [];
    const changed = [];
    const set = (column, value, key) => {
      if (value === (row[column] ?? null)) return;
      sets.push(`${column} = ?`);
      params.push(value);
      changed.push(key);
    };
    if (input.name !== undefined) set("name", input.name, "name");
    if (input.description !== undefined) set("description", input.description, "description");
    if (service !== undefined) set("service_id", service?.id ?? null, "serviceId");
    if (input.startDate !== undefined) set("start_date", input.startDate, "startDate");
    if (input.dueDate !== undefined) set("due_date", input.dueDate, "dueDate");
    if (input.includesEditables !== undefined) set("includes_editables", input.includesEditables ? 1 : 0, "includesEditables");
    if (input.internalNotes !== undefined) set("internal_notes", input.internalNotes, "internalNotes");
    const statusChange = input.status !== undefined && input.status !== row.status;
    if (statusChange) {
      set("status", input.status, "status");
      if (input.status === "delivered" && !row.delivered_at) set("delivered_at", now(), "deliveredAt");
      if (input.status !== "delivered" && input.status !== "archived" && row.delivered_at) set("delivered_at", null, "deliveredAt");
    }
    if (sets.length) {
      db.tx(() => {
        sets.push("updated_at = ?");
        params.push(now());
        db.run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, [...params, row.id]);
        if (statusChange)
          logActivity(req, {
            action: "project.status_changed",
            entityType: "project",
            entityId: row.id,
            projectId: row.id,
            summary: `Projeto ${input.name ?? row.name}: ${PROJECT_LABELS[row.status]} → ${PROJECT_LABELS[input.status]}.`,
            visibility: "client",
            data: { from: row.status, to: input.status },
          });
        const others = changed.filter((key) => key !== "status" && key !== "deliveredAt");
        if (others.length)
          logActivity(req, {
            action: "project.updated",
            entityType: "project",
            entityId: row.id,
            projectId: row.id,
            summary: `Projeto ${input.name ?? row.name} atualizado.`,
            data: { fields: others },
          });
      });
    }
    const fresh = db.get(`${PROJECT_SELECT} WHERE p.id = ?`, [row.id]);
    const [project] = serializeProjects(req, [fresh]);
    project.internalNotes = fresh.internal_notes ?? null;
    res.json({ project });
  });

  router.put("/api/projects/:id/members", requireCap("projects.manage"), (req, res) => {
    const row = loadProject(req, req.params.id);
    const input = parse(membersSchema, req.body);
    resolveMembers(db, row.client_id, input.members);
    let change;
    let reach;
    db.tx(() => {
      change = writeMembers(req, row.id, input.members);
      if (change.added.length || change.removed.length || change.changed.length) {
        const names = (ids) =>
          allIn(db, "SELECT name FROM users WHERE id IN (?) ORDER BY name COLLATE NOCASE", ids)
            .map((u) => u.name)
            .join(", ");
        const parts = [];
        if (change.added.length) parts.push(`entrou: ${names(change.added)}`);
        if (change.removed.length) parts.push(`saiu: ${names(change.removed)}`);
        if (change.changed.length) parts.push(`função alterada: ${names(change.changed)}`);
        logActivity(req, {
          action: "project.members_changed",
          entityType: "project",
          entityId: row.id,
          projectId: row.id,
          summary: `Equipe do projeto ${row.name} — ${parts.join("; ")}.`,
          data: change,
        });
      }
      reach = notifyAssigned(req, row, change.added);
    });
    const [project] = serializeProjects(req, [db.get(`${PROJECT_SELECT} WHERE p.id = ?`, [row.id])]);
    res.json({ project, ...change, ...reach });
  });

  // ---------------------------------------------------------------- tasks

  router.get("/api/projects/:id/tasks", requireCap("projects.view"), (req, res) => {
    const row = loadProject(req, req.params.id);
    const items = projectTasks(db, row.id);
    res.json({ items, total: items.length });
  });

  router.post("/api/projects/:id/tasks", requireCap("tasks.manage"), (req, res) => {
    const project = loadProject(req, req.params.id);
    const input = parse(taskCreateSchema, req.body);
    assertAssignee(db, project, input.assigneeId);
    assertTaskMaterial(db, project, input.materialId);
    const id = newId("tsk");
    const at = now();
    const status = input.status ?? "todo";
    db.tx(() => {
      db.run(
        `INSERT INTO tasks (id, project_id, material_id, title, description, assignee_id, status, due_date, sort_order,
           created_by, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          id,
          project.id,
          input.materialId ?? null,
          input.title,
          input.description ?? null,
          input.assigneeId ?? null,
          status,
          input.dueDate ?? null,
          req.user.id,
          at,
          at,
          status === "done" ? at : null,
        ],
      );
      placeTask(db, project.id, id, status, input.sortOrder);
      logActivity(req, {
        action: "task.created",
        entityType: "task",
        entityId: id,
        projectId: project.id,
        summary: `Tarefa "${input.title}" criada no projeto ${project.name}.`,
      });
      notifyTaskAssignee(req, project, { id, title: input.title, due_date: input.dueDate ?? null }, input.assigneeId);
    });
    const task = serializeTask(db.get(`${TASK_SELECT} WHERE t.id = ?`, [id]));
    res.status(201).json({ task, tasks: projectTasks(db, project.id) });
  });

  router.patch("/api/tasks/:id", requireCap("tasks.manage"), (req, res) => {
    const { task, project } = loadTask(req, req.params.id);
    const input = parse(taskPatchSchema, req.body);
    if (input.assigneeId !== undefined && input.assigneeId !== task.assignee_id) assertAssignee(db, project, input.assigneeId);
    if (input.materialId !== undefined) assertTaskMaterial(db, project, input.materialId);

    const sets = [];
    const params = [];
    const set = (column, value) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (input.title !== undefined) set("title", input.title);
    if (input.description !== undefined) set("description", input.description);
    if (input.dueDate !== undefined) set("due_date", input.dueDate);
    if (input.materialId !== undefined) set("material_id", input.materialId);
    const reassigned = input.assigneeId !== undefined && input.assigneeId !== task.assignee_id;
    if (reassigned) set("assignee_id", input.assigneeId);
    const status = input.status ?? task.status;
    const moved = status !== task.status;
    if (moved) {
      set("status", status);
      set("completed_at", status === "done" ? now() : null);
    }

    db.tx(() => {
      if (sets.length) {
        set("updated_at", now());
        db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, [...params, task.id]);
      }
      if (moved || input.sortOrder !== undefined) placeTask(db, project.id, task.id, status, input.sortOrder);
      const title = input.title ?? task.title;
      if (moved)
        logActivity(req, {
          action: "task.moved",
          entityType: "task",
          entityId: task.id,
          projectId: project.id,
          summary: `Tarefa "${title}" movida para ${TASK_LABELS[status]}.`,
          data: { from: task.status, to: status },
        });
      if (reassigned) {
        const assignee = input.assigneeId ? db.get("SELECT name FROM users WHERE id = ?", [input.assigneeId]) : null;
        logActivity(req, {
          action: "task.assigned",
          entityType: "task",
          entityId: task.id,
          projectId: project.id,
          summary: assignee ? `Tarefa "${title}" atribuída a ${assignee.name}.` : `Tarefa "${title}" ficou sem responsável.`,
        });
        notifyTaskAssignee(req, project, { id: task.id, title, due_date: input.dueDate !== undefined ? input.dueDate : task.due_date }, input.assigneeId);
      }
      // work waiting for review reaches the project leads
      if (moved && status === "review") {
        const leads = db.all("SELECT user_id FROM project_members WHERE project_id = ? AND role = 'lead'", [project.id]).map((r) => r.user_id);
        notify(req, leads, {
          type: "task.review",
          title: "Tarefa aguardando revisão",
          body: `${title} · ${project.name}`,
          link: `/admin/projetos/${project.id}?tarefa=${task.id}`,
          entityType: "task",
          entityId: task.id,
        });
      }
    });
    res.json({ task: serializeTask(db.get(`${TASK_SELECT} WHERE t.id = ?`, [task.id])), tasks: projectTasks(db, project.id) });
  });

  router.delete("/api/tasks/:id", requireCap("tasks.manage"), (req, res) => {
    const { task, project } = loadTask(req, req.params.id);
    if (!can(req.user, "projects.manage") && task.created_by !== req.user.id)
      throw forbidden("Somente quem criou a tarefa ou a gestão do projeto pode excluí-la.");
    db.tx(() => {
      db.run("DELETE FROM tasks WHERE id = ?", [task.id]);
      logActivity(req, {
        action: "task.deleted",
        entityType: "task",
        entityId: task.id,
        projectId: project.id,
        summary: `Tarefa "${task.title}" excluída do projeto ${project.name}.`,
      });
    });
    res.status(204).end();
  });

  router.get("/api/me/tasks", requireCap("projects.view"), (req, res) => {
    const scope = scopeSql.projects(req, "p");
    const status = typeof req.query.status === "string" ? req.query.status : "open";
    const statusSql = status === "done" ? "t.status = 'done'" : status === "all" ? "1 = 1" : "t.status != 'done'";
    const rows = db.all(
      `SELECT t.*, a.name AS assignee_name, a.role AS assignee_role, a.status AS assignee_status,
              m.title AS material_title, m.kind AS material_kind, cb.name AS creator_name, cb.role AS creator_role,
              p.name AS project_name, p.status AS project_status, b.id AS brand_id, b.name AS brand_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN brands b ON b.id = p.brand_id
         LEFT JOIN users a ON a.id = t.assignee_id
         LEFT JOIN materials m ON m.id = t.material_id
         LEFT JOIN users cb ON cb.id = t.created_by
        WHERE t.assignee_id = ? AND p.status != 'archived' AND ${statusSql} AND ${scope.sql}
        ORDER BY t.due_date IS NULL, t.due_date, CASE t.status WHEN 'review' THEN 0 WHEN 'doing' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END, t.updated_at DESC
        LIMIT 200`,
      [req.user.id, ...scope.params],
    );
    const items = rows.map((row) => ({
      ...serializeTask(row),
      project: { id: row.project_id, name: row.project_name, status: row.project_status },
      brand: { id: row.brand_id, name: row.brand_name },
    }));
    res.json({ items, total: items.length });
  });

  // ---------------------------------------------------------------- portal

  // Client: projects of their own brands with what was released to them.
  // Counts only cover released, visible materials (drafts never show).
  router.get("/api/portal/projects", requireCap("portal.access"), (req, res) => {
    const clientId = req.user.client_id;
    const where = ["b.client_id = ?", "b.status = 'active'", "p.status != 'archived'"];
    const params = [clientId];
    if (req.query.brandId) {
      const brand = assertBrand(req, String(req.query.brandId));
      where.push("p.brand_id = ?");
      params.push(brand.id);
    }
    const rows = db.all(
      `SELECT p.id, p.name, p.description, p.status, p.brand_id, p.start_date, p.due_date, p.delivered_at,
              p.includes_editables, p.created_at, p.updated_at, b.name AS brand_name, b.slug AS brand_slug,
              b.client_id, s.name AS service_name
         FROM projects p JOIN brands b ON b.id = p.brand_id LEFT JOIN services s ON s.id = p.service_id
        WHERE ${where.join(" AND ")}
        ORDER BY CASE p.status WHEN 'delivered' THEN 1 ELSE 0 END, p.due_date IS NULL, p.due_date, p.created_at DESC`,
      params,
    );
    const ids = rows.map((row) => row.id);
    const visible = clientMaterialFilter("m");
    const counts = new Map();
    for (const row of allIn(
      db,
      `SELECT m.project_id, m.approval_status, m.requires_approval, m.delivered_at IS NOT NULL AS delivered,
              MAX(m.released_at) AS last_release, COUNT(*) AS n
         FROM materials m WHERE ${visible} AND m.project_id IN (?)
        GROUP BY m.project_id, m.approval_status, m.requires_approval, delivered`,
      ids,
    )) {
      const c = counts.get(row.project_id) ?? { total: 0, approved: 0, pending: 0, changesRequested: 0, noApproval: 0, delivered: 0, lastReleaseAt: null };
      c.total += row.n;
      if (row.approval_status === "approved") c.approved += row.n;
      else if (row.approval_status === "pending") c.pending += row.n;
      else if (row.approval_status === "changes_requested") c.changesRequested += row.n;
      else c.noApproval += row.n;
      if (row.delivered) c.delivered += row.n;
      if (!c.lastReleaseAt || row.last_release > c.lastReleaseAt) c.lastReleaseAt = row.last_release;
      counts.set(row.project_id, c);
    }
    const downloadable = new Set(
      allIn(
        db,
        `SELECT DISTINCT m.project_id FROM materials m JOIN material_files f ON f.version_id = m.released_version_id
          WHERE ${visible} AND m.download_enabled = 1 AND m.project_id IN (?) AND f.published = 1
            AND (f.role IN ('original', 'final') OR (f.role = 'editable' AND m.editable_included = 1))
            AND (f.media_kind != 'font' OR f.font_distributable = 1)`,
        ids,
      ).map((row) => row.project_id),
    );
    const kits = new Map(ids.map((id) => [id, []]));
    for (const kit of allIn(
      db,
      `SELECT k.id, k.project_id, k.name, k.kind, k.released_at,
              (SELECT COUNT(*) FROM kit_items ki JOIN materials m ON m.id = ki.material_id
                WHERE ki.kit_id = k.id AND ${visible}) AS item_count
         FROM kits k WHERE k.status = 'released' AND k.project_id IN (?) ORDER BY k.released_at DESC`,
      ids,
    ))
      if (kit.item_count > 0)
        kits.get(kit.project_id).push({ id: kit.id, name: kit.name, kind: kit.kind, releasedAt: kit.released_at ?? null, itemCount: kit.item_count });

    const items = rows.map((row) => {
      const c = counts.get(row.id) ?? { total: 0, approved: 0, pending: 0, changesRequested: 0, noApproval: 0, delivered: 0, lastReleaseAt: null };
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? null,
        status: row.status,
        brand: { id: row.brand_id, name: row.brand_name, slug: row.brand_slug, clientId: row.client_id },
        service: row.service_name ? { name: row.service_name } : null,
        startDate: row.start_date ?? null,
        dueDate: row.due_date ?? null,
        deliveredAt: row.delivered_at ?? null,
        includesEditables: bool(row.includes_editables),
        materialCount: c.total,
        releasedCount: c.total,
        approvedCount: c.approved,
        pendingCount: c.pending,
        changesRequestedCount: c.changesRequested,
        finalizedCount: c.approved + c.noApproval,
        deliveredCount: c.delivered,
        lastReleaseAt: c.lastReleaseAt,
        hasDownloads: downloadable.has(row.id),
        kits: kits.get(row.id),
      };
    });
    res.json({ items, total: items.length });
  });

  return router;
}

