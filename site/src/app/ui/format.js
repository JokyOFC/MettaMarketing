// pt-BR formatters shared by every screen. All accept null/undefined and
// return "" (or "—" where noted) so callers never print "Invalid Date".

const LOCALE = "pt-BR";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Calendar dates ("2026-10-12") are local days; ISO timestamps are instants.
export function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string" && DATE_ONLY.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const numberFmt = new Intl.NumberFormat(LOCALE);
const decimalFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
// GB and up keep two decimals, so a file just over a limit ("1,03 GB") never
// reads the same as the limit itself ("1 GB").
const bigFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
const moneyFmt = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "BRL" });
const monthShort = new Intl.DateTimeFormat(LOCALE, { month: "short" });
const monthLong = new Intl.DateTimeFormat(LOCALE, { month: "long" });
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });
const weekdayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: "short" });

export function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  return numberFmt.format(Number(value));
}

export function formatPercent(ratio, digits = 0) {
  if (ratio === null || ratio === undefined || Number.isNaN(Number(ratio))) return "";
  return `${(Number(ratio) * 100).toFixed(digits).replace(".", ",")}%`;
}

// 1,2 MB · 820 KB · 12 bytes (binary units, as file managers show them).
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return "";
  const n = Number(bytes);
  if (n < 1024) return `${n} ${n === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text =
    value >= 100 ? numberFmt.format(Math.round(value)) : unit >= 2 ? bigFmt.format(Math.floor(value * 100) / 100) : decimalFmt.format(value);
  return `${text} ${units[unit]}`;
}

// "12 out. 2026"
export function formatDate(value, { year = true } = {}) {
  const date = toDate(value);
  if (!date) return "";
  const month = monthShort.format(date).replace(/\.?$/, ".").replace("..", ".");
  const base = `${date.getDate()} ${month}`;
  return year ? `${base} ${date.getFullYear()}` : base;
}

// "12 out. 2026, 14:30"
export function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return "";
  return `${formatDate(date)}, ${timeFmt.format(date)}`;
}

export function formatTime(value) {
  const date = toDate(value);
  return date ? timeFmt.format(date) : "";
}

export function formatWeekday(value) {
  const date = toDate(value);
  return date ? weekdayFmt.format(date).replace(".", "") : "";
}

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

// "agora", "há 5 min", "há 2 h", "ontem", "há 3 dias", "em 2 dias", then the date.
export function formatRelative(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return "";
  const diff = date.getTime() - now.getTime();
  const past = diff <= 0;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const dateOnly = typeof value === "string" && DATE_ONLY.test(value);
  if (!dateOnly) {
    if (abs < 45_000) return "agora";
    if (abs < hour) {
      const m = Math.max(1, Math.round(abs / minute));
      return past ? `há ${m} min` : `em ${m} min`;
    }
  }
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  if (!dateOnly && days === 0) {
    const h = Math.max(1, Math.round(abs / hour));
    return past ? `há ${h} h` : `em ${h} h`;
  }
  if (days === 0) return "hoje";
  if (days === -1) return "ontem";
  if (days === 1) return "amanhã";
  if (days < 0 && days >= -6) return `há ${-days} dias`;
  if (days > 0 && days <= 6) return `em ${days} dias`;
  return formatDate(date, { year: date.getFullYear() !== now.getFullYear() });
}

// Cents to "R$ 1.500,00".
export function formatMoney(cents) {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return "";
  return moneyFmt.format(Number(cents) / 100);
}

// 45000 -> "0:45", 3723000 -> "1:02:03".
export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return "";
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// Local "YYYY-MM-DD" for inputs and API calendar fields.
export function isoDate(value = new Date()) {
  const date = toDate(value);
  if (!date) return "";
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

// "2026-10"
export function monthKey(value = new Date()) {
  const date = toDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// "2026-10" (or a date) -> "Outubro de 2026"
export function monthLabel(value, { year = true } = {}) {
  let date = null;
  if (typeof value === "string" && /^\d{4}-\d{2}$/.test(value)) {
    const [y, m] = value.split("-").map(Number);
    date = new Date(y, m - 1, 1);
  } else date = toDate(value);
  if (!date) return "";
  const name = monthLong.format(date);
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return year ? `${label} de ${date.getFullYear()}` : label;
}

// plural(3, "arquivo", "arquivos") -> "3 arquivos"
export function plural(count, one, many, { showCount = true } = {}) {
  const n = Number(count) || 0;
  const word = n === 1 ? one : many;
  return showCount ? `${formatNumber(n)} ${word}` : word;
}

export function initials(name) {
  // Only words that start with a letter or digit count ("Ana Lima (dev)" -> "AL").
  const parts = String(name || "")
    .replace(/\([^)]*\)?/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/^[^\p{L}\p{N}]+/u, ""))
    .filter((part) => /^[\p{L}\p{N}]/u.test(part));
  if (!parts.length) return "?";
  // Prefer words that start with a letter ("Pessoa E2E 2809" -> "PE", not "P2").
  const words = parts.filter((part) => /^\p{L}/u.test(part));
  if (words.length) parts.splice(0, parts.length, ...words);
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

// "logo-principal.svg" -> "SVG"
export function fileFormat(nameOrExt) {
  const text = String(nameOrExt || "");
  const ext = text.includes(".") ? text.split(".").pop() : text;
  return ext ? ext.toUpperCase() : "";
}
