// In-app notifications (slice H). Every route works only on the caller's own
// rows; someone else's id answers 404.
import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { serializeNotification } from "../lib/serialize.js";
import { now } from "../lib/time.js";
import { paginate, queryBool } from "../lib/validate.js";

export default function notificationsRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  const unreadCount = (userId) =>
    db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", [userId]).n;

  // ?unread=1&page=&pageSize= -> { items, total, unread, page, pageSize }
  router.get("/api/notifications", requireAuth, (req, res) => {
    const { page, pageSize, limit, offset } = paginate(req.query, { defaultSize: 30, max: 100 });
    const onlyUnread = queryBool(req.query.unread);
    const where = onlyUnread ? "user_id = ? AND read_at IS NULL" : "user_id = ?";
    const total = db.get(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`, [req.user.id]).n;
    const rows = db.all(
      `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset],
    );
    res.json({
      items: rows.map(serializeNotification),
      total,
      unread: onlyUnread ? total : unreadCount(req.user.id),
      page,
      pageSize,
    });
  });

  router.get("/api/notifications/unread-count", requireAuth, (req, res) => {
    res.json({ unread: unreadCount(req.user.id) });
  });

  router.post("/api/notifications/read-all", requireAuth, (req, res) => {
    const { changes } = db.run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", [
      now(),
      req.user.id,
    ]);
    res.json({ updated: changes, unread: 0 });
  });

  router.post("/api/notifications/:id/read", requireAuth, (req, res) => {
    const row = db.get("SELECT * FROM notifications WHERE id = ? AND user_id = ?", [String(req.params.id), req.user.id]);
    if (!row) throw notFound();
    if (!row.read_at) {
      row.read_at = now();
      db.run("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL", [row.read_at, row.id]);
    }
    res.json({ notification: serializeNotification(row), unread: unreadCount(req.user.id) });
  });

  return router;
}
