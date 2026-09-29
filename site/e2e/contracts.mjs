#!/usr/bin/env node
// End-to-end proof of the contract flow with AssinaVelox, through the real UI:
//
//   node e2e/contracts.mjs --base http://127.0.0.1:5173 --av-log <AssinaVelox laravel.log>
//        [--mobile] [--shots <dir>] [--db server/data/metta.db] [--widget-origin http://127.0.0.1:8000]
//
// Needs the dev servers (npm run dev + npm run dev:api), the dev seed
// (npm run seed:dev) and an AssinaVelox instance the API points at
// (ASSINAVELOX_API_URL/ASSINAVELOX_TOKEN) with MAIL_MAILER=log, so the
// one-time codes can be read from its log (--av-log). The embed origins
// http://127.0.0.1:5173 and http://localhost:5173 must be allowed there.
//
// Steps:
//   1 contracts are configured in Configurações › Contratos (only when needed)
//   2 an order (Identidade visual) exists for Aurora; the admin opens it,
//     generates the contract and sends it; it reaches "Aguardando assinaturas"
//   3 the client sees the notice on /painel, opens Financeiro, the payment is
//     blocked ("Assinar o contrato") and signs INSIDE the platform: the
//     AssinaVelox widget opens in the drawer, the code arrives by e-mail (log),
//     the name is typed, the consent checked and the signature confirmed
//   4 the Metta representative (admin) signs from the order drawer, the same way
//   5 the contract is completed: final PDF + evidence stored; the client
//     downloads the signed PDF and the payment is released
//
// The widget is cross-origin: Chrome runs with site isolation off so the
// test can reach the iframe through an isolated world; clicks and typing are
// real input events. Sessions are minted in the local dev DB (no passwords).
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { HELPERS, launch, sleep } from "./driver.mjs";
import { openDevDb } from "./devdb.mjs";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, "..");
const MOBILE = argv.includes("--mobile");
const MODE = MOBILE ? "mobile" : "desktop";
const BASE = String(opt("base", "http://127.0.0.1:5173")).replace(/\/$/, "");
const DB_PATH = resolve(SITE, opt("db", "server/data/metta.db"));
const AV_LOG = opt("av-log", null);
const WIDGET_ORIGIN = String(opt("widget-origin", "http://127.0.0.1:8000")).replace(/\/$/, "");
const SHOTS = resolve(opt("shots", join(tmpdir(), "metta-e2e-contracts", MODE)));
const WORK = join(tmpdir(), `metta-e2e-contracts-${MODE}-${Date.now().toString(36)}`);
const ADMIN = "admin@metta.test";
const CLIENT = "cliente@aurora.test";

if (!AV_LOG || !existsSync(AV_LOG)) {
  console.error("Informe --av-log com o caminho do laravel.log da AssinaVelox (MAIL_MAILER=log).");
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const browser = await launch({
  headless: !argv.includes("--headed"),
  extraArgs: ["--disable-site-isolation-trials"],
  disableFeatures: ["IsolateOrigins", "site-per-process"],
});
const devdb = openDevDb(DB_PATH);
const sessions = { admin: devdb.mintSession(ADMIN), client: devdb.mintSession(CLIENT) };
const pages = {};
let shotNo = 0;

async function pageFor(role) {
  if (pages[role]) return pages[role];
  const page = await browser.newPage({ name: role, base: BASE, mobile: MOBILE, downloadsDir: join(WORK, "downloads", role) });
  await page.setCookie("metta_sid", sessions[role]);
  pages[role] = page;
  return page;
}
async function shot(page, name, opts) {
  shotNo += 1;
  return page.shot(join(SHOTS, `${String(shotNo).padStart(2, "0")}-${name}.png`), opts);
}

// API calls for set-up only (what the UI flow depends on but does not test).
async function api(method, path, body, role = "admin") {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie: `metta_sid=${sessions[role]}`, "x-metta-request": "1", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.error?.message ?? ""}`);
  return data;
}

// ---------- AssinaVelox log (one-time codes) ----------
const logSize = () => {
  try {
    return statSync(AV_LOG).size;
  } catch {
    return 0;
  }
};
function readLogFrom(offset) {
  const fd = openSync(AV_LOG, "r");
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, size - offset));
    readSync(fd, buf, 0, buf.length, Math.min(offset, size));
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
async function waitForCode(email, offset, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const records = readLogFrom(offset).split(/\r?\n(?=\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[^\]]*\] )/);
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      const m = r.match(/\*\*(\d{3}) ?(\d{3})\*\*/) ?? r.match(/<strong[^>]*>\s*(\d{3}) ?(\d{3})\s*<\/strong>/i);
      if (m && /c[oó]digo/i.test(r) && r.toLowerCase().includes(email.toLowerCase())) return `${m[1]}${m[2]}`;
    }
    await sleep(250);
  }
  throw new Error(`código de verificação para ${email} não apareceu no log da AssinaVelox`);
}

// ---------- the AssinaVelox widget (cross-origin iframe) ----------
async function widget(page) {
  const found = await page.waitFor(() => Boolean(document.querySelector("iframe.ct-sign__frame")), {
    timeout: 20000,
    message: "o widget de assinatura não abriu",
  });
  assert(found, "sem iframe");
  let frameId = null;
  const until = Date.now() + 20000;
  while (!frameId && Date.now() < until) {
    const { frameTree } = await page.send("Page.getFrameTree");
    const walk = (node) => {
      for (const child of node.childFrames ?? []) {
        if (child.frame.url.startsWith(WIDGET_ORIGIN)) return child.frame.id;
        const deep = walk(child);
        if (deep) return deep;
      }
      return null;
    };
    frameId = walk(frameTree);
    if (!frameId) await sleep(250);
  }
  assert(frameId, "o iframe da AssinaVelox não carregou");
  const { executionContextId } = await page.send("Page.createIsolatedWorld", {
    frameId,
    worldName: `metta-e2e-${Date.now()}`,
    grantUniveralAccess: true,
  });
  const run = async (fnOrExpr, ...args) => {
    const expression = typeof fnOrExpr === "function" ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})` : fnOrExpr;
    const res = await page.send("Runtime.evaluate", { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`widget: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    return res.result?.value;
  };
  await run(HELPERS);
  const text = () => run("document.body ? document.body.innerText : ''");
  const waitText = async (query, timeout = 30000) => {
    const until2 = Date.now() + timeout;
    let last = "";
    while (Date.now() < until2) {
      last = await text().catch(() => "");
      if (query instanceof RegExp ? query.test(last) : last.includes(query)) return last;
      await sleep(200);
    }
    throw new Error(`o widget não mostrou "${query}" (texto: ${last.slice(0, 200).replace(/\s+/g, " ")})`);
  };
  // Real input at the element's centre: frame point + iframe offset in the page.
  const clickAt = async (locator, { timeout = 20000, what } = {}) => {
    const until2 = Date.now() + timeout;
    let p = null;
    while (Date.now() < until2) {
      p = await run(locator).catch(() => null);
      if (p && !p.disabled) break;
      await sleep(200);
    }
    assert(p, `${what} não encontrado no widget`);
    assert(!p.disabled, `${what} continua desativado no widget`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const frame = await page.eval(() => {
        const r = document.querySelector("iframe.ct-sign__frame").getBoundingClientRect();
        return { left: r.left, top: r.top };
      });
      const x = Math.round(frame.left + p.x);
      const y = Math.round(frame.top + p.y);
      const height = page.viewport.height;
      if (y < 70 || y > height - 50) {
        // Bring it into the drawer's visible area (the iframe grows with its content).
        await page.eval((dy) => {
          const body = document.querySelector(".ct-sign__body") || document.querySelector(".ui-dialog__body");
          if (body) body.scrollTop += dy;
        }, y - Math.round(height / 2));
        await sleep(250);
        continue;
      }
      await page.tapAt(x, y);
      await sleep(120);
      return;
    }
    throw new Error(`${what} fora da área visível`);
  };
  const byName = (name) =>
    `(() => { const el = window.__e2e.find(${JSON.stringify(name)}, { role: 'clickable' }); return el ? window.__e2e.point(el) : null; })()`;
  const bySelector = (selector) =>
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? window.__e2e.point(el) : null; })()`;
  return { run, text, waitText, clickAt, byName, bySelector };
}

/** Signs inside the widget as `email` (code from the AssinaVelox log). */
async function signInWidget(page, email, name, prefix) {
  const w = await widget(page);
  await w.waitText(/Receber código por e-mail|Confirme o código/);
  await shot(page, `${prefix}-widget-aberto`);
  const offset = logSize();
  await w.clickAt(w.byName("Receber código por e-mail"), { what: "botão Receber código" });
  const code = await waitForCode(email, offset);
  await w.waitText(/tentativa|Reenviar/, 15000);
  await page.send("Input.insertText", { text: code });
  await w.waitText(/Assinar documento|Assinar/i, 30000);
  // Typed signature (the default mode is drawing).
  await w.clickAt(w.byName("Digitar"), { what: "opção Digitar" });
  const input = await w.run(() => {
    const el = document.querySelector('input[placeholder="Digite seu nome"]');
    return el ? window.__e2e.point(el) : null;
  });
  assert(input, "campo Digite seu nome não apareceu");
  await w.clickAt(w.bySelector('input[placeholder="Digite seu nome"]'), { what: "campo do nome" });
  await w.run(() => {
    const el = document.querySelector('input[placeholder="Digite seu nome"]');
    el.select();
  });
  await page.send("Input.insertText", { text: name });
  await w.clickAt(w.bySelector('button[role="checkbox"]'), { what: "caixa de aceite" });
  await shot(page, `${prefix}-widget-preenchido`);
  await w.clickAt(w.byName("Assinar documento"), { what: "botão Assinar documento", timeout: 45000 });
  // The confirmation enables only after ~800 ms of real visibility.
  await sleep(1200);
  await w.clickAt(w.byName("Confirmar e assinar"), { what: "botão Confirmar e assinar", timeout: 20000 });
}

// ---------- steps ----------
const steps = [];
const step = (id, title, fn) => steps.push({ id, title, fn });
const S = {};

step("setup", "Contratos configurados e pedido de identidade visual para a Aurora", async () => {
  const admin = await pageFor("admin");
  const status = await api("GET", "/api/contracts/status");
  assert(status.configured, "a API da Metta não está apontando para a AssinaVelox (ASSINAVELOX_API_URL/TOKEN)");
  if (!status.ready) {
    await admin.goto("/admin/configuracoes?aba=contratos");
    await admin.waitText("Regras dos contratos");
    await admin.fill("Quem assina pela Metta", "Administração Metta (dev)");
    await admin.fill("E-mail de quem assina", ADMIN);
    await admin.fill("Foro", "São Paulo/SP");
    await admin.click("Salvar regras", { role: "button" });
    await admin.waitText("Regras dos contratos salvas");
    for (const tab of ["Planos mensais", "Identidade visual e serviços avulsos"]) {
      await admin.click(tab, { role: "tab" });
      if (await admin.has("Revisei e quero usar este modelo", { role: "button" })) {
        await admin.click("Revisei e quero usar este modelo", { role: "button" });
        await admin.waitText(/Versão \d+ do modelo salva/);
      }
    }
    await shot(admin, "configuracoes-contratos", { full: true });
  }
  const opts = await api("GET", "/api/commerce/options");
  const aurora = opts.clients.find((c) => c.name.startsWith("Aurora"));
  assert(aurora, "cliente Aurora não encontrado (rode npm run seed:dev)");
  const identity = opts.services.find((s) => s.kind === "one_off");
  // Start clean: contracts and charges left open by earlier runs are canceled.
  const open = await api("GET", `/api/contracts?clientId=${aurora.id}&status=open`);
  for (const c of open.items) {
    await api("POST", `/api/contracts/${c.id}/cancel`, { reason: "Limpeza antes do teste de ponta a ponta." }).catch(() => {});
  }
  const openOrders = await api("GET", `/api/orders?clientId=${aurora.id}&status=open&pageSize=100`);
  for (const o of openOrders.items) await api("POST", `/api/orders/${o.id}/cancel`).catch(() => {});
  const drafts = await api("GET", `/api/orders?clientId=${aurora.id}&status=draft&pageSize=100`);
  for (const o of drafts.items) await api("POST", `/api/orders/${o.id}/cancel`).catch(() => {});
  const order = (await api("POST", "/api/orders", { clientId: aurora.id, brandId: aurora.brands[0]?.id, serviceId: identity.id, dueDate: "2026-10-30" })).order;
  // Without Mercado Pago credentials here, the charge is opened directly in the
  // dev DB so the client sees it waiting for payment.
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout = 8000");
  db.prepare("UPDATE orders SET status = 'pending_payment' WHERE id = ?").run(order.id);
  db.close();
  S.orderId = order.id;
});

step("send", "Admin gera e envia o contrato pelo pedido", async () => {
  const admin = await pageFor("admin");
  await admin.goto(`/admin/pedidos?pedido=${S.orderId}`);
  await admin.waitText("Gerar contrato");
  await shot(admin, "admin-pedido-sem-contrato");
  await admin.click("Gerar contrato", { role: "button" });
  await admin.waitText("Quem assina pelo cliente");
  await shot(admin, "admin-enviar-contrato");
  await admin.click("Enviar para assinatura", { role: "button", within: { text: "Quem assina pelo cliente" } });
  await admin.waitText("Aguardando assinaturas", { timeout: 60000 });
  await shot(admin, "admin-contrato-enviado");
  const [contract] = (await api("GET", `/api/contracts?orderId=${S.orderId}`)).items;
  S.code = contract.code;
});

step("client-sign", "Cliente vê o aviso, o pagamento bloqueado e assina dentro da plataforma", async () => {
  const client = await pageFor("client");
  await client.goto("/painel");
  await client.waitText(/contratos? aguardam? sua assinatura/);
  await shot(client, "cliente-aviso-contrato");
  await client.click(/^Ver contratos?$/);
  await client.waitText(S.code, { timeout: 20000 });
  assert(await client.has("Assinar o contrato"), "a cobrança deveria pedir a assinatura antes do pagamento");
  assert(!(await client.has("Pagar com Mercado Pago")), "o pagamento não deveria estar liberado antes do contrato");
  await shot(client, "cliente-financeiro-contrato", { full: true });
  await client.click("Assinar agora", { role: "button", within: { text: S.code, selector: "article" } });
  await signInWidget(client, CLIENT, "Cliente Aurora", "cliente");
  await client.waitText("Aceite registrado", { timeout: 60000 });
  await shot(client, "cliente-aceite-registrado");
  await client.click("Concluir", { role: "button" });
  await client.waitText(/Falta a assinatura da Metta|Aceite do contratante registrado/, { timeout: 30000 });
  await shot(client, "cliente-aguardando-metta");
});

step("metta-sign", "Representante da Metta assina pelo painel", async () => {
  const admin = await pageFor("admin");
  await admin.goto(`/admin/pedidos?pedido=${S.orderId}`);
  await admin.click("Atualizar status", { role: "button" });
  await admin.waitText("Assinar agora", { timeout: 30000 });
  await shot(admin, "admin-vez-da-metta");
  await admin.click("Assinar agora", { role: "button" });
  await signInWidget(admin, ADMIN, "Administração Metta", "metta");
  await admin.waitText("Aceite registrado", { timeout: 60000 });
  await shot(admin, "metta-aceite-registrado");
  await admin.click("Concluir", { role: "button" });
});

step("completed", "Contrato concluído: PDF final guardado, cliente baixa e o pagamento é liberado", async () => {
  const admin = await pageFor("admin");
  const until = Date.now() + 90000;
  for (;;) {
    await admin.goto(`/admin/pedidos?pedido=${S.orderId}`);
    if (await admin.eval(() => document.body.innerText.includes("Contrato assinado"))) break;
    if (Date.now() > until) throw new Error("o contrato não foi concluído em 90 s");
    if (await admin.has("Atualizar status", { role: "button" })) await admin.click("Atualizar status", { role: "button" });
    await sleep(3000);
  }
  await shot(admin, "admin-contrato-concluido", { full: true });

  const client = await pageFor("client");
  await client.goto("/painel/financeiro");
  await client.waitText("Contrato assinado");
  assert(await client.has("Pagar com Mercado Pago"), "o pagamento deveria estar liberado depois do contrato");
  await shot(client, "cliente-contrato-concluido", { full: true });
  const file = await client.download(() => client.click("Baixar", { role: "clickable", within: { text: "Contrato assinado" } }));
  const bytes = readFileSync(file.path);
  assert(bytes.subarray(0, 5).toString() === "%PDF-", "o download não é um PDF");
  assert(/contrato-assinado\.pdf$/.test(file.suggestedFilename ?? ""), `nome inesperado: ${file.suggestedFilename}`);
  S.signedBytes = bytes.length;
});

// ---------- runner ----------
const results = [];
let failed = false;
for (const s of steps) {
  const t0 = Date.now();
  process.stdout.write(`[${MODE}] ${s.id} — ${s.title} … `);
  try {
    await s.fn();
    const problems = Object.entries(pages).flatMap(([role, page]) => {
      const p = page.takeProblems();
      return [
        ...p.consoleErrors.filter((e) => !e.includes(WIDGET_ORIGIN)).map((e) => `${role}: console: ${e}`),
        ...p.badResponses.map((r) => `${role}: HTTP ${r.status} ${r.url}`),
      ];
    });
    if (problems.length) throw new Error(`problemas durante o passo:\n  ${problems.join("\n  ")}`);
    results.push({ id: s.id, ok: true });
    log(`ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (error) {
    failed = true;
    results.push({ id: s.id, ok: false });
    log(`FALHOU\n    ${error.message}`);
    // What the pages reported until the failure (often the actual cause).
    for (const [role, page] of Object.entries(pages)) {
      const p = page.takeProblems();
      for (const e of p.consoleErrors) log(`    ${role}: console: ${e}`);
      for (const r of p.badResponses) log(`    ${role}: HTTP ${r.status} ${r.url}`);
    }
    for (const [role, page] of Object.entries(pages)) {
      try {
        await page.shot(join(SHOTS, `FAIL-${s.id}-${role}.png`));
      } catch {}
    }
    break;
  }
}
devdb.revokeAll();
devdb.close();
await browser.close();
log(`\n${MODE}: ${results.filter((r) => r.ok).length}/${steps.length} passos ok · capturas em ${SHOTS}`);
if (S.orderId) log(`pedido: ${S.orderId}${S.signedBytes ? ` · PDF assinado baixado (${S.signedBytes} bytes)` : ""}`);
if (!failed) rmSync(WORK, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
