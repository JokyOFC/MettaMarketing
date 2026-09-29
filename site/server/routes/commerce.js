// Commerce (docs/API.md "Comercial"): services catalog, orders,
// subscriptions, payments, finance summary and the client billing portal.
// Staff access is capability-gated (finance/admin); clients only reach their
// own non-draft orders through /api/portal/*. Mercado Pago lives in
// services/mercadopago.js.
import { Router } from "express";
import { assertClient, scopeSql } from "../lib/access.js";
import { ACTIVITY_SELECT, logActivity } from "../lib/audit.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { conflict, notConfigured, notFound, upstream, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { clientUserIds, notify } from "../lib/notify.js";
import { bool, isStaff, parseJson, userRef } from "../lib/serialize.js";
import { now } from "../lib/time.js";
import { paginate, parse, schemas, z } from "../lib/validate.js";
import { contractGate, serializeContract } from "../services/contracts.js";
import * as mp from "../services/mercadopago.js";

// ------------------------------------------------------------------ dates (Brasília, UTC-3)

const SP_OFFSET_MS = 3 * 60 * 60 * 1000;
const todaySP = () => new Date(Date.now() - SP_OFFSET_MS).toISOString().slice(0, 10);

function monthRangeSP(date = new Date()) {
  const local = new Date(date.getTime() - SP_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  return {
    key: `${y}-${String(m + 1).padStart(2, "0")}`,
    start: new Date(Date.UTC(y, m, 1) + SP_OFFSET_MS).toISOString(),
    end: new Date(Date.UTC(y, m + 1, 1) + SP_OFFSET_MS).toISOString(),
  };
}

// ------------------------------------------------------------------ schemas

const money = (field = "o valor") =>
  z
    .number({ error: `Informe ${field}.` })
    .int("Use um valor em centavos.")
    .max(100_000_000, "Valor acima do limite permitido.");

const itemsSchema = z.array(z.string().trim().min(1, "Item vazio.").max(160, "Use no máximo 160 caracteres.")).max(30, "Use no máximo 30 itens.");

const serviceCreateSchema = z.object({
  name: schemas.text(120),
  kind: z.enum(["subscription", "one_off"], { error: "Escolha assinatura mensal ou avulso." }),
  priceCents: money("o preço").min(0, "O preço não pode ser negativo."),
  description: schemas.optionalText(1000),
  items: itemsSchema.optional(),
  includesEditables: z.boolean().optional(),
  active: z.boolean().optional(),
});

const servicePatchSchema = z.object({
  name: schemas.text(120).optional(),
  kind: z.enum(["subscription", "one_off"], { error: "Escolha assinatura mensal ou avulso." }).optional(),
  priceCents: money("o preço").min(0, "O preço não pode ser negativo.").optional(),
  description: schemas.optionalText(1000),
  items: itemsSchema.optional(),
  includesEditables: z.boolean().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});

const optionalId = z.union([schemas.id, z.null()]).optional();

const orderCreateSchema = z.object({
  clientId: schemas.id,
  brandId: optionalId,
  serviceId: optionalId,
  description: schemas.optionalText(250),
  amountCents: z.union([money().min(1, "Informe um valor maior que zero."), z.null()]).optional(),
  dueDate: schemas.optionalDate,
});

const orderPatchSchema = z.object({
  brandId: optionalId,
  serviceId: optionalId,
  description: schemas.text(250).optional(),
  amountCents: money().min(1, "Informe um valor maior que zero.").optional(),
  dueDate: schemas.optionalDate,
});

const subscriptionCreateSchema = z.object({
  clientId: schemas.id,
  serviceId: schemas.id,
  payerEmail: schemas.email,
  amountCents: z.union([money().min(1, "Informe um valor maior que zero."), z.null()]).optional(),
});

const checkoutSchema = z.object({ regenerate: z.boolean().optional() });
const reorderSchema = z.object({ ids: z.array(schemas.id).min(1).max(200) });

const ORDER_STATUSES = ["draft", "pending_payment", "paid", "failed", "cancelled", "refunded"];
const SUBSCRIPTION_STATUSES = ["pending", "active", "paused", "cancelled", "failed"];
const PAYMENT_STATUSES = ["pending", "in_process", "authorized", "approved", "in_mediation", "rejected", "cancelled", "refunded", "charged_back"];
const OPEN = new Set(["pending_payment", "failed"]);

const like = (text) => `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ------------------------------------------------------------------ queries & serializers

const ORDER_SELECT = `SELECT o.*, c.name AS client_name, b.name AS brand_name, s.name AS service_name,
    s.kind AS service_kind, u.id AS creator_id, u.name AS creator_name, u.role AS creator_role
  FROM orders o
  JOIN clients c ON c.id = o.client_id
  LEFT JOIN brands b ON b.id = o.brand_id
  LEFT JOIN services s ON s.id = o.service_id
  LEFT JOIN users u ON u.id = o.created_by`;

const SUBSCRIPTION_SELECT = `SELECT sb.*, c.name AS client_name, s.name AS service_name, s.items AS service_items,
    u.id AS creator_id, u.name AS creator_name, u.role AS creator_role
  FROM subscriptions sb
  JOIN clients c ON c.id = sb.client_id
  JOIN services s ON s.id = sb.service_id
  LEFT JOIN users u ON u.id = sb.created_by`;

const PAYMENT_SELECT = `SELECT p.*, o.description AS order_description, sv.name AS plan_name, c.name AS client_name
  FROM payments p
  LEFT JOIN orders o ON o.id = p.order_id
  LEFT JOIN subscriptions sb ON sb.id = p.subscription_id
  LEFT JOIN services sv ON sv.id = sb.service_id
  LEFT JOIN clients c ON c.id = p.client_id`;

function serializeService(row, usage) {
  const service = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    priceCents: row.price_cents,
    billingInterval: row.billing_interval ?? null,
    description: row.description ?? null,
    items: parseJson(row.items, []),
    includesEditables: bool(row.includes_editables),
    active: bool(row.active),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (usage) service.usage = usage;
  return service;
}

const creator = (row) => (row.creator_id ? userRef({ id: row.creator_id, name: row.creator_name, role: row.creator_role }) : null);

// Contract summary + payment gate (services/contracts.js). Clients only see
// contracts that were sent to them.
async function contractInfo(req, { orderId = null, subscriptionId = null, row }) {
  const gate = await contractGate(req.ctx, { orderId, subscriptionId, waived: Boolean(row.contract_waived_at) });
  const visible =
    gate.contract && (isStaff(req) || !["draft", "sending", "failed"].includes(gate.contract.status));
  const info = {
    contract: visible ? serializeContract(req, gate.contract) : null,
    contractRequired: gate.required,
    contractSatisfied: gate.satisfied,
  };
  if (isStaff(req))
    info.contractWaiver = row.contract_waived_at
      ? { at: row.contract_waived_at, reason: row.contract_waiver_reason ?? null }
      : null;
  return info;
}

// Why a client cannot pay yet, by the state of the contract they can see.
function contractBlockReason(contract) {
  if (contract?.status === "sent") {
    const client = contract.signers.find((s) => s.role === "client");
    return client?.turn
      ? "Assine o contrato para liberar o pagamento."
      : "Seu aceite foi registrado. O pagamento é liberado assim que a Metta assinar o contrato.";
  }
  if (contract && ["refused", "expired", "canceled"].includes(contract.status))
    return "A Metta vai enviar um novo contrato. O pagamento é liberado depois da assinatura.";
  return "A Metta está preparando o contrato. O pagamento é liberado depois da assinatura.";
}

export async function serializeOrder(req, row) {
  const order = {
    id: row.id,
    description: row.description,
    amountCents: row.amount_cents,
    status: row.status,
    dueDate: row.due_date ?? null,
    overdue: OPEN.has(row.status) && Boolean(row.due_date) && row.due_date < todaySP(),
    paidAt: row.paid_at ?? null,
    failureReason: row.status === "failed" ? (row.failure_reason ?? null) : null,
    client: { id: row.client_id, name: row.client_name },
    brand: row.brand_id ? { id: row.brand_id, name: row.brand_name ?? null } : null,
    service: row.service_id ? { id: row.service_id, name: row.service_name ?? null, kind: row.service_kind ?? null } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  Object.assign(order, await contractInfo(req, { orderId: row.id, row }));
  if (isStaff(req)) {
    order.externalReference = row.external_reference;
    order.checkoutUrl = row.checkout_url ?? null;
    order.hasCheckout = Boolean(row.checkout_url);
    order.createdBy = creator(row);
  } else {
    order.canPay = OPEN.has(row.status) && order.contractSatisfied;
    order.payBlockedReason = OPEN.has(row.status) && !order.contractSatisfied ? contractBlockReason(order.contract) : null;
  }
  return order;
}

export async function serializeSubscription(req, row) {
  const subscription = {
    id: row.id,
    status: row.status,
    amountCents: row.amount_cents,
    payerEmail: row.payer_email ?? null,
    startedAt: row.started_at ?? null,
    nextBillingDate: row.next_billing_date ?? null,
    cancelledAt: row.cancelled_at ?? null,
    failureReason: row.failure_reason ?? null,
    client: { id: row.client_id, name: row.client_name },
    service: { id: row.service_id, name: row.service_name, items: parseJson(row.service_items, []) },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  Object.assign(subscription, await contractInfo(req, { subscriptionId: row.id, row }));
  if (isStaff(req)) {
    subscription.externalReference = row.external_reference;
    subscription.checkoutUrl = row.checkout_url ?? null;
    subscription.hasCheckout = Boolean(row.checkout_url);
    subscription.mpPreapprovalId = row.mp_preapproval_id ?? null;
    subscription.createdBy = creator(row);
  } else {
    const blocked = row.status === "pending" && !subscription.contractSatisfied;
    subscription.checkoutUrl = row.status === "pending" && !blocked ? (row.checkout_url ?? null) : null;
    subscription.payBlockedReason = blocked ? contractBlockReason(subscription.contract) : null;
  }
  return subscription;
}

export function serializePayment(req, row) {
  const payment = {
    id: row.id,
    providerPaymentId: row.provider_payment_id,
    status: row.status,
    reason: mp.paymentReason(row.status, row.status_detail),
    amountCents: row.amount_cents ?? null,
    method: row.method ?? null,
    methodLabel: mp.methodLabel(row.method),
    paidAt: row.paid_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    order: row.order_id ? { id: row.order_id, description: row.order_description ?? null } : null,
    subscription: row.subscription_id ? { id: row.subscription_id, name: row.plan_name ?? null } : null,
  };
  if (isStaff(req)) {
    payment.statusDetail = row.status_detail ?? null;
    payment.client = row.client_id ? { id: row.client_id, name: row.client_name ?? null } : null;
  }
  return payment;
}

async function timeline(req, entityType, entityId) {
  const staff = isStaff(req);
  return (await req.ctx.db
    .all(`${ACTIVITY_SELECT} WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.id ASC`, [entityType, entityId]))
    .filter((row) => staff || row.visibility === "client")
    .map((row) => ({
      id: row.id,
      action: row.action,
      summary: row.summary,
      createdAt: row.created_at,
      actor: row.actor_id ? { name: row.actor_name ?? "Usuário removido", role: row.actor_role } : null,
      ...(staff ? { visibility: row.visibility } : {}),
    }));
}

// ------------------------------------------------------------------ router

export default function commerceRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  const getOrderRow = async (id) => (id ? await db.get(`${ORDER_SELECT} WHERE o.id = ?`, [id]) : null);
  const getSubscriptionRow = async (id) => (id ? await db.get(`${SUBSCRIPTION_SELECT} WHERE sb.id = ?`, [id]) : null);

  // Staff scope: out-of-scope clients answer 404 (finance/admin see all).
  async function assertOrder(req, id) {
    const row = await getOrderRow(id);
    if (!row) throw notFound("Não encontramos este pedido.");
    await assertClient(req, row.client_id);
    return row;
  }
  async function assertSubscription(req, id) {
    const row = await getSubscriptionRow(id);
    if (!row) throw notFound("Não encontramos esta assinatura.");
    await assertClient(req, row.client_id);
    return row;
  }

  async function orderDetail(req, row) {
    const payments = (await db
      .all(`${PAYMENT_SELECT} WHERE p.order_id = ? ORDER BY p.created_at DESC`, [row.id]))
      .map((p) => serializePayment(req, p));
    return {
      ...await serializeOrder(req, row),
      payments,
      timeline: await timeline(req, "order", row.id),
      recipients: (await clientUserIds(db, row.client_id)).length,
    };
  }

  async function subscriptionDetail(req, row) {
    const payments = (await db
      .all(`${PAYMENT_SELECT} WHERE p.subscription_id = ? ORDER BY p.created_at DESC`, [row.id]))
      .map((p) => serializePayment(req, p));
    return {
      ...await serializeSubscription(req, row),
      payments,
      timeline: await timeline(req, "subscription", row.id),
      recipients: (await clientUserIds(db, row.client_id)).length,
    };
  }

  const label = (row) => `${row.description} (${mp.formatBRL(row.amount_cents)})`;

  // One checkout creation per order at a time; reuses the link unless regenerate.
  const locks = new Map();
  async function ensureOrderCheckout(req, row, { regenerate = false } = {}) {
    if (row.checkout_url && !regenerate) return { url: row.checkout_url, reused: true };
    const key = `order:${row.id}`;
    if (locks.has(key)) return locks.get(key);
    const work = (async () => {
      const preference = await mp.createPreference(req.ctx, row);
      const at = now();
      await db.tx(async () => {
        const { changes } = await db.run(
          `UPDATE orders SET mp_preference_id = ?, checkout_url = ?,
             status = CASE WHEN status = 'draft' OR ? THEN 'pending_payment' ELSE status END,
             failure_reason = CASE WHEN status = 'draft' OR ? THEN NULL ELSE failure_reason END,
             updated_at = ?
           WHERE id = ? AND status IN ('draft', 'pending_payment', 'failed')`,
          [preference.id, preference.url, regenerate, regenerate, at, row.id],
        );
        if (!changes) throw conflict("Este pedido mudou enquanto o link era gerado. Atualize a página.");
        await logActivity(req, {
          action: "order.checkout_created",
          entityType: "order",
          entityId: row.id,
          clientId: row.client_id,
          brandId: row.brand_id,
          summary: regenerate ? "Novo link de pagamento gerado no Mercado Pago" : "Link de pagamento gerado no Mercado Pago",
          data: { preferenceId: preference.id },
        });
      });
      if (regenerate && row.mp_preference_id && row.mp_preference_id !== preference.id)
        mp.expirePreference(req.ctx, row.mp_preference_id).catch(() => {});
      return { url: preference.url, reused: false };
    })();
    locks.set(key, work);
    try {
      return await work;
    } finally {
      locks.delete(key);
    }
  }

  async function ensureSubscriptionCheckout(req, row, { regenerate = false } = {}) {
    if (row.checkout_url && !regenerate) return { url: row.checkout_url, reused: true };
    const key = `subscription:${row.id}`;
    if (locks.has(key)) return locks.get(key);
    const work = (async () => {
      const service = await db.get("SELECT * FROM services WHERE id = ?", [row.service_id]);
      const preapproval = await mp.createPreapproval(req.ctx, row, service);
      await db.tx(async () => {
        const { changes } = await db.run(
          `UPDATE subscriptions SET mp_preapproval_id = ?, checkout_url = ?, status = 'pending', failure_reason = NULL, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'failed')`,
          [preapproval.id, preapproval.url, now(), row.id],
        );
        if (!changes) throw conflict("Esta assinatura mudou enquanto o link era gerado. Atualize a página.");
        await logActivity(req, {
          action: "subscription.checkout_created",
          entityType: "subscription",
          entityId: row.id,
          clientId: row.client_id,
          summary: regenerate ? "Novo link de autorização gerado no Mercado Pago" : "Link de autorização gerado no Mercado Pago",
          data: { preapprovalId: preapproval.id },
        });
      });
      if (regenerate && row.mp_preapproval_id && row.mp_preapproval_id !== preapproval.id)
        mp.cancelPreapproval(req.ctx, row.mp_preapproval_id).catch(() => {});
      return { url: preapproval.url, reused: false };
    })();
    locks.set(key, work);
    try {
      return await work;
    } finally {
      locks.delete(key);
    }
  }

  // --------------------------------------------------------------- options for forms/filters

  router.get("/api/commerce/options", requireAuth, requireCap("orders.view"), async (req, res) => {
    const scope = scopeSql.clients(req, "c");
    const clients = await db.all(
      `SELECT c.id, c.name, c.status, c.contact_email FROM clients c WHERE ${scope.sql} ORDER BY c.name COLLATE utf8mb4_0900_ai_ci`,
      scope.params,
    );
    const brands = await db.all("SELECT id, client_id, name, status FROM brands ORDER BY name COLLATE utf8mb4_0900_ai_ci");
    const byClient = new Map();
    for (const brand of brands) {
      if (!byClient.has(brand.client_id)) byClient.set(brand.client_id, []);
      byClient.get(brand.client_id).push({ id: brand.id, name: brand.name, status: brand.status });
    }
    const services = await db.all("SELECT * FROM services WHERE active = 1 ORDER BY sort_order, name COLLATE utf8mb4_0900_ai_ci");
    res.json({
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        contactEmail: c.contact_email ?? null,
        brands: byClient.get(c.id) ?? [],
      })),
      services: services.map((row) => serializeService(row)),
    });
  });

  // --------------------------------------------------------------- services catalog

  async function serviceUsage() {
    const usage = new Map();
    const get = (id) => {
      if (!usage.has(id)) usage.set(id, { orders: 0, activeSubscriptions: 0, subscriptions: 0 });
      return usage.get(id);
    };
    for (const row of await db.all("SELECT service_id, COUNT(*) AS n FROM orders WHERE service_id IS NOT NULL GROUP BY service_id"))
      get(row.service_id).orders = row.n;
    for (const row of await db.all(
      "SELECT service_id, COUNT(*) AS n, SUM(status = 'active') AS active FROM subscriptions GROUP BY service_id",
    )) {
      get(row.service_id).subscriptions = row.n;
      get(row.service_id).activeSubscriptions = row.active ?? 0;
    }
    return (id) => usage.get(id) ?? { orders: 0, activeSubscriptions: 0, subscriptions: 0 };
  }

  router.get("/api/services", requireAuth, requireCap("services.view"), async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.active === "1" || req.query.active === "true") where.push("active = 1");
    if (req.query.kind === "subscription" || req.query.kind === "one_off") {
      where.push("kind = ?");
      params.push(req.query.kind);
    }
    const rows = await db.all(
      `SELECT * FROM services ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY sort_order, name COLLATE utf8mb4_0900_ai_ci`,
      params,
    );
    const usage = await serviceUsage();
    res.json({ items: rows.map((row) => serializeService(row, usage(row.id))), total: rows.length });
  });

  router.post("/api/services", requireAuth, requireCap("services.manage"), async (req, res) => {
    const input = parse(serviceCreateSchema, req.body);
    if (input.kind === "subscription" && input.priceCents <= 0)
      throw validation({ priceCents: "Assinaturas precisam de um valor mensal maior que zero." });
    const id = newId("svc");
    const at = now();
    await db.tx(async () => {
      const max = (await db.get("SELECT COALESCE(MAX(sort_order), 0) AS n FROM services")).n;
      await db.run(
        `INSERT INTO services (id, name, kind, price_cents, billing_interval, description, items, includes_editables,
           active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.kind,
          input.priceCents,
          input.kind === "subscription" ? "monthly" : null,
          input.description ?? null,
          JSON.stringify(input.items ?? []),
          input.includesEditables ? 1 : 0,
          input.active === false ? 0 : 1,
          max + 10,
          at,
          at,
        ],
      );
      await logActivity(req, {
        action: "service.created",
        entityType: "service",
        entityId: id,
        summary: `Serviço criado: ${input.name} (${mp.formatBRL(input.priceCents)}${input.kind === "subscription" ? "/mês" : ""})`,
      });
    });
    const row = await db.get("SELECT * FROM services WHERE id = ?", [id]);
    res.status(201).json({ service: serializeService(row, (await serviceUsage())(id)) });
  });

  router.post("/api/services/reorder", requireAuth, requireCap("services.manage"), async (req, res) => {
    const { ids } = parse(reorderSchema, req.body);
    const known = new Set((await db.all("SELECT id FROM services")).map((row) => row.id));
    if (ids.some((id) => !known.has(id))) throw notFound("Não encontramos um dos serviços.");
    await db.tx(async () => {
      for (const [index, id] of ids.entries())
        await db.run("UPDATE services SET sort_order = ?, updated_at = ? WHERE id = ?", [(index + 1) * 10, now(), id]);
      await logActivity(req, { action: "service.reordered", entityType: "service", summary: "Ordem do catálogo atualizada" });
    });
    const usage = await serviceUsage();
    res.json({
      items: (await db.all("SELECT * FROM services ORDER BY sort_order, name COLLATE utf8mb4_0900_ai_ci")).map((row) => serializeService(row, usage(row.id))),
    });
  });

  router.patch("/api/services/:id", requireAuth, requireCap("services.manage"), async (req, res) => {
    const row = await db.get("SELECT * FROM services WHERE id = ?", [req.params.id]);
    if (!row) throw notFound("Não encontramos este serviço.");
    const input = parse(servicePatchSchema, req.body);
    const usage = (await serviceUsage())(row.id);
    const kind = input.kind ?? row.kind;
    if (input.kind && input.kind !== row.kind && (usage.orders || usage.subscriptions))
      throw conflict("Este serviço já tem pedidos ou assinaturas. Crie um novo serviço em vez de mudar o tipo.");
    const price = input.priceCents ?? row.price_cents;
    if (kind === "subscription" && price <= 0)
      throw validation({ priceCents: "Assinaturas precisam de um valor mensal maior que zero." });

    const sets = [];
    const params = [];
    const put = (column, value) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (input.name !== undefined) put("name", input.name);
    if (input.kind !== undefined) {
      put("kind", input.kind);
      put("billing_interval", input.kind === "subscription" ? "monthly" : null);
    }
    if (input.priceCents !== undefined) put("price_cents", input.priceCents);
    if (input.description !== undefined) put("description", input.description);
    if (input.items !== undefined) put("items", JSON.stringify(input.items));
    if (input.includesEditables !== undefined) put("includes_editables", input.includesEditables ? 1 : 0);
    if (input.active !== undefined) put("active", input.active ? 1 : 0);
    if (input.sortOrder !== undefined) put("sort_order", input.sortOrder);
    if (sets.length) {
      put("updated_at", now());
      await db.tx(async () => {
        await db.run(`UPDATE services SET ${sets.join(", ")} WHERE id = ?`, [...params, row.id]);
        const changes = [];
        if (input.active !== undefined && bool(row.active) !== input.active) changes.push(input.active ? "ativado" : "desativado");
        if (input.priceCents !== undefined && input.priceCents !== row.price_cents)
          changes.push(`preço ${mp.formatBRL(row.price_cents)} → ${mp.formatBRL(input.priceCents)}`);
        await logActivity(req, {
          action: "service.updated",
          entityType: "service",
          entityId: row.id,
          summary: `Serviço ${input.name ?? row.name} atualizado${changes.length ? `: ${changes.join(", ")}` : ""}`,
        });
      });
    }
    res.json({ service: serializeService(await db.get("SELECT * FROM services WHERE id = ?", [row.id]), (await serviceUsage())(row.id)) });
  });

  // --------------------------------------------------------------- orders

  router.get("/api/orders", requireAuth, requireCap("orders.view"), async (req, res) => {
    const scope = scopeSql.clients(req, "c");
    const where = [scope.sql];
    const params = [...scope.params];
    if (req.query.clientId) {
      where.push("o.client_id = ?");
      params.push(String(req.query.clientId));
    }
    const base = { where: [...where], params: [...params] };
    const status = String(req.query.status ?? "");
    if (ORDER_STATUSES.includes(status)) {
      where.push("o.status = ?");
      params.push(status);
    } else if (status === "open") {
      where.push("o.status IN ('pending_payment', 'failed')");
    } else if (status === "overdue") {
      where.push("o.status IN ('pending_payment', 'failed') AND o.due_date IS NOT NULL AND o.due_date < ?");
      params.push(todaySP());
    }
    if (req.query.q) {
      where.push("(o.description LIKE ? COLLATE utf8mb4_0900_ai_ci OR c.name LIKE ? COLLATE utf8mb4_0900_ai_ci OR b.name LIKE ? COLLATE utf8mb4_0900_ai_ci)");
      params.push(like(req.query.q), like(req.query.q), like(req.query.q));
    }
    const { limit, offset, page, pageSize } = paginate(req.query);
    const sql = `${ORDER_SELECT} WHERE ${where.join(" AND ")}`;
    const total = (await db.get(`SELECT COUNT(*) AS n FROM (${sql}) AS counted`, params)).n;
    const rows = await db.all(`${sql} ORDER BY o.created_at DESC, o.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const counts = { all: 0 };
    for (const row of await db.all(
      `SELECT o.status, COUNT(*) AS n FROM orders o JOIN clients c ON c.id = o.client_id WHERE ${base.where.join(" AND ")} GROUP BY o.status`,
      base.params,
    )) {
      counts[row.status] = row.n;
      counts.all += row.n;
    }
    res.json({ items: await Promise.all(rows.map((row) => serializeOrder(req, row))), total, page, pageSize, counts });
  });

  router.post("/api/orders", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const input = parse(orderCreateSchema, req.body);
    const client = await assertClient(req, input.clientId);
    if (client.status === "archived") throw validation({ clientId: "Este cliente está arquivado." });
    let brand = null;
    if (input.brandId) {
      brand = await db.get("SELECT * FROM brands WHERE id = ?", [input.brandId]);
      if (!brand || brand.client_id !== client.id) throw validation({ brandId: "Esta marca não pertence ao cliente escolhido." });
    }
    let service = null;
    if (input.serviceId) {
      service = await db.get("SELECT * FROM services WHERE id = ?", [input.serviceId]);
      if (!service) throw validation({ serviceId: "Serviço não encontrado." });
      if (!service.active) throw validation({ serviceId: "Este serviço está inativo." });
    }
    const description = input.description ?? service?.name ?? null;
    const amount = input.amountCents ?? service?.price_cents ?? null;
    const fields = {};
    if (!description) fields.description = "Descreva o pedido ou escolha um serviço.";
    if (!amount || amount <= 0) fields.amountCents = "Informe um valor maior que zero.";
    if (Object.keys(fields).length) throw validation(fields);

    const id = newId("ord");
    const at = now();
    await db.tx(async () => {
      await db.run(
        `INSERT INTO orders (id, client_id, brand_id, service_id, description, amount_cents, status, due_date,
           external_reference, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
        [id, client.id, brand?.id ?? null, service?.id ?? null, description, amount, input.dueDate ?? null, `metta-${id}`, req.user.id, at, at],
      );
      await logActivity(req, {
        action: "order.created",
        entityType: "order",
        entityId: id,
        clientId: client.id,
        brandId: brand?.id ?? null,
        summary: `Pedido criado: ${description} (${mp.formatBRL(amount)})`,
      });
    });
    res.status(201).json({ order: await orderDetail(req, await getOrderRow(id)) });
  });

  router.get("/api/orders/:id", requireAuth, requireCap("orders.view"), async (req, res) => {
    res.json({ order: await orderDetail(req, await assertOrder(req, req.params.id)) });
  });

  router.patch("/api/orders/:id", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const row = await assertOrder(req, req.params.id);
    const input = parse(orderPatchSchema, req.body);
    const touchesCharge = ["brandId", "serviceId", "description", "amountCents"].some((key) => input[key] !== undefined);
    if (touchesCharge && row.status !== "draft")
      throw conflict("Valor e descrição só mudam enquanto o pedido é rascunho. Cancele-o e crie um novo pedido.");
    if (input.dueDate !== undefined && !["draft", "pending_payment", "failed"].includes(row.status))
      throw conflict("Este pedido já foi concluído e não pode mais ser alterado.");
    if (input.brandId) {
      const brand = await db.get("SELECT client_id FROM brands WHERE id = ?", [input.brandId]);
      if (!brand || brand.client_id !== row.client_id) throw validation({ brandId: "Esta marca não pertence a este cliente." });
    }
    if (input.serviceId) {
      const service = await db.get("SELECT active FROM services WHERE id = ?", [input.serviceId]);
      if (!service) throw validation({ serviceId: "Serviço não encontrado." });
    }
    const sets = [];
    const params = [];
    const put = (column, value) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (input.brandId !== undefined) put("brand_id", input.brandId);
    if (input.serviceId !== undefined) put("service_id", input.serviceId);
    if (input.description !== undefined) put("description", input.description);
    if (input.amountCents !== undefined) put("amount_cents", input.amountCents);
    if (input.dueDate !== undefined) put("due_date", input.dueDate);
    if (sets.length) {
      put("updated_at", now());
      await db.tx(async () => {
        await db.run(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`, [...params, row.id]);
        const updated = await getOrderRow(row.id);
        await logActivity(req, {
          action: "order.updated",
          entityType: "order",
          entityId: row.id,
          clientId: row.client_id,
          brandId: updated.brand_id,
          summary: `Pedido atualizado: ${label(updated)}${updated.due_date ? `, vencimento ${mp.formatDateBR(updated.due_date)}` : ""}`,
        });
      });
    }
    res.json({ order: await orderDetail(req, await getOrderRow(row.id)) });
  });

  router.post("/api/orders/:id/checkout", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const row = await assertOrder(req, req.params.id);
    const { regenerate = false } = parse(checkoutSchema, req.body ?? {});
    if (!["draft", "pending_payment", "failed"].includes(row.status))
      throw conflict(row.status === "paid" ? "Este pedido já está pago." : "Este pedido não aceita mais pagamentos.");
    const result = await ensureOrderCheckout(req, row, { regenerate });
    res.json({ checkoutUrl: result.url, reused: result.reused, order: await orderDetail(req, await getOrderRow(row.id)) });
  });

  router.post("/api/orders/:id/send", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const row = await assertOrder(req, req.params.id);
    if (!OPEN.has(row.status)) throw conflict("Gere o link de pagamento antes de enviar a cobrança ao cliente.");
    const recipients = await clientUserIds(db, row.client_id);
    if (!recipients.length)
      throw conflict("Este cliente ainda não tem usuários ativos na plataforma. Convide alguém em Clientes e marcas.");
    const due = row.due_date ? mp.formatDateBR(row.due_date) : null;
    let created = [];
    await db.tx(async () => {
      created = await notify(req, recipients, {
        type: "order.sent",
        title: "Nova cobrança da Metta",
        body: `${row.description}: ${mp.formatBRL(row.amount_cents)}${due ? `, com vencimento em ${due}` : ""}. Pague com segurança pelo Mercado Pago na área Financeiro.`,
        link: "/painel/financeiro",
        entityType: "order",
        entityId: row.id,
        email: true,
        emailLines: [
          ["Descrição", row.description],
          ["Valor", mp.formatBRL(row.amount_cents)],
          ...(due ? [["Vencimento", due]] : []),
        ],
        actionLabel: "Ver e pagar",
      });
      await logActivity(req, {
        action: "order.sent",
        entityType: "order",
        entityId: row.id,
        clientId: row.client_id,
        brandId: row.brand_id,
        summary: `Cobrança enviada: ${label(row)}`,
        visibility: "client",
      });
    });
    const emailable = (await db.get(
      `SELECT COUNT(*) AS n FROM users WHERE id IN (${recipients.map(() => "?").join(", ")}) AND notify_email = 1`,
      recipients,
    )).n;
    res.json({
      sent: created.length,
      emailRecipients: emailable,
      emailConfigured: ctx.mailer.isConfigured(),
      order: await orderDetail(req, await getOrderRow(row.id)),
    });
  });

  router.post("/api/orders/:id/cancel", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const row = await assertOrder(req, req.params.id);
    if (!["draft", "pending_payment", "failed"].includes(row.status))
      throw conflict(row.status === "paid" ? "Pedidos pagos não podem ser cancelados aqui. Faça o estorno pelo Mercado Pago." : "Este pedido já está encerrado.");
    const wasVisible = row.status !== "draft";
    await db.tx(async () => {
      await db.run("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = ?", [now(), row.id, row.status]);
      await logActivity(req, {
        action: "order.cancelled",
        entityType: "order",
        entityId: row.id,
        clientId: row.client_id,
        brandId: row.brand_id,
        summary: `Pedido cancelado: ${label(row)}`,
        visibility: wasVisible ? "client" : "internal",
      });
      if (wasVisible)
        await notify(req, await clientUserIds(db, row.client_id), {
          type: "order.cancelled",
          title: "Cobrança cancelada",
          body: `A cobrança ${label(row)} foi cancelada pela Metta. Nenhum pagamento é necessário.`,
          link: "/painel/financeiro",
          entityType: "order",
          entityId: row.id,
        });
    });
    let warning = null;
    if (row.mp_preference_id) {
      try {
        await mp.expirePreference(req.ctx, row.mp_preference_id);
      } catch {
        warning = "O pedido foi cancelado, mas não conseguimos desativar o link no Mercado Pago. Se alguém pagar por ele, o pagamento aparece aqui para estorno.";
      }
    }
    res.json({ order: await orderDetail(req, await getOrderRow(row.id)), warning });
  });

  // Pulls the payments of this order from Mercado Pago (when a webhook was missed).
  router.post("/api/orders/:id/sync", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const row = await assertOrder(req, req.params.id);
    const payments = await mp.searchPayments(req.ctx, row.external_reference);
    let changed = 0;
    for (const payment of payments) {
      try {
        if ((await mp.applyPayment(req.ctx, payment)).changed) changed += 1;
      } catch (err) {
        if (!(err instanceof mp.ReconcileError)) throw err;
      }
    }
    res.json({ found: payments.length, changed, order: await orderDetail(req, await getOrderRow(row.id)) });
  });

  // --------------------------------------------------------------- subscriptions

  router.get("/api/subscriptions", requireAuth, requireCap("orders.view"), async (req, res) => {
    const scope = scopeSql.clients(req, "c");
    const where = [scope.sql];
    const params = [...scope.params];
    if (req.query.clientId) {
      where.push("sb.client_id = ?");
      params.push(String(req.query.clientId));
    }
    const base = { where: [...where], params: [...params] };
    if (SUBSCRIPTION_STATUSES.includes(String(req.query.status ?? ""))) {
      where.push("sb.status = ?");
      params.push(String(req.query.status));
    }
    if (req.query.q) {
      where.push("(s.name LIKE ? COLLATE utf8mb4_0900_ai_ci OR c.name LIKE ? COLLATE utf8mb4_0900_ai_ci OR sb.payer_email LIKE ? COLLATE utf8mb4_0900_ai_ci)");
      params.push(like(req.query.q), like(req.query.q), like(req.query.q));
    }
    const { limit, offset, page, pageSize } = paginate(req.query);
    const sql = `${SUBSCRIPTION_SELECT} WHERE ${where.join(" AND ")}`;
    const total = (await db.get(`SELECT COUNT(*) AS n FROM (${sql}) AS counted`, params)).n;
    const rows = await db.all(`${sql} ORDER BY sb.created_at DESC, sb.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const counts = { all: 0 };
    for (const row of await db.all(
      `SELECT sb.status, COUNT(*) AS n FROM subscriptions sb JOIN clients c ON c.id = sb.client_id WHERE ${base.where.join(" AND ")} GROUP BY sb.status`,
      base.params,
    )) {
      counts[row.status] = row.n;
      counts.all += row.n;
    }
    res.json({ items: await Promise.all(rows.map((row) => serializeSubscription(req, row))), total, page, pageSize, counts });
  });

  router.post("/api/subscriptions", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const input = parse(subscriptionCreateSchema, req.body);
    const client = await assertClient(req, input.clientId);
    if (client.status === "archived") throw validation({ clientId: "Este cliente está arquivado." });
    const service = await db.get("SELECT * FROM services WHERE id = ?", [input.serviceId]);
    if (!service) throw validation({ serviceId: "Plano não encontrado." });
    if (service.kind !== "subscription") throw validation({ serviceId: "Escolha um plano de assinatura mensal." });
    if (!service.active) throw validation({ serviceId: "Este plano está inativo." });
    const amount = input.amountCents ?? service.price_cents;
    if (!amount || amount <= 0) throw validation({ amountCents: "Informe um valor mensal maior que zero." });
    const duplicate = await db.get(
      "SELECT id FROM subscriptions WHERE client_id = ? AND service_id = ? AND status IN ('pending', 'active', 'paused')",
      [client.id, service.id],
    );
    if (duplicate) throw conflict("Este cliente já tem uma assinatura deste plano em andamento.");

    const id = newId("sub");
    const at = now();
    await db.tx(async () => {
      await db.run(
        `INSERT INTO subscriptions (id, client_id, service_id, amount_cents, status, payer_email, external_reference,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [id, client.id, service.id, amount, input.payerEmail, `metta-${id}`, req.user.id, at, at],
      );
      await logActivity(req, {
        action: "subscription.created",
        entityType: "subscription",
        entityId: id,
        clientId: client.id,
        summary: `Assinatura criada: ${service.name} (${mp.formatBRL(amount)}/mês)`,
      });
    });
    res.status(201).json({ subscription: await subscriptionDetail(req, await getSubscriptionRow(id)) });
  });

  router.get("/api/subscriptions/:id", requireAuth, requireCap("orders.view"), async (req, res) => {
    res.json({ subscription: await subscriptionDetail(req, await assertSubscription(req, req.params.id)) });
  });

  router.post("/api/subscriptions/:id/checkout", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const row = await assertSubscription(req, req.params.id);
    const { regenerate = false } = parse(checkoutSchema, req.body ?? {});
    if (!["pending", "failed"].includes(row.status))
      throw conflict("Esta assinatura já foi autorizada ou encerrada; não precisa de um novo link.");
    const result = await ensureSubscriptionCheckout(req, row, { regenerate });
    res.json({ checkoutUrl: result.url, reused: result.reused, subscription: await subscriptionDetail(req, await getSubscriptionRow(row.id)) });
  });

  router.post("/api/subscriptions/:id/send", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const row = await assertSubscription(req, req.params.id);
    if (row.status !== "pending" || !row.checkout_url)
      throw conflict("Gere o link de autorização antes de enviar a assinatura ao cliente.");
    const recipients = await clientUserIds(db, row.client_id);
    if (!recipients.length)
      throw conflict("Este cliente ainda não tem usuários ativos na plataforma. Convide alguém em Clientes e marcas.");
    let created = [];
    await db.tx(async () => {
      created = await notify(req, recipients, {
        type: "subscription.sent",
        title: "Autorize sua assinatura Metta",
        body: `${row.service_name}: ${mp.formatBRL(row.amount_cents)} por mês. A autorização é feita no Mercado Pago com o e-mail ${row.payer_email}.`,
        link: "/painel/financeiro",
        entityType: "subscription",
        entityId: row.id,
        email: true,
        emailLines: [
          ["Plano", row.service_name],
          ["Valor mensal", mp.formatBRL(row.amount_cents)],
          ["E-mail do pagador", row.payer_email ?? ""],
        ],
        actionLabel: "Ver assinatura",
      });
      await logActivity(req, {
        action: "subscription.sent",
        entityType: "subscription",
        entityId: row.id,
        clientId: row.client_id,
        summary: `Assinatura enviada para autorização: ${row.service_name} (${mp.formatBRL(row.amount_cents)}/mês)`,
        visibility: "client",
      });
    });
    res.json({
      sent: created.length,
      emailConfigured: ctx.mailer.isConfigured(),
      subscription: await subscriptionDetail(req, await getSubscriptionRow(row.id)),
    });
  });

  router.post("/api/subscriptions/:id/cancel", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const row = await assertSubscription(req, req.params.id);
    if (row.status === "cancelled") throw conflict("Esta assinatura já está cancelada.");
    if (row.mp_preapproval_id) {
      if (!mp.mpStatus(ctx.config).configured)
        throw notConfigured(
          "Mercado Pago não configurado. Sem as credenciais não é possível cancelar a cobrança recorrente no Mercado Pago.",
        );
      // Cancel at the source first: never stop tracking a charge that keeps running.
      await mp.cancelPreapproval(req.ctx, row.mp_preapproval_id);
    }
    const at = now();
    await db.tx(async () => {
      await db.run("UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?", [at, at, row.id]);
      await logActivity(req, {
        action: "subscription.cancelled",
        entityType: "subscription",
        entityId: row.id,
        clientId: row.client_id,
        summary: `Assinatura cancelada: ${row.service_name}`,
        visibility: "client",
      });
      await notify(req, await clientUserIds(db, row.client_id), {
        type: "subscription.cancelled",
        title: "Assinatura cancelada",
        body: `A assinatura ${row.service_name} foi cancelada. Não haverá novas cobranças mensais.`,
        link: "/painel/financeiro",
        entityType: "subscription",
        entityId: row.id,
        email: row.status !== "pending",
      });
    });
    res.json({ subscription: await subscriptionDetail(req, await getSubscriptionRow(row.id)) });
  });

  router.post("/api/subscriptions/:id/sync", requireAuth, requireCap("orders.manage"), async (req, res) => {
    const row = await assertSubscription(req, req.params.id);
    let changed = 0;
    if (row.mp_preapproval_id) {
      const preapproval = await mp.getPreapproval(req.ctx, row.mp_preapproval_id);
      if ((await mp.applyPreapproval(req.ctx, preapproval)).changed) changed += 1;
    } else if (!mp.mpStatus(ctx.config).configured) {
      throw notConfigured(mp.MESSAGES.notConfigured);
    }
    const payments = await mp.searchPayments(req.ctx, row.external_reference);
    for (const payment of payments) {
      try {
        if ((await mp.applyPayment(req.ctx, payment, { preapprovalId: row.mp_preapproval_id })).changed) changed += 1;
      } catch (err) {
        if (!(err instanceof mp.ReconcileError)) throw err;
      }
    }
    res.json({ found: payments.length, changed, subscription: await subscriptionDetail(req, await getSubscriptionRow(row.id)) });
  });

  // --------------------------------------------------------------- payments & finance

  router.get("/api/payments", requireAuth, requireCap("finance.view", "orders.view"), async (req, res) => {
    const scope = scopeSql.clients(req, "c");
    const where = [`(p.client_id IS NULL OR ${scope.sql})`];
    const params = [...scope.params];
    if (req.query.clientId) {
      where.push("p.client_id = ?");
      params.push(String(req.query.clientId));
    }
    const status = String(req.query.status ?? "");
    if (PAYMENT_STATUSES.includes(status)) {
      where.push("p.status = ?");
      params.push(status);
    } else if (status === "failed") {
      where.push("p.status IN ('rejected', 'cancelled', 'charged_back')");
    } else if (status === "pending") {
      where.push("p.status IN ('pending', 'in_process', 'authorized')");
    }
    if (req.query.orderId) {
      where.push("p.order_id = ?");
      params.push(String(req.query.orderId));
    }
    const { limit, offset, page, pageSize } = paginate(req.query);
    const sql = `${PAYMENT_SELECT} WHERE ${where.join(" AND ")}`;
    const total = (await db.get(`SELECT COUNT(*) AS n FROM (${sql}) AS counted`, params)).n;
    const rows = await db.all(`${sql} ORDER BY COALESCE(p.paid_at, p.updated_at) DESC, p.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json({ items: rows.map((row) => serializePayment(req, row)), total, page, pageSize });
  });

  router.get("/api/finance/summary", requireAuth, requireCap("finance.view"), async (req, res) => {
    const today = todaySP();
    const month = monthRangeSP();
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const open = await db.get(
      "SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM orders WHERE status IN ('pending_payment', 'failed')",
    );
    const overdue = await db.get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM orders
        WHERE status IN ('pending_payment', 'failed') AND due_date IS NOT NULL AND due_date < ?`,
      [today],
    );
    const failedOrders = (await db.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'failed'")).n;
    const drafts = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM orders WHERE status = 'draft'");
    const received = await db.get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM payments
        WHERE status = 'approved' AND paid_at >= ? AND paid_at < ?`,
      [month.start, month.end],
    );
    const active = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM subscriptions WHERE status = 'active'");
    const pendingSubs = (await db.get("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'pending'")).n;
    const failures = (await db.get(
      "SELECT COUNT(*) AS n FROM payments WHERE status IN ('rejected', 'charged_back') AND updated_at >= ?",
      [since],
    )).n;
    res.json({
      month: month.key,
      receivable: { count: open.n, cents: open.cents, overdueCount: overdue.n, overdueCents: overdue.cents, failedCount: failedOrders },
      drafts: { count: drafts.n, cents: drafts.cents },
      receivedThisMonth: { count: received.n, cents: received.cents },
      subscriptions: { active: active.n, monthlyCents: active.cents, pending: pendingSubs },
      failures: { recent: failures, since, failedOrders },
    });
  });

  router.get("/api/finance/status", requireAuth, requireCap("finance.view", "orders.view"), (req, res) => {
    res.json({ mercadopago: mp.mpStatus(ctx.config), email: { configured: ctx.mailer.isConfigured() } });
  });

  router.get("/api/finance/webhooks", requireAuth, requireCap("finance.view"), async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const rows = await db.all(
      "SELECT * FROM webhook_events WHERE provider = 'mercadopago' ORDER BY received_at DESC, seq DESC LIMIT ?",
      [limit],
    );
    const total = (await db.get("SELECT COUNT(*) AS n FROM webhook_events WHERE provider = 'mercadopago'")).n;
    res.json({
      items: rows.map((row) => ({
        id: row.id,
        requestId: row.request_id ?? null,
        topic: row.topic ?? null,
        resourceId: row.resource_id ?? null,
        signatureValid: bool(row.signature_valid),
        receivedAt: row.received_at,
        processedAt: row.processed_at ?? null,
        error: row.error ?? null,
      })),
      total,
    });
  });

  // --------------------------------------------------------------- client portal

  router.get("/api/portal/billing", requireAuth, requireCap("portal.access"), async (req, res) => {
    const clientId = req.user.client_id;
    const orders = await db.all(
      `${ORDER_SELECT} WHERE o.client_id = ? AND o.status <> 'draft'
        ORDER BY CASE WHEN o.status IN ('pending_payment', 'failed') THEN 0 ELSE 1 END,
                 CASE WHEN o.status IN ('pending_payment', 'failed') THEN COALESCE(o.due_date, '9999-12-31') END,
                 o.created_at DESC`,
      [clientId],
    );
    const subscriptions = await db.all(`${SUBSCRIPTION_SELECT} WHERE sb.client_id = ? ORDER BY sb.created_at DESC`, [clientId]);
    const payments = await db.all(
      `${PAYMENT_SELECT} WHERE p.client_id = ? AND (p.order_id IS NULL OR o.status <> 'draft')
        ORDER BY COALESCE(p.paid_at, p.updated_at) DESC LIMIT 100`,
      [clientId],
    );
    res.json({
      orders: await Promise.all(orders.map((row) => serializeOrder(req, row))),
      subscriptions: await Promise.all(subscriptions.map((row) => serializeSubscription(req, row))),
      payments: payments.map((row) => serializePayment(req, row)),
      paymentsEnabled: mp.mpStatus(ctx.config).configured,
    });
  });

  router.post("/api/portal/orders/:id/pay", requireAuth, requireCap("portal.access"), async (req, res) => {
    const row = await getOrderRow(req.params.id);
    if (!row || row.client_id !== req.user.client_id || row.status === "draft") throw notFound("Não encontramos esta cobrança.");
    if (row.status === "paid") throw conflict("Esta cobrança já está paga.");
    if (!OPEN.has(row.status))
      throw conflict("Esta cobrança foi encerrada pela Metta. Fale com a equipe se precisar de uma nova.");
    const gate = await contractGate(ctx, { orderId: row.id, waived: Boolean(row.contract_waived_at) });
    if (!gate.satisfied)
      throw conflict(
        gate.contract?.status === "sent"
          ? "Assine o contrato antes de pagar. Ele está na seção Contratos, nesta mesma página."
          : "A Metta está preparando o contrato deste serviço. O pagamento é liberado depois da assinatura.",
        "contract_required",
      );
    let result;
    try {
      result = await ensureOrderCheckout(req, row);
    } catch (err) {
      if (err?.code === "integration_not_configured") throw notConfigured(mp.MESSAGES.clientNotConfigured);
      if (err?.code === "upstream_error")
        throw upstream("Não foi possível abrir o pagamento no Mercado Pago agora. Tente de novo em instantes.");
      throw err;
    }
    await logActivity(req, {
      action: "order.checkout_opened",
      entityType: "order",
      entityId: row.id,
      clientId: row.client_id,
      brandId: row.brand_id,
      summary: `${req.user.name} abriu o pagamento no Mercado Pago`,
    });
    res.json({ checkoutUrl: result.url, order: await serializeOrder(req, await getOrderRow(row.id)) });
  });

  return router;
}
