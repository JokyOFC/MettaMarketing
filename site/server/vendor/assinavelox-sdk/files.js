import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
const TYPES = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
};
/** Lê um arquivo do disco para enviar com `uploadDocument`. */
export async function fileFromPath(path, contentType) {
    const content = new Uint8Array(await readFile(path));
    return {
        content,
        filename: basename(path),
        contentType: contentType ??
            TYPES[extname(path).toLowerCase()] ??
            'application/octet-stream',
    };
}
export function toBytes(content) {
    if (typeof content === 'string') {
        return new TextEncoder().encode(content);
    }
    return content instanceof Uint8Array ? content : new Uint8Array(content);
}
/** Arquivo baixado de `downloadFile` (original, assinado ou evidências). */
export class DownloadedFile {
    content;
    contentType;
    filename;
    constructor(content, contentType, filename) {
        this.content = content;
        this.contentType = contentType;
        this.filename = filename;
    }
    static fromResponse(headers, body) {
        const disposition = headers['content-disposition'] ?? '';
        const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
        const quoted = /filename\s*=\s*"([^"]*)"/.exec(disposition);
        const plain = /filename\s*=\s*([^;]+)/.exec(disposition);
        let filename = null;
        if (extended?.[1] !== undefined) {
            filename = decodeURIComponent(extended[1].trim());
        }
        else if (quoted?.[1] !== undefined) {
            filename = quoted[1].trim();
        }
        else if (plain?.[1] !== undefined) {
            filename = plain[1].trim();
        }
        const type = headers['content-type'];
        return new DownloadedFile(body, type === undefined ? null : (type.split(';')[0] ?? '').trim(), filename);
    }
}
