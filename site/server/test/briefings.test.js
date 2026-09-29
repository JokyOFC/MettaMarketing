// Briefings: templates, builder validation, send, client answers (autosave
// and submit), review/reopen and isolation between clients and roles.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  addStaffAccess,
  createBrand,
  createClientWithBrand,
  createProject,
  createUser,
  login,
  startTestServer,
} from "./helpers.js";

let server;
let ctx;
const u = {};
const a = {};
const f = {};

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;
  const clientA = createClientWithBrand(ctx, { name: "Cliente A", brandName: "Marca A" });
  const clientB = createClientWithBrand(ctx, { name: "Cliente B", brandName: "Marca B" });
  f.clientA = clientA.clientId;
  f.brandA = clientA.brandId;
  f.brandA2 = createBrand(ctx, clientA.clientId, "Marca A2").id;
  f.brandB = clientB.brandId;

  u.admin = await createUser(ctx, { role: "admin", name: "Admin" });
  u.managerA = await createUser(ctx, { role: "manager", name: "Gestora A" });
  u.managerNone = await createUser(ctx, { role: "manager", name: "Gestor sem clientes" });
  u.designer = await createUser(ctx, { role: "designer", name: "Designer A" });
  u.designerIdle = await createUser(ctx, { role: "designer", name: "Designer sem projeto" });
  u.finance = await createUser(ctx, { role: "finance" });
  u.clientA = await createUser(ctx, { role: "client", clientId: clientA.clientId, name: "Ana Cliente" });
  u.clientA2 = await createUser(ctx, { role: "client", clientId: clientA.clientId, name: "Bruno Cliente" });
  u.clientB = await createUser(ctx, { role: "client", clientId: clientB.clientId, name: "Carla B" });
  addStaffAccess(ctx, u.managerA.id, clientA.clientId);

  f.projectA = createProject(ctx, { brandId: f.brandA, name: "Identidade A", memberIds: [u.designer.id] }).id;
  f.projectB = createProject(ctx, { brandId: f.brandB, name: "Projeto B" }).id;

  for (const key of Object.keys(u)) a[key] = await login(server, { email: u[key].email });
});

after(async () => {
  await server?.close();
});

const QUESTIONS = [
  { label: "Qual é o público?", type: "textarea", required: true },
  { label: "Tom de voz", type: "choice", options: ["Formal", "Próximo"], required: true },
  { label: "Redes", type: "multi", options: ["Instagram", "LinkedIn", "TikTok"] },
  { label: "Site atual", type: "url" },
  { label: "Data de lançamento", type: "date" },
];

async function newBriefing(agent = a.managerA, body = {}) {
  const res = await agent.post("/api/briefings", { brandId: f.brandA, title: "Briefing de teste", questions: QUESTIONS, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.briefing;
}

async function sentBriefing(body) {
  const briefing = await newBriefing(a.managerA, body);
  const res = await a.managerA.post(`/api/briefings/${briefing.id}/send`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.briefing;
}

const idsOf = (briefing) => Object.fromEntries(briefing.questions.map((item) => [item.label, item.id]));

describe("templates", () => {
  test("staff with briefings.view list the three built-in templates", async () => {
    const res = await a.designer.get("/api/briefing-templates");
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.items.map((item) => item.id),
      ["identidade-visual", "conteudo-mensal", "campanha"],
    );
    for (const template of res.body.items) {
      assert.ok(template.questions.length >= 8);
      assert.ok(template.requiredCount > 0);
      for (const question of template.questions) {
        if (question.type === "choice" || question.type === "multi") assert.ok(question.options.length >= 2);
      }
    }
  });

  test("clients and finance cannot read templates", async () => {
    assert.equal((await a.clientA.get("/api/briefing-templates")).status, 403);
    assert.equal((await a.finance.get("/api/briefing-templates")).status, 403);
  });

  test("a briefing created from a template copies its title, intro and questions", async () => {
    const res = await a.managerA.post("/api/briefings", { brandId: f.brandA, templateId: "campanha", projectId: f.projectA, dueDate: "2026-12-01" });
    assert.equal(res.status, 201);
    const { briefing } = res.body;
    assert.equal(briefing.status, "draft");
    assert.equal(briefing.title, "Briefing de campanha");
    assert.ok(briefing.intro);
    assert.equal(briefing.dueDate, "2026-12-01");
    assert.deepEqual(briefing.project, { id: f.projectA, name: "Identidade A" });
    assert.equal(briefing.brand.id, f.brandA);
    assert.equal(briefing.createdBy.id, u.managerA.id);
    assert.ok(briefing.questions.length > 5);
    assert.equal(new Set(briefing.questions.map((item) => item.id)).size, briefing.questions.length);
    assert.equal(briefing.permissions.canSend, true);
  });
});

describe("creating and editing", () => {
  test("only managers in scope and admins create briefings", async () => {
    assert.equal((await a.managerNone.post("/api/briefings", { brandId: f.brandA, title: "X" })).status, 404);
    assert.equal((await a.managerA.post("/api/briefings", { brandId: f.brandB, title: "X" })).status, 404);
    assert.equal((await a.designer.post("/api/briefings", { brandId: f.brandA, title: "X" })).status, 403);
    assert.equal((await a.clientA.post("/api/briefings", { brandId: f.brandA, title: "X" })).status, 403);
    assert.equal((await a.admin.post("/api/briefings", { brandId: f.brandB, title: "Do admin" })).status, 201);
  });

  test("question validation answers 422 with pt-BR messages per field", async () => {
    let res = await a.managerA.post("/api/briefings", { brandId: f.brandA });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.fields.title, "Dê um título ao briefing.");

    res = await a.managerA.post("/api/briefings", {
      brandId: f.brandA,
      title: "Inválido",
      questions: [{ label: "Escolha", type: "choice", options: ["Só uma"] }],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.fields["questions.0.options"], "Adicione pelo menos duas opções.");

    res = await a.managerA.post("/api/briefings", {
      brandId: f.brandA,
      title: "Duplicadas",
      questions: [
        { id: "igual", label: "Um", type: "text" },
        { id: "igual", label: "Dois", type: "text" },
      ],
    });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields["questions.1.id"]);

    res = await a.managerA.post("/api/briefings", {
      brandId: f.brandA,
      title: "Tipo",
      questions: [{ label: "Arquivo", type: "file" }],
    });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields["questions.0.type"]);

    res = await a.managerA.post("/api/briefings", { brandId: f.brandA, title: "Sem rótulo", questions: [{ label: "  ", type: "text" }] });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.fields["questions.0.label"], "Escreva a pergunta.");
  });

  test("a project from another brand is refused", async () => {
    const res = await a.admin.post("/api/briefings", { brandId: f.brandA, title: "Projeto errado", projectId: f.projectB });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.projectId);
  });

  test("editing keeps question ids stable and generates ids for new questions", async () => {
    const briefing = await newBriefing();
    const [first, second] = briefing.questions;
    const res = await a.managerA.patch(`/api/briefings/${briefing.id}`, {
      intro: "Obrigado por responder.",
      questions: [second, { ...first, label: "Qual é o público principal?" }, { label: "Nova pergunta", type: "text", required: false }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const updated = res.body.briefing;
    assert.equal(updated.intro, "Obrigado por responder.");
    assert.deepEqual(updated.questions.slice(0, 2).map((item) => item.id), [second.id, first.id]);
    assert.equal(updated.questions[1].label, "Qual é o público principal?");
    assert.match(updated.questions[2].id, /^[A-Za-z0-9_-]+$/);
    assert.equal(updated.questions[2].options, undefined);
  });

  test("designers read briefings of their brands but cannot change them", async () => {
    const briefing = await newBriefing();
    assert.equal((await a.designer.get(`/api/briefings/${briefing.id}`)).status, 200);
    assert.equal((await a.designer.patch(`/api/briefings/${briefing.id}`, { title: "Novo" })).status, 403);
    assert.equal((await a.designerIdle.get(`/api/briefings/${briefing.id}`)).status, 404);
    const list = await a.designerIdle.get("/api/briefings");
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 0);
  });

  test("drafts can be deleted; answered briefings cannot", async () => {
    const briefing = await newBriefing();
    assert.equal((await a.managerA.del(`/api/briefings/${briefing.id}`)).status, 204);
    assert.equal((await a.managerA.get(`/api/briefings/${briefing.id}`)).status, 404);
  });
});

describe("sending and client visibility", () => {
  test("clients never see drafts", async () => {
    const draft = await newBriefing(a.managerA, { title: "Rascunho secreto" });
    assert.equal((await a.clientA.get(`/api/briefings/${draft.id}`)).status, 404);
    const list = await a.clientA.get("/api/briefings");
    assert.equal(list.status, 200);
    assert.ok(!list.body.items.some((item) => item.id === draft.id));
    assert.equal(list.body.counts.draft, undefined);
  });

  test("a briefing without questions cannot be sent", async () => {
    const empty = await newBriefing(a.managerA, { title: "Vazio", questions: [] });
    const res = await a.managerA.post(`/api/briefings/${empty.id}/send`);
    assert.equal(res.status, 422);
  });

  test("send notifies every active client user in the app and by e-mail", async () => {
    const briefing = await newBriefing(a.managerA, { title: "Briefing enviado", dueDate: "2026-11-20" });
    const res = await a.managerA.post(`/api/briefings/${briefing.id}/send`);
    assert.equal(res.status, 200);
    assert.equal(res.body.briefing.status, "awaiting_client");
    assert.ok(res.body.briefing.sentAt);
    assert.equal(res.body.recipients, 2);
    assert.equal(res.body.reminder, false);
    // no SMTP in tests: the answer must not let the interface claim an e-mail
    assert.equal(res.body.notified, 2);
    assert.equal(res.body.emailConfigured, false);
    assert.equal(res.body.emailRecipients, 2);

    for (const user of [u.clientA, u.clientA2]) {
      const row = ctx.db.get("SELECT * FROM notifications WHERE user_id = ? AND entity_id = ?", [user.id, briefing.id]);
      assert.equal(row.type, "briefing.sent");
      assert.equal(row.link, `/painel/briefings/${briefing.id}`);
      assert.match(row.body, /20\/11\/2026/);
    }
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND entity_id = ?", [u.clientB.id, briefing.id]).n, 0);
    await ctx.mailer.idle();
    const mail = ctx.db.get("SELECT * FROM email_outbox WHERE to_email = ? AND subject LIKE ?", [u.clientA.email, "%Briefing enviado%"]);
    assert.ok(mail, "e-mail recorded in the outbox");
    assert.match(mail.text_body, new RegExp(`/painel/briefings/${briefing.id}`));

    const activity = ctx.db.get("SELECT * FROM activity_log WHERE entity_id = ? AND action = 'briefing.sent'", [briefing.id]);
    assert.equal(activity.visibility, "client");
    assert.equal(activity.client_id, f.clientA);

    const again = await a.managerA.post(`/api/briefings/${briefing.id}/send`);
    assert.equal(again.status, 200);
    assert.equal(again.body.reminder, true);
    assert.equal(again.body.briefing.status, "awaiting_client");
  });

  test("send reports who gets the e-mail: SMTP configured and e-mail notices on", async () => {
    const briefing = await newBriefing(a.managerA, { title: "Alcance do aviso" });
    const configured = ctx.mailer.isConfigured;
    ctx.db.run("UPDATE users SET notify_email = 0 WHERE id = ?", [u.clientA2.id]);
    try {
      ctx.mailer.isConfigured = () => true;
      const res = await a.managerA.post(`/api/briefings/${briefing.id}/send`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.recipients, 2);
      assert.equal(res.body.notified, 2);
      assert.equal(res.body.emailConfigured, true);
      assert.equal(res.body.emailRecipients, 1);
    } finally {
      ctx.mailer.isConfigured = configured;
      ctx.db.run("UPDATE users SET notify_email = 1 WHERE id = ?", [u.clientA2.id]);
    }
  });

  test("another client, a manager without access and finance cannot reach the briefing", async () => {
    const briefing = await sentBriefing();
    assert.equal((await a.clientB.get(`/api/briefings/${briefing.id}`)).status, 404);
    assert.equal((await a.clientB.put(`/api/briefings/${briefing.id}/answers`, { answers: {} })).status, 404);
    assert.equal((await a.managerNone.get(`/api/briefings/${briefing.id}`)).status, 404);
    assert.equal((await a.managerNone.post(`/api/briefings/${briefing.id}/review`)).status, 404);
    assert.equal((await a.finance.get(`/api/briefings/${briefing.id}`)).status, 403);
    assert.equal((await a.finance.get("/api/briefings")).status, 403);
    const listB = await a.clientB.get("/api/briefings");
    assert.ok(!listB.body.items.some((item) => item.id === briefing.id));
    const listNone = await a.managerNone.get("/api/briefings");
    assert.equal(listNone.body.total, 0);
  });

  test("client responses carry no staff-only fields", async () => {
    const briefing = await sentBriefing();
    const res = await a.clientA.get(`/api/briefings/${briefing.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.briefing.createdBy, undefined);
    assert.equal(res.body.briefing.reviewedBy, undefined);
    assert.equal(res.body.briefing.permissions.canAnswer, true);
    assert.equal(res.body.briefing.permissions.canEdit, false);
  });
});

describe("client answers", () => {
  test("autosave keeps partial answers and moves the briefing to in_progress", async () => {
    const briefing = await sentBriefing();
    const ids = idsOf(briefing);
    const res = await a.clientA.put(`/api/briefings/${briefing.id}/answers`, {
      answers: {
        [ids["Qual é o público?"]]: "Empresas de tecnologia ",
        [ids["Tom de voz"]]: "Inexistente",
        [ids["Redes"]]: ["Instagram", "Orkut"],
        [ids["Site atual"]]: "meusite",
        desconhecida: "ignorada",
      },
      submit: false,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const saved = res.body.briefing;
    assert.equal(saved.status, "in_progress");
    assert.equal(saved.answers[ids["Qual é o público?"]], "Empresas de tecnologia ");
    assert.equal(saved.answers[ids["Tom de voz"]], undefined);
    assert.deepEqual(saved.answers[ids["Redes"]], ["Instagram"]);
    assert.equal(saved.answers[ids["Site atual"]], "meusite");
    assert.equal(saved.answers.desconhecida, undefined);
    assert.deepEqual(saved.progress, { total: 5, answered: 3, required: 2, requiredAnswered: 1 });
    assert.ok(res.body.savedAt);

    const staffView = await a.managerA.get(`/api/briefings/${briefing.id}`);
    assert.equal(staffView.body.briefing.status, "in_progress");
    assert.equal(staffView.body.briefing.progress.answered, 3);
  });

  test("staff cannot answer on the client's behalf", async () => {
    const briefing = await sentBriefing();
    assert.equal((await a.managerA.put(`/api/briefings/${briefing.id}/answers`, { answers: {} })).status, 403);
    assert.equal((await a.admin.put(`/api/briefings/${briefing.id}/answers`, { answers: {} })).status, 403);
  });

  test("submit requires every required answer and validates links", async () => {
    const briefing = await sentBriefing();
    const ids = idsOf(briefing);
    let res = await a.clientA.put(`/api/briefings/${briefing.id}/answers`, {
      answers: { [ids["Qual é o público?"]]: "Fintechs", [ids["Site atual"]]: "não é um link" },
      submit: true,
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.fields[`answers.${ids["Tom de voz"]}`], "Responda esta pergunta.");
    assert.ok(res.body.error.fields[`answers.${ids["Site atual"]}`]);
    assert.equal(ctx.db.get("SELECT status FROM briefings WHERE id = ?", [briefing.id]).status, "awaiting_client");

    res = await a.clientA.put(`/api/briefings/${briefing.id}/answers`, {
      answers: {
        [ids["Qual é o público?"]]: "  Fintechs e bancos digitais  ",
        [ids["Tom de voz"]]: "Próximo",
        [ids["Site atual"]]: "www.exemplo.com.br",
        [ids["Data de lançamento"]]: "2026-11-03",
      },
      submit: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const done = res.body.briefing;
    assert.equal(done.status, "submitted");
    assert.equal(done.answers[ids["Qual é o público?"]], "Fintechs e bancos digitais");
    assert.equal(done.answers[ids["Site atual"]], "https://www.exemplo.com.br/");
    assert.equal(done.submittedBy.id, u.clientA.id);
    assert.ok(done.submittedAt);
    assert.equal(done.permissions.canAnswer, false);

    const note = ctx.db.get("SELECT * FROM notifications WHERE user_id = ? AND entity_id = ? AND type = 'briefing.submitted'", [
      u.managerA.id,
      briefing.id,
    ]);
    assert.ok(note, "the manager of the client is notified");
    assert.equal(note.link, `/admin/briefings/${briefing.id}`);
    const activity = ctx.db.get("SELECT * FROM activity_log WHERE entity_id = ? AND action = 'briefing.submitted'", [briefing.id]);
    assert.equal(activity.visibility, "client");

    // closed for the client and locked for question edits
    const late = await a.clientA.put(`/api/briefings/${briefing.id}/answers`, { answers: {}, submit: false });
    assert.equal(late.status, 409);
    const edit = await a.managerA.patch(`/api/briefings/${briefing.id}`, { questions: [] });
    assert.equal(edit.status, 409);
    assert.equal((await a.managerA.patch(`/api/briefings/${briefing.id}`, { title: "Renomeado" })).status, 200);
    assert.equal((await a.managerA.del(`/api/briefings/${briefing.id}`)).status, 409);
  });

  test("review and reopen", async () => {
    const briefing = await sentBriefing();
    const ids = idsOf(briefing);
    const complete = { [ids["Qual é o público?"]]: "Pessoas", [ids["Tom de voz"]]: "Formal" };
    assert.equal((await a.managerA.post(`/api/briefings/${briefing.id}/review`)).status, 409);
    assert.equal((await a.clientA.put(`/api/briefings/${briefing.id}/answers`, { answers: complete, submit: true })).status, 200);

    assert.equal((await a.clientA.post(`/api/briefings/${briefing.id}/review`)).status, 403);
    assert.equal((await a.designer.post(`/api/briefings/${briefing.id}/review`)).status, 403);
    const reviewed = await a.managerA.post(`/api/briefings/${briefing.id}/review`);
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.briefing.status, "reviewed");
    assert.equal(reviewed.body.briefing.reviewedBy.id, u.managerA.id);
    assert.equal((await a.managerA.post(`/api/briefings/${briefing.id}/review`)).status, 409);
    assert.equal((await a.clientA.get(`/api/briefings/${briefing.id}`)).body.briefing.status, "reviewed");

    const reopened = await a.managerA.post(`/api/briefings/${briefing.id}/reopen`, { message: "Faltou detalhar o público." });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.briefing.status, "in_progress");
    assert.equal(reopened.body.briefing.submittedAt, null);
    assert.equal(reopened.body.briefing.answers[ids["Tom de voz"]], "Formal");
    const note = ctx.db.get("SELECT * FROM notifications WHERE user_id = ? AND entity_id = ? AND type = 'briefing.reopened'", [
      u.clientA.id,
      briefing.id,
    ]);
    assert.equal(note.body, "Faltou detalhar o público.");
    const again = await a.clientA.put(`/api/briefings/${briefing.id}/answers`, { answers: complete, submit: false });
    assert.equal(again.status, 200);
    assert.equal(again.body.briefing.status, "in_progress");
  });
});

describe("lists", () => {
  test("staff filter by status and brand, with counts per status", async () => {
    const draft = await newBriefing(a.admin, { brandId: f.brandA2, title: "Marca dois" });
    const res = await a.managerA.get(`/api/briefings?brandId=${f.brandA2}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((item) => item.id), [draft.id]);
    assert.equal(res.body.items[0].questions, undefined);
    assert.equal(res.body.items[0].progress.total, QUESTIONS.length);
    assert.equal(res.body.counts.draft, 1);

    const drafts = await a.managerA.get("/api/briefings?status=draft");
    assert.ok(drafts.body.items.every((item) => item.status === "draft"));
    assert.ok(drafts.body.counts.awaiting_client >= 1);
    const search = await a.managerA.get(`/api/briefings?q=${encodeURIComponent("Marca dois")}`);
    assert.deepEqual(search.body.items.map((item) => item.id), [draft.id]);
  });

  test("clients see open briefings first", async () => {
    const res = await a.clientA.get("/api/briefings");
    assert.equal(res.status, 200);
    const statuses = res.body.items.map((item) => item.status);
    const firstClosed = statuses.findIndex((status) => status === "submitted" || status === "reviewed");
    const lastOpen = statuses.findLastIndex((status) => status === "awaiting_client" || status === "in_progress");
    assert.ok(firstClosed === -1 || lastOpen < firstClosed, statuses.join(","));
    assert.ok(res.body.items.every((item) => item.brand.clientId === f.clientA));
  });
});
