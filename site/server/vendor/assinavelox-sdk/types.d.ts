/** Document (API v1). */
export interface Document {
    created_at: string;
    failure: DocumentFailure | null;
    id: string;
    name: string;
    object: string;
    original_filename: string;
    pages: number | null;
    position: number;
    /** Valores conhecidos: `Enviado`, `Convertendo…`, `Pronto`, `Falha ao processar`, `Bloqueado` (a lista pode crescer). */
    processing_label: string;
    processing_status: string;
    ready: boolean;
    sha256: DocumentSha256;
    size_bytes: number | null;
    source_type: string;
}
/** DocumentFailure (API v1). */
export interface DocumentFailure {
    code: string | null;
    message: string | null;
}
/** DocumentSha256 (API v1). */
export interface DocumentSha256 {
    final: string | null;
    original: string | null;
    sent: string | null;
}
/** Sessão de assinatura embutida (widget, docs/fase-3/widget-embutido.md). `url` (uso único, com o token no fragmento) só vem na criação. */
export interface EmbeddedSigningSession {
    id: string;
    object: string;
    envelope_id: string | null;
    recipient_id: string | null;
    origin: string;
    /** Valores conhecidos: `pending`, `active`, `completed`, `refused`, `expired`, `revoked`, `closed` (a lista pode crescer). */
    status: string;
    expires_at: string | null;
    used_at: string | null;
    completed_at: string | null;
    revoked_at: string | null;
    created_at: string | null;
    /** Endereço de uso único para o iframe; só na criação. */
    url?: string;
}
/** Envelope (API v1). */
export interface Envelope {
    /** Só no detalhe. */
    cancel_reason?: string | null;
    canceled_at: string | null;
    completed_at: string | null;
    created_at: string;
    created_by: EnvelopeCreatedBy;
    display_code: string;
    /** Só no detalhe. */
    documents?: Document[];
    /** Só no detalhe. */
    expiration_days?: number | null;
    expired_at: string | null;
    expires_at: string | null;
    folder: EnvelopeFolder | null;
    id: string;
    /** Só no detalhe. */
    links?: EnvelopeLinks;
    /** Só no detalhe. */
    message?: string | null;
    object: string;
    /** Só no detalhe. */
    recipients?: Recipient[];
    recipients_count: number;
    refused_at: string | null;
    /** Só no detalhe. */
    send_copy_to_all?: boolean;
    sent_at: string | null;
    signature_status: string | null;
    signature_status_label: string | null;
    signed_count: number;
    signing_order: string;
    status: string;
    /** Valores conhecidos: `Assinado`, `Concluído`, `Rascunho`, `Rascunho · processando`, `Aguardando`, `Em andamento · finalizando`, `Recusado`, `Expirado`, `Cancelado`, `Em andamento` (a lista pode crescer). */
    status_label: string;
    title: string;
    updated_at: string;
    verification_code: string | null;
    viewers_count: number;
}
/** EnvelopeCreatedBy (API v1). */
export interface EnvelopeCreatedBy {
    name: string;
}
/** EnvelopeFolder (API v1). */
export interface EnvelopeFolder {
    id: string;
    name: string;
}
/** Só no detalhe. */
export interface EnvelopeLinks {
    events: string;
    evidence_file: string | null;
    fields: string;
    original_file: string;
    recipients: string;
    self: string;
    signed_file: string | null;
    verification: string | null;
}
/** Event (API v1). */
export interface Event {
    actor: EventActor;
    id: string;
    /** Valores conhecidos: `ok`, `warn`, `info` (a lista pode crescer). */
    kind: string;
    /** Rótulo em PT-BR do tipo; a lista cresce com a trilha — não é enumeração fechada. */
    label: string;
    object: string;
    occurred_at: string;
    recipient_id: string | null;
    type: string;
}
/** EventActor (API v1). */
export interface EventActor {
    name: string | null;
    type: string;
}
/** Field (API v1). */
export interface Field {
    auto: boolean;
    document_id: string | null;
    h: number;
    id: string;
    label: string | null;
    object: string;
    page: number;
    recipient_id: string | null;
    required: boolean;
    type: string;
    w: number;
    x: number;
    y: number;
}
/** Recipient (API v1). */
export interface Recipient {
    auth_method: string | null;
    email: string | null;
    id: string;
    label: string | null;
    name: string | null;
    notifications_count: number;
    notified_at: string | null;
    object: string;
    order: number;
    phone_masked: string | null;
    refusal_reason: string | null;
    refused_at: string | null;
    role: string;
    /** Valores conhecidos: `Signatário`, `Testemunha`, `Aprovador`, `Visualizador` (a lista pode crescer). */
    role_label: string;
    signed_at: string | null;
    status: string;
    /** Valores conhecidos: `Aprovado`, `Pendente`, `Assinado`, `Recusado`, `Expirado`, `Cancelado`, `Delegado` (a lista pode crescer). */
    status_label: string;
}
/** Template (API v1). */
export interface Template {
    category: string | null;
    description: string | null;
    id: string;
    name: string;
    object: string;
    /** Só no detalhe. */
    roles?: TemplateRole[];
    source_type: string;
    status: string;
    updated_at: string;
    usable: boolean;
    /** Só no detalhe. */
    variables?: TemplateVariable[];
    version: number | null;
}
/** TemplateRole (API v1). */
export interface TemplateRole {
    id: string;
    name: string;
    participant_role: string;
    participant_role_label: string;
}
/** TemplateVariable (API v1). */
export interface TemplateVariable {
    default_value: string | null;
    help_text: string | null;
    key: string;
    label: string;
    options: unknown;
    required: boolean;
    type: string;
}
/** Assinatura de REST Hook (um endpoint de webhook ligado ao token que a criou). `secret` só vem na criação (201); nas listagens é null e, quando a assinatura já existia (200), não vem. */
export interface WebhookSubscription {
    id: string;
    object: string;
    target_url: string;
    events: string[];
    /** Valores conhecidos: `active`, `paused` (a lista pode crescer). */
    status: string;
    status_label: string;
    paused_reason: string | null;
    secret_hint: string;
    signature_header: string;
    created_at: string;
    secret?: string | null;
}
/** POST /api/v1/envelopes/{envelope}/cancel — motivo opcional (o mesmo campo da interface). */
export interface CancelEnvelopeRequest {
    reason?: string | null;
}
/**
 * CreateWebhookSubscriptionRequest (API v1).
 *
 * Obrigatórios: target_url.
 */
export interface CreateWebhookSubscriptionRequest {
    event?: '*' | 'envelope.sent' | 'recipient.viewed' | 'recipient.signed' | 'recipient.approved' | 'recipient.refused' | 'envelope.refused' | 'envelope.completed' | 'envelope.expired' | 'envelope.canceled' | 'document.processing_failed' | null;
    events?: ('*' | 'envelope.sent' | 'recipient.viewed' | 'recipient.signed' | 'recipient.approved' | 'recipient.refused' | 'envelope.refused' | 'envelope.completed' | 'envelope.expired' | 'envelope.canceled' | 'document.processing_failed')[] | null;
    target_url: string;
}
/**
 * POST /api/v1/templates/{template}/envelopes — o mesmo corpo de "Usar modelo" na interface:
 *
 *  - `title` (opcional; padrão: nome do modelo);
 *  - `values`: `{chave_da_variavel: valor}`, validados por tipo no servidor
 *    (App\Services\Templates\VariableValues);
 *  - `participants`: `{ulid_do_papel: {name, email}}`, um por papel do modelo.
 *
 * A validação por tipo e por papel é de App\Services\Templates\CreateEnvelopeFromTemplate
 * (erros em `values.*`, `participants.*` e `template`).
 */
export interface GenerateEnvelopeFromTemplateRequest {
    participants?: Record<string, GenerateEnvelopeFromTemplateRequestParticipant> | null;
    title?: string | null;
    values?: Record<string, string | number | boolean | null> | null;
}
/**
 * GenerateEnvelopeFromTemplateRequestParticipant (API v1).
 *
 * Obrigatórios: email, name.
 */
export interface GenerateEnvelopeFromTemplateRequestParticipant {
    email: string;
    name: string;
}
/**
 * Corpo de `POST /api/v1/envelopes/{envelope}/recipients/{recipient}/embedded-sessions`
 *
 * Obrigatórios: origin.
 */
export interface StoreEmbeddedSigningSessionRequest {
    /** Validade da URL de uso único, em segundos (60 a 900; padrão 300). */
    expires_in?: number | null;
    /** Origem exata do site que hospeda o widget, ex.: `https://app.cliente.com.br`. */
    origin: string;
}
/**
 * POST /api/v1/envelopes — rascunho novo, com as mesmas regras de formato do passo 1 do
 *
 * Obrigatórios: title.
 */
export interface StoreEnvelopeRequest {
    expires_in_days?: number | null;
    folder_id?: string | null;
    message?: string | null;
    send_copy_to_all?: boolean | null;
    signing_order?: 'sequential' | 'parallel' | null;
    title: string;
}
/**
 * PUT /api/v1/envelopes/{envelope}/fields — substitui os campos posicionados.
 *
 * Obrigatórios: fields.
 */
export interface SyncEnvelopeFieldsRequest {
    fields: SyncEnvelopeFieldsRequestField[];
    initials_on_all_pages?: boolean | null;
}
/**
 * SyncEnvelopeFieldsRequestField (API v1).
 *
 * Obrigatórios: h, page, type, w, x, y.
 */
export interface SyncEnvelopeFieldsRequestField {
    auto?: boolean | null;
    /** Fase 2 §2.3: ULID do documento onde o campo fica. Ausente = primeiro documento. */
    document_id?: string | null;
    h: number;
    id?: string | null;
    label?: string | null;
    options?: SyncEnvelopeFieldsRequestFieldOptions | null;
    page: number;
    placeholder?: string | null;
    recipient_client_id?: string | null;
    recipient_id?: string | null;
    required?: boolean | null;
    type: 'signature' | 'initials' | 'name' | 'date' | 'text' | 'checkbox' | 'cpf' | 'stamp';
    w: number;
    x: number;
    y: number;
}
/** SyncEnvelopeFieldsRequestFieldOptions (API v1). */
export interface SyncEnvelopeFieldsRequestFieldOptions {
    date_format?: string | null;
    default?: boolean | null;
    font_size?: number | null;
    placeholder?: string | null;
}
/**
 * PUT /api/v1/envelopes/{envelope}/recipients — substitui a lista inteira de participantes.
 *
 * Obrigatórios: recipients, signing_order.
 */
export interface SyncEnvelopeRecipientsRequest {
    recipients: SyncEnvelopeRecipientsRequestRecipient[];
    signing_order: 'sequential' | 'parallel';
}
/**
 * SyncEnvelopeRecipientsRequestRecipient (API v1).
 *
 * Obrigatórios: email, name.
 */
export interface SyncEnvelopeRecipientsRequestRecipient {
    auth_method?: 'email_otp' | 'sms_otp' | 'whatsapp_otp' | null;
    channel?: 'email' | 'sms' | 'whatsapp' | null;
    email: string;
    id?: string | null;
    name: string;
    order?: number | null;
    /** Fase 2 §2.4: papel de domínio (o `role` acima é o rótulo livre). A flag */
    participant_role?: 'signer' | 'witness' | 'approver' | 'viewer' | null;
    /** Fase 2 §2.9 (C-CAN): telefone, canal do convite, método de autenticação e PIN. */
    phone?: string | null;
    pin?: string | null;
    remove_pin?: boolean | null;
    role?: string | null;
}
/** Parâmetros de consulta de `listEnvelopes`. */
export interface ListEnvelopesQuery {
    per_page?: number | null;
    cursor?: string | null;
    status?: ('draft' | 'preparing' | 'ready' | 'in_progress' | 'finalizing' | 'completed' | 'refused' | 'expired' | 'canceled')[] | null;
    folder?: string | null;
    q?: string | null;
    created_after?: string | null;
    created_before?: string | null;
    updated_after?: string | null;
}
/** Parâmetros de consulta de `downloadFile`. */
export interface DownloadFileQuery {
    /** ULID do arquivo, quando o envelope tem mais de um. Ausente = primeiro arquivo. */
    document?: string | null;
}
/** Parâmetros de consulta de `listEvents`. */
export interface ListEventsQuery {
    per_page?: number | null;
    cursor?: string | null;
}
/** Parâmetros de consulta de `listTemplates`. */
export interface ListTemplatesQuery {
    per_page?: number | null;
    cursor?: string | null;
}
