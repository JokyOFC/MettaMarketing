#!/usr/bin/env node
// End-to-end proof of the 12 acceptance criteria (SPEC) through the real UI.
//
//   node e2e/flows.mjs --base http://127.0.0.1:5173 [--mobile]
//        [--shots <dir>] [--auth session|ui] [--db server/data/metta.db]
//        [--headed] [--reduced] [--from <step-id> --state <file>] [--until <step-id>]
//
// Needs the dev servers (npm run dev + npm run dev:api) and the dev seed
// (npm run seed:dev). Every run creates its own client, brand, project and
// materials with a unique suffix, so reruns never collide.
//
// Auth modes:
//   session (default)  no password is typed anywhere: each person gets a
//                      session row in the local dev DB (e2e/devdb.mjs), and
//                      the invitation page is opened and checked but the new
//                      client's access is activated in the DB instead of by
//                      choosing a password. Sessions are revoked at the end.
//   ui                 logs in through /login with the dev accounts from
//                      server/scripts/seed-dev.js and accepts the invitation
//                      by choosing a random password in the form.
//
// What it walks (one step per line in the output, grouped by criterion):
//   1 admin creates client + brand + invitation (link read from the screen);
//     the invited person opens the invitation and reaches /painel
//   2 admin opens a project assigning designer + manager; the designer opens
//     the "Novo projeto atribuído" notice from the bell
//   3 designer uploads the logo (SVG + PNG, grouped) in /admin/biblioteca/enviar
//     and the 3-slide carousel in /admin/conteudo/novo (posts live in Conteúdo);
//     the client gets "não encontramos" for both drafts
//   4 manager reads the release summary (client, recipient, items) and releases
//   5 client opens the carousel, pages slides, expands, copies the caption,
//     comments and requests changes (internal notes never on screen); client
//     comments on the logo in Arquivos, the manager answers from the library
//     and the client reads the answer through /painel/arquivos?material=…#comentarios
//   6 designer opens the change-request notice, creates v2 from v1, replaces
//     slide 3, moves it first and sends it; manager releases v2
//   7 client approves v2 (v1 kept as superseded)
//   8 client downloads logo-principal.png (bytes compared) and two ZIPs: the
//     carousel (slides 01-03 in the new order) and the brand kit (folders)
//   9 Aurora (other client) opens the same URLs and gets the not-found state
//  10 admin filters /admin/historico by the client and finds every event in
//     order; the material history shows downloads as "não equivale a aprovação"
//  11 refused uploads show the reason per file; a disabled download shows the
//     message; an order without Mercado Pago explains "não configurado"
//  12 all of the above with --mobile (390x844, touch, mobile user agent)
//
// Exit code 0 only when every step passed with no console errors, no
// unexpected 4xx/5xx from /api or /dl and no sideways page scroll.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { launch, sleep } from "./driver.mjs";
import { makeFixtures } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const MOBILE = argv.includes("--mobile");
const MODE = MOBILE ? "mobile" : "desktop";
const BASE = String(opt("base", "http://127.0.0.1:5173")).replace(/\/$/, "");
const AUTH = opt("auth", "session");
const DB_PATH = resolve(SITE, opt("db", "server/data/metta.db"));
const SHOTS = resolve(opt("shots", join(tmpdir(), "metta-e2e-shots", MODE)));
const WORK = join(tmpdir(), `metta-e2e-${MODE}-${Date.now().toString(36)}`);
const FROM = opt("from", null);
const UNTIL = opt("until", null);
const STATE_FILE = opt("state", join(tmpdir(), `metta-e2e-state-${MODE}.json`));

const STAFF = {
  admin: "admin@metta.test",
  manager: "gestor@metta.test",
  designer: "designer@metta.test",
  aurora: "cliente@aurora.test",
};
const STAFF_NAMES = { manager: "Gestora de contas (dev)", designer: "Designer (dev)" };

// ---------- small helpers ----------
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}${p(d.getMonth() + 1)}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// Reads a ZIP's central directory; returns [{name, size, data()}].
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert(eocd >= 0, "ZIP inválido (sem diretório central)");
  let count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) {
    // ZIP64 end of central directory locator
    const loc = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), eocd);
    const z64 = Number(buffer.readBigUInt64LE(loc + 8));
    count = Number(buffer.readBigUInt64LE(z64 + 32));
    offset = Number(buffer.readBigUInt64LE(z64 + 48));
  }
  const entries = [];
  for (let i = 0, p = offset; i < count; i++) {
    assert(buffer.readUInt32LE(p) === 0x02014b50, "ZIP: entrada do diretório central inválida");
    const method = buffer.readUInt16LE(p + 10);
    let csize = buffer.readUInt32LE(p + 20);
    let size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    let local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    const extra = buffer.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = Number(extra.readBigUInt64LE(q))), (q += 8);
        if (csize === 0xffffffff) (csize = Number(extra.readBigUInt64LE(q))), (q += 8);
        if (local === 0xffffffff) local = Number(extra.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    const lname = buffer.readUInt16LE(local + 26);
    const lextra = buffer.readUInt16LE(local + 28);
    const start = local + 30 + lname + lextra;
    const raw = buffer.subarray(start, start + csize);
    entries.push({ name, size, data: () => (method === 0 ? raw : inflateRawSync(raw)) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------- run state ----------
const log = (...a) => console.log(...a);
let S = { run: `${stamp()}${MOBILE ? "m" : "d"}${randomBytes(2).toString("hex").slice(0, 2)}`, ids: {} };
if (FROM) {
  S = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  log(`retomando a execução ${S.run} a partir de ${FROM}`);
}
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(S, null, 2));

mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });
let shotNo = FROM ? S.shotNo || 0 : 0;

const F = await makeFixtures(join(WORK, "fixtures"), { run: S.run });
const browser = await launch({ headless: !argv.includes("--headed") });
const devdb = AUTH === "session" ? (await import("./devdb.mjs")).openDevDb(DB_PATH) : null;
const pages = {};
const downloadsDir = join(WORK, "downloads");

async function pageFor(role) {
  if (pages[role]) return pages[role];
  const page = await browser.newPage({ name: role, base: BASE, mobile: MOBILE, reduced: argv.includes("--reduced"), downloadsDir: join(downloadsDir, role) });
  pages[role] = page;
  if (role === "client" && !S.client?.active) return page; // anonymous until the invitation is accepted
  await signIn(page, role);
  return page;
}

async function signIn(page, role) {
  const email = role === "client" ? S.client.email : STAFF[role];
  if (AUTH === "session") {
    await page.setCookie("metta_sid", devdb.mintSession(email));
    return;
  }
  // --auth ui: the login form with the dev accounts of seed-dev.js.
  const seed = readFileSync(join(SITE, "server/scripts/seed-dev.js"), "utf8");
  let password = role === "client" ? S.client.password : null;
  if (!password) {
    const m =
      [...seed.matchAll(/email:\s*"([^"]+)"[^}]*?password:\s*"([^"]+)"/g)].find(([, e]) => e === email) || [];
    password = m[2];
  }
  assert(password, `sem senha de desenvolvimento para ${email}`);
  // Logged out, the login page asks /api/auth/me once and gets 401, as expected.
  await page.allowing([{ status: 401, pattern: /^\/api\/auth\/me/ }], async () => {
    await page.goto("/login");
    await page.fill("E-mail", email);
    await page.fill("Senha", password);
    await page.click("Entrar", { role: "button", exact: true });
    await page.waitFor(() => !location.pathname.startsWith("/login"), { message: `login de ${email}` });
  });
}

// ---------- steps ----------
const steps = [];
const step = (id, criterion, title, fn) => steps.push({ id, criterion, title, fn });

async function shot(page, name, opts) {
  shotNo += 1;
  S.shotNo = shotNo;
  const file = join(SHOTS, `${String(shotNo).padStart(2, "0")}-${name}.png`);
  await page.shot(file, opts);
  return file;
}

// Page helpers used by several steps.
// List filters; on phones they fold behind "Filtros", which a person opens first.
// On phones the filters sit behind a "Filtros" button (kit FilterBar or the
// library's own panel): found by its name, as a person would.
async function filterBy(page, label, option) {
  if (MOBILE) {
    const open = await page.eval(() => {
      const button = Array.from(document.querySelectorAll("button[aria-expanded]")).find(
        (b) => /^Filtros/.test((b.getAttribute("aria-label") || b.textContent || "").trim()) && b.getClientRects().length,
      );
      return button ? button.getAttribute("aria-expanded") : null;
    });
    if (open === "false") await page.click(/^Filtros/, { role: "button" });
  }
  await page.select(label, option);
}
// Sidebar navigation; on phones the menu opens first, as a person would.
async function nav(page, label) {
  if (MOBILE) await page.click("Abrir menu", { role: "button", exact: true });
  await page.click(label, { role: "link", within: "nav[aria-label=Principal]" });
}
async function openNotification(page, text) {
  await page.click(/^Notificações/, { role: "button" });
  await page.waitText(text, { timeout: 15000 });
  await page.click(text, { role: "any" });
}

// ===== Criterion 1: admin creates a client and its brand =====
step("c1-client", 1, "Admin cria cliente, marca e convite", async () => {
  const admin = await pageFor("admin");
  const r = S.run;
  S.client = {
    name: `Cliente E2E ${r}`,
    brand: `Marca E2E ${r}`,
    person: `Pessoa E2E ${r}`,
    email: `pessoa.${r.toLowerCase().replace(/[^a-z0-9]/g, "")}@e2e.test`,
  };
  await admin.goto("/admin/clientes");
  await admin.click("Novo cliente", { role: "button" });
  await admin.waitText("Cadastrar cliente e marca");
  await admin.fill("Nome do cliente", S.client.name);
  await admin.fill("Nome da marca", S.client.brand);
  await admin.fill("Descrição", "Marca criada pelo teste de ponta a ponta.");
  await admin.check(STAFF_NAMES.manager);
  await admin.check("Convidar alguém do cliente agora");
  await admin.fill("Nome", S.client.person, { exact: true });
  await admin.fill("E-mail", S.client.email, { exact: true });
  await shot(admin, "admin-novo-cliente");
  await admin.click("Criar cliente", { role: "button" });
  await admin.waitText(`Convite criado para ${S.client.person}`);
  S.ids.client = (await admin.url()).match(/clientes\/([^/?]+)/)?.[1];
  assert(S.ids.client, "a página do cliente não abriu depois de criar");
  S.client.invite = await admin.eval(
    (name) => document.querySelector(`input[aria-label="Link de convite de ${name}"]`)?.value,
    S.client.person,
  );
  assert(/\/convite\//.test(S.client.invite || ""), "o link de convite não apareceu na tela");
  await shot(admin, "admin-cliente-criado-convite");
  await admin.click(/^Marcas/, { role: "tab" });
  await admin.waitText(S.client.brand);
  await shot(admin, "admin-cliente-marcas");
});

step("c1-invite", 1, "Pessoa do cliente abre o convite e acessa o painel", async () => {
  const client = await pageFor("client");
  const url = new URL(S.client.invite);
  // Anonymous visitor: the app asks /api/auth/me once and gets 401, as expected.
  await client.allowing([{ status: 401, pattern: /^\/api\/auth\/me/ }], async () => {
    await client.goto(url.pathname);
    await client.waitText(S.client.email);
    await client.waitText("Criar acesso");
  });
  await shot(client, "cliente-convite");
  if (AUTH === "ui") {
    S.client.password = `e2e-${randomBytes(9).toString("base64url")}`;
    await client.fill("Crie uma senha", S.client.password);
    await client.fill("Confirme a senha", S.client.password);
    await client.click("Criar acesso", { role: "button" });
    await client.waitFor(() => location.pathname.startsWith("/painel"), { message: "o convite aceito não abriu o painel" });
  } else {
    devdb.activateInvited(S.client.email);
    await signIn(client, "client");
  }
  S.client.active = true;
  await client.goto("/painel");
  await client.waitText(S.client.brand);
  await shot(client, "cliente-painel-vazio");
});

// ===== Criterion 2: the team receives an assigned project =====
step("c2-project", 2, "Admin abre o projeto atribuindo designer e gestora", async () => {
  const admin = await pageFor("admin");
  S.project = `Projeto E2E ${S.run}`;
  await admin.goto("/admin/projetos");
  await admin.click("Novo projeto", { role: "button" });
  await admin.waitText("Abrir projeto");
  await admin.select("Marca", S.client.brand);
  await admin.select("Serviço contratado", /Identidade visual/);
  await admin.fill("Nome do projeto", S.project);
  await admin.check(STAFF_NAMES.designer);
  await admin.check(STAFF_NAMES.manager);
  await shot(admin, "admin-novo-projeto");
  await admin.click("Criar projeto", { role: "button" });
  await admin.waitFor(() => /\/admin\/projetos\/prj_/.test(location.pathname), { message: "página do projeto" });
  S.ids.project = (await admin.url()).match(/projetos\/([^/?]+)/)[1];
  await admin.waitText(S.project);
  await shot(admin, "admin-projeto-criado");
});

step("c2-designer-notice", 2, "Designer recebe o aviso e vê o projeto", async () => {
  const designer = await pageFor("designer");
  await designer.goto("/admin");
  await openNotification(designer, S.project);
  await designer.waitFor((id) => location.pathname.includes(id), { message: "aviso não abriu o projeto" }, S.ids.project);
  await designer.waitText(S.project);
  await shot(designer, "designer-projeto-atribuido");
  const manager = await pageFor("manager");
  await manager.goto("/admin/notificacoes");
  await manager.waitText(S.project);
  await shot(manager, "gestora-aviso-projeto");
});

// ===== Criterion 11 (uploads) + 3: designer sends a logo and a carousel as drafts =====
step("c11-upload-errors", 11, "Envio recusado mostra o motivo em cada arquivo", async () => {
  const designer = await pageFor("designer");
  await designer.goto("/admin/biblioteca/enviar");
  await designer.waitText("Tudo começa como rascunho");
  await designer.allowing([415, 415, 422], async () => {
    await designer.chooseFiles("Escolher arquivos", [F.exe, F.fakePng, F.empty]);
    await designer.waitText("3 com falha", { timeout: 20000 });
  });
  await designer.waitText("Formato .exe não permitido");
  await designer.waitText("não corresponde a um .png");
  await designer.waitText("O arquivo está vazio");
  await shot(designer, "designer-envio-recusado");
  for (const name of ["instalador.exe", "foto-falsa.png", "vazio.png"]) await designer.click(`Remover ${name}`, { role: "button" });
  await designer.waitText("3 com falha", { gone: true });
});

step("c3-logo", 3, "Designer envia a logo (SVG + PNG) como rascunho", async () => {
  const designer = await pageFor("designer");
  S.logo = `Logo principal E2E ${S.run}`;
  if (!(await designer.url()).startsWith("/admin/biblioteca/enviar")) await designer.goto("/admin/biblioteca/enviar");
  await designer.chooseFiles("Escolher arquivos", [F.logoSvg, F.logoPng]);
  await designer.waitText("2 enviados", { timeout: 30000 });
  await designer.click("Agrupar como um material", { role: "option" });
  await designer.select("Cliente", S.client.name);
  await designer.select("Marca", S.client.brand);
  await designer.select("Projeto ou serviço", S.project);
  await designer.select("Categoria", "Logotipo");
  await designer.select("Variante da logo", "Logo principal");
  await designer.fill("Título", S.logo, { exact: true });
  await designer.fill("Descrição", "Logo principal em vetor e PNG transparente.");
  await shot(designer, "designer-logo-formulario");
  await designer.click("Salvar como rascunho", { role: "button" });
  await designer.waitText("Material salvo");
  S.ids.logo = await designer.eval(() => document.querySelector(".lib-done__name")?.getAttribute("href")?.split("/").pop());
  assert(S.ids.logo?.startsWith("mat_"), "o material salvo não apareceu na confirmação");
  await designer.click("Enviar para revisão", { role: "button" });
  await designer.waitText("Enviado para revisão interna");
  await shot(designer, "designer-logo-salvo-revisao");
});

step("c3-carousel", 3, "Designer monta o carrossel (3 slides) como rascunho", async () => {
  const designer = await pageFor("designer");
  S.post = `Carrossel lançamento E2E ${S.run}`;
  const planned = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await designer.goto("/admin/conteudo/novo");
  await designer.select("Marca", S.client.brand);
  await designer.select("Projeto", S.project);
  await designer.fill("Título interno", S.post);
  await designer.select("Rede social", "Instagram");
  await designer.select("Formato", "Carrossel");
  await designer.fill("Data prevista", planned);
  await designer.chooseFiles("Escolher arquivos", F.slides);
  await designer.waitText("3 arquivos prontos", { timeout: 30000 });
  await designer.fill("Legenda", "Chegou o lançamento que a sua marca esperava. Arraste para o lado e conheça.");
  await designer.fill("Hashtags", "#lancamento #e2e");
  await designer.fill("Observações para o cliente", "Confira a ordem dos slides antes de aprovar.");
  await designer.fill("Notas internas", `NOTA-INTERNA-${S.run} não deve aparecer ao cliente`);
  await shot(designer, "designer-carrossel-formulario", { full: true });
  await designer.click("Salvar como rascunho", { role: "button" });
  await designer.waitFor(() => /\/admin\/conteudo\/mat_/.test(location.pathname), { message: "a página do post não abriu" });
  S.ids.post = (await designer.url()).match(/conteudo\/([^/?]+)/)[1];
  await designer.waitText(S.post);
  await designer.click("Enviar para revisão", { role: "button" });
  await designer.waitText("Enviado para revisão interna");
  await shot(designer, "designer-carrossel-rascunho");
});

step("c3-private", 3, "Rascunhos continuam invisíveis para o cliente", async () => {
  const client = await pageFor("client");
  await client.goto("/painel/conteudo");
  assert(!(await client.text()).includes(S.post), "o cliente vê o post antes da liberação");
  await client.allowing([404], async () => {
    await client.goto(`/painel/conteudo/${S.ids.post}`);
    await client.waitText("Não encontramos");
  });
  await shot(client, "cliente-rascunho-nao-encontrado");
  await client.allowing([404], async () => {
    await client.goto(`/painel/arquivos?material=${S.ids.logo}`);
    await client.waitText("Este material não está disponível");
  });
});

// ===== Criterion 4: the manager reviews and releases to the right client =====
step("c4-release", 4, "Gestora confere o resumo e libera ao cliente certo", async () => {
  const manager = await pageFor("manager");
  await manager.goto("/admin/notificacoes");
  await manager.waitText(`“${S.logo}” aguarda revisão`);
  await manager.waitText(`“${S.post}” aguarda revisão`);
  await shot(manager, "gestora-avisos-revisao");
  // A team-only note on the post: must never reach the client.
  await manager.goto(`/admin/conteudo/${S.ids.post}`);
  await manager.click(/^Notas internas/, { role: "tab" });
  await manager.fill("Nova nota interna", `NOTA-EQUIPE-${S.run} conferir contraste do slide 2`);
  await manager.click("Salvar nota", { role: "button" });
  await manager.waitText(`NOTA-EQUIPE-${S.run}`);
  await manager.goto("/admin/biblioteca");
  await filterBy(manager, "Cliente", S.client.name);
  await manager.waitText(S.logo);
  await manager.waitText(S.post);
  await manager.check(`Selecionar ${S.logo}`);
  await manager.check(`Selecionar ${S.post}`);
  await manager.waitText("2 materiais selecionados");
  await manager.click("Liberar", { role: "button", exact: true });
  await manager.waitText("Revise antes de liberar");
  const summary = await manager.text();
  for (const expected of [S.client.name, S.client.person, S.logo, S.post])
    assert(summary.includes(expected), `o resumo de liberação não mostra "${expected}"`);
  await shot(manager, "gestora-resumo-liberacao");
  await manager.click("Liberar 2 materiais", { role: "button" });
  await manager.waitText("2 materiais disponíveis");
  await shot(manager, "gestora-liberado");
  await manager.click("Concluir", { role: "button" });
});

// ===== Criterion 5: the client views, comments and asks for changes =====
step("c5-client-review", 5, "Cliente vê, comenta e pede ajustes no carrossel", async () => {
  const client = await pageFor("client");
  await client.goto("/painel");
  await client.click(/^Notificações/, { role: "button" });
  await client.waitText(S.client.brand);
  await shot(client, "cliente-aviso-liberacao");
  await client.press("Escape");
  await nav(client, /^Conteúdo/);
  await client.waitText(S.post);
  await shot(client, "cliente-central-conteudo");
  await client.click(S.post, { role: "link" });
  await client.waitFor((id) => location.pathname.endsWith(id), { message: "o post não abriu" }, S.ids.post);
  await client.waitText("Aguardando sua aprovação");
  await client.click("Próximo slide", { role: "button" });
  await client.waitText(/Slide 2 \/? ?(de )?3/);
  await client.click(/^Ampliar slide 2/, { role: "button" });
  await client.waitFor(() => window.__e2e.modals().length > 0, { message: "a prévia ampliada não abriu" });
  await shot(client, "cliente-previa-ampliada");
  await client.press("Escape");
  await client.waitFor(() => window.__e2e.modals().length === 0, { message: "a prévia ampliada não fechou" });
  await client.click("Copiar legenda", { role: "button", exact: true });
  await client.waitText("Copiado");
  const visible = await client.text();
  assert(!visible.includes("NOTA-INTERNA") && !visible.includes("NOTA-EQUIPE"), "nota interna visível para o cliente");
  await client.fill("Novo comentário", "Gostamos muito da proposta! Só o slide 3 precisa de ajuste.");
  await client.click("Comentar", { role: "button", exact: true });
  await client.waitText("Gostamos muito da proposta");
  await client.click("Solicitar ajustes", { role: "button", exact: true });
  await client.fill("Ajustes", "Trocar o fundo do slide 3 por um tom mais quente e colocá-lo como primeiro slide.");
  await client.select("Slide", "Slide 3");
  await shot(client, "cliente-pedido-ajustes");
  await client.click("Enviar pedido de ajustes", { role: "button" });
  await client.waitText("Ajustes solicitados");
  await shot(client, "cliente-ajustes-registrados");
});

step("c5-logo-comment", 5, "Cliente comenta a logo em Arquivos e lê a resposta da equipe", async () => {
  const client = await pageFor("client");
  await client.goto(`/painel/arquivos?material=${S.ids.logo}`);
  await client.waitText(S.logo);
  await client.waitText("Tire dúvidas ou peça ajustes neste material");
  const ask = `Dá para ter a logo também em versão para fundo escuro? (${S.run})`;
  await client.fill("Novo comentário", ask);
  await client.click("Comentar", { role: "button", exact: true });
  await client.waitText(ask);
  await shot(client, "cliente-comenta-logo");

  // The team answers from the library, in the thread shared with the client.
  const manager = await pageFor("manager");
  await manager.goto(`/admin/biblioteca/${S.ids.logo}`);
  await manager.waitText(ask);
  const reply = `Sim! A versão clara para fundo escuro entra na próxima entrega. (${S.run})`;
  await manager.fill("Novo comentário", reply);
  await manager.click("Comentar", { role: "button", exact: true });
  await manager.waitText(reply);
  await shot(manager, "gestora-responde-logo");

  // The link a "new comment" notice points to opens the drawer on the conversation.
  await client.goto("/painel");
  await client.goto(`/painel/arquivos?material=${S.ids.logo}#comentarios`);
  await client.waitText(reply);
  await client.waitFor(
    () => document.activeElement?.tagName === "H3" && document.activeElement.textContent.trim() === "Comentários",
    { message: "o link com #comentarios não levou à conversa do material" },
  );
  const visible = await client.text();
  assert(!visible.includes("NOTA-INTERNA") && !visible.includes("NOTA-EQUIPE"), "nota interna visível para o cliente");
  await shot(client, "cliente-le-resposta-logo");
});

// ===== Criterion 6: the designer sends a new version =====
step("c6-new-version", 6, "Designer recebe o pedido e monta a versão 2", async () => {
  const designer = await pageFor("designer");
  await designer.goto("/admin");
  await designer.click(/^Notificações/, { role: "button" });
  const notice = new RegExp(`pediu ajustes.*${S.post.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  await designer.waitText(notice);
  await shot(designer, "designer-aviso-ajustes");
  await designer.click(notice, { role: "any" });
  await designer.waitFor((id) => location.pathname.includes(id), { message: "o aviso não abriu o post" }, S.ids.post);
  await designer.waitText("Trocar o fundo do slide 3");
  await designer.click("Nova versão", { role: "button", exact: true });
  await designer.waitText("Nova versão · v2");
  await designer.fill("O que mudou", "Slide 3 com fundo mais quente e agora como primeiro slide, como pedido.");
  await designer.click("Partir da v1", { role: "option" });
  await designer.click("Criar versão 2", { role: "button" });
  await designer.waitText("Versão 2 criada");
  await designer.waitText("Arquivos da versão atual");
  // Replace slide 3 and move the new one to the front.
  await designer.click("Remover slide-3.png", { role: "button" });
  await designer.click("Remover", { role: "button", exact: true });
  await designer.waitText("Arquivo removido da versão");
  await designer.chooseFiles("Escolher arquivos", [F.slide3v2]);
  await designer.click("Adicionar 1 arquivo", { role: "button", timeout: 20000 });
  await designer.waitText("arquivo adicionado");
  await designer.click("Mover slide-3-v2.png para cima", { role: "button" });
  await designer.click("Mover slide-3-v2.png para cima", { role: "button" });
  await designer.click("Salvar ordem", { role: "button" });
  await designer.waitText("Ordem dos slides salva");
  const order = await designer.eval(() =>
    Array.from(document.querySelectorAll(".cnt-slides .cnt-slide__name")).map((n) => n.textContent.trim()),
  );
  assert(order.slice(0, 3).join() === "slide-3-v2.png,slide-1.png,slide-2.png", `ordem dos slides inesperada: ${order.join(", ")}`);
  await shot(designer, "designer-versao-2-ordem");
  await designer.click("Enviar para revisão", { role: "button" });
  await designer.waitText("Enviado para revisão interna");
});

step("c6-release-v2", 6, "Gestora libera a versão 2", async () => {
  const manager = await pageFor("manager");
  await manager.goto(`/admin/conteudo/${S.ids.post}`);
  await manager.click("Liberar ao cliente", { role: "button" });
  await manager.waitText("Revise antes de liberar");
  await manager.waitText(S.client.person);
  await manager.waitText("v2");
  await shot(manager, "gestora-resumo-versao-2");
  await manager.click(/^Liberar 1 material/, { role: "button" });
  await manager.waitText("Material disponível");
  await manager.click("Concluir", { role: "button" });
});

// ===== Criterion 7: the client approves that version =====
step("c7-approve", 7, "Cliente aprova a versão 2", async () => {
  const client = await pageFor("client");
  await client.goto("/painel/notificacoes");
  await client.waitText(S.post);
  await client.goto(`/painel/conteudo/${S.ids.post}`);
  await client.waitText("Versão 2 em revisão");
  await client.waitText(/Slide 1 \/? ?(de )?3/);
  const first = await client.eval(() => document.querySelector(".rv-carousel img")?.getAttribute("alt") || "");
  await shot(client, "cliente-versao-2");
  await client.click("Aprovar versão 2", { role: "button", exact: true });
  await client.waitText("Confirmar aprovação da versão 2?");
  await client.fill("Mensagem para a equipe", "Perfeito, pode seguir.");
  await client.click("Confirmar aprovação", { role: "button", exact: true });
  await client.waitText("Aprovada");
  await shot(client, "cliente-aprovado");
  // Previous version kept in the history, with its own decision.
  await client.click(/^Versões/, { role: "tab" }).catch(() => {});
  await client.waitText("Versão 1");
  S.firstSlideAlt = first;
});

// ===== Criterion 8: single-file and organised ZIP downloads =====
step("c8-downloads", 8, "Cliente baixa um arquivo e ZIPs organizados", async () => {
  const client = await pageFor("client");
  await client.goto("/painel/marca");
  await client.waitText(S.logo);
  await shot(client, "cliente-minha-marca");
  const single = await client.download(() => client.click(/^Baixar logo-principal\.png/, { role: "button" }));
  assert(single.suggestedFilename === "logo-principal.png", `nome do arquivo baixado: ${single.suggestedFilename}`);
  assert(readFileSync(single.path).equals(readFileSync(F.logoPng)), "o PNG baixado não é idêntico ao enviado");
  S.downloads = { single: single.suggestedFilename };

  // The carousel, slides in the approved order.
  await client.goto(`/painel/conteudo/${S.ids.post}`);
  await client.waitText("Aprovada");
  const zip = await client.download(() => client.click("Baixar slides em ordem (ZIP)", { role: "button" }), { timeout: 90000 });
  const entries = readZip(readFileSync(zip.path)).filter((e) => !e.name.endsWith("/"));
  const names = entries.map((e) => e.name);
  const root = `${S.client.brand} - ${S.post}`;
  const expected = [`${root}/01-slide-3-v2.png`, `${root}/02-slide-1.png`, `${root}/03-slide-2.png`];
  assert(names.join("|") === expected.join("|"), `ZIP do carrossel: ${names.join(", ")}`);
  assert(entries[0].data().equals(readFileSync(F.slide3v2)), "o slide 1 do ZIP não é o arquivo original da versão 2");
  await client.waitText("pronto", { timeout: 5000 }).catch(() => {});
  await shot(client, "cliente-zip-carrossel");

  // The brand kit, organised by area / category / format.
  await client.goto("/painel/marca");
  const kit = await client.download(() => client.click(/^Baixar kit completo/, { role: "button" }), { timeout: 90000 });
  const kitNames = readZip(readFileSync(kit.path)).map((e) => e.name);
  for (const path of [
    `${S.client.brand}/Identidade visual/Logos/SVG/logo-principal.svg`,
    `${S.client.brand}/Identidade visual/Logos/PNG/logo-principal.png`,
  ])
    assert(kitNames.includes(path), `kit da marca sem ${path} (tem: ${kitNames.join(", ")})`);
  S.downloads.zips = [zip.suggestedFilename, kit.suggestedFilename];
  await shot(client, "cliente-kit-marca");
});

// ===== Criterion 9: another client cannot open these materials =====
step("c9-isolation", 9, "Outro cliente (Aurora) não abre os materiais pelo endereço", async () => {
  const aurora = await pageFor("aurora");
  await aurora.allowing([404, 404], async () => {
    await aurora.goto(`/painel/conteudo/${S.ids.post}`);
    await aurora.waitText("Não encontramos");
    const text = await aurora.text();
    assert(!text.includes(S.post), "o título do post de outro cliente apareceu");
    await shot(aurora, "aurora-post-bloqueado");
    await aurora.goto(`/painel/arquivos?material=${S.ids.logo}`);
    await aurora.waitText("Este material não está disponível");
    await shot(aurora, "aurora-arquivo-bloqueado");
  });
  await aurora.goto("/painel/conteudo");
  assert(!(await aurora.text()).includes(S.post), "o post aparece na central de conteúdo de outro cliente");
});

// ===== Criterion 10: the admin reads the whole history =====
step("c10-history", 10, "Admin consulta o histórico completo", async () => {
  const admin = await pageFor("admin");
  await admin.goto("/admin/historico");
  await filterBy(admin, "Cliente", S.client.name);
  // Every entry on screen must belong to this client (the filter really applied).
  const entries = await admin.waitFor(
    (client) => {
      if (!location.search.includes("cliente=")) return null;
      const rows = Array.from(document.querySelectorAll(".ov-log .ov-entry"));
      if (!rows.length || document.querySelector(".ov-log.is-refreshing")) return null;
      const out = rows.map((row) => ({
        summary: row.querySelector(".ov-entry__summary")?.innerText.trim() ?? "",
        where: row.querySelector(".ov-entry__where")?.innerText ?? "",
      }));
      return out.every((e) => e.where.includes(client)) ? out : null;
    },
    { message: "o filtro por cliente não mostrou só os registros deste cliente" },
    S.client.name,
  );
  const summaries = entries.map((e) => e.summary);
  const q = (t) => `“${t}”`;
  const expected = [
    `Cliente ${S.client.name} criado.`,
    `Marca ${S.client.brand} criada.`,
    `${S.client.person} foi convidado para acessar a plataforma.`,
    `Projeto ${S.project} criado para a marca ${S.client.brand}.`,
    `Designer (dev) criou o material ${q(S.logo)} como rascunho.`,
    `Designer (dev) criou o material ${q(S.post)} como rascunho.`,
    `Gestora de contas (dev) liberou 2 materiais para ${S.client.name}.`,
    `${S.client.person} comentou em ${q(S.post)}.`,
    `${S.client.person} solicitou ajustes na versão 1 de ${q(S.post)}.`,
    `Designer (dev) criou a versão 2 de ${q(S.post)}.`,
    `Gestora de contas (dev) liberou 1 material para ${S.client.name}.`,
    `${S.client.person} aprovou a versão 2 de ${q(S.post)}.`,
  ];
  const missing = expected.filter((line) => !summaries.includes(line));
  if (missing.length) {
    writeFileSync(join(SHOTS, "historico.txt"), summaries.join("\n"));
    throw new Error(`histórico sem:\n  ${missing.join("\n  ")}`);
  }
  // Newest first: the approval comes before the change request, which comes before the release.
  const pos = (line) => summaries.indexOf(line);
  assert(pos(expected[11]) < pos(expected[8]) && pos(expected[8]) < pos(expected[6]), "ordem do histórico inesperada");
  S.historyCount = entries.length;
  await shot(admin, "admin-historico", { full: true });
  // The material's own history includes downloads, never counted as approval.
  await admin.goto(`/admin/biblioteca/${S.ids.logo}`);
  await admin.click(/^Histórico/, { role: "tab" });
  await admin.waitText(/baixou/i);
  await admin.waitText(/não equivale a aprovação/i);
  await shot(admin, "admin-historico-material");
});

// ===== Criterion 11: download disabled and payment not configured =====
step("c11-download-disabled", 11, "Download desativado mostra a mensagem clara", async () => {
  const manager = await pageFor("manager");
  await manager.goto(`/admin/biblioteca/${S.ids.logo}`);
  await manager.check("Download disponível", false);
  await manager.waitText(/download/i);
  await shot(manager, "gestora-download-desativado");
  const client = await pageFor("client");
  await client.goto(`/painel/arquivos?material=${S.ids.logo}`);
  await client.waitText("O download deste material ainda não foi liberado");
  assert(!(await client.has(/^Baixar logo-principal/, { role: "button" })), "o botão de download continua ativo");
  await shot(client, "cliente-download-bloqueado");
  // Back to normal so reruns and the team see the usual state.
  await manager.check("Download disponível", true);
});

step("c11-payment", 11, "Pedido sem Mercado Pago configurado explica o motivo", async () => {
  const admin = await pageFor("admin");
  await admin.goto("/admin/pedidos");
  await admin.waitText("Mercado Pago não configurado");
  await admin.click("Novo pedido", { role: "button" });
  await admin.waitText("Cobrança avulsa");
  await admin.select("Cliente", S.client.name);
  await admin.select("Serviço", /^Identidade visual/);
  await admin.click("Criar pedido", { role: "button" });
  await admin.waitText("Gerar link de pagamento");
  await admin.waitText("Defina MP_ACCESS_TOKEN");
  assert(!(await admin.has("Gerar link de pagamento", { role: "button" })) || (await admin.eval(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.includes("Gerar link de pagamento"));
    return b?.disabled;
  })), "o botão de gerar link deveria estar desativado sem credenciais");
  await shot(admin, "admin-pedido-sem-mercado-pago");
});

// ---------- runner ----------
const results = [];
let failed = false;
let started = !FROM;
for (const s of steps) {
  if (!started) {
    if (s.id === FROM) started = true;
    else continue;
  }
  const t0 = Date.now();
  process.stdout.write(`[${MODE}] ${s.id} — ${s.title} … `);
  try {
    await s.fn();
    const overflow = [];
    for (const [role, page] of Object.entries(pages)) {
      // No sideways page scroll on any screen (checked where each person ended the step).
      const o = await page
        .eval(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, path: location.pathname }))
        .catch(() => null);
      if (o && o.sw > o.cw + 1) overflow.push(`${role}: rolagem horizontal em ${o.path} (${o.sw}px > ${o.cw}px)`);
    }
    const problems = overflow.concat(Object.entries(pages).flatMap(([role, page]) => {
      const p = page.takeProblems();
      return [
        ...p.consoleErrors.map((e) => `${role}: console: ${e}`),
        ...p.badResponses.map((r) => `${role}: HTTP ${r.status} ${r.url}`),
      ];
    }));
    if (problems.length) throw new Error(`problemas durante o passo:\n  ${problems.join("\n  ")}`);
    const ms = Date.now() - t0;
    results.push({ id: s.id, criterion: s.criterion, ok: true, ms });
    log(`ok (${(ms / 1000).toFixed(1)} s)`);
    saveState();
  } catch (error) {
    failed = true;
    results.push({ id: s.id, criterion: s.criterion, ok: false, error: error.message });
    log(`FALHOU\n    ${error.message}`);
    for (const [role, page] of Object.entries(pages)) {
      try {
        await page.shot(join(SHOTS, `FAIL-${s.id}-${role}.png`));
      } catch {}
    }
    saveState();
    break;
  }
  if (UNTIL && s.id === UNTIL) break;
}

devdb?.revokeAll();
devdb?.close();
await browser.close();
const byCriterion = {};
for (const r of results) (byCriterion[r.criterion] ||= []).push(r.ok);
log(`\n${MODE}: ${results.filter((r) => r.ok).length}/${results.length} passos ok · capturas em ${SHOTS}`);
log(
  Object.entries(byCriterion)
    .map(([c, oks]) => `  critério ${c}: ${oks.every(Boolean) ? "ok" : "falhou"}`)
    .join("\n"),
);
const complete = !failed && !FROM && !UNTIL && results.length === steps.length;
if (MOBILE) log(`  critério 12 (mesmos fluxos no celular, 390 px com toque): ${complete ? "ok" : failed ? "falhou" : "parcial"}`);
// Downloads and fixtures are kept only when something failed, for inspection.
if (!failed) rmSync(WORK, { recursive: true, force: true });
else log(`arquivos desta execução (downloads, fixtures, estado): ${WORK} · ${STATE_FILE}`);
process.exit(failed ? 1 : 0);
