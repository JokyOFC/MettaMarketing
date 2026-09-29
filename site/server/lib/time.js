// All timestamps are ISO-8601 UTC strings; calendar dates are YYYY-MM-DD.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const now = () => new Date().toISOString();

const toMs = (value) => (value === undefined ? Date.now() : new Date(value).getTime());

export const addMinutes = (minutes, from) => new Date(toMs(from) + minutes * MINUTE).toISOString();
export const addHours = (hours, from) => new Date(toMs(from) + hours * HOUR).toISOString();
export const addDays = (days, from) => new Date(toMs(from) + days * DAY).toISOString();

// YYYY-MM-DD in UTC.
export const isoDate = (value) => new Date(toMs(value)).toISOString().slice(0, 10);
// YYYY-MM for ZIP folders and calendar grouping.
export const monthKey = (value) => String(value ?? "").slice(0, 7) || null;

export const isPast = (iso) => Boolean(iso) && new Date(iso).getTime() <= Date.now();

export function isValidDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text))) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}
