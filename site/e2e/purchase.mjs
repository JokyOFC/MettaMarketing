#!/usr/bin/env node
// End-to-end proof of the purchase started on the site, through the real UI:
//
//   node e2e/purchase.mjs --base http://127.0.0.1:5173 [--mobile] [--shots <dir>] [--db mysql://…local dev DB]
//
// Needs the dev servers (npm run dev + npm run dev:api) and the dev seed
// (npm run seed:dev), with sign-up open in Configurações (the default). The
// payment itself happens on Mercado Pago and is not driven here: without
// MP_ACCESS_TOKEN the confirmation page must say that online payment is
// unavailable; with it, the page must be ready to send the client there. The
// admin session is minted in the dev DB (no passwords typed for the team).
//
// Steps:
//   1 a visitor clicks "Comprar este plano" (Gestão) on /planos and lands on /cadastro, with the plan in context
//   2 after signing up, the visitor is on the confirmation page with the catalog price
//   3 signed in, "Comprar identidade visual" on the site goes straight to its confirmation page
//   4 on another device, the purchase link leads to sign-up, "Entrar" keeps the destination and login returns to it
//   5 the admin sees which catalog services the site sells
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch } from "./driver.mjs";
import { devDatabaseUrl, openDevDb } from "./devdb.mjs";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const MOBILE = argv.includes("--mobile");
const MODE = MOBILE ? "mobile" : "desktop";
const BASE = String(opt("base", "http://127.0.0.1:5173")).replace(/\/$/, "");
const SHOTS = resolve(opt("shots", join(tmpdir(), "metta-e2e-purchase", MODE)));
const WORK = join(tmpdir(), `metta-e2e-purchase-${MODE}-${Date.now().toString(36)}`);
const ADMIN = "admin@metta.test";
const STAMP = Date.now().toString(36);
const PERSON = {
  name: "Bruna Compra",
  email: `compra.${STAMP}@exemplo.test`,
  company: `Loja Compra ${STAMP}`,
  // test value for this run only; never reused
  password: `compra-${STAMP}-teste`,
};

mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const browser = await launch({ headless: !argv.includes("--headed") });
const devdb = await openDevDb(devDatabaseUrl(opt("db", null)));
const pages = {};
let shotNo = 0;

async function pageFor(role) {
  if (pages[role]) return pages[role];
  const page = await browser.newPage({ name: role, base: BASE, mobile: MOBILE, downloadsDir: join(WORK, "downloads", role) });
  if (role === "admin") await page.setCookie("metta_sid", await devdb.mintSession(ADMIN));
  pages[role] = page;
  return page;
}
async function shot(page, name, opts) {
  shotNo += 1;
  return page.shot(join(SHOTS, `${String(shotNo).padStart(2, "0")}-${name}.png`), opts);
}

// The confirmation page is ready either to pay or to say why it cannot.
async function checkConfirmation(page, { name, price, plan }) {
  await page.waitText("Confira o seu");
  await page.waitText(name);
  await page.waitText(price);
  await page.waitText("Próximos passos");
  if (await page.has(/Pagamento online indisponível/)) {
    log(`\n    (sem MP_ACCESS_TOKEN: a página avisa que o pagamento online está indisponível)`);
    return;
  }
  const button = plan ? "Autorizar no Mercado Pago" : "Pagar no Mercado Pago";
  assert(await page.has(button, { role: "button" }), `botão "${button}" não apareceu`);
  if (plan) assert(await page.has("E-mail da conta do Mercado Pago", { role: "textbox" }), "falta o e-mail do pagador");
  // A company without CPF/CNPJ is asked for it before leaving for Mercado Pago.
  if (await page.has("CNPJ ou CPF", { role: "textbox" })) {
    await page.click(button, { role: "button" });
    await page.waitText("Informe o CNPJ ou o CPF que vai no contrato.");
    assert(new URL(await page.eval(() => location.href)).pathname.startsWith("/painel/contratar/"), "saiu da página sem o documento");
  }
}

// Signed out, the app asks /api/auth/me once and gets 401, as expected.
const signedOut = (page, fn) => page.allowing([{ status: 401, pattern: /^\/api\/auth\/me/ }], fn);

const steps = [];
const step = (id, title, fn) => steps.push({ id, title, fn });

step("site", "No site, “Comprar este plano” leva ao cadastro com o plano em contexto", async () => {
  const visitor = await pageFor("visitor");
  await visitor.goto("/planos");
  await visitor.waitText("Formas de avançar");
  await signedOut(visitor, async () => {
    await visitor.click("Comprar este plano Gestão", { role: "link" });
    await visitor.waitFor(() => location.pathname === "/cadastro", { message: "o botão não levou ao cadastro" });
    await visitor.waitIdle();
  });
  const next = await visitor.eval(() => new URLSearchParams(location.search).get("next"));
  assert(next === "/painel/contratar/gestao", `destino inesperado: ${next}`);
  await visitor.waitText("Para contratar o plano Gestão");
  await shot(visitor, "cadastro-com-plano", { full: true });
});

step("signup", "Depois do cadastro, a pessoa confere o pedido com o preço do catálogo", async () => {
  const visitor = await pageFor("visitor");
  await visitor.fill("Seu nome", PERSON.name);
  await visitor.fill("E-mail", PERSON.email);
  await visitor.fill("Empresa ou marca", PERSON.company);
  await visitor.fill("Crie uma senha", PERSON.password);
  await visitor.fill("Confirme a senha", PERSON.password);
  await visitor.check(/Concordo que a Metta use estes dados/);
  await visitor.click("Criar conta", { role: "button" });
  await visitor.waitFor(() => location.pathname === "/painel/contratar/gestao", { message: "não chegou à confirmação do pedido" });
  await visitor.waitIdle();
  await checkConfirmation(visitor, { name: "Gestão", price: "3.000", plan: true });
  await shot(visitor, "confirmacao-plano", { full: true });
  assert((await devdb.userStatus(PERSON.email)) === "active", "o acesso deveria estar ativo");
});

step("identity", "Com sessão aberta, “Comprar identidade visual” vai direto à confirmação", async () => {
  const visitor = await pageFor("visitor");
  await visitor.goto("/planos");
  await visitor.waitText("Formas de avançar");
  await visitor.click("Comprar identidade visual", { role: "link" });
  await visitor.waitFor(() => location.pathname === "/painel/contratar/identidade-visual", {
    message: "não abriu a confirmação da identidade visual",
  });
  await visitor.waitIdle();
  await checkConfirmation(visitor, { name: "Identidade visual", price: "2.000", plan: false });
  await shot(visitor, "confirmacao-identidade", { full: true });
});

step("login", "Em outro aparelho, o link de compra passa pelo cadastro, “Entrar” mantém o destino", async () => {
  const other = await pageFor("returning");
  await signedOut(other, async () => {
    await other.goto("/painel/contratar/estrategia");
    await other.waitFor(() => location.pathname === "/cadastro", { message: "o link de compra não levou ao cadastro" });
    await other.waitText("Para contratar o plano Estratégia");
    await other.click("Entrar", { role: "link" });
    await other.waitFor(() => location.pathname === "/login", { message: "não abriu o login" });
    await other.waitText("Entre para contratar o plano Estratégia");
  });
  await other.fill("E-mail", PERSON.email);
  await other.fill("Senha", PERSON.password);
  await other.click("Entrar", { role: "button" });
  await other.waitFor(() => location.pathname === "/painel/contratar/estrategia", { message: "o login não voltou à compra" });
  await other.waitIdle();
  await checkConfirmation(other, { name: "Estratégia", price: "4.500", plan: true });
  await shot(other, "login-volta-a-compra");
});

step("admin", "A equipe vê no catálogo o que está à venda no site", async () => {
  const admin = await pageFor("admin");
  await admin.goto("/admin/planos");
  await admin.waitText("À venda no site");
  await shot(admin, "admin-catalogo-site", { full: true });
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
      return [...p.consoleErrors.map((e) => `${role}: console: ${e}`), ...p.badResponses.map((r) => `${role}: HTTP ${r.status} ${r.url}`)];
    });
    if (problems.length) throw new Error(`problemas durante o passo:\n  ${problems.join("\n  ")}`);
    results.push({ id: s.id, ok: true });
    log(`ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (error) {
    failed = true;
    results.push({ id: s.id, ok: false });
    log(`FALHOU\n    ${error.message}`);
    for (const [role, page] of Object.entries(pages)) {
      const p = page.takeProblems();
      for (const e of p.consoleErrors) log(`    ${role}: console: ${e}`);
      for (const r of p.badResponses) log(`    ${role}: HTTP ${r.status} ${r.url}`);
      try {
        await page.shot(join(SHOTS, `FAIL-${s.id}-${role}.png`));
      } catch {}
    }
    break;
  }
}
await devdb.revokeAll();
await devdb.close();
await browser.close();
log(`\n${MODE}: ${results.filter((r) => r.ok).length}/${steps.length} passos ok · capturas em ${SHOTS}`);
log(`cadastro: ${PERSON.company} <${PERSON.email}>`);
if (!failed) rmSync(WORK, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
