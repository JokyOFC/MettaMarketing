import { now } from "./time.js";

// Values in the settings table are stored as JSON text, one row per name.
export const DEFAULT_SETTINGS = {
  orgName: "Metta Marketing",
  supportEmail: "suporte@mettamkt.com.br",
  defaultNotifyEmail: true,
  zipRetentionHours: 24,
  // /cadastro accepts new client accounts
  signupEnabled: true,
};

export async function getSetting(db, key, fallback = DEFAULT_SETTINGS[key]) {
  const row = await db.get("SELECT value FROM settings WHERE name = ?", [key]);
  if (!row || row.value === null) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

// -> { ...DEFAULT_SETTINGS, ...stored }
export async function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of await db.all("SELECT name, value FROM settings")) {
    try {
      out[row.name] = JSON.parse(row.value);
    } catch {
      out[row.name] = row.value;
    }
  }
  return out;
}

export async function setSetting(db, key, value, userId = null) {
  await db.run(
    `INSERT INTO settings (name, value, updated_by, updated_at) VALUES (?, ?, ?, ?) AS incoming
     ON DUPLICATE KEY UPDATE value = incoming.value, updated_by = incoming.updated_by, updated_at = incoming.updated_at`,
    [key, JSON.stringify(value), userId, now()],
  );
}
