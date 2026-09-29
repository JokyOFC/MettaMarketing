// Base serializers. Everything that leaves the API goes through a
// serializer that picks fields explicitly; internal fields are dropped for
// the client role here, not in the interface.

import { guidelineDraft } from "./guidelines.js";
import { capabilitiesFor } from "./permissions.js";

export const isStaff = (req) => Boolean(req?.user) && req.user.role !== "client";
export const isClientViewer = (req) => req?.user?.role === "client";

export const bool = (value) => value === 1 || value === true;

export function parseJson(text, fallback) {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// UserRef = { id, name, role }
export function userRef(row) {
  if (!row || !row.id) return null;
  return { id: row.id, name: row.name, role: row.role };
}

// Team members appear to clients by name only ("dados de equipe" stay
// internal). Accepts a row with id/name/role or prefixed columns.
export function personRef(req, row) {
  if (!row || !row.id) return null;
  if (isStaff(req) || row.role === "client") return userRef(row);
  return { name: row.name };
}

export function brandRef(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, slug: row.slug, clientId: row.client_id };
}

// Me = { id, name, email, role, status, jobTitle, notifyEmail, client, brands, capabilities }
export async function serializeMe(req, user) {
  const db = req.ctx.db;
  let client = null;
  let brands = [];
  if (user.role === "client" && user.client_id) {
    const row = await db.get("SELECT id, name FROM clients WHERE id = ?", [user.client_id]);
    client = row ? { id: row.id, name: row.name } : null;
    brands = (await db
      .all("SELECT id, name, slug, client_id FROM brands WHERE client_id = ? AND status = 'active' ORDER BY name", [
        user.client_id,
      ]))
      .map(brandRef);
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    jobTitle: user.job_title ?? null,
    phone: user.phone ?? null,
    notifyEmail: bool(user.notify_email),
    client,
    brands,
    capabilities: user.capabilities ?? capabilitiesFor(user.role),
  };
}

// Staff-facing user (team lists, client users). Clients get their own
// colleagues without internal metadata.
export function serializeUser(req, row) {
  if (!row) return null;
  const base = {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    jobTitle: row.job_title ?? null,
  };
  if (!isStaff(req)) return base;
  return {
    ...base,
    phone: row.phone ?? null,
    clientId: row.client_id ?? null,
    notifyEmail: bool(row.notify_email),
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeClient(req, row) {
  if (!row) return null;
  const role = req?.user?.role;
  const base = { id: row.id, name: row.name, legalName: row.legal_name ?? null, status: row.status, createdAt: row.created_at };
  // designers get the basic record only (clients.view scoped to projects)
  if (role === "designer") return base;
  const contact = {
    ...base,
    document: row.document ?? null,
    contactName: row.contact_name ?? null,
    contactEmail: row.contact_email ?? null,
    contactPhone: row.contact_phone ?? null,
    updatedAt: row.updated_at,
  };
  if (!isStaff(req)) return contact;
  // source: 'staff' (created by the team) | 'signup' (self sign-up at /cadastro)
  return { ...contact, internalNotes: row.internal_notes ?? null, source: row.source ?? "staff" };
}

// Brand = { id, clientId, client:{id,name}, name, slug, description,
//           usageGuidelines, typographyGuidelines (RELEASED text only), status, createdAt,
//           staff: internalNotes, usageGuidelinesDraft, typographyGuidelinesDraft,
//                  hasUnreleasedGuidelines, guidelinesDraftAt, guidelinesReleasedAt }
// Guideline drafts never reach the client (lib/guidelines.js, D3).
export function serializeBrand(req, row) {
  if (!row) return null;
  const brand = {
    id: row.id,
    clientId: row.client_id,
    client: row.client_name !== undefined ? { id: row.client_id, name: row.client_name } : null,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    usageGuidelines: row.usage_guidelines ?? null,
    typographyGuidelines: row.typography_guidelines ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (isStaff(req)) {
    brand.internalNotes = row.internal_notes ?? null;
    const draft = guidelineDraft(row);
    brand.usageGuidelinesDraft = draft.usage;
    brand.typographyGuidelinesDraft = draft.typography;
    brand.hasUnreleasedGuidelines = draft.pending;
    brand.guidelinesDraftAt = draft.pending ? (row.guidelines_draft_at ?? null) : null;
    brand.guidelinesReleasedAt = row.guidelines_released_at ?? null;
  }
  return brand;
}

// Category = { id, slug, name, area, folder, sortOrder, isSystem, archivedAt }
export function serializeCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    area: row.area,
    folder: row.folder,
    sortOrder: row.sort_order,
    isSystem: bool(row.is_system),
    archivedAt: row.archived_at ?? null,
  };
}

// Activity rows from ACTIVITY_SELECT (lib/audit.js).
export function serializeActivity(req, row) {
  const staff = isStaff(req);
  let actor = null;
  if (row.actor_id) {
    const ref = { id: row.actor_id, name: row.actor_name ?? "Usuário removido", role: row.actor_role };
    actor = staff || row.actor_role === "client" ? ref : { name: ref.name };
  }
  const activity = {
    id: row.id,
    actor,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    client: row.client_id ? { id: row.client_id, name: row.client_name ?? null } : null,
    brand: row.brand_id ? { id: row.brand_id, name: row.brand_name ?? null } : null,
    projectId: row.project_id ?? null,
    materialId: row.material_id ?? null,
    createdAt: row.created_at,
  };
  if (staff) {
    activity.data = parseJson(row.data, null);
    activity.visibility = row.visibility;
  }
  return activity;
}

// Notification = { id, type, title, body, link, entityType, entityId, readAt, createdAt }
export function serializeNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body ?? null,
    link: row.link ?? null,
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    readAt: row.read_at ?? null,
    createdAt: row.created_at,
  };
}
