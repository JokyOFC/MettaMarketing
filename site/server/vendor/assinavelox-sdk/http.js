import { randomUUID } from 'node:crypto';
import { ApiError, InvalidRequestError, NetworkError, RequestTimeoutError, } from './errors.js';
import { toBytes } from './files.js';
import { API_MAJOR, SDK_VERSION } from './version.js';
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const UNSAFE = /[\r\n\0]/;
const RESERVED = new Set([
    'authorization',
    'accept',
    'user-agent',
    'idempotency-key',
    'content-type',
    'content-length',
    'host',
]);
function checkHeaders(headers) {
    const result = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
        if (UNSAFE.test(name) || UNSAFE.test(String(value))) {
            throw new InvalidRequestError(`Cabeçalho "${name}" com quebra de linha.`);
        }
        result[name] = String(value);
    }
    return result;
}
function scalar(name, value) {
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (typeof value === 'number' || typeof value === 'string') {
        return String(value);
    }
    throw new InvalidRequestError(`Parâmetro de consulta "${name}" com tipo não suportado.`);
}
function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
}
function multipart(field, file) {
    const contentType = file.contentType ?? 'application/octet-stream';
    if (UNSAFE.test(contentType)) {
        throw new InvalidRequestError('contentType do arquivo com quebra de linha.');
    }
    const boundary = `AssinaVeloxSdk${randomUUID().replaceAll('-', '')}`;
    const quote = (value) => value
        .replaceAll('"', '%22')
        .replaceAll('\r', '%0D')
        .replaceAll('\n', '%0A');
    const encoder = new TextEncoder();
    const head = `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${quote(field)}"; filename="${quote(file.filename)}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`;
    return {
        body: concat([
            encoder.encode(head),
            toBytes(file.content),
            encoder.encode(`\r\n--${boundary}--\r\n`),
        ]),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}
/**
 * Núcleo HTTP do SDK (uso interno). O token fica num campo privado (#): não
 * aparece em `console.log`, `util.inspect` nem em mensagens de erro.
 * Redirecionamentos não são seguidos.
 */
export class HttpClient {
    baseUrl;
    timeoutMs;
    userAgent;
    #token;
    #headers;
    #fetch;
    constructor(options) {
        if (typeof options.baseUrl !== 'string' ||
            !/^https?:\/\/[^/\s]+/i.test(options.baseUrl)) {
            throw new InvalidRequestError('baseUrl precisa ser http(s)://…/api/v1 da sua instalação.');
        }
        // Só caracteres visíveis de um byte (a regra de valor de cabeçalho HTTP): NUL, controle,
        // espaço ou acima de 0xFF fariam o `fetch` recusar o cabeçalho com uma mensagem que
        // repete o valor — e o token iria para a exceção.
        if (typeof options.token !== 'string' ||
            options.token === '' ||
            /[^\x21-\x7e\x80-\xff]/.test(options.token)) {
            throw new InvalidRequestError('token vazio ou com espaço: use o texto exibido na criação da chave.');
        }
        const timeoutMs = options.timeoutMs ?? 30_000;
        if (!(timeoutMs > 0)) {
            throw new InvalidRequestError('timeoutMs precisa ser maior que zero.');
        }
        const fetchImpl = options.fetch ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
            throw new InvalidRequestError('fetch indisponível: use Node.js 18 ou mais novo.');
        }
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.timeoutMs = timeoutMs;
        this.#token = options.token;
        this.#headers = checkHeaders(options.headers);
        this.#fetch = fetchImpl;
        this.userAgent = `assinavelox-node/${SDK_VERSION} (api-v${API_MAJOR}; node/${process.version})`;
    }
    url(path, pathParams, query, querySpec) {
        let resolved = path;
        for (const [name, value] of Object.entries(pathParams)) {
            if (typeof value !== 'string' || value === '') {
                throw new InvalidRequestError(`Parâmetro "${name}" obrigatório (texto não vazio).`);
            }
            resolved = resolved.replace(`{${name}}`, encodeURIComponent(value));
        }
        const values = query;
        const unknown = Object.keys(values).filter((name) => !(name in querySpec));
        if (unknown.length > 0) {
            throw new InvalidRequestError(`Parâmetro de consulta desconhecido: ${unknown.join(', ')}.`);
        }
        const pairs = [];
        for (const [name, [wire, repeat]] of Object.entries(querySpec)) {
            const value = values[name];
            if (value === undefined || value === null) {
                continue;
            }
            const items = repeat && Array.isArray(value) ? value : [value];
            for (const item of items) {
                pairs.push(`${encodeURIComponent(wire)}=${encodeURIComponent(scalar(name, item))}`);
            }
        }
        return (this.baseUrl +
            resolved +
            (pairs.length > 0 ? `?${pairs.join('&')}` : ''));
    }
    async request(spec) {
        const options = spec.options ?? {};
        const url = this.url(spec.path, spec.pathParams ?? {}, spec.query ?? {}, spec.querySpec ?? {});
        const headers = {};
        for (const [name, value] of Object.entries({
            ...this.#headers,
            ...checkHeaders(options.headers),
        })) {
            if (!RESERVED.has(name.toLowerCase())) {
                headers[name.toLowerCase()] = value;
            }
        }
        headers.authorization = `Bearer ${this.#token}`;
        headers.accept = spec.accept ?? 'application/json';
        headers['user-agent'] = this.userAgent;
        let key = options.idempotencyKey;
        if (key === undefined && spec.idempotency === 'required') {
            key = randomUUID();
        }
        if (key !== undefined) {
            if (!IDEMPOTENCY_KEY.test(key)) {
                throw new InvalidRequestError('Idempotency-Key: de 1 a 255 caracteres ASCII visíveis, sem espaços.');
            }
            headers['idempotency-key'] = key;
        }
        let body;
        if (spec.file !== undefined) {
            const encoded = multipart(spec.fileField ?? 'file', spec.file);
            body = encoded.body;
            headers['content-type'] = encoded.contentType;
        }
        else if (spec.hasBody === true &&
            spec.json !== undefined &&
            spec.json !== null) {
            body = new TextEncoder().encode(JSON.stringify(spec.json));
            headers['content-type'] = 'application/json';
        }
        const limit = options.timeoutMs ?? this.timeoutMs;
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, limit);
        const external = options.signal;
        const relay = () => controller.abort(external?.reason);
        if (external?.aborted === true) {
            controller.abort(external.reason);
        }
        else {
            external?.addEventListener('abort', relay, { once: true });
        }
        const where = `${spec.method} ${spec.path}`;
        try {
            const response = await this.#fetch(url, {
                method: spec.method,
                headers,
                body,
                redirect: 'manual',
                signal: controller.signal,
            });
            const payload = new Uint8Array(await response.arrayBuffer());
            const responseHeaders = {};
            response.headers.forEach((value, name) => {
                responseHeaders[name.toLowerCase()] = value;
            });
            if (response.status < 200 || response.status >= 300) {
                throw ApiError.fromResponse(response.status, responseHeaders, payload);
            }
            return {
                status: response.status,
                headers: responseHeaders,
                body: payload,
            };
        }
        catch (error) {
            if (error instanceof ApiError) {
                throw error;
            }
            if (timedOut) {
                throw new RequestTimeoutError(`Tempo esgotado (${limit} ms) em ${where}.`);
            }
            if (external?.aborted === true) {
                throw error;
            }
            const cause = error.cause;
            let reason = String(cause?.code ?? cause?.message ?? error.message);
            // Nunca repetir um cabeçalho recusado (o valor seria "Bearer <token>") nem o token:
            // nesses casos a mensagem é genérica e o erro original NÃO vai como `cause`.
            const unsafe = (error instanceof TypeError && /header/i.test(reason)) ||
                reason.includes(this.#token);
            if (unsafe) {
                reason = 'cabeçalho inválido';
            }
            throw new NetworkError(`Falha de conexão em ${where}: ${reason}`, unsafe ? undefined : { cause: error });
        }
        finally {
            clearTimeout(timer);
            external?.removeEventListener('abort', relay);
        }
    }
}
export function jsonOf(response) {
    if (response.body.byteLength === 0) {
        return null;
    }
    return JSON.parse(new TextDecoder().decode(response.body));
}
export function dataOf(response) {
    const json = jsonOf(response);
    return json !== null && typeof json === 'object'
        ? json.data
        : undefined;
}
export function metaOf(response) {
    const json = jsonOf(response);
    const meta = json !== null && typeof json === 'object'
        ? json.meta
        : undefined;
    return meta !== null && typeof meta === 'object' && !Array.isArray(meta)
        ? meta
        : {};
}
