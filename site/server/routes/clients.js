// Clients, brands and client users (docs/API.md "Clientes, marcas, equipe,
// projetos"). Only admins create clients (clients.create) and edit their
// sensitive data; managers edit contacts, notes and brands of the clients they
// were given; designers read the basic record of their projects' clients.
import { Router } from "express";
import { assertBrand, assertClient, scopeSql } from "../lib/access.js";
import { logActivity } from "../lib/audit.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { conflict, forbidden, notFound, validation } from "../lib/errors.js";
import { saveGuidelineDraft } from "../lib/guidelines.js";
import { newId } from "../lib/ids.js";
import { can } from "../lib/permissions.js";
import { getSetting } from "../lib/settings.js";
import { isStaff, serializeBrand, serializeClient, serializeUser } from "../lib/serialize.js";
import { now } from "../lib/time.js";
import { parse, schemas, z } from "../lib/validate.js";
import { listProjects } from "./projects.js";
import { cutAccess, deliverInvite, inviteInfo, notifyAccessGranted } from "./team.js";

const CLIENT_STATUSES = ["active", "paused", "archived"];
const STATUS_LABELS = { active: "ativo", paused: "pausado", archived: "arquivado" };

const placeholders = (list) => list.map(() => "?").join(", ");
const escapeLike = (text) => String(text).replace(/[\\%_]/g, (c) => `\\${c}`);

// ------------------------------------------------------------------ documents

const digitsOf = (text) => String(text ?? "").replace(/\D/g, "");

function validCnpj(d) {
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const check = (len) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, weight, i) => acc + Number(d[i]) * weight, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return check(12) === Number(d[12]) && check(13) === Number(d[13]);
}

function validCpf(d) {
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const check = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(d[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(d[9]) && check(10) === Number(d[10]);
}

// "12.345.678/0001-95" or "123.456.789-09"
export function formatDocument(text) {
  const d = digitsOf(text);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return text;
}

const documentSchema = z
  .union([z.string().trim().max(32), z.null()])
  .optional()
  .transform((value) => (value ? value : value === undefined ? undefined : null))
  .refine((value) => {
    if (!value) return true;
    const d = digitsOf(value);
    return validCnpj(d) || validCpf(d);
  }, "Informe um CNPJ válido (14 dígitos) ou, para pessoa física, um CPF.")
  .transform((value) => (value ? formatDocument(value) : value));

const optionalEmail = z
  .union([z.literal(""), z.null(), schemas.email])
  .optional()
  .transform((value) => (value === undefined ? undefined : value || null));

const phoneSchema = z
  .union([z.string().trim().max(40), z.null()])
  .optional()
  .transform((value) => (value === undefined ? undefined : value || null))
  .refine((value) => !value || digitsOf(value).length >= 8, "Informe um telefone com DDD.");

// ------------------------------------------------------------------ schemas

const brandFields = {
  name: schemas.text(120),
  description: schemas.optionalText(2000),
  usageGuidelines: schemas.optionalText(10000),
  typographyGuidelines: schemas.optionalText(10000),
  internalNotes: schemas.optionalText(5000),
};
const brandCreateSchema = z.object(brandFields);
const brandPatchSchema = z
  .object({
    name: brandFields.name.optional(),
    description: brandFields.description,
    usageGuidelines: brandFields.usageGuidelines,
    typographyGuidelines: brandFields.typographyGuidelines,
    internalNotes: brandFields.internalNotes,
    status: z.enum(["active", "archived"], { error: "Escolha ativa ou arquivada." }).optional(),
  })
  .strict();

const clientFields = {
  name: schemas.text(160),
  legalName: schemas.optionalText(200),
  document: documentSchema,
  contactName: schemas.optionalText(120),
  contactEmail: optionalEmail,
  contactPhone: phoneSchema,
  internalNotes: schemas.optionalText(5000),
};
const userInviteSchema = z.object({ name: schemas.text(120), email: schemas.email });
const clientCreateSchema = z.object({
  ...clientFields,
  brand: z.object({ name: schemas.text(120), description: schemas.optionalText(2000) }).optional(),
  user: userInviteSchema.optional(),
  managerIds: z.array(schemas.id).max(100).optional(),
});
const clientPatchSchema = z
  .object({
    name: clientFields.name.optional(),
    legalName: clientFields.legalName,
    document: clientFields.document,
    contactName: clientFields.contactName,
    contactEmail: clientFields.contactEmail,
    contactPhone: clientFields.contactPhone,
    internalNotes: clientFields.internalNotes,
    status: z.enum(CLIENT_STATUSES, { error: "Escolha um status válido." }).optional(),
  })
  .strict();
// Managers may change these; the rest needs clients.edit (admin).
const MANAGER_FIELDS = new Set(["contactName", "contactEmail", "contactPhone", "internalNotes"]);
const CLIENT_COLUMNS = {
  name: "name",
  legalName: "legal_name",
  document: "document",
  contactName: "contact_name",
  contactEmail: "contact_email",
  contactPhone: "contact_phone",
  internalNotes: "internal_notes",
  status: "status",
};
const FIELD_LABELS = {
  name: "nome",
  legalName: "razão social",
  document: "CNPJ",
  contactName: "contato",
  contactEmail: "e-mail de contato",
  contactPhone: "telefone",
  internalNotes: "notas internas",
  status: "status",
};
const clientUserPatchSchema = z
  .object({
    name: schemas.text(120).optional(),
    status: z.enum(["active", "disabled"], { error: "Escolha ativo ou desativado." }).optional(),
  })
  .strict();
const managerSchema = z.object({ userId: schemas.id });

// ------------------------------------------------------------------ helpers

function slugify(text) {
  return (
    String(text)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "marca"
  );
}

async function uniqueBrandSlug(db, clientId, name) {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; await db.get("SELECT 1 AS yes FROM brands WHERE client_id = ? AND slug = ?", [clientId, slug]); n += 1) slug = `${base}-${n}`;
  return slug;
}

async function assertBrandName(db, clientId, name, exceptId = null) {
  const clash = await db.get("SELECT id FROM brands WHERE client_id = ? AND lower(name) = lower(?) AND NOT (id <=> ?)", [clientId, name, exceptId]);
  if (clash) throw validation({ name: "Este cliente já tem uma marca com este nome." });
}

// Guidelines sent on creation start as a draft: the client only reads them
// after the identity release (lib/guidelines.js, D3).
async function insertBrand(req, clientId, input) {
  const db = req.ctx.db;
  const id = newId("brd");
  const at = now();
  await db.run(
    `INSERT INTO brands (id, client_id, name, slug, description, internal_notes, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [id, clientId, input.name, await uniqueBrandSlug(db, clientId, input.name), input.description ?? null, input.internalNotes ?? null, req.user.id, at, at],
  );
  if (input.usageGuidelines || input.typographyGuidelines)
    await saveGuidelineDraft(
      db,
      await db.get("SELECT * FROM brands WHERE id = ?", [id]),
      { usage: input.usageGuidelines, typography: input.typographyGuidelines },
      { userId: req.user.id, at },
    );
  await logActivity(req, {
    action: "brand.created",
    entityType: "brand",
    entityId: id,
    brandId: id,
    clientId,
    summary: `Marca ${input.name} criada.`,
    visibility: "client",
  });
  return id;
}

async function insertClientUser(req, clientId, input) {
  const db = req.ctx.db;
  if (await db.get("SELECT id FROM users WHERE email = ?", [input.email]))
    throw validation({ email: "Já existe um acesso com este e-mail.", "user.email": "Já existe um acesso com este e-mail." });
  const id = newId("usr");
  const at = now();
  await db.run(
    `INSERT INTO users (id, email, name, role, client_id, status, notify_email, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'client', ?, 'invited', ?, ?, ?, ?)`,
    [id, input.email, input.name, clientId, await getSetting(db, "defaultNotifyEmail") === false ? 0 : 1, req.user.id, at, at],
  );
  await logActivity(req, {
    action: "user.invited",
    entityType: "user",
    entityId: id,
    clientId,
    summary: `${input.name} foi convidado para acessar a plataforma.`,
    visibility: "client",
  });
  return id;
}

// Brand rows with counts; `where` must reference alias b.
async function brandsWithCounts(req, where, params) {
  const db = req.ctx.db;
  const scope = scopeSql.brands(req, "b");
  const rows = await db.all(
    `SELECT b.*, c.name AS client_name FROM brands b JOIN clients c ON c.id = b.client_id
      WHERE ${scope.sql} AND ${where}
      ORDER BY b.status = 'archived', b.name COLLATE utf8mb4_0900_ai_ci`,
    [...scope.params, ...params],
  );
  if (!rows.length) return [];
  const staff = isStaff(req);
  const withCounts = staff && req.user.role !== "finance";
  const ids = rows.map((row) => row.id);
  const counts = new Map(ids.map((id) => [id, { projects: 0, activeProjects: 0, materials: 0, released: 0, kits: 0 }]));
  if (withCounts) {
    const projectScope = scopeSql.projects(req, "p");
    for (const row of await db.all(
      `SELECT p.brand_id, COUNT(*) AS n, SUM(p.status NOT IN ('delivered', 'archived')) AS open FROM projects p
        WHERE p.status != 'archived' AND ${projectScope.sql} AND p.brand_id IN (${placeholders(ids)}) GROUP BY p.brand_id`,
      [...projectScope.params, ...ids],
    )) {
      counts.get(row.brand_id).projects = row.n;
      counts.get(row.brand_id).activeProjects = row.open ?? 0;
    }
    for (const row of await db.all(
      `SELECT brand_id, COUNT(*) AS n, SUM(visibility = 'released') AS released FROM materials
        WHERE archived_at IS NULL AND brand_id IN (${placeholders(ids)}) GROUP BY brand_id`,
      ids,
    )) {
      counts.get(row.brand_id).materials = row.n;
      counts.get(row.brand_id).released = row.released ?? 0;
    }
    for (const row of await db.all(
      `SELECT brand_id, COUNT(*) AS n FROM kits WHERE status != 'archived' AND brand_id IN (${placeholders(ids)}) GROUP BY brand_id`,
      ids,
    ))
      counts.get(row.brand_id).kits = row.n;
  }
  return rows.map((row) => ({ ...serializeBrand(req, row), ...(withCounts ? { counts: counts.get(row.id) } : {}) }));
}

async function clientUsers(req, clientId) {
  const db = req.ctx.db;
  const rows = await db.all(
    `SELECT * FROM users WHERE role = 'client' AND client_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END, name COLLATE utf8mb4_0900_ai_ci`,
    [clientId],
  );
  const invites = await inviteInfo(
    db,
    rows.filter((row) => row.status === "invited").map((row) => row.id),
  );
  return rows.map((row) => ({ ...serializeUser(req, row), invite: invites.get(row.id) ?? null }));
}

async function clientManagers(req, clientId) {
  return (await req.ctx.db
    .all(
      `SELECT u.*, a.granted_at FROM staff_client_access a JOIN users u ON u.id = a.user_id
        WHERE a.client_id = ? AND u.role = 'manager'
        ORDER BY u.status = 'disabled', u.name COLLATE utf8mb4_0900_ai_ci`,
      [clientId],
    ))
    .map((row) => ({ ...serializeUser(req, row), grantedAt: row.granted_at }));
}

function clientPermissions(req) {
  const user = req.user;
  const editsContacts = can(user, "clients.edit") || can(user, "brands.edit");
  return {
    canEdit: editsContacts,
    canEditSensitive: can(user, "clients.edit"),
    canManageBrands: can(user, "brands.edit"),
    canManageUsers: editsContacts,
    canViewUsers: user.role !== "designer",
    canViewTeam: can(user, "team.view"),
    canManageAccess: can(user, "team.manage"),
    canViewProjects: can(user, "projects.view"),
    canManageProjects: can(user, "projects.manage"),
    canViewOrders: can(user, "orders.view"),
    canViewLibrary: can(user, "materials.view"),
    canViewContent: can(user, "content.view"),
  };
}

async function clientSummary(req, id) {
  const db = req.ctx.db;
  const row = await db.get("SELECT * FROM clients WHERE id = ?", [id]);
  return serializeClient(req, row);
}

async function assertManagerTarget(db, userId) {
  const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
  if (!user || user.role !== "manager")
    throw validation({ userId: "Escolha um gestor. Administradores já acessam todos os clientes e designers acessam pelos projetos." });
  return user;
}

// ------------------------------------------------------------------ router

export default function clientsRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  router.get("/api/clients", requireCap("clients.view"), async (req, res) => {
    const scope = scopeSql.clients(req, "c");
    const projectScope = scopeSql.projects(req, "p");
    const where = [scope.sql];
    const params = [...scope.params];
    const status = typeof req.query.status === "string" ? req.query.status : "";
    if (CLIENT_STATUSES.includes(status)) {
      where.push("c.status = ?");
      params.push(status);
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      const like = `%${escapeLike(q)}%`;
      // Search only what this role can read (serializeClient): designers get
      // the basic record, so CNPJ and contact fields must not be probed; brand
      // names only within the viewer's brand scope.
      const columns = ["c.name", "IFNULL(c.legal_name, '')"];
      if (req.user.role !== "designer")
        columns.push("IFNULL(c.document, '')", "IFNULL(c.contact_email, '')", "IFNULL(c.contact_name, '')");
      const searchBrands = scopeSql.brands(req, "bq");
      where.push(
        `(${columns.map((column) => `${column} LIKE ? COLLATE utf8mb4_0900_ai_ci`).join(" OR ")}
          OR EXISTS (SELECT 1 FROM brands bq WHERE bq.client_id = c.id AND ${searchBrands.sql} AND bq.name LIKE ? COLLATE utf8mb4_0900_ai_ci))`,
      );
      params.push(...columns.map(() => like), ...searchBrands.params, like);
    }
    const rows = await db.all(
      `SELECT c.*,
         (SELECT COUNT(*) FROM projects p JOIN brands pb ON pb.id = p.brand_id
           WHERE pb.client_id = c.id AND p.status NOT IN ('archived', 'delivered') AND ${projectScope.sql}) AS project_count,
         (SELECT COUNT(*) FROM users u WHERE u.role = 'client' AND u.client_id = c.id AND u.status != 'disabled') AS user_count
        FROM clients c WHERE ${where.join(" AND ")}
        ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, c.name COLLATE utf8mb4_0900_ai_ci`,
      [...projectScope.params, ...params],
    );
    const ids = rows.map((row) => row.id);
    const brandScope = scopeSql.brands(req, "b");
    const brands = new Map(ids.map((id) => [id, []]));
    if (ids.length)
      for (const row of await db.all(
        `SELECT b.id, b.name, b.slug, b.status, b.client_id FROM brands b
          WHERE b.client_id IN (${placeholders(ids)}) AND ${brandScope.sql}
          ORDER BY b.status = 'archived', b.name COLLATE utf8mb4_0900_ai_ci`,
        [...ids, ...brandScope.params],
      ))
        brands.get(row.client_id).push({ id: row.id, name: row.name, slug: row.slug, status: row.status });
    const designer = req.user.role === "designer";
    const items = rows.map((row) => ({
      id: row.id,
      name: row.name,
      legalName: row.legal_name ?? null,
      status: row.status,
      brandCount: brands.get(row.id).filter((b) => b.status === "active").length,
      brands: brands.get(row.id),
      projectCount: row.project_count,
      userCount: designer ? null : row.user_count,
      contactName: designer ? null : (row.contact_name ?? null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    res.json({ items, total: items.length, permissions: { canCreate: can(req.user, "clients.create") } });
  });

  router.post("/api/clients", requireCap("clients.create"), async (req, res) => {
    const input = parse(clientCreateSchema, req.body);
    if (input.user && await db.get("SELECT id FROM users WHERE email = ?", [input.user.email]))
      throw validation({ "user.email": "Já existe um acesso com este e-mail." });
    const managerIds = [...new Set(input.managerIds ?? [])];
    for (const managerId of managerIds) await assertManagerTarget(db, managerId);
    const id = newId("cli");
    const at = now();
    let brandId = null;
    let userId = null;
    await db.tx(async () => {
      await db.run(
        `INSERT INTO clients (id, name, legal_name, document, contact_name, contact_email, contact_phone, status,
           internal_notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.legalName ?? null,
          input.document ?? null,
          input.contactName ?? null,
          input.contactEmail ?? null,
          input.contactPhone ?? null,
          input.internalNotes ?? null,
          req.user.id,
          at,
          at,
        ],
      );
      await logActivity(req, {
        action: "client.created",
        entityType: "client",
        entityId: id,
        clientId: id,
        summary: `Cliente ${input.name} criado.`,
      });
      if (input.brand) brandId = await insertBrand(req, id, input.brand);
      for (const managerId of managerIds)
        await db.run("INSERT INTO staff_client_access (user_id, client_id, granted_by, granted_at) VALUES (?, ?, ?, ?)", [managerId, id, req.user.id, at]);
      if (managerIds.length)
        await logActivity(req, {
          action: "client.managers_changed",
          entityType: "client",
          entityId: id,
          clientId: id,
          summary: `${managerIds.length === 1 ? "1 gestor recebeu" : `${managerIds.length} gestores receberam`} acesso ao cliente ${input.name}.`,
          data: { added: managerIds },
        });
      for (const managerId of managerIds) await notifyAccessGranted(req, { id: managerId }, [id]);
      if (input.user) userId = await insertClientUser(req, id, input.user);
    });
    let invite = {};
    let user = null;
    if (userId) {
      const row = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
      invite = await deliverInvite(req, row, { clientName: input.name });
      user = { ...serializeUser(req, row), invite: (await inviteInfo(db, [userId])).get(userId) ?? null };
    }
    res.status(201).json({
      client: await clientSummary(req, id),
      brand: brandId ? serializeBrand(req, await db.get("SELECT b.*, c.name AS client_name FROM brands b JOIN clients c ON c.id = b.client_id WHERE b.id = ?", [brandId])) : null,
      user,
      ...invite,
    });
  });

  router.get("/api/clients/:id", requireCap("clients.view"), async (req, res) => {
    const row = await assertClient(req, req.params.id);
    const permissions = clientPermissions(req);
    const brands = await brandsWithCounts(req, "b.client_id = ?", [row.id]);
    const projects = permissions.canViewProjects ? await listProjects(req, { clientId: row.id, archived: true }) : [];
    const client = serializeClient(req, row);
    if (req.user.role !== "designer") {
      const materials = await db.get(
        `SELECT COUNT(*) AS n, SUM(m.visibility = 'released') AS released, MAX(m.released_at) AS last_release
           FROM materials m JOIN brands b ON b.id = m.brand_id WHERE b.client_id = ? AND m.archived_at IS NULL`,
        [row.id],
      );
      client.stats = {
        materials: permissions.canViewLibrary ? materials.n : null,
        released: permissions.canViewLibrary ? (materials.released ?? 0) : null,
        lastReleaseAt: permissions.canViewLibrary ? (materials.last_release ?? null) : null,
      };
    }
    res.json({
      client,
      brands,
      users: permissions.canViewUsers ? await clientUsers(req, row.id) : [],
      projects,
      managers: permissions.canViewTeam ? await clientManagers(req, row.id) : [],
      email: { configured: ctx.mailer.isConfigured() },
      permissions,
    });
  });

  router.patch("/api/clients/:id", requireCap("clients.edit", "brands.edit"), async (req, res) => {
    const row = await assertClient(req, req.params.id);
    const input = parse(clientPatchSchema, req.body);
    const keys = Object.keys(input).filter((key) => input[key] !== undefined);
    if (!can(req.user, "clients.edit")) {
      const blocked = keys.filter((key) => !MANAGER_FIELDS.has(key) && (input[key] ?? null) !== (row[CLIENT_COLUMNS[key]] ?? null));
      if (blocked.length)
        throw forbidden(
          `Somente administradores alteram ${blocked.map((key) => FIELD_LABELS[key]).join(", ")}. Você pode atualizar contatos e notas internas.`,
        );
    }
    const changed = keys.filter((key) => (input[key] ?? null) !== (row[CLIENT_COLUMNS[key]] ?? null));
    if (changed.length) {
      await db.tx(async () => {
        await db.run(
          `UPDATE clients SET ${changed.map((key) => `${CLIENT_COLUMNS[key]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
          [...changed.map((key) => input[key] ?? null), now(), row.id],
        );
        const statusChanged = changed.includes("status");
        await logActivity(req, {
          action: statusChanged ? "client.status_changed" : "client.updated",
          entityType: "client",
          entityId: row.id,
          clientId: row.id,
          summary: statusChanged
            ? `Cliente ${input.name ?? row.name} marcado como ${STATUS_LABELS[input.status]}.`
            : `Dados do cliente ${input.name ?? row.name} atualizados (${changed.map((key) => FIELD_LABELS[key]).join(", ")}).`,
          data: { fields: changed },
        });
      });
    }
    res.json({ client: await clientSummary(req, row.id) });
  });

  // ---------------------------------------------------------------- client users

  router.get("/api/clients/:id/users", requireCap("clients.view"), async (req, res) => {
    const row = await assertClient(req, req.params.id);
    if (req.user.role === "designer") throw forbidden();
    const items = await clientUsers(req, row.id);
    res.json({ items, total: items.length, email: { configured: ctx.mailer.isConfigured() } });
  });

  router.post("/api/clients/:id/users", requireCap("clients.edit", "brands.edit"), async (req, res) => {
    const client = await assertClient(req, req.params.id);
    if (client.status === "archived") throw conflict("Este cliente está arquivado. Reative-o antes de convidar pessoas.", "client_archived");
    const input = parse(userInviteSchema, req.body);
    let userId;
    await db.tx(async () => {
      userId = await insertClientUser(req, client.id, input);
    });
    const row = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
    const invite = await deliverInvite(req, row, { clientName: client.name });
    res.status(201).json({ user: { ...serializeUser(req, row), invite: (await inviteInfo(db, [userId])).get(userId) ?? null }, ...invite });
  });

  router.patch("/api/clients/:id/users/:userId", requireCap("clients.edit", "brands.edit"), async (req, res) => {
    const client = await assertClient(req, req.params.id);
    const target = await db.get("SELECT * FROM users WHERE id = ? AND role = 'client' AND client_id = ?", [req.params.userId, client.id]);
    if (!target) throw notFound();
    const input = parse(clientUserPatchSchema, req.body);
    let nextStatus = input.status;
    if (nextStatus === "active" && !target.password_hash) nextStatus = "invited";
    const statusChange = nextStatus !== undefined && nextStatus !== target.status;
    const nameChange = input.name !== undefined && input.name !== target.name;
    if (statusChange || nameChange) {
      await db.tx(async () => {
        await db.run("UPDATE users SET name = ?, status = ?, updated_at = ? WHERE id = ?", [
          nameChange ? input.name : target.name,
          statusChange ? nextStatus : target.status,
          now(),
          target.id,
        ]);
        if (statusChange && nextStatus === "disabled") await cutAccess(db, target.id);
        await logActivity(req, {
          action: statusChange ? (nextStatus === "disabled" ? "user.disabled" : "user.enabled") : "user.updated",
          entityType: "user",
          entityId: target.id,
          clientId: client.id,
          summary: statusChange
            ? nextStatus === "disabled"
              ? `Acesso de ${target.name} desativado.`
              : `Acesso de ${target.name} reativado.`
            : `Nome de ${target.name} atualizado para ${input.name}.`,
        });
      });
    }
    const fresh = await db.get("SELECT * FROM users WHERE id = ?", [target.id]);
    res.json({ user: { ...serializeUser(req, fresh), invite: (await inviteInfo(db, [fresh.id])).get(fresh.id) ?? null } });
  });

  // ---------------------------------------------------------------- managers with access

  router.post("/api/clients/:id/managers", requireCap("team.manage"), async (req, res) => {
    const client = await assertClient(req, req.params.id);
    const { userId } = parse(managerSchema, req.body);
    const manager = await assertManagerTarget(db, userId);
    const exists = await db.get("SELECT 1 AS yes FROM staff_client_access WHERE user_id = ? AND client_id = ?", [manager.id, client.id]);
    if (!exists) {
      await db.tx(async () => {
        await db.run("INSERT INTO staff_client_access (user_id, client_id, granted_by, granted_at) VALUES (?, ?, ?, ?)", [manager.id, client.id, req.user.id, now()]);
        await logActivity(req, {
          action: "client.manager_added",
          entityType: "client",
          entityId: client.id,
          clientId: client.id,
          summary: `${manager.name} recebeu acesso ao cliente ${client.name}.`,
          data: { userId: manager.id },
        });
        if (manager.status !== "disabled") await notifyAccessGranted(req, manager, [client.id]);
      });
    }
    res.status(exists ? 200 : 201).json({ managers: await clientManagers(req, client.id) });
  });

  router.delete("/api/clients/:id/managers/:userId", requireCap("team.manage"), async (req, res) => {
    const client = await assertClient(req, req.params.id);
    const manager = await db.get("SELECT * FROM users WHERE id = ?", [req.params.userId]);
    const { changes } = manager
      ? await db.run("DELETE FROM staff_client_access WHERE user_id = ? AND client_id = ?", [manager.id, client.id])
      : { changes: 0 };
    if (!changes) throw notFound();
    await logActivity(req, {
      action: "client.manager_removed",
      entityType: "client",
      entityId: client.id,
      clientId: client.id,
      summary: `${manager.name} deixou de acessar o cliente ${client.name}.`,
      data: { userId: manager.id },
    });
    res.json({ managers: await clientManagers(req, client.id) });
  });

  // ---------------------------------------------------------------- brands

  router.get("/api/brands", requireAuth, async (req, res) => {
    const where = ["1 = 1"];
    const params = [];
    if (req.query.clientId) {
      where.push("b.client_id = ?");
      params.push(String(req.query.clientId));
    }
    const status = req.user.role === "client" ? "active" : typeof req.query.status === "string" ? req.query.status : "";
    if (status === "active" || status === "archived") {
      where.push("b.status = ?");
      params.push(status);
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push("(b.name LIKE ? COLLATE utf8mb4_0900_ai_ci OR c.name LIKE ? COLLATE utf8mb4_0900_ai_ci)");
      params.push(like, like);
    }
    const items = await brandsWithCounts(req, where.join(" AND "), params);
    res.json({ items, total: items.length });
  });

  router.post("/api/clients/:id/brands", requireCap("brands.edit"), async (req, res) => {
    const client = await assertClient(req, req.params.id);
    const input = parse(brandCreateSchema, req.body);
    await assertBrandName(db, client.id, input.name);
    let id;
    await db.tx(async () => {
      id = await insertBrand(req, client.id, input);
    });
    const [brand] = await brandsWithCounts(req, "b.id = ?", [id]);
    res.status(201).json({ brand });
  });

  router.get("/api/brands/:id", requireAuth, async (req, res) => {
    const row = await assertBrand(req, req.params.id);
    if (req.user.role === "client" && row.status !== "active") throw notFound();
    const [brand] = await brandsWithCounts(req, "b.id = ?", [row.id]);
    if (!brand) throw notFound();
    res.json({ brand });
  });

  router.patch("/api/brands/:id", requireCap("brands.edit"), async (req, res) => {
    const row = await assertBrand(req, req.params.id);
    const input = parse(brandPatchSchema, req.body);
    if (input.name !== undefined && input.name !== row.name) await assertBrandName(db, row.client_id, input.name, row.id);
    // Guideline fields only change the team's draft; the identity release
    // publishes them (routes/brandlib.js, D3).
    const columns = {
      name: "name",
      description: "description",
      internalNotes: "internal_notes",
      status: "status",
    };
    const changed = Object.keys(columns).filter((key) => input[key] !== undefined && (input[key] ?? null) !== (row[columns[key]] ?? null));
    const at = now();
    await db.tx(async () => {
      const guidelines = await saveGuidelineDraft(
        db,
        row,
        { usage: input.usageGuidelines, typography: input.typographyGuidelines },
        { userId: req.user.id, at },
      );
      if (!changed.length && !guidelines.changed) return;
      if (changed.length)
        await db.run(`UPDATE brands SET ${changed.map((key) => `${columns[key]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [
          ...changed.map((key) => input[key] ?? null),
          at,
          row.id,
        ]);
      const fields = [
        ...changed,
        ...(guidelines.fields.includes("usage") ? ["usageGuidelines"] : []),
        ...(guidelines.fields.includes("typography") ? ["typographyGuidelines"] : []),
      ];
      const archived = changed.includes("status");
      await logActivity(req, {
        action: archived ? (input.status === "archived" ? "brand.archived" : "brand.restored") : "brand.updated",
        entityType: "brand",
        entityId: row.id,
        brandId: row.id,
        clientId: row.client_id,
        summary: archived
          ? `Marca ${input.name ?? row.name} ${input.status === "archived" ? "arquivada" : "reativada"}.`
          : guidelines.changed && !changed.length
            ? `Rascunho das orientações da marca ${row.name} atualizado.`
            : `Marca ${input.name ?? row.name} atualizada.`,
        data: { fields, ...(guidelines.changed ? { guidelinesDraft: guidelines.pending } : {}) },
      });
    });
    const [brand] = await brandsWithCounts(req, "b.id = ?", [row.id]);
    res.json({ brand });
  });

  return router;
}

