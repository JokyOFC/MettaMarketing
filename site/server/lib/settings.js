import { now } from "./time.js";

// Values in the settings table are stored as JSON text.
export const DEFAULT_SETTINGS = {
  orgName: "Metta Marketing",
  supportEmail: "suporte@mettamkt.com.br",
  defaultNotifyEmail: true,
  zipRetentionHours: 24,
};

export function getSetting(db, key, fallback = DEFAULT_SETTINGS[key]) {
  const row = db.get("SELECT value FROM settings WHERE key = ?", [key]);
  if (!row || row.value === null) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

// -> { ...DEFAULT_SETTINGS, ...stored }
export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.all("SELECT key, value FROM settings")) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

export function setSetting(db, key, value, userId = null) {
  db.run(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), userId, now()],
  );
}
