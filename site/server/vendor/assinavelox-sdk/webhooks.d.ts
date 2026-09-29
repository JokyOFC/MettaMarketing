export declare const VERSION = "v1";
export declare const SECRET_PREFIX = "whsec_";
export declare const SIGNATURE_HEADER = "X-AssinaVelox-Signature";
export declare const TIMESTAMP_HEADER = "X-AssinaVelox-Timestamp";
export declare const DELIVERY_HEADER = "X-AssinaVelox-Delivery-Id";
export declare const EVENT_HEADER = "X-AssinaVelox-Event";
export declare const EVENT_ID_HEADER = "X-AssinaVelox-Event-Id";
export declare const ATTEMPT_HEADER = "X-AssinaVelox-Attempt";
export declare const DEFAULT_TOLERANCE_SECONDS = 300;
export type RawBody = string | Uint8Array | ArrayBuffer;
export interface VerifyOptions {
    /** Agora, em segundos Unix (padrão: o relógio local). */
    now?: number;
    /** Janela de tolerância em segundos (padrão: 300). */
    tolerance?: number;
}
/** `hex(HMAC-SHA256(segredo, "{timestamp}.{corpo}"))`. */
export declare function computeSignature(secret: string, timestamp: number, rawBody: RawBody): string;
/** Valor do cabeçalho como a plataforma envia (útil nos testes do seu receptor). */
export declare function signatureHeader(secrets: readonly string[], timestamp: number, rawBody: RawBody): string;
/** true se alguma assinatura `v1` conferir e o timestamp estiver na janela. */
export declare function verifySignature(secret: string, signatureHeaderValue: string | null | undefined, timestampHeader: string | null | undefined, rawBody: RawBody, options?: VerifyOptions): boolean;
type HeaderBag = Record<string, string | string[] | undefined> | {
    get(name: string): string | null;
};
/**
 * Confere a assinatura e devolve o evento decodificado; senão,
 * `WebhookSignatureError`. Deduplique pelo cabeçalho
 * `X-AssinaVelox-Delivery-Id` (igual em todas as tentativas).
 */
export declare function constructEvent(rawBody: RawBody, headers: HeaderBag, secret: string, options?: VerifyOptions): Record<string, unknown>;
export {};
