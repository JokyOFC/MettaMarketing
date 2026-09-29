// Commerce + Mercado Pago: catalog, orders, subscriptions, webhooks and the
// client billing portal, against a mock Mercado Pago API on an ephemeral port.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { pruneWebhookEvents, UNSIGNED_LIMIT, WEBHOOK_RETENTION } from "../routes/webhooks.js";
import { signManifest, webhookIdle } from "../services/mercadopago.js";
import {
  addStaffAccess,
  createClientWithBrand,
  createProject,
  createUser,
  login,
  startTestServer,
} from "./helpers.js";

const SECRET = "whsec-test-3f9a0c2b";

// ---------------------------------------------------------------- mock Mercado Pago

async function startMockMp() {
  const state = {
    mode: "ok",
    calls: [],
    preferences: [],
    preapprovals: new Map(),
    payments: new Map(),
    authorized: new Map(),
    seq: 0,
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const url = new URL(req.url, "http://mock");
    state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (state.mode === "timeout") return; // never answers
    if (state.mode === "unauthorized") return send(401, { message: "invalid access token", status: 401 });
    if (state.mode === "badrequest")
      return send(400, { message: "invalid_items", status: 400, cause: [{ code: 1, description: "items.unit_price must be a number" }] });
    if (state.mode === "down") return send(503, { message: "service unavailable" });

    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "POST" && url.pathname === "/checkout/preferences") {
      state.seq += 1;
      const id = `pref-${state.seq}`;
      state.preferences.push({ id, body, headers: req.headers });
      return send(201, {
        id,
        init_point: `https://mp.example/checkout?pref_id=${id}`,
        sandbox_init_point: `https://sandbox.mp.example/checkout?pref_id=${id}`,
      });
    }
    if (req.method === "PUT" && parts[0] === "checkout" && parts[1] === "preferences") return send(200, { id: parts[2], expires: true });
    if (req.method === "POST" && url.pathname === "/preapproval") {
      state.seq += 1;
      const id = `pre${state.seq}`;
      const record = { id, status: "pending", ...body };
      state.preapprovals.set(id, record);
      return send(201, { ...record, init_point: `https://mp.example/subscriptions/checkout?preapproval_id=${id}` });
    }
    if (parts[0] === "preapproval" && parts[1]) {
      const record = state.preapprovals.get(parts[1]);
      if (!record) return send(404, { message: "preapproval not found" });
      if (req.method === "PUT") Object.assign(record, body);
      return send(200, record);
    }
    if (req.method === "GET" && url.pathname === "/v1/payments/search") {
      const results = [...state.payments.values()].filter((p) => p.external_reference === url.searchParams.get("external_reference"));
      return send(200, { results, paging: { total: results.length } });
    }
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "payments") {
      const payment = state.payments.get(parts[2]);
      return payment ? send(200, payment) : send(404, { message: "Payment not found", status: 404 });
    }
    if (req.method === "GET" && parts[0] === "authorized_payments") {
      const record = state.authorized.get(parts[1]);
      return record ? send(200, record) : send(404, { message: "not found" });
    }
    send(404, { message: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    calls: (method, prefix) => state.calls.filter((c) => c.method === method && c.path.startsWith(prefix)),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function addPayment(mock, id, fields) {
  const payment = {
    id: Number(id),
    status: "approved",
    status_detail: "accredited",
    transaction_amount: 1500,
    currency_id: "BRL",
    payment_type_id: "credit_card",
    payment_method_id: "visa",
    date_created: "2026-09-28T09:58:00.000-04:00",
    date_approved: "2026-09-28T10:00:00.000-04:00",
    live_mode: false,
    ...fields,
  };
  mock.state.payments.set(String(id), payment);
  return payment;
}

async function sendWebhook(server, { type = "payment", dataId, requestId = randomUUID(), secret = SECRET, signature } = {}) {
  const ts = String(Date.now());
  const header = signature ?? signManifest(secret, { dataId, requestId, ts });
  const response = await fetch(`${server.url}/api/webhooks/mercadopago?data.id=${encodeURIComponent(dataId)}&type=${type}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": header, "x-request-id": requestId },
    body: JSON.stringify({ action: `${type}.updated`, api_version: "v1", data: { id: String(dataId) }, type, live_mode: false }),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  await webhookIdle(server.ctx);
  return { status: response.status, body, requestId };
}

// ---------------------------------------------------------------- fixtures

let mock;
let server;
let ctx;
const u = {};
const a = {};
const f = {};

before(async () => {
  mock = await startMockMp();
  server = await startTestServer({
    mpAccessToken: "TEST-1234567890-abc",
    mpWebhookSecret: SECRET,
    mpApiBase: mock.url,
    appUrl: "https://app.metta.test",
  });
  ctx = server.ctx;

  const clientA = await createClientWithBrand(ctx, { name: "Cliente A", brandName: "Marca A" });
  const clientB = await createClientWithBrand(ctx, { name: "Cliente B", brandName: "Marca B" });
  Object.assign(f, { clientA: clientA.clientId, brandA: clientA.brandId, clientB: clientB.clientId, brandB: clientB.brandId });

  u.admin = await createUser(ctx, { role: "admin" });
  u.finance = await createUser(ctx, { role: "finance" });
  u.manager = await createUser(ctx, { role: "manager" });
  u.designer = await createUser(ctx, { role: "designer" });
  u.clientA = await createUser(ctx, { role: "client", clientId: f.clientA });
  u.clientB = await createUser(ctx, { role: "client", clientId: f.clientB });
  await addStaffAccess(ctx, u.manager.id, f.clientA);
  await createProject(ctx, { brandId: f.brandA, memberIds: [u.designer.id] });

  for (const [key, user] of Object.entries(u)) a[key] = await login(server, { email: user.email });
});

after(async () => {
  await webhookIdle(ctx);
  await server?.close();
  await mock?.close();
});

async function newOrder(agent = a.finance, body = {}) {
  const res = await agent.post("/api/orders", {
    clientId: f.clientA,
    brandId: f.brandA,
    description: "Identidade visual — ajustes finais",
    amountCents: 150000,
    dueDate: "2026-10-15",
    ...body,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.order;
}

const orderRow = async (id) => await ctx.db.get("SELECT * FROM orders WHERE id = ?", [id]);

// ---------------------------------------------------------------- tests

describe("Mercado Pago not configured", () => {
  test("checkout answers 503 and clients get a friendly message", async () => {
    const bare = await startTestServer();
    try {
      const { clientId } = await createClientWithBrand(bare.ctx, { name: "Sem MP" });
      const admin = await login(bare, { email: (await createUser(bare.ctx, { role: "admin" })).email });
      const client = await login(bare, { email: (await createUser(bare.ctx, { role: "client", clientId })).email });

      const status = await admin.get("/api/finance/status");
      assert.equal(status.status, 200);
      assert.equal(status.body.mercadopago.configured, false);
      assert.equal(status.body.mercadopago.mode, null);

      const created = await admin.post("/api/orders", { clientId, description: "Pacote de posts", amountCents: 90000 });
      assert.equal(created.status, 201);
      const checkout = await admin.post(`/api/orders/${created.body.order.id}/checkout`, {});
      assert.equal(checkout.status, 503);
      assert.equal(checkout.body.error.code, "integration_not_configured");
      assert.match(checkout.body.error.message, /^Mercado Pago não configurado/);
      assert.equal((await bare.db.get("SELECT status FROM orders WHERE id = ?", [created.body.order.id])).status, "draft");

      await bare.db.run("UPDATE orders SET status = 'pending_payment' WHERE id = ?", [created.body.order.id]);
      const pay = await client.post(`/api/portal/orders/${created.body.order.id}/pay`, {});
      assert.equal(pay.status, 503);
      assert.equal(pay.body.error.message, "Pagamento online indisponível no momento. Fale com a Metta.");
      const billing = await client.get("/api/portal/billing");
      assert.equal(billing.body.paymentsEnabled, false);

      // Without the webhook secret nothing is trusted.
      const hook = await fetch(`${bare.url}/api/webhooks/mercadopago?data.id=1&type=payment`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "r-1", "x-signature": "ts=1,v1=abc" },
        body: JSON.stringify({ type: "payment", data: { id: "1" } }),
      });
      assert.equal(hook.status, 401);
      const event = await bare.db.get("SELECT * FROM webhook_events WHERE request_id = 'r-1'");
      assert.equal(event.signature_valid, 0);
      assert.match(event.error, /MP_WEBHOOK_SECRET/);
    } finally {
      await bare.close();
    }
  });
});

describe("services catalog", () => {
  test("finance manages the catalog, manager only reads, others are blocked", async () => {
    const created = await a.finance.post("/api/services", {
      name: "Gestão de redes",
      kind: "subscription",
      priceCents: 250000,
      description: "Plano mensal de conteúdo",
      items: ["12 posts por mês", "Reunião estratégica mensal"],
      includesEditables: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const service = created.body.service;
    assert.equal(service.kind, "subscription");
    assert.equal(service.billingInterval, "monthly");
    assert.deepEqual(service.items, ["12 posts por mês", "Reunião estratégica mensal"]);
    f.plan = service.id;

    const invalid = await a.finance.post("/api/services", { name: "", kind: "x", priceCents: -1 });
    assert.equal(invalid.status, 422);
    assert.ok(invalid.body.error.fields.name && invalid.body.error.fields.kind && invalid.body.error.fields.priceCents);

    const off = await a.finance.patch(`/api/services/${service.id}`, { active: false });
    assert.equal(off.body.service.active, false);
    const on = await a.admin.patch(`/api/services/${service.id}`, { active: true, priceCents: 260000 });
    assert.equal(on.body.service.priceCents, 260000);

    const list = await a.manager.get("/api/services");
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((item) => item.id === service.id));
    assert.equal((await a.manager.post("/api/services", { name: "X", kind: "one_off", priceCents: 1 })).status, 403);
    assert.equal((await a.manager.patch(`/api/services/${service.id}`, { active: false })).status, 403);
    assert.equal((await a.designer.get("/api/services")).status, 403);
    assert.equal((await a.clientA.get("/api/services")).status, 403);

    const ids = list.body.items.map((item) => item.id).reverse();
    const reordered = await a.finance.post("/api/services/reorder", { ids });
    assert.equal(reordered.status, 200);
    assert.deepEqual(reordered.body.items.map((item) => item.id), ids);
  });
});

describe("orders and checkout", () => {
  test("creating a checkout builds the preference and moves draft to pending_payment", async () => {
    const order = await newOrder();
    assert.equal(order.status, "draft");
    assert.equal(order.amountCents, 150000);
    assert.equal(order.externalReference, `metta-${order.id}`);

    const before = mock.state.preferences.length;
    const res = await a.finance.post(`/api/orders/${order.id}/checkout`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.reused, false);
    assert.match(res.body.checkoutUrl, /sandbox\.mp\.example/); // TEST- token -> sandbox link
    assert.equal(res.body.order.status, "pending_payment");

    const sent = mock.state.preferences.at(-1);
    assert.equal(mock.state.preferences.length, before + 1);
    assert.equal(sent.headers.authorization, "Bearer TEST-1234567890-abc");
    assert.ok(sent.headers["x-idempotency-key"]);
    assert.equal(sent.body.external_reference, order.externalReference);
    assert.equal(sent.body.items[0].unit_price, 1500);
    assert.equal(sent.body.items[0].currency_id, "BRL");
    assert.equal(sent.body.back_urls.success, "https://app.metta.test/painel/financeiro?retorno=sucesso");
    assert.equal(sent.body.back_urls.pending, "https://app.metta.test/painel/financeiro?retorno=pendente");
    assert.equal(sent.body.back_urls.failure, "https://app.metta.test/painel/financeiro?retorno=falha");
    assert.equal(sent.body.notification_url, "https://app.metta.test/api/webhooks/mercadopago");
    assert.equal(sent.body.auto_return, "approved");

    const again = await a.finance.post(`/api/orders/${order.id}/checkout`, {});
    assert.equal(again.body.reused, true);
    assert.equal(mock.state.preferences.length, before + 1);

    // Amount cannot change once a link exists; due date still can.
    assert.equal((await a.finance.patch(`/api/orders/${order.id}`, { amountCents: 1 })).status, 409);
    assert.equal((await a.finance.patch(`/api/orders/${order.id}`, { dueDate: "2026-10-20" })).body.order.dueDate, "2026-10-20");
    f.order = order;
  });

  test("order validation explains missing fields in pt-BR", async () => {
    const res = await a.finance.post("/api/orders", { clientId: f.clientA, brandId: f.brandB });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.fields.brandId, "Esta marca não pertence ao cliente escolhido.");
    const res2 = await a.finance.post("/api/orders", { clientId: f.clientA });
    assert.equal(res2.status, 422);
    assert.equal(res2.body.error.fields.description, "Descreva o pedido ou escolha um serviço.");
    assert.equal(res2.body.error.fields.amountCents, "Informe um valor maior que zero.");
  });

  test("send notifies the client's users in-app and by e-mail", async () => {
    const res = await a.finance.post(`/api/orders/${f.order.id}/send`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sent, 1);
    assert.equal(res.body.emailConfigured, false);
    const note = await ctx.db.get("SELECT * FROM notifications WHERE user_id = ? AND type = 'order.sent'", [u.clientA.id]);
    assert.ok(note);
    assert.equal(note.link, "/painel/financeiro");
    const mail = await ctx.db.get("SELECT * FROM email_outbox WHERE to_user_id = ? ORDER BY created_at DESC LIMIT 1", [u.clientA.id]);
    assert.ok(mail);
    assert.equal(mail.status, "not_configured");
  });
});

describe("webhooks", () => {
  test("valid signature: the payment is confirmed through the API and the order is paid", async () => {
    addPayment(mock, 5001, { external_reference: f.order.externalReference });
    const fetchesBefore = mock.calls("GET", "/v1/payments/5001").length;
    const res = await sendWebhook(server, { dataId: "5001" });
    assert.equal(res.status, 200);
    assert.equal(mock.calls("GET", "/v1/payments/5001").length, fetchesBefore + 1);

    const order = await orderRow(f.order.id);
    assert.equal(order.status, "paid");
    assert.equal(order.paid_at, "2026-09-28T14:00:00.000Z");
    const payment = await ctx.db.get("SELECT * FROM payments WHERE provider_payment_id = '5001'");
    assert.equal(payment.order_id, f.order.id);
    assert.equal(payment.client_id, f.clientA);
    assert.equal(payment.amount_cents, 150000);
    assert.equal(payment.method, "credit_card/visa");

    const event = await ctx.db.get("SELECT * FROM webhook_events WHERE request_id = ?", [res.requestId]);
    assert.equal(event.signature_valid, 1);
    assert.ok(event.processed_at);
    assert.equal(event.error, null);

    assert.ok(await ctx.db.get("SELECT id FROM notifications WHERE user_id = ? AND type = 'payment.approved'", [u.clientA.id]));
    assert.ok(await ctx.db.get("SELECT id FROM notifications WHERE user_id = ? AND type = 'payment.approved'", [u.finance.id]));
    assert.equal(await ctx.db.get("SELECT id FROM notifications WHERE user_id = ? AND type = 'payment.approved'", [u.clientB.id]), undefined);
    const log = await ctx.db.get("SELECT * FROM activity_log WHERE action = 'payment.approved' AND entity_id = ?", [f.order.id]);
    assert.equal(log.visibility, "client");

    const billing = await a.clientA.get("/api/portal/billing");
    const mine = billing.body.orders.find((o) => o.id === f.order.id);
    assert.equal(mine.status, "paid");
    assert.equal(mine.canPay, false);
    assert.ok(billing.body.payments.some((p) => p.providerPaymentId === "5001" && p.status === "approved" && p.methodLabel === "Cartão de crédito (Visa)"));
  });

  test("duplicated delivery (same x-request-id) is idempotent", async () => {
    const order = await newOrder();
    await a.finance.post(`/api/orders/${order.id}/checkout`, {});
    addPayment(mock, 5002, { external_reference: order.externalReference });
    const requestId = randomUUID();
    const first = await sendWebhook(server, { dataId: "5002", requestId });
    assert.equal(first.status, 200);
    const notes = (await ctx.db.get("SELECT COUNT(*) AS n FROM notifications")).n;
    const fetches = mock.calls("GET", "/v1/payments/5002").length;
    const logs = (await ctx.db.get("SELECT COUNT(*) AS n FROM activity_log")).n;

    const second = await sendWebhook(server, { dataId: "5002", requestId });
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(mock.calls("GET", "/v1/payments/5002").length, fetches);
    assert.equal((await ctx.db.get("SELECT COUNT(*) AS n FROM notifications")).n, notes);
    assert.equal((await ctx.db.get("SELECT COUNT(*) AS n FROM activity_log")).n, logs);
    assert.equal((await ctx.db.get("SELECT COUNT(*) AS n FROM payments WHERE provider_payment_id = '5002'")).n, 1);
    assert.equal((await ctx.db.get("SELECT COUNT(*) AS n FROM webhook_events WHERE request_id = ?", [requestId])).n, 1);

    // A new delivery (new request id) for the same unchanged payment changes nothing either.
    await sendWebhook(server, { dataId: "5002" });
    assert.equal((await ctx.db.get("SELECT COUNT(*) AS n FROM notifications")).n, notes);
  });

  test("invalid signature answers 401, is recorded and changes nothing", async () => {
    const order = await newOrder();
    await a.finance.post(`/api/orders/${order.id}/checkout`, {});
    addPayment(mock, 5003, { external_reference: order.externalReference });
    const fetches = mock.calls("GET", "/v1/payments/5003").length;
    const res = await sendWebhook(server, { dataId: "5003", secret: "wrong-secret" });
    assert.equal(res.status, 401);
    const event = await ctx.db.get("SELECT * FROM webhook_events WHERE request_id = ?", [res.requestId]);
    assert.equal(event.signature_valid, 0);
    assert.match(event.error, /Assinatura inválida/);
    assert.equal((await orderRow(order.id)).status, "pending_payment");
    assert.equal(mock.calls("GET", "/v1/payments/5003").length, fetches);
    assert.equal(await ctx.db.get("SELECT id FROM payments WHERE provider_payment_id = '5003'"), undefined);

    const malformed = await sendWebhook(server, { dataId: "5003", signature: "garbage" });
    assert.equal(malformed.status, 401);

    const webhooks = await a.finance.get("/api/finance/webhooks");
    const listed = webhooks.body.items.find((item) => item.requestId === res.requestId);
    assert.equal(listed.signatureValid, false);
    assert.ok(listed.error);
  });

  test("rejected payment marks the order failed with a pt-BR reason; the client can retry", async () => {
    const order = await newOrder();
    const checkout = await a.finance.post(`/api/orders/${order.id}/checkout`, {});
    addPayment(mock, 5004, {
      external_reference: order.externalReference,
      status: "rejected",
      status_detail: "cc_rejected_insufficient_amount",
      date_approved: null,
    });
    const res = await sendWebhook(server, { dataId: "5004" });
    assert.equal(res.status, 200);
    const row = await orderRow(order.id);
    assert.equal(row.status, "failed");
    assert.equal(row.failure_reason, "Saldo ou limite insuficiente");
    assert.ok(await ctx.db.get("SELECT id FROM notifications WHERE user_id = ? AND type = 'payment.failed'", [u.clientA.id]));

    const detail = await a.finance.get(`/api/orders/${order.id}`);
    assert.equal(detail.body.order.failureReason, "Saldo ou limite insuficiente");
    assert.equal(detail.body.order.payments[0].reason, "Saldo ou limite insuficiente");
    assert.ok(detail.body.order.timeline.some((entry) => entry.action === "payment.rejected"));

    const prefs = mock.state.preferences.length;
    const pay = await a.clientA.post(`/api/portal/orders/${order.id}/pay`, {});
    assert.equal(pay.status, 200);
    assert.equal(pay.body.checkoutUrl, checkout.body.checkoutUrl);
    assert.equal(mock.state.preferences.length, prefs);

    // A later approved attempt settles it.
    addPayment(mock, 5005, { external_reference: order.externalReference });
    await sendWebhook(server, { dataId: "5005" });
    assert.equal((await orderRow(order.id)).status, "paid");
    assert.equal((await orderRow(order.id)).failure_reason, null);
  });

  test("unknown references are recorded with an error and never crash", async () => {
    addPayment(mock, 5006, { external_reference: "outra-loja-123" });
    const res = await sendWebhook(server, { dataId: "5006" });
    assert.equal(res.status, 200);
    const event = await ctx.db.get("SELECT * FROM webhook_events WHERE request_id = ?", [res.requestId]);
    assert.ok(event.processed_at);
    assert.match(event.error, /Referência desconhecida/);
    assert.equal(await ctx.db.get("SELECT id FROM payments WHERE provider_payment_id = '5006'"), undefined);

    const missing = await sendWebhook(server, { dataId: "999999" });
    assert.equal(missing.status, 200);
    assert.match((await ctx.db.get("SELECT error FROM webhook_events WHERE request_id = ?", [missing.requestId])).error, /recusou/);

    const other = await sendWebhook(server, { type: "merchant_order", dataId: "77" });
    assert.equal(other.status, 200);
    assert.equal((await ctx.db.get("SELECT error FROM webhook_events WHERE request_id = ?", [other.requestId])).error, null);

    const broken = await fetch(`${server.url}/api/webhooks/mercadopago`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "broken-1" },
      body: "{not json",
    });
    assert.equal(broken.status, 400);
    assert.ok(await ctx.db.get("SELECT id FROM webhook_events WHERE request_id = 'broken-1'"));
  });

  test("unsigned deliveries store no payload, are limited per IP and pruned", async () => {
    const fresh = await startTestServer({ mpAccessToken: "TEST-1234567890-abc", mpWebhookSecret: SECRET, mpApiBase: mock.url });
    try {
      const big = JSON.stringify({ type: "payment", data: { id: "1" }, filler: "x".repeat(200 * 1024) });
      const statuses = [];
      for (let i = 0; i < UNSIGNED_LIMIT.max + 10; i += 1) {
        const res = await fetch(`${fresh.url}/api/webhooks/mercadopago?data.id=1&type=payment`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": `spam-${i}`, "x-signature": "ts=1,v1=abc" },
          body: big,
        });
        statuses.push(res.status);
      }
      assert.ok(statuses.slice(0, UNSIGNED_LIMIT.max).every((code) => code === 401));
      assert.ok(statuses.slice(UNSIGNED_LIMIT.max).every((code) => code === 429), "beyond the limit nothing is stored");
      const stored = await fresh.db.get("SELECT COUNT(*) AS n, SUM(LENGTH(IFNULL(payload, ''))) AS bytes FROM webhook_events");
      assert.equal(stored.n, UNSIGNED_LIMIT.max);
      assert.equal(stored.bytes, 0, "no payload from unsigned requests");
      const row = await fresh.db.get("SELECT * FROM webhook_events WHERE request_id = 'spam-0'");
      assert.equal(row.signature_valid, 0);
      assert.match(row.error, /Assinatura inválida/);

      // a signed delivery still goes through (the limit only counts rejected ones) and keeps its payload
      addPayment(mock, 5101, { external_reference: "sem-pedido-5101" });
      const signed = await sendWebhook(fresh, { dataId: "5101" });
      assert.equal(signed.status, 200);
      assert.ok((await fresh.db.get("SELECT payload FROM webhook_events WHERE request_id = ?", [signed.requestId])).payload.includes("5101"));

      // a signed delivery reusing an id first seen unsigned replaces the stored metadata
      const reused = await sendWebhook(fresh, { dataId: "5101", requestId: "spam-1" });
      assert.equal(reused.status, 200);
      const upgraded = await fresh.db.get("SELECT * FROM webhook_events WHERE request_id = 'spam-1'");
      assert.equal(upgraded.signature_valid, 1);
      assert.ok(upgraded.payload.includes("5101"));

      // retention: old rejected rows go, the newest ones are capped, pending signed rows stay
      const insert = async (id, valid, receivedAt, processed) =>
        await fresh.db.run(
          "INSERT INTO webhook_events (id, provider, request_id, signature_valid, received_at, processed_at) VALUES (?, 'mercadopago', ?, ?, ?, ?)",
          [id, id, valid, receivedAt, processed],
        );
      const old = new Date(Date.now() - (WEBHOOK_RETENTION.unsignedDays + 1) * 86400000).toISOString();
      const veryOld = new Date(Date.now() - (WEBHOOK_RETENTION.signedDays + 1) * 86400000).toISOString();
      await fresh.db.tx(async () => {
        await insert("whk_oldUnsigned0001", 0, old, null);
        await insert("whk_oldSignedDone01", 1, veryOld, veryOld);
        await insert("whk_oldSignedOpen01", 1, veryOld, null);
        for (let i = 0; i < WEBHOOK_RETENTION.unsignedKeep + 20; i += 1)
          await insert(`whk_flood${String(i).padStart(10, "0")}`, 0, new Date(Date.now() - i * 1000).toISOString(), null);
      });
      await pruneWebhookEvents(fresh.db);
      assert.equal((await fresh.db.get("SELECT COUNT(*) AS n FROM webhook_events WHERE signature_valid = 0")).n, WEBHOOK_RETENTION.unsignedKeep);
      assert.equal(await fresh.db.get("SELECT id FROM webhook_events WHERE id = 'whk_oldUnsigned0001'"), undefined);
      assert.equal(await fresh.db.get("SELECT id FROM webhook_events WHERE id = 'whk_oldSignedDone01'"), undefined);
      assert.ok(await fresh.db.get("SELECT id FROM webhook_events WHERE id = 'whk_oldSignedOpen01'"), "unprocessed signed rows are kept");
      assert.ok(await fresh.db.get("SELECT id FROM webhook_events WHERE request_id = ?", [signed.requestId]));
      await webhookIdle(fresh.ctx);
    } finally {
      await fresh.close();
    }
  });

  test("sync pulls payments from Mercado Pago when a notification was missed", async () => {
    const order = await newOrder();
    await a.finance.post(`/api/orders/${order.id}/checkout`, {});
    addPayment(mock, 5007, { external_reference: order.externalReference, status: "pending", status_detail: "pending_waiting_payment", date_approved: null });
    addPayment(mock, 5008, { external_reference: order.externalReference, date_created: "2026-09-28T11:00:00.000-04:00" });
    const res = await a.finance.post(`/api/orders/${order.id}/sync`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.found, 2);
    assert.equal(res.body.order.status, "paid");
    assert.equal(res.body.order.payments.length, 2);
  });
});

describe("upstream failures", () => {
  test("timeout, rejected credentials and validation errors answer 502 without changing the order", async () => {
    const order = await newOrder();
    ctx.config.mpTimeoutMs = 250;
    try {
      mock.state.mode = "timeout";
      const slow = await a.finance.post(`/api/orders/${order.id}/checkout`, {});
      assert.equal(slow.status, 502);
      assert.equal(slow.body.error.code, "upstream_error");
      assert.equal(slow.body.error.message, "Mercado Pago indisponível no momento. Tente de novo.");

      mock.state.mode = "unauthorized";
      const denied = await a.finance.post(`/api/orders/${order.id}/checkout`, {});
      assert.equal(denied.status, 502);
      assert.match(denied.body.error.message, /^Credenciais do Mercado Pago recusadas/);

      mock.state.mode = "badrequest";
      const invalid = await a.finance.post(`/api/orders/${order.id}/checkout`, {});
      assert.equal(invalid.status, 502);
      assert.match(invalid.body.error.message, /items\.unit_price must be a number/);

      mock.state.mode = "down";
      await a.finance.patch(`/api/orders/${order.id}`, {}); // no-op
      await ctx.db.run("UPDATE orders SET status = 'pending_payment' WHERE id = ?", [order.id]);
      const pay = await a.clientA.post(`/api/portal/orders/${order.id}/pay`, {});
      assert.equal(pay.status, 502);
      assert.match(pay.body.error.message, /Tente de novo/);
      await ctx.db.run("UPDATE orders SET status = 'draft' WHERE id = ?", [order.id]);
    } finally {
      mock.state.mode = "ok";
      delete ctx.config.mpTimeoutMs;
    }
    const row = await orderRow(order.id);
    assert.equal(row.status, "draft");
    assert.equal(row.checkout_url, null);
  });
});

describe("subscriptions", () => {
  test("preapproval checkout, activation by webhook and cancellation through Mercado Pago", async () => {
    const created = await a.finance.post("/api/subscriptions", {
      clientId: f.clientA,
      serviceId: f.plan,
      payerEmail: "Pagador@Cliente-A.test",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sub = created.body.subscription;
    assert.equal(sub.status, "pending");
    assert.equal(sub.amountCents, 260000);
    assert.equal(sub.payerEmail, "pagador@cliente-a.test");

    const dup = await a.finance.post("/api/subscriptions", { clientId: f.clientA, serviceId: f.plan, payerEmail: "x@y.test" });
    assert.equal(dup.status, 409);

    const checkout = await a.finance.post(`/api/subscriptions/${sub.id}/checkout`, {});
    assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
    const call = mock.calls("POST", "/preapproval").at(-1);
    assert.equal(call.body.payer_email, "pagador@cliente-a.test");
    assert.equal(call.body.external_reference, sub.externalReference);
    assert.deepEqual(call.body.auto_recurring, { frequency: 1, frequency_type: "months", transaction_amount: 2600, currency_id: "BRL" });
    assert.equal(call.body.status, "pending");
    assert.equal(call.body.back_url, "https://app.metta.test/painel/financeiro?retorno=assinatura");
    const preapprovalId = checkout.body.subscription.mpPreapprovalId;
    assert.ok(preapprovalId);

    const portalPending = await a.clientA.get("/api/portal/billing");
    assert.equal(portalPending.body.subscriptions.find((s) => s.id === sub.id).checkoutUrl, checkout.body.checkoutUrl);

    Object.assign(mock.state.preapprovals.get(preapprovalId), { status: "authorized", next_payment_date: "2026-10-28T10:00:00.000-04:00" });
    const hook = await sendWebhook(server, { type: "subscription_preapproval", dataId: preapprovalId });
    assert.equal(hook.status, 200);
    const active = await ctx.db.get("SELECT * FROM subscriptions WHERE id = ?", [sub.id]);
    assert.equal(active.status, "active");
    assert.equal(active.next_billing_date, "2026-10-28");
    assert.ok(active.started_at);
    assert.ok(await ctx.db.get("SELECT id FROM notifications WHERE user_id = ? AND type = 'subscription.active'", [u.clientA.id]));

    const summary = await a.finance.get("/api/finance/summary");
    assert.equal(summary.body.subscriptions.active, 1);
    assert.equal(summary.body.subscriptions.monthlyCents, 260000);

    const cancel = await a.finance.post(`/api/subscriptions/${sub.id}/cancel`, {});
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.equal(cancel.body.subscription.status, "cancelled");
    const put = mock.calls("PUT", `/preapproval/${preapprovalId}`).at(-1);
    assert.deepEqual(put.body, { status: "cancelled" });
  });

  test("recurring charges arrive as authorized payments and are linked to the subscription", async () => {
    const created = await a.finance.post("/api/subscriptions", { clientId: f.clientA, serviceId: f.plan, payerEmail: "p@a.test" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sub = created.body.subscription;
    const checkout = await a.finance.post(`/api/subscriptions/${sub.id}/checkout`, {});
    const preapprovalId = checkout.body.subscription.mpPreapprovalId;
    addPayment(mock, 6001, {
      external_reference: null,
      status: "rejected",
      status_detail: "cc_rejected_card_disabled",
      transaction_amount: 2600,
      date_approved: null,
    });
    mock.state.authorized.set("7001", { id: 7001, preapproval_id: preapprovalId, payment: { id: 6001 } });
    const res = await sendWebhook(server, { type: "subscription_authorized_payment", dataId: "7001" });
    assert.equal(res.status, 200);
    assert.equal((await ctx.db.get("SELECT error FROM webhook_events WHERE request_id = ?", [res.requestId])).error, null);
    const payment = await ctx.db.get("SELECT * FROM payments WHERE provider_payment_id = '6001'");
    assert.equal(payment.subscription_id, sub.id);
    assert.equal(payment.client_id, f.clientA);
    assert.match((await ctx.db.get("SELECT failure_reason FROM subscriptions WHERE id = ?", [sub.id])).failure_reason, /Cartão desativado/);
    const billing = await a.clientA.get("/api/portal/billing");
    assert.ok(billing.body.payments.some((p) => p.subscription?.id === sub.id && p.reason?.startsWith("Cartão desativado")));
    await a.finance.post(`/api/subscriptions/${sub.id}/cancel`, {});
  });

  test("cancellation keeps the subscription when Mercado Pago fails", async () => {
    const plan = await a.finance.post("/api/services", { name: "Plano Estratégia", kind: "subscription", priceCents: 100000 });
    const created = await a.finance.post("/api/subscriptions", { clientId: f.clientB, serviceId: plan.body.service.id, payerEmail: "b@b.test" });
    const sub = created.body.subscription;
    await a.finance.post(`/api/subscriptions/${sub.id}/checkout`, {});
    mock.state.mode = "down";
    try {
      const res = await a.finance.post(`/api/subscriptions/${sub.id}/cancel`, {});
      assert.equal(res.status, 502);
    } finally {
      mock.state.mode = "ok";
    }
    assert.equal((await ctx.db.get("SELECT status FROM subscriptions WHERE id = ?", [sub.id])).status, "pending");
  });
});

describe("isolation and permissions", () => {
  test("clients only see and pay their own non-draft orders", async () => {
    const draft = await newOrder(a.finance, { description: "Rascunho interno" });
    const open = await newOrder(a.finance, { description: "Pacote de stories" });
    await a.finance.post(`/api/orders/${open.id}/checkout`, {});
    const other = await newOrder(a.finance, { clientId: f.clientB, brandId: f.brandB, description: "Pedido do cliente B" });
    await a.finance.post(`/api/orders/${other.id}/checkout`, {});

    const billingA = await a.clientA.get("/api/portal/billing");
    assert.equal(billingA.status, 200);
    const idsA = billingA.body.orders.map((o) => o.id);
    assert.ok(idsA.includes(open.id));
    assert.ok(!idsA.includes(draft.id), "drafts stay internal");
    assert.ok(!idsA.includes(other.id));
    assert.ok(billingA.body.payments.every((p) => p.order === null || idsA.includes(p.order.id)));

    const billingB = await a.clientB.get("/api/portal/billing");
    const idsB = billingB.body.orders.map((o) => o.id);
    assert.ok(idsB.includes(other.id));
    assert.ok(!idsB.includes(open.id));
    assert.ok(billingB.body.payments.every((p) => p.order === null || idsB.includes(p.order.id)));

    assert.equal((await a.clientB.post(`/api/portal/orders/${open.id}/pay`, {})).status, 404);
    assert.equal((await a.clientA.post(`/api/portal/orders/${draft.id}/pay`, {})).status, 404);
    assert.equal((await a.clientA.post(`/api/portal/orders/${f.order.id}/pay`, {})).status, 409); // already paid
    const pay = await a.clientA.post(`/api/portal/orders/${open.id}/pay`, {});
    assert.equal(pay.status, 200);
    assert.match(pay.body.checkoutUrl, /^https:\/\//);

    // Staff-only fields never reach the client.
    const order = billingA.body.orders.find((o) => o.id === open.id);
    for (const field of ["externalReference", "checkoutUrl", "createdBy", "hasCheckout"]) assert.ok(!(field in order), field);
    const payment = billingA.body.payments[0];
    assert.ok(!("statusDetail" in payment) && !("client" in payment));
    assert.ok(!("mpPreapprovalId" in billingA.body.subscriptions[0]));

    // Clients never reach staff endpoints.
    assert.equal((await a.clientA.get("/api/orders")).status, 403);
    assert.equal((await a.clientA.get(`/api/orders/${open.id}`)).status, 403);
    assert.equal((await a.clientA.get("/api/payments")).status, 403);
    assert.equal((await a.clientA.get("/api/finance/summary")).status, 403);
    assert.equal((await a.finance.get("/api/portal/billing")).status, 403);
  });

  test("designers and managers cannot see finance", async () => {
    for (const agent of [a.designer, a.manager]) {
      assert.equal((await agent.get("/api/finance/summary")).status, 403);
      assert.equal((await agent.get("/api/finance/status")).status, 403);
      assert.equal((await agent.get("/api/finance/webhooks")).status, 403);
      assert.equal((await agent.get("/api/payments")).status, 403);
      assert.equal((await agent.get("/api/orders")).status, 403);
      assert.equal((await agent.get(`/api/orders/${f.order.id}`)).status, 403);
      assert.equal((await agent.post(`/api/orders/${f.order.id}/checkout`, {})).status, 403);
      assert.equal((await agent.get("/api/subscriptions")).status, 403);
      assert.equal((await agent.get("/api/commerce/options")).status, 403);
    }
    assert.equal((await a.finance.get("/api/orders/ord_AAAAAAAAAAAAAAAA")).status, 404);
  });

  test("finance summary uses real sums and counts", async () => {
    const res = await a.finance.get("/api/finance/summary");
    assert.equal(res.status, 200);
    const db = ctx.db;
    const open = await db.get("SELECT COUNT(*) AS n, SUM(amount_cents) AS cents FROM orders WHERE status IN ('pending_payment', 'failed')");
    assert.equal(res.body.receivable.count, open.n);
    assert.equal(res.body.receivable.cents, open.cents ?? 0);
    assert.equal(res.body.failures.recent, (await db.get("SELECT COUNT(*) AS n FROM payments WHERE status IN ('rejected', 'charged_back')")).n);
    // Every approved test payment is dated 2026-09-28 (Brasília); only count it in that month.
    const month = res.body.month;
    const approved = await db.get("SELECT COUNT(*) AS n, SUM(amount_cents) AS cents FROM payments WHERE status = 'approved'");
    if (month === "2026-09") {
      assert.equal(res.body.receivedThisMonth.count, approved.n);
      assert.equal(res.body.receivedThisMonth.cents, approved.cents);
    } else {
      assert.equal(res.body.receivedThisMonth.count, 0);
    }

    const payments = await a.finance.get("/api/payments?status=approved");
    assert.equal(payments.body.total, approved.n);
    const list = await a.admin.get(`/api/orders?clientId=${f.clientB}`);
    assert.ok(list.body.items.every((o) => o.client.id === f.clientB));
    assert.equal(list.body.counts.all, list.body.total);
  });

  test("cancelling an order expires its link and tells the client", async () => {
    const order = await newOrder(a.finance, { description: "Pedido a cancelar" });
    await a.finance.post(`/api/orders/${order.id}/checkout`, {});
    const prefId = (await orderRow(order.id)).mp_preference_id;
    const res = await a.finance.post(`/api/orders/${order.id}/cancel`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.order.status, "cancelled");
    assert.equal(res.body.warning, null);
    assert.equal(mock.calls("PUT", `/checkout/preferences/${prefId}`).at(-1).body.expires, true);
    assert.ok(await ctx.db.get("SELECT id FROM notifications WHERE user_id = ? AND type = 'order.cancelled'", [u.clientA.id]));
    assert.equal((await a.clientA.post(`/api/portal/orders/${order.id}/pay`, {})).status, 409);
    assert.equal((await a.finance.post(`/api/orders/${order.id}/cancel`, {})).status, 409);
  });
});
