/**
 * SDK Node.js da API v1 da AssinaVelox (TypeScript, ESM, sem dependências,
 * Node 18+). Veja sdks/node/README.md.
 */
export { AssinaVelox } from './client.js';
export { ApiError, AssinaVeloxError, InvalidRequestError, NetworkError, PROBLEM_PREFIX, RequestTimeoutError, WebhookSignatureError, type ProblemDetails, } from './errors.js';
export { DownloadedFile, fileFromPath, type FileUpload } from './files.js';
export type { ClientOptions, RequestOptions } from './http.js';
export { Page, type ApiResult } from './page.js';
export type * from './types.js';
export { API_MAJOR, API_VERSION, SDK_VERSION, SPEC_SHA256 } from './version.js';
export * as webhooks from './webhooks.js';
