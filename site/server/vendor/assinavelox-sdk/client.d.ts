import { DownloadedFile, type FileUpload } from './files.js';
import { type ClientOptions, type RequestOptions } from './http.js';
import { Page, type ApiResult } from './page.js';
import type * as T from './types.js';
/**
 * Cliente da API v1 da AssinaVelox.
 *
 * ```ts
 * const client = new AssinaVelox({ baseUrl: 'https://sua-instalacao.example/api/v1', token: process.env.ASSINAVELOX_TOKEN! });
 * ```
 *
 * O token fica num campo privado (não aparece em `console.log`). Redirecionamentos
 * não são seguidos. Erros da API viram `ApiError` (RFC 9457).
 */
export declare class AssinaVelox {
    #private;
    constructor(options: ClientOptions);
    get baseUrl(): string;
    /**
     * Listar documentos — `GET /envelopes`.
     *
     * Paginada por cursor. `for await` percorre todas as páginas.
     */
    listEnvelopes(query?: T.ListEnvelopesQuery, options?: RequestOptions): Promise<Page<T.Envelope>>;
    /**
     * Criar rascunho — `POST /envelopes`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    createEnvelope(body: T.StoreEnvelopeRequest, options?: RequestOptions): Promise<T.Envelope>;
    /** Detalhar documento — `GET /envelopes/{envelope}`. */
    getEnvelope(envelope: string, options?: RequestOptions): Promise<T.Envelope>;
    /**
     * Enviar arquivo — `POST /envelopes/{envelope}/documents`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    uploadDocument(envelope: string, file: FileUpload, options?: RequestOptions): Promise<T.Document>;
    /** Situação dos participantes — `GET /envelopes/{envelope}/recipients`. */
    listRecipients(envelope: string, options?: RequestOptions): Promise<T.Recipient[]>;
    /**
     * Definir participantes — `PUT /envelopes/{envelope}/recipients`.
     *
     * Aceita Idempotency-Key (opcional).
     */
    syncRecipients(envelope: string, body: T.SyncEnvelopeRecipientsRequest, options?: RequestOptions): Promise<T.Recipient[]>;
    /** Listar campos — `GET /envelopes/{envelope}/fields`. */
    listFields(envelope: string, options?: RequestOptions): Promise<T.Field[]>;
    /**
     * Definir campos — `PUT /envelopes/{envelope}/fields`.
     *
     * Aceita Idempotency-Key (opcional).
     */
    syncFields(envelope: string, body: T.SyncEnvelopeFieldsRequest, options?: RequestOptions): Promise<T.Field[]>;
    /**
     * Enviar para assinatura — `POST /envelopes/{envelope}/send`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    sendEnvelope(envelope: string, options?: RequestOptions): Promise<ApiResult<T.Envelope>>;
    /**
     * Cancelar documento — `POST /envelopes/{envelope}/cancel`.
     *
     * Aceita Idempotency-Key (opcional).
     */
    cancelEnvelope(envelope: string, body?: T.CancelEnvelopeRequest, options?: RequestOptions): Promise<ApiResult<T.Envelope>>;
    /**
     * Baixar arquivo — `GET /envelopes/{envelope}/files/{type}`.
     *
     * Devolve os bytes do arquivo.
     */
    downloadFile(envelope: string, type: 'original' | 'signed' | 'evidence', query?: T.DownloadFileQuery, options?: RequestOptions): Promise<DownloadedFile>;
    /**
     * Eventos da trilha — `GET /envelopes/{envelope}/events`.
     *
     * Paginada por cursor. `for await` percorre todas as páginas.
     */
    listEvents(envelope: string, query?: T.ListEventsQuery, options?: RequestOptions): Promise<Page<T.Event>>;
    /** Registro de verificação — `GET /envelopes/{envelope}/verification`. */
    getVerification(envelope: string, options?: RequestOptions): Promise<Record<string, unknown>>;
    /**
     * Listar modelos — `GET /templates`.
     *
     * Paginada por cursor. `for await` percorre todas as páginas.
     */
    listTemplates(query?: T.ListTemplatesQuery, options?: RequestOptions): Promise<Page<T.Template>>;
    /** Detalhar modelo — `GET /templates/{template}`. */
    getTemplate(template: string, options?: RequestOptions): Promise<T.Template>;
    /**
     * Gerar documento a partir do modelo — `POST /templates/{template}/envelopes`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    createEnvelopeFromTemplate(template: string, body?: T.GenerateEnvelopeFromTemplateRequest, options?: RequestOptions): Promise<T.Envelope>;
    /** Eventos que podem ser assinados (`*` = todos, inclusive os que forem criados depois) — `GET /webhook-events`. */
    listWebhookEvents(options?: RequestOptions): Promise<unknown[]>;
    /** Payload de exemplo de um evento, no formato `{data: [payload]}` — lista com um item, que é o que os editores de gatilho esperam para mapear campos. Nenhum dado real — `GET /webhook-events/{event}/sample`. */
    getWebhookEventSample(event: string, options?: RequestOptions): Promise<ApiResult<unknown[]>>;
    /** Assinaturas ativas deste token — `GET /webhook-subscriptions`. */
    listWebhookSubscriptions(options?: RequestOptions): Promise<ApiResult<T.WebhookSubscription[]>>;
    /**
     * Assina um evento (ou vários) numa URL HTTPS pública — `POST /webhook-subscriptions`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    createWebhookSubscription(body: T.CreateWebhookSubscriptionRequest, options?: RequestOptions): Promise<ApiResult<T.WebhookSubscription>>;
    /** Remove a assinatura (o "unsubscribe" do REST Hooks). 204; 404 se não for deste token — `DELETE /webhook-subscriptions/{subscription}`. */
    deleteWebhookSubscription(subscription: string, options?: RequestOptions): Promise<void>;
    /**
     * Criar sessão de assinatura embutida — `POST /envelopes/{envelope}/recipients/{recipient}/embedded-sessions`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    createEmbeddedSession(envelope: string, recipient: string, body: T.StoreEmbeddedSigningSessionRequest, options?: RequestOptions): Promise<T.EmbeddedSigningSession>;
    /** Situação da sessão embutida — `GET /envelopes/{envelope}/recipients/{recipient}/embedded-sessions/{embeddedSession}`. */
    getEmbeddedSession(envelope: string, recipient: string, embeddedSession: string, options?: RequestOptions): Promise<T.EmbeddedSigningSession>;
    /** Revogar sessão embutida — `DELETE /envelopes/{envelope}/recipients/{recipient}/embedded-sessions/{embeddedSession}`. */
    revokeEmbeddedSession(envelope: string, recipient: string, embeddedSession: string, options?: RequestOptions): Promise<T.EmbeddedSigningSession>;
}
