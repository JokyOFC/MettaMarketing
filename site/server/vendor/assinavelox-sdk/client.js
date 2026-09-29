// Gerado por tools/sdkgen a partir de sdks/openapi/v1.json — não edite; rode python tools/sdkgen/sdkgen.py generate.
import { DownloadedFile } from './files.js';
import { dataOf, HttpClient, jsonOf, metaOf, } from './http.js';
import { Page } from './page.js';
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
export class AssinaVelox {
    #http;
    constructor(options) {
        this.#http = new HttpClient(options);
    }
    get baseUrl() {
        return this.#http.baseUrl;
    }
    /**
     * Listar documentos — `GET /envelopes`.
     *
     * Paginada por cursor. `for await` percorre todas as páginas.
     */
    async listEnvelopes(query = {}, options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/envelopes',
            query,
            querySpec: {
                per_page: ['per_page', false],
                cursor: ['cursor', false],
                status: ['status[]', true],
                folder: ['folder', false],
                q: ['q', false],
                created_after: ['created_after', false],
                created_before: ['created_before', false],
                updated_after: ['updated_after', false],
            },
            options,
        });
        return Page.fromJson(jsonOf(response), (cursor) => this.listEnvelopes({ ...query, cursor }, options));
    }
    /**
     * Criar rascunho — `POST /envelopes`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    async createEnvelope(body, options = {}) {
        const response = await this.#http.request({
            method: 'POST',
            path: '/envelopes',
            json: body,
            hasBody: true,
            idempotency: 'required',
            options,
        });
        return dataOf(response);
    }
    /** Detalhar documento — `GET /envelopes/{envelope}`. */
    async getEnvelope(envelope, options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/envelopes/{envelope}',
            pathParams: { envelope: envelope },
            options,
        });
        return dataOf(response);
    }
    /**
     * Enviar arquivo — `POST /envelopes/{envelope}/documents`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    async uploadDocument(envelope, file, options = {}) {
        const response = await this.#http.request({
            method: 'POST',
            path: '/envelopes/{envelope}/documents',
            pathParams: { envelope: envelope },
            file,
            fileField: 'file',
            idempotency: 'required',
            options,
        });
        return dataOf(response);
    }
    /** Situação dos participantes — `GET /envelopes/{envelope}/recipients`. */
    async listRecipients(envelope, options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/envelopes/{envelope}/recipients',
            pathParams: { envelope: envelope },
            options,
        });
        return (dataOf(response) ?? []);
    }
    /**
     * Definir participantes — `PUT /envelopes/{envelope}/recipients`.
     *
     * Aceita Idempotency-Key (opcional).
     */
    async syncRecipients(envelope, body, options = {}) {
        const response = await this.#http.request({
            method: 'PUT',
            path: '/envelopes/{envelope}/recipients',
            pathParams: { envelope: envelope },
            json: body,
            hasBody: true,
            idempotency: 'optional',
            options,
        });
        return (dataOf(response) ?? []);
    }
    /** Listar campos — `GET /envelopes/{envelope}/fields`. */
    async listFields(envelope, options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/envelopes/{envelope}/fields',
            pathParams: { envelope: envelope },
            options,
        });
        return (dataOf(response) ?? []);
    }
    /**
     * Definir campos — `PUT /envelopes/{envelope}/fields`.
     *
     * Aceita Idempotency-Key (opcional).
     */
    async syncFields(envelope, body, options = {}) {
        const response = await this.#http.request({
            method: 'PUT',
            path: '/envelopes/{envelope}/fields',
            pathParams: { envelope: envelope },
            json: body,
            hasBody: true,
            idempotency: 'optional',
            options,
        });
        return (dataOf(response) ?? []);
    }
    /**
     * Enviar para assinatura — `POST /envelopes/{envelope}/send`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    async sendEnvelope(envelope, options = {}) {
        const response = await this.#http.request({
            method: 'POST',
            path: '/envelopes/{envelope}/send',
            pathParams: { envelope: envelope },
            idempotency: 'required',
            options,
        });
        return { data: dataOf(response), meta: metaOf(response) };
    }
    /**
     * Cancelar documento — `POST /envelopes/{envelope}/cancel`.
     *
     * Aceita Idempotency-Key (opcional).
     */
    async cancelEnvelope(envelope, body, options = {}) {
        const response = await this.#http.request({
            method: 'POST',
            path: '/envelopes/{envelope}/cancel',
            pathParams: { envelope: envelope },
            json: body,
            hasBody: true,
            idempotency: 'optional',
            options,
        });
        return { data: dataOf(response), meta: metaOf(response) };
    }
    /**
     * Baixar arquivo — `GET /envelopes/{envelope}/files/{type}`.
     *
     * Devolve os bytes do arquivo.
     */
    async downloadFile(envelope, type, query = {}, options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/envelopes/{envelope}/files/{type}',
            pathParams: { envelope: envelope, type: type },
            query,
            querySpec: { document: ['document', false] },
            options,
            accept: '*/*',
        });
        return DownloadedFile.fromResponse(response.headers, response.body);
    }
    /**
     * Eventos da trilha — `GET /envelopes/{envelope}/events`.
     *
     * Paginada por cursor. `for await` percorre todas as páginas.
     */
    async listEvents(envelope, query = {}, options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/envelopes/{envelope}/events',
            pathParams: { envelope: envelope },
            query,
            querySpec: {
                per_page: ['per_page', false],
                cursor: ['cursor', false],
            },
            options,
        });
        return Page.fromJson(jsonOf(response), (cursor) => this.listEvents(envelope, { ...query, cursor }, options));
    }
    /** Registro de verificação — `GET /envelopes/{envelope}/verification`. */
    async getVerification(envelope, options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/envelopes/{envelope}/verification',
            pathParams: { envelope: envelope },
            options,
        });
        return dataOf(response);
    }
    /**
     * Listar modelos — `GET /templates`.
     *
     * Paginada por cursor. `for await` percorre todas as páginas.
     */
    async listTemplates(query = {}, options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/templates',
            query,
            querySpec: {
                per_page: ['per_page', false],
                cursor: ['cursor', false],
            },
            options,
        });
        return Page.fromJson(jsonOf(response), (cursor) => this.listTemplates({ ...query, cursor }, options));
    }
    /** Detalhar modelo — `GET /templates/{template}`. */
    async getTemplate(template, options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/templates/{template}',
            pathParams: { template: template },
            options,
        });
        return dataOf(response);
    }
    /**
     * Gerar documento a partir do modelo — `POST /templates/{template}/envelopes`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    async createEnvelopeFromTemplate(template, body, options = {}) {
        const response = await this.#http.request({
            method: 'POST',
            path: '/templates/{template}/envelopes',
            pathParams: { template: template },
            json: body,
            hasBody: true,
            idempotency: 'required',
            options,
        });
        return dataOf(response);
    }
    /** Eventos que podem ser assinados (`*` = todos, inclusive os que forem criados depois) — `GET /webhook-events`. */
    async listWebhookEvents(options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/webhook-events',
            options,
        });
        return (dataOf(response) ?? []);
    }
    /** Payload de exemplo de um evento, no formato `{data: [payload]}` — lista com um item, que é o que os editores de gatilho esperam para mapear campos. Nenhum dado real — `GET /webhook-events/{event}/sample`. */
    async getWebhookEventSample(event, options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/webhook-events/{event}/sample',
            pathParams: { event: event },
            options,
        });
        return {
            data: (dataOf(response) ?? []),
            meta: metaOf(response),
        };
    }
    /** Assinaturas ativas deste token — `GET /webhook-subscriptions`. */
    async listWebhookSubscriptions(options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/webhook-subscriptions',
            options,
        });
        return {
            data: (dataOf(response) ?? []),
            meta: metaOf(response),
        };
    }
    /**
     * Assina um evento (ou vários) numa URL HTTPS pública — `POST /webhook-subscriptions`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    async createWebhookSubscription(body, options = {}) {
        const response = await this.#http.request({
            method: 'POST',
            path: '/webhook-subscriptions',
            json: body,
            hasBody: true,
            idempotency: 'required',
            options,
        });
        return {
            data: dataOf(response),
            meta: metaOf(response),
        };
    }
    /** Remove a assinatura (o "unsubscribe" do REST Hooks). 204; 404 se não for deste token — `DELETE /webhook-subscriptions/{subscription}`. */
    async deleteWebhookSubscription(subscription, options = {}) {
        await this.#http.request({
            method: 'DELETE',
            path: '/webhook-subscriptions/{subscription}',
            pathParams: { subscription: subscription },
            options,
        });
    }
    /**
     * Criar sessão de assinatura embutida — `POST /envelopes/{envelope}/recipients/{recipient}/embedded-sessions`.
     *
     * Idempotency-Key obrigatória: o SDK gera um UUID v4 se você não passar uma chave.
     */
    async createEmbeddedSession(envelope, recipient, body, options = {}) {
        const response = await this.#http.request({
            method: 'POST',
            path: '/envelopes/{envelope}/recipients/{recipient}/embedded-sessions',
            pathParams: { envelope: envelope, recipient: recipient },
            json: body,
            hasBody: true,
            idempotency: 'required',
            options,
        });
        return dataOf(response);
    }
    /** Situação da sessão embutida — `GET /envelopes/{envelope}/recipients/{recipient}/embedded-sessions/{embeddedSession}`. */
    async getEmbeddedSession(envelope, recipient, embeddedSession, options = {}) {
        const response = await this.#http.request({
            method: 'GET',
            path: '/envelopes/{envelope}/recipients/{recipient}/embedded-sessions/{embeddedSession}',
            pathParams: {
                envelope: envelope,
                recipient: recipient,
                embeddedSession: embeddedSession,
            },
            options,
        });
        return dataOf(response);
    }
    /** Revogar sessão embutida — `DELETE /envelopes/{envelope}/recipients/{recipient}/embedded-sessions/{embeddedSession}`. */
    async revokeEmbeddedSession(envelope, recipient, embeddedSession, options = {}) {
        const response = await this.#http.request({
            method: 'DELETE',
            path: '/envelopes/{envelope}/recipients/{recipient}/embedded-sessions/{embeddedSession}',
            pathParams: {
                envelope: envelope,
                recipient: recipient,
                embeddedSession: embeddedSession,
            },
            options,
        });
        return dataOf(response);
    }
}
