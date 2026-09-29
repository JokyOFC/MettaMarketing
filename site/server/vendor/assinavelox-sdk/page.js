const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
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
export class Page {
    data;
    links;
    meta;
    #fetch;
    constructor(data, links, meta, fetch) {
        this.data = data;
        this.links = links;
        this.meta = meta;
        this.#fetch = fetch;
    }
    get nextCursor() {
        const value = this.meta.next_cursor;
        return typeof value === 'string' && value !== '' ? value : null;
    }
    get prevCursor() {
        const value = this.meta.prev_cursor;
        return typeof value === 'string' && value !== '' ? value : null;
    }
    get perPage() {
        const value = this.meta.per_page;
        return typeof value === 'number' ? value : null;
    }
    get hasMore() {
        return this.nextCursor !== null;
    }
    async nextPage() {
        const cursor = this.nextCursor;
        return cursor === null ? null : this.#fetch(cursor);
    }
    /** Todos os itens, desta página em diante. */
    async *autoPagingIterator() {
        yield* this.data;
        let page = await this.nextPage();
        while (page !== null) {
            yield* page.data;
            page = await page.nextPage();
        }
    }
    [Symbol.asyncIterator]() {
        return this.autoPagingIterator();
    }
    static fromJson(body, fetch) {
        const json = record(body);
        const data = Array.isArray(json.data) ? json.data : [];
        return new Page(data, record(json.links), record(json.meta), fetch);
    }
}
