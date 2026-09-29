// Release to the client: summary first (preview), then an atomic release.
// Only materials.release (admin, manager in scope). History of releases.
import { Router } from "express";
import { scopeSql } from "../lib/access.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { isStaff, personRef } from "../lib/serialize.js";
import { paginate, parse, schemas, z } from "../lib/validate.js";
import { loadMaterialRows, previewRelease, releaseMaterials, serializeMaterials } from "../services/materials.js";

const id = z.string().trim().min(1).max(64);
const previewSchema = z.object({
  materialIds: z.array(id).max(500).default([]),
  kitId: id.nullable().optional(),
});
const releaseSchema = previewSchema.extend({
  downloadEnabled: z.union([z.boolean(), z.record(z.string(), z.boolean()), z.null()]).optional(),
  notifyEmail: z.boolean().default(false),
  notifyApp: z.boolean().default(true),
  message: schemas.optionalText(2000),
});

export default function releasesRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  router.post("/api/releases/preview", requireAuth, requireCap("materials.release"), async (req, res) => {
    const body = parse(previewSchema, req.body);
    res.json(await previewRelease(req, body));
  });

  router.post("/api/releases", requireAuth, requireCap("materials.release"), async (req, res) => {
    const body = parse(releaseSchema, req.body);
    res.status(201).json(await releaseMaterials(req, body));
  });

  // Release history. Staff: within scope; clients: their own releases, with
  // only the materials they can currently see (and nothing internal).
  router.get("/api/releases", requireAuth, requireCap("materials.view", "portal.access"), async (req, res) => {
    const staff = isStaff(req);
    const scope = scopeSql.brands(req, "b");
    const where = [scope.sql];
    const params = [...scope.params];
    for (const [key, column] of [
      ["clientId", "r.client_id"],
      ["brandId", "r.brand_id"],
      ["kitId", "r.kit_id"],
    ]) {
      const value = typeof req.query[key] === "string" ? req.query[key] : null;
      if (value) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (typeof req.query.materialId === "string" && req.query.materialId) {
      where.push("EXISTS (SELECT 1 FROM release_items x WHERE x.release_id = r.id AND x.material_id = ?)");
      params.push(req.query.materialId);
    }
    const { limit, offset } = paginate(req.query, { defaultSize: 30, max: 200 });
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const from = `FROM releases r JOIN brands b ON b.id = r.brand_id JOIN clients c ON c.id = r.client_id
      LEFT JOIN users u ON u.id = r.actor_id LEFT JOIN kits k ON k.id = r.kit_id`;
    const total = (await db.get(`SELECT COUNT(*) AS n ${from} ${whereSql}`, params)).n;
    const rows = await db.all(
      `SELECT r.*, b.name AS brand_name, c.name AS client_name, u.name AS actor_name, u.role AS actor_role,
          k.name AS kit_name, k.status AS kit_status
         ${from} ${whereSql} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const releaseIds = rows.map((r) => r.id);
    const itemRows = releaseIds.length
      ? await db.all(
          `SELECT ri.*, v.number AS version_number FROM release_items ri
             LEFT JOIN material_versions v ON v.id = ri.version_id
            WHERE ri.release_id IN (${releaseIds.map(() => "?").join(", ")})`,
          releaseIds,
        )
      : [];
    const materialRows = await loadMaterialRows(db, [...new Set(itemRows.map((i) => i.material_id))]);
    // clients only see materials still visible to them (scopeSql rule)
    const visible = staff
      ? materialRows
      : materialRows.filter(
          (m) => m.client_id === req.user.client_id && m.visibility === "released" && !m.archived_at && m.released_version_id,
        );
    const materials = new Map((await serializeMaterials(req, visible)).map((m) => [m.id, m]));

    const items = rows
      .map((r) => {
        const entries = itemRows
          .filter((i) => i.release_id === r.id && materials.has(i.material_id))
          .map((i) => {
            const m = materials.get(i.material_id);
            return {
              materialId: i.material_id,
              title: m.title,
              kind: m.kind,
              category: m.category,
              thumb: m.thumb,
              versionId: i.version_id,
              versionNumber: i.version_number ?? null,
              downloadEnabled: i.download_enabled === 1,
            };
          });
        const release = {
          id: r.id,
          createdAt: r.created_at,
          client: { id: r.client_id, name: r.client_name },
          brand: { id: r.brand_id, name: r.brand_name },
          kit: r.kit_id && (staff || r.kit_status === "released") ? { id: r.kit_id, name: r.kit_name } : null,
          actor: r.actor_id ? personRef(req, { id: r.actor_id, name: r.actor_name, role: r.actor_role }) : null,
          message: r.message ?? null,
          items: entries,
          itemCount: entries.length,
        };
        if (staff) {
          release.notifyEmail = r.notify_email === 1;
          release.notifyApp = r.notify_app === 1;
        }
        return release;
      })
      .filter((release) => staff || release.items.length);
    res.json({ items, total: staff ? total : items.length });
  });

  return router;
}
