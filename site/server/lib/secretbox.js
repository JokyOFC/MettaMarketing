// Encrypts small secrets kept in the database (e.g. the AssinaVelox webhook
// secret returned once by the API) with AES-256-GCM. The key is derived from
// APP_SECRET, so a copied database alone does not reveal them.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";

function keyFor(appSecret, purpose) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(String(appSecret)), Buffer.alloc(0), `metta:${purpose}`, 32));
}

/** seal(appSecret, purpose, text) -> "v1.<iv>.<tag>.<data>" (base64url parts). */
export function seal(appSecret, purpose, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(appSecret, purpose), iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

/** open(appSecret, purpose, sealed) -> text, or null when it cannot be read. */
export function open(appSecret, purpose, sealed) {
  if (typeof sealed !== "string") return null;
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(appSecret, purpose), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
