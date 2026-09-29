import { z } from "zod";
import { validation } from "./errors.js";
import { isValidDate } from "./time.js";

// Friendly pt-BR defaults for every zod schema in the app. Messages given in
// a schema (e.g. .min(10, "…")) still take precedence.
function ptBR(issue) {
  const { code } = issue;
  if (code === "invalid_type") {
    if (issue.input === undefined || issue.input === null) return "Campo obrigatório.";
    if (issue.expected === "int") return "Use um número inteiro.";
    if (issue.expected === "number") return "Informe um número.";
    if (issue.expected === "boolean") return "Valor inválido.";
    if (issue.expected === "array") return "Lista inválida.";
    return "Valor inválido.";
  }
  if (code === "too_small") {
    const min = Number(issue.minimum);
    if (issue.origin === "string")
      return min <= 1 ? "Campo obrigatório." : `Use pelo menos ${min} caracteres.`;
    if (issue.origin === "array" || issue.origin === "set")
      return min <= 1 ? "Selecione pelo menos um item." : `Selecione pelo menos ${min} itens.`;
    return `O valor mínimo é ${min}.`;
  }
  if (code === "too_big") {
    const max = Number(issue.maximum);
    if (issue.origin === "string") return `Use no máximo ${max} caracteres.`;
    if (issue.origin === "array" || issue.origin === "set") return `Selecione no máximo ${max} itens.`;
    return `O valor máximo é ${max}.`;
  }
  if (code === "invalid_format") {
    if (issue.format === "email") return "Informe um e-mail válido.";
    if (issue.format === "url") return "Informe um link válido, começando com https://.";
    return "Formato inválido.";
  }
  if (code === "invalid_value") return "Escolha uma opção válida.";
  if (code === "unrecognized_keys") return "Campo não permitido.";
  return "Valor inválido.";
}
z.config({ customError: ptBR });

export { z };

// Parses data with a zod schema; throws 422 validation with { field: message }.
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const fields = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_";
    fields[key] ??= issue.message;
  }
  throw validation(fields);
}

const trimmed = (max) => z.string().trim().max(max);

// Reusable building blocks.
export const schemas = {
  id: z.string().regex(/^[a-z]{3}_[A-Za-z0-9_-]{16}$/, "Identificador inválido."),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  // required text: trimmed, not empty
  text: (max = 200) => trimmed(max).min(1, "Campo obrigatório."),
  // optional text: '' becomes null
  optionalText: (max = 2000) =>
    z
      .union([trimmed(max), z.null()])
      .optional()
      .transform((value) => (value === "" ? null : value)),
  date: z.string().refine(isValidDate, "Use uma data válida (AAAA-MM-DD)."),
  optionalDate: z
    .union([z.string(), z.null()])
    .optional()
    .refine((value) => value == null || value === "" || isValidDate(value), "Use uma data válida (AAAA-MM-DD).")
    .transform((value) => (value === "" ? null : value)),
  hex: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use o formato #RRGGBB.")
    .transform((value) => value.toUpperCase()),
  url: z.string().trim().pipe(z.url({ protocol: /^https?$/ }).max(2000)),
  // accepts true/false, 1/0, "1"/"0", "true"/"false" (query strings)
  bool: z.preprocess((value) => {
    if (value === "1" || value === "true" || value === 1) return true;
    if (value === "0" || value === "false" || value === 0 || value === "") return false;
    return value;
  }, z.boolean()),
  tags: z.array(z.string().trim().min(1).max(40)).max(30),
  ids: z.array(z.string().min(1).max(64)).max(500),
};

// ?page=&pageSize= (max 200) -> { page, pageSize, limit, offset }
export function paginate(query = {}, { defaultSize = 50, max = 200 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const size = Math.min(max, Math.max(1, Number.parseInt(query.pageSize, 10) || defaultSize));
  return { page, pageSize: size, limit: size, offset: (page - 1) * size };
}

// Query-string helpers: '1'/'true' -> true; comma lists -> arrays.
export const queryBool = (value) => value === "1" || value === "true" || value === true;
export const queryList = (value) =>
  value === undefined || value === null || value === ""
    ? []
    : (Array.isArray(value) ? value : String(value).split(","))
        .map((item) => String(item).trim())
        .filter(Boolean);
