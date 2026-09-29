import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  apiUrl,
  networkError,
  signalUnauthenticated,
  toApiError,
} from "./client.js";
import { formatBytes } from "../ui/format.js";

const UPLOAD_MESSAGES = {
  payload_too_large: "Arquivo acima do limite permitido.",
  unsupported_media: "Formato não permitido.",
};

// ---- upload limit (GET /api/uploads/limits, staff with materials.upload)

let limitsPromise = null;

/**
 * getUploadLimits() -> Promise<{ maxUploadBytes, maxUploadMb, maxUploadLabel } | null>
 * Fetched once per page load; null when unavailable (no permission, offline:
 * the server still refuses oversized files with 413).
 */
export function getUploadLimits() {
  if (!limitsPromise)
    limitsPromise = api.get("/uploads/limits").then(
      (limits) => (Number(limits?.maxUploadBytes) > 0 ? limits : null),
      (error) => {
        // a network hiccup may pass; a refusal (403) will not
        if (error?.code === "network") limitsPromise = null;
        return null;
      },
    );
  return limitsPromise;
}

/** useUploadLimits() -> { maxUploadBytes, maxUploadMb, maxUploadLabel } | null (null while loading). */
export function useUploadLimits() {
  const [limits, setLimits] = useState(null);
  useEffect(() => {
    let alive = true;
    getUploadLimits().then((value) => {
      if (alive) setLimits(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return limits;
}

export const uploadLimitMessage = (limits) =>
  `O arquivo ultrapassa o limite de ${limits?.maxUploadLabel || formatBytes(limits?.maxUploadBytes)}.`;

const tooLarge = (limits) =>
  new ApiError({
    status: 413,
    code: "payload_too_large",
    message: uploadLimitMessage(limits),
    data: { error: { code: "payload_too_large", maxBytes: limits?.maxUploadBytes } },
  });

function parse(xhr) {
  const text = xhr.responseText;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// One file per request so each item has its own real progress (XHR exposes
// upload progress; fetch does not). Resolves with the `upload` record.
// A file above the server's limit is refused before any byte is sent.
export async function uploadFile(file, options = {}) {
  const limits = options.url && options.url !== "/uploads" ? null : await getUploadLimits();
  if (limits && file?.size > limits.maxUploadBytes) throw tooLarge(limits);
  return sendFile(file, options, limits);
}

function sendFile(file, { onProgress, signal, url = "/uploads" } = {}, limits = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Envio cancelado.", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const target = apiUrl(url);
    xhr.open("POST", target);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("X-Metta-Request", "1");
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const done = () => signal?.removeEventListener("abort", abort);

    xhr.upload.onprogress = (event) => {
      onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    };
    xhr.onload = () => {
      done();
      const body = parse(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(file.size, file.size);
        resolve(body?.upload ?? body);
        return;
      }
      let error = toApiError(xhr.status, body);
      // A refused file (e.g. empty) comes back as a validation error on the
      // `file` field; that sentence is the per-file reason, not the generic
      // "Revise os campos destacados".
      const fileReason = error.fields?.file;
      if (error.code === "validation" && typeof fileReason === "string")
        error = new ApiError({ status: error.status, code: error.code, message: fileReason, fields: error.fields, data: body });
      else if (UPLOAD_MESSAGES[error.code] && !body?.error?.message)
        error = new ApiError({
          status: error.status,
          code: error.code,
          message: UPLOAD_MESSAGES[error.code],
          fields: error.fields,
          data: body,
        });
      signalUnauthenticated(error, url);
      reject(error);
    };
    xhr.onerror = () => {
      done();
      // a server that cuts an oversized upload short looks like a dropped connection
      if (limits && file?.size > limits.maxUploadBytes) {
        reject(tooLarge(limits));
        return;
      }
      reject(
        networkError(
          "A conexão caiu durante o envio. Verifique sua internet e envie o arquivo de novo.",
        ),
      );
    };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => {
      done();
      reject(new DOMException("Envio cancelado.", "AbortError"));
    };

    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

export default uploadFile;
