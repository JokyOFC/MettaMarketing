// Contracts signed through AssinaVelox (docs/API.md "Contratos").
// Staff (orders.view / orders.manage) prepare, send, follow and cancel them;
// settings.manage edits the templates and the integration; clients see their
// own contracts, sign them inside the portal and download the final files.
import { Router } from "express";
import { assertClient, scopeSql } from "../lib/access.js";
import { ACTIVITY_SELECT } from "../lib/audit.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { conflict, forbidden, notFound, rateLimited } from "../lib/errors.js";
import { fileHeaders, sendStoredFile } from "../lib/http.js";
import { isStaff } from "../lib/serialize.js";
import { can } from "../lib/permissions.js";
import { paginate, parse, schemas, z } from "../lib/validate.js";
import {
  avStatus,
  connectWebhook,
  disconnectWebhook,
  MESSAGES as AV_MESSAGES,
  testConnection,
} from "../services/assinavelox.js";
import {
  cancelContract,
  CONTRACT_SELECT,
  CONTRACT_STATUSES,
  contractCode,
  contractSettings,
  createContract,
  currentTemplate,
  FILE_KINDS,
  getContractRow,
  KINDS,
  openSigningSession,
  previewContract,
  renderTemplateExample,
  retryContract,
  saveContractSettings,
  saveTemplate,
  serializeContract,
  serializeTemplate,
  settingsIssues,
  syncContract,
  unwaiveContract,
  waiveContract,
} from "../services/contracts.js";
import { VARIABLES } from "../services/contractTemplates.js";

const optionalId = z.union([schemas.id, z.null()]).optional();

const signerSchema = z.union([
  z.object({ userId: schemas.id }),
  z.object({ name: schemas.text(120), email: schemas.email }),
]);

const createSchema = z
  .object({
    orderId: optionalId,
    subscriptionId: optionalId,
    brandId: optionalId,
    signer: signerSchema,
    expiresInDays: z.number().int().min(1).max(90).optional(),
  })
  .refine((v) => Boolean(v.orderId) !== Boolean(v.subscriptionId), { message: "Informe o pedido ou a assinatura." });

const sourceSchema = z
  .object({ orderId: optionalId, subscriptionId: optionalId })
  .refine((v) => Boolean(v.orderId) !== Boolean(v.subscriptionId), { message: "Informe o pedido ou a assinatura." });

const waiveSchema = z
  .object({ orderId: optionalId, subscriptionId: optionalId, reason: schemas.text(300) })
  .refine((v) => Boolean(v.orderId) !== Boolean(v.subscriptionId), { message: "Informe o pedido ou a assinatura." });

const cancelSchema = z.object({ reason: schemas.optionalText(300) });

const settingsSchema = z.object({
  signerName: schemas.text(120).optional(),
  signerEmail: schemas.email.optional(),
  signerRole: schemas.text(80).optional(),
  companyName: schemas.text(160).optional(),
  companyDocument: z
    .string()
    .trim()
    .regex(/^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/, "Use um CNPJ no formato 00.000.000/0000-00.")
    .optional(),
  forum: schemas.text(120).optional(),
  noticeDays: z.number().int().min(0).max(365).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  requiredBeforePayment: z.boolean().optional(),
});

const templateSchema = z.object({
  title: schemas.text(160),
  body: z.string().trim().min(40, "O contrato precisa de um texto.").max(60000, "Texto longo demais."),
});

const templatePreviewSchema = z.object({
  title: z.string().max(160).optional(),
  body: z.string().max(60000).optional(),
});

function sendPdf(res, bytes, filename) {
  const buffer = Buffer.from(bytes);
  fileHeaders(res, { mime: "application/pdf", size: buffer.length, filename, disposition: "inline" });
  res.status(200).end(buffer);
}

export default function contractsRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  // Each embedded session is created on AssinaVelox: one every 5 s per
  // person and contract is plenty for a human.
  const lastSession = new Map();
  async function openThrottled(req, row, role) {
    const key = `${req.user.id}:${row.id}`;
    if (Date.now() - (lastSession.get(key) ?? 0) < 5000)
      throw rateLimited("Aguarde alguns segundos antes de abrir a assinatura de novo.");
    const session = await openSigningSession(req, row, role);
    if (lastSession.size > 5000) lastSession.clear();
    lastSession.set(key, Date.now());
    return session;
  }

  // Staff: contract in scope (404 otherwise). Clients: only their own, and
  // only once it has been sent to them.
  function assertContract(req, id) {
    const row = getContractRow(db, id);
    if (!row) throw notFound("Não encontramos este contrato.");
    if (isStaff(req)) {
      if (!can(req.user, "orders.view")) throw notFound("Não encontramos este contrato.");
      assertClient(req, row.client_id);
    } else if (row.client_id !== req.user.client_id || ["draft", "sending", "failed"].includes(row.status)) {
      throw notFound("Não encontramos este contrato.");
    }
    return row;
  }

  function detail(req, row) {
    const staff = isStaff(req);
    const timeline = db
      .all(`${ACTIVITY_SELECT} WHERE a.entity_type = 'contract' AND a.entity_id = ? ORDER BY a.id ASC`, [row.id])
      .filter((a) => staff || a.visibility === "client")
      .map((a) => ({
        id: a.id,
        action: a.action,
        summary: a.summary,
        createdAt: a.created_at,
        actor: a.actor_id ? { name: a.actor_name ?? "Usuário removido" } : null,
      }));
    return { ...serializeContract(req, row), timeline };
  }

  // --------------------------------------------------------------- integration status (staff)

  router.get("/api/contracts/status", requireAuth, requireCap("orders.view", "settings.manage"), (req, res) => {
    const settings = contractSettings(db);
    const templates = KINDS.map((kind) => {
      const t = currentTemplate(db, kind);
      return { kind, version: t.version, reviewed: Boolean(t.created_by) };
    });
    const status = avStatus(ctx);
    const issues = [...settingsIssues(settings)];
    if (!status.configured) issues.unshift(AV_MESSAGES.notConfigured);
    for (const t of templates)
      if (!t.reviewed) issues.push("Revise e salve os modelos de contrato em Configurações › Contratos.");
    res.json({
      configured: status.configured,
      ready: status.configured && !settingsIssues(settings).length && templates.every((t) => t.reviewed),
      requiredBeforePayment: Boolean(settings.requiredBeforePayment),
      expiresInDays: settings.expiresInDays,
      signer: { name: settings.signerName || null, email: settings.signerEmail || null },
      issues: [...new Set(issues)],
      templates,
      webhookReceiving: status.webhook.receiving,
    });
  });

  // --------------------------------------------------------------- settings & templates (admin)

  router.get("/api/contracts/settings", requireAuth, requireCap("settings.manage"), (req, res) => {
    const settings = contractSettings(db);
    res.json({
      settings,
      issues: settingsIssues(settings),
      integration: avStatus(ctx),
      templates: KINDS.map((kind) => serializeTemplate(currentTemplate(db, kind))),
      variables: VARIABLES,
    });
  });

  router.patch("/api/contracts/settings", requireAuth, requireCap("settings.manage"), (req, res) => {
    const patch = parse(settingsSchema, req.body ?? {});
    const settings = saveContractSettings(req, patch);
    res.json({ settings, issues: settingsIssues(settings) });
  });

  router.put("/api/contracts/templates/:kind", requireAuth, requireCap("settings.manage"), (req, res) => {
    if (!KINDS.includes(req.params.kind)) throw notFound("Modelo de contrato não encontrado.");
    const input = parse(templateSchema, req.body ?? {});
    const row = saveTemplate(req, req.params.kind, input);
    res.json({ template: serializeTemplate(row) });
  });

  // Example PDF of the (possibly unsaved) template text.
  router.post("/api/contracts/templates/:kind/preview", requireAuth, requireCap("settings.manage"), async (req, res) => {
    const kind = req.params.kind;
    if (!KINDS.includes(kind)) throw notFound("Modelo de contrato não encontrado.");
    const input = parse(templatePreviewSchema, req.body ?? {});
    const current = currentTemplate(db, kind);
    const bytes = await renderTemplateExample(db, kind, {
      ...current,
      title: input.title ?? current.title,
      body: input.body ?? current.body,
    });
    sendPdf(res, bytes, `modelo-${kind}-exemplo.pdf`);
  });

  router.post("/api/contracts/integration/test", requireAuth, requireCap("settings.manage"), async (req, res) => {
    res.json(await testConnection(ctx));
  });

  router.post("/api/contracts/integration/webhook", requireAuth, requireCap("settings.manage"), async (req, res) => {
    await connectWebhook(ctx, req.user.id);
    res.json({ integration: avStatus(ctx) });
  });

  router.delete("/api/contracts/integration/webhook", requireAuth, requireCap("settings.manage"), async (req, res) => {
    await disconnectWebhook(ctx, req.user.id);
    res.json({ integration: avStatus(ctx) });
  });

  // --------------------------------------------------------------- staff: list, preview, create

  router.get("/api/contracts", requireAuth, requireCap("orders.view"), (req, res) => {
    const scope = scopeSql.clients(req, "c");
    const where = [scope.sql];
    const params = [...scope.params];
    for (const [param, column] of [
      ["clientId", "ct.client_id"],
      ["orderId", "ct.order_id"],
      ["subscriptionId", "ct.subscription_id"],
    ]) {
      if (req.query[param]) {
        where.push(`${column} = ?`);
        params.push(String(req.query[param]));
      }
    }
    const status = String(req.query.status ?? "");
    if (CONTRACT_STATUSES.includes(status)) {
      where.push("ct.status = ?");
      params.push(status);
    } else if (status === "open") where.push("ct.status IN ('sending', 'sent', 'failed')");
    const { limit, offset, page, pageSize } = paginate(req.query);
    const sql = `${CONTRACT_SELECT} WHERE ${where.join(" AND ")}`;
    const total = db.get(`SELECT COUNT(*) AS n FROM (${sql})`, params).n;
    const rows = db.all(`${sql} ORDER BY ct.created_at DESC, ct.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json({ items: rows.map((row) => serializeContract(req, row)), total, page, pageSize });
  });

  // PDF exactly as it would be sent (with a "Pré-visualização" banner). POST
  // so the signer's name and e-mail never travel in a URL.
  router.post("/api/contracts/preview", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const input = parse(createSchema, req.body ?? {});
    const row = input.orderId
      ? db.get("SELECT client_id FROM orders WHERE id = ?", [input.orderId])
      : db.get("SELECT client_id FROM subscriptions WHERE id = ?", [input.subscriptionId]);
    if (!row) throw notFound();
    assertClient(req, row.client_id);
    const bytes = await previewContract(req, input);
    sendPdf(res, bytes, "contrato-pre-visualizacao.pdf");
  });

  router.post("/api/contracts", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const input = parse(createSchema, req.body ?? {});
    const source = input.orderId
      ? db.get("SELECT client_id FROM orders WHERE id = ?", [input.orderId])
      : db.get("SELECT client_id FROM subscriptions WHERE id = ?", [input.subscriptionId]);
    if (!source) throw notFound();
    assertClient(req, source.client_id);
    const row = await createContract(req, input);
    res.status(202).json({ contract: detail(req, row) });
  });

  router.post("/api/contracts/waive", requireAuth, requireCap("orders.manage"), (req, res) => {
    const input = parse(waiveSchema, req.body ?? {});
    const row = input.orderId
      ? db.get("SELECT client_id FROM orders WHERE id = ?", [input.orderId])
      : db.get("SELECT client_id FROM subscriptions WHERE id = ?", [input.subscriptionId]);
    if (!row) throw notFound();
    assertClient(req, row.client_id);
    waiveContract(req, input, input.reason);
    res.json({ waived: true });
  });

  router.post("/api/contracts/unwaive", requireAuth, requireCap("orders.manage"), (req, res) => {
    const input = parse(sourceSchema, req.body ?? {});
    const row = input.orderId
      ? db.get("SELECT client_id FROM orders WHERE id = ?", [input.orderId])
      : db.get("SELECT client_id FROM subscriptions WHERE id = ?", [input.subscriptionId]);
    if (!row) throw notFound();
    assertClient(req, row.client_id);
    unwaiveContract(req, input);
    res.json({ waived: false });
  });

  router.get("/api/contracts/:id", requireAuth, requireCap("orders.view"), (req, res) => {
    res.json({ contract: detail(req, assertContract(req, req.params.id)) });
  });

  router.post("/api/contracts/:id/retry", requireAuth, requireCap("orders.manage"), (req, res) => {
    const row = assertContract(req, req.params.id);
    res.status(202).json({ contract: detail(req, retryContract(req, row)) });
  });

  router.post("/api/contracts/:id/sync", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const row = assertContract(req, req.params.id);
    if (!row.envelope_id) throw conflict("Este contrato ainda não chegou à AssinaVelox.");
    await syncContract(ctx, row.id, { source: "button" });
    res.json({ contract: detail(req, getContractRow(db, row.id)) });
  });

  router.post("/api/contracts/:id/cancel", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const row = assertContract(req, req.params.id);
    const { reason } = parse(cancelSchema, req.body ?? {});
    const result = await cancelContract(req, row, reason);
    res.json({ contract: detail(req, result.row), warning: result.warning });
  });

  // The Metta representative signs from the admin panel.
  router.post("/api/contracts/:id/sign-session", requireAuth, requireCap("orders.view"), async (req, res) => {
    const row = assertContract(req, req.params.id);
    res.json(await openThrottled(req, row, "metta"));
  });

  // Files: staff in scope, or the client that owns the contract.
  router.get("/api/contracts/:id/files/:kind", requireAuth, async (req, res) => {
    const row = getContractRow(db, req.params.id);
    if (!row) throw notFound("Não encontramos este contrato.");
    if (isStaff(req)) {
      if (!can(req.user, "orders.view")) throw notFound("Não encontramos este contrato.");
      assertClient(req, row.client_id);
    } else if (!can(req.user, "portal.access") || row.client_id !== req.user.client_id || ["draft", "sending", "failed"].includes(row.status)) {
      throw notFound("Não encontramos este contrato.");
    }
    const kind = FILE_KINDS[req.params.kind];
    if (!kind) throw notFound("Arquivo não encontrado.");
    const key = row[kind.column];
    if (!key) throw notFound(req.params.kind === "original" ? "Arquivo não encontrado." : "O arquivo final ainda não está disponível.");
    await sendStoredFile(req, res, ctx.storage, key, {
      mime: "application/pdf",
      size: row[kind.size] ?? undefined,
      filename: kind.name(contractCode(row.id)),
      disposition: req.query.download === "1" ? "attachment" : "inline",
    });
  });

  // --------------------------------------------------------------- client portal

  router.get("/api/portal/contracts", requireAuth, requireCap("portal.access"), (req, res) => {
    const rows = db.all(
      `${CONTRACT_SELECT} WHERE ct.client_id = ? AND ct.status NOT IN ('draft', 'sending', 'failed')
        ORDER BY CASE WHEN ct.status = 'sent' THEN 0 ELSE 1 END, ct.created_at DESC`,
      [req.user.client_id],
    );
    res.json({ items: rows.map((row) => serializeContract(req, row)) });
  });

  router.get("/api/portal/contracts/:id", requireAuth, requireCap("portal.access"), (req, res) => {
    res.json({ contract: detail(req, assertContract(req, req.params.id)) });
  });

  router.post("/api/portal/contracts/:id/sign-session", requireAuth, requireCap("portal.access"), async (req, res) => {
    const row = assertContract(req, req.params.id);
    res.json(await openThrottled(req, row, "client"));
  });

  // After the widget reports completion: read the envelope again (throttled).
  const lastRefresh = new Map();
  router.post("/api/portal/contracts/:id/refresh", requireAuth, requireCap("portal.access"), async (req, res) => {
    const row = assertContract(req, req.params.id);
    const last = lastRefresh.get(row.id) ?? 0;
    if (Date.now() - last < 3000) throw rateLimited("Aguarde alguns segundos para atualizar de novo.");
    lastRefresh.set(row.id, Date.now());
    if (lastRefresh.size > 2000) lastRefresh.clear();
    try {
      await syncContract(ctx, row.id, { source: "portal" });
    } catch (err) {
      if (err?.code === "integration_not_configured") throw forbidden(AV_MESSAGES.clientNotConfigured, "integration_not_configured");
      throw err;
    }
    res.json({ contract: detail(req, getContractRow(db, row.id)) });
  });

  return router;
}
