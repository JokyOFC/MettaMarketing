import { now } from "./time.js";

/**
 * logActivity(req | ctx, { action, entityType, entityId, clientId, brandId,
 *   projectId, materialId, summary, data, visibility }) -> id
 *
 * summary is a short pt-BR sentence shown in history screens. visibility
 * 'client' entries may be shown to the client's own users; everything else is
 * staff-only. Missing brand/client ids are derived from the material/brand.
 */
export async function logActivity(source, entry) {
  const ctx = source?.ctx ?? source;
  const db = ctx.db;
  const user = source?.user ?? null;
  let { clientId = null, brandId = null, projectId = null, materialId = null } = entry;

  if (materialId && (!brandId || projectId === null)) {
    const material = await db.get("SELECT brand_id, project_id FROM materials WHERE id = ?", [materialId]);
    if (material) {
      brandId ??= material.brand_id;
      projectId ??= material.project_id;
    }
  }
  if (projectId && !brandId) brandId = (await db.get("SELECT brand_id FROM projects WHERE id = ?", [projectId]))?.brand_id ?? null;
  if (brandId && !clientId) clientId = (await db.get("SELECT client_id FROM brands WHERE id = ?", [brandId]))?.client_id ?? null;

  const data = entry.data === undefined || entry.data === null ? null : JSON.stringify(entry.data);
  const result = await db.run(
    `INSERT INTO activity_log (actor_id, actor_role, action, entity_type, entity_id, client_id,
       brand_id, project_id, material_id, summary, data, visibility, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.actorId ?? user?.id ?? null,
      entry.actorRole ?? user?.role ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      clientId,
      brandId,
      projectId,
      materialId,
      String(entry.summary ?? entry.action),
      data,
      entry.visibility === "client" ? "client" : "internal",
      source?.ip ?? null,
      now(),
    ],
  );
  return Number(result.lastInsertRowid);
}

// SELECT used by activity lists; pair with serializeActivity().
export const ACTIVITY_SELECT = `SELECT a.*, u.name AS actor_name, cl.name AS client_name, br.name AS brand_name
  FROM activity_log a
  LEFT JOIN users u ON u.id = a.actor_id
  LEFT JOIN clients cl ON cl.id = a.client_id
  LEFT JOIN brands br ON br.id = a.brand_id`;
