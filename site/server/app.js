import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import express from "express";
import { openDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { seed } from "./db/seed.js";
import { startJobs } from "./jobs/index.js";
import { loadSession, pruneLoginAttempts } from "./lib/auth.js";
import { csrf } from "./lib/csrf.js";
import { apiNotFound, errorHandler } from "./lib/errors.js";
import { createLogger } from "./lib/log.js";
import { createMailer } from "./lib/mailer.js";
import { createSigner } from "./lib/signed.js";
import { createStorage } from "./lib/storage.js";
import "./lib/validate.js"; // installs the pt-BR zod messages

import activityRoutes from "./routes/activity.js";
import authRoutes from "./routes/auth.js";
import brandlibRoutes from "./routes/brandlib.js";
import briefingsRoutes from "./routes/briefings.js";
import categoriesRoutes from "./routes/categories.js";
import clientsRoutes from "./routes/clients.js";
import commerceRoutes from "./routes/commerce.js";
import contentRoutes from "./routes/content.js";
import contractsRoutes from "./routes/contracts.js";
import filesRoutes from "./routes/files.js";
import kitsRoutes from "./routes/kits.js";
import materialsRoutes from "./routes/materials.js";
import notificationsRoutes from "./routes/notifications.js";
import overviewRoutes from "./routes/overview.js";
import projectsRoutes from "./routes/projects.js";
import releasesRoutes from "./routes/releases.js";
import reportsRoutes from "./routes/reports.js";
import reviewsRoutes from "./routes/reviews.js";
import settingsRoutes from "./routes/settings.js";
import teamRoutes from "./routes/team.js";
import uploadsRoutes from "./routes/uploads.js";
import webhooksRoutes from "./routes/webhooks.js";
import zipsRoutes from "./routes/zips.js";

/**
 * Opens (and migrates/seeds) the database and builds the shared context:
 * ctx = { config, db, storage, mailer, jobs, signer, log }.
 * Pass { jobs: false } to skip the workers (scripts).
 */
export function createContext(config, { jobs = true, log } = {}) {
  const logger = log ?? createLogger(config.logLevel);
  mkdirSync(config.dataDir, { recursive: true });
  if (config.dbFile !== ":memory:") mkdirSync(dirname(config.dbFile), { recursive: true });
  const db = openDb(config.dbFile);
  migrate(db);
  seed(db);
  pruneLoginAttempts(db);
  const ctx = {
    config,
    db,
    storage: createStorage(config),
    mailer: createMailer({ config, db, log: logger }),
    signer: createSigner(config.appSecret),
    jobs: null,
    log: logger,
  };
  if (jobs) ctx.jobs = startJobs(ctx);
  return ctx;
}

// Tiny cookie parser (no dependency). Keeps the first value of each name.
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || name in out) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function securityHeaders(config) {
  return function setSecurityHeaders(req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (config.isProduction && req.secure)
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}

// Mounting order for the domain routers (each exports (ctx) => Router with
// full /api/... or /dl/... paths). webhooks is mounted before the JSON
// parser so it can read the raw body itself.
const ROUTERS = [
  authRoutes,
  uploadsRoutes,
  materialsRoutes,
  releasesRoutes,
  kitsRoutes,
  filesRoutes,
  zipsRoutes,
  brandlibRoutes,
  contentRoutes,
  reviewsRoutes,
  clientsRoutes,
  teamRoutes,
  projectsRoutes,
  commerceRoutes,
  contractsRoutes,
  briefingsRoutes,
  notificationsRoutes,
  settingsRoutes,
  categoriesRoutes,
  overviewRoutes,
  reportsRoutes,
  activityRoutes,
];

/**
 * createApp(ctx, { extend }) -> express app. extend(app) runs after the API
 * routers and before the 404/error handlers (index.js serves dist/ there).
 */
export function createApp(ctx, { extend } = {}) {
  const { config } = ctx;
  const app = express();
  app.set("trust proxy", config.trustProxy);
  app.set("case sensitive routing", true);
  app.disable("x-powered-by");
  app.set("etag", false);
  app.locals.ctx = ctx;

  app.use(securityHeaders(config));
  app.use((req, res, next) => {
    req.ctx = ctx;
    req.cookies = parseCookies(req.headers.cookie);
    const path = req.path.toLowerCase();
    if (path.startsWith("/api/") || path.startsWith("/dl/") || path === "/api" || path === "/dl")
      res.setHeader("Cache-Control", "no-store");
    // The domain routers match case-insensitively; the API only answers on its
    // canonical lower-case prefix, so "/API/..." never reaches a route.
    if (/^\/(api|dl)(\/|$)/i.test(req.path) && !/^\/(api|dl)(\/|$)/.test(req.path)) return apiNotFound(req, res);
    next();
  });

  app.use(webhooksRoutes(ctx));
  app.use(express.json({ limit: "1mb" }));
  app.use(loadSession(ctx));
  app.use(csrf(ctx));

  for (const routes of ROUTERS) app.use(routes(ctx));

  app.use(["/api", "/dl"], apiNotFound);
  if (extend) extend(app);
  app.use(errorHandler(ctx));
  return app;
}
