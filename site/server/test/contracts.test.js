// Contracts through AssinaVelox: settings gate, PDF preview, sending steps,
// payment gate, embedded signing, webhooks, sync, final files, isolation,
// cancel, waiver and failure handling — against a fake AssinaVelox API.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { webhooks } from "../vendor/assinavelox-sdk/index.js";
import { startFakeAssinaVelox } from "./fakes/assinavelox.js";
import { embedOrigin } from "../services/contracts.js";
import { createClientWithBrand, createUser, login, startTestServer } from "./helpers.js";

const WEBHOOK_SECRET = "whsec_test_contracts_0123456789";

// Raw fetch Response through an agent (keeps the session cookie).
const raw = (agent, path, method = "GET", body) => agent.request(method, path, { body, raw: true });

function signedHeaders(body, secret = WEBHOOK_SECRET, { deliveryId = `dlv_${Math.random().toString(36).slice(2)}`, ts } = {}) {
  const timestamp = ts ?? Math.floor(Date.now() / 1000);
  return {
    "Content-Type": "application/json",
    "X-AssinaVelox-Signature": webhooks.signatureHeader([secret], timestamp, body),
    "X-AssinaVelox-Timestamp": String(timestamp),
    "X-AssinaVelox-Delivery-Id": deliveryId,
    "X-AssinaVelox-Event": JSON.parse(body).type,
  };
}

const TEMPLATE_BODY = (kind) =>
  `**CONTRATANTE:** {{contratante_nome}}, CNPJ {{contratante_documento}}, representada por {{representante_nome}}.

**CONTRATADA:** {{contratada_nome}}, CNPJ {{contratada_documento}}.

# Cláusula 1ª — Do objeto
1.1. Serviço {{servico}} para a marca {{marca}}:
{{itens}}

# Cláusula 2ª — Do valor
2.1. Valor ${kind === "subscription" ? "mensal" : "único"} de {{valor}} ({{valor_por_extenso}}).

# Cláusula 3ª — Do foro
3.1. Foro de {{foro}}. Emitido em {{data}}. Contrato {{contrato_codigo}}.`;

describe("contracts (AssinaVelox)", () => {
  let av;
  let server;
  let admin;
  let finance;
  let manager;
  let clientA;
  let clientA2;
  let clientB;
  let a;
  let b;
  let orderId;
  let subscriptionId;
  let contractId;

  before(async () => {
    av = await startFakeAssinaVelox();
    server = await startTestServer({
      assinavelox: { apiUrl: av.apiUrl, token: "avk_test_token", webhookSecret: WEBHOOK_SECRET, syncMinutes: 0 },
    });
    const { ctx } = server;
    a = createClientWithBrand(ctx, { name: "Cliente Contratos A", brandName: "Marca A" });
    b = createClientWithBrand(ctx, { name: "Cliente Contratos B", brandName: "Marca B" });
    const adminUser = await createUser(ctx, { role: "admin", email: "admin-ct@metta.test", name: "Admin Contratos" });
    await createUser(ctx, { role: "finance", email: "fin-ct@metta.test", name: "Financeiro Contratos" });
    await createUser(ctx, { role: "manager", email: "ger-ct@metta.test", name: "Gestor Contratos" });
    const cA = await createUser(ctx, { role: "client", clientId: a.client.id, email: "marina@cliente-a.test", name: "Marina Costa" });
    await createUser(ctx, { role: "client", clientId: a.client.id, email: "outra@cliente-a.test", name: "Outra Pessoa" });
    await createUser(ctx, { role: "client", clientId: b.client.id, email: "bruno@cliente-b.test", name: "Bruno" });
    admin = await login(server, { email: adminUser.email });
    finance = await login(server, { email: "fin-ct@metta.test" });
    manager = await login(server, { email: "ger-ct@metta.test" });
    clientA = await login(server, { email: cA.email });
    clientA2 = await login(server, { email: "outra@cliente-a.test" });
    clientB = await login(server, { email: "bruno@cliente-b.test" });

    const services = (await admin.get("/api/services")).body.items;
    const identity = services.find((s) => s.kind === "one_off");
    const plan = services.find((s) => s.kind === "subscription");
    const order = await admin.post("/api/orders", { clientId: a.client.id, brandId: a.brand.id, serviceId: identity.id, dueDate: "2026-10-20" });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    orderId = order.body.order.id;
    const sub = await admin.post("/api/subscriptions", { clientId: a.client.id, serviceId: plan.id, payerEmail: "marina@cliente-a.test" });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    subscriptionId = sub.body.subscription.id;
  });

  after(async () => {
    await server?.close();
    await av?.close();
  });

  test("sending is blocked until the representative, forum and reviewed templates exist", async () => {
    let status = (await finance.get("/api/contracts/status")).body;
    assert.equal(status.configured, true);
    assert.equal(status.ready, false);
    let res = await admin.post("/api/contracts", { orderId, signer: { userId: clientA.user.id } });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /quem assina pela Metta/);

    res = await manager.patch("/api/contracts/settings", { forum: "São Paulo/SP" });
    assert.equal(res.status, 403, "only settings.manage edits contract settings");
    res = await admin.patch("/api/contracts/settings", { signerName: "Admin Contratos", signerEmail: "admin-ct@metta.test", forum: "São Paulo/SP" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.issues, []);

    res = await admin.post("/api/contracts", { orderId, signer: { userId: clientA.user.id } });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /Revise e salve o modelo/);

    res = await admin.put("/api/contracts/templates/one_off", { title: "Contrato {{nao_existe}}", body: TEMPLATE_BODY("one_off") });
    assert.equal(res.status, 422);
    assert.match(res.body.error.fields.body, /nao_existe/);

    for (const kind of ["one_off", "subscription"]) {
      res = await admin.put(`/api/contracts/templates/${kind}`, { title: "Contrato de prestação de serviços", body: TEMPLATE_BODY(kind) });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.template.reviewed, true);
      assert.equal(res.body.template.version, 2);
    }
    status = (await finance.get("/api/contracts/status")).body;
    assert.equal(status.ready, true);
    assert.deepEqual(status.issues, []);
  });

  test("template example and contract preview render real PDFs", async () => {
    const example = await raw(admin, "/api/contracts/templates/subscription/preview", "POST", {});
    assert.equal(example.status, 200);
    assert.equal(example.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await example.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");

    const preview = await raw(admin, "/api/contracts/preview", "POST", { orderId, signer: { userId: clientA.user.id } });
    assert.equal(preview.status, 200);
    assert.equal(Buffer.from(await preview.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    const denied = await raw(manager, "/api/contracts/preview", "POST", { orderId, signer: { userId: clientA.user.id } });
    assert.equal(denied.status, 403);
  });

  test("the contract is sent: envelope, sequential signers, valid fields, client notified", async () => {
    const res = await finance.post("/api/contracts", { orderId, signer: { userId: clientA.user.id } });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    contractId = res.body.contract.id;
    assert.equal(res.body.contract.status, "sending");
    await server.ctx.jobs.idle();

    const detail = (await finance.get(`/api/contracts/${contractId}`)).body.contract;
    assert.equal(detail.status, "sent", detail.error ?? "");
    assert.ok(detail.envelopeId);
    assert.equal(detail.signers[0].name, "Marina Costa");
    assert.equal(detail.signers[0].turn, true);
    assert.equal(detail.signers[1].turn, false);

    const envelope = av.envelope(detail.envelopeId);
    assert.equal(envelope.status, "in_progress");
    assert.deepEqual(envelope.recipients.map((r) => [r.order, r.email]), [
      [1, "marina@cliente-a.test"],
      [2, "admin-ct@metta.test"],
    ]);
    assert.equal(envelope.fields.filter((f) => f.type === "signature").length, 2);
    assert.equal(envelope.fields.filter((f) => f.type === "date").length, 2);

    // A second contract for the same order is refused while this one is open.
    const dup = await finance.post("/api/contracts", { orderId, signer: { userId: clientA.user.id } });
    assert.equal(dup.status, 409);

    const notes = (await clientA.get("/api/notifications")).body.items;
    assert.ok(notes.some((n) => n.type === "contract.sent"));
  });

  test("payment waits for the signature; the client sees why", async () => {
    // make the order payable (checkout needs Mercado Pago, so set the status directly)
    server.db.run("UPDATE orders SET status = 'pending_payment' WHERE id = ?", [orderId]);
    const billing = (await clientA.get("/api/portal/billing")).body;
    const order = billing.orders.find((o) => o.id === orderId);
    assert.equal(order.canPay, false);
    assert.match(order.payBlockedReason, /Assine o contrato/);
    assert.equal(order.contract.status, "sent");
    const pay = await clientA.post(`/api/portal/orders/${orderId}/pay`);
    assert.equal(pay.status, 409);
    assert.equal(pay.body.error.code, "contract_required");
  });

  test("embedded signing only for the right signer, in turn", async () => {
    const ok = await clientA.post(`/api/portal/contracts/${contractId}/sign-session`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.url, /#t=/);
    assert.equal(ok.body.widgetOrigin, new URL(av.apiUrl).origin);

    const other = await clientA2.post(`/api/portal/contracts/${contractId}/sign-session`);
    assert.equal(other.status, 403);
    assert.match(other.body.error.message, /Marina Costa/);

    const foreign = await clientB.post(`/api/portal/contracts/${contractId}/sign-session`);
    assert.equal(foreign.status, 404);

    const mettaTooEarly = await admin.post(`/api/contracts/${contractId}/sign-session`);
    assert.equal(mettaTooEarly.status, 409);
    const notSigner = await finance.post(`/api/contracts/${contractId}/sign-session`);
    assert.equal(notSigner.status, 403, "only the Metta representative signs from the panel");
  });

  test("webhooks: invalid signature is refused; signed delivery triggers a sync; duplicates are ignored", async () => {
    const detail = (await finance.get(`/api/contracts/${contractId}`)).body.contract;
    av.sign(detail.envelopeId, 1);
    const body = JSON.stringify({
      id: "01EVT0000000000000000000A1",
      type: "recipient.signed",
      version: 1,
      occurred_at: new Date().toISOString(),
      data: { envelope: { id: detail.envelopeId, status: "in_progress" }, recipient: { id: "x", status: "signed" } },
    });

    const forged = await fetch(`${server.url}/api/webhooks/assinavelox`, {
      method: "POST",
      headers: signedHeaders(body, "whsec_wrong_secret"),
      body,
    });
    assert.equal(forged.status, 401);
    const stale = await fetch(`${server.url}/api/webhooks/assinavelox`, {
      method: "POST",
      headers: signedHeaders(body, WEBHOOK_SECRET, { ts: Math.floor(Date.now() / 1000) - 3600 }),
      body,
    });
    assert.equal(stale.status, 401, "outside the 5-minute window");
    assert.equal((await finance.get(`/api/contracts/${contractId}`)).body.contract.signers[0].status, "pending");

    const headers = signedHeaders(body, WEBHOOK_SECRET, { deliveryId: "dlv_same_1" });
    const first = await fetch(`${server.url}/api/webhooks/assinavelox`, { method: "POST", headers, body });
    assert.equal(first.status, 204);
    await server.ctx.jobs.idle();
    const after1 = (await finance.get(`/api/contracts/${contractId}`)).body.contract;
    assert.equal(after1.signers[0].status, "signed");
    assert.equal(after1.signers[1].turn, true);
    // Now it waits for Metta: the client is told so, not asked to sign again.
    const waiting = (await clientA.get("/api/portal/billing")).body.orders.find((o) => o.id === orderId);
    assert.equal(waiting.canPay, false);
    assert.match(waiting.payBlockedReason, /Seu aceite foi registrado/);
    const events =server.db.get("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'contract.client_signed' AND entity_id = ?", [contractId]).n;
    assert.equal(events, 1);

    const again = await fetch(`${server.url}/api/webhooks/assinavelox`, { method: "POST", headers, body });
    assert.equal(again.status, 204);
    await server.ctx.jobs.idle();
    assert.equal(
      server.db.get("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'contract.client_signed' AND entity_id = ?", [contractId]).n,
      1,
    );
    const unsigned = server.db.get("SELECT COUNT(*) AS n FROM webhook_events WHERE provider = 'assinavelox' AND signature_valid = 0").n;
    assert.equal(unsigned, 2);
    const stored = server.db.get("SELECT payload FROM webhook_events WHERE provider = 'assinavelox' AND signature_valid = 0 LIMIT 1");
    assert.equal(stored.payload, null, "unsigned deliveries never store the payload");

    // The Metta signer (admin) can now open the embedded session.
    const turn = await admin.post(`/api/contracts/${contractId}/sign-session`);
    assert.equal(turn.status, 200, JSON.stringify(turn.body));
    const notSigner = await finance.post(`/api/contracts/${contractId}/sign-session`);
    assert.equal(notSigner.status, 403);
  });

  test("completion stores the final PDF and the evidence; payment is released; files are isolated", async () => {
    const detail = (await finance.get(`/api/contracts/${contractId}`)).body.contract;
    av.sign(detail.envelopeId, 2);
    const synced = await finance.post(`/api/contracts/${contractId}/sync`);
    assert.equal(synced.status, 200);
    assert.equal(synced.body.contract.status, "completed");
    assert.deepEqual(synced.body.contract.files, { original: true, signed: true, evidence: true });
    assert.match(synced.body.contract.signatureStatusLabel, /Aceite eletrônico/);

    const file = await raw(clientA, `/api/contracts/${contractId}/files/signed`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-disposition"), /contrato-assinado\.pdf/);
    assert.match(Buffer.from(await file.arrayBuffer()).toString(), /signed of/);
    const download = await raw(clientA, `/api/contracts/${contractId}/files/evidence?download=1`);
    assert.match(download.headers.get("content-disposition"), /^attachment/);

    assert.equal((await raw(clientB, `/api/contracts/${contractId}/files/signed`)).status, 404);
    assert.equal((await raw(manager, `/api/contracts/${contractId}/files/signed`)).status, 404);
    assert.equal((await clientB.get(`/api/portal/contracts/${contractId}`)).status, 404);
    assert.deepEqual((await clientB.get("/api/portal/contracts")).body.items, []);

    const billing = (await clientA.get("/api/portal/billing")).body;
    const order = billing.orders.find((o) => o.id === orderId);
    assert.equal(order.canPay, true);
    assert.equal(order.payBlockedReason, null);
    const pay = await clientA.post(`/api/portal/orders/${orderId}/pay`);
    assert.notEqual(pay.body?.error?.code, "contract_required");

    const notes = (await clientA.get("/api/notifications")).body.items;
    assert.ok(notes.some((n) => n.type === "contract.completed"));
    const history = (await clientA.get("/api/portal/activity")).body.items.map((a) => a.summary).join("\n");
    assert.match(history, /concluído/);
  });

  test("waiver lifts the requirement for one subscription; unwaive restores it", async () => {
    let sub = (await clientA.get("/api/portal/billing")).body.subscriptions.find((s) => s.id === subscriptionId);
    assert.equal(sub.contractSatisfied, false);
    const res = await finance.post("/api/contracts/waive", { subscriptionId, reason: "Contrato assinado em papel." });
    assert.equal(res.status, 200);
    sub = (await clientA.get("/api/portal/billing")).body.subscriptions.find((s) => s.id === subscriptionId);
    assert.equal(sub.contractSatisfied, true);
    await finance.post("/api/contracts/unwaive", { subscriptionId });
    sub = (await clientA.get("/api/portal/billing")).body.subscriptions.find((s) => s.id === subscriptionId);
    assert.equal(sub.contractSatisfied, false);
  });

  test("a failed step is reported and a retry completes without duplicating the envelope", async () => {
    av.fail((method, path) => method === "POST" && /\/send$/.test(path), 503, "dispatch-failed", { once: true });
    const res = await finance.post("/api/contracts", {
      subscriptionId,
      brandId: a.brand.id,
      signer: { name: "Marina Costa", email: "marina@cliente-a.test" },
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const id = res.body.contract.id;
    await server.ctx.jobs.idle();
    let detail = (await finance.get(`/api/contracts/${id}`)).body.contract;
    assert.equal(detail.status, "failed");
    assert.match(detail.error, /convites/);
    assert.equal(detail.step, "send");
    const envelopesBefore = av.state.envelopes.size;

    const retry = await finance.post(`/api/contracts/${id}/retry`);
    assert.equal(retry.status, 202);
    await server.ctx.jobs.idle();
    detail = (await finance.get(`/api/contracts/${id}`)).body.contract;
    assert.equal(detail.status, "sent", detail.error ?? "");
    assert.equal(av.state.envelopes.size, envelopesBefore, "no second envelope");

    // cancel: the envelope is canceled on AssinaVelox and the client is told
    const cancel = await finance.post(`/api/contracts/${id}/cancel`, { reason: "Plano alterado." });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.contract.status, "canceled");
    assert.equal(av.envelope(detail.envelopeId).status, "canceled");
  });

  test("refusal is recorded with the reason and the team is notified", async () => {
    const res = await finance.post("/api/contracts", { subscriptionId, signer: { userId: clientA.user.id } });
    assert.equal(res.status, 202);
    await server.ctx.jobs.idle();
    const id = res.body.contract.id;
    const detail = (await finance.get(`/api/contracts/${id}`)).body.contract;
    av.refuse(detail.envelopeId, 1, "Valor diferente do combinado.");
    const synced = (await finance.post(`/api/contracts/${id}/sync`)).body.contract;
    assert.equal(synced.status, "refused");
    assert.equal(synced.refusalReason, "Valor diferente do combinado.");
    const notes = (await finance.get("/api/notifications")).body.items;
    assert.ok(notes.some((n) => n.type === "contract.refused"));
  });

  test("a contract being finalized cannot be canceled", async () => {
    const res = await finance.post("/api/contracts", { subscriptionId, signer: { userId: clientA.user.id } });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await server.ctx.jobs.idle();
    const id = res.body.contract.id;
    const detail = (await finance.get(`/api/contracts/${id}`)).body.contract;
    assert.equal(detail.status, "sent");
    av.envelope(detail.envelopeId).status = "finalizing";
    const cancel = await finance.post(`/api/contracts/${id}/cancel`, {});
    assert.equal(cancel.status, 409);
    assert.match(cancel.body.error.message, /sendo concluído/);
    assert.equal((await finance.get(`/api/contracts/${id}`)).body.contract.status, "sent");
    av.envelope(detail.envelopeId).status = "in_progress";
    const ok = await finance.post(`/api/contracts/${id}/cancel`, {});
    assert.equal(ok.status, 200);
  });

  test("upstream errors become clear pt-BR messages", async () => {
    av.fail((method, path) => method === "GET" && path === "/envelopes", 401, "unauthenticated", { once: true });
    const res = await admin.post("/api/contracts/integration/test");
    assert.equal(res.status, 502);
    assert.match(res.body.error.message, /recusou a chave/);
    const ok = await admin.post("/api/contracts/integration/test");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
  });

  test("webhook subscription needs a public HTTPS address", async () => {
    const res = await admin.post("/api/contracts/integration/webhook");
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /HTTPS público/);
  });
});

describe("contracts with a public address: REST Hook subscription", () => {
  test("the secret is stored sealed and accepted for deliveries", async () => {
    const av = await startFakeAssinaVelox();
    const server = await startTestServer({
      appUrl: "https://app.metta.example",
      assinavelox: { apiUrl: av.apiUrl, token: "avk_test_token", syncMinutes: 0 },
    });
    try {
      const adminUser = await createUser(server.ctx, { role: "admin", email: "admin-hook@metta.test", name: "Admin Hook" });
      const admin = await login(server, { email: adminUser.email });
      const res = await admin.post("/api/contracts/integration/webhook");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.integration.webhook.receiving, true);
      assert.equal(res.body.integration.webhook.subscription.targetUrl, "https://app.metta.example/api/webhooks/assinavelox");
      const stored = server.db.get("SELECT value FROM settings WHERE key = 'assinavelox.webhook'").value;
      const secret = [...av.state.subscriptions.values()][0].secret;
      assert.ok(!stored.includes(secret), "the secret is not stored in clear text");

      const body = JSON.stringify({ id: "01EVT", type: "webhook.ping", version: 1, data: {} });
      const ping = await fetch(`${server.url}/api/webhooks/assinavelox`, { method: "POST", headers: signedHeaders(body, secret), body });
      assert.equal(ping.status, 204);

      const removed = await admin.del("/api/contracts/integration/webhook");
      assert.equal(removed.status, 200);
      assert.equal(removed.body.integration.webhook.subscription, null);
      assert.equal(av.state.subscriptions.size, 0);
    } finally {
      await server.close();
      await av.close();
    }
  });
});

describe("contracts without AssinaVelox configured", () => {
  test("sending answers 503 and payments are not blocked", async () => {
    const server = await startTestServer();
    try {
      const { ctx } = server;
      const c = createClientWithBrand(ctx, { name: "Cliente Sem Contrato", brandName: "Marca" });
      const adminUser = await createUser(ctx, { role: "admin", email: "admin-nc@metta.test", name: "Admin" });
      const client = await createUser(ctx, { role: "client", clientId: c.client.id, email: "cli-nc@test.test", name: "Cliente" });
      const admin = await login(server, { email: adminUser.email });
      const clientSession = await login(server, { email: client.email });
      const services = (await admin.get("/api/services")).body.items;
      const order = await admin.post("/api/orders", { clientId: c.client.id, serviceId: services.find((s) => s.kind === "one_off").id });
      server.db.run("UPDATE orders SET status = 'pending_payment' WHERE id = ?", [order.body.order.id]);
      const res = await admin.post("/api/contracts", { orderId: order.body.order.id, signer: { userId: client.id } });
      assert.equal(res.status, 503);
      assert.match(res.body.error.message, /AssinaVelox não configurada/);
      const billing = (await clientSession.get("/api/portal/billing")).body;
      assert.equal(billing.orders[0].contractRequired, false);
      assert.equal(billing.orders[0].canPay, true);
    } finally {
      await server.close();
    }
  });
});

describe("embedded signing origin", () => {
  const req = (origin, { isProduction = false } = {}) => ({
    ctx: { config: { appUrl: "https://app.metta.example", isProduction } },
    get: (name) => (name.toLowerCase() === "origin" ? origin : undefined),
  });
  test("uses the page origin when it is APP_URL or loopback outside production", () => {
    assert.equal(embedOrigin(req("https://app.metta.example")), "https://app.metta.example");
    assert.equal(embedOrigin(req("http://localhost:5173")), "http://localhost:5173");
    assert.equal(embedOrigin(req("http://127.0.0.1:5173")), "http://127.0.0.1:5173");
    assert.equal(embedOrigin(req(undefined)), "https://app.metta.example");
  });
  test("never trusts other origins, nor loopback in production", () => {
    assert.equal(embedOrigin(req("https://evil.example")), "https://app.metta.example");
    assert.equal(embedOrigin(req("http://localhost:5173", { isProduction: true })), "https://app.metta.example");
    assert.equal(embedOrigin(req("not a url")), "https://app.metta.example");
  });
});
