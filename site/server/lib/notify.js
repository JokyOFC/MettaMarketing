import { renderEmail } from "./emails.js";
import { newId } from "./ids.js";
import { now } from "./time.js";

/**
 * notify(req | ctx, userIds, { type, title, body, link, entityType, entityId,
 *   email, emailLines, actionLabel, includeSelf }) -> notification ids
 *
 * Creates in-app notifications for active (and invited) users, skipping the
 * acting user unless includeSelf. When email is true, users with
 * notify_email = 1 also get an e-mail (recorded in email_outbox; sent after
 * the surrounding transaction commits). link is an app path such as
 * /painel/conteudo/mat_x.
 */
export function notify(source, userIds, payload) {
  if (Array.isArray(source) || !payload) throw new Error("usage: notify(req | ctx, userIds, payload)");
  const ctx = source?.ctx ?? source;
  const { db } = ctx;
  const actorId = source?.user?.id ?? null;
  const ids = [...new Set((userIds ?? []).filter(Boolean))].filter(
    (id) => payload.includeSelf || id !== actorId,
  );
  if (!ids.length) return [];

  const users = db.all(
    `SELECT id, email, name, status, notify_email FROM users
      WHERE id IN (${ids.map(() => "?").join(", ")}) AND status IN ('active', 'invited')`,
    ids,
  );
  const createdAt = now();
  const created = [];
  for (const user of users) {
    const id = newId("ntf");
    db.run(
      `INSERT INTO notifications (id, user_id, type, title, body, link, entity_type, entity_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        user.id,
        payload.type,
        payload.title,
        payload.body ?? null,
        payload.link ?? null,
        payload.entityType ?? null,
        payload.entityId ?? null,
        createdAt,
      ],
    );
    created.push(id);
  }

  if (payload.email && ctx.mailer) {
    const recipients = users.filter((user) => user.status === "active" && user.notify_email === 1);
    const actionUrl = payload.link ? `${ctx.config.appUrl}${payload.link.startsWith("/") ? "" : "/"}${payload.link}` : null;
    for (const user of recipients) {
      const message = renderEmail({
        title: payload.title,
        intro: payload.body ?? null,
        lines: payload.emailLines ?? [],
        actionLabel: payload.actionLabel ?? "Abrir na plataforma",
        actionUrl,
      });
      db.afterCommit(() => {
        ctx.mailer.send({ to: user.email, toUserId: user.id, ...message }).catch(() => {});
      });
    }
  }
  return created;
}

// ------------------------------------------------------------- recipients

// Active users of a client account.
export function clientUserIds(db, clientId) {
  if (!clientId) return [];
  return db
    .all("SELECT id FROM users WHERE role = 'client' AND client_id = ? AND status = 'active'", [clientId])
    .map((row) => row.id);
}

// Managers with access to the client.
export function managerIdsForClient(db, clientId) {
  if (!clientId) return [];
  return db
    .all(
      `SELECT u.id FROM users u JOIN staff_client_access a ON a.user_id = u.id
        WHERE a.client_id = ? AND u.role = 'manager' AND u.status = 'active'`,
      [clientId],
    )
    .map((row) => row.id);
}

export function adminIds(db) {
  return db.all("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").map((row) => row.id);
}

// Staff responsible for a material: owner, creator, project members and the
// managers of its client.
export function staffIdsForMaterial(db, material) {
  if (!material) return [];
  const clientId =
    material.client_id ?? db.get("SELECT client_id FROM brands WHERE id = ?", [material.brand_id])?.client_id;
  const ids = new Set();
  const staff = (id) => {
    if (!id) return;
    const row = db.get("SELECT role, status FROM users WHERE id = ?", [id]);
    if (row && row.role !== "client" && row.status === "active") ids.add(id);
  };
  staff(material.owner_id);
  staff(material.created_by);
  if (material.project_id) {
    for (const row of db.all(
      `SELECT pm.user_id FROM project_members pm JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ? AND u.status = 'active'`,
      [material.project_id],
    ))
      ids.add(row.user_id);
  }
  for (const id of managerIdsForClient(db, clientId)) ids.add(id);
  return [...ids];
}

// Managers of the brand's client plus members of the brand's projects.
export function staffForBrand(db, brandId) {
  const brand = db.get("SELECT client_id FROM brands WHERE id = ?", [brandId]);
  if (!brand) return [];
  const ids = new Set(managerIdsForClient(db, brand.client_id));
  for (const row of db.all(
    `SELECT DISTINCT pm.user_id FROM project_members pm
       JOIN projects p ON p.id = pm.project_id JOIN users u ON u.id = pm.user_id
      WHERE p.brand_id = ? AND u.status = 'active'`,
    [brandId],
  ))
    ids.add(row.user_id);
  return [...ids];
}

// Aliases named in docs/PLATFORM.md §4.
export const usersForClient = clientUserIds;
