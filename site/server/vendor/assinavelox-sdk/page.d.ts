/** Resposta com `data` e `meta` (ex.: `sendEnvelope` traz `meta.invitations_sent`). */
export interface ApiResult<T> {
    data: T;
    meta: Record<string, unknown>;
}
/**
 * Uma página de resultados paginados por cursor (`meta.next_cursor`).
 *
 * ```ts
 * for await (const envelope of await client.listEnvelopes()) { ... }
 * ```
 *
 * O `for await` percorre TODAS as páginas, buscando as próximas sob demanda;
 * `page.data` tem só os itens desta página. O cursor é opaco.
 */
export declare class Page<T> implements AsyncIterable<T> {
    #private;
    readonly data: T[];
    readonly links: Record<string, unknown>;
    readonly meta: Record<string, unknown>;
    constructor(data: T[], links: Record<string, unknown>, meta: Record<string, unknown>, fetch: (cursor: string) => Promise<Page<T>>);
    get nextCursor(): string | null;
    get prevCursor(): string | null;
    get perPage(): number | null;
    get hasMore(): boolean;
    nextPage(): Promise<Page<T> | null>;
    /** Todos os itens, desta página em diante. */
    autoPagingIterator(): AsyncGenerator<T, void, undefined>;
    [Symbol.asyncIterator](): AsyncGenerator<T, void, undefined>;
    static fromJson<T>(body: unknown, fetch: (cursor: string) => Promise<Page<T>>): Page<T>;
}
