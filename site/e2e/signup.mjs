#!/usr/bin/env node
// End-to-end proof of the self sign-up through the real UI:
//
//   node e2e/signup.mjs --base http://127.0.0.1:5173 [--mobile] [--shots <dir>] [--db mysql://…local dev DB]
//
// Needs the dev servers (npm run dev + npm run dev:api) and the dev seed
// (npm run seed:dev), with sign-up open in Configurações (the default). The
// admin session is minted in the dev DB (no passwords typed for the team).
//
// Steps:
//   1 a visitor opens /cadastro, fills the form and lands on /painel, signed in
//   2 on another device the same person logs in with the new password
//   3 the admin sees the notice and the new client marked "Cadastro pelo site"
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
const SHOTS = resolve(opt("shots", join(tmpdir(), "metta-e2e-signup", MODE)));
const WORK = join(tmpdir(), `metta-e2e-signup-${MODE}-${Date.now().toString(36)}`);
const ADMIN = "admin@metta.test";
const STAMP = Date.now().toString(36);
const PERSON = {
  name: "Rafaela Teste",
  email: `cadastro.${STAMP}@exemplo.test`,
  company: `Empresa Cadastro ${STAMP}`,
  phone: "(11) 97777-6666",
  document: "12.345.678/0001-90",
  // test value for this run only; never reused
  password: `cadastro-${STAMP}-teste`,
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

const steps = [];
const step = (id, title, fn) => steps.push({ id, title, fn });

step("form", "Visitante cria a conta e entra direto na área do cliente", async () => {
  const visitor = await pageFor("visitor");
  await visitor.goto("/cadastro");
  await visitor.waitText("Crie o acesso da sua");
  await shot(visitor, "cadastro-vazio", { full: true });
  await visitor.fill("Seu nome", PERSON.name);
  await visitor.fill("E-mail", PERSON.email);
  await visitor.fill("Empresa ou marca", PERSON.company);
  await visitor.fill(/Telefone ou WhatsApp/, PERSON.phone);
  await visitor.fill(/CNPJ ou CPF/, PERSON.document);
  await visitor.fill("Crie uma senha", PERSON.password);
  await visitor.fill("Confirme a senha", PERSON.password);
  await visitor.check(/Concordo que a Metta use estes dados/);
  await shot(visitor, "cadastro-preenchido", { full: true });
  await visitor.click("Criar conta", { role: "button" });
  await visitor.waitFor(() => location.pathname.startsWith("/painel"), { message: "não chegou à área do cliente" });
  await visitor.waitIdle();
  await visitor.waitText(PERSON.company);
  await shot(visitor, "painel-novo-cliente", { full: true });
  assert((await devdb.userStatus(PERSON.email)) === "active", "o acesso deveria estar ativo");
});

step("login", "Em outro aparelho, a pessoa entra com a senha criada", async () => {
  const returning = await pageFor("returning");
  await returning.goto("/login");
  await returning.fill("E-mail", PERSON.email);
  await returning.fill("Senha", PERSON.password);
  await returning.click("Entrar", { role: "button" });
  await returning.waitFor(() => location.pathname.startsWith("/painel"), { message: "o login não abriu a área do cliente" });
  await returning.waitIdle();
  await shot(returning, "login-novo-cliente");
});

step("admin", "A equipe vê o aviso e o cliente marcado como cadastro pelo site", async () => {
  const admin = await pageFor("admin");
  await admin.goto("/admin/notificacoes");
  await admin.waitText("Novo cadastro pelo site");
  await shot(admin, "admin-aviso-cadastro");
  await admin.goto(`/admin/clientes?q=${encodeURIComponent(PERSON.company)}`);
  await admin.waitText(PERSON.company);
  assert(await admin.has("Cadastro pelo site"), "o cliente não está marcado como cadastro pelo site");
  await shot(admin, "admin-clientes-cadastro");
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
