/**
 * Erros do SDK. Todos herdam de `AssinaVeloxError`.
 */
export declare const PROBLEM_PREFIX = "urn:assinavelox:problem:";
/** Base de todos os erros do SDK. */
export declare class AssinaVeloxError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** O pedido foi recusado pelo próprio SDK, antes de sair (ex.: Idempotency-Key inválida). */
export declare class InvalidRequestError extends AssinaVeloxError {
}
/** Falha de rede: conexão recusada, DNS, TLS ou conexão interrompida. */
export declare class NetworkError extends AssinaVeloxError {
}
/** O tempo limite da requisição se esgotou. */
export declare class RequestTimeoutError extends NetworkError {
}
/** A assinatura do webhook não conferiu ou está fora da janela de tempo. */
export declare class WebhookSignatureError extends AssinaVeloxError {
}
/** Corpo RFC 9457 (`application/problem+json`) da API v1. */
export interface ProblemDetails {
    type: string;
    title: string;
    status?: number;
    detail?: string;
    instance?: string;
    correlation_id?: string;
    errors?: Record<string, string[]>;
    [extension: string]: unknown;
}
interface ApiErrorInit {
    status: number;
    type: string;
    title: string;
    detail?: string | null;
    instance?: string | null;
    correlationId?: string | null;
    errors?: Record<string, string[]>;
    problem?: Record<string, unknown>;
    headers?: Record<string, string>;
}
/**
 * Resposta de erro da API (RFC 9457). `type` é uma URN estável
 * (`urn:assinavelox:problem:{slug}`): compare como texto e trate um `type`
 * desconhecido pelo `status`. Quando a resposta não é RFC 9457 (ex.: um proxy
 * devolveu HTML), `type` é `about:blank` e `title` é genérico.
 */
export declare class ApiError extends AssinaVeloxError {
    readonly status: number;
    readonly type: string;
    readonly title: string;
    readonly detail: string | null;
    readonly instance: string | null;
    readonly correlationId: string | null;
    readonly errors: Record<string, string[]>;
    readonly problem: Record<string, unknown>;
    readonly headers: Record<string, string>;
    constructor(init: ApiErrorInit);
    /** Sufixo do `type` (`not-found`, `validation-failed`...), ou null fora do padrão. */
    get slug(): string | null;
    hasType(slug: string): boolean;
    /** Segundos do cabeçalho `Retry-After` (429, 409 em processamento, 503). */
    get retryAfter(): number | null;
    static fromResponse(status: number, headers: Record<string, string>, body: Uint8Array): ApiError;
}
export {};
