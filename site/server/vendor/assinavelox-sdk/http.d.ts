import { type FileUpload } from './files.js';
/** Opções do cliente. */
export interface ClientOptions {
    /** Endereço da sua instalação, terminando em `/api/v1`. */
    baseUrl: string;
    /** Texto da chave criada em Integrações → Chaves (exibido uma única vez). */
    token: string;
    /** Tempo máximo de cada requisição, em milissegundos (padrão: 30000). */
    timeoutMs?: number;
    /** Cabeçalhos extras em todas as requisições. */
    headers?: Record<string, string>;
    /** `fetch` alternativo (testes, proxies). Padrão: o `fetch` global do Node 18+. */
    fetch?: typeof fetch;
}
/** Opções de uma chamada. */
export interface RequestOptions {
    /**
     * 1 a 255 caracteres ASCII visíveis. Nas criações e no envio, sem chave o
     * SDK gera um UUID v4.
     */
    idempotencyKey?: string;
    /** Milissegundos; ausente usa o do cliente. */
    timeoutMs?: number;
    /** Cabeçalhos extras (não substituem Authorization, Accept nem User-Agent). */
    headers?: Record<string, string>;
    /** Cancela a requisição. */
    signal?: AbortSignal;
}
export interface RawResponse {
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
}
export interface RequestSpec {
    method: string;
    path: string;
    pathParams?: Record<string, string>;
    query?: object;
    querySpec?: Record<string, readonly [string, boolean]>;
    json?: unknown;
    hasBody?: boolean;
    file?: FileUpload;
    fileField?: string;
    idempotency?: 'required' | 'optional';
    options?: RequestOptions;
    accept?: string;
}
/**
 * Núcleo HTTP do SDK (uso interno). O token fica num campo privado (#): não
 * aparece em `console.log`, `util.inspect` nem em mensagens de erro.
 * Redirecionamentos não são seguidos.
 */
export declare class HttpClient {
    #private;
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly userAgent: string;
    constructor(options: ClientOptions);
    url(path: string, pathParams: Record<string, string>, query: object, querySpec: Record<string, readonly [string, boolean]>): string;
    request(spec: RequestSpec): Promise<RawResponse>;
}
export declare function jsonOf(response: RawResponse): unknown;
export declare function dataOf(response: RawResponse): unknown;
export declare function metaOf(response: RawResponse): Record<string, unknown>;
