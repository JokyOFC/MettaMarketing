// Minimal in-process fake of the AssinaVelox API v1 used by the contract
// tests. It follows the documented shapes ({data}, problem+json errors,
// Idempotency-Key replay) and validates what the Metta client sends
// (field geometry and minimum sizes, sequential recipients, origins).
import { randomUUID } from "node:crypto";
import http from "node:http";

const MIN_PT = { signature: [56, 20], initials: [22, 14], date: [40, 9], name: [40, 9], text: [18, 9], checkbox: [8, 8] };
const A4 = [595.28, 841.89];

const ulid = () => randomUUID().replace(/-/g, "").toUpperCase().slice(0, 26).padEnd(26, "0");

export async function startFakeAssinaVelox({ token = "avk_test_token", allowedOrigins = ["http://127.0.0.1:5173"] } = {}) {
  const state = {
    token,
    allowedOrigins,
    envelopes: new Map(),
    idempotency: new Map(),
    subscriptions: new Map(),
    sessions: new Map(),
    calls: [],
    failures: [], // [{ match: (method, path) => bool, status, type, detail, errors, once }]
    processingPolls: 1, // GETs before an uploaded document becomes ready
    seq: 0,
  };

  const problem = (res, status, slug, title, extra = {}) => {
    res.writeHead(status, { "content-type": "application/problem+json", "x-correlation-id": ulid() });
    res.end(JSON.stringify({ type: `urn:assinavelox:problem:${slug}`, title, status, ...extra }));
  };
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  function envelopeView(env, detail = true) {
    const view = {
      id: env.id,
      object: "envelope",
      display_code: env.display_code,
      title: env.title,
      status: env.status,
      status_label: { draft: "Rascunho", ready: "Rascunho", in_progress: "Em andamento", completed: "Concluído", refused: "Recusado", canceled: "Cancelado", expired: "Expirado" }[env.status] ?? env.status,
      signing_order: env.signing_order,
      recipients_count: env.recipients.length,
      signed_count: env.recipients.filter((r) => r.status === "signed").length,
      viewers_count: 0,
      verification_code: env.sent_at ? env.verification_code : null,
      signature_status: env.status === "completed" ? "none" : null,
      signature_status_label: env.status === "completed" ? "Aceite eletrônico com evidências (sem assinatura criptográfica)" : null,
      created_at: env.created_at,
      updated_at: env.updated_at,
      sent_at: env.sent_at,
      expires_at: env.expires_at,
      completed_at: env.completed_at,
      refused_at: env.refused_at,
      expired_at: null,
      canceled_at: env.canceled_at,
      folder: null,
      created_by: { name: "Integração Metta" },
    };
    if (detail) {
      view.documents = env.documents.map((d) => ({
        id: d.id,
        object: "document",
        position: 1,
        name: d.name,
        original_filename: d.name,
        source_type: "pdf",
        processing_status: d.polls >= state.processingPolls ? "ready" : "processing",
        processing_label: d.polls >= state.processingPolls ? "Pronto" : "Convertendo…",
        ready: d.polls >= state.processingPolls,
        pages: d.pages,
        size_bytes: d.size,
        sha256: { original: null, sent: null, final: null },
        failure: null,
        created_at: env.created_at,
      }));
      view.recipients = env.recipients.map((r) => ({
        id: r.id,
        object: "recipient",
        name: r.name,
        email: r.email,
        phone_masked: null,
        role: "signer",
        role_label: "Signatário",
        label: r.role ?? null,
        order: r.order,
        status: r.status,
        status_label: r.status,
        auth_method: "email_otp",
        notified_at: env.sent_at,
        notifications_count: env.sent_at ? 1 : 0,
        signed_at: r.signed_at ?? null,
        refused_at: r.refused_at ?? null,
        refusal_reason: r.refusal_reason ?? null,
      }));
      view.message = env.message;
      view.expiration_days = env.expires_in_days;
      view.send_copy_to_all = true;
      view.links = {};
    }
    return view;
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://fake");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    state.calls.push({ method: req.method, path, headers: req.headers, size: raw.length });

    if (req.headers.authorization !== `Bearer ${state.token}`)
      return problem(res, 401, "unauthenticated", "Não autenticado");

    const failure = state.failures.find((f) => f.match(req.method, path));
    if (failure) {
      if (failure.once) state.failures.splice(state.failures.indexOf(failure), 1);
      if (failure.hang) return; // never answers (timeout)
      return problem(res, failure.status, failure.type, failure.title ?? "Erro", {
        ...(failure.detail ? { detail: failure.detail } : {}),
        ...(failure.errors ? { errors: failure.errors } : {}),
      });
    }

    // Idempotency-Key replay (same key + same route -> same response).
    const key = req.headers["idempotency-key"];
    const idemKey = key ? `${req.method} ${path} ${key}` : null;
    if (idemKey && state.idempotency.has(idemKey)) {
      const saved = state.idempotency.get(idemKey);
      return json(res, saved.status, saved.body, { "idempotent-replayed": "true" });
    }
    const reply = (status, body) => {
      if (idemKey && status < 400) state.idempotency.set(idemKey, { status, body });
      return json(res, status, body);
    };
    let body = null;
    if ((req.headers["content-type"] ?? "").includes("application/json")) {
      try {
        body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      } catch {
        return problem(res, 400, "bad-request", "JSON inválido");
      }
    }
    const parts = path.split("/").filter(Boolean);
    const at = new Date().toISOString();

    // envelopes
    if (req.method === "GET" && path === "/envelopes") {
      const data = [...state.envelopes.values()].map((e) => envelopeView(e, false)).slice(0, Number(url.searchParams.get("per_page") ?? 25));
      return json(res, 200, { data, links: {}, meta: { next_cursor: null, prev_cursor: null, per_page: data.length } });
    }
    if (req.method === "POST" && path === "/envelopes") {
      if (!key) return problem(res, 400, "idempotency-key-missing", "Idempotency-Key obrigatória");
      if (!body?.title || body.title.length < 3) return problem(res, 422, "validation-failed", "Dados inválidos", { errors: { title: ["O título é obrigatório."] } });
      state.seq += 1;
      const env = {
        id: ulid(),
        display_code: `AV-${String(state.seq).padStart(6, "0")}`,
        title: body.title,
        message: body.message ?? null,
        signing_order: body.signing_order ?? "sequential",
        expires_in_days: body.expires_in_days ?? 15,
        status: "draft",
        documents: [],
        recipients: [],
        fields: [],
        verification_code: `VER-${state.seq}`,
        created_at: at,
        updated_at: at,
        sent_at: null,
        expires_at: null,
        completed_at: null,
        refused_at: null,
        canceled_at: null,
      };
      state.envelopes.set(env.id, env);
      return reply(201, { data: envelopeView(env) });
    }
    const env = parts[0] === "envelopes" ? state.envelopes.get(parts[1]) : null;
    if (parts[0] === "envelopes" && parts[1] && !env) return problem(res, 404, "not-found", "Não encontrado");

    if (env && req.method === "GET" && parts.length === 2) {
      for (const d of env.documents) d.polls += 1;
      return json(res, 200, { data: envelopeView(env) });
    }
    if (env && req.method === "POST" && parts[2] === "documents") {
      if (!key) return problem(res, 400, "idempotency-key-missing", "Idempotency-Key obrigatória");
      if (env.status !== "draft" && env.status !== "ready") return problem(res, 409, "invalid-status", "Status inválido");
      const text = raw.toString("latin1");
      if (!text.includes("%PDF-")) return problem(res, 422, "upload-rejected", "Arquivo recusado", { errors: { file: ["Envie um PDF."] } });
      const pages = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length || 1;
      const doc = { id: ulid(), name: "contrato.pdf", size: raw.length, pages, polls: 0, bytes: raw };
      env.documents.push(doc);
      return reply(201, { data: { id: doc.id, object: "document", ready: false, processing_status: "processing", pages } });
    }
    if (env && req.method === "PUT" && parts[2] === "recipients") {
      if (!["draft", "ready"].includes(env.status)) return problem(res, 409, "invalid-status", "Status inválido");
      const list = body?.recipients ?? [];
      if (!list.length) return problem(res, 422, "validation-failed", "Dados inválidos", { errors: { recipients: ["Informe ao menos um participante."] } });
      env.recipients = list.map((r, i) => ({ id: ulid(), name: r.name, email: r.email, order: r.order ?? i + 1, role: r.role, status: "pending" }));
      return json(res, 200, {
        data: env.recipients.map((r) => ({ id: r.id, object: "recipient", name: r.name, email: r.email, order: r.order, status: "pending", role: "signer" })),
      });
    }
    if (env && req.method === "PUT" && parts[2] === "fields") {
      const doc = env.documents[0];
      const errors = {};
      (body?.fields ?? []).forEach((f, i) => {
        const [minW, minH] = MIN_PT[f.type] ?? [1, 1];
        if (!env.recipients.some((r) => r.id === f.recipient_id)) errors[`fields.${i}.recipient_id`] = ["Participante inválido."];
        if (doc && f.document_id !== doc.id) errors[`fields.${i}.document_id`] = ["Documento inválido."];
        if (!(f.page >= 1 && f.page <= (doc?.pages ?? 1))) errors[`fields.${i}.page`] = ["Página inexistente."];
        if (f.x < 0 || f.y < 0 || f.x + f.w > 1 || f.y + f.h > 1) errors[`fields.${i}.x`] = ["Fora da página."];
        if (f.w * A4[0] < minW - 0.01 || f.h * A4[1] < minH - 0.01) errors[`fields.${i}.w`] = ["Menor que o mínimo."];
      });
      for (const r of env.recipients)
        if (!(body?.fields ?? []).some((f) => f.recipient_id === r.id && f.type === "signature"))
          errors.fields = [`${r.name} precisa de um campo de assinatura.`];
      if (Object.keys(errors).length) return problem(res, 422, "validation-failed", "Dados inválidos", { errors });
      env.fields = body.fields.map((f) => ({ ...f, id: ulid() }));
      env.status = "ready";
      return json(res, 200, { data: env.fields.map((f) => ({ ...f, object: "field", auto: false })) });
    }
    if (env && req.method === "POST" && parts[2] === "send") {
      if (!key) return problem(res, 400, "idempotency-key-missing", "Idempotency-Key obrigatória");
      if (env.status !== "ready") return problem(res, 409, "envelope-not-ready", "Documento não está pronto", { issues: ["Campos"] });
      env.status = "in_progress";
      env.sent_at = at;
      env.expires_at = new Date(Date.now() + env.expires_in_days * 86400000).toISOString();
      return reply(200, { data: envelopeView(env), meta: { invitations_sent: 1 } });
    }
    if (env && req.method === "POST" && parts[2] === "cancel") {
      if (env.status !== "in_progress") return problem(res, 409, "invalid-status", "Status inválido");
      env.status = "canceled";
      env.canceled_at = at;
      return json(res, 200, { data: envelopeView(env), meta: { recipients_notified: 1 } });
    }
    if (env && req.method === "GET" && parts[2] === "files") {
      const type = parts[3];
      if (type === "original") {
        res.writeHead(200, { "content-type": "application/pdf" });
        return res.end(env.documents[0]?.bytes ?? Buffer.from("%PDF-1.4"));
      }
      if (env.status !== "completed") return problem(res, 404, "not-found", "Arquivo final indisponível");
      res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="${type}.pdf"` });
      return res.end(Buffer.from(`%PDF-1.4\n% ${type} of ${env.id}\n%%EOF`));
    }
    if (env && parts[2] === "recipients" && parts[4] === "embedded-sessions") {
      const recipient = env.recipients.find((r) => r.id === parts[3]);
      if (!recipient) return problem(res, 404, "not-found", "Não encontrado");
      if (req.method === "POST") {
        if (env.status !== "in_progress") return problem(res, 409, "invalid-status", "Status inválido");
        const first = [...env.recipients].sort((a, b) => a.order - b.order).find((r) => r.status === "pending");
        if (first?.id !== recipient.id) return problem(res, 409, "recipient-not-active", "Fora da vez");
        if (!state.allowedOrigins.includes(body?.origin))
          return problem(res, 422, "validation-failed", "Dados inválidos", { errors: { origin: ["Origem não cadastrada."] } });
        const session = { id: ulid(), envelope_id: env.id, recipient_id: recipient.id, origin: body.origin, status: "pending", created_at: at, expires_at: new Date(Date.now() + (body.expires_in ?? 300) * 1000).toISOString() };
        state.sessions.set(session.id, session);
        return json(res, 201, { data: { ...session, object: "embedded_signing_session", url: `http://fake-widget.test/embed/v1/sessoes/${session.id}#t=secret-${session.id}` } });
      }
      const session = state.sessions.get(parts[5]);
      if (!session) return problem(res, 404, "not-found", "Não encontrado");
      if (req.method === "DELETE") session.status = session.status === "completed" ? "completed" : "revoked";
      return json(res, 200, { data: { ...session, object: "embedded_signing_session", url: null } });
    }

    // webhook subscriptions (REST Hooks)
    if (req.method === "POST" && path === "/webhook-subscriptions") {
      if (!/^https:\/\//.test(body?.target_url ?? ""))
        return problem(res, 422, "validation-failed", "Dados inválidos", { errors: { target_url: ["Use um endereço HTTPS público."] } });
      const existing = [...state.subscriptions.values()].find((s) => s.target_url === body.target_url);
      if (existing) return json(res, 200, { data: { ...existing, secret: null } });
      const sub = { id: ulid(), object: "webhook_subscription", target_url: body.target_url, events: body.events ?? [body.event], status: "active", status_label: "Ativa", paused_reason: null, secret_hint: "whsec_…abcd", signature_header: "X-AssinaVelox-Signature", created_at: at };
      const secret = `whsec_${randomUUID().replace(/-/g, "")}`;
      state.subscriptions.set(sub.id, { ...sub, secret });
      return json(res, 201, { data: { ...sub, secret } });
    }
    if (req.method === "DELETE" && parts[0] === "webhook-subscriptions") {
      if (!state.subscriptions.delete(parts[1])) return problem(res, 404, "not-found", "Não encontrado");
      res.writeHead(204);
      return res.end();
    }
    return problem(res, 404, "not-found", "Rota desconhecida");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const helpers = {
    apiUrl,
    state,
    envelope: (id) => state.envelopes.get(id),
    sign(envelopeId, order) {
      const env = state.envelopes.get(envelopeId);
      const r = env.recipients.find((x) => x.order === order);
      r.status = "signed";
      r.signed_at = new Date().toISOString();
      if (env.recipients.every((x) => x.status === "signed")) {
        env.status = "completed";
        env.completed_at = new Date().toISOString();
      }
      env.updated_at = new Date().toISOString();
    },
    refuse(envelopeId, order, reason) {
      const env = state.envelopes.get(envelopeId);
      const r = env.recipients.find((x) => x.order === order);
      r.status = "refused";
      r.refused_at = new Date().toISOString();
      r.refusal_reason = reason;
      env.status = "refused";
      env.refused_at = r.refused_at;
    },
    fail(match, status, type, extra = {}) {
      state.failures.push({ match, status, type, ...extra });
    },
    clearFailures() {
      state.failures.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
  return helpers;
}
