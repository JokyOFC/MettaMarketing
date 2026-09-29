/**
 * Erros do SDK. Todos herdam de `AssinaVeloxError`.
 */
export const PROBLEM_PREFIX = 'urn:assinavelox:problem:';
/** Base de todos os erros do SDK. */
export class AssinaVeloxError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = new.target.name;
    }
}
/** O pedido foi recusado pelo próprio SDK, antes de sair (ex.: Idempotency-Key inválida). */
export class InvalidRequestError extends AssinaVeloxError {
}
/** Falha de rede: conexão recusada, DNS, TLS ou conexão interrompida. */
export class NetworkError extends AssinaVeloxError {
}
/** O tempo limite da requisição se esgotou. */
export class RequestTimeoutError extends NetworkError {
}
/** A assinatura do webhook não conferiu ou está fora da janela de tempo. */
export class WebhookSignatureError extends AssinaVeloxError {
}
const text = (value) => typeof value === 'string' ? value : null;
/**
 * Resposta de erro da API (RFC 9457). `type` é uma URN estável
 * (`urn:assinavelox:problem:{slug}`): compare como texto e trate um `type`
 * desconhecido pelo `status`. Quando a resposta não é RFC 9457 (ex.: um proxy
 * devolveu HTML), `type` é `about:blank` e `title` é genérico.
 */
export class ApiError extends AssinaVeloxError {
    status;
    type;
    title;
    detail;
    instance;
    correlationId;
    errors;
    problem;
    headers;
    constructor(init) {
        let message = `${init.status} ${init.title}`;
        if (init.detail) {
            message += `: ${init.detail}`;
        }
        message += ` (${init.type})`;
        if (init.correlationId) {
            message += ` [correlation_id ${init.correlationId}]`;
        }
        super(message);
        this.status = init.status;
        this.type = init.type;
        this.title = init.title;
        this.detail = init.detail ?? null;
        this.instance = init.instance ?? null;
        this.correlationId = init.correlationId ?? null;
        this.errors = init.errors ?? {};
        this.problem = init.problem ?? {};
        this.headers = init.headers ?? {};
    }
    /** Sufixo do `type` (`not-found`, `validation-failed`...), ou null fora do padrão. */
    get slug() {
        return this.type.startsWith(PROBLEM_PREFIX)
            ? this.type.slice(PROBLEM_PREFIX.length)
            : null;
    }
    hasType(slug) {
        return this.slug === slug;
    }
    /** Segundos do cabeçalho `Retry-After` (429, 409 em processamento, 503). */
    get retryAfter() {
        const value = (this.headers['retry-after'] ?? '').trim();
        return /^\d+$/.test(value) ? Number(value) : null;
    }
    static fromResponse(status, headers, body) {
        let parsed = null;
        if (body.byteLength > 0 &&
            (headers['content-type'] ?? '').includes('json')) {
            try {
                parsed = JSON.parse(new TextDecoder().decode(body));
            }
            catch {
                parsed = null;
            }
        }
        const correlation = headers['x-correlation-id'] ?? null;
        if (parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed)) {
            const problem = parsed;
            const type = text(problem.type);
            const title = text(problem.title);
            if (type !== null && title !== null) {
                const errors = {};
                if (problem.errors !== null &&
                    typeof problem.errors === 'object') {
                    for (const [field, messages] of Object.entries(problem.errors)) {
                        errors[field] = (Array.isArray(messages) ? messages : [messages]).map(String);
                    }
                }
                return new ApiError({
                    status,
                    type,
                    title,
                    detail: text(problem.detail),
                    instance: text(problem.instance),
                    correlationId: text(problem.correlation_id) ?? correlation,
                    errors,
                    problem,
                    headers,
                });
            }
        }
        return new ApiError({
            status,
            type: 'about:blank',
            title: `Erro HTTP ${status}`,
            correlationId: correlation,
            headers,
        });
    }
}
