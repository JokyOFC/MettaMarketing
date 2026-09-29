/**
 * Arquivo para `uploadDocument` (multipart, campo `file`). A API não aceita
 * upload por URL.
 */
export interface FileUpload {
    content: Uint8Array | ArrayBuffer | string;
    filename: string;
    contentType?: string;
}
/** Lê um arquivo do disco para enviar com `uploadDocument`. */
export declare function fileFromPath(path: string, contentType?: string): Promise<FileUpload>;
export declare function toBytes(content: Uint8Array | ArrayBuffer | string): Uint8Array;
/** Arquivo baixado de `downloadFile` (original, assinado ou evidências). */
export declare class DownloadedFile {
    readonly content: Uint8Array;
    readonly contentType: string | null;
    readonly filename: string | null;
    constructor(content: Uint8Array, contentType: string | null, filename: string | null);
    static fromResponse(headers: Record<string, string>, body: Uint8Array): DownloadedFile;
}
