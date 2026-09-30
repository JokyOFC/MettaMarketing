// Mock of the Mercado Pago API on an ephemeral port, used by the commerce and
// purchase tests: preferences, preapprovals, payments (search and fetch) and
// authorized payments, plus failure modes (state.mode: timeout, unauthorized,
// badrequest, down). sendWebhook() posts a notification signed like Mercado
// Pago does and waits for its processing.
import { randomUUID } from "node:crypto";
import http from "node:http";
import { signManifest, webhookIdle } from "../../services/mercadopago.js";

export async function startMockMp() {
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

export function addPayment(mock, id, fields) {
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

export async function sendWebhook(server, { type = "payment", dataId, requestId = randomUUID(), secret, signature } = {}) {
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
