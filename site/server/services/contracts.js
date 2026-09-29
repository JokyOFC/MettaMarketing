// Contracts for acquisitions (monthly plans and one-off services such as
// brand identity), signed through AssinaVelox.
//
// Flow: the team previews and sends a contract for an order or subscription →
// Metta renders the PDF from the current template version → a background job
// creates the envelope on AssinaVelox (upload, recipients, fields, send) with
// idempotency keys and state checks, so a retry never duplicates anything →
// the client signs inside the portal (embedded widget) or through the e-mail
// invitation, then the Metta representative signs → webhooks and a periodic
// sync read the envelope from the API (the source of truth) → on completion
// the final PDF and the evidence page are stored privately and, when the
// setting is on, payment is released.
import { randomUUID } from "node:crypto";
import { conflict, HttpError, notConfigured, notFound, validation } from "../lib/errors.js";
import { logActivity } from "../lib/audit.js";
import { newId } from "../lib/ids.js";
import { adminIds, clientUserIds, notify } from "../lib/notify.js";
import { isStaff, parseJson } from "../lib/serialize.js";
import { getSetting, setSetting } from "../lib/settings.js";
import { now } from "../lib/time.js";
import { appOrigin, avCall, isConfigured, MESSAGES as AV_MESSAGES, widgetOrigin } from "./assinavelox.js";
import { renderContractPdf } from "./contractPdf.js";
import {
  DEFAULT_TEMPLATES,
  fillTemplate,
  inspectTemplate,
  KIND_LABELS,
  KINDS,
  moneyInWords,
  parseBlocks,
  VARIABLES,
} from "./contractTemplates.js";

export const CONTRACT_STATUSES = ["draft", "sending", "sent", "completed", "refused", "expired", "canceled", "failed"];
const OPEN_STATUSES = ["sending", "sent", "failed"];

// ------------------------------------------------------------------ settings

const SETTINGS_KEY = "contracts.config";

export const CONTRACT_DEFAULTS = {
  signerName: "",
  signerEmail: "",
  signerRole: "Representante legal",
  companyName: "METTA MARKETING LTDA",
  companyDocument: "68.562.250/0001-59",
  forum: "",
  noticeDays: 30,
  expiresInDays: 15,
  requiredBeforePayment: true,
};

export async function contractSettings(db) {
  const stored = await getSetting(db, SETTINGS_KEY, null);
  return { ...CONTRACT_DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
}

export async function saveContractSettings(req, patch) {
  const { db } = req.ctx;
  const next = { ...await contractSettings(db), ...patch };
  await db.tx(async () => {
    await setSetting(db, SETTINGS_KEY, next, req.user.id);
    await logActivity(req, {
      action: "contracts.settings_updated",
      entityType: "settings",
      entityId: SETTINGS_KEY,
      summary: `${req.user.name} atualizou as configurações de contratos`,
      data: { fields: Object.keys(patch) },
    });
  });
  return next;
}

/** Missing settings that block sending, as pt-BR sentences. */
export function settingsIssues(settings) {
  const issues = [];
  if (!settings.signerName || !settings.signerEmail) issues.push("Defina quem assina pela Metta (nome e e-mail).");
  if (!settings.forum) issues.push("Defina o foro do contrato (cidade/UF).");
  if (!settings.companyName || !settings.companyDocument) issues.push("Defina a razão social e o CNPJ da Metta.");
  return issues;
}

// ------------------------------------------------------------------ templates

export async function ensureDefaultTemplates(db) {
  for (const kind of KINDS) {
    const exists = await db.get("SELECT 1 FROM contract_template_versions WHERE kind = ? LIMIT 1", [kind]);
    if (exists) continue;
    await db.run(
      `INSERT INTO contract_template_versions (id, kind, version, title, body, created_by, created_at)
       VALUES (?, ?, 1, ?, ?, NULL, ?)`,
      [newId("ctv"), kind, DEFAULT_TEMPLATES[kind].title, DEFAULT_TEMPLATES[kind].body, now()],
    );
  }
}

export async function currentTemplate(db, kind) {
  await ensureDefaultTemplates(db);
  return await db.get(
    `SELECT t.*, u.name AS author_name FROM contract_template_versions t
      LEFT JOIN users u ON u.id = t.created_by
      WHERE t.kind = ? ORDER BY t.version DESC LIMIT 1`,
    [kind],
  );
}

export function serializeTemplate(row) {
  const { used, unknown } = inspectTemplate(`${row.title}\n${row.body}`);
  return {
    kind: row.kind,
    label: KIND_LABELS[row.kind],
    version: row.version,
    title: row.title,
    body: row.body,
    // The initial model ships with the platform: someone at Metta must review
    // and save it (with legal advice) before the first contract goes out.
    reviewed: Boolean(row.created_by),
    updatedAt: row.created_at,
    updatedBy: row.author_name ?? null,
    variables: { used, unknown },
  };
}

export async function saveTemplate(req, kind, { title, body }) {
  const { db } = req.ctx;
  if (!KINDS.includes(kind)) throw notFound("Modelo de contrato não encontrado.");
  const { unknown } = inspectTemplate(`${title}\n${body}`);
  if (unknown.length)
    throw validation({
      body: `Variáveis desconhecidas: ${unknown.map((v) => `{{${v}}}`).join(", ")}. Use as variáveis da lista.`,
    });
  const current = await currentTemplate(db, kind);
  if (current.title === title && current.body === body && current.created_by) return current;
  const id = newId("ctv");
  await db.tx(async () => {
    await db.run(
      `INSERT INTO contract_template_versions (id, kind, version, title, body, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, kind, current.version + 1, title, body, req.user.id, now()],
    );
    await logActivity(req, {
      action: "contracts.template_saved",
      entityType: "contract_template",
      entityId: id,
      summary: `${req.user.name} salvou a versão ${current.version + 1} do modelo de contrato (${KIND_LABELS[kind]})`,
    });
  });
  return await currentTemplate(db, kind);
}

// ------------------------------------------------------------------ helpers

const SP_OFFSET_MS = 3 * 60 * 60 * 1000;
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export const formatMoney = (cents) => brl.format(Number(cents || 0) / 100).replace(/ /g, " ");

export function longDate(value = new Date()) {
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00Z`)
    : new Date(new Date(value).getTime() - SP_OFFSET_MS);
  return `${date.getUTCDate()} de ${MONTHS[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
}

/** Short human code printed on the contract: CT-XXXXXXXX. */
export function contractCode(id) {
  const letters = String(id).slice(4).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `CT-${letters.slice(0, 8).padEnd(8, "0")}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function financeAndAdminIds(db) {
  return [
    ...new Set([
      ...await adminIds(db),
      ...(await db.all("SELECT id FROM users WHERE role = 'finance' AND status = 'active'")).map((row) => row.id),
    ]),
  ];
}

async function userIdByEmail(db, email) {
  return email ? ((await db.get("SELECT id FROM users WHERE email = ? AND status = 'active'", [email]))?.id ?? null) : null;
}

// ------------------------------------------------------------------ source (order / subscription)

/**
 * Loads what a contract is about. -> { kind, client, brand, service, order,
 * subscription, amountCents, description, dueDate }
 */
export async function loadSource(db, { orderId, subscriptionId, brandId }) {
  if (Boolean(orderId) === Boolean(subscriptionId)) throw validation({ source: "Informe o pedido ou a assinatura." });
  if (orderId) {
    const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
    if (!order) throw notFound("Não encontramos este pedido.");
    const service = order.service_id ? await db.get("SELECT * FROM services WHERE id = ?", [order.service_id]) : null;
    const client = await db.get("SELECT * FROM clients WHERE id = ?", [order.client_id]);
    const brand =
      (order.brand_id && await db.get("SELECT * FROM brands WHERE id = ?", [order.brand_id])) ||
      await db.get("SELECT * FROM brands WHERE client_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", [client.id]);
    return {
      kind: "one_off",
      client,
      brand: brand ?? null,
      service,
      order,
      subscription: null,
      amountCents: order.amount_cents,
      description: order.description,
      dueDate: order.due_date ?? null,
      status: order.status,
      waived: Boolean(order.contract_waived_at),
    };
  }
  const subscription = await db.get("SELECT * FROM subscriptions WHERE id = ?", [subscriptionId]);
  if (!subscription) throw notFound("Não encontramos esta assinatura.");
  const service = await db.get("SELECT * FROM services WHERE id = ?", [subscription.service_id]);
  const client = await db.get("SELECT * FROM clients WHERE id = ?", [subscription.client_id]);
  let brand = null;
  if (brandId) {
    brand = await db.get("SELECT * FROM brands WHERE id = ?", [brandId]);
    if (!brand || brand.client_id !== client.id) throw validation({ brandId: "Esta marca não pertence ao cliente." });
  } else brand = await db.get("SELECT * FROM brands WHERE client_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", [client.id]);
  return {
    kind: "subscription",
    client,
    brand: brand ?? null,
    service,
    order: null,
    subscription,
    amountCents: subscription.amount_cents,
    description: service?.name ?? "Plano",
    dueDate: null,
    status: subscription.status,
    waived: Boolean(subscription.contract_waived_at),
  };
}

function buildValues({ source, settings, signer, code, issuedAt }) {
  const { client, brand, service, kind } = source;
  return {
    contrato_codigo: code,
    data: longDate(issuedAt),
    contratante_nome: client.legal_name || client.name,
    contratante_documento: client.document || "—",
    representante_nome: signer.name,
    representante_email: signer.email,
    marca: brand?.name ?? client.name,
    servico: service?.name ?? source.description,
    descricao: source.description,
    itens: parseJson(service?.items, []),
    valor: formatMoney(source.amountCents),
    valor_por_extenso: moneyInWords(source.amountCents),
    periodicidade: kind === "subscription" ? "mensal" : "pagamento único",
    vencimento: source.dueDate ? longDate(source.dueDate) : "na data indicada no link de pagamento",
    aviso_previo_dias: String(settings.noticeDays ?? 30),
    contratada_nome: settings.companyName,
    contratada_documento: settings.companyDocument,
    contratada_representante: settings.signerName || "—",
    foro: settings.forum || "—",
  };
}

async function renderFor({ template, source, settings, signer, code, issuedAt, preview }) {
  const values = buildValues({ source, settings, signer, code, issuedAt });
  const subtitle = source.kind === "subscription" ? `Plano ${values.servico}` : values.servico;
  const pdf = await renderContractPdf({
    title: fillTemplate(template.title, values),
    subtitle,
    code,
    issuedAt: values.data,
    blocks: parseBlocks(fillTemplate(template.body, values)),
    parties: {
      client: { name: signer.name, label: `CONTRATANTE · ${values.contratante_nome}` },
      metta: { name: settings.signerName || "Representante da Metta", label: `CONTRATADA · ${settings.companyName}` },
    },
    preview,
    footer: `${settings.companyName} · CNPJ ${settings.companyDocument}`,
  });
  return { ...pdf, values, title: fillTemplate(template.title, values) };
}

/** Example PDF for the template editor (sample data, "Exemplo" banner). */
export async function renderTemplateExample(db, kind, override = null) {
  if (!KINDS.includes(kind)) throw notFound("Modelo de contrato não encontrado.");
  const template = override ?? await currentTemplate(db, kind);
  const settings = await contractSettings(db);
  const sample = Object.fromEntries(VARIABLES.map((v) => [v.key, v.example]));
  const source = {
    kind,
    client: { name: "Cliente de exemplo", legal_name: sample.contratante_nome, document: sample.contratante_documento },
    brand: { name: sample.marca },
    service: {
      name: kind === "subscription" ? sample.servico : "Identidade visual",
      items: JSON.stringify(["Item do serviço conforme o catálogo", "Outro item do serviço"]),
    },
    amountCents: kind === "subscription" ? 300000 : 200000,
    description: kind === "subscription" ? sample.servico : "Identidade visual",
    dueDate: null,
  };
  const out = await renderFor({
    template,
    source,
    settings,
    signer: { name: sample.representante_nome, email: sample.representante_email },
    code: "CT-EXEMPLO0",
    issuedAt: new Date().toISOString(),
    preview: "Exemplo",
  });
  return out.bytes;
}

// ------------------------------------------------------------------ gate (payment)

/**
 * Whether payment must wait for the contract. Only enforced when the
 * integration is configured and the setting is on; a waiver lifts it.
 */
export async function contractGate(ctx, { orderId = null, subscriptionId = null, waived = false } = {}) {
  const { db, config } = ctx;
  const settings = await contractSettings(db);
  const contract = await latestContract(db, { orderId, subscriptionId });
  const required = Boolean(settings.requiredBeforePayment) && isConfigured(config) && !waived;
  const satisfied = !required || contract?.status === "completed";
  return { required, satisfied, waived, contract };
}

export async function latestContract(db, { orderId = null, subscriptionId = null }) {
  if (orderId) return await db.get("SELECT * FROM contracts WHERE order_id = ? ORDER BY created_at DESC LIMIT 1", [orderId]);
  if (subscriptionId)
    return await db.get("SELECT * FROM contracts WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 1", [subscriptionId]);
  return null;
}

// ------------------------------------------------------------------ serialization

const STATUS_LABELS = {
  draft: "Rascunho",
  sending: "Preparando envio",
  sent: "Aguardando assinaturas",
  completed: "Concluído",
  refused: "Recusado",
  expired: "Expirado",
  canceled: "Cancelado",
  failed: "Falha no envio",
};

const SIGNER_LABELS = {
  pending: "Pendente",
  notified: "Convite enviado",
  viewed: "Convite aberto",
  signed: "Aceite registrado",
  approved: "Aprovado",
  refused: "Recusou",
  expired: "Expirado",
  canceled: "Cancelado",
  delegated: "Delegou",
};

function signerView(row, role, req) {
  const prefix = role === "client" ? "client" : "metta";
  const email = row[`${prefix}_signer_email`];
  const view = {
    role,
    name: row[`${prefix}_signer_name`],
    status: row[`${prefix}_status`] ?? (row.status === "sent" ? "pending" : null),
    statusLabel: SIGNER_LABELS[row[`${prefix}_status`]] ?? (row.status === "sent" ? "Pendente" : null),
    signedAt: row[`${prefix}_signed_at`] ?? null,
  };
  if (isStaff(req) || role === "client") view.email = email;
  if (req?.user) view.isYou = Boolean(email) && String(email).toLowerCase() === String(req.user.email ?? "").toLowerCase();
  // Only one open signature at a time (sequential order): client first.
  const clientDone = ["signed", "approved"].includes(row.client_status);
  view.turn = row.status === "sent" && (role === "client" ? !clientDone : clientDone && !["signed", "approved"].includes(row.metta_status));
  return view;
}

export function serializeContract(req, row) {
  const staff = isStaff(req);
  const contract = {
    id: row.id,
    code: contractCode(row.id),
    kind: row.kind,
    kindLabel: KIND_LABELS[row.kind],
    title: row.title,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    providerStatusLabel: row.provider_status_label ?? null,
    signatureStatusLabel: row.signature_status_label ?? null,
    displayCode: row.display_code ?? null,
    verificationCode: row.verification_code ?? null,
    orderId: row.order_id ?? null,
    subscriptionId: row.subscription_id ?? null,
    client: { id: row.client_id, name: row.client_name ?? null },
    brand: row.brand_id ? { id: row.brand_id, name: row.brand_name ?? null } : null,
    signers: [signerView(row, "client", req), signerView(row, "metta", req)],
    refusalReason: row.status === "refused" ? (row.refusal_reason ?? null) : null,
    files: {
      original: Boolean(row.document_key),
      signed: Boolean(row.signed_key),
      evidence: Boolean(row.evidence_key),
    },
    sentAt: row.sent_at ?? null,
    expiresAt: row.expires_at ?? null,
    completedAt: row.completed_at ?? null,
    refusedAt: row.refused_at ?? null,
    expiredAt: row.expired_at ?? null,
    canceledAt: row.canceled_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (staff) {
    contract.envelopeId = row.envelope_id ?? null;
    contract.step = row.step ?? null;
    contract.error = row.status === "failed" ? (row.error ?? null) : null;
    contract.attempts = row.attempts;
    contract.cancelReason = row.cancel_reason ?? null;
    contract.lastSyncedAt = row.last_synced_at ?? null;
    contract.documentPages = row.document_pages ?? null;
    contract.createdBy = row.creator_name ? { name: row.creator_name } : null;
  }
  return contract;
}

export const CONTRACT_SELECT = `SELECT ct.*, c.name AS client_name, b.name AS brand_name, u.name AS creator_name
  FROM contracts ct
  JOIN clients c ON c.id = ct.client_id
  LEFT JOIN brands b ON b.id = ct.brand_id
  LEFT JOIN users u ON u.id = ct.created_by`;

export const getContractRow = async (db, id) => (id ? await db.get(`${CONTRACT_SELECT} WHERE ct.id = ?`, [id]) : null);

// ------------------------------------------------------------------ create & preview

async function resolveSigner(db, source, signer) {
  if (signer?.userId) {
    const user = await db.get("SELECT * FROM users WHERE id = ? AND client_id = ? AND status = 'active'", [signer.userId, source.client.id]);
    if (!user) throw validation({ signer: "Escolha uma pessoa ativa deste cliente." });
    return { name: user.name, email: user.email.toLowerCase(), userId: user.id };
  }
  const name = String(signer?.name ?? "").trim();
  const email = String(signer?.email ?? "").trim().toLowerCase();
  const fields = {};
  if (name.length < 2) fields["signer.name"] = "Informe o nome de quem assina pelo cliente.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields["signer.email"] = "Informe um e-mail válido.";
  if (Object.keys(fields).length) throw validation(fields);
  const user = await db.get("SELECT id FROM users WHERE email = ? AND client_id = ? AND status = 'active'", [email, source.client.id]);
  return { name, email, userId: user?.id ?? null };
}

function assertSendable(ctx, source, settings, templateRow) {
  if (!isConfigured(ctx.config)) throw notConfigured(AV_MESSAGES.notConfigured);
  const issues = settingsIssues(settings);
  if (issues.length) throw conflict(`${issues.join(" ")} Ajuste em Configurações › Contratos.`);
  if (!templateRow.created_by)
    throw conflict("Revise e salve o modelo de contrato em Configurações › Contratos antes do primeiro envio.");
  if (source.order && !["draft", "pending_payment", "failed"].includes(source.status))
    throw conflict("Este pedido já foi pago ou encerrado; não precisa de contrato novo.");
  if (source.subscription && !["pending", "active", "paused", "failed"].includes(source.status))
    throw conflict("Esta assinatura está cancelada.");
  if (source.client.status === "archived") throw conflict("Este cliente está arquivado.");
}

export async function previewContract(req, { orderId, subscriptionId, brandId, signer }) {
  const { db } = req.ctx;
  const source = await loadSource(db, { orderId, subscriptionId, brandId });
  const settings = await contractSettings(db);
  const template = await currentTemplate(db, source.kind);
  const resolved = await resolveSigner(db, source, signer);
  const out = await renderFor({
    template,
    source,
    settings,
    signer: resolved,
    code: "CT-PREVIA00",
    issuedAt: new Date().toISOString(),
    preview: "Pré-visualização",
  });
  return out.bytes;
}

/**
 * Creates the contract row (status 'sending') and queues the sending job.
 * The PDF is rendered here, so a template edit made afterwards never changes
 * what this client receives.
 */
export async function createContract(req, { orderId, subscriptionId, brandId, signer, expiresInDays }) {
  const { ctx, user } = req;
  const { db, storage } = ctx;
  const source = await loadSource(db, { orderId, subscriptionId, brandId });
  const settings = await contractSettings(db);
  const template = await currentTemplate(db, source.kind);
  assertSendable(ctx, source, settings, template);
  const open = await latestContract(db, { orderId, subscriptionId });
  if (open && ["sending", "sent", "failed"].includes(open.status))
    throw conflict("Já existe um contrato em andamento para este item. Cancele-o antes de enviar outro.");
  if (open?.status === "completed") throw conflict("O contrato deste item já foi concluído.");

  const resolved = await resolveSigner(db, source, signer);
  if (resolved.email === String(settings.signerEmail).toLowerCase())
    throw validation({ "signer.email": "Quem assina pelo cliente precisa ser outra pessoa, diferente do representante da Metta." });

  const id = newId("ctr");
  const code = contractCode(id);
  const issuedAt = now();
  const out = await renderFor({ template, source, settings, signer: resolved, code, issuedAt, preview: null });
  const stored = await storage.putBuffer(Buffer.from(out.bytes));
  const days = Math.min(90, Math.max(1, Number(expiresInDays) || settings.expiresInDays || 15));
  const data = {
    values: { ...out.values, itens: out.values.itens },
    fields: out.fields,
    templateVersion: template.version,
  };
  try {
    await db.tx(async () => {
      // One live contract per order/subscription: checked again inside the
      // transaction (transactions run one at a time) to close the race window.
      const live = await latestContract(db, { orderId, subscriptionId });
      if (live && ["sending", "sent", "failed", "completed"].includes(live.status))
        throw conflict("Já existe um contrato em andamento para este item. Atualize a página.");
      await db.run(
        `INSERT INTO contracts (id, client_id, brand_id, order_id, subscription_id, kind, template_version_id, title, status,
           client_signer_name, client_signer_email, client_signer_user_id, metta_signer_name, metta_signer_email,
           expires_in_days, document_key, document_sha256, document_size, document_pages, data, step,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        [
          id,
          source.client.id,
          source.brand?.id ?? null,
          source.order?.id ?? null,
          source.subscription?.id ?? null,
          source.kind,
          template.id,
          `${out.title} — ${source.description}`,
          resolved.name,
          resolved.email,
          resolved.userId,
          settings.signerName,
          String(settings.signerEmail).toLowerCase(),
          days,
          stored.key,
          stored.sha256,
          stored.size,
          out.pages,
          JSON.stringify(data),
          user.id,
          issuedAt,
          issuedAt,
        ],
      );
      await logActivity(req, {
        action: "contract.created",
        entityType: "contract",
        entityId: id,
        clientId: source.client.id,
        brandId: source.brand?.id ?? null,
        summary: `${user.name} gerou o contrato ${code} (${source.description}) para assinatura de ${resolved.name}`,
        data: { orderId: source.order?.id ?? null, subscriptionId: source.subscription?.id ?? null, templateVersion: template.version },
      });
    });
  } catch (err) {
    await storage.remove(stored.key).catch(() => {});
    if (err?.code === "ER_DUP_ENTRY") throw conflict("Já existe um contrato em andamento para este item. Atualize a página.");
    throw err;
  }
  ctx.jobs?.enqueue("contracts.send", { contractId: id });
  return await getContractRow(db, id);
}

// ------------------------------------------------------------------ sending (job)

const DOCUMENT_WAIT_MS = 90_000;

async function update(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.run(`UPDATE contracts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [
    ...keys.map((k) => fields[k]),
    now(),
    id,
  ]);
}

async function readStored(storage, key) {
  const chunks = [];
  for await (const chunk of storage.createReadStream(key)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Runs (or resumes) the sending steps. Each step checks the envelope state
 * first, and creations carry idempotency keys, so a retry after a crash or an
 * API failure never creates a second envelope or sends twice.
 */
export async function runSend(ctx, contractId) {
  const { db, storage } = ctx;
  let row = await db.get("SELECT * FROM contracts WHERE id = ?", [contractId]);
  if (!row || row.status !== "sending") return row;
  const code = contractCode(row.id);
  const data = parseJson(row.data, {});
  const step = async (name) => await update(db, row.id, { step: name });

  try {
    // 1. envelope
    let envelopeId = row.envelope_id;
    if (!envelopeId) {
      await step("envelope");
      const envelope = await avCall(ctx, "a criação do contrato", (client) =>
        client.createEnvelope(
          {
            title: `${code} · ${row.title}`.slice(0, 160),
            message:
              "A Metta Marketing enviou este contrato para a sua assinatura. Você também pode assinar pela área do cliente da plataforma Metta.",
            signing_order: "sequential",
            expires_in_days: row.expires_in_days,
            send_copy_to_all: true,
          },
          { idempotencyKey: `metta-${row.id}-envelope` },
        ),
      );
      envelopeId = envelope.id;
      await update(db, row.id, { envelope_id: envelopeId, display_code: envelope.display_code ?? null });
    }

    let envelope = await avCall(ctx, "a consulta do contrato", (client) => client.getEnvelope(envelopeId));
    const alreadySent = !["draft", "preparing", "ready"].includes(envelope.status);

    if (!alreadySent) {
      // 2. document
      if (!envelope.documents?.length) {
        await step("document");
        const bytes = await readStored(storage, row.document_key);
        await avCall(ctx, "o envio do PDF do contrato", (client) =>
          client.uploadDocument(
            envelopeId,
            { content: bytes, filename: `contrato-${code}.pdf`, contentType: "application/pdf" },
            { idempotencyKey: `metta-${row.id}-document` },
          ),
        );
      }
      await step("processing");
      const started = Date.now();
      let waitMs = 600;
      for (;;) {
        envelope = await avCall(ctx, "a consulta do contrato", (client) => client.getEnvelope(envelopeId));
        const doc = envelope.documents?.[0];
        if (doc?.ready) break;
        if (doc && ["failed", "blocked"].includes(doc.processing_status))
          throw new HttpError(
            502,
            "upstream_error",
            `A AssinaVelox não conseguiu processar o PDF do contrato${doc.failure?.message ? `: ${doc.failure.message}` : "."}`,
          );
        if (Date.now() - started > DOCUMENT_WAIT_MS)
          throw new HttpError(502, "upstream_error", "A AssinaVelox ainda está processando o PDF do contrato. Tente de novo em alguns minutos.");
        await sleep(waitMs);
        waitMs = Math.min(3000, Math.round(waitMs * 1.5));
      }
      const documentId = envelope.documents[0].id;

      // 3. recipients (client first, then Metta)
      await step("recipients");
      const recipients = await avCall(ctx, "a definição de quem assina", (client) =>
        client.syncRecipients(
          envelopeId,
          {
            signing_order: "sequential",
            recipients: [
              { name: row.client_signer_name, email: row.client_signer_email, order: 1, role: "Contratante" },
              { name: row.metta_signer_name, email: row.metta_signer_email, order: 2, role: "Contratada" },
            ],
          },
          { idempotencyKey: `metta-${row.id}-recipients` },
        ),
      );
      const byOrder = new Map(recipients.map((r) => [Number(r.order), r]));
      const clientRecipient = byOrder.get(1);
      const mettaRecipient = byOrder.get(2);
      if (!clientRecipient || !mettaRecipient)
        throw new HttpError(502, "upstream_error", "A AssinaVelox não devolveu os participantes do contrato.");
      await update(db, row.id, { client_recipient_id: clientRecipient.id, metta_recipient_id: mettaRecipient.id });

      // 4. fields
      await step("fields");
      const recipientFor = { client: clientRecipient.id, metta: mettaRecipient.id };
      await avCall(ctx, "o posicionamento das assinaturas", (client) =>
        client.syncFields(
          envelopeId,
          {
            fields: (data.fields ?? []).map((field) => ({
              type: field.type,
              page: field.page,
              x: field.x,
              y: field.y,
              w: field.w,
              h: field.h,
              required: true,
              recipient_id: recipientFor[field.signer],
              document_id: documentId,
              label: field.type === "signature" ? "Assinatura" : "Data do aceite",
              ...(field.type === "date" ? { options: { date_format: "d/m/Y", font_size: 8 } } : {}),
            })),
          },
          { idempotencyKey: `metta-${row.id}-fields` },
        ),
      );

      // 5. send
      await step("send");
      const sent = await avCall(ctx, "o envio para assinatura", (client) =>
        client.sendEnvelope(envelopeId, { idempotencyKey: `metta-${row.id}-send` }),
      );
      envelope = sent.data ?? envelope;
    }

    // Final state from the API.
    envelope = await avCall(ctx, "a consulta do contrato", (client) => client.getEnvelope(envelopeId));
    const transitions = await applyEnvelope(ctx, row.id, envelope, { initial: true });
    row = await db.get("SELECT * FROM contracts WHERE id = ?", [row.id]);
    if (row.status === "sending") await update(db, row.id, { status: "sent", sent_at: envelope.sent_at ?? now(), step: null, error: null });
    row = await getContractRow(db, row.id);
    await announceSent(ctx, row);
    // Resumed long after the fact: the envelope may already be finished.
    if (transitions.length) {
      if (row.status === "completed") await downloadFinalFiles(ctx, row).catch(() => {});
      await announceTransitions(ctx, await getContractRow(db, row.id), transitions);
    }
    return await getContractRow(db, row.id);
  } catch (err) {
    const message = err instanceof HttpError ? err.message : AV_MESSAGES.unavailable;
    if (!(err instanceof HttpError)) ctx.log?.error?.("[contracts] sending failed:", err);
    await db.tx(async () => {
      await update(db, row.id, { status: "failed", error: message, attempts: (row.attempts ?? 0) + 1 });
      await logActivity(ctx, {
        action: "contract.send_failed",
        entityType: "contract",
        entityId: row.id,
        clientId: row.client_id,
        brandId: row.brand_id,
        summary: `O envio do contrato ${code} para a AssinaVelox falhou: ${message}`,
        data: { step: (await db.get("SELECT step FROM contracts WHERE id = ?", [row.id]))?.step ?? null },
      });
      if (row.created_by)
        await notify(ctx, [row.created_by], {
          type: "contract.failed",
          title: "O contrato não foi enviado",
          body: `${code}: ${message}`,
          link: contractStaffLink(row),
          entityType: "contract",
          entityId: row.id,
        });
    });
    return await db.get("SELECT * FROM contracts WHERE id = ?", [row.id]);
  }
}

export async function retryContract(req, row) {
  if (row.status !== "failed") throw conflict("Só contratos com falha no envio podem ser reenviados.");
  if (!isConfigured(req.ctx.config)) throw notConfigured(AV_MESSAGES.notConfigured);
  await req.ctx.db.tx(async () => {
    await update(req.ctx.db, row.id, { status: "sending", error: null, step: "queued" });
    await logActivity(req, {
      action: "contract.retry",
      entityType: "contract",
      entityId: row.id,
      clientId: row.client_id,
      summary: `${req.user.name} tentou enviar de novo o contrato ${contractCode(row.id)}`,
    });
  });
  req.ctx.jobs?.enqueue("contracts.send", { contractId: row.id });
  return await getContractRow(req.ctx.db, row.id);
}

function contractStaffLink(row) {
  return row.order_id ? `/admin/pedidos?pedido=${row.order_id}` : `/admin/pedidos?assinatura=${row.subscription_id}`;
}

async function announceSent(ctx, row) {
  if (row.status !== "sent" || row.step === "announced") return;
  const { db } = ctx;
  const code = contractCode(row.id);
  await db.tx(async () => {
    await update(db, row.id, { step: "announced" });
    await logActivity(ctx, {
      action: "contract.sent",
      entityType: "contract",
      entityId: row.id,
      clientId: row.client_id,
      brandId: row.brand_id,
      summary: `Contrato ${code} enviado para assinatura de ${row.client_signer_name}`,
      visibility: "client",
    });
    await notify(ctx, await clientUserIds(db, row.client_id), {
      type: "contract.sent",
      title: "Contrato disponível para assinatura",
      body: `${row.title}. Assine pela área Financeiro da plataforma ou pelo e-mail da AssinaVelox enviado a ${row.client_signer_name}.`,
      link: "/painel/financeiro#contratos",
      entityType: "contract",
      entityId: row.id,
      email: true,
      emailLines: [
        ["Contrato", code],
        ["Quem assina", `${row.client_signer_name} (${row.client_signer_email})`],
      ],
      actionLabel: "Ver e assinar",
    });
  });
}

// ------------------------------------------------------------------ sync

const SIGNED = new Set(["signed", "approved"]);

function mapStatus(envelopeStatus) {
  switch (envelopeStatus) {
    case "in_progress":
    case "finalizing":
      return "sent";
    case "completed":
      return "completed";
    case "refused":
      return "refused";
    case "expired":
      return "expired";
    case "canceled":
      return "canceled";
    default:
      return null; // draft / preparing / ready: still being prepared
  }
}

/**
 * Applies an envelope read from the API. Returns the list of transitions
 * ('client_signed', 'metta_signed', 'completed', 'refused', 'expired',
 * 'canceled') so the caller can notify once.
 */
export async function applyEnvelope(ctx, contractId, envelope, { initial = false } = {}) {
  const { db } = ctx;
  const row = await db.get("SELECT * FROM contracts WHERE id = ?", [contractId]);
  if (!row) return [];
  const transitions = [];
  const fields = {
    last_synced_at: now(),
    display_code: envelope.display_code ?? row.display_code,
    verification_code: envelope.verification_code ?? row.verification_code,
    provider_status_label: envelope.status_label ?? row.provider_status_label,
    signature_status: envelope.signature_status ?? row.signature_status,
    signature_status_label: envelope.signature_status_label ?? row.signature_status_label,
    expires_at: envelope.expires_at ?? row.expires_at,
  };
  if (envelope.sent_at && !row.sent_at) fields.sent_at = envelope.sent_at;

  for (const recipient of envelope.recipients ?? []) {
    const prefix =
      recipient.id === row.client_recipient_id ? "client" : recipient.id === row.metta_recipient_id ? "metta" : null;
    if (!prefix) continue;
    const before = row[`${prefix}_status`];
    fields[`${prefix}_status`] = recipient.status;
    fields[`${prefix}_signed_at`] = recipient.signed_at ?? row[`${prefix}_signed_at`];
    if (recipient.status === "refused" && recipient.refusal_reason) fields.refusal_reason = recipient.refusal_reason;
    if (SIGNED.has(recipient.status) && !SIGNED.has(before) && !initial) transitions.push(`${prefix}_signed`);
  }

  const next = mapStatus(envelope.status);
  if (next && next !== row.status && !(row.status === "sending" && next === "sent")) {
    if (["completed", "refused", "expired", "canceled"].includes(next)) {
      fields.status = next;
      fields.step = null;
      fields.error = null;
      if (next === "completed") fields.completed_at = envelope.completed_at ?? now();
      if (next === "refused") fields.refused_at = envelope.refused_at ?? now();
      if (next === "expired") fields.expired_at = envelope.expired_at ?? now();
      if (next === "canceled") fields.canceled_at = envelope.canceled_at ?? now();
      transitions.push(next);
    } else if (next === "sent" && ["failed"].includes(row.status)) {
      fields.status = "sent";
      fields.error = null;
    }
  }
  await update(db, row.id, fields);
  return transitions;
}

async function downloadFinalFiles(ctx, row) {
  const { db, storage } = ctx;
  const updates = {};
  if (!row.signed_key) {
    const file = await avCall(ctx, "o download do contrato assinado", (client) => client.downloadFile(row.envelope_id, "signed"));
    const stored = await storage.putBuffer(Buffer.from(file.content));
    Object.assign(updates, { signed_key: stored.key, signed_sha256: stored.sha256, signed_size: stored.size });
  }
  if (!row.evidence_key) {
    try {
      const file = await avCall(ctx, "o download das evidências", (client) => client.downloadFile(row.envelope_id, "evidence"));
      const stored = await storage.putBuffer(Buffer.from(file.content));
      Object.assign(updates, { evidence_key: stored.key, evidence_size: stored.size });
    } catch (err) {
      // Some installations append the evidence page to the signed file only.
      if (err?.avStatus !== 404) throw err;
    }
  }
  if (Object.keys(updates).length) await update(db, row.id, updates);
}

/** Reads the envelope from AssinaVelox and applies it (webhook, job, button). */
export async function syncContract(ctx, contractId, { source = "sync" } = {}) {
  const { db } = ctx;
  const row = await db.get("SELECT * FROM contracts WHERE id = ?", [contractId]);
  if (!row?.envelope_id) return row;
  if (row.status === "sending") return row; // the sending job owns it
  const envelope = await avCall(ctx, "a consulta do contrato", (client) => client.getEnvelope(row.envelope_id));
  const transitions = await applyEnvelope(ctx, row.id, envelope);
  let current = await getContractRow(db, row.id);
  if (current.status === "completed" && (!current.signed_key || !current.evidence_key)) {
    try {
      await downloadFinalFiles(ctx, current);
    } catch (err) {
      ctx.log?.warn?.(`[contracts] final files not downloaded yet (${source}): ${err.message}`);
    }
    current = await getContractRow(db, row.id);
  }
  if (transitions.length) await announceTransitions(ctx, current, transitions);
  return current;
}

async function announceTransitions(ctx, row, transitions) {
  const { db } = ctx;
  const code = contractCode(row.id);
  const staff = [...new Set([...await financeAndAdminIds(db), row.created_by].filter(Boolean))];
  const mettaSignerId = await userIdByEmail(db, row.metta_signer_email);
  await db.tx(async () => {
    for (const transition of transitions) {
      if (transition === "client_signed") {
        await logActivity(ctx, {
          action: "contract.client_signed",
          entityType: "contract",
          entityId: row.id,
          clientId: row.client_id,
          brandId: row.brand_id,
          summary: `${row.client_signer_name} registrou o aceite do contrato ${code}`,
          visibility: "client",
        });
        await notify(ctx, staff, {
          type: "contract.client_signed",
          title: "Cliente assinou o contrato",
          body: `${row.client_signer_name} registrou o aceite do contrato ${code}. Falta a assinatura da Metta.`,
          link: contractStaffLink(row),
          entityType: "contract",
          entityId: row.id,
        });
        if (mettaSignerId)
          await notify(ctx, [mettaSignerId], {
            type: "contract.your_turn",
            title: "Sua vez de assinar o contrato",
            body: `${row.client_signer_name} já assinou o contrato ${code}. Assine pelo painel ou pelo e-mail da AssinaVelox.`,
            link: contractStaffLink(row),
            entityType: "contract",
            entityId: row.id,
            email: true,
            actionLabel: "Assinar agora",
          });
      } else if (transition === "metta_signed") {
        await logActivity(ctx, {
          action: "contract.metta_signed",
          entityType: "contract",
          entityId: row.id,
          clientId: row.client_id,
          brandId: row.brand_id,
          summary: `${row.metta_signer_name} assinou o contrato ${code} pela Metta`,
          visibility: "client",
        });
      } else if (transition === "completed") {
        await logActivity(ctx, {
          action: "contract.completed",
          entityType: "contract",
          entityId: row.id,
          clientId: row.client_id,
          brandId: row.brand_id,
          summary: `Contrato ${code} concluído: aceite das duas partes registrado`,
          visibility: "client",
        });
        const gateLifted = (await contractSettings(db)).requiredBeforePayment;
        await notify(ctx, await clientUserIds(db, row.client_id), {
          type: "contract.completed",
          title: "Contrato concluído",
          body: `O contrato ${code} foi assinado pelas duas partes. A cópia final e a página de evidências estão na área Financeiro.${gateLifted ? " O pagamento já está liberado." : ""}`,
          link: "/painel/financeiro#contratos",
          entityType: "contract",
          entityId: row.id,
          email: true,
          actionLabel: "Ver contrato",
        });
        await notify(ctx, staff, {
          type: "contract.completed",
          title: "Contrato concluído",
          body: `${code} (${row.client_name ?? "cliente"}) foi assinado pelas duas partes.`,
          link: contractStaffLink(row),
          entityType: "contract",
          entityId: row.id,
        });
      } else if (["refused", "expired", "canceled"].includes(transition)) {
        const label = { refused: "recusado", expired: "expirou", canceled: "foi cancelado" }[transition];
        const sentence = transition === "refused" ? `O contrato ${code} foi recusado` : `O contrato ${code} ${label}`;
        await logActivity(ctx, {
          action: `contract.${transition}`,
          entityType: "contract",
          entityId: row.id,
          clientId: row.client_id,
          brandId: row.brand_id,
          summary: `${sentence}${transition === "refused" && row.refusal_reason ? `: ${row.refusal_reason}` : ""}`,
          visibility: "client",
        });
        await notify(ctx, staff, {
          type: `contract.${transition}`,
          title: transition === "refused" ? "Contrato recusado" : transition === "expired" ? "Contrato expirou" : "Contrato cancelado",
          body: `${sentence}. Gere um novo contrato quando fizer sentido.`,
          link: contractStaffLink(row),
          entityType: "contract",
          entityId: row.id,
        });
      }
    }
  });
}

// ------------------------------------------------------------------ cancel & waive

export async function cancelContract(req, row, reason) {
  const { ctx } = req;
  const { db } = ctx;
  if (!["sending", "sent", "failed"].includes(row.status)) throw conflict("Este contrato já está encerrado.");
  if (row.status === "sending") throw conflict("O contrato ainda está sendo enviado. Aguarde alguns segundos e tente de novo.");
  let warning = null;
  if (row.envelope_id) {
    let envelope = null;
    try {
      envelope = await avCall(ctx, "a consulta do contrato", (client) => client.getEnvelope(row.envelope_id));
    } catch (err) {
      // A contract that never reached AssinaVelox properly can still be closed here.
      if (row.status !== "failed" || err?.code === "integration_not_configured") throw err;
      warning = "O contrato foi cancelado aqui, mas não conseguimos confirmar o cancelamento na AssinaVelox.";
    }
    if (envelope) {
      if (["finalizing", "completed"].includes(envelope.status)) {
        await applyEnvelope(ctx, row.id, envelope);
        throw conflict("As duas partes já assinaram: o contrato está sendo concluído e não pode mais ser cancelado.");
      }
      if (["refused", "expired", "canceled"].includes(envelope.status)) {
        await applyEnvelope(ctx, row.id, envelope);
        throw conflict("Este contrato já foi encerrado na AssinaVelox. Atualize a página.");
      }
      if (envelope.status === "in_progress")
        await avCall(ctx, "o cancelamento do contrato", (client) =>
          client.cancelEnvelope(row.envelope_id, { reason: reason || "Cancelado pela Metta." }),
        );
      // draft/preparing/ready: never sent to anyone; closing it here is enough.
    }
  }
  const code = contractCode(row.id);
  await db.tx(async () => {
    await update(db, row.id, { status: "canceled", canceled_at: now(), cancel_reason: reason || null, step: null });
    await logActivity(req, {
      action: "contract.canceled",
      entityType: "contract",
      entityId: row.id,
      clientId: row.client_id,
      brandId: row.brand_id,
      summary: `${req.user.name} cancelou o contrato ${code}${reason ? `: ${reason}` : ""}`,
      visibility: row.status === "sent" ? "client" : "internal",
    });
    if (row.status === "sent")
      await notify(req, await clientUserIds(db, row.client_id), {
        type: "contract.canceled",
        title: "Contrato cancelado",
        body: `O contrato ${code} foi cancelado pela Metta. Não é preciso assiná-lo.`,
        link: "/painel/financeiro#contratos",
        entityType: "contract",
        entityId: row.id,
      });
  });
  return { row: await getContractRow(db, row.id), warning };
}

export async function waiveContract(req, { orderId, subscriptionId }, reason) {
  const { db } = req.ctx;
  const table = orderId ? "orders" : "subscriptions";
  const id = orderId ?? subscriptionId;
  const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!row) throw notFound();
  const latest = await latestContract(db, { orderId, subscriptionId });
  if (latest && ["sending", "sent"].includes(latest.status))
    throw conflict("Cancele o contrato em andamento antes de dispensar a assinatura.");
  await db.tx(async () => {
    await db.run(`UPDATE ${table} SET contract_waived_at = ?, contract_waived_by = ?, contract_waiver_reason = ?, updated_at = ? WHERE id = ?`, [
      now(),
      req.user.id,
      reason,
      now(),
      id,
    ]);
    await logActivity(req, {
      action: "contract.waived",
      entityType: orderId ? "order" : "subscription",
      entityId: id,
      clientId: row.client_id,
      summary: `${req.user.name} dispensou o contrato deste ${orderId ? "pedido" : "plano"}: ${reason}`,
    });
  });
}

export async function unwaiveContract(req, { orderId, subscriptionId }) {
  const { db } = req.ctx;
  const table = orderId ? "orders" : "subscriptions";
  const id = orderId ?? subscriptionId;
  const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!row) throw notFound();
  await db.tx(async () => {
    await db.run(`UPDATE ${table} SET contract_waived_at = NULL, contract_waived_by = NULL, contract_waiver_reason = NULL, updated_at = ? WHERE id = ?`, [
      now(),
      id,
    ]);
    await logActivity(req, {
      action: "contract.waiver_removed",
      entityType: orderId ? "order" : "subscription",
      entityId: id,
      clientId: row.client_id,
      summary: `${req.user.name} voltou a exigir contrato assinado neste ${orderId ? "pedido" : "plano"}`,
    });
  });
}

// ------------------------------------------------------------------ embedded signing

const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Origin the widget will be framed by: the page's own origin (the Origin
 * header of this same-origin POST) when it is the configured APP_URL or, outside
 * production, a loopback address; otherwise APP_URL. AssinaVelox checks it
 * against its list of allowed origins and pins frame-ancestors to it.
 */
export function embedOrigin(req) {
  const fallback = appOrigin(req.ctx.config);
  const header = req.get?.("origin");
  if (!header) return fallback;
  try {
    const origin = new URL(header).origin;
    if (origin === fallback) return origin;
    if (!req.ctx.config.isProduction && LOOPBACK_ORIGIN.test(origin)) return origin;
  } catch {
    // ignore malformed headers
  }
  return fallback;
}

/**
 * Opens an embedded signing session for the logged-in signer.
 * role: 'client' (client portal) or 'metta' (admin panel).
 * -> { url, sessionId, widgetOrigin, expiresAt }
 */
export async function openSigningSession(req, row, role) {
  const { ctx, user } = req;
  const { db } = ctx;
  if (row.status !== "sent") throw conflict("Este contrato não está aguardando assinatura.");
  const prefix = role === "client" ? "client" : "metta";
  const email = String(row[`${prefix}_signer_email`] ?? "").toLowerCase();
  if (!email || email !== String(user.email ?? "").toLowerCase())
    throw new HttpError(
      403,
      "forbidden",
      role === "client"
        ? `Este contrato deve ser assinado por ${row.client_signer_name}. Peça a essa pessoa para entrar na plataforma ou usar o e-mail da AssinaVelox.`
        : "Só o representante da Metta definido em Configurações › Contratos pode assinar por aqui.",
    );
  const recipientId = row[`${prefix}_recipient_id`];
  if (!recipientId) throw conflict("O contrato ainda está sendo preparado. Aguarde alguns segundos.");
  if (role === "metta" && !SIGNED.has(row.client_status))
    throw conflict("A assinatura da Metta vem depois da assinatura do cliente.");

  // Revoke sessions this person opened before and never used (limit of 5).
  const previous = parseJson(row.embed_sessions, []).filter((s) => s.role === role);
  for (const session of previous.slice(-3)) {
    await avCall(ctx, "o encerramento de uma sessão anterior", (client) =>
      client.revokeEmbeddedSession(row.envelope_id, recipientId, session.id),
    ).catch(() => {});
  }
  const session = await avCall(ctx, "a abertura da assinatura", (client) =>
    client.createEmbeddedSession(
      row.envelope_id,
      recipientId,
      { origin: embedOrigin(req), expires_in: 600 },
      { idempotencyKey: randomUUID() },
    ),
  );
  const sessions = [
    ...parseJson(row.embed_sessions, []).filter((s) => !previous.some((p) => p.id === s.id)),
    { id: session.id, role, createdAt: now() },
  ].slice(-10);
  await db.tx(async () => {
    await update(db, row.id, { embed_sessions: JSON.stringify(sessions) });
    await logActivity(req, {
      action: "contract.signing_opened",
      entityType: "contract",
      entityId: row.id,
      clientId: row.client_id,
      summary: `${user.name} abriu a assinatura do contrato ${contractCode(row.id)} na plataforma`,
    });
  });
  // The URL carries a one-time token in its fragment: never logged or stored.
  return { url: session.url, sessionId: session.id, widgetOrigin: widgetOrigin(ctx.config), expiresAt: session.expires_at };
}

// ------------------------------------------------------------------ files

export const FILE_KINDS = {
  original: { column: "document_key", size: "document_size", name: (code) => `${code}-contrato-enviado.pdf` },
  signed: { column: "signed_key", size: "signed_size", name: (code) => `${code}-contrato-assinado.pdf` },
  evidence: { column: "evidence_key", size: "evidence_size", name: (code) => `${code}-evidencias.pdf` },
};

export { KINDS, KIND_LABELS, OPEN_STATUSES };
