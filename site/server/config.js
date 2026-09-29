import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// site/ (the folder that holds package.json, dist/ and server/).
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Flat keys accepted as overrides (tests) and read from the environment.
const ENV_KEYS = {
  nodeEnv: "NODE_ENV",
  port: "PORT",
  host: "HOST",
  dataDir: "DATA_DIR",
  appUrl: "APP_URL",
  appSecret: "APP_SECRET",
  maxUploadMb: "MAX_UPLOAD_MB",
  smtpUrl: "SMTP_URL",
  smtpHost: "SMTP_HOST",
  smtpPort: "SMTP_PORT",
  smtpUser: "SMTP_USER",
  smtpPass: "SMTP_PASS",
  smtpSecure: "SMTP_SECURE",
  mailFrom: "MAIL_FROM",
  mpAccessToken: "MP_ACCESS_TOKEN",
  mpWebhookSecret: "MP_WEBHOOK_SECRET",
  mpApiBase: "MP_API_BASE",
  avApiUrl: "ASSINAVELOX_API_URL",
  avToken: "ASSINAVELOX_TOKEN",
  avWebhookSecret: "ASSINAVELOX_WEBHOOK_SECRET",
  avSyncMinutes: "ASSINAVELOX_SYNC_MINUTES",
  avTimeoutMs: "ASSINAVELOX_TIMEOUT_MS",
  ffmpegPath: "FFMPEG_PATH",
  ffprobePath: "FFPROBE_PATH",
  zipRetentionHours: "ZIP_RETENTION_HOURS",
  trustProxy: "TRUST_PROXY",
  distDir: "DIST_DIR",
};

const blank = (value) => value === undefined || value === null || value === "";

function toInt(value, fallback, name) {
  if (blank(value)) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.floor(n);
}

function toBool(value, fallback = false) {
  if (blank(value)) return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parseTrustProxy(value) {
  if (blank(value)) return false;
  if (typeof value === "boolean" || typeof value === "number") return value;
  const text = String(value).trim();
  if (/^(true|yes|on)$/i.test(text)) return true;
  if (/^(false|no|off|0)$/i.test(text)) return false;
  if (/^\d+$/.test(text)) return Number(text);
  return text; // "loopback", "10.0.0.0/8, 127.0.0.1" …
}

// Returns the absolute path of an executable on PATH, or null.
export function findOnPath(name) {
  const dirs = (process.env.PATH || process.env.Path || "").split(delimiter).filter(Boolean);
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = join(dir.replace(/^"|"$/g, ""), candidate);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function resolveBinary(explicit, name) {
  if (explicit === null || explicit === false) return null;
  if (!blank(explicit)) return existsSync(explicit) ? explicit : null;
  return findOnPath(name);
}

// Dev/test: APP_SECRET is generated once and kept in DATA_DIR/.secret.
function persistedSecret(dataDir) {
  const file = join(dataDir, ".secret");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // generate below
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(48).toString("base64url");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

/**
 * Builds the runtime configuration from the environment. `overrides` takes
 * the flat camelCase keys above (tests pass { dataDir, appSecret, nodeEnv… });
 * `smtp`, `mercadopago`, `assinavelox` and `mailTransport` objects are accepted as well.
 */
export function loadConfig(overrides = {}) {
  const flat = {};
  for (const [key, envName] of Object.entries(ENV_KEYS)) flat[key] = process.env[envName];
  for (const key of Object.keys(ENV_KEYS)) if (key in overrides) flat[key] = overrides[key];
  if (overrides.mercadopago) {
    const mp = overrides.mercadopago;
    if ("accessToken" in mp) flat.mpAccessToken = mp.accessToken;
    if ("webhookSecret" in mp) flat.mpWebhookSecret = mp.webhookSecret;
    if ("apiBase" in mp) flat.mpApiBase = mp.apiBase;
  }
  if (overrides.assinavelox) {
    const av = overrides.assinavelox;
    for (const [from, to] of [["apiUrl", "avApiUrl"], ["token", "avToken"], ["webhookSecret", "avWebhookSecret"], ["syncMinutes", "avSyncMinutes"], ["timeoutMs", "avTimeoutMs"]])
      if (from in av) flat[to] = av[from];
  }
  if (overrides.smtp) {
    const s = overrides.smtp;
    for (const [from, to] of [["url", "smtpUrl"], ["host", "smtpHost"], ["port", "smtpPort"], ["user", "smtpUser"], ["pass", "smtpPass"], ["secure", "smtpSecure"]])
      if (from in s) flat[to] = s[from];
  }

  const env = blank(flat.nodeEnv) ? "development" : String(flat.nodeEnv);
  const isProduction = env === "production";
  const isTest = env === "test";

  const port = toInt(flat.port, 8787, "PORT");
  const host = blank(flat.host) ? "127.0.0.1" : String(flat.host);

  const dataDirRaw = blank(flat.dataDir) ? join(ROOT_DIR, "server", "data") : String(flat.dataDir);
  const dataDir = isAbsolute(dataDirRaw) ? dataDirRaw : resolve(ROOT_DIR, dataDirRaw);

  let appUrl = blank(flat.appUrl)
    ? isProduction
      ? `http://${host}:${port}`
      : "http://127.0.0.1:5173"
    : String(flat.appUrl);
  appUrl = appUrl.replace(/\/+$/, "");
  try {
    new URL(appUrl);
  } catch {
    throw new Error("APP_URL must be an absolute URL, e.g. https://mettamkt.com.br");
  }

  let appSecret = blank(flat.appSecret) ? null : String(flat.appSecret);
  if (isProduction) {
    if (!appSecret) throw new Error("APP_SECRET is required when NODE_ENV=production");
    if (appSecret.length < 32) throw new Error("APP_SECRET must have at least 32 characters");
  } else if (!appSecret) {
    appSecret = persistedSecret(dataDir);
  }

  const maxUploadMb = toInt(flat.maxUploadMb, 1024, "MAX_UPLOAD_MB") || 1024;

  const smtp = {
    url: blank(flat.smtpUrl) ? null : String(flat.smtpUrl),
    host: blank(flat.smtpHost) ? null : String(flat.smtpHost),
    port: blank(flat.smtpPort) ? null : toInt(flat.smtpPort, null, "SMTP_PORT"),
    user: blank(flat.smtpUser) ? null : String(flat.smtpUser),
    pass: blank(flat.smtpPass) ? null : String(flat.smtpPass),
    secure: toBool(flat.smtpSecure, false),
  };
  const smtpConfigured = Boolean(smtp.url || smtp.host);

  const mercadopago = {
    accessToken: blank(flat.mpAccessToken) ? null : String(flat.mpAccessToken),
    webhookSecret: blank(flat.mpWebhookSecret) ? null : String(flat.mpWebhookSecret),
    apiBase: (blank(flat.mpApiBase) ? "https://api.mercadopago.com" : String(flat.mpApiBase)).replace(/\/+$/, ""),
  };

  // AssinaVelox (contracts): API base ending in /api/v1, token with the
  // envelope, document, recipient, webhook and embedded-signing abilities.
  const assinavelox = {
    apiUrl: blank(flat.avApiUrl) ? null : String(flat.avApiUrl).replace(/\/+$/, ""),
    token: blank(flat.avToken) ? null : String(flat.avToken),
    webhookSecret: blank(flat.avWebhookSecret) ? null : String(flat.avWebhookSecret),
    syncMinutes: toInt(flat.avSyncMinutes, 5, "ASSINAVELOX_SYNC_MINUTES"),
    timeoutMs: toInt(flat.avTimeoutMs, 30000, "ASSINAVELOX_TIMEOUT_MS") || 30000,
    // Tests inject a fetch that talks to a fake AssinaVelox.
    fetch: overrides.assinavelox?.fetch ?? null,
  };
  if (assinavelox.apiUrl) {
    try {
      new URL(assinavelox.apiUrl);
    } catch {
      throw new Error("ASSINAVELOX_API_URL must be a valid URL ending in /api/v1");
    }
  }

  return {
    env,
    nodeEnv: env,
    isProduction,
    isTest,
    port,
    host,
    rootDir: ROOT_DIR,
    distDir: blank(flat.distDir) ? join(ROOT_DIR, "dist") : resolve(ROOT_DIR, String(flat.distDir)),
    dataDir,
    storageDir: join(dataDir, "storage"),
    tmpDir: join(dataDir, "tmp"),
    dbFile: overrides.dbFile ?? join(dataDir, "metta.db"),
    appUrl,
    appSecret,
    maxUploadMb,
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    smtp,
    smtpConfigured,
    mailFrom: blank(flat.mailFrom) ? "Metta Marketing <nao-responda@mettamkt.com.br>" : String(flat.mailFrom),
    // Tests may inject a nodemailer transport (e.g. { jsonTransport: true }).
    mailTransport: overrides.mailTransport ?? null,
    mercadopago,
    mpAccessToken: mercadopago.accessToken,
    mpWebhookSecret: mercadopago.webhookSecret,
    mpApiBase: mercadopago.apiBase,
    assinavelox,
    ffmpegPath: resolveBinary(flat.ffmpegPath, "ffmpeg"),
    ffprobePath: resolveBinary(flat.ffprobePath, "ffprobe"),
    zipRetentionHours: toInt(flat.zipRetentionHours, 24, "ZIP_RETENTION_HOURS") || 24,
    trustProxy: parseTrustProxy(flat.trustProxy),
    logLevel: overrides.logLevel ?? (isTest ? "error" : "info"),
  };
}
