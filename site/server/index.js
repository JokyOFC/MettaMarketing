import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { createApp, createContext } from "./app.js";
import { loadConfig } from "./config.js";

// Production: serves the Vite build (dist/) next to the API.
// /painel/* and /admin/* fall back to their SPA shell; clean URLs such as
// /sobre map to sobre.html; everything else gets 404.html with status 404.
function serveSite(app, config) {
  const dist = config.distDir;
  if (!existsSync(join(dist, "index.html"))) {
    console.warn(`[site] ${dist} has no build; run "npm run build" to serve the site.`);
    return;
  }
  const read = (file) => {
    const full = join(dist, file);
    return existsSync(full) ? readFileSync(full, "utf8") : null;
  };
  const notFoundHtml = read("404.html") ?? "<!doctype html><title>Página não encontrada</title>";
  const shells = {
    painel: read("painel.html") ?? notFoundHtml,
    admin: read("admin.html") ?? notFoundHtml,
    convite: read("convite.html") ?? notFoundHtml,
    reset: read("redefinir-senha.html") ?? notFoundHtml,
  };
  const sendHtml = (res, html, status = 200) => {
    res.status(status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(html);
  };

  app.use(
    "/assets",
    express.static(join(dist, "assets"), {
      immutable: true,
      maxAge: "1y",
      index: false,
      fallthrough: true,
    }),
  );
  app.use(
    express.static(dist, {
      index: "index.html",
      extensions: ["html"],
      redirect: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
        else res.setHeader("Cache-Control", "public, max-age=3600");
      },
    }),
  );
  app.get(["/painel", "/painel/*splat"], (req, res) => sendHtml(res, shells.painel));
  app.get(["/admin", "/admin/*splat"], (req, res) => sendHtml(res, shells.admin));
  // Invitation and reset links from e-mails; the page validates the token.
  app.get("/convite/:token", (req, res) => sendHtml(res, shells.convite));
  app.get("/redefinir-senha/:token", (req, res) => sendHtml(res, shells.reset));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    sendHtml(res, notFoundHtml, 404);
  });
}

const config = loadConfig();
const ctx = createContext(config);
const log = ctx.log;

if (!process.env.APP_URL && config.isProduction)
  log.warn(`APP_URL is not set; e-mail links will use ${config.appUrl}`);
if (!ctx.mailer.isConfigured()) log.info("E-mail is not configured: messages stay in the outbox as not_configured.");

const app = createApp(ctx, { extend: config.isProduction ? (instance) => serveSite(instance, config) : undefined });
const server = app.listen(config.port, config.host, () => {
  log.info(`Metta API listening on http://${config.host}:${server.address().port} (${config.env})`);
});
server.on("error", (err) => {
  log.error("Server failed to start:", err.message);
  process.exit(1);
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info(`${signal} received, shutting down…`);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  server.close();
  server.closeIdleConnections?.();
  try {
    await ctx.jobs?.stop();
    await ctx.mailer.idle();
  } catch (err) {
    log.error("Error while stopping jobs:", err);
  }
  ctx.db.close();
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
