// Briefings (slice H): questionnaires the team sends to a client brand.
//
//   draft -> awaiting_client (send) -> in_progress (client autosave)
//         -> submitted (client submit) -> reviewed (team)
//   submitted|reviewed -> in_progress (reopen)
//
// Staff read within their brand scope (briefings.view) and write with
// briefings.manage; clients read non-draft briefings of their own brands and
// are the only ones who answer. Out-of-scope ids answer 404.
import { randomBytes } from "node:crypto";
import { Router } from "express";
import { assertBrand, assertProject, scopeSql } from "../lib/access.js";
import { logActivity } from "../lib/audit.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { conflict, notFound, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { adminIds, clientUserIds, managerIdsForClient, notify } from "../lib/notify.js";
import { isStaff, parseJson, personRef, userRef } from "../lib/serialize.js";
import { isValidDate, now } from "../lib/time.js";
import { paginate, parse, queryList, schemas, z } from "../lib/validate.js";
import { noticeReach } from "./projects.js";

export const QUESTION_TYPES = ["text", "textarea", "choice", "multi", "date", "url"];
export const BRIEFING_STATUSES = ["draft", "awaiting_client", "in_progress", "submitted", "reviewed"];
const OPEN_FOR_CLIENT = new Set(["awaiting_client", "in_progress"]);
const ANSWER_LIMITS = { text: 1000, textarea: 10000, url: 2000, date: 10, choice: 120 };

// ------------------------------------------------------------------ templates

const q = (id, type, label, extra = {}) => ({ id, type, label, help: null, required: false, ...extra });

export const BRIEFING_TEMPLATES = [
  {
    id: "identidade-visual",
    name: "Identidade visual",
    description: "Negócio, público, personalidade e referências para criar ou evoluir a marca.",
    title: "Briefing de identidade visual",
    intro:
      "Estas respostas orientam a criação da identidade visual da sua marca. Responda com calma: tudo fica salvo automaticamente e você pode voltar quando quiser antes de enviar.",
    questions: [
      q("negocio", "textarea", "Conte sobre o negócio: o que a empresa faz e para quem.", { required: true }),
      q("publico", "textarea", "Quem é o público principal da marca?", {
        required: true,
        help: "Perfil, momento de vida, o que valorizam e o que esperam de uma empresa como a sua.",
      }),
      q("diferenciais", "textarea", "O que diferencia a empresa dos concorrentes?", { required: true }),
      q("personalidade", "multi", "Quais palavras descrevem a personalidade desejada para a marca?", {
        required: true,
        help: "Escolha até quatro, se possível.",
        options: ["Confiável", "Próxima", "Sofisticada", "Inovadora", "Acessível", "Tecnológica", "Sóbria", "Ousada", "Acolhedora", "Direta"],
      }),
      q("marca-atual", "choice", "A marca já possui um logotipo?", {
        required: true,
        options: ["Não, é uma marca nova", "Sim, e queremos evoluir o atual", "Sim, e queremos substituí-lo"],
      }),
      q("concorrentes", "textarea", "Cite concorrentes ou marcas que admira, do seu setor ou não.", {
        help: "Diga o que chama sua atenção em cada uma.",
      }),
      q("referencias", "url", "Link para uma pasta de referências visuais", {
        help: "Pinterest, Google Drive, Dropbox ou similar.",
      }),
      q("cores", "textarea", "Há cores que a marca deve usar ou evitar?"),
      q("aplicacoes", "multi", "Onde a identidade será aplicada primeiro?", {
        required: true,
        options: ["Redes sociais", "Site", "Aplicativo", "Apresentações", "Materiais impressos", "Sinalização", "Embalagens"],
      }),
      q("lancamento", "date", "Existe uma data importante para o lançamento?"),
      q("observacoes", "textarea", "Algo mais que devemos saber?"),
    ],
  },
  {
    id: "conteudo-mensal",
    name: "Conteúdo mensal",
    description: "Prioridades, datas e temas do mês para planejar o calendário de publicações.",
    title: "Briefing de conteúdo do mês",
    intro: "Conte o que é prioridade neste mês. Com estas respostas planejamos o calendário e os formatos das publicações.",
    questions: [
      q("objetivo", "textarea", "Qual é o principal objetivo da comunicação neste mês?", { required: true }),
      q("temas", "textarea", "Quais temas, produtos ou serviços devem ter destaque?", { required: true }),
      q("datas", "textarea", "Datas, lançamentos ou eventos que devem entrar no calendário", {
        help: "Inclua a data e uma breve descrição de cada item.",
      }),
      q("redes", "multi", "Em quais redes vamos publicar?", {
        required: true,
        options: ["Instagram", "LinkedIn", "Facebook", "TikTok", "YouTube", "X"],
      }),
      q("formatos", "multi", "Quais formatos vocês preferem?", {
        options: ["Posts estáticos", "Carrosséis", "Stories", "Reels e vídeos"],
      }),
      q("evitar", "textarea", "Há assuntos que devemos evitar?"),
      q("materiais", "url", "Link com fotos, vídeos ou materiais da empresa para usar", {
        help: "Google Drive, Dropbox ou similar.",
      }),
      q("aprovador", "text", "Quem aprova as publicações do lado de vocês?", { required: true }),
      q("observacoes", "textarea", "Observações"),
    ],
  },
  {
    id: "campanha",
    name: "Campanha",
    description: "Objetivo, mensagem, período e canais de uma campanha com começo, meio e fim.",
    title: "Briefing de campanha",
    intro: "Detalhes para planejarmos a campanha. Quanto mais claro o objetivo, mais precisa fica a proposta.",
    questions: [
      q("nome", "text", "Nome ou tema da campanha", { required: true }),
      q("objetivo", "choice", "Qual é o objetivo principal?", {
        required: true,
        options: ["Reconhecimento de marca", "Geração de contatos", "Lançamento de produto", "Engajamento", "Vendas", "Outro"],
      }),
      q("mensagem", "textarea", "Qual mensagem o público precisa guardar?", { required: true }),
      q("publico", "textarea", "Para quem é esta campanha?", { required: true }),
      q("oferta", "textarea", "Há oferta, condição especial ou chamada para ação?"),
      q("inicio", "date", "Data de início", { required: true }),
      q("fim", "date", "Data de término"),
      q("canais", "multi", "Em quais canais a campanha vai aparecer?", {
        required: true,
        options: ["Instagram", "LinkedIn", "Facebook", "TikTok", "YouTube", "E-mail", "Site", "Mídia paga"],
      }),
      q("midia-paga", "textarea", "Haverá investimento em mídia paga? Conte como imagina."),
      q("referencias", "url", "Link para referências"),
      q("observacoes", "textarea", "Observações"),
    ],
  },
];

const templateById = (id) => BRIEFING_TEMPLATES.find((template) => template.id === id) ?? null;

function serializeTemplate(template) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    title: template.title,
    intro: template.intro,
    questionCount: template.questions.length,
    requiredCount: template.questions.filter((item) => item.required).length,
    questions: template.questions.map((item) => ({ ...item, options: item.options ? [...item.options] : undefined })),
  };
}

// ------------------------------------------------------------------ questions

const questionSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,40}$/, "Identificador de pergunta inválido.")
    .optional()
    .nullable(),
  label: z.string().trim().min(1, "Escreva a pergunta.").max(300),
  help: schemas.optionalText(1000),
  type: z.enum(QUESTION_TYPES),
  options: z.array(z.string().trim().max(120)).max(30, "Use no máximo 30 opções.").optional().nullable(),
  required: z.boolean().optional().default(false),
});
const questionsSchema = z.array(questionSchema).max(80, "Use no máximo 80 perguntas.");

const newQuestionId = () => `q${randomBytes(5).toString("hex")}`;

// Validates the question list as a whole: stable unique ids (new ones are
// generated), choice types need two distinct options, others drop options.
export function normalizeQuestions(list) {
  const fields = {};
  const seen = new Set();
  const out = list.map((item, index) => {
    let id = item.id || null;
    if (id && seen.has(id)) fields[`questions.${index}.id`] = "Há duas perguntas com o mesmo identificador.";
    if (!id) {
      do id = newQuestionId();
      while (seen.has(id));
    }
    seen.add(id);
    const question = {
      id,
      label: item.label,
      help: item.help ?? null,
      type: item.type,
      required: Boolean(item.required),
    };
    if (item.type === "choice" || item.type === "multi") {
      const options = (item.options ?? []).map((text) => text.trim()).filter(Boolean);
      const lower = options.map((text) => text.toLowerCase());
      if (options.length < 2) fields[`questions.${index}.options`] = "Adicione pelo menos duas opções.";
      else if (new Set(lower).size !== lower.length) fields[`questions.${index}.options`] = "As opções precisam ser diferentes entre si.";
      question.options = options;
    }
    return question;
  });
  if (Object.keys(fields).length) throw validation(fields);
  return out;
}

// ------------------------------------------------------------------ answers

const isEmpty = (value) =>
  value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length);

export function hasAnswer(question, value) {
  if (isEmpty(value)) return false;
  if (question.type === "multi") return Array.isArray(value) && value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

export function briefingProgress(questions, answers) {
  let answered = 0;
  let required = 0;
  let requiredAnswered = 0;
  for (const question of questions) {
    const ok = hasAnswer(question, answers?.[question.id]);
    if (ok) answered += 1;
    if (question.required) {
      required += 1;
      if (ok) requiredAnswered += 1;
    }
  }
  return { total: questions.length, answered, required, requiredAnswered };
}

// "www.site.com" -> "https://www.site.com"; null when it is not a web link.
function normalizeUrl(text) {
  let value = String(text).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value.replace(/^\/+/, "")}`;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Cleans a client's answers against the current questions. Autosave keeps
 * partial input (unknown ids and mismatched types are dropped); submit trims,
 * validates links and dates and requires every required question.
 * -> answers object (only non-empty values)
 */
export function cleanAnswers(questions, raw, { submit = false } = {}) {
  const fields = {};
  const out = {};
  for (const question of questions) {
    const value = raw?.[question.id];
    if (isEmpty(value)) {
      if (submit && question.required) fields[`answers.${question.id}`] = "Responda esta pergunta.";
      continue;
    }
    const key = `answers.${question.id}`;
    if (question.type === "multi") {
      if (!Array.isArray(value)) continue;
      const allowed = new Set(question.options ?? []);
      const picked = [...new Set(value.filter((item) => typeof item === "string" && allowed.has(item)))];
      if (picked.length) out[question.id] = picked;
      else if (submit && question.required) fields[key] = "Escolha pelo menos uma opção.";
      continue;
    }
    if (typeof value !== "string") continue;
    const limit = ANSWER_LIMITS[question.type] ?? 1000;
    if (value.length > limit) {
      fields[key] = `Use no máximo ${limit} caracteres.`;
      continue;
    }
    if (question.type === "choice") {
      if ((question.options ?? []).includes(value)) out[question.id] = value;
      else if (submit && question.required) fields[key] = "Escolha uma das opções.";
      continue;
    }
    if (question.type === "date") {
      if (isValidDate(value.trim())) out[question.id] = value.trim();
      else if (submit) fields[key] = "Use uma data válida.";
      continue;
    }
    if (question.type === "url" && submit) {
      const url = normalizeUrl(value);
      if (url) out[question.id] = url;
      else fields[key] = "Informe um link válido, por exemplo https://site.com.br.";
      continue;
    }
    out[question.id] = submit ? value.trim() : value;
  }
  if (Object.keys(fields).length) throw validation(fields, submit ? "Revise as respostas destacadas antes de enviar." : undefined);
  return out;
}

// ------------------------------------------------------------------ records

const BRIEFING_SELECT = `SELECT br.*, b.client_id AS client_id, b.name AS brand_name, b.slug AS brand_slug,
       c.name AS client_name, p.name AS project_name,
       cu.name AS created_by_name, cu.role AS created_by_role,
       su.name AS submitted_by_name, su.role AS submitted_by_role,
       ru.name AS reviewed_by_name, ru.role AS reviewed_by_role
  FROM briefings br
  JOIN brands b ON b.id = br.brand_id
  JOIN clients c ON c.id = b.client_id
  LEFT JOIN projects p ON p.id = br.project_id
  LEFT JOIN users cu ON cu.id = br.created_by
  LEFT JOIN users su ON su.id = br.submitted_by
  LEFT JOIN users ru ON ru.id = br.reviewed_by`;

const loadRow = (db, id) => db.get(`${BRIEFING_SELECT} WHERE br.id = ?`, [id]);

// Loads a briefing the viewer may see, or throws 404.
function assertBriefing(req, id) {
  const row = typeof id === "string" && id.length <= 64 ? loadRow(req.ctx.db, id) : null;
  if (!row) throw notFound();
  if (req.user.role === "client") {
    if (row.client_id !== req.user.client_id || row.status === "draft") throw notFound();
    return row;
  }
  assertBrand(req, row.brand_id); // 404 outside the staff member's scope
  return row;
}

function serializeBriefing(req, row, { full = true } = {}) {
  const staff = isStaff(req);
  const questions = parseJson(row.questions, []);
  const stored = parseJson(row.answers, {});
  const answers = {};
  for (const question of questions) if (!isEmpty(stored[question.id])) answers[question.id] = stored[question.id];
  const briefing = {
    id: row.id,
    title: row.title,
    intro: row.intro ?? null,
    status: row.status,
    dueDate: row.due_date ?? null,
    sentAt: row.sent_at ?? null,
    submittedAt: row.submitted_at ?? null,
    submittedBy: row.submitted_by
      ? personRef(req, { id: row.submitted_by, name: row.submitted_by_name ?? "Usuário removido", role: row.submitted_by_role })
      : null,
    reviewedAt: row.reviewed_at ?? null,
    brand: { id: row.brand_id, name: row.brand_name, slug: row.brand_slug, clientId: row.client_id },
    client: { id: row.client_id, name: row.client_name },
    project: row.project_id ? { id: row.project_id, name: row.project_name } : null,
    progress: briefingProgress(questions, answers),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (staff) {
    briefing.createdBy = row.created_by ? userRef({ id: row.created_by, name: row.created_by_name, role: row.created_by_role }) : null;
    briefing.reviewedBy = row.reviewed_by ? userRef({ id: row.reviewed_by, name: row.reviewed_by_name, role: row.reviewed_by_role }) : null;
  }
  if (full) {
    briefing.questions = questions;
    briefing.answers = answers;
  }
  return briefing;
}

// Only the fields the client portal and the staff list need.
function permissionsFor(req, row) {
  const manage = req.user.role !== "client" && req.user.capabilities?.includes("briefings.manage");
  const locked = row.status === "submitted" || row.status === "reviewed";
  return {
    canEdit: Boolean(manage),
    canEditQuestions: Boolean(manage) && !locked,
    canSend: Boolean(manage) && row.status === "draft",
    canRemind: Boolean(manage) && OPEN_FOR_CLIENT.has(row.status),
    canDelete: Boolean(manage) && (row.status === "draft" || row.status === "awaiting_client"),
    canReview: Boolean(manage) && row.status === "submitted",
    canReopen: Boolean(manage) && locked,
    canAnswer: req.user.role === "client" && OPEN_FOR_CLIENT.has(row.status),
  };
}

const detail = (req, row) => ({ ...serializeBriefing(req, row), permissions: permissionsFor(req, row) });

function dateLabel(value) {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

// Project id from the request -> row (must belong to the brand), null or undefined.
function resolveProject(req, projectId, brandId) {
  if (projectId === undefined) return undefined;
  if (projectId === null || projectId === "") return null;
  let project;
  try {
    project = assertProject(req, projectId);
  } catch {
    throw validation({ projectId: "Escolha um projeto desta marca." });
  }
  if (project.brand_id !== brandId) throw validation({ projectId: "O projeto escolhido pertence a outra marca." });
  return project;
}

// Team members who follow a briefing: its author, the client's managers and
// the members of the linked project. Falls back to admins.
function staffFollowers(db, row) {
  const ids = new Set();
  const author = row.created_by ? db.get("SELECT id, role, status FROM users WHERE id = ?", [row.created_by]) : null;
  if (author && author.role !== "client" && author.status === "active") ids.add(author.id);
  for (const id of managerIdsForClient(db, row.client_id)) ids.add(id);
  if (row.project_id)
    for (const member of db.all(
      `SELECT pm.user_id FROM project_members pm JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ? AND u.status = 'active'`,
      [row.project_id],
    ))
      ids.add(member.user_id);
  if (!ids.size) for (const id of adminIds(db)) ids.add(id);
  return [...ids];
}

// ------------------------------------------------------------------ schemas

const createSchema = z.object({
  brandId: z.string({ error: "Escolha a marca." }).trim().min(1, "Escolha a marca.").max(64),
  projectId: z.string().trim().max(64).nullable().optional(),
  templateId: z.string().trim().max(60).nullable().optional(),
  title: schemas.optionalText(160),
  intro: schemas.optionalText(4000),
  dueDate: schemas.optionalDate,
  questions: questionsSchema.optional(),
});

const patchSchema = z.object({
  title: z.string().trim().min(1, "Dê um título ao briefing.").max(160).optional(),
  intro: schemas.optionalText(4000),
  dueDate: schemas.optionalDate,
  projectId: z.string().trim().max(64).nullable().optional(),
  questions: questionsSchema.optional(),
});

const answersSchema = z.object({
  answers: z.record(z.string().max(60), z.union([z.string().max(20000), z.array(z.string().max(500)).max(60), z.null()])),
  submit: z.boolean().optional().default(false),
});

const reopenSchema = z.object({ message: schemas.optionalText(1000) });

// ------------------------------------------------------------------ router

export default function briefingsRoutes(ctx) {
  const router = Router();
  const { db } = ctx;
  const canView = requireCap("briefings.view", "portal.access");
  const canManage = requireCap("briefings.manage");

  router.get("/api/briefing-templates", requireAuth, requireCap("briefings.view"), (req, res) => {
    res.json({ items: BRIEFING_TEMPLATES.map(serializeTemplate) });
  });

  router.get("/api/briefings", requireAuth, canView, (req, res) => {
    const { page, pageSize, limit, offset } = paginate(req.query, { defaultSize: 50 });
    const where = [];
    const params = [];
    if (req.user.role === "client") {
      where.push("b.client_id = ?", "br.status <> 'draft'");
      params.push(req.user.client_id);
    } else {
      const scope = scopeSql.brands(req, "b");
      where.push(scope.sql);
      params.push(...scope.params);
      if (req.query.clientId) {
        where.push("b.client_id = ?");
        params.push(String(req.query.clientId));
      }
      if (req.query.projectId) {
        where.push("br.project_id = ?");
        params.push(String(req.query.projectId));
      }
    }
    if (req.query.brandId) {
      where.push("br.brand_id = ?");
      params.push(String(req.query.brandId));
    }
    const q = String(req.query.q ?? "").trim().slice(0, 100);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(br.title LIKE ? ESCAPE '\\' OR b.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    const base = `FROM briefings br JOIN brands b ON b.id = br.brand_id JOIN clients c ON c.id = b.client_id WHERE ${where.join(" AND ")}`;

    // counts per status ignore the status filter (tabs show every bucket)
    const counts = Object.fromEntries(BRIEFING_STATUSES.map((status) => [status, 0]));
    for (const row of db.all(`SELECT br.status, COUNT(*) AS n ${base} GROUP BY br.status`, params)) counts[row.status] = row.n;
    if (req.user.role === "client") delete counts.draft;

    const statuses = queryList(req.query.status).filter((status) => BRIEFING_STATUSES.includes(status));
    const listWhere = [...where];
    const listParams = [...params];
    if (statuses.length) {
      listWhere.push(`br.status IN (${statuses.map(() => "?").join(", ")})`);
      listParams.push(...statuses);
    }
    const whereSql = listWhere.join(" AND ");
    const total = db.get(
      `SELECT COUNT(*) AS n FROM briefings br JOIN brands b ON b.id = br.brand_id JOIN clients c ON c.id = b.client_id WHERE ${whereSql}`,
      listParams,
    ).n;
    const order =
      req.user.role === "client"
        ? `CASE WHEN br.status IN ('awaiting_client', 'in_progress') THEN 0 ELSE 1 END,
           CASE WHEN br.status IN ('awaiting_client', 'in_progress') THEN COALESCE(br.due_date, '9999-12-31') END,
           COALESCE(br.submitted_at, br.sent_at, br.created_at) DESC`
        : "br.updated_at DESC, br.created_at DESC";
    const rows = db.all(`${BRIEFING_SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...listParams, limit, offset]);
    res.json({ items: rows.map((row) => serializeBriefing(req, row, { full: false })), total, counts, page, pageSize });
  });

  router.post("/api/briefings", requireAuth, canManage, (req, res) => {
    const input = parse(createSchema, req.body);
    const brand = assertBrand(req, input.brandId);
    const project = resolveProject(req, input.projectId, brand.id);
    let template = null;
    if (input.templateId) {
      template = templateById(input.templateId);
      if (!template) throw validation({ templateId: "Escolha um modelo da lista." });
    }
    const title = input.title ?? template?.title ?? null;
    if (!title) throw validation({ title: "Dê um título ao briefing." });
    const questions = normalizeQuestions(input.questions ?? template?.questions ?? []);
    const id = newId("brf");
    const at = now();
    db.tx(() => {
      db.run(
        `INSERT INTO briefings (id, brand_id, project_id, title, intro, questions, answers, status, due_date,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', 'draft', ?, ?, ?, ?)`,
        [id, brand.id, project?.id ?? null, title, input.intro ?? template?.intro ?? null, JSON.stringify(questions), input.dueDate ?? null, req.user.id, at, at],
      );
      logActivity(req, {
        action: "briefing.created",
        entityType: "briefing",
        entityId: id,
        brandId: brand.id,
        projectId: project?.id ?? null,
        summary: `Briefing "${title}" criado para ${brand.name}${template ? ` a partir do modelo ${template.name}` : ""}.`,
        data: template ? { templateId: template.id } : null,
      });
    });
    res.status(201).json({ briefing: detail(req, loadRow(db, id)) });
  });

  router.get("/api/briefings/:id", requireAuth, canView, (req, res) => {
    const row = assertBriefing(req, req.params.id);
    res.json({ briefing: detail(req, row) });
  });

  router.patch("/api/briefings/:id", requireAuth, canManage, (req, res) => {
    const row = assertBriefing(req, req.params.id);
    const input = parse(patchSchema, req.body);
    const sets = [];
    const params = [];
    const changed = [];
    const set = (column, value, field) => {
      sets.push(`${column} = ?`);
      params.push(value);
      changed.push(field);
    };
    if (input.questions !== undefined) {
      if (row.status === "submitted" || row.status === "reviewed")
        throw conflict("As respostas já foram enviadas. Reabra o briefing para alterar as perguntas.");
      set("questions", JSON.stringify(normalizeQuestions(input.questions)), "questions");
    }
    if (input.title !== undefined) set("title", input.title, "title");
    if (input.intro !== undefined) set("intro", input.intro, "intro");
    if (input.dueDate !== undefined) set("due_date", input.dueDate, "dueDate");
    if (input.projectId !== undefined) set("project_id", resolveProject(req, input.projectId, row.brand_id)?.id ?? null, "projectId");
    if (sets.length) {
      db.tx(() => {
        db.run(`UPDATE briefings SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...params, now(), row.id]);
        logActivity(req, {
          action: "briefing.updated",
          entityType: "briefing",
          entityId: row.id,
          brandId: row.brand_id,
          projectId: row.project_id,
          summary: `Briefing "${input.title ?? row.title}" atualizado.`,
          data: { fields: changed },
        });
      });
    }
    res.json({ briefing: detail(req, loadRow(db, row.id)) });
  });

  router.delete("/api/briefings/:id", requireAuth, canManage, (req, res) => {
    const row = assertBriefing(req, req.params.id);
    if (row.status !== "draft" && row.status !== "awaiting_client")
      throw conflict("Este briefing já tem respostas do cliente e não pode ser excluído.");
    db.tx(() => {
      db.run("DELETE FROM briefings WHERE id = ?", [row.id]);
      db.run("DELETE FROM notifications WHERE entity_type = 'briefing' AND entity_id = ?", [row.id]);
      logActivity(req, {
        action: "briefing.deleted",
        entityType: "briefing",
        entityId: row.id,
        brandId: row.brand_id,
        projectId: row.project_id,
        summary: `Briefing "${row.title}" excluído.`,
      });
    });
    res.status(204).end();
  });

  // draft -> awaiting_client (notifies the client); while the client has not
  // answered yet, sending again is a reminder.
  router.post("/api/briefings/:id/send", requireAuth, canManage, (req, res) => {
    const row = assertBriefing(req, req.params.id);
    if (row.status === "submitted" || row.status === "reviewed")
      throw conflict("O cliente já enviou as respostas deste briefing.");
    const questions = parseJson(row.questions, []);
    if (row.status === "draft") {
      if (!questions.length) throw validation({ questions: "Adicione pelo menos uma pergunta antes de enviar." }, "Adicione pelo menos uma pergunta antes de enviar.");
      normalizeQuestions(questions); // stored lists are always valid; re-check before the client sees it
    }
    const reminder = row.status !== "draft";
    const recipients = clientUserIds(db, row.client_id);
    const due = dateLabel(row.due_date);
    const at = now();
    let reach;
    db.tx(() => {
      if (!reminder)
        db.run("UPDATE briefings SET status = 'awaiting_client', sent_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'", [at, at, row.id]);
      const notices = notify(req, recipients, {
        type: reminder ? "briefing.reminder" : "briefing.sent",
        title: reminder ? `Lembrete: briefing "${row.title}"` : `Novo briefing: ${row.title}`,
        body: reminder
          ? `O briefing de ${row.brand_name} ainda aguarda suas respostas.${due ? ` Prazo: ${due}.` : ""}`
          : `A equipe Metta enviou um briefing para ${row.brand_name}.${due ? ` Prazo: ${due}.` : ""}`,
        link: `/painel/briefings/${row.id}`,
        entityType: "briefing",
        entityId: row.id,
        email: true,
        actionLabel: "Responder briefing",
        emailLines: [
          ["Marca", row.brand_name],
          ["Perguntas", String(questions.length)],
          ...(due ? [["Prazo", due]] : []),
          "As respostas ficam salvas automaticamente enquanto você preenche.",
        ],
      });
      reach = noticeReach(req, notices);
      logActivity(req, {
        action: reminder ? "briefing.reminded" : "briefing.sent",
        entityType: "briefing",
        entityId: row.id,
        brandId: row.brand_id,
        projectId: row.project_id,
        summary: reminder ? `Lembrete do briefing "${row.title}" enviado ao cliente.` : `Briefing "${row.title}" enviado para preenchimento.`,
        data: { recipients: recipients.length },
        visibility: reminder ? "internal" : "client",
      });
    });
    // recipients: client users notified; emailConfigured/emailRecipients say
    // whether an e-mail really goes out (never assumed by the interface).
    res.json({ briefing: detail(req, loadRow(db, row.id)), recipients: recipients.length, reminder, ...reach });
  });

  // Client answers: autosave (submit false) or final submission.
  router.put("/api/briefings/:id/answers", requireAuth, requireCap("portal.access"), (req, res) => {
    const row = assertBriefing(req, req.params.id);
    const input = parse(answersSchema, req.body);
    if (!OPEN_FOR_CLIENT.has(row.status))
      throw conflict(
        row.status === "reviewed" || row.status === "submitted"
          ? "Suas respostas já foram enviadas. Para alterar algo, fale com a equipe Metta."
          : "Este briefing não está aberto para respostas.",
      );
    const questions = parseJson(row.questions, []);
    const answers = cleanAnswers(questions, input.answers, { submit: input.submit });
    const at = now();
    db.tx(() => {
      const { changes } = db.run(
        `UPDATE briefings SET answers = ?, status = ?, updated_at = ?,
           submitted_at = CASE WHEN ? THEN ? ELSE submitted_at END,
           submitted_by = CASE WHEN ? THEN ? ELSE submitted_by END
         WHERE id = ? AND status IN ('awaiting_client', 'in_progress')`,
        [JSON.stringify(answers), input.submit ? "submitted" : "in_progress", at, input.submit, at, input.submit, req.user.id, row.id],
      );
      if (!changes) throw conflict();
      if (input.submit) {
        notify(req, staffFollowers(db, row), {
          type: "briefing.submitted",
          title: `Briefing respondido: ${row.title}`,
          body: `${req.user.name} (${row.client_name}) enviou as respostas.`,
          link: `/admin/briefings/${row.id}`,
          entityType: "briefing",
          entityId: row.id,
          email: true,
          actionLabel: "Ver respostas",
          emailLines: [
            ["Cliente", row.client_name],
            ["Marca", row.brand_name],
          ],
        });
        logActivity(req, {
          action: "briefing.submitted",
          entityType: "briefing",
          entityId: row.id,
          brandId: row.brand_id,
          projectId: row.project_id,
          summary: `${req.user.name} respondeu o briefing "${row.title}".`,
          visibility: "client",
        });
      }
    });
    res.json({ briefing: detail(req, loadRow(db, row.id)), savedAt: at });
  });

  router.post("/api/briefings/:id/review", requireAuth, canManage, (req, res) => {
    const row = assertBriefing(req, req.params.id);
    if (row.status !== "submitted") throw conflict("Só é possível revisar um briefing respondido.");
    const at = now();
    db.tx(() => {
      db.run("UPDATE briefings SET status = 'reviewed', reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?", [at, req.user.id, at, row.id]);
      logActivity(req, {
        action: "briefing.reviewed",
        entityType: "briefing",
        entityId: row.id,
        brandId: row.brand_id,
        projectId: row.project_id,
        summary: `Briefing "${row.title}" revisado pela equipe Metta.`,
        visibility: "client",
      });
    });
    res.json({ briefing: detail(req, loadRow(db, row.id)) });
  });

  router.post("/api/briefings/:id/reopen", requireAuth, canManage, (req, res) => {
    const row = assertBriefing(req, req.params.id);
    if (row.status !== "submitted" && row.status !== "reviewed")
      throw conflict("Só é possível reabrir um briefing que já foi respondido.");
    const { message } = parse(reopenSchema, req.body ?? {});
    const at = now();
    db.tx(() => {
      db.run(
        `UPDATE briefings SET status = 'in_progress', submitted_at = NULL, submitted_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL, updated_at = ? WHERE id = ?`,
        [at, row.id],
      );
      notify(req, clientUserIds(db, row.client_id), {
        type: "briefing.reopened",
        title: `Briefing reaberto: ${row.title}`,
        body: message ?? "A equipe Metta reabriu o briefing para você revisar ou completar as respostas.",
        link: `/painel/briefings/${row.id}`,
        entityType: "briefing",
        entityId: row.id,
        email: true,
        actionLabel: "Abrir briefing",
      });
      logActivity(req, {
        action: "briefing.reopened",
        entityType: "briefing",
        entityId: row.id,
        brandId: row.brand_id,
        projectId: row.project_id,
        summary: `Briefing "${row.title}" reaberto para ajustes do cliente.`,
        data: message ? { message } : null,
        visibility: "client",
      });
    });
    res.json({ briefing: detail(req, loadRow(db, row.id)) });
  });

  return router;
}
