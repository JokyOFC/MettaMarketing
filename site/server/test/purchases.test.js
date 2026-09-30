// Purchases started on the site (/planos → /painel/contratar/:slug): the
// client pays first on Mercado Pago and the contract follows the confirmed
// payment, sent automatically to the buyer — against a mock Mercado Pago API
// and a fake AssinaVelox.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { siteOffers } from "../../src/data/brand.js";
import { sendContractAfterPayment } from "../services/contracts.js";
import { webhookIdle } from "../services/mercadopago.js";
import { startFakeAssinaVelox } from "./fakes/assinavelox.js";
import { addPayment, sendWebhook as sendSignedWebhook, startMockMp } from "./fakes/mercadopago.js";
import { createAgent, createClientWithBrand, createUser, login, startTestServer, waitFor } from "./helpers.js";

const MP_SECRET = "whsec-test-purchases-7c1d";
const AV_CONFIG = (av) => ({ apiUrl: av.apiUrl, token: "avk_test_token", webhookSecret: "whsec_test_purchases_0123456789", syncMinutes: 0 });
const MP_CONFIG = (mock) => ({
  mpAccessToken: "TEST-1234567890-purchases",
  mpWebhookSecret: MP_SECRET,
  mpApiBase: mock.url,
  appUrl: "https://app.metta.test",
});

const TEMPLATE_BODY = `**CONTRATANTE:** {{contratante_nome}}, documento {{contratante_documento}}, representada por {{representante_nome}}.

# Cláusula 1ª — Do objeto
1.1. {{servico}} para a marca {{marca}}:
{{itens}}

# Cláusula 2ª — Do valor
2.1. {{valor}} ({{valor_por_extenso}}), {{periodicidade}}.

# Cláusula 3ª — Do foro
3.1. Foro de {{foro}}. Emitido em {{data}}. Contrato {{contrato_codigo}}.`;

let counter = 0;
const signupInput = (overrides = {}) => {
  counter += 1;
  return {
    name: "Clara Menezes",
    email: `clara.${Date.now().toString(36)}${counter}@loja.test`,
    company: `Loja Aurora ${counter}`,
    password: "senha-forte-do-cadastro",
    acceptTerms: true,
    ...overrides,
  };
};

/** A visitor who signs up on the site (no CPF/CNPJ given). -> agent with { user } */
async function signUp(server, overrides) {
  const agent = createAgent(server);
  const res = await agent.post("/api/auth/signup", signupInput(overrides));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  agent.user = res.body.user;
  return agent;
}

const notes = async (db, userId, type) =>
  await db.all("SELECT * FROM notifications WHERE user_id = ? AND type = ? ORDER BY created_at, id", [userId, type]);

describe("purchases from the site (Mercado Pago first, contract after)", () => {
  let mock;
  let av;
  let server;
  let db;
  let admin;
  let finance;
  let buyer;
  const sendWebhook = (options) => sendSignedWebhook(server, { secret: MP_SECRET, ...options });

  before(async () => {
    mock = await startMockMp();
    av = await startFakeAssinaVelox({ allowedOrigins: ["https://app.metta.test"] });
    server = await startTestServer({ ...MP_CONFIG(mock), assinavelox: AV_CONFIG(av) });
    db = server.db;
    const adminUser = await createUser(server.ctx, { role: "admin", email: "admin-compras@metta.test", name: "Admin Compras" });
    const financeUser = await createUser(server.ctx, { role: "finance", email: "fin-compras@metta.test", name: "Financeiro Compras" });
    admin = await login(server, { email: adminUser.email });
    finance = await login(server, { email: financeUser.email });

    // Contracts ready: Metta's signer, forum and reviewed templates.
    let res = await admin.patch("/api/contracts/settings", { signerName: "Admin Compras", signerEmail: adminUser.email, forum: "São Paulo/SP" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    for (const kind of ["one_off", "subscription"]) {
      res = await admin.put(`/api/contracts/templates/${kind}`, { title: "Contrato de prestação de serviços", body: TEMPLATE_BODY });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    assert.equal((await finance.get("/api/contracts/status")).body.ready, true);

    buyer = await signUp(server);
  });

  after(async () => {
    await webhookIdle(server?.ctx);
    await server?.close();
    await mock?.close();
    await av?.close();
  });

  const serviceBySlug = async (slug) => (await admin.get("/api/services")).body.items.find((s) => s.slug === slug);

  test("the seeded catalog answers the site's buy buttons", async () => {
    const services = (await admin.get("/api/services")).body.items;
    const linked = services.filter((s) => s.slug).map((s) => [s.slug, s.kind]);
    assert.deepEqual(
      linked.sort(),
      siteOffers.map((offer) => [offer.slug, offer.kind]).sort(),
    );
    assert.equal((await serviceBySlug("identidade-visual")).priceCents, 200000);
    assert.equal((await serviceBySlug("gestao")).priceCents, 300000);
  });

  test("only a signed-in client sees an offer, with the catalog price", async () => {
    assert.equal((await createAgent(server).get("/api/portal/offers/gestao")).status, 401);
    assert.equal((await admin.get("/api/portal/offers/gestao")).status, 403);

    const res = await buyer.get("/api/portal/offers/gestao");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.offer.slug, "gestao");
    assert.equal(res.body.offer.name, "Gestão");
    assert.equal(res.body.offer.kind, "subscription");
    assert.equal(res.body.offer.priceCents, 300000);
    assert.ok(res.body.offer.items.length > 0);
    assert.equal(res.body.paymentsEnabled, true);
    assert.equal(res.body.contractAfterPayment, true);
    assert.equal(res.body.needsDocument, true);
    assert.equal(res.body.payerEmail, buyer.user.email);
    assert.equal(res.body.blocked, null);

    assert.equal((await buyer.get("/api/portal/offers/nao-existe")).status, 404);
    const strategy = await serviceBySlug("estrategia");
    await admin.patch(`/api/services/${strategy.id}`, { active: false });
    assert.equal((await buyer.get("/api/portal/offers/estrategia")).status, 404, "inactive services are not sold");
    await admin.patch(`/api/services/${strategy.id}`, { active: true });
  });

  test("the team links and unlinks site buttons in the catalog", async () => {
    const identity = await serviceBySlug("identidade-visual");
    const presence = await serviceBySlug("presenca");
    let res = await admin.patch(`/api/services/${identity.id}`, { slug: "gestao" });
    assert.equal(res.status, 422);
    assert.match(res.body.error.fields.slug, /plano mensal/);
    res = await admin.post("/api/services", { name: "Presença 2", kind: "subscription", priceCents: 150000, slug: "presenca" });
    assert.equal(res.status, 422);
    assert.match(res.body.error.fields.slug, /já está ligado/);
    res = await admin.post("/api/services", { name: "Outro", kind: "one_off", priceCents: 1000, slug: "nao-existe" });
    assert.equal(res.status, 422);

    res = await admin.patch(`/api/services/${presence.id}`, { slug: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.service.slug, null);
    assert.equal((await buyer.get("/api/portal/offers/presenca")).status, 404);
    res = await admin.patch(`/api/services/${presence.id}`, { slug: "presenca" });
    assert.equal(res.body.service.slug, "presenca");
    const log = await db.get("SELECT summary FROM activity_log WHERE entity_id = ? ORDER BY id DESC LIMIT 1", [presence.id]);
    assert.match(log.summary, /ligado ao botão “Presença” do site/);
  });

  let orderId;
  test("brand identity: the CPF/CNPJ is asked once, then the client goes to Checkout Pro", async () => {
    let res = await buyer.post("/api/portal/purchases", { offer: "identidade-visual" });
    assert.equal(res.status, 422);
    assert.match(res.body.error.fields.document, /CNPJ ou o CPF/);
    res = await buyer.post("/api/portal/purchases", { offer: "identidade-visual", document: "123" });
    assert.equal(res.status, 422);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM orders WHERE client_id = ?", [buyer.user.client.id])).n, 0);

    const preferences = mock.state.preferences.length;
    res = await buyer.post("/api/portal/purchases", { offer: "identidade-visual", document: "12.345.678/0001-90" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.checkoutUrl, /^https:\/\/sandbox\.mp\.example\/checkout\?pref_id=/);
    orderId = res.body.order.id;
    assert.equal(res.body.order.status, "pending_payment");
    assert.equal(res.body.order.contractAfterPayment, true);
    assert.equal(res.body.order.canPay, true);

    const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
    assert.equal(order.contract_after_payment, 1);
    assert.equal(order.created_by, buyer.user.id);
    assert.equal(order.amount_cents, 200000);
    assert.equal(order.description, "Identidade visual");
    assert.equal(mock.state.preferences.length, preferences + 1);
    const preference = mock.state.preferences.at(-1).body;
    assert.equal(preference.external_reference, `metta-${orderId}`);
    assert.equal(preference.items[0].unit_price, 2000);
    assert.equal(preference.back_urls.success, "https://app.metta.test/painel/financeiro?retorno=sucesso");
    const client = await db.get("SELECT document FROM clients WHERE id = ?", [buyer.user.client.id]);
    assert.equal(client.document, "12.345.678/0001-90");
    assert.equal((await buyer.get("/api/portal/offers/identidade-visual")).body.needsDocument, false);

    // "Comprar" again: same order, same link, nothing new at Mercado Pago.
    const again = await buyer.post("/api/portal/purchases", { offer: "identidade-visual" });
    assert.equal(again.status, 200);
    assert.equal(again.body.order.id, orderId);
    assert.equal(again.body.checkoutUrl, res.body.checkoutUrl);
    assert.equal(mock.state.preferences.length, preferences + 1);
  });

  test("payment never waits for the contract on a site purchase", async () => {
    // The setting says "contract before payment" and AssinaVelox is configured…
    assert.equal((await finance.get("/api/contracts/status")).body.requiredBeforePayment, true);
    const billing = (await buyer.get("/api/portal/billing")).body;
    assert.equal(billing.contractsEnabled, true);
    const order = billing.orders.find((o) => o.id === orderId);
    // …but a site purchase is paid first.
    assert.equal(order.contractRequired, false);
    assert.equal(order.canPay, true);
    assert.equal(order.payBlockedReason, null);
    const pay = await buyer.post(`/api/portal/orders/${orderId}/pay`);
    assert.equal(pay.status, 200, JSON.stringify(pay.body));

    const staff = (await finance.get(`/api/orders/${orderId}`)).body.order;
    assert.equal(staff.contractAfterPayment, true);
    assert.equal(staff.contractAutoAt, null);
    assert.equal(staff.createdBy.name, "Clara Menezes");
  });

  test("once paid, the contract goes to the buyer automatically", async () => {
    addPayment(mock, 8101, { external_reference: `metta-${orderId}`, transaction_amount: 2000 });
    const hook = await sendWebhook({ dataId: "8101" });
    assert.equal(hook.status, 200);
    await server.ctx.jobs.idle();

    const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
    assert.equal(order.status, "paid");
    assert.ok(order.contract_auto_at);
    const contracts = await db.all("SELECT * FROM contracts WHERE order_id = ?", [orderId]);
    assert.equal(contracts.length, 1);
    const [contract] = contracts;
    assert.equal(contract.status, "sent", contract.error ?? "");
    assert.equal(contract.client_signer_user_id, buyer.user.id);
    assert.equal(contract.client_signer_email, buyer.user.email);
    assert.equal(contract.created_by, null);
    assert.deepEqual(av.envelope(contract.envelope_id).recipients.map((r) => [r.order, r.email]), [
      [1, buyer.user.email],
      [2, "admin-compras@metta.test"],
    ]);
    const created = await db.get("SELECT summary FROM activity_log WHERE action = 'contract.created' AND entity_id = ?", [contract.id]);
    assert.match(created.summary, /gerado automaticamente depois do pagamento/);

    // The buyer is told the contract is next, then that it arrived.
    const [paid] = await notes(db, buyer.user.id, "payment.approved");
    assert.match(paid.body, /contrato chega para você assinar/);
    assert.equal((await notes(db, buyer.user.id, "contract.sent")).length, 1);
    // Finance and admins see a new sale from the site.
    for (const who of [admin, finance]) {
      const [sale] = await notes(db, who.user.id, "payment.approved");
      assert.match(sale.title, /Nova compra pelo site/);
      assert.match(sale.body, /O contrato segue automaticamente/);
    }

    // The client signs it in the portal like any other contract.
    const billing = (await buyer.get("/api/portal/billing")).body;
    const portalOrder = billing.orders.find((o) => o.id === orderId);
    assert.equal(portalOrder.status, "paid");
    assert.equal(portalOrder.contract.status, "sent");
    const session = await buyer.post(`/api/portal/contracts/${contract.id}/sign-session`);
    assert.equal(session.status, 200, JSON.stringify(session.body));

    // Runs once: a second pass (webhook retry, restart scan) changes nothing.
    assert.equal(await sendContractAfterPayment(server.ctx, { orderId }), null);
    const hookAgain = await sendWebhook({ dataId: "8101" });
    assert.equal(hookAgain.status, 200);
    await server.ctx.jobs.idle();
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM contracts WHERE order_id = ?", [orderId])).n, 1);
  });

  test("the team can still send a contract by hand for a paid site purchase", async () => {
    const [contract] = await db.all("SELECT * FROM contracts WHERE order_id = ?", [orderId]);
    const dup = await finance.post("/api/contracts", { orderId, signer: { userId: buyer.user.id } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, "contract_exists");
    const cancel = await admin.post(`/api/contracts/${contract.id}/cancel`, { reason: "Dados da empresa mudaram." });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    const resend = await finance.post("/api/contracts", { orderId, signer: { userId: buyer.user.id } });
    assert.equal(resend.status, 202, JSON.stringify(resend.body));
    await server.ctx.jobs.idle();

    // A charge made by the team keeps the old rule: once paid, no new contract.
    const staffOrder = await finance.post("/api/orders", {
      clientId: buyer.user.client.id,
      description: "Ajustes extras",
      amountCents: 50000,
    });
    assert.equal(staffOrder.status, 201, JSON.stringify(staffOrder.body));
    assert.equal(staffOrder.body.order.contractAfterPayment, false);
    await db.run("UPDATE orders SET status = 'paid' WHERE id = ?", [staffOrder.body.order.id]);
    const refused = await finance.post("/api/contracts", { orderId: staffOrder.body.order.id, signer: { userId: buyer.user.id } });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /já foi pago/);
  });

  let planBuyer;
  let subscriptionId;
  test("plan: the monthly authorization is tied to the payer's e-mail", async () => {
    planBuyer = await signUp(server, { document: "123.456.789-09" });
    assert.equal((await planBuyer.get("/api/portal/offers/gestao")).body.needsDocument, false);

    const before = mock.calls("POST", "/preapproval").length;
    let res = await planBuyer.post("/api/portal/purchases", { offer: "gestao", payerEmail: "pagador@loja.test" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.checkoutUrl, /^https:\/\/mp\.example\/subscriptions\/checkout\?preapproval_id=/);
    subscriptionId = res.body.subscription.id;
    assert.equal(res.body.subscription.status, "pending");
    assert.equal(res.body.subscription.contractAfterPayment, true);
    assert.equal(res.body.subscription.checkoutUrl, res.body.checkoutUrl, "the client can resume from Financeiro");
    let call = mock.calls("POST", "/preapproval").at(-1);
    assert.equal(call.body.payer_email, "pagador@loja.test");
    assert.equal(call.body.external_reference, `metta-${subscriptionId}`);
    assert.equal(call.body.auto_recurring.transaction_amount, 3000);
    assert.equal(call.body.back_url, "https://app.metta.test/painel/financeiro?retorno=assinatura");

    // Same plan and e-mail: the same link.
    res = await planBuyer.post("/api/portal/purchases", { offer: "gestao", payerEmail: "pagador@loja.test" });
    assert.equal(res.status, 200);
    assert.equal(res.body.subscription.id, subscriptionId);
    assert.equal(mock.calls("POST", "/preapproval").length, before + 1);

    // Another payer e-mail: a new authorization; the old link is cancelled.
    const oldPreapproval = (await db.get("SELECT mp_preapproval_id FROM subscriptions WHERE id = ?", [subscriptionId])).mp_preapproval_id;
    res = await planBuyer.post("/api/portal/purchases", { offer: "gestao" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.subscription.id, subscriptionId);
    call = mock.calls("POST", "/preapproval").at(-1);
    assert.equal(call.body.payer_email, planBuyer.user.email, "defaults to the buyer's e-mail");
    assert.equal(mock.calls("POST", "/preapproval").length, before + 2);
    // The old link is cancelled in the background, right after the new one.
    await waitFor(() => mock.state.preapprovals.get(oldPreapproval).status === "cancelled");

    // Choosing another plan before authorizing replaces the first one.
    const firstPreapproval = (await db.get("SELECT mp_preapproval_id FROM subscriptions WHERE id = ?", [subscriptionId])).mp_preapproval_id;
    res = await planBuyer.post("/api/portal/purchases", { offer: "presenca" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const replaced = await db.get("SELECT * FROM subscriptions WHERE id = ?", [subscriptionId]);
    assert.equal(replaced.status, "cancelled");
    assert.equal(mock.state.preapprovals.get(firstPreapproval).status, "cancelled");
    subscriptionId = res.body.subscription.id;
    assert.equal(res.body.subscription.service.name, "Presença");
    const pending = await db.all("SELECT id FROM subscriptions WHERE client_id = ? AND status = 'pending'", [planBuyer.user.client.id]);
    assert.deepEqual(pending.map((s) => s.id), [subscriptionId]);
  });

  test("plan: once authorized, the contract goes out and the plan cannot be bought twice", async () => {
    const { mp_preapproval_id: preapprovalId } = await db.get("SELECT mp_preapproval_id FROM subscriptions WHERE id = ?", [subscriptionId]);
    Object.assign(mock.state.preapprovals.get(preapprovalId), { status: "authorized", next_payment_date: "2026-10-30T10:00:00.000-03:00" });
    const hook = await sendWebhook({ type: "subscription_preapproval", dataId: preapprovalId });
    assert.equal(hook.status, 200);
    await server.ctx.jobs.idle();

    const subscription = await db.get("SELECT * FROM subscriptions WHERE id = ?", [subscriptionId]);
    assert.equal(subscription.status, "active");
    assert.ok(subscription.contract_auto_at);
    const contract = await db.get("SELECT * FROM contracts WHERE subscription_id = ?", [subscriptionId]);
    assert.equal(contract.status, "sent", contract.error ?? "");
    assert.equal(contract.kind, "subscription");
    assert.equal(contract.client_signer_user_id, planBuyer.user.id);
    const [active] = await notes(db, planBuyer.user.id, "subscription.active");
    assert.match(active.body, /contrato chega para você assinar/);
    const [sale] = await notes(db, finance.user.id, "subscription.active");
    assert.match(sale.title, /Nova assinatura pelo site/);

    for (const offer of ["presenca", "estrategia"]) {
      const view = await planBuyer.get(`/api/portal/offers/${offer}`);
      assert.equal(view.body.blocked.code, "plan_active");
      const res = await planBuyer.post("/api/portal/purchases", { offer });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "plan_active");
    }
    assert.match((await planBuyer.get("/api/portal/offers/estrategia")).body.blocked.message, /Para trocar de plano, fale com a Metta/);
    // A one-off service is still for sale.
    assert.equal((await planBuyer.get("/api/portal/offers/identidade-visual")).body.blocked, null);
  });

  test("a subscription prepared by the team is handled in Financeiro, not bought again", async () => {
    const other = await createClientWithBrand(server.ctx, { name: "Cliente da Equipe", brandName: "Marca da Equipe" });
    const person = await createUser(server.ctx, { role: "client", clientId: other.client.id, email: "pessoa@equipe.test" });
    const client = await login(server, { email: person.email });
    const gestao = await serviceBySlug("gestao");
    const created = await finance.post("/api/subscriptions", { clientId: other.client.id, serviceId: gestao.id, payerEmail: "pessoa@equipe.test" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.subscription.contractAfterPayment, false);

    const view = await client.get("/api/portal/offers/presenca");
    assert.equal(view.body.blocked.code, "plan_pending");
    const res = await client.post("/api/portal/purchases", { offer: "presenca", document: "12.345.678/0001-90" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "plan_pending");
  });

  test("a new catalog price replaces an unpaid order at the old price", async () => {
    const shopper = await signUp(server, { document: "98.765.432/0001-10" });
    const first = await shopper.post("/api/portal/purchases", { offer: "identidade-visual" });
    assert.equal(first.status, 201);
    const identity = await serviceBySlug("identidade-visual");
    await admin.patch(`/api/services/${identity.id}`, { priceCents: 250000 });
    try {
      assert.equal((await shopper.get("/api/portal/offers/identidade-visual")).body.offer.priceCents, 250000);
      const second = await shopper.post("/api/portal/purchases", { offer: "identidade-visual" });
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.notEqual(second.body.order.id, first.body.order.id);
      assert.equal(second.body.order.amountCents, 250000);
      assert.equal((await db.get("SELECT status FROM orders WHERE id = ?", [first.body.order.id])).status, "cancelled");
    } finally {
      await admin.patch(`/api/services/${identity.id}`, { priceCents: 200000 });
    }
  });

  test("Mercado Pago failures leave nothing behind and keep useful messages", async () => {
    const shopper = await signUp(server, { document: "11.222.333/0001-81" });
    const count = async () => (await db.get("SELECT COUNT(*) AS n FROM orders WHERE client_id = ?", [shopper.user.client.id])).n;
    mock.state.mode = "down";
    try {
      const res = await shopper.post("/api/portal/purchases", { offer: "identidade-visual" });
      assert.equal(res.status, 502);
      assert.equal(res.body.error.code, "upstream_error");
      assert.match(res.body.error.message, /Tente de novo em instantes/);
      assert.equal(await count(), 0, "the draft created by the click is removed");

      mock.state.mode = "badrequest";
      const refused = await shopper.post("/api/portal/purchases", { offer: "identidade-visual" });
      assert.equal(refused.status, 502);
      assert.match(refused.body.error.message, /O Mercado Pago recusou a solicitação: items\.unit_price must be a number/);
      assert.equal(await count(), 0);
    } finally {
      mock.state.mode = "ok";
    }
    const ok = await shopper.post("/api/portal/purchases", { offer: "identidade-visual" });
    assert.equal(ok.status, 201);
  });

  test("two clicks at once make one order", async () => {
    const shopper = await signUp(server, { document: "22.333.444/0001-05" });
    const [a, b] = await Promise.all([
      shopper.post("/api/portal/purchases", { offer: "identidade-visual" }),
      shopper.post("/api/portal/purchases", { offer: "identidade-visual" }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.order.id, b.body.order.id);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM orders WHERE client_id = ?", [shopper.user.client.id])).n, 1);
  });

  test("an archived client cannot buy", async () => {
    const shopper = await signUp(server, { document: "33.444.555/0001-60" });
    await db.run("UPDATE clients SET status = 'archived' WHERE id = ?", [shopper.user.client.id]);
    const res = await shopper.post("/api/portal/purchases", { offer: "identidade-visual" });
    assert.ok([403, 409].includes(res.status), `status ${res.status}`);
  });
});

describe("site purchase when the contract cannot go automatically", () => {
  test("finance and admins are told why; the team sends it by hand", async () => {
    const mock = await startMockMp();
    const av = await startFakeAssinaVelox();
    // AssinaVelox connected, but Configurações › Contratos never filled in.
    const server = await startTestServer({ ...MP_CONFIG(mock), assinavelox: AV_CONFIG(av) });
    try {
      const adminUser = await createUser(server.ctx, { role: "admin", email: "admin-auto@metta.test", name: "Admin" });
      const financeUser = await createUser(server.ctx, { role: "finance", email: "fin-auto@metta.test" });
      const admin = await login(server, { email: adminUser.email });
      const buyer = await signUp(server, { document: "12.345.678/0001-90" });

      const res = await buyer.post("/api/portal/purchases", { offer: "identidade-visual" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const orderId = res.body.order.id;
      assert.equal(res.body.order.canPay, true, "an incomplete contract setup never blocks the payment");
      addPayment(mock, 9101, { external_reference: `metta-${orderId}`, transaction_amount: 2000 });
      await sendSignedWebhook(server, { secret: MP_SECRET, dataId: "9101" });
      await server.ctx.jobs.idle();

      const order = await server.db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
      assert.equal(order.status, "paid");
      assert.ok(order.contract_auto_at);
      assert.equal((await server.db.get("SELECT COUNT(*) AS n FROM contracts WHERE order_id = ?", [orderId])).n, 0);
      for (const id of [adminUser.id, financeUser.id]) {
        const [note] = await notes(server.db, id, "contract.needs_sending");
        assert.ok(note, "finance and admins are told");
        assert.match(note.body, /não saiu automaticamente/);
        assert.match(note.body, /quem assina pela Metta/);
        assert.equal(note.link, `/admin/pedidos?pedido=${orderId}`);
      }
      assert.ok(await server.db.get("SELECT id FROM activity_log WHERE action = 'contract.not_sent_after_payment' AND entity_id = ?", [orderId]));
      // Nobody is promised a contract that is not coming by itself.
      const [paid] = await notes(server.db, buyer.user.id, "payment.approved");
      assert.ok(paid);
      assert.doesNotMatch(paid.body, /contrato/);
      const [sale] = await notes(server.db, financeUser.id, "payment.approved");
      assert.match(sale.title, /Nova compra pelo site/);
      assert.doesNotMatch(sale.body, /segue automaticamente/);
      assert.equal((await buyer.get("/api/portal/billing")).body.contractsEnabled, false);
      const staffView = (await admin.get(`/api/orders/${orderId}`)).body.order;
      assert.ok(staffView.contractAutoAt);
      assert.equal(staffView.contract, null);

      // Runs once: no second notice.
      await sendContractAfterPayment(server.ctx, { orderId });
      assert.equal((await notes(server.db, adminUser.id, "contract.needs_sending")).length, 1);

      // Once the settings are done, the team sends it from the order.
      await admin.patch("/api/contracts/settings", { signerName: "Admin", signerEmail: adminUser.email, forum: "São Paulo/SP" });
      for (const kind of ["one_off", "subscription"])
        await admin.put(`/api/contracts/templates/${kind}`, { title: "Contrato de prestação de serviços", body: TEMPLATE_BODY });
      const sent = await admin.post("/api/contracts", { orderId, signer: { userId: buyer.user.id } });
      assert.equal(sent.status, 202, JSON.stringify(sent.body));
      await server.ctx.jobs.idle();
      assert.equal((await server.db.get("SELECT status FROM contracts WHERE order_id = ?", [orderId])).status, "sent");
    } finally {
      await webhookIdle(server.ctx);
      await server.close();
      await mock.close();
      await av.close();
    }
  });
});

describe("site purchase without Mercado Pago", () => {
  test("the page says payment is unavailable and nothing is created", async () => {
    const server = await startTestServer();
    try {
      const buyer = await signUp(server, { document: "12.345.678/0001-90" });
      const view = await buyer.get("/api/portal/offers/identidade-visual");
      assert.equal(view.status, 200);
      assert.equal(view.body.paymentsEnabled, false);
      assert.equal(view.body.contractAfterPayment, false);
      const res = await buyer.post("/api/portal/purchases", { offer: "identidade-visual" });
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, "integration_not_configured");
      assert.match(res.body.error.message, /Pagamento online indisponível/);
      assert.equal((await server.db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
    } finally {
      await server.close();
    }
  });
});
